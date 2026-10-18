# ngrok → Render EXASOL_DSN automation (runs on your Windows laptop)

Keeps Render's `EXASOL_DSN` equal to the current ngrok TCP address of your local Exasol, and triggers
**one** deployment only when the address really changed. It does not run in the Render backend and uses
only the Python standard library.

**Your laptop, Exasol, internet connection, and ngrok must stay running** for the deployed app to reach the
database. If any stops, the app returns controlled `503` errors (or briefly serves cached data; see the root README).

## One-time setup (PowerShell, repository root)

```powershell
# optional: only needed to run the tests
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r tools\ngrok_render_sync\requirements-local.txt

Copy-Item tools\ngrok_render_sync\local.env.example tools\ngrok_render_sync\local.env
notepad tools\ngrok_render_sync\local.env   # fill RENDER_API_KEY and RENDER_SERVICE_ID (srv-...)
```

Alternatively set `RENDER_API_KEY` / `RENDER_SERVICE_ID` as Windows environment variables (they override the file).
`local.env` and `.state\` are gitignored. Never paste keys into chat or commit them.

| Variable | Required | Meaning |
|---|---|---|
| `RENDER_API_KEY` | yes | Render account API key |
| `RENDER_SERVICE_ID` | yes | The backend web service ID (`srv-...`) |
| `BACKEND_URL` | yes for the helper | Backend base URL, e.g. `https://your-service.onrender.com` |
| `HELPER_TOKEN` | yes for the helper | Separate long random token; must match Render's helper-only token |
| `NGROK_PATH` | no | Full path to `ngrok.exe` if not on PATH |
| `NGROK_INSPECT_ADDRS` | no | Comma list of ngrok API addresses to probe (default `127.0.0.1:4040,127.0.0.1:4041`) |
| `EXASOL_LOCAL_HOST` / `EXASOL_LOCAL_PORT` | no | Defaults `127.0.0.1` / `8563` |

## Usage

```powershell
# 1. See what would happen. Changes nothing on Render.
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -DryRun

# 2. Normal run: update if needed, request one deployment, wait for it, then prove a DB query
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Wait -VerifyUrl https://YOUR-BACKEND.onrender.com/api/datasets/status

# Optional continuous monitoring (poll 60 s, applies a change only after 3 identical polls, >=10 min between deploys)
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Watch

# Register this workflow to run at your Windows logon (after local.env is configured)
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -InstallTask

# Remove the logon task (does not stop Exasol or ngrok)
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -UninstallTask

# Stop ONLY the ngrok this tool started (recorded PID, verified to be ngrok)
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Stop
```

The launcher first checks `exakit status --json`. If the installed runtime reports `stopped`, it runs
`exakit start` and polls the configured local database port (up to 3 minutes). It does not install or repair
Exasol. If `exakit` is absent, Exasol is not installed, or status is `interrupted`/unknown, it stops with an
actionable message. In particular it never invokes `exakit repair-runtime`, which can destroy the database.
`-Stop` skips this startup check.

Even `-DryRun` may start an installed, stopped Exasol runtime and start ngrok if no matching tunnel exists
(it needs the address). It reads Render's current value with a `GET`, but never writes to Render.

What each run does: (1) checks `127.0.0.1:8563`; (2) reuses a TCP tunnel whose upstream is exactly
`127.0.0.1:8563`/`localhost:8563` found on inspection ports 4040, 4041 or `NGROK_INSPECT_ADDRS`, otherwise starts
`ngrok tcp 127.0.0.1:8563 --log=stdout`; (3) converts `tcp://host:port` to `host:port`; (4) reads Render's current
`EXASOL_DSN` and compares; (5) if different, `PUT`s **only** `EXASOL_DSN` and requests one deploy.
If the current DSN has a `/certificate-fingerprint` part it is **preserved**; only host and port change.
`EXASOL_USER`/`EXASOL_PASSWORD` are never read or written.

A tunnel we start is a detached process that survives the launcher; its PID and inspection address are
recorded in `.state\state.json`. A tunnel you started yourself is reused but never stopped by this tool.
Inspection address strategy: the tool reads the `starting web service addr=...` line from its own ngrok's log,
so it knows which local API belongs to that process even when 4040 is busy.

## Start automatically at Windows logon

After filling in `local.env`, install a per-user Scheduled Task:

```powershell
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -InstallTask
```

It registers **D2C Exasol ngrok Render sync** for the current Windows user, running only when that user is
logged on. At logon it starts Exasol if the installed runtime reports `stopped`, then launches the debounced
watcher. The watcher checks every 60 seconds, requires 3 identical public addresses, and enforces 10 minutes
between deployments. It updates Render only if the DSN changed (or completes a recorded pending deployment).
Task output is appended to the gitignored monthly log in `.state\\automation-YYYYMM.log`.

The Scheduled Task reads `local.env` and the current user's persistent environment variables. Variables set
only in a temporary PowerShell session won't be available to a task at logon; put Render credentials in the
gitignored local file or use Windows user-level variables. Do not paste credentials into chat.

Remove the scheduled watcher with:

```powershell
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -UninstallTask
```

Uninstalling stops only the watcher task; it leaves Exasol and ngrok running. To stop the ngrok process this
tool owns, separately run `.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Stop`. The tool does not stop
Exasol; if you want the database stopped, use the Exakit runtime's documented stop command manually.

The watcher is **at logon**, not triggered by each browser page view. The hosted Start database control uses
the separate outbound helper described below; the Vercel app never opens an inbound connection to the laptop.
Your laptop must be powered on, logged in, awake, online, and running Exasol/ngrok for the hosted app to query it.

## Hosted “Start database” button

The Action Center button is one-click: there is no browser admin token. The backend first checks the configured
Exasol connection; if it answers `SELECT 1`, it reports **Database is already running** without needing the
helper. Otherwise it queues a job only when the helper heartbeat is recent. The helper polls every 15 seconds
using `HELPER_TOKEN`, then:

1. Reports progress and calls this launcher's fixed `-EnsureExasolOnly` mode, which reuses the Exakit status
   and safe-start logic above. A stopped runtime is started; an `interrupted` runtime is reported as needing
   manual attention. The helper never calls `exakit repair-runtime`.
2. Imports `ngrok_render_sync.py` and reuses its `RunLock`, tunnel discovery, single-variable Render update,
   idempotency/deploy reconciliation, deployment polling, and `/api/datasets/status` query verification.
3. Reports `requested → starting_exasol → starting_tunnel → updating_render → deploying → verifying → done`
   (or `failed`). If `EXASOL_DSN` already matches, a Render deployment is skipped and progress says so.

Backend job status is deliberately in memory and resets on a Render redeploy. The helper persists its current
job in `tools\db_helper\.state\job.json`, continues polling/heartbeating, and retries reports so the new
backend process can reconstruct current progress. Helper logs are written to
`tools\db_helper\.state\helper-YYYYMM.log`; messages omit credentials and addresses.

### Helper token and Render configuration

On Render, set a long random `HELPER_TOKEN`. Keep the same value in
`tools\ngrok_render_sync\local.env` with `BACKEND_URL`, `RENDER_API_KEY`, and `RENDER_SERVICE_ID`.
`ADPILOT_CORS_ORIGINS` should retain any existing origins. No token is put in the browser bundle.

Generate a random token locally with:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
```

Use `local.env.example` as the template; environment variables override the file. Set the generated helper
token to the same value on Render and in `local.env`.

**Public one-click access:** the browser-facing start and status endpoints are intentionally unauthenticated.
Anyone who can reach the backend can request the fixed start workflow, with a one-request-per-minute limit.
This starts Exasol/ngrok and may cause a Render deployment when the tunnel address changes. Keep the app
private/unlisted if that is not acceptable. The helper-only endpoints still require `HELPER_TOKEN`; no
arbitrary command or argument can be sent from a browser or backend request.

### Install, remove, and run the helper

From the repository root, after configuring `local.env`:

```powershell
# Per-user Scheduled Task, runs at logon
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -InstallHelperTask

# Remove the task; Exasol and ngrok are left running
.\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -UninstallHelperTask

# Run interactively and stop with Ctrl+C
.\.venv\Scripts\python.exe .\tools\db_helper\helper.py
```

The task is named **D2C Exasol helper**, runs for the logged-in Windows user, and restarts on failure. It
appends logs to `tools\db_helper\.state\helper-YYYYMM.log`. For local UI/API testing, use
`BACKEND_URL=http://127.0.0.1:8000` and the same test `HELPER_TOKEN` in both the helper environment and local
backend environment, with `ADPILOT_DEMO_MODE=0`. The mocked test suite does not contact Render, ngrok, or
Exasol:

```powershell
..\.venv\Scripts\python.exe -m pytest backend\tests tools\ngrok_render_sync\tests
```

This feature still requires the laptop to be on, awake, online, logged in, and running the helper. A Render
redeploy can take several minutes. A reserved ngrok TCP address can keep `EXASOL_DSN` unchanged after a
tunnel restart, avoiding the environment update and deployment; the live database query is still verified.

## What "success" means

| Message | Proves |
|---|---|
| `Deployment REQUESTED` | Render accepted a deploy request (has an ID) |
| `Deployment status: live` | The new service version started. **Not** that the database works |
| `Database query verification: VERIFIED` | Only when `-VerifyUrl` points to `/api/datasets/status`, which runs `SELECT COUNT(*)` on `DQPS.RAW_D2C_DATA` through Render and the tunnel |

`/api/health` runs only `SELECT 1`; prefer `/api/datasets/status`. Both return sanitized errors.

## Idempotency and recovery

State lives in `tools\ngrok_render_sync\.state\state.json` (`pending` and `last_deploy`).

- Unchanged DSN and nothing pending: no update, no deploy.
- DSN updated but the deploy request failed: `pending.env_applied` stays true; the next run finishes the deploy
  even though Render's DSN already matches.
- Deploy request timed out / HTTP 5xx / 202 with no ID: the tool lists Render deploys created since the update.
  If one exists it is adopted; otherwise nothing is re-sent for 10 minutes (exit code 4).
- A deploy that Render itself started after the env change is adopted, not duplicated.
- A lock file prevents two runs at once (exit code 3). A stale lock from a crashed run is cleared automatically.
- `-ForceDeploy`: exceptional recovery; deploys even if the DSN is unchanged.
- `-AllowCreate`: only if `EXASOL_DSN` is missing on Render (no fingerprint can be inferred).

Exit codes: 0 ok, 1 error, 2 preflight (database/ngrok), 3 locked, 4 deployment unresolved.

## Verified against official docs (checked 2026-10-18)

- Render: `GET/PUT /v1/services/{id}/env-vars/{key}` (body `{"value": ...}`), `POST /v1/services/{id}/deploys`
  (201 with deploy object, or 202 queued without one), `GET /v1/services/{id}/deploys[/{deployId}]`, Bearer auth.
- ngrok agent API: `GET /api/tunnels` (deprecated) and `GET /api/endpoints`; both are handled.
- **Unverified / assumptions:** the exact list-deploys response item shape (`{deploy, cursor}`) is handled
  defensively but not exercised live; ngrok's `starting web service addr=` log line is relied on (the configured
  inspection addresses are the fallback); whether an env-var `PUT` auto-triggers a Render deploy is not assumed
  either way (a deploy appearing after the update is adopted). Nothing here was run against live Render.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest tools\ngrok_render_sync\tests -q
```

All mocked: no Render, ngrok, or Exasol access.

## Existing temporary scripts (not removed)

`backend\check_ngrok.py` (hardcodes an old ngrok hostname), `backend\check_exasol.py`, and root `test_exasol.py`
(standalone Gemini summarizer that loads the CSV into Exasol). They are not used by this automation or the app.
Render's Build/Start commands were not modified; if they still run these checks, revisit them.
