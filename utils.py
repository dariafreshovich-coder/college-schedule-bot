from __future__ import annotations

import re
from datetime import date
from typing import Any


_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)")


def clean_text(value: Any) -> str:
    """Return a compact, human-readable value from an Excel/DOCX cell."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).replace("\xa0", " ")
    return " ".join(text.split()).strip()


def normalize_key(value: Any) -> str:
    """Normalize group names for matching values from different source files."""
    return clean_text(value).casefold().replace("ё", "е")


def parse_date_from_text(text: str) -> date | None:
    for match in _DATE_RE.finditer(text or ""):
        day, month, year = (int(part) for part in match.groups())
        if year < 100:
            year += 2000
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return None


def clean_teacher(value: Any) -> str:
    """Fix the common DOCX typo 'ХаритоноваС.В.' without changing the name."""
    text = clean_text(value)
    return re.sub(r"(?<=[А-Яа-яЁё])(?=[А-ЯЁ]\.?)", " ", text)
