"""PII detection and masking guardrail.

Detects emails, phone numbers, credit cards, SSN (US), Aadhaar/PAN (India),
and likely name columns via regex + column-name heuristics. The upload flow
warns the user, who chooses to mask or proceed.
"""
import re

import pandas as pd

PATTERNS = {
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)\d{3}[\s-]?\d{4}(?!\d)"),
    "credit_card": re.compile(r"\b(?:\d[ -]?){13,19}\b"),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "aadhaar": re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"),
    "pan": re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),
}

NAME_COLUMN_HINTS = re.compile(
    r"(first|last|full|customer|employee|user|contact)[\s_]*name|^name$", re.IGNORECASE
)
SENSITIVE_COLUMN_HINTS = re.compile(
    r"email|phone|mobile|ssn|aadhaar|pan[\s_]*(no|num|number)?$|passport|credit[\s_]*card|card[\s_]*(no|num)|address|dob|date[\s_]*of[\s_]*birth|salary",
    re.IGNORECASE,
)

SAMPLE_ROWS = 200  # rows sampled per column for value scanning


def _luhn_ok(digits: str) -> bool:
    d = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    checksum = 0
    for i, n in enumerate(reversed(d)):
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        checksum += n
    return checksum % 10 == 0


def scan(df: pd.DataFrame) -> list[dict]:
    """Return findings: [{column, types, match_ratio, reason}]."""
    findings = []
    for col in df.columns:
        types, reasons = set(), []
        if SENSITIVE_COLUMN_HINTS.search(str(col)):
            types.add("sensitive_column_name")
            reasons.append(f"column name '{col}' looks sensitive")
        if NAME_COLUMN_HINTS.search(str(col)):
            types.add("person_name")
            reasons.append(f"column name '{col}' suggests person names")

        sample = df[col].dropna().astype(str).head(SAMPLE_ROWS)
        if not sample.empty:
            hits = {}
            for kind, pattern in PATTERNS.items():
                matched = sample.str.contains(pattern, regex=True)
                ratio = matched.mean()
                if kind == "credit_card" and ratio > 0:
                    # reduce false positives (e.g. long IDs) with Luhn check
                    valid = sum(
                        _luhn_ok(m.group())
                        for v in sample[matched].head(20)
                        if (m := pattern.search(v))
                    )
                    if valid == 0:
                        continue
                if ratio >= 0.3:
                    hits[kind] = ratio
            for kind, ratio in hits.items():
                types.add(kind)
                reasons.append(f"{ratio:.0%} of sampled values match {kind} pattern")

        if types:
            findings.append({"column": col, "types": sorted(types), "reason": "; ".join(reasons)})
    return findings


def _mask_value(val: str, kind: str) -> str:
    if kind == "email":
        return PATTERNS["email"].sub(lambda m: m.group()[0] + "***@" + m.group().split("@")[1], val)
    if kind in ("credit_card", "aadhaar", "ssn", "phone"):
        digits = re.sub(r"\D", "", val)
        return "****" + digits[-4:] if len(digits) >= 4 else "****"
    return "****"


def mask(df: pd.DataFrame, findings: list[dict]) -> pd.DataFrame:
    """Return a copy with PII masked. Name/sensitive columns are pseudonymized
    (stable token per unique value) so groupby analysis still works."""
    df = df.copy()
    for f in findings:
        col = f["column"]
        if col not in df.columns:
            continue
        value_types = [t for t in f["types"] if t in PATTERNS]
        if value_types:
            kind = value_types[0]
            df[col] = df[col].astype(str).map(lambda v: _mask_value(v, kind))
        else:
            # pseudonymize: same input -> same token, keeps aggregations meaningful
            codes, _ = pd.factorize(df[col].astype(str))
            prefix = "person" if "person_name" in f["types"] else "value"
            df[col] = [f"{prefix}_{c + 1}" if c >= 0 else "" for c in codes]
    return df
