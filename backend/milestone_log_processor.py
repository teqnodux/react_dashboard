"""
Milestone Log Processor
Builds a chronological audit trail of milestone observations per deal,
drawn from all existing data sources (no LLM calls).

Input:  press_release, dma_extract, timelines, tracking, regulatory, sec_filings, proxy_analysis
Output: { deal_id, milestones: [ { id, label, category, current_status, current_date, observations: [...] } ] }
"""

import json
import re
from pathlib import Path
from datetime import datetime
from typing import Optional

_BACKEND_DIR = Path(__file__).parent
_DATA_DIR = _BACKEND_DIR / "data"
TIMELINES_DIR = _DATA_DIR / "timelines"
SEC_FILINGS_DIR = _DATA_DIR / "sec_filings"


# ── Milestone definitions ────────────────────────────────────────────────────

MILESTONES = {
    # Regulatory
    "hsr":              {"label": "HSR (Hart-Scott-Rodino)",   "category": "regulatory"},
    "sec_registration": {"label": "SEC Registration (S-4/F-4)","category": "regulatory"},
    "proxy":            {"label": "Proxy Statement",           "category": "regulatory"},
    "shareholder_vote": {"label": "Stockholder Vote",          "category": "regulatory"},
    "cfius":            {"label": "CFIUS",                      "category": "regulatory"},
    "eu_ec":            {"label": "EU Commission",             "category": "regulatory"},
    "other_reg":        {"label": "Other Regulatory",          "category": "regulatory"},
    # Guidance
    "expected_close":   {"label": "Expected Close",            "category": "guidance"},
    "outside_date":     {"label": "Outside Date",              "category": "guidance"},
    "deal_status":      {"label": "Deal Status",               "category": "guidance"},
}

# Status priority for deriving current_status (higher = more advanced)
STATUS_PRIORITY = {
    "identified": 1, "due": 2, "scheduled": 3, "filed": 5,
    "under_review": 6, "phase_2": 7, "mailed": 8,
    "effective": 9, "cleared": 10, "approved": 11, "completed": 12,
    # Guidance statuses
    "initial": 1, "updated": 4, "on_track": 3, "delayed": 4,
    "extended": 4, "set": 6,
    # Catch-all
    "pending": 2,
}

# SEC filing keyword patterns → milestone IDs
SEC_PATTERNS = {
    "hsr": re.compile(r'hsr|hart.?scott', re.I),
    "sec_registration": re.compile(r's-?4|f-?4|registration\s+statement', re.I),
    "proxy": re.compile(r'proxy\s+statement|prem\s*14|defm\s*14', re.I),
    "shareholder_vote": re.compile(r'(stockholder|shareholder).*(vote|approv|meeting)', re.I),
    "expected_close": re.compile(r'(close|closing).*(expect|first\s+half|second\s+half|20\d{2})', re.I),
    "deal_status": re.compile(r'(deal|transaction|merger).*(status|on\s+track|delay|condition)', re.I),
    "eu_ec": re.compile(r'eu\s+(commission|competition)|european\s+commission|ec\s+merger', re.I),
    "cfius": re.compile(r'cfius|committee\s+on\s+foreign\s+investment', re.I),
}


def _init_milestones() -> dict:
    """Create fresh milestone dict with empty observation lists."""
    ms = {}
    for mid, meta in MILESTONES.items():
        ms[mid] = {
            "id": mid,
            "label": meta["label"],
            "category": meta["category"],
            "current_status": None,
            "current_date": None,
            "observations": [],
        }
    return ms


def _add_obs(ms: dict, milestone_id: str, obs: dict):
    """Append an observation to a milestone, creating it if unknown."""
    if milestone_id not in ms:
        ms[milestone_id] = {
            "id": milestone_id,
            "label": obs.get("source_label", milestone_id),
            "category": "regulatory",
            "current_status": None,
            "current_date": None,
            "observations": [],
        }
    ms[milestone_id]["observations"].append(obs)


def _truncate(text: str, maxlen: int = 300) -> str:
    if not text:
        return ""
    text = text.strip().replace("\n", " ")
    return text[:maxlen] + "…" if len(text) > maxlen else text


def _find_deal_ticker(deal_id: str) -> str:
    """Look up target ticker for a deal from deals.json or timeline JSON."""
    deals_path = _DATA_DIR / "deals.json"
    if deals_path.exists():
        deals_data = json.loads(deals_path.read_text())
        deals_list = deals_data.get("deals", deals_data) if isinstance(deals_data, dict) else deals_data
        for d in deals_list:
            did = d.get("deal_id") or d.get("id", "")
            if did == deal_id:
                return (d.get("target_ticker") or "").lower()
    tl_path = TIMELINES_DIR / f"{deal_id}.json"
    if tl_path.exists():
        tl = json.loads(tl_path.read_text())
        return (tl.get("target_ticker") or "").lower()
    return ""


# ── Source extractors ─────────────────────────────────────────────────────────

def _from_press_release(deal_id: str, ms: dict):
    """Extract milestone observations from press release data."""
    from press_release_processor import get_press_release_data
    pr_raw = get_press_release_data(deal_id)
    if not pr_raw:
        return
    pr = pr_raw.get("extracted", {})
    # Tag to announce/signing date — PR is always from deal announcement
    doc_date = pr_raw.get("filing_date") or pr.get("announce_date")
    if not doc_date:
        doc_date = _get_signing_date(deal_id)

    # Expected close guidance
    if pr.get("expected_close"):
        _add_obs(ms, "expected_close", {
            "doc_date": doc_date,
            "source_type": "press_release",
            "source_label": "Press Release (8-K)",
            "status": "initial",
            "value": pr["expected_close"],
            "excerpt": _truncate(f"Expected close: {pr['expected_close']}"),
        })

    # Regulatory bodies — skipped here. The merger agreement provides the same
    # info with more detail (filing deadlines, conditions). No point duplicating.

    # Shareholder approval noted
    if pr.get("shareholder_approval_required"):
        _add_obs(ms, "shareholder_vote", {
            "doc_date": doc_date,
            "source_type": "press_release",
            "source_label": "Press Release (8-K)",
            "status": "identified",
            "value": "Shareholder approval required",
            "excerpt": _truncate("Stockholder approval required per press release"),
        })

    # Deal status — on track at announcement
    _add_obs(ms, "deal_status", {
        "doc_date": doc_date,
        "source_type": "press_release",
        "source_label": "Press Release (8-K)",
        "status": "initial",
        "value": "Announced",
        "excerpt": _truncate("Deal announced"),
    })


def _from_dma_extract(deal_id: str, ms: dict):
    """Extract milestone observations from DMA extract (merger agreement data).
    Always tagged to signing/announce date — this is agreement data, not when we processed it."""
    from dma_summary_processor import get_dma_extract
    dma_raw = get_dma_extract(deal_id)
    if not dma_raw:
        return
    dma = dma_raw.get("extracted", {})
    # Use announce_date from the extract, or look up signing_date from timeline
    doc_date = dma.get("announce_date")
    if not doc_date:
        tl_path = TIMELINES_DIR / f"{deal_id}.json"
        if tl_path.exists():
            tl = json.loads(tl_path.read_text())
            doc_date = tl.get("signing_date")
    if not doc_date:
        doc_date = dma_raw.get("filing_date")

    # Regulatory filing deadlines
    deadlines_text = dma.get("regulatory_filing_deadlines") or ""
    if deadlines_text:
        if re.search(r'hsr', deadlines_text, re.I):
            _add_obs(ms, "hsr", {
                "doc_date": doc_date,
                "source_type": "merger_agreement",
                "source_label": "Merger Agreement",
                "status": "due",
                "value": deadlines_text,
                "excerpt": _truncate(deadlines_text),
            })

    # Regulatory approvals required
    for approval in (dma.get("regulatory_approvals_required") or []):
        a_lower = approval.lower()
        if "hsr" in a_lower:
            pass  # Already covered by deadlines
        elif "eu" in a_lower or "european" in a_lower:
            _add_obs(ms, "eu_ec", {
                "doc_date": doc_date,
                "source_type": "merger_agreement",
                "source_label": "Merger Agreement",
                "status": "identified",
                "value": approval,
                "excerpt": _truncate(f"Required approval: {approval}"),
            })
        elif "cfius" in a_lower:
            _add_obs(ms, "cfius", {
                "doc_date": doc_date,
                "source_type": "merger_agreement",
                "source_label": "Merger Agreement",
                "status": "identified",
                "value": approval,
                "excerpt": _truncate(f"Required approval: {approval}"),
            })
        elif "antitrust" in a_lower or "foreign" in a_lower:
            _add_obs(ms, "other_reg", {
                "doc_date": doc_date,
                "source_type": "merger_agreement",
                "source_label": "Merger Agreement",
                "status": "identified",
                "value": approval,
                "excerpt": _truncate(f"Required approval: {approval}"),
            })

    # Expected close
    if dma.get("expected_close"):
        _add_obs(ms, "expected_close", {
            "doc_date": doc_date,
            "source_type": "merger_agreement",
            "source_label": "Merger Agreement",
            "status": "updated",
            "value": dma["expected_close"],
            "excerpt": _truncate(f"Expected close per agreement: {dma['expected_close']}"),
        })

    # Outside date
    if dma.get("outside_date"):
        ext_cond = dma.get("outside_date_extension_condition") or ""
        ext_date = dma.get("outside_date_extension") or ""
        value = dma["outside_date"]
        if ext_date:
            value += f" (extendable to {ext_date})"
        _add_obs(ms, "outside_date", {
            "doc_date": doc_date,
            "source_type": "merger_agreement",
            "source_label": "Merger Agreement",
            "status": "initial",
            "value": value,
            "excerpt": _truncate(f"Outside date: {dma['outside_date']}. {ext_cond}"),
        })


def _from_timeline(deal_id: str, ms: dict):
    """Extract milestone observations from timeline JSON (calculated dates)."""
    tl_path = TIMELINES_DIR / f"{deal_id}.json"
    if not tl_path.exists():
        return
    tl = json.loads(tl_path.read_text())
    signing = tl.get("signing_date")
    doc_date = signing or (tl.get("_meta", {}).get("filing_date"))

    # Deadline events → milestone due dates
    for ev in tl.get("deadline_events", []):
        label = (ev.get("label") or "").lower()
        calc = ev.get("calculation") or ""
        evt_date = ev.get("date")

        if "hsr" in label and "clearance" not in label:
            _add_obs(ms, "hsr", {
                "doc_date": doc_date,
                "source_type": "timeline",
                "source_label": "Timeline (calculated)",
                "status": "due",
                "value": f"Due {evt_date}" if evt_date else calc,
                "excerpt": _truncate(f"{ev.get('label')}: {calc}"),
            })
        elif "s-4" in label or "s4" in label or "registration" in label.lower():
            _add_obs(ms, "sec_registration", {
                "doc_date": doc_date,
                "source_type": "timeline",
                "source_label": "Timeline (calculated)",
                "status": "due",
                "value": f"Due {evt_date}" if evt_date else calc,
                "excerpt": _truncate(f"{ev.get('label')}: {calc}"),
            })
        elif "proxy" in label:
            _add_obs(ms, "proxy", {
                "doc_date": doc_date,
                "source_type": "timeline",
                "source_label": "Timeline (calculated)",
                "status": "due",
                "value": f"Due {evt_date}" if evt_date else calc,
                "excerpt": _truncate(f"{ev.get('label')}: {calc}"),
            })

    # Outside date extensions
    if tl.get("outside_date_initial"):
        _add_obs(ms, "outside_date", {
            "doc_date": doc_date,
            "source_type": "timeline",
            "source_label": "Timeline (calculated)",
            "status": "initial",
            "value": tl["outside_date_initial"],
            "excerpt": _truncate(f"Outside date: {tl['outside_date_initial']}"),
        })
    for ext in (tl.get("outside_date_extensions") or []):
        _add_obs(ms, "outside_date", {
            "doc_date": doc_date,
            "source_type": "timeline",
            "source_label": "Timeline (calculated)",
            "status": "extended",
            "value": ext.get("date", ""),
            "excerpt": _truncate(f"Extension to {ext.get('date')}: {ext.get('condition', '')}"),
        })


def _from_tracking(deal_id: str, ms: dict):
    """Extract milestone observations from tracking JSON (actual filed dates)."""
    trk_path = TIMELINES_DIR / f"{deal_id}_tracking.json"
    if not trk_path.exists():
        return
    trk = json.loads(trk_path.read_text())
    events = trk.get("events", {})

    key_to_milestone = {
        "hsr_filed":            ("hsr",              "filed"),
        "reg_hsr_act":          ("hsr",              "cleared"),
        "s4_filed":             ("sec_registration", "filed"),
        "s4_effective":         ("sec_registration", "effective"),
        "proxy_filed":          ("proxy",            "filed"),
        "conditions_satisfied": ("deal_status",      "completed"),
    }

    for key, (mid, status) in key_to_milestone.items():
        ev = events.get(key, {})
        if ev and ev.get("date"):
            _add_obs(ms, mid, {
                "doc_date": ev["date"],
                "source_type": "tracking",
                "source_label": "Tracking",
                "status": status,
                "value": ev["date"],
                "excerpt": _truncate(f"{key}: {ev['date']}"),
            })


def _from_regulatory(deal_id: str, ms: dict):
    """Extract milestone observations from regulatory JSON."""
    reg_path = TIMELINES_DIR / f"{deal_id}_regulatory.json"
    if not reg_path.exists():
        return
    reg = json.loads(reg_path.read_text())
    doc_date = reg.get("last_updated")

    for approval in reg.get("approvals", []):
        aid = (approval.get("id") or "").lower()
        status = approval.get("status", "pending")
        auth = approval.get("authority_short", "")
        notes = approval.get("notes", "")

        # Map regulatory approval to milestone
        if "hsr" in aid:
            mid = "hsr"
        elif "sec" in aid or "s4" in aid or "s-4" in aid:
            mid = "sec_registration"
        elif "eu" in aid or "ec" in aid or "european" in aid:
            mid = "eu_ec"
        elif "cfius" in aid:
            mid = "cfius"
        else:
            mid = "other_reg"

        obs = {
            "doc_date": doc_date,
            "source_type": "regulatory",
            "source_label": f"Regulatory Tracker ({auth})",
            "status": status,
            "value": f"{auth}: {status}",
            "excerpt": _truncate(notes),
        }

        # Add filed date if available
        if approval.get("filed_date"):
            obs["value"] = f"{auth}: filed {approval['filed_date']}"
            obs["status"] = "filed"
        if approval.get("cleared_date"):
            obs["value"] = f"{auth}: cleared {approval['cleared_date']}"
            obs["status"] = "cleared"

        _add_obs(ms, mid, obs)

        # Also extract from linked_docs for richer trail
        for doc in (approval.get("linked_docs") or []):
            doc_type = doc.get("doc_type", "")
            summary = doc.get("summary", "")
            if summary and len(summary) > 20:
                _add_obs(ms, mid, {
                    "doc_date": doc.get("doc_date") or doc_date,
                    "source_type": f"regulatory_linked_{doc_type}",
                    "source_label": doc.get("L1") or f"Regulatory ({doc_type})",
                    "status": status,
                    "value": _truncate(summary, 100),
                    "excerpt": _truncate(summary),
                })


def _from_sec_filings(deal_id: str, ms: dict):
    """Scan SEC filing L3 fields for concrete milestone updates.
    Only surfaces observations with actual dates or status changes —
    not boilerplate mentions of conditions/risks from the agreement."""
    ticker = _find_deal_ticker(deal_id)
    if not ticker:
        return
    index_path = SEC_FILINGS_DIR / ticker / "filing_index.json"
    if not index_path.exists():
        return
    index_data = json.loads(index_path.read_text())

    # Look up announce date to skip the announcement filing (it just restates the agreement)
    announce_date = _get_announce_date(deal_id)

    # Only scan fields that contain actual updates (not conditions lists, risks, etc.)
    update_fields = {
        "425":  ["deal_status_update", "regulatory_update", "timeline_update"],
        "8-K":  ["event"],
        "10-K": ["guidance_and_outlook"],
        "10-Q": ["guidance_and_outlook"],
        "OTHER": ["regulatory_mentions", "timeline_or_dates"],
    }

    # Patterns that indicate a concrete, past-tense status change.
    # "will file" / "has been reached" / listing conditions = not updates.
    _ACTION_PAT = re.compile(
        r'filed\s+(on|with\s+the\s+SEC\s+on|its\s+HSR|HSR\s+Act\s+notification\w*\s+on)'
        r'|was\s+filed\s+(on|with)'
        r'|was\s+(cleared|approved|declared\s+effective|granted|terminated|withdrawn|mailed)'
        r'|received\s+(clearance|approval|early\s+termination)'
        r'|waiting\s+period\s+(expir\w+\s+(on|March|April|May|June|July|Aug|Sep|Oct|Nov|Dec|Jan|Feb)|set\s+to\s+expire)'
        r'|declared\s+effective'
        r'|early\s+termination\s+(was\s+)?granted'
        r'|second\s+request\s+(was\s+)?issued',
        re.I
    )

    for filing in index_data.get("results", []):
        form_type = (filing.get("form_type") or "").upper()
        if "FORM 4" in form_type or "SC 13" in form_type:
            continue

        summary = filing.get("summary", {})
        filing_date = summary.get("filing_date") or filing.get("date")
        filing_date_norm = _normalize_date(filing_date)

        # Skip announcement-day filings — they just restate the agreement
        if announce_date and filing_date_norm and filing_date_norm <= announce_date:
            continue

        l3 = summary.get("L3_detailed", {})
        if not isinstance(l3, dict):
            continue

        form_key = form_type.replace("FORM ", "")
        fields_to_check = update_fields.get(form_key, update_fields.get("OTHER", []))

        for field_name in fields_to_check:
            field_val = l3.get(field_name)
            if not field_val:
                continue
            text = str(field_val) if not isinstance(field_val, str) else field_val
            if len(text) < 20:
                continue

            # Must contain a past-tense action — not just a keyword mention
            if not _ACTION_PAT.search(text):
                continue

            # Now check which milestone this updates
            for mid, pattern in SEC_PATTERNS.items():
                if pattern.search(text):
                    source_label = f"SEC Filing ({form_type}, {filing_date or '?'})"
                    _add_obs(ms, mid, {
                        "doc_date": filing_date_norm,
                        "source_type": "sec_filing",
                        "source_label": source_label,
                        "status": "updated",
                        "value": _truncate(text, 120),
                        "excerpt": _truncate(text),
                    })
                    break


def _get_announce_date(deal_id: str) -> Optional[str]:
    """Get announce/signing date to filter out announcement-day filings."""
    from press_release_processor import get_press_release_data
    pr = get_press_release_data(deal_id)
    if pr:
        ext = pr.get("extracted", {})
        d = ext.get("announce_date") or pr.get("filing_date")
        if d:
            return d
    return _get_signing_date(deal_id)


def _get_signing_date(deal_id: str) -> Optional[str]:
    """Get signing date from timeline JSON."""
    tl_path = TIMELINES_DIR / f"{deal_id}.json"
    if tl_path.exists():
        tl = json.loads(tl_path.read_text())
        return tl.get("signing_date")
    return None


def _from_proxy_analysis(deal_id: str, ms: dict):
    """Parse proxy analysis text files for milestone observations."""
    from proxy_analysis_processor import get_proxy_analyses
    analyses = get_proxy_analyses(deal_id)
    if not analyses:
        return

    # Look up actual proxy/S-4 filing date from tracking
    trk_path = TIMELINES_DIR / f"{deal_id}_tracking.json"
    proxy_filing_date = None
    if trk_path.exists():
        trk = json.loads(trk_path.read_text())
        events = trk.get("events", {})
        # Use proxy_filed or s4_filed date as the proxy document date
        proxy_filing_date = (events.get("proxy_filed") or {}).get("date") \
            or (events.get("s4_filed") or {}).get("date")

    for analysis in analyses:
        doc_type = analysis.get("doc_type", "summary")
        filing_type = analysis.get("filing_type", "")
        generated = analysis.get("generated", "")
        # Use actual filing date from tracking, then analysis metadata, then generated
        doc_date = proxy_filing_date \
            or analysis.get("filing_date") \
            or _extract_date_from_generated(generated)

        source_label = f"Proxy ({filing_type})" if filing_type else "Proxy Analysis"

        # Scan QA items for milestone keywords
        for qa in (analysis.get("qa_items") or analysis.get("qa_pairs") or []):
            question = qa.get("question", "")
            answer = qa.get("answer", "")
            q_lower = question.lower()
            a_text = answer

            # HSR / regulatory
            if re.search(r'regulatory|hsr|antitrust|clearance|approval', q_lower):
                # Check for HSR specifics in answer
                if re.search(r'hsr|hart.?scott', a_text, re.I):
                    # Look for filed date
                    date_match = re.search(r'filed.*?(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})', a_text, re.I)
                    if date_match:
                        _add_obs(ms, "hsr", {
                            "doc_date": doc_date,
                            "source_type": "proxy_analysis",
                            "source_label": source_label,
                            "status": "filed",
                            "value": date_match.group(1),
                            "excerpt": _truncate(a_text),
                        })
                    # Look for waiting period expiration date (must be near "expire")
                    expire_match = re.search(
                        r'(?:waiting\s+period|expir\w+)\s+(?:scheduled\s+to\s+|set\s+to\s+)?expir\w*\s+(\w+\s+\d{1,2},?\s+\d{4})',
                        a_text, re.I
                    )
                    if expire_match:
                        _add_obs(ms, "hsr", {
                            "doc_date": doc_date,
                            "source_type": "proxy_analysis",
                            "source_label": source_label,
                            "status": "under_review",
                            "value": f"Waiting period expires {expire_match.group(1)}",
                            "excerpt": _truncate(a_text),
                        })
                    # Look for clearance granted
                    clear_match = re.search(
                        r'(clearance|early\s+termination)\s+(?:was\s+)?(?:granted|received|obtained)\s*(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})?',
                        a_text, re.I
                    )
                    if clear_match and clear_match.group(2):
                        _add_obs(ms, "hsr", {
                            "doc_date": doc_date,
                            "source_type": "proxy_analysis",
                            "source_label": source_label,
                            "status": "cleared",
                            "value": f"Cleared {clear_match.group(2)}",
                            "excerpt": _truncate(a_text),
                        })

                # EU / international
                if re.search(r'eu\b|european\s+commission|ec\s+merger', a_text, re.I):
                    _add_obs(ms, "eu_ec", {
                        "doc_date": doc_date,
                        "source_type": "proxy_analysis",
                        "source_label": source_label,
                        "status": "identified",
                        "value": _truncate(a_text, 100),
                        "excerpt": _truncate(a_text),
                    })

            # Stockholder vote / meeting
            if re.search(r'shareholder|stockholder|vote|meeting|record\s+date', q_lower):
                status = "identified"
                value = _truncate(a_text, 100)
                # Look for specific date
                if re.search(r'(meeting|vote).*?(\w+\s+\d{1,2},?\s+\d{4})', a_text, re.I):
                    status = "scheduled"
                _add_obs(ms, "shareholder_vote", {
                    "doc_date": doc_date,
                    "source_type": "proxy_analysis",
                    "source_label": source_label,
                    "status": status,
                    "value": value,
                    "excerpt": _truncate(a_text),
                })

            # Expected close / closing timeline
            if re.search(r'clos(e|ing)\s+(timeline|date|expect)|expected\s+close', q_lower):
                _add_obs(ms, "expected_close", {
                    "doc_date": doc_date,
                    "source_type": "proxy_analysis",
                    "source_label": source_label,
                    "status": "updated",
                    "value": _truncate(a_text, 120),
                    "excerpt": _truncate(a_text),
                })

        # detail_sections skipped — they contain tables/background narrative,
        # not milestone updates. QA pairs above capture the meaningful content.


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize_date(date_str: Optional[str]) -> Optional[str]:
    """Normalize dates like 'MM/DD/YY' or 'MM/DD/YYYY' to 'YYYY-MM-DD'."""
    if not date_str:
        return None
    date_str = date_str.strip()
    # Already ISO format
    if re.match(r'^\d{4}-\d{2}-\d{2}', date_str):
        return date_str[:10]
    # MM/DD/YY
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})$', date_str)
    if m:
        month, day, year = m.groups()
        if len(year) == 2:
            year = "20" + year
        return f"{year}-{int(month):02d}-{int(day):02d}"
    return date_str


def _extract_date_from_generated(generated: str) -> Optional[str]:
    """Extract date from proxy 'generated' field like 'March 17, 2026 - 10:49 PM'."""
    if not generated:
        return None
    m = re.match(r'(\w+ \d{1,2},? \d{4})', generated)
    if m:
        for fmt in ("%B %d, %Y", "%B %d %Y"):
            try:
                dt = datetime.strptime(m.group(1), fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


def _deduplicate_observations(observations: list) -> list:
    """Remove near-duplicate observations (same source_type + status + value)."""
    seen = set()
    deduped = []
    for obs in observations:
        key = (obs.get("source_type"), obs.get("status"), obs.get("value", "")[:80])
        if key not in seen:
            seen.add(key)
            deduped.append(obs)
    return deduped


def _derive_current_status(observations: list) -> tuple:
    """Derive current_status and current_date from the most advanced observation.
    First find the highest-priority status, then among all observations with that
    status, prefer one whose value is a date."""
    if not observations:
        return None, None
    # Find best status
    best_priority = max(STATUS_PRIORITY.get(o.get("status", ""), 0) for o in observations)
    best_status = None
    for o in observations:
        if STATUS_PRIORITY.get(o.get("status", ""), 0) == best_priority:
            best_status = o.get("status")
            break

    # Among observations with the best status, find one with a date-like value
    best_date = None
    for o in observations:
        if STATUS_PRIORITY.get(o.get("status", ""), 0) == best_priority:
            if _is_date_like(o.get("value")):
                best_date = o["value"]
                break
    # Fallback: latest doc_date among best-status observations
    if not best_date:
        best_date = max(
            (o.get("doc_date") or "" for o in observations
             if STATUS_PRIORITY.get(o.get("status", ""), 0) == best_priority),
            default=None
        )
    return best_status, best_date


def _is_date_like(val: Optional[str]) -> bool:
    """Check if a value looks like a date (YYYY-MM-DD or Month Day, Year)."""
    if not val:
        return False
    return bool(re.match(r'^\d{4}-\d{2}-\d{2}$', val)) or bool(
        re.match(r'^\w+ \d{1,2},? \d{4}$', val.strip()))


# ── Main entry point ─────────────────────────────────────────────────────────

def build_milestone_log(deal_id: str) -> dict:
    """Build complete milestone log from all data sources. No caching — always fresh."""
    ms = _init_milestones()

    # Call each extractor in order (source documents only — no derived outputs)
    _from_press_release(deal_id, ms)
    _from_dma_extract(deal_id, ms)
    # _from_timeline skipped — calculated from agreement, not a source
    # _from_tracking skipped — internal system dates, not a source document
    # _from_regulatory skipped — derived output, not a source document
    _from_sec_filings(deal_id, ms)
    _from_proxy_analysis(deal_id, ms)

    # Post-process: deduplicate, derive status
    milestones = []
    for mid, m in ms.items():
        obs = m["observations"]
        if not obs:
            continue  # Skip milestones with no data
        obs = _deduplicate_observations(obs)
        # Sort by doc_date ascending
        obs.sort(key=lambda o: o.get("doc_date") or "9999")
        m["observations"] = obs
        m["current_status"], m["current_date"] = _derive_current_status(obs)
        milestones.append(m)

    # Sort: regulatory first, then guidance, then by label
    cat_order = {"regulatory": 0, "guidance": 1}
    milestones.sort(key=lambda m: (cat_order.get(m["category"], 9), m["label"]))

    return {
        "deal_id": deal_id,
        "milestones": milestones,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
