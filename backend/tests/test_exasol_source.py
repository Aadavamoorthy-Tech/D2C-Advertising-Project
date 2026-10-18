"""Mocked tests: the live dataset loader must use Exasol and never the CSV.

These do not touch a real database. See README for the live read-only check.
"""
from __future__ import annotations

import importlib.util
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("adpilot_backend_live", APP_PATH)
assert SPEC and SPEC.loader
app_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app_module)
client = TestClient(app_module.app)


class FakeStatement:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class FakeConnection:
    def __init__(self, rows, log):
        self.rows, self.log = rows, log

    def execute(self, sql, *args):
        self.log.append(sql)
        return FakeStatement(self.rows if "ORDER BY" in sql else [(len(self.rows),)])


def make_rows(count=3):
    rows = []
    for i in range(count, 0, -1):  # deliberately unordered; SQL ORDER BY is what is asserted
        row = []
        for name in app_module.CSV_COLUMNS:
            if name == "date":
                row.append(datetime(2024, 1, i))
            elif name in app_module.NUMERIC_COLUMNS:
                row.append(Decimal(i) if name == "id" else Decimal("10.50"))
            else:
                row.append(f"{name}_{i % 2}")
        rows.append(tuple(row))
    return rows


@pytest.fixture
def exasol(monkeypatch):
    state = {"rows": make_rows(), "log": [], "fail": False, "opened": 0, "closed": 0}

    @contextmanager
    def fake_connection():
        state["opened"] += 1
        if state["fail"]:
            raise ConnectionError("secret-host.ngrok.io password=hunter2")
        try:
            yield FakeConnection(state["rows"], state["log"])
        finally:
            state["closed"] += 1

    monkeypatch.setattr(app_module, "DEMO_MODE", False)
    monkeypatch.setattr(app_module, "exasol_connection", fake_connection)
    monkeypatch.setattr(
        pd, "read_csv", lambda *a, **k: pytest.fail("CSV must not be read in live mode")
    )
    app_module.clear_frame_cache()
    yield state
    app_module.clear_frame_cache()


def test_loader_queries_dqps_table_with_explicit_order(exasol):
    frame, source = app_module.load_frame()
    sql = exasol["log"][0]
    assert source == "exasol"
    assert '"DQPS"."RAW_D2C_DATA"' in sql
    assert 'ORDER BY "ID"' in sql
    assert '"RECORD_DATE"' in sql and '"DATE"' not in sql.replace('"RECORD_DATE"', "")
    assert exasol["opened"] == exasol["closed"] == 1


def test_frame_columns_and_dtypes_match_csv_contract(exasol):
    frame, _ = app_module.load_frame()
    assert tuple(frame.columns) == app_module.CSV_COLUMNS
    assert pd.api.types.is_datetime64_any_dtype(frame["date"])
    assert frame["id"].dtype == "int64"
    for column in app_module.NUMERIC_COLUMNS:
        assert pd.api.types.is_numeric_dtype(frame[column]), column
    assert frame["ad_spend"].dtype == "float64"


def test_nulls_become_nan_not_errors(exasol):
    rows = [list(r) for r in exasol["rows"]]
    rows[0][app_module.CSV_COLUMNS.index("ad_spend")] = None
    exasol["rows"] = [tuple(r) for r in rows]
    frame, _ = app_module.load_frame()
    assert frame["ad_spend"].isna().sum() == 1


def test_cache_avoids_reloading_each_request(exasol):
    app_module.load_frame()
    app_module.load_frame()
    client.get("/api/filters")
    assert sum("ORDER BY" in sql for sql in exasol["log"]) == 1


def test_overview_response_shape_from_exasol(exasol):
    response = client.get("/api/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "exasol"
    assert body["is_demo"] is False
    assert body["metrics"]["record_count"] == 3
    assert body["metrics"]["spend"] == pytest.approx(31.5)


def test_exasol_down_returns_sanitized_503_without_csv_fallback(exasol):
    exasol["fail"] = True
    response = client.get("/api/overview")
    assert response.status_code == 503
    text = response.text
    assert "hunter2" not in text and "ngrok" not in text
    assert "Exasol data source is unavailable" in text


def test_stale_cache_is_served_only_within_documented_window(exasol, monkeypatch):
    monkeypatch.setattr(app_module, "CACHE_TTL_SECONDS", 0.0)
    app_module.load_frame()
    exasol["fail"] = True
    frame, source = app_module.load_frame()
    assert source == "exasol" and len(frame) == 3
    monkeypatch.setattr(app_module, "CACHE_MAX_STALE_SECONDS", 0.0)
    with pytest.raises(app_module.HTTPException) as caught:
        app_module.load_frame()
    assert caught.value.status_code == 503


def test_dataset_status_counts_dqps_table(exasol):
    response = client.get("/api/datasets/status")
    assert response.json() == {"status": "ready", "row_count": 3, "source": "Exasol"}
    assert any("DQPS" in sql for sql in exasol["log"])


def test_live_upload_is_disabled_and_does_not_touch_database(exasol):
    response = client.post(
        "/api/datasets/ingest", files={"file": ("a.csv", b"id\n1\n", "text/csv")}
    )
    assert response.status_code == 405
    assert exasol["opened"] == 0


def test_duplicate_ids_rejected(exasol):
    exasol["rows"] = make_rows(2) + make_rows(1)[:1]
    exasol["rows"][2] = (Decimal(1),) + exasol["rows"][2][1:]
    response = client.get("/api/filters")
    assert response.status_code == 409
