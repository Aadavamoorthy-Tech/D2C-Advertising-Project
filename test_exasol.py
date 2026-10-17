import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pyexasol

FINGERPRINT = "CAE0B01EE61155D5325D4D4D4AF1578EB13DCFA9AE613DB6C18B3BB6887F8085"
TABLE_NAME = "ADPILOT_LLM.D2C_CAMPAIGN_DATA"
ANALYSIS_COLUMNS = (
    "DATE",
    "REGION",
    "CHANNEL",
    "PRODUCT_CATEGORY",
    "CUSTOMER_SEGMENT",
    "AD_SPEND",
    "PRICE",
    "DISCOUNT_RATE",
    "MARKET_REACH",
    "IMPRESSIONS",
    "CLICK_THROUGH_RATE",
    "COMPETITION_INDEX",
    "SEASONALITY_INDEX",
    "CAMPAIGN_DURATION_DAYS",
    "SKU_ID",
    "AD_PLATFORM",
    "CAMPAIGN_ID",
    "CONVERSIONS",
    "UNITS_SOLD",
    "SALES_REVENUE",
    "GROSS_PROFIT",
    "NET_PROFIT",
    "PROFIT_MARGIN_PCT",
    "STOCK_LEVEL",
    "RETURN_RATE_PCT",
    "UNITS_RETURNED",
    "RETURN_ADJUSTED_NET_PROFIT",
    "ROAS",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Load the D2C CSV into Exasol and ask Gemini to summarize its data."
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=Path(__file__).resolve().parent / "engineered_d2c_dataset_15k_v5.csv",
        help="CSV file to load (default: engineered_d2c_dataset_15k_v5.csv next to this script).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Number of rows sent per summarization request (1-1000; default: 500).",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
        help="Gemini model (default: GEMINI_MODEL or gemini-flash-latest).",
    )
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000:
        parser.error("--batch-size must be between 1 and 1000")
    return args


def summarize_with_gemini(data: dict, model: str, instructions: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Set it in your environment before running this script."
        )

    request_body = {
        "model": model,
        "max_tokens": 4000,
        "messages": [
            {"role": "system", "content": instructions},
            {
                "role": "user",
                "content": json.dumps(data, default=str, separators=(",", ":")),
            },
        ],
    }
    request = Request(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        data=json.dumps(request_body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"Gemini API returned HTTP {exc.code}.") from exc
    except URLError as exc:
        raise RuntimeError("Could not reach the Gemini API.") from exc

    choices = result.get("choices", []) if isinstance(result, dict) else []
    message = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
    content = message.get("content", "") if isinstance(message, dict) else ""
    if isinstance(content, list):
        text = "\n".join(
            part["text"]
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ).strip()
    else:
        text = content.strip() if isinstance(content, str) else ""
    if not text:
        raise RuntimeError("The Gemini response did not contain any summary text.")
    return text


def summarize_dataset(
    conn: pyexasol.ExaConnection, batch_size: int, model: str
) -> str:
    columns_sql = ", ".join(f'"{column}"' for column in ANALYSIS_COLUMNS)
    batch_summaries = []
    offset = 0
    batch_number = 0

    while True:
        rows = conn.execute(
            f"""
            SELECT {columns_sql}
            FROM {TABLE_NAME}
            ORDER BY "ID"
            LIMIT {batch_size}
            OFFSET {offset}
            """
        ).fetchall()
        if not rows:
            break

        batch_number += 1
        instructions = """Summarize only the supplied campaign data batch.
State concise, directly observed patterns and notable differences in the metrics.
Do not diagnose causes, make predictions, or recommend actions. Do not invent values.
"""
        batch_summary = summarize_with_gemini(
            {
                "batch_number": batch_number,
                "columns": ANALYSIS_COLUMNS,
                "rows": rows,
            },
            model,
            instructions,
        )
        batch_summaries.append(batch_summary)
        offset += len(rows)
        print(f"Summarized {offset} rows so far...")

    if not batch_summaries:
        raise RuntimeError(f"No rows were found in {TABLE_NAME}.")

    final_instructions = """Create one concise summary of the supplied summaries
of the complete campaign dataset. Describe overall patterns and differences that
are explicitly supported by those summaries. Do not recommend actions, infer
causation, predict outcomes, or add facts that are not present.
"""
    return summarize_with_gemini(
        {"batch_summaries": batch_summaries},
        model,
        final_instructions,
    )


def main() -> None:
    args = parse_args()
    csv_path = args.csv.expanduser().resolve()
    if not csv_path.is_file():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Set it in your environment before running this script."
        )

    password_file = (
        Path.home()
        / ".exasol-starter-kit"
        / "credentials"
        / "personal_sys_password"
    )
    password = password_file.read_text().strip()
    conn = pyexasol.connect(
        dsn=f"127.0.0.1/{FINGERPRINT}:8563",
        user="sys",
        password=password,
        compression=True,
    )
    try:
        conn.execute("CREATE SCHEMA IF NOT EXISTS ADPILOT_LLM")
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                "ID" DECIMAL(18, 0),
                "DATE" TIMESTAMP,
                "REGION" VARCHAR(256),
                "CHANNEL" VARCHAR(256),
                "PRODUCT_CATEGORY" VARCHAR(256),
                "CUSTOMER_SEGMENT" VARCHAR(256),
                "AD_SPEND" DECIMAL(18, 6),
                "PRICE" DECIMAL(18, 6),
                "DISCOUNT_RATE" DECIMAL(18, 6),
                "MARKET_REACH" DECIMAL(18, 6),
                "IMPRESSIONS" DECIMAL(18, 6),
                "CLICK_THROUGH_RATE" DECIMAL(18, 6),
                "COMPETITION_INDEX" DECIMAL(18, 6),
                "SEASONALITY_INDEX" DECIMAL(18, 6),
                "CAMPAIGN_DURATION_DAYS" DECIMAL(18, 0),
                "CUSTOMER_LIFETIME_VALUE" DECIMAL(18, 6),
                "ESTIMATED_CLICKS" DECIMAL(18, 6),
                "EFFECTIVE_PRICE" DECIMAL(18, 6),
                "SKU_ID" VARCHAR(256),
                "AD_PLATFORM" VARCHAR(256),
                "CAMPAIGN_ID" VARCHAR(256),
                "UNIT_COGS" DECIMAL(18, 6),
                "CONVERSIONS" DECIMAL(18, 6),
                "UNITS_SOLD" DECIMAL(18, 6),
                "SALES_REVENUE" DECIMAL(18, 6),
                "TOTAL_COGS" DECIMAL(18, 6),
                "GROSS_PROFIT" DECIMAL(18, 6),
                "NET_PROFIT" DECIMAL(18, 6),
                "PROFIT_MARGIN_PCT" DECIMAL(18, 6),
                "STOCK_LEVEL" DECIMAL(18, 6),
                "CUSTOMER_AGE" DECIMAL(18, 0),
                "CUSTOMER_GENDER" VARCHAR(256),
                "PAYMENT_METHOD" VARCHAR(256),
                "RETURN_RATE_PCT" DECIMAL(18, 6),
                "UNITS_RETURNED" DECIMAL(18, 6),
                "RETURN_ADJUSTED_NET_PROFIT" DECIMAL(18, 6),
                "ROAS" DECIMAL(18, 6)
            )
            """
        )

        print(f"Loading {csv_path.name} into {TABLE_NAME}...")
        conn.execute(f"TRUNCATE TABLE {TABLE_NAME}")
        conn.import_from_file(
            str(csv_path),
            TABLE_NAME,
            import_params={"skip": 1},
        )
        conn.commit()

        print(
            f"Sending all campaign data to Gemini in batches of {args.batch_size}..."
        )
        summary = summarize_dataset(conn, args.batch_size, args.model)
        print("\n=== Dataset Summary ===\n")
        print(summary)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
