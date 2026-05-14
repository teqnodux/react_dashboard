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
  "New Zealand":    "🇳🇿",
  China:            "🇨🇳",
  "United Kingdom": "🇬🇧",
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a UTC ISO string (MongoDB created_at / updated_at) to EST.
 * Returns e.g. "Apr 13, 2026, 05:09 AM EDT" or null if unparseable.
 */
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

/** Label for the source authority's own date field */
function getRegisterDateLabel(source: string): string {
  switch (source) {
    case "accc_cases":                                    return "Notification Date";
    case "brazil_cases":                                  return "Registration Date";
    case "canada_cases":                                  return "Opened Date";
    case "ec_cases":
    case "fs_cases":                                      return "Notification Date";
    case "german_cases":                                  return "Filing Date";
    case "nz_cases":                                      return "Opened Date";
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional":                            return "Filing Date";
    case "uk_cma_cases":                                  return "Opened Date";
    default:                                              return "Date";
  }
}

/** The date published/registered by the source authority */
function getRegisterDate(source: string, r: FilingRecord): string | null {
  switch (source) {
    case "accc_cases":       return r.effective_notification_date || null;
    case "brazil_cases":     return r.registration_date || null;
    case "canada_cases":     return r.opened_date || null;
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

/**
 * MongoDB created_at — when our scraper first inserted this doc.
 * samr collections store this as processed_at instead.
 */
function getRawCreatedAt(source: string, r: FilingRecord): string | null {
  if (source === "samr_cases" || source === "samr_conditional" || source === "samr_unconditional") {
    return r.processed_at || null;
  }
  return r.created_at || null;
}

/**
 * MongoDB updated_at — when our scraper last refreshed this doc.
 * samr collections don't have this field.
 */
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
    case "ec_cases":
    case "fs_cases":
      return r.status ? { text: r.status, open: r.is_open !== false } : null;
    case "german_cases":
      return r.diploma_en ? { text: r.diploma_en, open: r.is_open === true } : null;
    case "nz_cases":
      return r.status ? { text: r.status, open: r.is_open !== false } : null;
    case "samr_cases":
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
      if (r.status?.stage) fields.push({ label: "Phase", value: r.status.stage });
      if (r.status?.determination_publication_date)
        fields.push({ label: "Decision Date", value: r.status.determination_publication_date });
      break;
    case "brazil_cases":
      if (r.process) fields.push({ label: "Process #", value: r.process });
      if (r.table_records?.length)
        fields.push({ label: "Documents", value: String(r.table_records.length) });
      break;
    case "canada_cases":
      if (r.industry) fields.push({ label: "Industry", value: r.industry });
      if (r.concluded_date) fields.push({ label: "Concluded", value: r.concluded_date });
      break;
    case "ec_cases":
    case "fs_cases":
      if (r.case_number) fields.push({ label: "Case #", value: r.case_number });
      if (r.investigation_phase) fields.push({ label: "Phase", value: r.investigation_phase });
      if (r.last_decision_date) fields.push({ label: "Last Decision", value: r.last_decision_date });
      if (r.provisional_deadline) fields.push({ label: "Deadline", value: r.provisional_deadline });
      break;
    case "german_cases":
      if (r.file_number) fields.push({ label: "File #", value: r.file_number });
      if (r.product_area_en) fields.push({ label: "Product Area", value: r.product_area_en });
      break;
    case "nz_cases":
      if (r.case_number) fields.push({ label: "Case #", value: r.case_number });
      if (r.case_details?.Category) fields.push({ label: "Category", value: r.case_details.Category });
      if (r.case_details?.["Date closed"]) fields.push({ label: "Closed", value: r.case_details["Date closed"] });
      break;
    case "samr_cases":
      if (r.title_cn) fields.push({ label: "Chinese Title", value: r.title_cn });
      break;
    case "uk_cma_cases":
      if (r.case_type) fields.push({ label: "Type", value: r.case_type });
      if (r.market_sector) fields.push({ label: "Sector", value: r.market_sector });
      if (r.description)
        fields.push({ label: "Description", value: r.description.length > 200 ? r.description.slice(0, 200) + "…" : r.description });
      break;
    default: break;
  }
  return fields;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  dealId: string;
}

export default function ForeignFilingsTab({ dealId }: Props) {
  const [data, setData] = useState<ForeignFilingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
                  const extras        = getExtraFields(group.source, record);

                  const registerDate  = getRegisterDate(group.source, record);
                  const registerLabel = getRegisterDateLabel(group.source);
                  const createdAt     = formatToEST(getRawCreatedAt(group.source, record));
                  const updatedAt     = formatToEST(getRawUpdatedAt(group.source, record));

                  return (
                    <div key={idx} className="ff-record">

                      {/* Title + status badge */}
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
                        {status && (
                          <span className={`ff-status-badge ${status.open ? "open" : "closed"}`}>
                            {status.text}
                          </span>
                        )}
                      </div>

                      {/* Three dates row */}
                      {(registerDate || createdAt || updatedAt) && (
                        <div className="ff-dates-row">
                          {registerDate && (
                            <div className="ff-date-item">
                              <span className="ff-date-label">{registerLabel}</span>
                              <span className="ff-date-value">{registerDate}</span>
                            </div>
                          )}
                          {createdAt && (
                            <div className="ff-date-item">
                              <span className="ff-date-label">Received</span>
                              <span className="ff-date-value">{createdAt}</span>
                            </div>
                          )}
                          {updatedAt && updatedAt !== createdAt && (
                            <div className="ff-date-item">
                              <span className="ff-date-label">Last Updated</span>
                              <span className="ff-date-value">{updatedAt}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Extra fields */}
                      {extras.length > 0 && (
                        <div className="ff-record-extras">
                          {extras.map((f, i) => (
                            <div key={i} className="ff-extra-item">
                              <span className="ff-extra-label">{f.label}</span>
                              <span className="ff-extra-value">{f.value}</span>
                            </div>
                          ))}
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
