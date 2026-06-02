#!/usr/bin/env python3
"""Generate FCA data JSON files from SQLite DB for the dashboard API.

Usage: python3 scripts/generate-fca-data.py
Output: api/data/fca-lists.json, api/data/fca-holidays.json
"""

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent.parent / "trading-db" / "idx.db"
OUT_DIR = Path(__file__).resolve().parent.parent / "api" / "data"

# ── IDX Holidays (manual, updated as needed) ──
IDX_HOLIDAYS = [
    "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-23", "2026-03-24",
    "2026-04-03", "2026-05-01", "2026-05-14", "2026-05-15", "2026-05-27", "2026-05-28",
]

# FCA threshold and period
FCA_THRESHOLD = 51
PERIOD_START = "2026-02-27"
PERIOD_END = "2026-05-28"


def generate():
    if not DB_PATH.exists():
        print(f"ERROR: DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()

    # ── FCA lists ──
    c.execute("SELECT code, criteria FROM fca_list WHERE is_active=1 ORDER BY code")
    all_fca = c.fetchall()

    all_codes = [r[0] for r in all_fca]
    pure_1 = [r[0] for r in all_fca if r[1].strip() == "1"]
    multi = {r[0]: r[1] for r in all_fca if r[1].strip() != "1"}

    # Suspended: criteria 10 or 11
    suspended = [
        r[0] for r in all_fca
        if r[1].strip() in ("10", "11")
        or ", 10" in r[1]
        or ", 11" in r[1]
        or "7, 11" in r[1]
    ]

    # ── Stock names ──
    c.execute("SELECT code, name FROM stocks WHERE code IN ({})".format(
        ",".join(f"'{c}'" for c in all_codes)
    ))
    names = dict(c.fetchall())

    conn.close()

    fca_data = {
        "generated": __import__("datetime").datetime.now().isoformat(),
        "totalActive": len(all_codes),
        "pureCriteria1": len(pure_1),
        "suspended": len(suspended),
        "allActiveFca": all_codes,
        "pureCriteria1": pure_1,
        "fcaCriteria": multi,
        "suspendedCriteria": suspended,
        "stockNames": names,
        "periodStart": PERIOD_START,
        "periodEnd": PERIOD_END,
        "fcaThreshold": FCA_THRESHOLD,
    }

    holidays_data = {
        "generated": __import__("datetime").datetime.now().isoformat(),
        "holidays": IDX_HOLIDAYS,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(OUT_DIR / "fca-lists.json", "w") as f:
        json.dump(fca_data, f, indent=2)

    with open(OUT_DIR / "fca-holidays.json", "w") as f:
        json.dump(holidays_data, f, indent=2)

    print(f"✅ Generated {OUT_DIR / 'fca-lists.json'} ({len(all_codes)} FCA stocks)")
    print(f"✅ Generated {OUT_DIR / 'fca-holidays.json'} ({len(IDX_HOLIDAYS)} holidays)")
    print(f"   Pure criteria 1: {len(pure_1)}")
    print(f"   Suspended: {len(suspended)}")


if __name__ == "__main__":
    generate()
