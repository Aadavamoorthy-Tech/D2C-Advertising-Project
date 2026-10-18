import socket

HOST = "0.tcp.in.ngrok.io"
PORT = 27803

print(f"NGROK TEST: Connecting to {HOST}:{PORT}", flush=True)

try:
    with socket.create_connection((HOST, PORT), timeout=15):
        print("NGROK TEST: TCP CONNECTION SUCCESSFUL", flush=True)
except OSError as exc:
    print(
        f"NGROK TEST: FAILED - {type(exc).__name__}: {exc}",
        flush=True,
    )