from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("adpilot_backend", APP_PATH)
assert SPEC and SPEC.loader
app_module = importlib.util.module_from_spec(SPEC)
sys.modules["adpilot_backend"] = app_module
SPEC.loader.exec_module(app_module)
client = TestClient(app_module.app)


@pytest.fixture(autouse=True)
def demo_data(monkeypatch):
    monkeypatch.setattr(app_module, "DEMO_MODE", True)
    monkeypatch.setattr(app_module, "demo_frame", None)
    monkeypatch.setattr(
        app_module,
        "DEFAULT_CSV",
        Path(__file__).resolve().parents[2] / "engineered_d2c_dataset_15k_v5.csv",
    )
    monkeypatch.setattr(app_module, "demo_status", {
        "dataset_id": None,
        "file_name": "fixture.csv",
        "row_count": 0,
        "ingested_at": None,
        "status": "not_loaded",
        "duplicate_rows": 0,
        "warnings": [],
    })


def test_demo_health_is_explicit():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "demo", "source": "local CSV fixture"}


def test_overview_uses_real_fixture_and_weighted_ratios():
    response = client.get("/api/overview")
    assert response.status_code == 200
    result = response.json()
    assert result["is_demo"] is True
    assert result["metrics"]["record_count"] == 15000
    assert result["metrics"]["roas"] == pytest.approx(
        result["metrics"]["attributed_revenue"] / result["metrics"]["spend"]
    )
    assert result["metrics"]["attribution_note"]
    assert "trend" in result and "quality" in result


def test_campaign_search_and_pagination():
    response = client.get("/api/campaigns", params={"search": "CAMP_EMAIL", "page_size": 5})
    assert response.status_code == 200
    result = response.json()
    assert len(result["items"]) <= 5
    assert result["total"] > 0
    assert all("EMAIL" in item["campaign_id"] for item in result["items"])


def test_csv_validation_rejects_wrong_schema():
    response = client.post(
        "/api/datasets/ingest",
        files={"file": ("invalid.csv", b"id,other\n1,x\n", "text/csv")},
    )
    assert response.status_code == 422


def test_valid_csv_upload_in_demo_mode_updates_dataset():
    import io

    sample = pd.read_csv(app_module.DEFAULT_CSV, nrows=2)
    output = io.StringIO()
    sample.to_csv(output, index=False)
    response = client.post(
        "/api/datasets/ingest",
        files={"file": ("sample.csv", output.getvalue().encode(), "text/csv")},
    )
    assert response.status_code == 200
    assert response.json()["row_count"] == 2
    assert response.json()["source"] == "CSV fixture demo mode"
    overview = client.get("/api/overview")
    assert overview.status_code == 200
    assert overview.json()["metrics"]["record_count"] == 2


def test_summary_covers_batches_and_excludes_personal_fields(monkeypatch):
    frame = pd.read_csv(app_module.DEFAULT_CSV, parse_dates=["date"]).iloc[:3].copy()
    monkeypatch.setattr(app_module, "load_frame", lambda: (frame, "demo_csv"))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    requests = []

    def fake_summary(data, model, instructions):
        requests.append((data, instructions))
        return f"Summary {len(requests)}"

    monkeypatch.setattr(app_module, "summarize_with_gemini", fake_summary)
    response = client.post("/api/summary", json={"batch_size": 2})
    assert response.status_code == 200
    result = response.json()
    assert result["rows_summarized"] == 3
    assert result["batch_count"] == 2
    assert len(requests) == 3
    assert "CUSTOMER_AGE" not in requests[0][0]["columns"]
    assert "CUSTOMER_GENDER" not in requests[0][0]["columns"]
    assert "PAYMENT_METHOD" not in requests[0][0]["columns"]
    assert "Do not diagnose causes" in requests[0][1]
    assert "Do not" in requests[-1][1]


def test_summary_returns_deterministic_fallback_without_openai_key(monkeypatch):
    frame = pd.read_csv(app_module.DEFAULT_CSV, parse_dates=["date"]).iloc[:3].copy()
    monkeypatch.setattr(app_module, "load_frame", lambda: (frame, "demo_csv"))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(
        app_module,
        "summarize_with_gemini",
        lambda *args, **kwargs: pytest.fail("Gemini should not be called without a key"),
    )

    response = client.post("/api/summary", json={"batch_size": 2})

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "fallback"
    assert result["model"] is None
    assert result["batch_count"] == 0
    assert result["rows_summarized"] == 3
    assert "deterministic descriptive totals" in result["summary"]
    assert "AI explanation unavailable" in result["status_message"]


def test_gemini_request_uses_chat_completions_and_extracts_summary(monkeypatch):
    import urllib.request

    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def read(self):
            return b'{"choices":[{"message":{"content":"Grounded summary"}}]}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["headers"] = dict(request.header_items())
        captured["body"] = json.loads(request.data)
        captured["timeout"] = timeout
        return Response()

    import json

    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    result = app_module.summarize_with_gemini(
        {"rows": [{"campaign": "example"}]},
        "gemini-flash-latest",
        "Summarize only observed patterns.",
    )

    assert result == "Grounded summary"
    assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-gemini-key"
    assert captured["body"]["model"] == "gemini-flash-latest"
    assert captured["body"]["messages"][0] == {
        "role": "system",
        "content": "Summarize only observed patterns.",
    }
    assert json.loads(captured["body"]["messages"][1]["content"]) == {
        "rows": [{"campaign": "example"}]
    }
    assert captured["timeout"] == 120


def test_zero_denominator_returns_unavailable():
    result = app_module.aggregate(pd.DataFrame([{
        "ad_spend": 0, "impressions": 0, "estimated_clicks": 0, "conversions": 0,
        "sales_revenue": 0, "gross_profit": 0, "return_adjusted_net_profit": 0,
        "campaign_id": "c1",
    }]))
    assert result["roas"] is None
    assert result["ctr"] is None
    assert result["cpa"] is None


def test_all_missing_metrics_stay_unavailable_instead_of_becoming_zero():
    result = app_module.aggregate(pd.DataFrame([{
        "ad_spend": None, "impressions": None, "estimated_clicks": None,
        "conversions": None, "sales_revenue": None, "gross_profit": None,
        "return_adjusted_net_profit": None, "campaign_id": "c1",
    }]))
    assert result["spend"] is None
    assert result["attributed_revenue"] is None
    assert result["roas"] is None


def test_duplicate_csv_ids_are_not_silently_deduplicated():
    import io
    frame = pd.read_csv(app_module.DEFAULT_CSV, nrows=1)
    duplicate = pd.concat([frame, frame], ignore_index=True)
    output = io.StringIO()
    duplicate.to_csv(output, index=False)
    response = client.post(
        "/api/datasets/ingest",
        files={"file": ("duplicates.csv", output.getvalue().encode(), "text/csv")},
    )
    assert response.status_code == 422
    assert "Duplicate record IDs" in response.json()["detail"]["message"]


def test_recommendation_only_flags_negative_adjusted_profit_with_minimum_rows():
    frame = pd.DataFrame([
        {
            "id": index,
            "campaign_id": "campaign-a",
            "ad_platform": "Social",
            "channel": "Social",
            "sku_id": "sku-a",
            "ad_spend": 10.0,
            "sales_revenue": 8.0,
            "return_adjusted_net_profit": -2.0,
        }
        for index in range(1, 6)
    ] + [
        {
            "id": 6,
            "campaign_id": "campaign-b",
            "ad_platform": "Search",
            "channel": "Search",
            "sku_id": "sku-b",
            "ad_spend": 10.0,
            "sales_revenue": 20.0,
            "return_adjusted_net_profit": 3.0,
        }
    ])
    candidates = app_module.recommendation_candidates(frame)
    assert len(candidates) == 1
    assert candidates[0]["action_type"] == "investigate"
    assert candidates[0]["evidence"]["return_adjusted_net_profit"] == -10.0
    assert "does not establish cause" in candidates[0]["evidence"]["limitation"]


def test_decisions_require_approval_before_simulation_and_never_execute_live(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    response = client.post(
        "/api/recommendations/0123456789abcdefabcd/simulate",
        json={"reason": ""},
    )
    assert response.status_code == 404

    candidate = {
        "id": "0123456789abcdefabcd",
        "dataset_id": "dataset",
        "campaign_id": "campaign-a",
        "sku_id": "sku-a",
        "channel": "Social",
        "ad_platform": "Social",
        "action_type": "investigate",
        "title": "Investigate campaign-a / sku-a",
        "status": "proposed",
        "evidence": {
            "record_count": 5,
            "ad_spend": 50,
            "attributed_revenue": 40,
            "return_adjusted_net_profit": -10,
            "rule_id": "investigate-negative-adjusted-profit",
            "rule_version": "1",
        },
    }
    with app_module.decision_store() as db:
        db.execute(
            """
            INSERT INTO decisions
            (decision_id, dataset_id, target, evidence_json, status, updated_at)
            VALUES (?, ?, ?, ?, 'proposed', ?)
            """,
            (
                candidate["id"], candidate["dataset_id"], "campaign-a|sku-a",
                __import__("json").dumps(candidate["evidence"]), "test-time",
            ),
        )
        db.commit()

    assert client.post(f"/api/recommendations/{candidate['id']}/simulate", json={}).status_code == 409
    approved = client.post(f"/api/recommendations/{candidate['id']}/approve", json={})
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    simulated = client.post(f"/api/recommendations/{candidate['id']}/simulate", json={})
    assert simulated.status_code == 200
    assert simulated.json()["status"] == "simulated"
    assert "no advertising account was changed" in simulated.json()["message"]
    assert client.get("/api/decision-history").json()["items"][0]["status"] == "simulated"

    path = f"/api/recommendations/{candidate['id']}/rollback"
    assert client.post(path, json={"reason": "Bogus"}).status_code == 422
    assert client.post(path, json={"reason": "Other"}).status_code == 422

    # A newer applied decision on the same target blocks the rollback.
    with app_module.decision_store() as db:
        db.execute(
            "INSERT INTO decisions (decision_id, dataset_id, target, evidence_json, status, updated_at) "
            "VALUES ('newer1', 'dataset', 'campaign-a|sku-a', '{}', 'simulated', 't')"
        )
        db.execute(
            "INSERT INTO decision_events (decision_id, status, reason, created_at) VALUES ('newer1', 'simulated', '', 't')"
        )
        db.commit()
    blocked = client.post(path, json={"reason": "Budget changed"})
    assert blocked.status_code == 409 and "newer decision" in blocked.json()["detail"]
    with app_module.decision_store() as db:
        db.execute("DELETE FROM decisions WHERE decision_id = 'newer1'")
        db.execute("DELETE FROM decision_events WHERE decision_id = 'newer1'")
        db.commit()

    done = client.post(path, json={"reason": "Performance worsened", "performed_by": "Tester"})
    assert done.status_code == 200
    assert done.json()["status"] == "proposed"
    assert done.json()["restored_state"] == "proposed"
    assert client.post(path, json={"reason": "Budget changed"}).status_code == 409

    # A rejected decision can also be rolled back to Pending.
    with app_module.decision_store() as db:
        db.execute(
            "INSERT INTO decisions (decision_id, dataset_id, target, evidence_json, status, updated_at) "
            "VALUES ('rej1', 'dataset', 'x|y', '{}', 'proposed', 't')"
        )
        db.commit()
    assert client.post("/api/recommendations/rej1/reject", json={"reason": "no"}).json()["status"] == "rejected"
    undone = client.post("/api/recommendations/rej1/rollback", json={"reason": "Decision was incorrect"})
    assert undone.status_code == 200 and undone.json()["status"] == "proposed"
    assert client.post("/api/recommendations/rej1/rollback", json={"reason": "Budget changed"}).status_code == 409
    audit = client.get("/api/rollback-audit").json()["items"]
    assert audit[0]["previous_state"] == "proposed" and audit[0]["rolled_back_state"] == "rejected"
    audit = [a for a in audit if a["decision_id"] != "rej1"]
    assert audit[0]["previous_state"] == "approved" and audit[0]["performed_by"] == "Tester"
    history = client.get("/api/decision-history").json()["items"]
    assert [e["status"] for e in history].count("simulated") == 1


def test_budget_scenarios_save_and_send_to_decision_center(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "load_frame", lambda *a, **k: (pd.DataFrame(), "test"))
    monkeypatch.setattr(app_module, "recommendation_candidates", lambda frame: [])
    body = {
        "name": "Shift to Email", "objective": "profit", "level": "channel",
        "total_budget": 100, "max_change_pct": 20, "constraints": [],
        "allocation": [
            {"key": "a", "current": 60, "recommended": 50, "change": -10},
            {"key": "b", "current": 40, "recommended": 50, "change": 10},
        ],
        "impact": {"current_profit": 5, "budget_moved": 10},
    }
    assert client.post("/api/budget-scenarios", json={**body, "total_budget": 90}).status_code == 422
    saved = client.post("/api/budget-scenarios", json=body)
    assert saved.status_code == 200 and saved.json()["decision_id"] is None
    assert client.get("/api/recommendations").json()["items"] == []
    sent = client.post(f"/api/budget-scenarios/{saved.json()['id']}/send")
    assert sent.status_code == 200
    assert client.post(f"/api/budget-scenarios/{saved.json()['id']}/send").status_code == 409
    items = client.get("/api/recommendations").json()["items"]
    assert len(items) == 1 and items[0]["status"] == "proposed"
    assert items[0]["title"].startswith("Budget reallocation simulation")
    assert client.get("/api/budget-scenarios").json()["items"][0]["sent"] is True


@pytest.fixture
def helper_api(monkeypatch):
    import time

    monkeypatch.setattr(app_module, "DEMO_MODE", False)
    monkeypatch.setenv("HELPER_TOKEN", "test-helper-token")
    monkeypatch.setattr(app_module, "_exasol_is_reachable", lambda: False)
    with app_module._db_start_lock:
        app_module._db_start_job.clear()
        app_module._db_start_job.update({
            "job_id": None,
            "state": "idle",
            "step": "idle",
            "message": "Database startup has not been requested.",
            "updated_at": None,
        })
        app_module._db_start_last_heartbeat = time.monotonic()
        app_module._db_start_last_request = float("-inf")
        app_module._db_start_claimed_job = None
        app_module._db_start_claimed_at = 0.0
    yield
    with app_module._db_start_lock:
        app_module._db_start_job.clear()
        app_module._db_start_job.update({
            "job_id": None,
            "state": "idle",
            "step": "idle",
            "message": "Database startup has not been requested.",
            "updated_at": None,
        })
        app_module._db_start_last_heartbeat = 0.0
        app_module._db_start_last_request = float("-inf")
        app_module._db_start_claimed_job = None
        app_module._db_start_claimed_at = 0.0


def test_database_start_browser_endpoints_are_one_click_without_an_admin_token(helper_api):
    response = client.post("/api/db/start")
    assert response.status_code == 202
    assert response.json()["state"] == "running"
    assert client.get("/api/db/start/status").status_code == 200


def test_database_start_reports_already_running_without_a_helper(helper_api, monkeypatch):
    monkeypatch.setattr(app_module, "_exasol_is_reachable", lambda: True)
    status = client.get("/api/db/start/status")
    assert status.status_code == 200
    assert status.json()["state"] == "already_running"
    assert status.json()["message"] == "Database is already running."
    assert status.json()["helper_online"] is True
    response = client.post("/api/db/start")
    assert response.status_code == 200
    assert response.json()["state"] == "already_running"
    assert response.json()["step"] == "done"
    assert response.json()["message"] == "Database is already running."
    assert response.json()["helper_online"] is True


def test_helper_poll_report_contract_and_database_start_state_machine(helper_api):
    helper = {"Authorization": "Bearer test-helper-token"}
    assert client.get("/api/helper/poll").status_code == 401
    assert client.get("/api/helper/poll", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/api/helper/report", headers={"Authorization": "Bearer wrong"}, json={
        "job_id": "job-1", "step": "requested", "message": "Starting",
    }).status_code == 401

    started = client.post("/api/db/start")
    assert started.status_code == 202
    job_id = started.json()["job_id"]
    assert started.json()["step"] == "requested"
    assert client.post("/api/db/start").json()["job_id"] == job_id
    invalid = client.post("/api/helper/report", headers=helper, json={
        "job_id": job_id, "step": "verifying", "message": "Out of order",
    })
    assert invalid.status_code == 409
    assert client.get("/api/helper/poll", headers=helper).json() == {
        "action": "start", "job_id": job_id,
    }
    assert client.get("/api/helper/poll", headers=helper).json() == {"action": "none"}

    steps = (
        "requested", "starting_exasol", "starting_tunnel", "updating_render",
        "deploying", "verifying", "done",
    )
    for step in steps:
        response = client.post("/api/helper/report", headers=helper, json={
            "job_id": job_id, "step": step, "message": f"Progress: {step}",
        })
        assert response.status_code == 200, response.text
    status = client.get("/api/db/start/status")
    assert status.status_code == 200
    assert status.json()["state"] == "succeeded"
    assert status.json()["step"] == "done"
    assert status.json()["helper_online"] is True


def test_start_rate_limit_and_helper_offline_detection(helper_api):
    helper = {"Authorization": "Bearer test-helper-token"}
    import time

    app_module._db_start_last_heartbeat = 0.0
    status = client.get("/api/db/start/status")
    assert status.json()["helper_online"] is False
    assert client.post("/api/db/start").status_code == 503
    assert "helper is offline" in client.post("/api/db/start").json()["detail"].lower()

    app_module._db_start_last_request = time.monotonic() - 61
    app_module._db_start_last_heartbeat = time.monotonic()
    started = client.post("/api/db/start")
    assert started.status_code == 202
    assert client.post("/api/db/start").status_code == 202
    failed = client.post("/api/helper/report", headers=helper, json={
        "job_id": started.json()["job_id"],
        "step": "failed",
        "message": "Test failure",
    })
    assert failed.status_code == 200
    assert client.post("/api/db/start").status_code == 429
    assert client.get("/api/helper/poll", headers=helper).json() == {"action": "none"}
    assert client.get("/api/db/start/status").json()["helper_online"] is True
    app_module._db_start_last_heartbeat = time.monotonic() - 46
    assert client.get("/api/db/start/status").json()["helper_online"] is False


def test_helper_report_reconstructs_progress_after_backend_state_reset(helper_api):
    helper = {"Authorization": "Bearer test-helper-token"}
    app_module._db_start_job.update(job_id=None, state="idle", step="idle")
    restored = client.post("/api/helper/report", headers=helper, json={
        "job_id": "persisted-job", "step": "deploying", "message": "Render deployment in progress.",
    })
    assert restored.status_code == 200
    assert client.get("/api/db/start/status").json()["step"] == "deploying"


def test_db_start_endpoints_are_not_applicable_in_demo_mode(helper_api, monkeypatch):
    monkeypatch.setattr(app_module, "DEMO_MODE", True)
    assert client.post("/api/db/start").status_code == 404
    assert client.get("/api/db/start/status").status_code == 404
