import React, { useEffect, useState } from "react";
import api from "../services/api";
import "../styles/ForeignFilingsTab.css";

interface FilingRecord {
  [key: string]: any;
}

interface FilingGroup {
  source: string;
  label: string;
  country: string;
  count: number;
  records: FilingRecord[];
}

interface ForeignFilingsResponse {
  filings: FilingGroup[];
}

const FLAG: Record<string, string> = {
  Australia:        "🇦🇺",
  Brazil:           "🇧🇷",
  Canada:           "🇨🇦",
  EU:               "🇪🇺",
  Germany:          "🇩🇪",
  India:            "🇮🇳",
  "New Zealand":    "🇳🇿",
  China:            "🇨🇳",
  "United Kingdom": "🇬🇧",
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatToEST(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return null;
  }
}

function getRegisterDateLabel(_source: string): string {
  return "Filed";
}

function getRegisterDate(source: string, r: FilingRecord): string | null {
  switch (source) {
    case "accc_cases":       return r.effective_notification_date || null;
    case "brazil_cases":     return r.registration_date || null;
    case "canada_cases":     return r.opened_date || null;
    case "cci_cases":        return r.date_of_notification || null;
    case "ec_cases":
    case "fs_cases":         return r.notification_date || r.last_decision_date || null;
    case "german_cases":     return r.date || null;
    case "nz_cases":         return r.case_details?.["Date opened"] || null;
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional": return r.date || null;
    case "uk_cma_cases":     return r.opened_date || null;
    default:                 return null;
  }
}

function getRawCreatedAt(source: string, r: FilingRecord): string | null {
  if (source === "samr_cases" || source === "samr_conditional" || source === "samr_unconditional") {
    return r.processed_at || null;
  }
  return r.created_at || null;
}

function getRawUpdatedAt(source: string, r: FilingRecord): string | null {
  if (source === "samr_cases" || source === "samr_conditional" || source === "samr_unconditional") {
    return null;
  }
  return r.updated_at || null;
}

// ─── Per-source field extractors ──────────────────────────────────────────────

function getRecordTitle(source: string, r: FilingRecord): string {
  switch (source) {
    case "accc_cases":       return r.title || "";
    case "brazil_cases":     return r.interessados_en || r.interessados || "";
    case "canada_cases":     return r.parties || "";
    case "cci_cases":        return r.notifying_parties || r.combination_registration_no || "";
    case "ec_cases":
    case "fs_cases":         return r.case_title || "";
    case "german_cases":     return r.pursue_en || r.pursue || "";
    case "nz_cases":         return r.title || "";
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional": return r.title_en || r.title_cn || "";
    case "uk_cma_cases":     return r.title || "";
    default:                 return "";
  }
}

function getRecordUrl(source: string, r: FilingRecord): string | null {
  switch (source) {
    case "accc_cases":
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional": return r.url || null;
    case "brazil_cases":     return r.detail_url || null;
    case "cci_cases":        return r.notice_under_review_url || r.detail_urls?.notice_under_review || null;
    case "ec_cases":
    case "fs_cases":         return r.case_url || null;
    case "nz_cases":
    case "uk_cma_cases":     return r.detail_url || null;
    default:                 return null;
  }
}

function getRecordStatus(source: string, r: FilingRecord): { text: string; open: boolean } | null {
  switch (source) {
    case "accc_cases": {
      const text = r.status?.accc_determination || r.acquisition_status || "";
      return text ? { text, open: r.is_open ?? true } : null;
    }
    case "brazil_cases":
      return r.type_en ? { text: r.type_en, open: r.is_open === "True" || r.is_open === true } : null;
    case "canada_cases":
      return r.outcome ? { text: r.outcome, open: r.is_open === true } : null;
    case "cci_cases":
      return r.cci_status ? { text: r.cci_status, open: r.stage === "UNDER_REVIEW" || r.decision_date == null } : null;
    case "ec_cases":
    case "fs_cases":
      return r.status ? { text: r.status, open: r.is_open !== false } : null;
    case "german_cases":
      return r.diploma_en ? { text: r.diploma_en, open: r.is_open === true } : null;
    case "nz_cases":
      return r.status ? { text: r.status, open: r.is_open !== false } : null;
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional":
      return { text: r.is_open ? "Open" : "Closed", open: r.is_open === true };
    case "uk_cma_cases": {
      const text = r.case_state
        ? r.outcome ? `${r.case_state} — ${r.outcome}` : r.case_state
        : "";
      return text ? { text, open: r.case_state === "Open" } : null;
    }
    default: return null;
  }
}

function getExtraFields(source: string, r: FilingRecord): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  switch (source) {
    case "accc_cases":
      if (r.case_number) fields.push({ label: "Case #", value: r.case_number });
      if (r.type) fields.push({ label: "Filing Type", value: r.type });
      if (r.status?.stage) fields.push({ label: "Phase", value: r.status.stage });
      if (r.status?.determination_publication_date)
        fields.push({ label: "Decision Date", value: r.status.determination_publication_date });
      if (r.status?.end_of_determination_period)
        fields.push({ label: "Determination Deadline", value: r.status.end_of_determination_period });
      break;
    case "brazil_cases":
      if (r.process) fields.push({ label: "Process #", value: r.process });
      if (r.type_en) fields.push({ label: "Type", value: r.type_en });
      if (r.table_records?.length)
        fields.push({ label: "Documents", value: String(r.table_records.length) });
      break;
    case "canada_cases":
      if (r.industry) fields.push({ label: "Industry", value: r.industry });
      if (r.concluded_date) fields.push({ label: "Concluded", value: r.concluded_date });
      break;
    case "cci_cases":
      if (r.combination_registration_no) fields.push({ label: "Registration #", value: r.combination_registration_no });
      if (r.form) fields.push({ label: "Form", value: r.form });
      if (r.stage) fields.push({ label: "Stage", value: r.stage });
      if (r.decision_date && r.decision_date !== "None")
        fields.push({ label: "Decision Date", value: r.decision_date });
      if (r.under_section && r.under_section !== "None")
        fields.push({ label: "Under Section", value: r.under_section });
      break;
    case "ec_cases":
    case "fs_cases":
      if (r.case_number) fields.push({ label: "Case #", value: r.case_number });
      if (r.investigation_phase) fields.push({ label: "Phase", value: String(r.investigation_phase) });
      if (r.last_decision_date && r.last_decision_date !== "none")
        fields.push({ label: "Last Decision", value: r.last_decision_date });
      if (r.provisional_deadline) fields.push({ label: "Deadline", value: r.provisional_deadline });
      break;
    case "german_cases":
      if (r.file_number) fields.push({ label: "File #", value: r.file_number });
      if (r.diploma_en) fields.push({ label: "Outcome", value: r.diploma_en });
      if (r.product_area_en) fields.push({ label: "Product Area", value: r.product_area_en });
      break;
    case "nz_cases":
      if (r.case_number) fields.push({ label: "Case #", value: r.case_number });
      if (r.case_details?.Category) fields.push({ label: "Category", value: r.case_details.Category });
      if (r.case_details?.["Date closed"]) fields.push({ label: "Closed", value: r.case_details["Date closed"] });
      break;
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional":
      if (r.title_cn) fields.push({ label: "Chinese Title", value: r.title_cn });
      break;
    case "uk_cma_cases":
      if (r.case_type) fields.push({ label: "Type", value: r.case_type });
      if (r.market_sector) fields.push({ label: "Sector", value: r.market_sector });
      if (r.closed_date && r.closed_date !== "None")
        fields.push({ label: "Closed", value: r.closed_date });
      if (r.last_updated && r.last_updated !== "None")
        fields.push({ label: "Authority Update", value: r.last_updated });
      break;
    default: break;
  }
  return fields;
}

// ─── Detail panel helpers ─────────────────────────────────────────────────────

function hasDetailPanel(source: string, r: FilingRecord): boolean {
  // Extras are now on the right side — any record with extras or rich data shows the panel
  if (getExtraFields(source, r).length > 0) return true;
  switch (source) {
    case "uk_cma_cases":
      return !!(r.description || r.history?.length);
    case "accc_cases":
      return !!(r.about_the_acquisition || r.decisions_and_key_events?.length);
    case "brazil_cases":
      return !!(r.historico_records?.length || r.table_records?.length);
    case "german_cases":
      return !!(r.pursue_en || r.product_area_en);
    case "cci_cases":
      return !!(
        r.notice_under_review_url || r.section31_order_url ||
        r.section31_summary_url   || r.section43a_44_order_url ||
        r.approved_with_modification_url ||
        (r.description && r.description !== "None")
      );
    case "ec_cases":
    case "fs_cases":
      return !!(
        r.companies?.length ||
        r.economic_activities?.length ||
        r.regulation ||
        r.instrument ||
        r.case_type ||
        (Array.isArray(r.decisions) && r.decisions.length > 0) ||
        r.other_case_related_information?.length
      );
    case "nz_cases": {
      if (!r.case_details) return false;
      const shown = new Set(["Date opened", "Category", "Date closed"]);
      return Object.keys(r.case_details).some(k => !shown.has(k) && r.case_details[k]);
    }
    default: return false;
  }
}

/** Parse DD/MM/YYYY or DD/MM/YYYY HH:MM into a timestamp for sorting. */
function parseDMY(s: string | null | undefined): number {
  if (!s) return 0;
  const [datePart, timePart] = s.trim().split(" ");
  const parts = datePart.split("/");
  if (parts.length !== 3) return 0;
  const [d, m, y] = parts;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}${timePart ? "T" + timePart : ""}`;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function renderDetailPanel(source: string, r: FilingRecord): React.ReactNode {
  const sections: React.ReactNode[] = [];

  // ── CMA (UK) ───────────────────────────────────────────────────────────────
  if (source === "uk_cma_cases") {
    if (r.description) {
      sections.push(
        <div key="desc" className="ff-detail-section">
          <div className="ff-detail-section-title">Description</div>
          <p className="ff-detail-text">{r.description}</p>
        </div>
      );
    }
    if (r.history?.length) {
      const sorted = [...r.history].sort((a: any, b: any) =>
        new Date(b.datetime || b.date).getTime() - new Date(a.datetime || a.date).getTime()
      );
      sections.push(
        <div key="history" className="ff-detail-section">
          <div className="ff-detail-section-title">Case History ({r.history.length})</div>
          <div className="ff-timeline">
            {sorted.map((h: any, i: number) => (
              <div key={i} className="ff-timeline-item">
                <span className="ff-timeline-date">{h.date}</span>
                <span className="ff-timeline-note">{h.note}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  // ── ACCC (Australia) ───────────────────────────────────────────────────────
  if (source === "accc_cases") {
    const acq = r.about_the_acquisition;
    if (acq) {
      const acquirers: string[] = (acq.acquirers || []).map((p: any) => p.name).filter(Boolean);
      const targets: string[]   = (acq.targets || []).map((p: any) => p.name).filter(Boolean);
      const others: string[]    = (acq.other_parties || []).map((p: any) => p.name).filter(Boolean);
      if (acquirers.length || targets.length || others.length) {
        sections.push(
          <div key="parties" className="ff-detail-section">
            <div className="ff-detail-section-title">Parties</div>
            <div className="ff-parties-grid">
              {acquirers.length > 0 && (
                <div className="ff-parties-col">
                  <div className="ff-parties-col-label">Acquirer{acquirers.length > 1 ? "s" : ""}</div>
                  {acquirers.map((n, i) => <div key={i} className="ff-party-item">{n}</div>)}
                </div>
              )}
              {targets.length > 0 && (
                <div className="ff-parties-col">
                  <div className="ff-parties-col-label">Target{targets.length > 1 ? "s" : ""}</div>
                  {targets.map((n, i) => <div key={i} className="ff-party-item">{n}</div>)}
                </div>
              )}
              {others.length > 0 && (
                <div className="ff-parties-col">
                  <div className="ff-parties-col-label">Other Parties</div>
                  {others.map((n, i) => <div key={i} className="ff-party-item">{n}</div>)}
                </div>
              )}
            </div>
          </div>
        );
      }
      if (acq.description) {
        sections.push(
          <div key="acq-desc" className="ff-detail-section">
            <div className="ff-detail-section-title">About the Acquisition</div>
            <p className="ff-detail-text">{acq.description}</p>
          </div>
        );
      }
      if (acq.anzsic_codes) {
        const codes = String(acq.anzsic_codes)
          .split(";").map(s => s.trim()).filter(Boolean);
        if (codes.length) {
          sections.push(
            <div key="anzsic" className="ff-detail-section">
              <div className="ff-detail-section-title">ANZSIC Codes</div>
              <div className="ff-detail-list">
                {codes.map((c, i) => <div key={i} className="ff-detail-list-item">{c}</div>)}
              </div>
            </div>
          );
        }
      }
    }
    if (r.decisions_and_key_events?.length) {
      sections.push(
        <div key="events" className="ff-detail-section">
          <div className="ff-detail-section-title">Key Events ({r.decisions_and_key_events.length})</div>
          <div className="ff-timeline">
            {r.decisions_and_key_events.map((e: any, i: number) => (
              <div key={i} className="ff-timeline-item">
                <span className="ff-timeline-date">{e.date}</span>
                <span className="ff-timeline-note">
                  {e.attachment_url ? (
                    <a href={e.attachment_url} target="_blank" rel="noopener noreferrer" className="ff-doc-link">
                      {e.description}
                    </a>
                  ) : e.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  // ── CADE (Brazil) ──────────────────────────────────────────────────────────
  if (source === "brazil_cases") {
    if (r.historico_records?.length) {
      const sorted = [...r.historico_records].sort(
        (a: any, b: any) => parseDMY(b.date_time) - parseDMY(a.date_time)
      );
      sections.push(
        <div key="history" className="ff-detail-section">
          <div className="ff-detail-section-title">Case History ({r.historico_records.length})</div>
          <div className="ff-cade-table-wrap">
            <table className="ff-cade-table">
              <thead>
                <tr>
                  <th>Date / Time</th>
                  <th>Unit</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((h: any, i: number) => (
                  <tr key={i}>
                    <td className="ff-cade-td-date">{h.date_time || "—"}</td>
                    <td className="ff-cade-td-unit">{h.unit || "—"}</td>
                    <td>{h.description_en || h.description || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    if (r.table_records?.length) {
      const sortedDocs = [...r.table_records].sort(
        (a: any, b: any) => parseDMY(b.data_documento || b.data_registro) - parseDMY(a.data_documento || a.data_registro)
      );
      sections.push(
        <div key="docs" className="ff-detail-section">
          <div className="ff-detail-section-title">Documents ({r.table_records.length})</div>
          <div className="ff-cade-table-wrap">
            <table className="ff-cade-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>Doc Date</th>
                  <th>Reg Date</th>
                  <th>Unit</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {sortedDocs.map((doc: any, i: number) => (
                  <tr key={i}>
                    <td className="ff-cade-td-num">{doc.documento_processo || i + 1}</td>
                    <td>{doc.document_type || "—"}</td>
                    <td className="ff-cade-td-date">{doc.data_documento || "—"}</td>
                    <td className="ff-cade-td-date">{doc.data_registro || "—"}</td>
                    <td className="ff-cade-td-unit">{doc.unidade || "—"}</td>
                    <td>
                      {doc.document_url ? (
                        <a href={doc.document_url} target="_blank" rel="noopener noreferrer" className="ff-doc-link">
                          View ↗
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
  }

  // ── EC / Foreign Subsidies (EU) ────────────────────────────────────────────
  if (source === "ec_cases" || source === "fs_cases") {
    if (r.companies?.length) {
      sections.push(
        <div key="companies" className="ff-detail-section">
          <div className="ff-detail-section-title">Companies</div>
          <div className="ff-tags">
            {r.companies.map((c: string, i: number) => (
              <span key={i} className="ff-tag">{c}</span>
            ))}
          </div>
        </div>
      );
    }
    if (r.economic_activities?.length) {
      sections.push(
        <div key="activities" className="ff-detail-section">
          <div className="ff-detail-section-title">Economic Activities</div>
          <div className="ff-detail-list">
            {r.economic_activities.map((a: string, i: number) => (
              <div key={i} className="ff-detail-list-item">{a}</div>
            ))}
          </div>
        </div>
      );
    }
    const metaFields: { label: string; value: string }[] = [];
    if (r.regulation) metaFields.push({ label: "Regulation", value: r.regulation });
    if (r.instrument) metaFields.push({ label: "Instrument", value: r.instrument });
    if (r.case_type)  metaFields.push({ label: "Case Type",  value: r.case_type });
    if (metaFields.length) {
      sections.push(
        <div key="meta" className="ff-detail-section">
          <div className="ff-detail-section-title">Regulatory Details</div>
          <div className="ff-detail-kv">
            {metaFields.map((f, i) => (
              <div key={i} className="ff-detail-kv-row">
                <span className="ff-detail-kv-label">{f.label}</span>
                <span className="ff-detail-kv-value">{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (Array.isArray(r.decisions) && r.decisions.length > 0) {
      sections.push(
        <div key="decisions" className="ff-detail-section">
          <div className="ff-detail-section-title">Decisions ({r.decisions.length})</div>
          <div className="ff-timeline">
            {r.decisions.map((d: any, i: number) => (
              <div key={i} className="ff-timeline-item">
                <span className="ff-timeline-date">{d.decision_date || ""}</span>
                <span className="ff-timeline-note">{d.decision_type || ""}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (r.other_case_related_information?.length) {
      sections.push(
        <div key="related" className="ff-detail-section">
          <div className="ff-detail-section-title">Related Information</div>
          <div className="ff-timeline">
            {r.other_case_related_information.map((item: any, i: number) => (
              <div key={i} className="ff-timeline-item">
                <span className="ff-timeline-date">{item.date || ""}</span>
                <span className="ff-timeline-note">
                  {item.ref || ""}
                  {item.type ? <span className="ff-timeline-tag">{item.type.replace(/_/g, " ")}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  // ── CCI (India) ────────────────────────────────────────────────────────────
  if (source === "cci_cases") {
    const orders: { label: string; url: string | null; seen: any }[] = [
      { label: "Notice Under Review",         url: r.notice_under_review_url       || r.detail_urls?.notice_under_review       || null, seen: r.source_seen_at?.notice_under_review },
      { label: "Section 31 Order",            url: r.section31_order_url           || r.detail_urls?.section31_order           || null, seen: r.source_seen_at?.section31_order },
      { label: "Section 31 Summary",          url: r.section31_summary_url                                                       || null, seen: null },
      { label: "Section 43A / 44 Order",      url: r.section43a_44_order_url       || r.detail_urls?.section43a_44_order       || null, seen: r.source_seen_at?.section43a_44_order },
      { label: "Approved with Modification",  url: r.approved_with_modification_url || r.detail_urls?.approved_with_modification || null, seen: r.source_seen_at?.approved_with_modification },
    ];
    const presentOrders = orders.filter(o => o.url);
    if (presentOrders.length > 0) {
      sections.push(
        <div key="orders" className="ff-detail-section">
          <div className="ff-detail-section-title">Orders & Documents ({presentOrders.length})</div>
          <div className="ff-cade-table-wrap">
            <table className="ff-cade-table">
              <thead>
                <tr>
                  <th>Order Type</th>
                  <th>First Seen</th>
                  <th>Last Seen</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {presentOrders.map((o, i) => {
                  const first = o.seen?.first_seen_at;
                  const last  = o.seen?.last_seen_at;
                  return (
                    <tr key={i}>
                      <td>{o.label}</td>
                      <td className="ff-cade-td-date">{first ? formatToEST(first) || first : "—"}</td>
                      <td className="ff-cade-td-date">{last  ? formatToEST(last)  || last  : "—"}</td>
                      <td>
                        {o.url ? (
                          <a href={o.url} target="_blank" rel="noopener noreferrer" className="ff-doc-link">View ↗</a>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    if (r.description && r.description !== "None") {
      sections.push(
        <div key="desc" className="ff-detail-section">
          <div className="ff-detail-section-title">Description</div>
          <p className="ff-detail-text">{r.description}</p>
        </div>
      );
    }
  }

  // ── Germany (Bundeskartellamt) ────────────────────────────────────────────
  if (source === "german_cases") {
    if (r.pursue_en) {
      sections.push(
        <div key="subject" className="ff-detail-section">
          <div className="ff-detail-section-title">Subject</div>
          <p className="ff-detail-text">{r.pursue_en}</p>
          {r.pursue && r.pursue !== r.pursue_en && (
            <p className="ff-detail-text-sub">{r.pursue}</p>
          )}
        </div>
      );
    }
    if (r.product_area_en) {
      sections.push(
        <div key="products" className="ff-detail-section">
          <div className="ff-detail-section-title">Product Areas</div>
          <div className="ff-tags">
            {r.product_area_en.split(",").map((p: string) => p.trim()).filter(Boolean).map((p: string, i: number) => (
              <span key={i} className="ff-tag">{p}</span>
            ))}
          </div>
        </div>
      );
    }
  }

  // ── NZCC (New Zealand) — remaining case_details ────────────────────────────
  if (source === "nz_cases" && r.case_details) {
    const shown = new Set(["Date opened", "Category", "Date closed"]);
    const extra = Object.entries(r.case_details as Record<string, string>)
      .filter(([k, v]) => !shown.has(k) && v);
    if (extra.length) {
      sections.push(
        <div key="details" className="ff-detail-section">
          <div className="ff-detail-section-title">Additional Case Details</div>
          <div className="ff-detail-kv">
            {extra.map(([k, v], i) => (
              <div key={i} className="ff-detail-kv-row">
                <span className="ff-detail-kv-label">{k}</span>
                <span className="ff-detail-kv-value">{v}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  // ── Generic key details (extras) at the top of every panel ──────────────
  const extras = getExtraFields(source, r);
  if (extras.length > 0) {
    sections.unshift(
      <div key="extras" className="ff-detail-section">
        <div className="ff-detail-section-title">Key Details</div>
        <div className="ff-detail-kv">
          {extras.map((f, i) => (
            <div key={i} className="ff-detail-kv-row">
              <span className="ff-detail-kv-label">{f.label}</span>
              <span className="ff-detail-kv-value">{f.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (sections.length === 0) return null;
  return <div className="ff-detail-panel">{sections}</div>;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  dealId: string;
}

export default function ForeignFilingsTab({ dealId }: Props) {
  const [data, setData]                       = useState<ForeignFilingsResponse | null>(null);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [expanded, setExpanded]               = useState<Set<string>>(new Set());
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get(`/api/deals/${dealId}/foreign-filings`)
      .then(res => {
        setData(res.data);
        setExpanded(new Set(res.data.filings.map((f: FilingGroup) => f.source)));
      })
      .catch(() => setError("Failed to load foreign filings"))
      .finally(() => setLoading(false));
  }, [dealId]);

  if (loading) return <div className="ff-loading">Loading foreign filings…</div>;
  if (error)   return <div className="ff-error">{error}</div>;

  if (!data || data.filings.length === 0) {
    return (
      <div className="ff-empty">
        <div className="ff-empty-icon">🌐</div>
        <div className="ff-empty-title">No Foreign Filings</div>
        <div className="ff-empty-sub">
          No regulatory filings found for this deal across monitored jurisdictions.
        </div>
      </div>
    );
  }

  const totalRecords = data.filings.reduce((s, f) => s + f.count, 0);

  const toggleSection = (source: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(source) ? next.delete(source) : next.add(source);
      return next;
    });
  };

  const toggleRecord = (key: string) => {
    setExpandedRecords(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
    <div className="ff-container">
      <div className="ff-summary-bar">
        <span className="ff-summary-jurisdictions">
          {data.filings.length} Jurisdiction{data.filings.length !== 1 ? "s" : ""}
        </span>
        <span className="ff-summary-sep">·</span>
        <span className="ff-summary-total">
          {totalRecords} Filing{totalRecords !== 1 ? "s" : ""}
        </span>
      </div>

      {data.filings.map(group => {
        const isOpen = expanded.has(group.source);
        const flag   = FLAG[group.country] ?? "🌐";

        return (
          <div key={group.source} className="ff-section">
            <button
              className={`ff-section-header ${isOpen ? "open" : ""}`}
              onClick={() => toggleSection(group.source)}
            >
              <span className="ff-section-flag">{flag}</span>
              <span className="ff-section-label">{group.label}</span>
              <span className="ff-section-country">{group.country}</span>
              <span className="ff-section-badge">{group.count}</span>
              <span className="ff-section-chevron">{isOpen ? "▾" : "▸"}</span>
            </button>

            {isOpen && (
              <div className="ff-records">
                {group.records.map((record, idx) => {
                  const title         = getRecordTitle(group.source, record);
                  const url           = getRecordUrl(group.source, record);
                  const status        = getRecordStatus(group.source, record);
                  const registerDate  = getRegisterDate(group.source, record);
                  const registerLabel = getRegisterDateLabel(group.source);
                  const createdAt     = formatToEST(getRawCreatedAt(group.source, record));
                  const updatedAt     = formatToEST(getRawUpdatedAt(group.source, record));

                  const recordKey       = `${group.source}-${idx}`;
                  const isRecordOpen    = expandedRecords.has(recordKey);
                  const showDetailBtn   = hasDetailPanel(group.source, record);

                  const detailPanel = isRecordOpen ? renderDetailPanel(group.source, record) : null;

                  return (
                    <div key={idx} className={`ff-record ${isRecordOpen ? "expanded" : ""}`}>

                      {/* Left side — summary card (always visible) */}
                      <div className="ff-record-left">

                        {/* Title + status + external link */}
                        <div className="ff-record-header">
                          <div className="ff-record-title">
                            {url ? (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="ff-record-link">
                                {title}
                              </a>
                            ) : (
                              <span>{title}</span>
                            )}
                          </div>
                          <div className="ff-record-header-right">
                            {status && (
                              <span className={`ff-status-badge ${status.open ? "open" : "closed"}`}>
                                {status.text}
                              </span>
                            )}
                            {url && (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ff-ext-link-btn"
                                title="Open on authority website"
                                onClick={e => e.stopPropagation()}
                              >
                                ↗
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Dates row + toggle on the right */}
                        {(registerDate || createdAt || updatedAt || showDetailBtn) && (
                          <div className="ff-dates-row">
                            {registerDate && (
                              <div className="ff-date-item">
                                <span className="ff-date-label">{registerLabel}</span>
                                <span className="ff-date-value">{registerDate}</span>
                              </div>
                            )}
                            {createdAt && (
                              <div className="ff-date-item">
                                <span className="ff-date-label">First Seen</span>
                                <span className="ff-date-value">{createdAt}</span>
                              </div>
                            )}
                            {updatedAt && updatedAt !== createdAt && (
                              <div className="ff-date-item">
                                <span className="ff-date-label">Last Updated</span>
                                <span className="ff-date-value">{updatedAt}</span>
                              </div>
                            )}
                            {showDetailBtn && !isRecordOpen && (
                              <button
                                className="ff-expand-btn"
                                onClick={() => toggleRecord(recordKey)}
                              >
                                Show details ▸
                              </button>
                            )}
                          </div>
                        )}

                      </div>

                      {/* Right side — detail panel (only when expanded) */}
                      {isRecordOpen && detailPanel && (
                        <div className="ff-record-right">
                          <div className="ff-record-right-header">
                            <button
                              className="ff-expand-btn"
                              onClick={() => toggleRecord(recordKey)}
                            >
                              ◂ Hide details
                            </button>
                          </div>
                          {detailPanel}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
