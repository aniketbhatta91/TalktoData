"""Generate dataset-aware prompt suggestions using the fast LLM.

Called after upload so the user sees relevant, specific prompts instead of
generic placeholder text. Falls back to rule-based suggestions using actual
column names if the LLM call fails.
"""
import json
import re

import config

_SYSTEM = (
    "You are a data analyst. Given a dataset description, generate exactly 5 "
    "short, specific, actionable prompt suggestions a user could ask about this data. "
    "Return ONLY a valid JSON array of 5 strings — no explanation, no markdown fences."
)

_DOMAIN_HINTS = {
    "healthcare": "Focus on clinical KPIs: readmissions, length of stay, bed occupancy, mortality, cost per case.",
    "supplychain": "Focus on supply chain KPIs: OTIF, inventory turnover, lead time, stockouts, demand forecast accuracy.",
    "hr": "Focus on people analytics: attrition, headcount, time-to-fill, compensation, engagement scores.",
    "retail": "Focus on retail KPIs: sales trends, basket size, conversion rate, top products, seasonal patterns.",
}


def generate(profile: dict, domain: str = "", dataset_name: str = "") -> list[str]:
    """Return 5 dataset-specific prompt suggestions.
    Uses the fast LLM; falls back to rule-based suggestions using real column names.
    """
    dtypes = profile.get("dtypes", {})
    cols = [f"{col} ({dtype})" for col, dtype in list(dtypes.items())[:25]]
    col_str = ", ".join(cols)
    rows = profile.get("shape", {}).get("rows", "?")

    numeric_cols = [
        c for c, t in dtypes.items()
        if "int" in str(t).lower() or "float" in str(t).lower()
    ]
    date_cols = [
        c for c, t in dtypes.items()
        if "datetime" in str(t).lower()
        or c.lower() in ("date", "year", "month", "week", "period", "timestamp", "time")
    ]
    cat_cols = [
        c for c, t in dtypes.items()
        if "object" in str(t).lower() or "category" in str(t).lower()
    ]

    domain_hint = _DOMAIN_HINTS.get(domain, "")
    user_msg = (
        f"Dataset: '{dataset_name}', {rows} rows.\n"
        f"Columns: {col_str}\n"
        + (f"Domain context: {domain_hint}\n" if domain_hint else "")
        + "Generate 5 diverse suggestions: mix charts, stats, outlier detection, and domain-specific KPI questions."
    )

    try:
        raw = _call_llm(user_msg)
        parsed = _parse(raw)
        if parsed:
            return parsed
    except Exception:
        pass

    return _fallback(numeric_cols, date_cols, cat_cols, domain, dataset_name)


def _call_llm(user_msg: str) -> str:
    if config.LLM_PROVIDER == "openai":
        from openai import OpenAI
        client = OpenAI(base_url=config.OPENAI_BASE_URL, api_key=config.OPENAI_API_KEY or "none")
        r = client.chat.completions.create(
            model=config.OPENAI_FAST_MODEL,
            max_tokens=350,
            temperature=0.7,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user_msg},
            ],
        )
        return (r.choices[0].message.content or "").strip()
    else:
        import anthropic
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
        r = client.messages.create(
            model=config.ANTHROPIC_FAST_MODEL,
            max_tokens=350,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )
        return "".join(b.text for b in r.content if b.type == "text").strip()


def _parse(raw: str) -> list[str]:
    """Extract a JSON array of strings from the LLM response."""
    raw = re.sub(r"```[a-z]*\n?", "", raw).strip().rstrip("`").strip()
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    result = json.loads(raw)
    if isinstance(result, list):
        return [str(s).strip() for s in result if s][:5]
    return []


def _fallback(numeric_cols: list, date_cols: list, cat_cols: list,
              domain: str, dataset_name: str) -> list[str]:
    """Rule-based suggestions built from actual column names — always dataset-specific."""
    suggestions = []

    # Time-series suggestion if date + numeric columns present
    if date_cols and numeric_cols:
        suggestions.append(
            f"Show {numeric_cols[0]} trend over {date_cols[0]} as a line chart"
        )

    # Numeric distribution
    if numeric_cols:
        suggestions.append(
            f"Show distribution and outliers for {', '.join(numeric_cols[:3])}"
        )

    # Category breakdown
    if cat_cols and numeric_cols:
        suggestions.append(
            f"Compare {numeric_cols[0]} across different {cat_cols[0]} values"
        )
    elif numeric_cols and len(numeric_cols) >= 2:
        suggestions.append(
            f"Show correlation between {numeric_cols[0]} and {numeric_cols[1]}"
        )

    # Always include EDA and outlier check
    suggestions.append("Run sanity checks and find outliers in the dataset")

    if len(suggestions) < 5:
        suggestions.append(f"Do a full exploratory data analysis of {dataset_name} with charts")

    # Domain-specific 5th suggestion
    domain_extra = {
        "healthcare": f"What is the average length of stay and how does it vary by {cat_cols[0] if cat_cols else 'department'}?",
        "supplychain": f"Which {cat_cols[0] if cat_cols else 'products'} have the highest stockout frequency?",
        "hr": f"Show attrition rate breakdown by {cat_cols[0] if cat_cols else 'department'}",
        "retail": f"Which {cat_cols[0] if cat_cols else 'products'} generate the most revenue?",
    }
    if domain in domain_extra and len(suggestions) < 5:
        suggestions.append(domain_extra[domain])

    return suggestions[:5]
