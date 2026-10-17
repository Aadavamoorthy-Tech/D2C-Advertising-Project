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

For the explicitly labeled, fixture-backed local demo without Exasol, use a separate PowerShell window and set:

```powershell
$env:ADPILOT_DEMO_MODE = "1"
$env:GEMINI_API_KEY = "your-key"
```

The demo reads the bundled CSV. It does not silently switch to demo when Exasol fails. `GEMINI_API_KEY` may be omitted to use the deterministic descriptive summary fallback.

### 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. Backend health/API: <http://localhost:8000/api/health>.

The frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). The Gemini API key and Exasol credentials belong only in the backend environment; never put them in a `NEXT_PUBLIC_*` variable.

## Data and AI behavior

- Upload a CSV from **Unified data hub**. The API validates the exact 37-column schema, dates, numeric values, and duplicate IDs. The current dataset table is replaced on a new valid upload; an identical file is detected by SHA-256 and not reloaded.
- Live mode writes only to the dedicated `ADPILOT_LLM.D2C_CAMPAIGN_DATA` table and an ingestion metadata table under `ADPILOT_LLM`.
- Enable demo mode only with `ADPILOT_DEMO_MODE=1`. UI badges identify fixture data.
- The overview and campaign table metrics are calculated deterministically in the backend. CTR, CPC, CPM, CVR, CPA, and ROAS use aggregate sums. Zero denominators return unavailable values.
- Campaign revenue is labeled as attributed data and is not represented as reconciled business revenue. The CSV has no currency column; totals assume one currency.
- Summarization is a separate user-triggered action. With `GEMINI_API_KEY`, the backend sends the full dataset in stable ID-ordered batches to Gemini's OpenAI-compatible chat-completions API using `GEMINI_MODEL` (default `gemini-flash-latest`), then combines the batch summaries. Demographics and payment method are excluded. Prompts prohibit diagnoses, causal claims, predictions, and recommendations. Without the key, the API returns an explicitly labeled deterministic descriptive totals fallback and does not call Gemini. AI text is descriptive; deterministic backend metrics remain the numeric source of truth.
- The app is a local MVP without authentication. Do not expose it publicly or use it for live ad spend decisions.

## Configuration

See `backend/.env.example` and `frontend/.env.example`. Relevant backend environment:

- `ADPILOT_DEMO_MODE=1` explicitly selects the bundled CSV fixture.
- `EXASOL_DSN`, `EXASOL_USER`, `EXASOL_PASSWORD` configure live Exasol; the password can instead be read from the local Starter Kit credential file.
- `GEMINI_API_KEY` and optional `GEMINI_MODEL` configure AI summaries (default model `gemini-flash-latest`).
- `ADPILOT_MAX_UPLOAD_BYTES` sets the upload cap; default is 20 MiB.
- `ADPILOT_CORS_ORIGINS` sets permitted local frontend origins.

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
..\.venv\Scripts\python.exe -m pytest backend\tests
cd frontend
npm run typecheck
npm run build
```

No real Exasol ingestion or Gemini request is performed by the tests.

## Scope notes

This MVP includes ingestion/status, overview, campaign filtering/search/pagination/export, deterministic observations, a rule-based “investigate” queue for campaign/SKU groups with at least five rows and negative return-adjusted profit, human approval/rejection, simulated review status, a local review history, and full-dataset AI summaries. It does not change advertising spend. The supplied CSV has no click field, so the dashboard uses `estimated_clicks` and labels it explicitly; missing fields are not fabricated. Anomaly detection, outcomes evaluation, persistent asynchronous jobs, and authentication remain unimplemented. The visual shell follows the existing UI code under `New folder`; that directory is not an application runtime dependency. No separate dashboard screenshot was supplied, so pixel-level comparison cannot be verified.
