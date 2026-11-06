# AdPilot D2C Intelligence

The application is available in the link https://d2-c-advertising-project.vercel.app/

A local dashboard for CSV-backed D2C campaign data, deterministic metrics, and AI-generated dataset summaries. The interface follows the dark/lime AdPilot styling in `New folder`; that folder is only a UI reference and is not used as an application dependency.

## Start locally

Prerequisites: Python 3.11+, Node.js 20+, and npm. No database or local database service is required.

### 1. Backend

From the repository root, in PowerShell:

```powershell
cd backend
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
# Store your Gemini key in this backend-only environment variable (or put it in backend\.env).
$env:GEMINI_API_KEY = "your-key"
$env:GEMINI_MODEL = "gemini-flash-latest"
..\.venv\Scripts\python.exe -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

If you do not set `GEMINI_API_KEY`, the summary endpoint uses deterministic descriptive totals instead of making an AI request.

The backend always loads `engineered_d2c_dataset_15k_v5.csv`. CSV uploads replace the active dataset in memory until the backend restarts. `GEMINI_API_KEY` may be omitted to use the deterministic descriptive summary fallback.

### 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. Backend health/API: <http://localhost:8000/api/health>.

The frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). The Gemini API key belongs only in the backend environment; never put it in a `NEXT_PUBLIC_*` variable.

## Data and AI behavior

- The bundled CSV is the sole default data source. It is loaded and cached in memory; no database connection or laptop database helper is used.
- `POST /api/datasets/ingest` validates an uploaded CSV and makes it the active dataset for the current backend process. Restarting the backend restores the bundled CSV.
- The overview and campaign table metrics are calculated deterministically in the backend. CTR, CPC, CPM, CVR, CPA, and ROAS use aggregate sums. Zero denominators return unavailable values.
- Campaign revenue is labeled as attributed data and is not represented as reconciled business revenue. The CSV has no currency column; totals assume one currency.
- Summarization is a separate user-triggered action. With `GEMINI_API_KEY`, the backend sends the full dataset in stable ID-ordered batches to Gemini's OpenAI-compatible chat-completions API using `GEMINI_MODEL` (default `gemini-flash-latest`), then combines the batch summaries. Demographics and payment method are excluded. Prompts prohibit diagnoses, causal claims, predictions, and recommendations. Without the key, the API returns an explicitly labeled deterministic descriptive totals fallback and does not call Gemini. AI text is descriptive; deterministic backend metrics remain the numeric source of truth.
- The app does not have general user authentication; do not treat the dashboard as private or use it for live ad spend decisions.

## Configuration

See `backend/.env.example` and `frontend/.env.example`. Relevant backend environment:

- `GEMINI_API_KEY` and optional `GEMINI_MODEL` configure AI summaries (default model `gemini-flash-latest`).
- `ADPILOT_MAX_UPLOAD_BYTES` sets the upload cap; default is 20 MiB.
- `ADPILOT_CORS_ORIGINS` sets permitted local frontend origins.

## Checks

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests
cd frontend
npm run typecheck
npm run build
```

No external database or Gemini request is performed by the tests.

## Scope notes

This MVP includes ingestion/status, overview, campaign filtering/search/pagination/export, deterministic observations, a rule-based “investigate” queue for campaign/SKU groups with at least five rows and negative return-adjusted profit, human approval/rejection, simulated review status, a local review history, and full-dataset AI summaries. It does not change advertising spend. The supplied CSV has no click field, so the dashboard uses `estimated_clicks` and labels it explicitly; missing fields are not fabricated. Anomaly detection, outcomes evaluation, persistent asynchronous jobs, and authentication remain unimplemented. The visual shell follows the existing UI code under `New folder`; that directory is not an application runtime dependency. No separate dashboard screenshot was supplied, so pixel-level comparison cannot be verified.
