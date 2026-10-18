"""Mocked tests for the outbound local database helper."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

HELPER_DIR = Path(__file__).resolve().parents[2] / "db_helper"
sys.path.insert(0, str(HELPER_DIR))
import helper as db_helper  # noqa: E402
import ngrok_render_sync as nrs  # noqa: E402


@pytest.fixture
def helper_instance(tmp_path):
    logger = logging.getLogger(f"helper-test-{id(tmp_path)}")
    logger.addHandler(logging.NullHandler())
    instance = db_helper.DatabaseHelper(
        "https://backend.example",
        "test-helper-token",
        nrs.Config(render_api_key="test-key", render_service_id="srv-test", state_dir=tmp_path),
        tmp_path,
        logger=logger,
        sleep=lambda _seconds: None,
        request=lambda _method, _path, _payload: {"action": "none"},
    )
    return instance


def test_duplicate_start_requests_are_ignored_while_a_worker_is_active(helper_instance, monkeypatch):
    instances = []

    class FakeThread:
        def __init__(self, target, args, name, daemon):
            self.target, self.args = target, args
            self.alive = False
            instances.append(self)

        def start(self):
            self.alive = True

        def is_alive(self):
            return self.alive

    monkeypatch.setattr(db_helper.threading, "Thread", FakeThread)
    assert helper_instance.accept_start("job-1") is True
    assert helper_instance.accept_start("job-1") is False
    assert helper_instance.accept_start("job-2") is False
    assert len(instances) == 1


def test_saved_progress_is_retried_after_backend_outage(helper_instance):
    job = {
        "job_id": "job-1",
        "step": "deploying",
        "message": "Waiting for the Render deployment.",
        "updated_at": "2026-10-18T00:00:00+00:00",
    }
    helper_instance._save_job(job)
    backend_available = False
    reports = []

    def request(method, path, payload):
        nonlocal backend_available
        if not backend_available:
            raise OSError("simulated backend outage")
        if method == "GET":
            return {"action": "none"}
        reports.append(payload)
        return {"accepted": True}

    helper_instance._request_override = request
    helper_instance.poll_once()
    assert helper_instance._load_job() == job
    assert reports == []

    backend_available = True
    helper_instance.poll_once()
    assert reports == [{
        "job_id": "job-1",
        "step": "deploying",
        "message": "Waiting for the Render deployment.",
    }]


def test_stage_report_retries_until_backend_returns(helper_instance):
    attempts = 0

    def request(method, _path, _payload):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("simulated backend outage")
        return {"accepted": True}

    helper_instance._request_override = request
    job = {
        "job_id": "job-1",
        "step": "starting_exasol",
        "message": "Starting Exasol.",
        "updated_at": "2026-10-18T00:00:00+00:00",
    }
    helper_instance._report_until_accepted(job)
    assert attempts == 2


def test_polling_runs_and_reports_the_fixed_start_workflow(helper_instance):
    reports = []

    def request(method, _path, payload):
        if method == "GET":
            return {"action": "start", "job_id": "job-1"} if not reports else {"action": "none"}
        reports.append(payload["step"])
        return {"accepted": True}

    class MockWorkflow(db_helper.DatabaseHelper):
        def _execute_sync(self, job_id):
            for step in (
                "starting_exasol", "starting_tunnel", "updating_render",
                "deploying", "verifying",
            ):
                self._set_step(job_id, step, f"Mocked {step} progress.")

    instance = MockWorkflow(
        helper_instance.backend_url,
        helper_instance.helper_token,
        helper_instance.cfg,
        helper_instance.state_dir,
        logger=helper_instance.logger,
        sleep=lambda _seconds: None,
        request=request,
    )
    instance.poll_once()
    assert instance._worker is not None
    instance._worker.join(timeout=5)
    assert not instance._worker.is_alive()
    assert list(dict.fromkeys(reports)) == [
        "requested", "starting_exasol", "starting_tunnel", "updating_render",
        "deploying", "verifying", "done",
    ]
