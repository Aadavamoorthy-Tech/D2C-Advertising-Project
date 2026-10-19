"""Mocked tests. No live Render, ngrok, Exasol, or network access is used."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ngrok_render_sync as nrs  # noqa: E402

DSN_OLD = "old.tcp.ngrok.io/ABCDEF123:11111"
DSN_NEW = "0.tcp.in.ngrok.io/ABCDEF123:22222"
TUNNEL = {"tunnels": [{"proto": "tcp", "public_url": "tcp://0.tcp.in.ngrok.io:22222",
                       "config": {"addr": "localhost:8563"}}]}


@pytest.fixture
def cfg(tmp_path):
    return nrs.Config(render_api_key="rnd_FAKE", render_service_id="srv-1", state_dir=tmp_path)


@pytest.fixture
def store(tmp_path):
    return nrs.StateStore(tmp_path / "state.json")


class FakeRender:
    """Scripted transport; records every call and never leaves the process."""

    def __init__(self, env=DSN_OLD):
        self.env, self.calls, self.deploys = env, [], []
        self.put_status, self.post_behaviour, self.statuses = 200, "201", {}

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url))
        path = url.split("/v1", 1)[1]
        if "/env-vars/" in path:
            if method == "GET":
                if self.env is None:
                    return 404, {}, b"{}"
                return 200, {}, json.dumps({"key": "EXASOL_DSN", "value": self.env}).encode()
            if self.put_status != 200:
                return self.put_status, {}, b"{}"
            self.env = json.loads(body)["value"]
            return 200, {"Date": "Sun, 18 Oct 2026 06:00:00 GMT"}, b"{}"
        if path.endswith("/deploys") and method == "POST":
            if self.post_behaviour == "timeout":
                self.deploys.append("dep-ghost")  # Render did process it
                raise nrs.AmbiguousRequest("timeout")
            if self.post_behaviour == "timeout-lost":
                raise nrs.AmbiguousRequest("timeout")
            if self.post_behaviour == "500":
                return 500, {}, b"{}"
            if self.post_behaviour == "fail":
                return 400, {}, b"{}"
            self.deploys.append("dep-1")
            return 201, {}, json.dumps({"id": "dep-1", "status": "created"}).encode()
        if "/deploys?" in path:
            now = datetime(2099, 1, 1, tzinfo=timezone.utc).isoformat()
            return 200, {}, json.dumps([{"deploy": {"id": d, "createdAt": now}} for d in self.deploys]).encode()
        if "/deploys/" in path:
            dep = path.rsplit("/", 1)[1]
            return 200, {}, json.dumps({"id": dep, "status": self.statuses.get(dep, "live")}).encode()
        raise AssertionError(path)

    def count(self, method, needle=""):
        return sum(1 for m, u in self.calls if m == method and needle in u)


def client_for(cfg, fake):
    return nrs.RenderClient(cfg, transport=fake, sleep=lambda s: None)


def run_sync(cfg, store, fake, host="0.tcp.in.ngrok.io:22222", **kw):
    return nrs.sync_once(cfg, client_for(cfg, fake), store, host, out=lambda m: None, sleep=lambda s: None, **kw)


# ---- ngrok / preflight ---------------------------------------------------------------
def test_ngrok_not_installed(cfg):
    with pytest.raises(nrs.NgrokNotFound, match="not found on PATH"):
        nrs.find_ngrok(cfg, which=lambda name: None)


def test_ngrok_configured_path_missing(cfg):
    cfg.ngrok_path = str(Path(cfg.state_dir) / "nope.exe")
    with pytest.raises(nrs.NgrokNotFound):
        nrs.find_ngrok(cfg)


def test_database_unavailable_stops_with_actionable_message():
    def refuse(*a, **k):
        raise ConnectionRefusedError()
    with pytest.raises(nrs.PreflightError, match="Start your local Exasol"):
        nrs.check_database("127.0.0.1", 8563, connect=refuse)


def test_inspection_api_on_4041():
    def get_json(url, timeout=3.0):
        if ":4040" in url:
            raise ConnectionRefusedError()
        return TUNNEL
    found = nrs.find_matching_tunnel(["127.0.0.1:4040", "127.0.0.1:4041"], {"localhost:8563", "127.0.0.1:8563"}, get_json)
    assert found == ("127.0.0.1:4041", "tcp://0.tcp.in.ngrok.io:22222")


def test_unrelated_tunnels_are_never_selected():
    payload = {"tunnels": [
        {"proto": "tcp", "public_url": "tcp://0.tcp.ngrok.io:1", "config": {"addr": "localhost:22"}},
        {"proto": "tcp", "public_url": "tcp://0.tcp.ngrok.io:2", "config": {"addr": "localhost:85630"}},
        {"proto": "https", "public_url": "https://x.ngrok.app", "config": {"addr": "localhost:8563"}},
        {"proto": "tcp", "public_url": "tcp://0.tcp.ngrok.io:3", "config": {"addr": "127.0.0.1:8563"}},
    ]}
    found = nrs.find_matching_tunnel(["127.0.0.1:4040"], {"localhost:8563", "127.0.0.1:8563"}, lambda u, timeout=3.0: payload)
    assert found[1] == "tcp://0.tcp.ngrok.io:3"
    only_unrelated = {"tunnels": payload["tunnels"][:2]}
    assert nrs.find_matching_tunnel(["127.0.0.1:4040"], {"localhost:8563"}, lambda u, timeout=3.0: only_unrelated) is None


def test_endpoints_api_format_is_supported():
    def get_json(url, timeout=3.0):
        if url.endswith("/api/tunnels"):
            raise ValueError("deprecated")
        return {"endpoints": [{"url": "tcp://5.tcp.ngrok.io:999", "upstream": {"url": "tcp://localhost:8563"}}]}
    assert nrs.find_matching_tunnel(["127.0.0.1:4040"], {"localhost:8563"}, get_json)[1] == "tcp://5.tcp.ngrok.io:999"


def test_public_url_conversion():
    assert nrs.tcp_public_url_to_hostport("tcp://0.tcp.in.ngrok.io:12345") == "0.tcp.in.ngrok.io:12345"
    with pytest.raises(nrs.SyncError):
        nrs.tcp_public_url_to_hostport("https://x.ngrok.app")


def test_reuse_does_not_start_ngrok(cfg, store):
    hostport, addr, started = nrs.ensure_tunnel(
        cfg, store, get_json=lambda u, timeout=3.0: TUNNEL,
        popen=lambda *a, **k: pytest.fail("must not start ngrok"))
    assert (hostport, started) == ("0.tcp.in.ngrok.io:22222", False)


def test_start_reads_own_inspection_port_and_records_owner(cfg, store, monkeypatch):
    cfg.inspect_addrs = ("127.0.0.1:4040",)
    monkeypatch.setattr(nrs, "find_ngrok", lambda c: "ngrok.exe")

    class Proc:
        pid, returncode = 4321, None

        def poll(self):
            return None

    def popen(cmd, stdout, **kw):
        assert cmd[:3] == ["ngrok.exe", "tcp", "127.0.0.1:8563"]
        stdout.write('t=1 lvl=info msg="starting web service" obj=web addr=127.0.0.1:4055\n')
        return Proc()

    seen = []

    def get_json(url, timeout=3.0):
        seen.append(url)
        if ":4055" not in url:
            raise ConnectionRefusedError()
        return TUNNEL
    hostport, addr, started = nrs.ensure_tunnel(cfg, store, get_json=get_json, popen=popen, sleep=lambda s: None)
    assert started and addr == "127.0.0.1:4055"
    assert store.load()["ngrok"]["pid"] == 4321 and store.load()["ngrok"]["inspect_addr"] == "127.0.0.1:4055"
    # a later run finds the owned instance on its recorded address and does not start another
    again = nrs.ensure_tunnel(cfg, store, get_json=get_json, popen=lambda *a, **k: pytest.fail("restarted"))
    assert again[2] is False


def test_ngrok_startup_failure_reports_log(cfg, store, monkeypatch):
    monkeypatch.setattr(nrs, "find_ngrok", lambda c: "ngrok.exe")

    class Proc:
        pid, returncode = 1, 1

        def poll(self):
            return 1

    def popen(cmd, stdout, **kw):
        stdout.write("ERROR: authentication failed\n")
        return Proc()
    with pytest.raises(nrs.SyncError, match="authentication failed"):
        nrs.start_ngrok(cfg, store, popen=popen, get_json=lambda u, timeout=3.0: {}, sleep=lambda s: None)


def test_stop_only_owned_ngrok(store):
    store.save({"ngrok": {"pid": 99}})
    killed = []
    msg = nrs.stop_owned_ngrok(store, alive=lambda p: True, is_ngrok=lambda p: False, run=lambda *a, **k: killed.append(a))
    assert not killed and "refusing" in msg
    store.save({"ngrok": {"pid": 99}})
    nrs.stop_owned_ngrok(store, alive=lambda p: True, is_ngrok=lambda p: True, run=lambda cmd, **k: killed.append(cmd))
    assert killed == [["taskkill", "/PID", "99", "/T", "/F"]]


# ---- Render sync ---------------------------------------------------------------------
def test_dsn_keeps_fingerprint():
    assert nrs.build_dsn(DSN_OLD, "0.tcp.in.ngrok.io:22222") == DSN_NEW
    assert nrs.build_dsn("h:1", "a.b:2") == "a.b:2"


def test_unchanged_dsn_does_nothing(cfg, store):
    fake = FakeRender(env=DSN_NEW)
    result = run_sync(cfg, store, fake)
    assert result.status == "unchanged"
    assert fake.count("PUT") == 0 and fake.count("POST") == 0


def test_changed_dsn_updates_one_variable_and_deploys_once(cfg, store):
    fake = FakeRender()
    result = run_sync(cfg, store, fake)
    assert result.status == "updated" and result.deploy_id == "dep-1"
    puts = [u for m, u in fake.calls if m == "PUT"]
    assert puts == [f"{cfg.render_base_url}/services/srv-1/env-vars/EXASOL_DSN"]
    assert fake.count("POST") == 1 and fake.env == DSN_NEW
    assert "pending" not in store.load() and store.load()["last_deploy"]["id"] == "dep-1"
    again = run_sync(cfg, store, fake)  # rerun is idempotent
    assert again.status == "unchanged" and fake.count("POST") == 1


def test_dry_run_changes_nothing(cfg, store):
    fake = FakeRender()
    result = run_sync(cfg, store, fake, dry_run=True)
    assert result.status == "dry_run" and "Nothing was changed" in result.message
    assert fake.count("PUT") == 0 and fake.count("POST") == 0 and store.load() == {}


def test_missing_variable_requires_allow_create(cfg, store):
    with pytest.raises(nrs.SyncError, match="allow-create"):
        run_sync(cfg, store, FakeRender(env=None))


@pytest.mark.parametrize("status,needle", [(401, "rejected the API key"), (403, "lacks permission")])
def test_auth_errors_are_clear_and_leak_nothing(cfg, status, needle):
    client = client_for(cfg, lambda *a: (status, {}, b'{"message":"secret"}'))
    with pytest.raises(nrs.RenderAuthError, match=needle) as caught:
        client.get_env()
    assert "rnd_FAKE" not in str(caught.value)


def test_rate_limit_honours_retry_after_then_succeeds(cfg):
    sleeps, replies = [], iter([(429, {"Retry-After": "7"}, b""), (200, {}, b'{"value":"x:1"}')])
    client = nrs.RenderClient(cfg, transport=lambda *a: next(replies), sleep=sleeps.append)
    assert client.get_env() == "x:1" and sleeps == [7.0]


def test_rate_limit_exhaustion_message(cfg):
    client = nrs.RenderClient(cfg, transport=lambda *a: (429, {}, b""), sleep=lambda s: None, max_retries=2)
    with pytest.raises(nrs.RenderHTTPError, match="rate limit"):
        client.get_env()


def test_env_update_ok_but_deploy_fails_then_later_run_finishes(cfg, store):
    fake = FakeRender()
    fake.post_behaviour = "fail"
    with pytest.raises(nrs.RenderHTTPError):
        run_sync(cfg, store, fake)
    assert fake.env == DSN_NEW and store.load()["pending"]["env_applied"] is True
    fake.post_behaviour = "201"
    result = run_sync(cfg, store, fake)  # Render DSN already matches, pending must still finish
    assert result.status == "recovered" and result.deploy_id == "dep-1"
    assert fake.count("PUT") == 1 and fake.count("POST") == 2  # one rejected, one accepted
    assert "pending" not in store.load()


def test_ambiguous_timeout_reconciles_instead_of_resending(cfg, store):
    fake = FakeRender()
    fake.post_behaviour = "timeout"  # Render actually created the deploy
    result = run_sync(cfg, store, fake)
    assert result.deploy_id == "dep-ghost"
    assert fake.count("POST") == 1


def test_ambiguous_timeout_without_deploy_is_not_blindly_retried(cfg, store):
    fake = FakeRender()
    fake.post_behaviour = "timeout-lost"
    with pytest.raises(nrs.DeployPending):
        run_sync(cfg, store, fake)
    with pytest.raises(nrs.DeployPending, match="Not re-sending"):
        run_sync(cfg, store, fake)
    assert fake.count("POST") == 1
    state = store.load()  # after the grace window a retry is allowed
    state["pending"]["deploy_attempt_at"] = nrs.iso(nrs.utcnow() - timedelta(minutes=11))
    store.save(state)
    fake.post_behaviour = "201"
    assert run_sync(cfg, store, fake).deploy_id == "dep-1"


def test_post_500_is_treated_as_ambiguous(cfg):
    client = client_for(cfg, FakeRender())
    client.transport = lambda *a: (500, {}, b"")
    with pytest.raises(nrs.AmbiguousRequest):
        client.create_deploy()


def test_force_deploy_with_unchanged_dsn(cfg, store):
    fake = FakeRender(env=DSN_NEW)
    result = run_sync(cfg, store, fake, force_deploy=True)
    assert result.status == "recovered" and fake.count("PUT") == 0 and fake.count("POST") == 1


def test_wait_for_deploy_states(cfg):
    fake = FakeRender()
    fake.statuses["d"] = "build_failed"
    assert nrs.wait_for_deploy(client_for(cfg, fake), "d", 30, out=lambda m: None, sleep=lambda s: None) == "build_failed"
    ticks = iter(range(0, 1000, 20))
    fake.statuses["d"] = "build_in_progress"
    final = nrs.wait_for_deploy(client_for(cfg, fake), "d", 30, out=lambda m: None, sleep=lambda s: None, clock=lambda: next(ticks))
    assert final.startswith("timeout")


def test_verify_distinguishes_live_from_query_verified():
    ok = lambda *a: (200, {}, b'{"status":"ready","source":"Exasol","row_count":15000}')
    assert nrs.verify_database_query("https://x/api/datasets/status", ok)[0] is True
    bad = lambda *a: (503, {}, b"{}")
    assert nrs.verify_database_query("https://x/api/datasets/status", bad)[0] is False
    demo = lambda *a: (200, {}, b'{"status":"ready","source":"Exasol","row_count":15000,"mode":"demo"}')
    assert nrs.verify_database_query("https://x/api/db/start/verify", demo)[0] is False
    live = lambda *a: (200, {}, b'{"status":"ready","source":"Exasol","row_count":15000,"mode":"live"}')
    assert nrs.verify_database_query(
        "https://x/api/db/start/verify", live, require_live_mode=True
    )[0] is True


# ---- concurrency / config ------------------------------------------------------------
def test_concurrent_invocation_is_blocked(tmp_path):
    lock_path = tmp_path / "sync.lock"
    with nrs.RunLock(lock_path):
        with pytest.raises(nrs.LockHeld):
            with nrs.RunLock(lock_path):
                pass
    assert not lock_path.exists()


def test_stale_lock_is_recovered(tmp_path):
    lock_path = tmp_path / "sync.lock"
    lock_path.write_text("999999")
    with nrs.RunLock(lock_path, alive=lambda pid: False):
        assert lock_path.read_text() == str(os.getpid())


def test_config_env_overrides_file_and_repr_hides_key(tmp_path):
    env_file = tmp_path / "local.env"
    env_file.write_text("RENDER_API_KEY=file-key\nRENDER_SERVICE_ID=srv-file\nNGROK_INSPECT_ADDRS=127.0.0.1:4045\n")
    cfg = nrs.load_config({"RENDER_API_KEY": "env-key"}, env_file)
    assert cfg.render_api_key == "env-key" and cfg.render_service_id == "srv-file"
    assert cfg.inspect_addrs == ("127.0.0.1:4045",)
    assert "env-key" not in repr(cfg)
