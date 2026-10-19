# AdPilot D2C Intelligence

A local dashboard for CSV-backed D2C campaign data, deterministic metrics, and AI-generated dataset summaries. The interface follows the dark/lime AdPilot styling in `New folder`; that folder is only a UI reference and is not used as an application dependency.

## Start locally

Prerequisites: Python 3.11+, Node.js 20+, npm, and the Exasol Starter Kit (unless using explicit demo mode).

### 1. Backend

From the repository root, in PowerShell:

```powershell
cd backend
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:EXASOL_DSN = "127.0.0.1/REPLACE_WITH_CERTIFICATE_FINGERPRINT:8563"
# Store your Gemini key in this backend-only environment variable (or put it in backend\.env).
$env:GEMINI_API_KEY = "your-key"
$env:GEMINI_MODEL = "gemini-flash-latest"
..\.venv\Scripts\python.exe -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

If you do not set `GEMINI_API_KEY`, the summary endpoint uses deterministic descriptive totals instead of making an AI request.

To force the fixture-backed CSV demo even when Exasol is available, use a separate PowerShell window and set:

```powershell
$env:ADPILOT_DEMO_MODE = "1"
$env:GEMINI_API_KEY = "your-key"
```

The explicit demo mode reads the bundled CSV and allows CSV uploads. Otherwise, the application prefers Exasol and automatically reads the bundled CSV if Exasol is unavailable. It retries Exasol on subsequent requests, and a successful Exasol read always takes precedence over the CSV. `GEMINI_API_KEY` may be omitted to use the deterministic descriptive summary fallback.

### 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. Backend health/API: <http://localhost:8000/api/health>.

The frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). The Gemini API key and Exasol credentials belong only in the backend environment; never put them in a `NEXT_PUBLIC_*` variable.

## Data and AI behavior

- When Exasol is available, the dataset is **read-only** from `DQPS.RAW_D2C_DATA` (`RECORD_DATE` is exposed as `date`) and the bundled CSV is not read. If Exasol is unavailable, the backend uses the bundled CSV as a read-only fallback. `POST /api/datasets/ingest` returns `405` outside explicit demo mode and never writes to Exasol; CSV uploads are available only in explicit demo mode (`ADPILOT_DEMO_MODE=1`). The frontend still shows its upload form; live uploads are rejected with that message.
- Successful Exasol reads cache the whole DataFrame in memory for `ADPILOT_DATA_CACHE_TTL_SECONDS` (default 300) and refresh it with one `ORDER BY "ID"` query on a fresh, closed-after-use connection. On refresh failure, the backend prefers the bundled CSV to a stale Exasol copy and retries Exasol on subsequent requests. If the CSV cannot be loaded, an Exasol cache may be served for up to `ADPILOT_DATA_MAX_STALE_SECONDS` (default 900); without either source, API routes return a sanitized `503`.
- Automatic ngrok/Render DSN sync and the hosted **Start database** action for Windows: see `tools/ngrok_render_sync/README.md`. A successful action switches Render from CSV demo mode to live Exasol mode, deploys the change, verifies the dataset query, and refreshes the dashboard from Exasol.
- The PowerShell launcher checks `exakit status --json`, starts Exasol only if the installed runtime is stopped, then waits for the configured database port before continuing. It does not install or repair Exasol.
- To run the DSN watcher automatically at Windows logon, configure `tools/ngrok_render_sync/local.env` and run `.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -InstallTask`. The separate outbound helper required by the hosted **Start database** button is installed with `-InstallHelperTask`; remove it with `-UninstallHelperTask`. The Vercel app never connects inbound to your laptop.
- Set `ADPILOT_DEMO_MODE=1` to force CSV demo mode (including CSV uploads), regardless of Exasol availability. Otherwise, a CSV fallback is selected automatically only when Exasol is unavailable; the UI identifies the active source.
- The overview and campaign table metrics are calculated deterministically in the backend. CTR, CPC, CPM, CVR, CPA, and ROAS use aggregate sums. Zero denominators return unavailable values.
- Campaign revenue is labeled as attributed data and is not represented as reconciled business revenue. The CSV has no currency column; totals assume one currency.
- Summarization is a separate user-triggered action. With `GEMINI_API_KEY`, the backend sends the full dataset in stable ID-ordered batches to Gemini's OpenAI-compatible chat-completions API using `GEMINI_MODEL` (default `gemini-flash-latest`), then combines the batch summaries. Demographics and payment method are excluded. Prompts prohibit diagnoses, causal claims, predictions, and recommendations. Without the key, the API returns an explicitly labeled deterministic descriptive totals fallback and does not call Gemini. AI text is descriptive; deterministic backend metrics remain the numeric source of truth.
- The app does not have general user authentication. The database-start button is intentionally one-click and public: anyone who can reach the backend can request its fixed Exasol-start workflow, subject to a one-request-per-minute limit. The helper endpoint remains protected by a separate `HELPER_TOKEN`; do not treat the dashboard as private or use it for live ad spend decisions.

## Configuration

See `backend/.env.example` and `frontend/.env.example`. Relevant backend environment:

- `ADPILOT_DEMO_MODE=1` forces the bundled CSV fixture, even if Exasol is available. Without it, the bundled CSV is used only as an automatic fallback when Exasol is unavailable.
- `EXASOL_DSN`, `EXASOL_USER`, `EXASOL_PASSWORD` configure live Exasol; the password can instead be read from the local Starter Kit credential file.
- `GEMINI_API_KEY` and optional `GEMINI_MODEL` configure AI summaries (default model `gemini-flash-latest`).
- `ADPILOT_MAX_UPLOAD_BYTES` sets the upload cap; default is 20 MiB.
- `ADPILOT_CORS_ORIGINS` sets permitted local frontend origins.
- `HELPER_TOKEN` is a long random secret shared between the backend and the local helper. Set it on Render and in `tools/ngrok_render_sync/local.env`.

For the hosted database-start feature, set `HELPER_TOKEN` in Render's backend environment and use the same value in the gitignored local helper configuration. On the laptop, also set `BACKEND_URL`, `RENDER_API_KEY`, and `RENDER_SERVICE_ID`. The browser requires no token. See the automation README for setup, task installation, flow, and limitations.

## Standalone Exasol summarizer

The original `test_exasol.py` entry point also uses Gemini's OpenAI-compatible chat-completions API. From the project root, set `GEMINI_API_KEY` in the same PowerShell session, then run:

```powershell
$env:GEMINI_API_KEY = "your-key"
$env:GEMINI_MODEL = "gemini-flash-latest"
.\.venv\Scripts\python.exe .\test_exasol.py
```

The script still requires a running, configured Exasol instance. Do not put the key in frontend configuration, source control, or chat.

## Checks

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests tools\ngrok_render_sync\tests
cd frontend
npm run typecheck
npm run build
```

No real Exasol ingestion or Gemini request is performed by the tests.

## Scope notes

This MVP includes ingestion/status, overview, campaign filtering/search/pagination/export, deterministic observations, a rule-based “investigate” queue for campaign/SKU groups with at least five rows and negative return-adjusted profit, human approval/rejection, simulated review status, a local review history, and full-dataset AI summaries. It does not change advertising spend. The supplied CSV has no click field, so the dashboard uses `estimated_clicks` and labels it explicitly; missing fields are not fabricated. Anomaly detection, outcomes evaluation, persistent asynchronous jobs, and authentication remain unimplemented. The visual shell follows the existing UI code under `New folder`; that directory is not an application runtime dependency. No separate dashboard screenshot was supplied, so pixel-level comparison cannot be verified.
