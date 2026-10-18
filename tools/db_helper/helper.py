"""Outbound-only laptop helper for authenticated database-start requests."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

SYNC_DIR = Path(__file__).resolve().parents[1] / "ngrok_render_sync"
if str(SYNC_DIR) not in sys.path:
    sys.path.insert(0, str(SYNC_DIR))

import ngrok_render_sync as nrs  # noqa: E402

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
POLL_SECONDS = 15
REPORT_RETRY_SECONDS = 5
TERMINAL_STEPS = {"done", "failed"}


class BackendHTTPError(Exception):
    def __init__(self, status: int):
        super().__init__(f"backend returned HTTP {status}")
        self.status = status


def load_settings(env_file: Path | None = None) -> dict[str, str]:
    path = env_file or SYNC_DIR / "local.env"
    values = nrs.parse_env_file(path)
    values.update({key: value for key, value in os.environ.items() if value})
    return values


def configure_logging(state_dir: Path = STATE_DIR) -> logging.Logger:
    state_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("adpilot.db_helper")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        filename = state_dir / f"helper-{datetime.now():%Y%m}.log"
        handler = logging.FileHandler(filename, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    return logger


class DatabaseHelper:
    def __init__(
        self,
        backend_url: str,
        helper_token: str,
        cfg: nrs.Config,
        state_dir: Path = STATE_DIR,
        *,
        logger: logging.Logger | None = None,
        sleep: Callable[[float], None] = time.sleep,
        request: Callable[[str, str, dict[str, Any] | None], dict[str, Any]] | None = None,
    ):
        self.backend_url = backend_url.rstrip("/")
        self.helper_token = helper_token
        self.cfg = cfg
        self.state_dir = state_dir
        self.job_path = state_dir / "job.json"
        self.logger = logger or configure_logging(state_dir)
        self.sleep = sleep
        self._request_override = request
        self._active_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._active_job_id: str | None = None
        self._worker: threading.Thread | None = None

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._request_override:
            return self._request_override(method, path, payload)
        headers = {"Authorization": f"Bearer {self.helper_token}", "Accept": "application/json"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.backend_url}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise BackendHTTPError(exc.code) from None

    def _load_job(self) -> dict[str, Any] | None:
        with self._state_lock:
            try:
                result = json.loads(self.job_path.read_text(encoding="utf-8"))
                return result if isinstance(result, dict) and result.get("job_id") else None
            except (OSError, ValueError):
                return None

    def _save_job(self, job: dict[str, Any]) -> None:
        with self._state_lock:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            temporary = self.job_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(job, indent=2), encoding="utf-8")
            os.replace(temporary, self.job_path)

    def _report_once(self, job: dict[str, Any]) -> bool:
        try:
            self._request("POST", "/api/helper/report", {
                "job_id": job["job_id"],
                "step": job["step"],
                "message": job["message"],
            })
            return True
        except BackendHTTPError as exc:
            if exc.status == 409:
                raise
            self.logger.warning("Progress report unavailable (HTTP %s); will retry.", exc.status)
        except (OSError, ValueError, TimeoutError) as exc:
            self.logger.warning("Progress report unavailable (%s); will retry.", type(exc).__name__)
        return False

    def _report_until_accepted(self, job: dict[str, Any]) -> None:
        while not self._report_once(job):
            self.sleep(REPORT_RETRY_SECONDS)

    def _set_step(self, job_id: str, step: str, message: str) -> dict[str, Any]:
        job = {
            "job_id": job_id,
            "step": step,
            "message": message,
            "updated_at": datetime.now().astimezone().isoformat(),
        }
        self._save_job(job)
        self._report_until_accepted(job)
        return job

    def _start_exasol(self) -> None:
        script = SYNC_DIR / "Start-ExasolTunnel.ps1"
        result = subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(script), "-EnsureExasolOnly",
            ],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if result.returncode:
            output = f"{result.stdout}\n{result.stderr}".lower()
            if "interrupted" in output:
                raise RuntimeError("Exasol runtime is interrupted.")
            raise RuntimeError("Exasol runtime could not be started.")

    def _execute_sync(self, job_id: str) -> None:
        store = nrs.StateStore(self.cfg.state_dir / "state.json")
        with nrs.RunLock(self.cfg.state_dir / "sync.lock"):
            self._set_step(job_id, "starting_exasol", "Checking Exakit and starting Exasol if it is stopped.")
            try:
                self._start_exasol()
            except RuntimeError:
                raise
            except (OSError, subprocess.SubprocessError) as exc:
                raise RuntimeError("Exasol startup could not be completed.") from exc

            self._set_step(job_id, "starting_tunnel", "Starting or reusing the ngrok TCP tunnel.")
            hostport, _, _ = nrs.ensure_tunnel(self.cfg, store)
            self._set_step(job_id, "updating_render", "Checking Render's EXASOL_DSN and deployment state.")
            nrs.require_render_config(self.cfg)
            client = nrs.RenderClient(self.cfg)
            result = nrs.sync_once(
                self.cfg,
                client,
                store,
                hostport,
                out=lambda _message: None,
                on_stage=lambda step: self._set_step(
                    job_id,
                    step,
                    "Updating only EXASOL_DSN on Render." if step == "updating_render"
                    else "Waiting for the Render deployment.",
                ),
            )
            if result.status == "unchanged":
                self._set_step(
                    job_id,
                    "deploying",
                    "Render EXASOL_DSN already matches; no deployment is needed.",
                )
            if result.status in {"updated", "recovered"}:
                deploy_id = result.deploy_id or store.load().get("last_deploy", {}).get("id")
                if not deploy_id:
                    raise RuntimeError("Render deployment could not be confirmed.")
                status = nrs.wait_for_deploy(
                    client,
                    deploy_id,
                    timeout=900,
                    interval=10,
                    out=lambda _message: None,
                )
                if status != "live":
                    raise RuntimeError("Render deployment did not become live.")

            self._set_step(job_id, "verifying", "Verifying a real query against DQPS.RAW_D2C_DATA.")
            verified, _detail = nrs.verify_database_query(
                f"{self.backend_url}/api/datasets/status"
            )
            if not verified:
                raise RuntimeError("The live Exasol dataset query could not be verified.")

    def _run_job(self, job_id: str) -> None:
        try:
            self._set_step(job_id, "requested", "The laptop helper accepted the database-start request.")
            self._execute_sync(job_id)
            self._set_step(job_id, "done", "Exasol is reachable through ngrok and the live dataset query succeeded.")
            self.logger.info("Database start job completed.")
        except Exception as exc:
            interrupted = isinstance(exc, RuntimeError) and "interrupted" in str(exc).lower()
            message = (
                "Exasol needs manual attention; inspect Exakit status and logs."
                if interrupted
                else "Database startup failed during local startup or Render verification; review the local helper log."
            )
            self.logger.error("Database start job failed (%s).", type(exc).__name__)
            try:
                self._set_step(job_id, "failed", message)
            except (BackendHTTPError, OSError, ValueError, TimeoutError) as report_exc:
                self.logger.error("Final failure report interrupted (%s); the saved state will be retried.", type(report_exc).__name__)
        finally:
            with self._active_lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None

    def accept_start(self, job_id: str) -> bool:
        if not job_id or len(job_id) > 80:
            return False
        with self._active_lock:
            if self._active_job_id is not None or (self._worker and self._worker.is_alive()):
                return False
            self._active_job_id = job_id
            self._save_job({
                "job_id": job_id,
                "step": "requested",
                "message": "The laptop helper accepted the database-start request.",
                "updated_at": datetime.now().astimezone().isoformat(),
            })
            self._worker = threading.Thread(
                target=self._run_job, args=(job_id,), name="database-start", daemon=True
            )
            self._worker.start()
            return True

    def _retry_saved_report(self) -> None:
        job = self._load_job()
        if job:
            try:
                self._report_once(job)
            except BackendHTTPError as exc:
                self.logger.warning("Saved progress belongs to a superseded job (HTTP %s).", exc.status)

    def poll_once(self) -> None:
        try:
            result = self._request("GET", "/api/helper/poll")
        except (BackendHTTPError, OSError, ValueError, TimeoutError) as exc:
            reason = f"HTTP {exc.status}" if isinstance(exc, BackendHTTPError) else type(exc).__name__
            self.logger.warning("Backend poll unavailable (%s); progress will be retried.", reason)
            self._retry_saved_report()
            return
        if result.get("action") == "start" and isinstance(result.get("job_id"), str):
            if not self.accept_start(result["job_id"]):
                self.logger.info("Ignored a duplicate start request while a job is active.")
        elif result.get("action") not in {"none", "start"}:
            self.logger.warning("Ignored an unsupported helper action.")
        self._retry_saved_report()

    def recover_interrupted_job(self) -> None:
        previous = self._load_job()
        if previous and previous.get("step") not in TERMINAL_STEPS:
            failed = {
                **previous,
                "step": "failed",
                "message": "The helper restarted during this run; retry the database start.",
                "updated_at": datetime.now().astimezone().isoformat(),
            }
            self._save_job(failed)
            try:
                self._report_until_accepted(failed)
            except BackendHTTPError as exc:
                self.logger.warning("Previous job could not be restored (HTTP %s); polling continues.", exc.status)

    def run_forever(self) -> None:
        self.recover_interrupted_job()
        self.logger.info("Database helper started; polling the backend every %s seconds.", POLL_SECONDS)
        while True:
            self.poll_once()
            self.sleep(POLL_SECONDS)


def main() -> int:
    settings = load_settings()
    backend_url = settings.get("BACKEND_URL", "").strip()
    helper_token = settings.get("HELPER_TOKEN", "").strip()
    try:
        parsed_url = urlsplit(backend_url)
        secure_remote = parsed_url.scheme == "https" and bool(parsed_url.hostname)
        local_http = parsed_url.scheme == "http" and parsed_url.hostname in {"localhost", "127.0.0.1", "::1"}
        valid_url = (
            (secure_remote or local_http)
            and not parsed_url.username
            and not parsed_url.password
            and parsed_url.path in {"", "/"}
            and not parsed_url.query
            and not parsed_url.fragment
        )
    except ValueError:
        valid_url = False
    if not valid_url:
        print("Set BACKEND_URL to the Render backend URL (or a local loopback URL).")
        return 2
    if not helper_token or helper_token.startswith("REPLACE_WITH_"):
        print("Set HELPER_TOKEN in tools\\ngrok_render_sync\\local.env or the user environment.")
        return 2
    cfg = nrs.load_config(env=settings)
    helper = DatabaseHelper(backend_url, helper_token, cfg)
    try:
        helper.run_forever()
    except KeyboardInterrupt:
        helper.logger.info("Database helper stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
