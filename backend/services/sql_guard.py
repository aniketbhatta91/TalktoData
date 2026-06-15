"""Safe SQL layer: validates queries (SELECT-only) and runs them over the
session's dataframes via DuckDB. Also ready for future external DB connections.

Pruning rules:
- exactly one statement, must be SELECT (or WITH ... SELECT)
- no DDL/DML keywords (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/ATTACH/COPY...)
- no PRAGMA/SET/INSTALL/LOAD or filesystem table functions
- result rows capped
"""
import re

import pandas as pd

MAX_RESULT_ROWS = 10_000

_BLOCKED = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|truncate|grant|revoke|"
    r"attach|detach|copy|export|import|pragma|set|reset|install|load|call|"
    r"vacuum|checkpoint|begin|commit|rollback|read_csv|read_parquet|read_json|"
    r"read_csv_auto|glob|getenv)\b",
    re.IGNORECASE,
)


def validate(query: str) -> list[str]:
    """Return list of violations; empty means the query is allowed."""
    violations = []
    stripped = query.strip().rstrip(";").strip()
    if ";" in stripped:
        violations.append("multiple SQL statements are not allowed")
    # strip string literals before keyword scan to avoid false positives
    no_strings = re.sub(r"'[^']*'", "''", stripped)
    if not re.match(r"^\s*(select|with)\b", no_strings, re.IGNORECASE):
        violations.append("only SELECT queries are allowed")
    blocked = sorted({m.group().lower() for m in _BLOCKED.finditer(no_strings)})
    if blocked:
        violations.append(f"blocked keywords: {', '.join(blocked)}")
    if re.search(r"--|/\*", no_strings):
        violations.append("SQL comments are not allowed")
    return violations


def run_sql(query: str, datasets: dict[str, pd.DataFrame]) -> dict:
    """Validate then execute a SELECT over the in-memory datasets.
    Each dataset is exposed as a table with its dataset name."""
    violations = validate(query)
    if violations:
        return {"ok": False, "error": "Query blocked: " + "; ".join(violations), "rows": []}

    try:
        import duckdb
    except ImportError:
        return {"ok": False, "error": "duckdb not installed (pip install duckdb)", "rows": []}

    con = duckdb.connect(":memory:")
    try:
        con.execute("SET enable_external_access=false")
        for name, df in datasets.items():
            con.register(name, df)
        result = con.execute(query).fetch_df().head(MAX_RESULT_ROWS)
        return {
            "ok": True,
            "error": None,
            "columns": [str(c) for c in result.columns],
            "rows": result.astype(str).to_dict(orient="records"),
            "row_count": int(len(result)),
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "rows": []}
    finally:
        con.close()
