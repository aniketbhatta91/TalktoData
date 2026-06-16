"""Data profiling (sanity checks, outliers) and sandboxed code execution."""
import contextlib
import io
import json
import traceback

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go


MAX_ROWS = 200_000   # rows kept in memory per dataset
MAX_COLS = 120       # columns included in profile sent to LLM


def load_dataframe(path: str, filename: str) -> pd.DataFrame:
    if filename.lower().endswith((".xlsx", ".xls")):
        df = pd.read_excel(path, nrows=MAX_ROWS)
    else:
        df = pd.read_csv(path, nrows=MAX_ROWS, on_bad_lines="skip", low_memory=False)
    df.columns = [str(c).strip() for c in df.columns]
    # Best-effort parse of date-like columns
    for col in df.columns:
        if df[col].dtype == object:
            try:
                parsed = pd.to_datetime(df[col], errors="raise", format="mixed")
                if parsed.notna().mean() > 0.9:
                    df[col] = parsed
            except (ValueError, TypeError):
                pass
    return df


def auto_profile(df: pd.DataFrame) -> dict:
    """Statistical summary, sanity checks, and IQR outlier detection.
    Caps columns at MAX_COLS so the profile JSON stays manageable."""
    # Cap wide datasets — keep first MAX_COLS columns
    if df.shape[1] > MAX_COLS:
        df = df.iloc[:, :MAX_COLS]

    numeric = df.select_dtypes(include=np.number)

    outliers = {}
    for col in numeric.columns:
        s = numeric[col].dropna()
        if len(s) < 4:
            continue
        q1, q3 = s.quantile([0.25, 0.75])
        iqr = q3 - q1
        mask = (s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)
        if mask.sum() > 0:
            outliers[col] = {
                "count": int(mask.sum()),
                "examples": s[mask].head(5).round(2).tolist(),
            }

    sanity = {
        "duplicate_rows": int(df.duplicated().sum()),
        "missing_values": {c: int(v) for c, v in df.isna().sum().items() if v > 0},
        "constant_columns": [c for c in df.columns if df[c].nunique(dropna=True) <= 1],
        "negative_values": {
            c: int((numeric[c] < 0).sum())
            for c in numeric.columns
            if (numeric[c] < 0).any()
        },
    }

    return {
        "shape": {"rows": int(df.shape[0]), "columns": int(df.shape[1])},
        "dtypes": {c: str(t) for c, t in df.dtypes.items()},
        "numeric_summary": json.loads(numeric.describe().round(3).to_json()) if not numeric.empty else {},
        "outliers_iqr": outliers,
        "sanity_checks": sanity,
        "head": df.head(5).astype(str).to_dict(orient="records"),
    }


def run_code(code: str, datasets: dict, active: str) -> dict:
    """Execute model-generated pandas/plotly code.

    Scope: `df` = active dataset, `dfs` = dict of all datasets by name.
    Convention: print() for text output; assign a plotly figure to `fig`
    (or fig1, fig2, ...) to return charts.
    """
    from services import code_guard

    violations = code_guard.validate(code)
    if violations:
        return {
            "ok": False,
            "output": "",
            "error": "Code blocked by security guard: " + "; ".join(violations) + ". Rewrite the code without these constructs.",
            "figures": [],
        }

    dfs = {name: d.copy() for name, d in datasets.items()}
    scope = {"df": dfs.get(active), "dfs": dfs, "pd": pd, "np": np, "px": px, "go": go}
    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            exec(code, scope)  # noqa: S102 - intentional; local analysis tool
    except Exception:
        return {"ok": False, "output": stdout.getvalue(), "error": traceback.format_exc(limit=3), "figures": []}

    figures = [
        json.loads(v.to_json())
        for k, v in scope.items()
        if k.startswith("fig") and isinstance(v, go.Figure)
    ]
    return {"ok": True, "output": stdout.getvalue()[:8000], "error": None, "figures": figures}
