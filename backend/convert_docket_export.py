#!/usr/bin/env python3
"""
Convert docket_entries_export.json (from docket_chat_gpt2.py analysis)
into the dashboard's expected data/dockets/{deal_id}.json format.

Usage:
    python convert_docket_export.py <export_json> <deal_id> [--output-dir DIR]

Example:
    python convert_docket_export.py \
        "../../Docket Review/docket_entries_export.json" \
        D004
"""

import json
import sys
from pathlib import Path
from collections import Counter, defaultdict
from typing import Optional


def parse_json_field(val):
    """Parse a JSON string field into a Python object. Returns [] on failure."""
    if val is None:
        return []
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []


def convert_entry(raw: dict) -> dict:
    """Convert a single export entry to dashboard DocketEntry format."""
    return {
        "entry_no": raw.get("entry_no", 0),
        "received_date": raw.get("received_date", ""),
        "title": raw.get("title", ""),
        "relevance_level": (raw.get("relevance_level") or "medium").lower(),
        "filer_role": raw.get("filer_role") or "",
        "filer_name": raw.get("filer_name") or "",
        "position_on_deal": raw.get("position_on_deal") or "Neutral",
        "entry_summary": raw.get("entry_summary") or "",
        "key_arguments": parse_json_field(raw.get("key_arguments_json")),
        "cumulative_impact": raw.get("cumulative_impact") or "",
        "download_link": raw.get("download_link") or "",
        "opposition_type": raw.get("opposition_type") or "",
        "intervenor_type": raw.get("intervenor_type") or "",
        "key_excerpts": parse_json_field(raw.get("key_excerpts_json")),
        "relief_type": raw.get("relief_type") or "",
        "presents_new_info": raw.get("presents_new_info", 0),
    }


def aggregate_stakeholders(entries: list) -> list:
    """Build stakeholder list from entries by grouping on filer_name."""
    filer_data = defaultdict(lambda: {
        "roles": [], "positions": [], "opposition_types": [],
        "intervenor_types": [], "statuses": [], "count": 0,
    })

    for e in entries:
        name = e.get("filer_name", "").strip()
        if not name:
            continue
        fd = filer_data[name]
        fd["count"] += 1
        if e.get("filer_role"):
            fd["roles"].append(e["filer_role"])
        if e.get("position_on_deal"):
            fd["positions"].append(e["position_on_deal"])
        if e.get("opposition_type") and e["opposition_type"] != "None":
            fd["opposition_types"].append(e["opposition_type"])
        if e.get("intervenor_type") and e["intervenor_type"] != "None":
            fd["intervenor_types"].append(e["intervenor_type"])
        raw_status = e.get("intervenor_status") or ""
        if raw_status and raw_status != "None":
            fd["statuses"].append(raw_status)

    def most_common(lst):
        if not lst:
            return ""
        return Counter(lst).most_common(1)[0][0]

    stakeholders = []
    for name, fd in sorted(filer_data.items(), key=lambda x: -x[1]["count"]):
        role = most_common(fd["roles"])
        status_raw = most_common(fd["statuses"])
        status = "active" if "active" in status_raw else (status_raw or "active")
        stakeholders.append({
            "name": name,
            "role": role,
            "filing_count": fd["count"],
            "position": most_common(fd["positions"]),
            "opposition_type": most_common(fd["opposition_types"]),
            "status": status,
            "intervenor_type": most_common(fd["intervenor_types"]),
        })

    return stakeholders


def extract_conditions(sorted_raw_entries: list, entry_nos: list) -> list:
    """Extract unique conditions with entry references.

    For each condition, tracks:
      - asked_in: entry_no + date + filer where condition was first proposed
      - resolved_in: entry_no + date + filer where Commission/settlement adopted it

    category values:
      - "practical"  — from Approve_Conditional filers
      - "fallback"   — from Deny_With_Fallback_Conditions filers
      - "demand"     — from Deny/ideological/outright filers
    """
    # norm_key -> condition dict (first occurrence wins)
    seen: dict = {}
    # norm_key -> list of (entry_no, date, filer, filer_role, relief) for all mentions
    all_mentions: dict = defaultdict(list)

    for idx, raw in enumerate(sorted_raw_entries):
        conds = parse_json_field(raw.get("conditions_requested_json"))
        if not conds:
            continue

        filer = raw.get("filer_name") or "Unknown"
        relief = raw.get("relief_type") or ""
        opp_type = raw.get("opposition_type") or ""
        filer_role = raw.get("filer_role") or ""
        date = raw.get("received_date") or ""
        eno = entry_nos[idx]

        # Derive category
        relief_lower = relief.lower()
        if "approve_conditional" in relief_lower or "approve" in relief_lower:
            category = "practical"
        elif "deny_with_fallback" in relief_lower:
            category = "fallback"
        elif opp_type in ("ideological", "outright") or "deny" in relief_lower:
            category = "demand"
        else:
            category = "practical" if filer_role == "Commission" else "proposed"

        # Derive status
        status = "proposed"
        if filer_role == "Commission":
            status = "required"
        elif "approve" in relief_lower:
            status = "pending"

        for cond_text in conds:
            if not isinstance(cond_text, str) or not cond_text.strip():
                continue
            norm = cond_text.strip().lower()[:80]

            # Track every mention
            all_mentions[norm].append({
                "entry_no": eno,
                "date": date,
                "filer": filer,
                "filer_role": filer_role,
                "relief": relief,
            })

            if norm in seen:
                continue

            seen[norm] = {
                "text": cond_text.strip(),
                "status": status,
                "source": filer,
                "category": category,
                "opposition_type": opp_type if opp_type != "None" else "",
                "relief_type": relief,
                "asked_in": {"entry_no": eno, "date": date, "filer": filer},
                "resolved_in": None,
            }

    # Second pass: find resolution entries for each condition
    # A condition is "resolved" if a Commission or Party/settlement entry also mentions it
    for norm, cond in seen.items():
        mentions = all_mentions[norm]
        asked_role = None
        for m in mentions:
            if m["entry_no"] == cond["asked_in"]["entry_no"]:
                asked_role = m["filer_role"]
                break

        for m in mentions:
            if m["entry_no"] == cond["asked_in"]["entry_no"]:
                continue  # skip the original ask
            # Commission ordering it = resolved
            if m["filer_role"] == "Commission":
                cond["resolved_in"] = {
                    "entry_no": m["entry_no"],
                    "date": m["date"],
                    "filer": m["filer"],
                }
                cond["status"] = "required"
                break
            # Party/settlement adopting it = resolved via settlement
            if m["filer_role"] == "Party" and "approve" in m["relief"].lower():
                cond["resolved_in"] = {
                    "entry_no": m["entry_no"],
                    "date": m["date"],
                    "filer": m["filer"],
                }
                cond["status"] = "pending"
                break

        # If the condition was first filed by Commission, it's both asked and resolved
        if asked_role == "Commission" and cond["resolved_in"] is None:
            cond["resolved_in"] = cond["asked_in"].copy()

        # If pending (settlement filing), the filing itself is the resolution
        if cond["status"] == "pending" and cond["resolved_in"] is None:
            cond["resolved_in"] = cond["asked_in"].copy()

    return list(seen.values())


def convert(export_path: str, deal_id: str, output_dir: Optional[str] = None):
    """Main conversion: export JSON → dashboard docket JSON."""
    with open(export_path) as f:
        raw_entries = json.load(f)

    print(f"Loaded {len(raw_entries)} raw entries from {export_path}")

    # Sort chronologically first — all downstream processing uses this order
    raw_entries.sort(key=lambda e: e.get("received_date", ""))

    # Convert entries and assign sequential entry_nos (#1 = earliest)
    entries = [convert_entry(e) for e in raw_entries]
    entry_nos = []
    for i, entry in enumerate(entries, start=1):
        entry["entry_no"] = i
        entry_nos.append(i)
    print(f"Converted {len(entries)} entries")

    # Aggregate stakeholders
    stakeholders = aggregate_stakeholders(raw_entries)
    print(f"Aggregated {len(stakeholders)} stakeholders")

    # Extract conditions with entry references
    conditions = extract_conditions(raw_entries, entry_nos)
    print(f"Extracted {len(conditions)} conditions")

    resolved_count = sum(1 for c in conditions if c.get("resolved_in"))
    print(f"  Resolved: {resolved_count}, Unresolved: {len(conditions) - resolved_count}")

    # Get docket number from first entry
    docket_no = raw_entries[0].get("docket_no", "") if raw_entries else ""

    # Build output
    output = {
        "docket_metadata": {
            "docket_number": docket_no,
            "case_name": "ALLETE / Minnesota Power — BlackRock/GIP Acquisition",
            "jurisdiction": "Minnesota PUC",
            "status": "APPROVED",
        },
        "docket_entries": entries,
        "docket_stakeholders": stakeholders,
        "docket_conditions": conditions,
    }

    # Write
    if output_dir:
        out_dir = Path(output_dir)
    else:
        out_dir = Path(__file__).parent.parent / "data" / "dockets"

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{deal_id}.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {out_path} ({out_path.stat().st_size:,} bytes)")
    print(f"  Entries: {len(entries)}")
    print(f"  Stakeholders: {len(stakeholders)}")
    print(f"  Conditions: {len(conditions)}")

    # Summary
    positions = Counter(e["position_on_deal"] for e in entries)
    relevances = Counter(e["relevance_level"] for e in entries)
    print(f"  Positions: {dict(positions)}")
    print(f"  Relevance: {dict(relevances)}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python convert_docket_export.py <export_json> <deal_id> [--output-dir DIR]")
        sys.exit(1)

    export_path = sys.argv[1]
    deal_id = sys.argv[2]
    output_dir = None
    if "--output-dir" in sys.argv:
        idx = sys.argv.index("--output-dir")
        output_dir = sys.argv[idx + 1]

    convert(export_path, deal_id, output_dir)
