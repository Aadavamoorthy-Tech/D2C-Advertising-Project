"""Local Windows automation: keep Render's EXASOL_DSN in sync with the current ngrok TCP address.

Runs on the laptop only (standard library, no third-party packages). It never touches
EXASOL_USER / EXASOL_PASSWORD, never replaces the service's env-var collection, and
triggers a deployment only when EXASOL_DSN actually had to change (or when recovering
a pending deployment). See README.md in this folder.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlencode

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
ENV_VAR_NAME = "EXASOL_DSN"
DEMO_MODE_ENV_VAR_NAME = "ADPILOT_DEMO_MODE"
TERMINAL_OK = {"live"}
TERMINAL_FAIL = {"build_failed", "update_failed", "canceled", "pre_deploy_failed"}
TERMINAL_OTHER = {"deactivated"}  # superseded by a newer deploy
DEPLOY_RECONCILE_GRACE = timedelta(minutes=10)

EXIT_OK, EXIT_ERROR, EXIT_PREFLIGHT, EXIT_LOCKED, EXIT_PENDING = 0, 1, 2, 3, 4


class SyncError(Exception):
    exit_code = EXIT_ERROR


class PreflightError(SyncError):
    exit_code = EXIT_PREFLIGHT


class NgrokNotFound(PreflightError):
    pass


class LockHeld(SyncError):
    exit_code = EXIT_LOCKED


class RenderAuthError(SyncError):
    pass


class RenderHTTPError(SyncError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AmbiguousRequest(SyncError):
    """The request may or may not have been processed by Render."""


class DeployPending(SyncError):
    exit_code = EXIT_PENDING


# ----------------------------------------------------------------------------- config
@dataclass
class Config:
    render_api_key: str = field(default="", repr=False)
    render_service_id: str = ""
    ngrok_path: str = ""
    inspect_addrs: tuple[str, ...] = ("127.0.0.1:4040", "127.0.0.1:4041")
    db_host: str = "127.0.0.1"
    db_port: int = 8563
    render_base_url: str = "https://api.render.com/v1"
    http_timeout: float = 20.0
    state_dir: Path = STATE_DIR

    @property
    def upstreams(self) -> set[str]:
        return {f"127.0.0.1:{self.db_port}", f"localhost:{self.db_port}", str(self.db_port)}


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_config(env: dict[str, str] | None = None, env_file: Path | None = None) -> Config:
    """Real environment variables take precedence over the local gitignored file."""
    merged = parse_env_file(env_file or HERE / "local.env")
    merged.update({k: v for k, v in (os.environ if env is None else env).items() if v})
    addrs = [a.strip() for a in merged.get("NGROK_INSPECT_ADDRS", "").split(",") if a.strip()]
    cfg = Config(
        render_api_key=merged.get("RENDER_API_KEY", ""),
        render_service_id=merged.get("RENDER_SERVICE_ID", ""),
        ngrok_path=merged.get("NGROK_PATH", ""),
        db_host=merged.get("EXASOL_LOCAL_HOST", "127.0.0.1"),
        db_port=int(merged.get("EXASOL_LOCAL_PORT", "8563")),
    )
    if addrs:
        cfg.inspect_addrs = tuple(addrs)
    return cfg


def require_render_config(cfg: Config) -> None:
    missing = [n for n, v in (("RENDER_API_KEY", cfg.render_api_key),
                              ("RENDER_SERVICE_ID", cfg.render_service_id)) if not v]
    if missing:
        raise SyncError(f"Missing {', '.join(missing)}. Set it in the environment or tools\\ngrok_render_sync\\local.env.")


# ----------------------------------------------------------------------------- helpers
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def say(message: str) -> None:
    print(message, flush=True)


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def process_is_ngrok(pid: int) -> bool:
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "ngrok" in out.lower()


class RunLock:
    """Exclusive lock file so two runs never update/deploy the same service at once."""

    def __init__(self, path: Path, alive: Callable[[int], bool] = pid_alive):
        self.path, self.alive = path, alive

    def __enter__(self) -> "RunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    holder = int(self.path.read_text().strip() or 0)
                except (OSError, ValueError):
                    holder = 0
                if holder and self.alive(holder):
                    raise LockHeld(f"Another sync run (PID {holder}) is active. Wait for it to finish.")
                self.path.unlink(missing_ok=True)  # stale lock from a crashed run
                continue
            with os.fdopen(fd, "w") as handle:
                handle.write(str(os.getpid()))
            return self
        raise LockHeld("Could not acquire the sync lock.")

    def __exit__(self, *exc: Any) -> None:
        self.path.unlink(missing_ok=True)


class StateStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def save(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)


# ----------------------------------------------------------------------------- DB preflight
def check_database(host: str, port: int, connect: Callable[..., Any] = socket.create_connection) -> None:
    try:
        connect((host, port), timeout=3).close()
    except OSError as exc:
        raise PreflightError(
            f"Exasol is not reachable on {host}:{port} ({type(exc).__name__}). Start your local Exasol "
            "database and wait until it accepts connections, then run this again. This script does not "
            "start, install, or modify Exasol."
        ) from exc


# ----------------------------------------------------------------------------- ngrok
def tcp_public_url_to_hostport(public_url: str) -> str:
    match = re.fullmatch(r"tcp://([^/:\s]+):(\d+)/?", public_url.strip())
    if not match:
        raise SyncError("ngrok returned an unexpected public URL; expected tcp://host:port.")
    return f"{match.group(1)}:{match.group(2)}"


def http_get_json(url: str, timeout: float = 3.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # local inspection API only
        return json.loads(response.read().decode("utf-8"))


def _normalize_upstream(value: str) -> str:
    return re.sub(r"^\w+://", "", value.strip().lower()).rstrip("/")


def tunnels_from_api(addr: str, get_json: Callable[..., Any]) -> list[tuple[str, str]]:
    """Return (public_url, upstream) for TCP tunnels exposed by one ngrok agent API."""
    found: list[tuple[str, str]] = []
    try:
        for item in get_json(f"http://{addr}/api/tunnels").get("tunnels", []):
            public_url = str(item.get("public_url", ""))
            if public_url.startswith("tcp://"):
                found.append((public_url, str((item.get("config") or {}).get("addr", ""))))
    except (OSError, ValueError, AttributeError):
        pass
    if found:
        return found
    try:  # newer agents list endpoints (the /api/tunnels listing is deprecated)
        for item in get_json(f"http://{addr}/api/endpoints").get("endpoints", []):
            url = str(item.get("url", ""))
            if url.startswith("tcp://"):
                found.append((url, str((item.get("upstream") or {}).get("url", ""))))
    except (OSError, ValueError, AttributeError):
        pass
    return found


def find_matching_tunnel(addrs: tuple[str, ...] | list[str], upstreams: set[str],
                         get_json: Callable[..., Any] = http_get_json) -> tuple[str, str] | None:
    """Return (inspect_addr, public_url) for a TCP tunnel forwarding to the Exasol port only."""
    for addr in addrs:
        for public_url, upstream in tunnels_from_api(addr, get_json):
            if _normalize_upstream(upstream) in upstreams:
                return addr, public_url
    return None


def find_ngrok(cfg: Config, which: Callable[[str], str | None] = shutil.which) -> str:
    if cfg.ngrok_path:
        if Path(cfg.ngrok_path).is_file():
            return cfg.ngrok_path
        raise NgrokNotFound(f"NGROK_PATH points to a missing file: {cfg.ngrok_path}")
    found = which("ngrok")
    if not found:
        raise NgrokNotFound(
            "ngrok was not found on PATH. Install it, or set NGROK_PATH in "
            "tools\\ngrok_render_sync\\local.env to the full path of ngrok.exe."
        )
    return found


def read_log_tail(path: Path, lines: int = 6) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(no log output)"


def start_ngrok(cfg: Config, store: StateStore, timeout: float = 45.0, popen: Callable[..., Any] = subprocess.Popen,
                get_json: Callable[..., Any] = http_get_json, sleep: Callable[[float], None] = time.sleep) -> tuple[str, str]:
    """Start our own ngrok. The local API address is read from this process's own log,
    so we always know which inspection API belongs to it (4040 may be taken by another agent)."""
    exe = find_ngrok(cfg)
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    log_path = cfg.state_dir / "ngrok.log"
    flags = 0x00000200 | 0x00000008 if sys.platform == "win32" else 0  # NEW_PROCESS_GROUP | DETACHED_PROCESS
    with open(log_path, "w", encoding="utf-8") as log:
        proc = popen([exe, "tcp", f"{cfg.db_host}:{cfg.db_port}", "--log=stdout", "--log-format=logfmt"],
                     stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags)
    state = store.load()
    state["ngrok"] = {"pid": proc.pid, "started_at": iso(utcnow()), "exe": exe}
    store.save(state)
    deadline = time.monotonic() + timeout
    inspect_addr = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            state = store.load()
            state.pop("ngrok", None)
            store.save(state)
            raise SyncError(f"ngrok exited during startup (code {proc.returncode}). Last log lines:\n{read_log_tail(log_path)}")
        text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        match = re.search(r'msg="?starting web service"?.*?addr="?(\d[\d.]*:\d+)', text)
        if match:
            inspect_addr = match.group(1)
        if inspect_addr:
            found = find_matching_tunnel([inspect_addr], cfg.upstreams, get_json)
            if found:
                state = store.load()
                state["ngrok"]["inspect_addr"] = inspect_addr
                store.save(state)
                return found
        sleep(1.0)
    raise SyncError(f"ngrok did not publish a tunnel within {timeout:.0f}s. Last log lines:\n{read_log_tail(log_path)}\n"
                    "Check your ngrok authtoken and internet connection.")


def ensure_tunnel(cfg: Config, store: StateStore, get_json: Callable[..., Any] = http_get_json,
                  **start_kwargs: Any) -> tuple[str, str, bool]:
    """Return (public_hostport, inspect_addr, started_new). Reuses a matching tunnel when present."""
    addrs = list(cfg.inspect_addrs)
    owned = store.load().get("ngrok", {}).get("inspect_addr")
    if owned and owned not in addrs:
        addrs.append(owned)
    found = find_matching_tunnel(addrs, cfg.upstreams, get_json)
    started = False
    if not found:
        found = start_ngrok(cfg, store, get_json=get_json, **start_kwargs)
        started = True
    return tcp_public_url_to_hostport(found[1]), found[0], started


def stop_owned_ngrok(store: StateStore, alive: Callable[[int], bool] = pid_alive,
                     is_ngrok: Callable[[int], bool] = process_is_ngrok,
                     run: Callable[..., Any] = subprocess.run) -> str:
    """Stop only the ngrok process recorded in our state file."""
    state = store.load()
    info = state.get("ngrok")
    if not info:
        return "No ngrok process owned by this automation is recorded; nothing stopped."
    pid = int(info["pid"])
    if not alive(pid):
        message = f"Recorded ngrok PID {pid} is no longer running."
    elif not is_ngrok(pid):
        message = f"PID {pid} is not an ngrok process any more (PID reuse); refusing to stop it."
    else:
        run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=30)
        message = f"Stopped ngrok PID {pid} started by this automation."
    state.pop("ngrok", None)
    store.save(state)
    return message


# ----------------------------------------------------------------------------- Render
Transport = Callable[[str, str, dict[str, str], "bytes | None", float], "tuple[int, dict[str, str], bytes]"]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None,
                     timeout: float) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()
    except (TimeoutError, ConnectionResetError) as exc:
        raise AmbiguousRequest(f"Render did not answer in time ({type(exc).__name__}).") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, ConnectionResetError)):
            raise AmbiguousRequest(f"Render did not answer in time ({type(exc.reason).__name__}).") from exc
        raise RenderHTTPError(f"Could not reach Render ({type(exc.reason).__name__}). Check your internet connection.") from exc


class RenderClient:
    def __init__(self, cfg: Config, transport: Transport = urllib_transport,
                 sleep: Callable[[float], None] = time.sleep, max_retries: int = 3):
        self.cfg, self.transport, self.sleep, self.max_retries = cfg, transport, sleep, max_retries

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None, *,
              idempotent: bool = True) -> tuple[int, dict[str, str], Any]:
        headers = {"Authorization": f"Bearer {self.cfg.render_api_key}", "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        url = f"{self.cfg.render_base_url}{path}"
        for attempt in range(self.max_retries + 1):
            try:
                status, resp_headers, raw = self.transport(method, url, headers, data, self.cfg.http_timeout)
            except AmbiguousRequest:
                if idempotent and attempt < self.max_retries:
                    self.sleep(2 ** attempt)
                    continue
                raise
            if status == 429:  # rejected before processing, so a retry is safe for every method
                if attempt < self.max_retries:
                    retry_after = {k.lower(): v for k, v in resp_headers.items()}.get("retry-after", "")
                    self.sleep(min(float(retry_after), 60.0) if retry_after.replace(".", "", 1).isdigit() else 2 ** (attempt + 1))
                    continue
                raise RenderHTTPError("Render rate limit reached (HTTP 429). Wait a few minutes and run again.", 429)
            if status in (401, 403):
                raise RenderAuthError(
                    "Render rejected the API key (HTTP 401). Create a new key and update RENDER_API_KEY." if status == 401
                    else "Render denied access (HTTP 403). The API key's account lacks permission for this service.")
            if status == 404:
                raise RenderHTTPError("Render resource not found (HTTP 404). Check RENDER_SERVICE_ID and that the API key can see the service.", 404)
            if status >= 500:
                if idempotent and attempt < self.max_retries:
                    self.sleep(2 ** attempt)
                    continue
                if not idempotent:
                    raise AmbiguousRequest(f"Render returned HTTP {status}; the request may have been processed.")
                raise RenderHTTPError(f"Render returned HTTP {status}. Try again later.", status)
            if status >= 400:
                raise RenderHTTPError(f"Render rejected the request (HTTP {status}).", status)
            payload: Any = None
            if raw:
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except ValueError:
                    payload = None
            return status, resp_headers, payload
        raise RenderHTTPError("Render request retries exhausted.")

    def _svc(self) -> str:
        return f"/services/{quote(self.cfg.render_service_id, safe='')}"

    def get_env(self, key: str = ENV_VAR_NAME) -> str | None:
        try:
            _, _, payload = self._call("GET", f"{self._svc()}/env-vars/{quote(key, safe='')}")
        except RenderHTTPError as exc:
            if exc.status == 404:
                return None
            raise
        return (payload or {}).get("value")

    def put_env(self, value: str, key: str = ENV_VAR_NAME) -> datetime:
        """Documented single-variable endpoint; other variables are untouched. Returns Render's server time."""
        _, headers, _ = self._call("PUT", f"{self._svc()}/env-vars/{quote(key, safe='')}", {"value": value})
        date = {k.lower(): v for k, v in headers.items()}.get("date")
        try:
            return parsedate_to_datetime(date).astimezone(timezone.utc) if date else utcnow()
        except (TypeError, ValueError):
            return utcnow()

    def create_deploy(self) -> str | None:
        """POST a deploy with default behaviour (latest commit of the connected branch). 201 returns the id; 202 does not."""
        status, _, payload = self._call("POST", f"{self._svc()}/deploys", {}, idempotent=False)
        return (payload or {}).get("id") if status == 201 else None

    def get_deploy(self, deploy_id: str) -> dict[str, Any]:
        _, _, payload = self._call("GET", f"{self._svc()}/deploys/{quote(deploy_id, safe='')}")
        return payload or {}

    def deploys_since(self, since: datetime) -> list[dict[str, Any]]:
        query = urlencode({"createdAfter": iso(since), "limit": 20})
        _, _, payload = self._call("GET", f"{self._svc()}/deploys?{query}")
        items = [(item.get("deploy", item) if isinstance(item, dict) else {}) for item in (payload or [])]
        return sorted((i for i in items if i.get("id")), key=lambda i: i.get("createdAt", ""))


def split_dsn(dsn: str) -> tuple[str, str | None, str]:
    """host[/fingerprint]:port -> (host, fingerprint or None, port)."""
    match = re.fullmatch(r"([^/:]+)(?:/([^:]+))?:(\d+)", dsn.strip())
    if not match:
        raise SyncError("Render's current EXASOL_DSN has an unexpected format (expected host[/fingerprint]:port).")
    return match.group(1), match.group(2), match.group(3)


def build_dsn(current: str | None, hostport: str, allow_create: bool = False) -> str:
    """Swap host and port but keep a certificate fingerprint already present in the current DSN."""
    host, port = hostport.rsplit(":", 1)
    if current is None:
        if not allow_create:
            raise SyncError("EXASOL_DSN does not exist on the Render service. Re-run with --allow-create to add it "
                            "(note: no certificate fingerprint can be inferred).")
        return hostport
    _, fingerprint, _ = split_dsn(current)
    return f"{host}/{fingerprint}:{port}" if fingerprint else f"{host}:{port}"


def describe_dsn(dsn: str | None) -> str:
    if dsn is None:
        return "(not set)"
    host, fingerprint, port = split_dsn(dsn)
    return f"{host}:{port}" + (" (certificate fingerprint preserved)" if fingerprint else "")


# ----------------------------------------------------------------------------- sync
@dataclass
class SyncResult:
    status: str  # unchanged | dry_run | updated | recovered
    desired: str = ""
    deploy_id: str | None = None
    message: str = ""


def adopt_deploy(state: dict[str, Any], store: StateStore, deploy_id: str, desired: str) -> None:
    state["last_deploy"] = {"id": deploy_id, "desired": desired, "requested_at": iso(utcnow())}
    state.pop("pending", None)
    store.save(state)


def reconcile_deploy(client: RenderClient, pending: dict[str, Any]) -> str | None:
    """Look for a deploy Render already created after our env update, instead of sending another request."""
    since = parse_iso(pending["env_applied_at"])
    if pending.get("deploy_attempt_at"):
        since = max(since, parse_iso(pending["deploy_attempt_at"]) - timedelta(minutes=2))
    deploys = client.deploys_since(since)
    return deploys[-1]["id"] if deploys else None


def ensure_deployment(client: RenderClient, store: StateStore, state: dict[str, Any], out: Callable[[str], None],
                      sleep: Callable[[float], None] = time.sleep) -> str | None:
    pending = state["pending"]
    existing = reconcile_deploy(client, pending) if (pending.get("deploy_attempt_at") or not pending.get("forced")) else None
    if existing:
        out(f"      Render already has deployment {existing} created after the update; not requesting another.")
        adopt_deploy(state, store, existing, pending["desired"])
        return existing
    attempt = pending.get("deploy_attempt_at")
    if attempt and utcnow() - parse_iso(attempt) < DEPLOY_RECONCILE_GRACE:
        raise DeployPending("A deployment request was sent but Render shows no deployment yet. Not re-sending; "
                            "run again in a few minutes (or after the 10-minute reconcile window).")
    pending["deploy_attempt_at"] = iso(utcnow())
    store.save(state)
    try:
        deploy_id = client.create_deploy()
    except AmbiguousRequest as exc:
        sleep(5)
        found = reconcile_deploy(client, pending)
        if found:
            out(f"      Request outcome was uncertain; Render shows deployment {found}.")
            adopt_deploy(state, store, found, pending["desired"])
            return found
        raise DeployPending(f"{exc} Not re-sending blindly; run again to reconcile with Render.") from exc
    except SyncError:
        pending.pop("deploy_attempt_at", None)  # definitely rejected; a later run may retry
        store.save(state)
        raise
    if deploy_id is None:  # 202 queued: no id returned
        sleep(3)
        deploy_id = reconcile_deploy(client, pending)
        if deploy_id is None:
            raise DeployPending("Render queued the deployment (HTTP 202) but its ID is not visible yet; run again to reconcile.")
    adopt_deploy(state, store, deploy_id, pending["desired"])
    return deploy_id


def wait_for_deploy(client: RenderClient, deploy_id: str, timeout: float, interval: float = 10.0,
                    out: Callable[[str], None] = say, sleep: Callable[[float], None] = time.sleep,
                    clock: Callable[[], float] = time.monotonic) -> str:
    deadline = clock() + timeout
    last = ""
    while True:
        status = str(client.get_deploy(deploy_id).get("status", "unknown"))
        if status != last:
            out(f"      deployment {deploy_id}: {status}")
            last = status
        if status in TERMINAL_OK | TERMINAL_FAIL | TERMINAL_OTHER:
            return status
        if clock() + interval > deadline:
            return f"timeout (last status: {status})"
        sleep(interval)


def sync_once(cfg: Config, client: RenderClient, store: StateStore, hostport: str, *, dry_run: bool = False,
              force_deploy: bool = False, allow_create: bool = False, out: Callable[[str], None] = say,
              sleep: Callable[[float], None] = time.sleep,
              on_stage: Callable[[str], None] | None = None) -> SyncResult:
    state = store.load()
    if on_stage:
        on_stage("updating_render")
    current = client.get_env()
    desired = build_dsn(current, hostport, allow_create)
    pending = state.get("pending")
    resume = bool(pending and pending.get("env_applied"))
    changed = current != desired

    if not changed and not resume and not force_deploy:
        return SyncResult("unchanged", desired, message="Render EXASOL_DSN already matches the ngrok address; no update, no deployment.")
    if dry_run:
        plan = []
        if changed:
            plan.append(f"update only {ENV_VAR_NAME} from {describe_dsn(current)} to {describe_dsn(desired)}")
        plan.append("trigger exactly one deployment" + (" (finishing a pending one)" if resume and not changed else ""))
        return SyncResult("dry_run", desired, message="Would " + ", then ".join(plan) + ". Nothing was changed.")

    if changed:
        state["pending"] = {"desired": desired, "env_applied": False, "created_at": iso(utcnow())}
        store.save(state)
        applied_at = client.put_env(desired)
        state["pending"].update(env_applied=True, env_applied_at=iso(applied_at))
        store.save(state)
        out(f"      Updated {ENV_VAR_NAME} on Render.")
    elif not resume:  # force-deploy with unchanged DSN
        state["pending"] = {"desired": desired, "env_applied": True, "forced": True,
                            "env_applied_at": iso(utcnow()), "created_at": iso(utcnow())}
        store.save(state)
    if on_stage:
        on_stage("deploying")
    deploy_id = ensure_deployment(client, store, state, out, sleep)
    return SyncResult("updated" if changed else "recovered", desired, deploy_id=deploy_id,
                      message=f"Deployment requested: {deploy_id}")


def verify_database_query(
    url: str,
    transport: Transport = urllib_transport,
    *,
    require_live_mode: bool = False,
) -> tuple[bool, str]:
    """Call a backend endpoint that runs SELECT COUNT(*) on DQPS.RAW_D2C_DATA."""
    try:
        status, _, raw = transport("GET", url, {"Accept": "application/json"}, None, 30.0)
    except SyncError as exc:
        return False, str(exc)
    if status != 200:
        return False, f"backend answered HTTP {status}"
    try:
        body = json.loads(raw.decode("utf-8"))
    except ValueError:
        return False, "backend response was not JSON"
    if (
        body.get("status") == "ready"
        and body.get("source") == "Exasol"
        and (
            body.get("mode") == "live"
            if require_live_mode
            else body.get("mode") != "demo"
        )
    ):
        return True, f"backend loaded {body.get('row_count')} rows from the Exasol dataset"
    if require_live_mode and body.get("mode") != "live":
        return False, "backend is not serving live Exasol mode"
    return False, f"backend reported status={body.get('status')}"


# ----------------------------------------------------------------------------- CLI
def run_once(args: argparse.Namespace, cfg: Config, out: Callable[[str], None] = say) -> int:
    store = StateStore(cfg.state_dir / "state.json")
    out("[1/5] Checking local database ...")
    check_database(cfg.db_host, cfg.db_port)
    out(f"      OK: Exasol reachable on {cfg.db_host}:{cfg.db_port}")

    out("[2/5] Looking for the ngrok tunnel ...")
    hostport, inspect_addr, started = ensure_tunnel(cfg, store)
    out(f"      ngrok {'started' if started else 'reused'} (inspection API {inspect_addr})")
    out(f"[3/5] Current public address: {hostport}")

    require_render_config(cfg)
    client = RenderClient(cfg)
    out("[4/5] Comparing with Render ...")
    with RunLock(cfg.state_dir / "sync.lock"):
        result = sync_once(cfg, client, store, hostport, dry_run=args.dry_run, force_deploy=args.force_deploy,
                           allow_create=args.allow_create, out=out)
        out(f"      {result.status.upper()}: {result.message}")
        out("[5/5] Deployment")
        deploy_id = result.deploy_id or store.load().get("last_deploy", {}).get("id")
        if result.status in ("updated", "recovered"):
            out(f"      Deployment REQUESTED (id {deploy_id}).")
        if args.wait and deploy_id and not args.dry_run:
            final = wait_for_deploy(client, deploy_id, args.wait_timeout, out=out)
            out(f"      Deployment status: {final}" + ("  -> LIVE" if final == "live" else ""))
            if final != "live":
                return EXIT_ERROR
            if args.verify_url:
                ok, detail = verify_database_query(args.verify_url)
                out(f"      Database query verification: {'VERIFIED' if ok else 'NOT verified'} ({detail})")
                return EXIT_OK if ok else EXIT_ERROR
            out("      'live' only means the service started; the database query is NOT verified (use --verify-url).")
    if started and args.stop_on_exit:
        out(stop_owned_ngrok(store))
    return EXIT_OK


def run_watch(args: argparse.Namespace, cfg: Config, out: Callable[[str], None] = say) -> int:
    """Poll the tunnel; apply a new address only after it is stable for --debounce polls."""
    store = StateStore(cfg.state_dir / "state.json")
    require_render_config(cfg)
    client = RenderClient(cfg)
    candidate, stable, last_synced, backoff, last_deploy_at = None, 0, None, 0.0, float("-inf")
    out(f"Watching every {args.interval}s (debounce {args.debounce} polls). Press Ctrl+C to stop; ngrok keeps running.")
    while True:
        try:
            check_database(cfg.db_host, cfg.db_port)
            hostport, _, started = ensure_tunnel(cfg, store)
            stable = stable + 1 if hostport == candidate else 1
            candidate = hostport
            due = hostport != last_synced or bool(store.load().get("pending"))
            cooled = time.monotonic() - last_deploy_at >= args.min_deploy_interval
            if started:
                out(f"ngrok restarted; new address {hostport}")
            if due and stable >= args.debounce and cooled:
                with RunLock(cfg.state_dir / "sync.lock"):
                    result = sync_once(cfg, client, store, hostport, dry_run=args.dry_run, out=out)
                out(f"{result.status.upper()}: {result.message}")
                last_synced = hostport
                if result.status in ("updated", "recovered"):
                    last_deploy_at = time.monotonic()
            backoff = 0.0
        except LockHeld as exc:
            out(str(exc))
        except SyncError as exc:
            backoff = min(max(backoff * 2, args.interval), 600.0)
            out(f"Problem: {exc} (retrying in {backoff:.0f}s)")
        try:
            time.sleep(max(backoff, args.interval))
        except KeyboardInterrupt:
            return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Sync ngrok's public Exasol address into Render's EXASOL_DSN.")
    p.add_argument("--dry-run", action="store_true", help="discover and describe changes; do not modify Render")
    p.add_argument("--wait", action="store_true", help="poll the deployment until it finishes")
    p.add_argument("--wait-timeout", type=float, default=900.0)
    p.add_argument("--verify-url", help="backend URL of /api/datasets/status to prove a live DB query after deploy")
    p.add_argument("--force-deploy", action="store_true", help="recovery: deploy even if EXASOL_DSN is unchanged")
    p.add_argument("--allow-create", action="store_true", help="allow creating EXASOL_DSN if it is missing")
    p.add_argument("--watch", action="store_true", help="keep monitoring the tunnel")
    p.add_argument("--interval", type=float, default=60.0)
    p.add_argument("--debounce", type=int, default=3, help="consecutive identical polls before applying (watch)")
    p.add_argument("--min-deploy-interval", type=float, default=600.0, help="minimum seconds between deployments (watch)")
    p.add_argument("--stop", action="store_true", help="stop only the ngrok process this tool started, then exit")
    p.add_argument("--stop-on-exit", action="store_true", help="stop ngrok afterwards if this run started it")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config()
    try:
        if args.stop:
            say(stop_owned_ngrok(StateStore(cfg.state_dir / "state.json")))
            return EXIT_OK
        return run_watch(args, cfg) if args.watch else run_once(args, cfg)
    except SyncError as exc:
        say(f"ERROR: {exc}")
        return exc.exit_code
    except KeyboardInterrupt:
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
