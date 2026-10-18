import os
import pyexasol

connection = None

try:
    print("EXASOL TEST: Connecting", flush=True)

    connection = pyexasol.connect(
        dsn=os.environ["EXASOL_DSN"],
        user=os.environ["EXASOL_USER"],
        password=os.environ["EXASOL_PASSWORD"],
        encryption=True,
    )

    statement = connection.execute(
        "SELECT COUNT(*) FROM DQPS.RAW_D2C_DATA"
    )
    row_count = statement.fetchone()[0]

    print(
        f"EXASOL TEST: SUCCESS - row count = {row_count}",
        flush=True,
    )

except Exception as exc:
    print(
        f"EXASOL TEST: FAILED - {type(exc).__name__}: {exc}",
        flush=True,
    )

finally:
    if connection is not None:
        connection.close()