"""Start the AdPilot backend and frontend together. Stop both with Ctrl+C.

Usage: python run_me.py            (CSV demo mode when ADPILOT_DEMO_MODE is not set)
       python run_me.py --live     (use Exasol; credentials from backend/.env)
"""
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV_PY = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def wait_for(url: str, procs, timeout: int = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(p.poll() is not None for p in procs):
            return False
        try:
            with urlopen(url, timeout=3):
                return True
        except (URLError, OSError):
            time.sleep(1)
    print(f"Timed out waiting for {url}", flush=True)
    return False


def main() -> int:
    python = str(VENV_PY) if VENV_PY.exists() else sys.executable
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        print("npm was not found. Install Node.js first.")
        return 1

    if not (FRONTEND / "node_modules").exists():
        print("Installing frontend dependencies (first run only)...")
        if subprocess.call([npm, "install"], cwd=FRONTEND) != 0:
            return 1

    env = os.environ.copy()
    if "--live" not in sys.argv:
        env.setdefault("ADPILOT_DEMO_MODE", "1")

    print("Starting AdPilot (first start can take 10-20 seconds)...", flush=True)
    procs = [
        subprocess.Popen(
            [python, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"],
            cwd=BACKEND, env=env,
        ),
        subprocess.Popen([npm, "run", "dev"], cwd=FRONTEND, env=env),
    ]

    try:
        if wait_for("http://127.0.0.1:8000/api/health", procs) and wait_for("http://localhost:3000", procs):
            print("\nAdPilot is ready: http://localhost:3000  (Ctrl+C to stop)\n", flush=True)
            webbrowser.open("http://localhost:3000")
        while all(p.poll() is None for p in procs):
            time.sleep(1)
        print("A server exited; shutting down.", flush=True)
    except KeyboardInterrupt:
        print("\nStopping...", flush=True)
    finally:
        for p in procs:
            if p.poll() is None:
                if os.name == "nt":
                    subprocess.call(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    p.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
