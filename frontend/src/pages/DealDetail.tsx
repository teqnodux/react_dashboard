import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { DealDetail as DealDetailType } from "../types/deal";
import DocketView from "../components/DocketView";
import SpreadChart from "../components/SpreadChart";
import DMATimeline from "../components/DMATimeline";
import RegulatoryTab from "../components/RegulatoryTab";
import RegulatoryMonitorTab from "../components/RegulatoryMonitorTab";
import MAEReview from "../components/MAEReview";
import DealRedditAnalysis from "../components/DealRedditAnalysis";
import TearsheetTooltip from "../components/TearsheetTooltip";
import ScorecardTab from "../components/ScorecardTab";
import MilestoneLog from "../components/MilestoneLog";
import FeedTab from "../components/FeedTab";
import MongoFeedTab from "../components/MongoFeedTab";
import DashboardNav from "../components/DashboardNav";
import {
  getFilingTypeColor,
  renderL3Detail
} from "../components/SECFilingRenderers";
import "../styles/DealDetail.css";
import "../styles/SECFilings.css";
import { API_BASE_URL } from "../config";

/** Render proxy detail section content with tables, headers, bullets, bold */
function renderProxyDetailContent(content: string): React.ReactNode {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  const formatInline = (text: string): React.ReactNode => {
    // Handle **bold** markers
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    if (parts.length === 1) return text;
    return (
      <>
        {parts.map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            p
          )
        )}
      </>
    );
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Detect table: line with tabs followed by a separator (------\t------)
    if (
      trimmed.includes("\t") &&
      i + 1 < lines.length &&
      /^-+\t/.test(lines[i + 1]?.trim())
    ) {
      const headers = trimmed.split("\t").map((h) => h.trim());
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("\t")) {
        rows.push(lines[i].split("\t").map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div key={blocks.length} className="proxy-detail-table-wrap">
          <table className="proxy-detail-table">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{formatInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Markdown headers: #### or ###
    if (trimmed.startsWith("####")) {
      blocks.push(
        <h6 key={blocks.length} className="proxy-detail-h4">
          {trimmed.replace(/^#{4}\s*/, "")}
        </h6>
      );
      i++;
      continue;
    }
    if (trimmed.startsWith("###")) {
      blocks.push(
        <h6 key={blocks.length} className="proxy-detail-h3">
          {trimmed.replace(/^#{3}\s*/, "")}
        </h6>
      );
      i++;
      continue;
    }

    // Bullet list
    if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
        // Collect continuation lines (indented, not starting with -)
        while (
          i < lines.length &&
          lines[i].startsWith("   ") &&
          !lines[i].trim().startsWith("- ")
        ) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        }
      }
      blocks.push(
        <ul key={blocks.length} className="proxy-detail-list">
          {items.map((item, ii) => (
            <li key={ii}>{formatInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list (1. 2. 3.)
    if (/^\d+\.\s/.test(trimmed)) {
      const items: { num: string; text: string }[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^(\d+)\.\s+(.*)/);
        if (m) items.push({ num: m[1], text: m[2] });
        i++;
      }
      blocks.push(
        <ol
          key={blocks.length}
          className="proxy-detail-list"
          start={parseInt(items[0]?.num || "1")}
        >
          {items.map((item, ii) => (
            <li key={ii} value={parseInt(item.num)}>
              {formatInline(item.text)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Key: Value line (word followed by colon at start)
    const kvMatch = trimmed.match(/^([A-Z][A-Za-z\s/'-]+?):\s+(.+)/);
    if (kvMatch && !trimmed.startsWith("http") && kvMatch[1].length < 50) {
      blocks.push(
        <p key={blocks.length} className="proxy-detail-kv">
          <strong>{kvMatch[1]}:</strong> {formatInline(kvMatch[2])}
        </p>
      );
      i++;
      continue;
    }

    // Regular paragraph
    blocks.push(
      <p key={blocks.length} className="proxy-detail-para">
        {formatInline(trimmed)}
      </p>
    );
    i++;
  }

  return <div className="proxy-detail-rendered">{blocks}</div>;
}

export default function DealDetail() {
  const { dealId } = useParams<{ dealId: string }>();
  const [deal, setDeal] = useState<DealDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("financial");
  const [expandedClauses, setExpandedClauses] = useState<Set<string>>(
    new Set()
  );
  const [expandedClauseTexts, setExpandedClauseTexts] = useState<Set<string>>(
    new Set()
  );
  const [dmaViewMode, setDmaViewMode] = useState<"concise" | "fulsome">(
    "concise"
  );
  const [dmaSearchQuery, setDmaSearchQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set()
  );
  const [expandedColumnGroups, setExpandedColumnGroups] = useState<Set<string>>(
    new Set()
  );
  const [liveQuotes, setLiveQuotes] = useState<any>(null);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [selectedSECFiling, setSelectedSECFiling] = useState<any>(null);
  const [secDetailView, setSecDetailView] = useState<"summary" | "full">(
    "summary"
  );
  const [secDefaultView, setSecDefaultView] = useState<"summary" | "full">(
    "summary"
  );
  const [secProcessUrl, setSecProcessUrl] = useState("");
  const [secProcessing, setSecProcessing] = useState(false);
  const [secProcessError, setSecProcessError] = useState("");
  const [secProcessSuccess, setSecProcessSuccess] = useState("");
  const [secBatchMode, setSecBatchMode] = useState(false);
  const [secBatchUrls, setSecBatchUrls] = useState("");
  const [secFilingRole, setSecFilingRole] = useState<"target" | "acquirer">(
    "target"
  );
  const [secTypeFilter, setSecTypeFilter] = useState<string>("all");
  // Proxy analysis state
  const [proxyAnalyses, setProxyAnalyses] = useState<any[]>([]);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [selectedProxy, setSelectedProxy] = useState<any>(null);
  const [proxyCollapsed, setProxyCollapsed] = useState<Set<string>>(new Set());
  const [proxyDetailLoading, setProxyDetailLoading] = useState(false);
  const [proxyDetailTab, setProxyDetailTab] = useState<string>("summary");
  const [proxyUploadOpen, setProxyUploadOpen] = useState(false);
  const [proxyUploadText, setProxyUploadText] = useState("");
  const [proxyUploading, setProxyUploading] = useState(false);
  // 10-K/10-Q analysis state
  const [tenkAnalyses, setTenkAnalyses] = useState<any[]>([]);
  const [tenkLoading, setTenkLoading] = useState(false);
  const [selectedTenk, setSelectedTenk] = useState<any>(null);
  const [tenkDetailLoading, setTenkDetailLoading] = useState(false);
  const [tenkTagFilter, setTenkTagFilter] = useState<string>("ALL");
  const [tenkViewMode, setTenkViewMode] = useState<"summary" | "detail">(
    "summary"
  );
  // Press release extraction state
  const [prText, setPrText] = useState("");
  const [prProcessing, setPrProcessing] = useState(false);
  const [prError, setPrError] = useState("");
  const [prSuccess, setPrSuccess] = useState("");
  const [prData, setPrData] = useState<any>(null);
  const [prExpanded, setPrExpanded] = useState(false);
  const [dmaExtract, setDmaExtract] = useState<any>(null);
  const [dmaSourceText, setDmaSourceText] = useState<string | null>(null);
  const [dmaExText, setDmaExText] = useState("");
  const [dmaExProcessing, setDmaExProcessing] = useState(false);
  const [dmaExError, setDmaExError] = useState("");
  const [dmaExSuccess, setDmaExSuccess] = useState("");
  const [dmaExExpanded, setDmaExExpanded] = useState(false);
  const [dmaInconsistencies, setDmaInconsistencies] = useState<any[]>([]);
  const [regData, setRegData] = useState<any>(null);
  const [dealOverrides, setDealOverrides] = useState<Record<string, any>>({});
  const [editingBorrow, setEditingBorrow] = useState(false);
  const [borrowInput, setBorrowInput] = useState("");
  const [sofrRate, setSofrRate] = useState<number | null>(null);
  const [sofrDate, setSofrDate] = useState<string>("");
  const [globalSettings, setGlobalSettings] = useState<{
    long_spread_bps: number;
    short_spread_bps: number;
  }>({ long_spread_bps: 50, short_spread_bps: 20 });
  const [longSpreadInput, setLongSpreadInput] = useState("");
  const [shortSpreadInput, setShortSpreadInput] = useState("");
  const [editingClose, setEditingClose] = useState(false);
  const [closeInput, setCloseInput] = useState("");
  const [dmaStatus, setDmaStatus] = useState<
    "idle" | "checking" | "ready" | "generating" | "error"
  >("idle");
  const [dmaError, setDmaError] = useState<string | null>(null);
  // Timeline upload state
  const [timelineText, setTimelineText] = useState("");
  const [timelineProcessing, setTimelineProcessing] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineSuccess, setTimelineSuccess] = useState("");
  const [timelineError, setTimelineError] = useState("");
  // Unified upload state
  const [uploadDocType, setUploadDocType] = useState<
    "dma_summary" | "press_release" | "proxy" | "tenk"
  >("dma_summary");
  const [uploadText, setUploadText] = useState("");
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [docSources, setDocSources] = useState<any>(null);
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  const [covenantStatus, setCovenantStatus] = useState<
    "idle" | "checking" | "ready" | "generating" | "error"
  >("idle");
  const [covenantError, setCovenantError] = useState<string | null>(null);
  const [terminationStatus, setTerminationStatus] = useState<
    "idle" | "checking" | "ready" | "generating" | "error"
  >("idle");
  const [terminationError, setTerminationError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Documents tab
  const [allDocSources, setAllDocSources] = useState<any>(null);
  const [allDocsLoading, setAllDocsLoading] = useState(false);
  const [docViewSource, setDocViewSource] = useState<{
    type: string;
    filename?: string;
  } | null>(null);
  const [docSourceText, setDocSourceText] = useState<string | null>(null);
  const [docSourceLoading, setDocSourceLoading] = useState(false);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [docPreviews, setDocPreviews] = useState<Record<string, any>>({});
  // Merger agreement URL + pipeline state
  const [mergerUrl, setMergerUrl] = useState<string>("");
  const [mergerUrlSaved, setMergerUrlSaved] = useState<string | null>(null);
  const [mergerUrlInput, setMergerUrlInput] = useState("");
  const [covenantPipelineStatus, setCovenantPipelineStatus] =
    useState<string>("idle");
  const [covenantPipelineStep, setCovenantPipelineStep] = useState<string>("");
  const [maeStatus, setMaeStatus] = useState<
    "idle" | "checking" | "ready" | "running" | "error"
  >("idle");
  const [maePipelineStep, setMaePipelineStep] = useState<string>("");
  const [maeError, setMaeError] = useState<string | null>(null);
  // MAE structured analysis (MongoDB mae_analyses)
  const [maeData, setMaeData] = useState<any>(null);
  const [maeDataLoading, setMaeDataLoading] = useState(false);
  const [maeView, setMaeView] = useState<"analysis" | "pipeline">("analysis");
  // DMA summary from MongoDB DOCX (deal_dma_summary)
  const [dmaSummary, setDmaSummary] = useState<any>(null);
  const [dmaSummaryLoading, setDmaSummaryLoading] = useState(false);
  const [terminationPipelineStatus, setTerminationPipelineStatus] =
    useState<string>("idle");
  const [terminationPipelineStep, setTerminationPipelineStep] =
    useState<string>("");
  // Checkboxes for "run on save"
  const [runMaeOnSave, setRunMaeOnSave] = useState(false);
  const [runCovenantsOnSave, setRunCovenantsOnSave] = useState(false);
  const [runTerminationOnSave, setRunTerminationOnSave] = useState(false);
  const [pipelineRunFeedback, setPipelineRunFeedback] = useState<string | null>(
    null
  );
  const [terminationSources, setTerminationSources] = useState<any[]>([]);
  const [terminationHtml, setTerminationHtml] = useState<string>("");
  const terminationIframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!dealId) return;

    fetch(`${API_BASE_URL}/api/deals/${dealId}`)
      .then((res) => res.json())
      .then((data) => {
        setDeal(data);
        setLoading(false);

        // Initialize all sections as expanded
        const sectionsToDisplay =
          data.concise_sections && data.fulsome_sections
            ? dmaViewMode === "concise"
              ? data.concise_sections
              : data.fulsome_sections
            : data.dma_sections || [];

        const allSectionIds = new Set<string>();
        sectionsToDisplay.forEach((_: any, idx: number) => {
          allSectionIds.add(`section-${idx}`);
        });
        setExpandedSections(allSectionIds);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [dealId, dmaViewMode]);

  // Fetch merger agreement URL
  useEffect(() => {
    if (!dealId) return;
    fetch(`${API_BASE_URL}/api/deals/${dealId}/merger-agreement-url`)
      .then((res) => res.json())
      .then((data) => {
        if (data.url) {
          setMergerUrlSaved(data.url);
          setMergerUrlInput(data.url);
        }
      })
      .catch(() => {});
  }, [dealId]);

  // Handle ESC key to exit full screen
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullScreen) {
        setIsFullScreen(false);
      }
    };

    if (isFullScreen) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [isFullScreen]);

  // Auto-select most recent filing when SEC tab opens
  useEffect(() => {
    if (activeTab !== "sec" || !deal?.ai_sec_filings?.length) return;
    const roleFilings = deal.ai_sec_filings.filter(
      (f: any) => f._role === secFilingRole
    );
    if (roleFilings.length > 0 && !selectedSECFiling) {
      const sorted = [...roleFilings].sort(
        (a: any, b: any) =>
          new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      setSelectedSECFiling(sorted[0]);
      setSecDetailView(secDefaultView);
    }
  }, [activeTab, deal, secFilingRole]);

  // Fetch 10-K/10-Q analyses when tab opens
  useEffect(() => {
    if (activeTab !== "10k" || !dealId || tenkAnalyses.length > 0) return;
    setTenkLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/deals/${dealId}/tenk-analysis`
        );
        const data = await res.json();
        const filings = data.filings || [];
        setTenkAnalyses(filings);
        // Auto-select first filing
        if (filings.length > 0) {
          await handleSelectTenk(filings[0]);
        }
      } catch (e) {
        console.error("[tenk] fetch error:", e);
      } finally {
        setTenkLoading(false);
      }
    })();
  }, [activeTab, dealId]);

  const buildProxyCollapsedSet = (p: any) => {
    const collapsed = new Set<string>();
    if (p?.doc_type === "changes") {
      p.sections?.forEach((s: any) => {
        if (!s.has_changes) collapsed.add(`${p.filename}-${s.name}`);
      });
    }
    // Collapse individual detail sections by default (both summary + changes)
    p?.detail_sections?.forEach((sec: any) => {
      collapsed.add(`${p.filename}-detail-${sec.number}`);
    });
    return collapsed;
  };

  const handleSelectProxy = async (f: any) => {
    if (!dealId || !f) return;
    setProxyDetailLoading(true);
    setProxyDetailTab("summary");
    try {
      // Render something immediately, then replace with the parsed result.
      setSelectedProxy(f);
      const proxyId = f.proxy_id || f._id;
      const parsedRes = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/proxy-analysis/parsed/${proxyId}`
      );
      if (!parsedRes.ok) throw new Error(await parsedRes.text());
      const parsed = await parsedRes.json();
      setSelectedProxy(parsed);
      setProxyCollapsed(buildProxyCollapsedSet(parsed));
    } finally {
      setProxyDetailLoading(false);
    }
  };

  const handleSelectTenk = async (f: any) => {
    if (!dealId || !f) return;
    setTenkDetailLoading(true);
    setTenkViewMode("summary");
    setTenkTagFilter("ALL");
    try {
      setSelectedTenk(f);
      const recordId = f._id;
      const parsedRes = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/tenk-analysis/parsed/${recordId}`
      );
      if (!parsedRes.ok) throw new Error(await parsedRes.text());
      const parsed = await parsedRes.json();
      setSelectedTenk(parsed);
    } finally {
      setTenkDetailLoading(false);
    }
  };

  // Fetch proxy analyses when proxy tab opens
  useEffect(() => {
    if (activeTab !== "proxy" || !dealId || proxyAnalyses.length > 0) return;
    setProxyLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/deals/${dealId}/proxy-analysis`
        );
        const data = await res.json();
        const filings = data.filings || [];
        setProxyAnalyses(filings);
        setSelectedProxy(filings[0] || null);
        setProxyCollapsed(new Set());
        if (filings.length > 0) {
          await handleSelectProxy(filings[0]);
        }
      } catch (e) {
        console.error("[proxy] fetch error:", e);
      } finally {
        setProxyLoading(false);
      }
    })();
  }, [activeTab, dealId]);

  // Covenants: auto-check when tab opens, auto-generate if missing
  useEffect(() => {
    if (activeTab !== "covenants" || !dealId || covenantStatus !== "idle")
      return;
    setCovenantStatus("checking");
    fetch(`${API_BASE_URL}/api/deals/${dealId}/covenants`)
      .then((res) => {
        if (res.ok) {
          setCovenantStatus("ready");
        } else if (res.status === 404) {
          setCovenantStatus("generating");
          return fetch(
            `${API_BASE_URL}/api/deals/${dealId}/covenants/generate`,
            { method: "POST" }
          )
            .then((genRes) => genRes.json())
            .then((genData) => {
              if (genData.url) {
                setCovenantStatus("ready");
              } else {
                setCovenantStatus("error");
                setCovenantError(genData.detail || "Generation failed");
              }
            });
        } else {
          setCovenantStatus("error");
          setCovenantError("Failed to check covenant status");
        }
      })
      .catch((err) => {
        setCovenantStatus("error");
        setCovenantError(err.message);
      });
  }, [activeTab, dealId, covenantStatus]);

  // Termination: auto-check when tab opens
  useEffect(() => {
    if (activeTab !== "termination" || !dealId || terminationStatus !== "idle")
      return;
    setTerminationStatus("checking");
    fetch(`${API_BASE_URL}/api/deals/${dealId}/termination`)
      .then((res) => {
        if (res.ok) {
          setTerminationStatus("ready");
        } else {
          // Check if pipeline is already running
          return fetch(
            `${API_BASE_URL}/api/deals/${dealId}/termination/pipeline-status`
          )
            .then((r) => r.json())
            .then((ps) => {
              if (ps.status === "running") {
                setTerminationStatus("error");
                setTerminationPipelineStatus("running");
                setTerminationPipelineStep(ps.step || "starting");
              } else {
                setTerminationStatus("error");
                setTerminationError(null);
              }
            });
        }
      })
      .catch((err) => {
        setTerminationStatus("error");
        setTerminationError(err.message);
      });
  }, [activeTab, dealId, terminationStatus]);

  // Pipeline polling for termination
  useEffect(() => {
    if (terminationPipelineStatus !== "running" || !dealId) return;
    const interval = setInterval(() => {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/termination/pipeline-status`)
        .then((res) => res.json())
        .then((data) => {
          setTerminationPipelineStep(data.step || "");
          if (data.status === "complete") {
            setTerminationPipelineStatus("idle");
            setTerminationStatus("idle"); // trigger re-check
          } else if (data.status === "error") {
            setTerminationPipelineStatus("error");
            setTerminationError(data.error || "Pipeline failed");
          }
        });
    }, 5000);
    return () => clearInterval(interval);
  }, [terminationPipelineStatus, dealId]);

  // Fetch termination sources + HTML when dashboard is ready
  useEffect(() => {
    if (terminationStatus !== "ready" || !dealId) return;
    fetch(`${API_BASE_URL}/api/deals/${dealId}/termination/sources`)
      .then((res) => res.json())
      .then((data) => setTerminationSources(data.sources || []))
      .catch(() => {});
    fetch(`${API_BASE_URL}/api/deals/${dealId}/termination`)
      .then((res) => res.text())
      .then((html) => setTerminationHtml(html))
      .catch(() => {});
  }, [terminationStatus, dealId]);

  // Auto-resize termination iframe to match content height
  const handleTerminationIframeLoad = useCallback(() => {
    const resize = () => {
      const iframe = terminationIframeRef.current;
      if (!iframe) return;
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          // Force layout recalc then measure
          const h = Math.max(
            doc.documentElement.scrollHeight,
            doc.body.scrollHeight,
            800
          );
          iframe.style.height = h + 40 + "px";
        }
      } catch {
        /* cross-origin fallback */
      }
    };
    // Measure immediately + after styles/fonts load
    resize();
    setTimeout(resize, 200);
    setTimeout(resize, 1000);
  }, []);

  // MAE: auto-check when tab opens
  useEffect(() => {
    if (activeTab !== "mae" || !dealId || maeStatus !== "idle") return;
    setMaeStatus("checking");
    fetch(`${API_BASE_URL}/api/deals/${dealId}/mae`)
      .then((res) => {
        if (res.ok) {
          setMaeStatus("ready");
        } else {
          setMaeStatus("error");
          setMaeError(null);
        }
      })
      .catch(() => {
        setMaeStatus("error");
        setMaeError(null);
      });
  }, [activeTab, dealId, maeStatus]);

  // MAE: fetch structured clause analysis from MongoDB when MAE tab opens
  useEffect(() => {
    if (activeTab !== "mae" || !dealId || maeData) return;
    setMaeDataLoading(true);
    fetch(`${API_BASE_URL}/api/deals/${dealId}/mae-analysis`)
      .then((res) => {
        if (!res.ok) throw new Error("No MAE data");
        return res.json();
      })
      .then((data) => {
        setMaeData(data);
        setMaeDataLoading(false);
      })
      .catch(() => setMaeDataLoading(false));
  }, [activeTab, dealId]);

  // Pipeline polling for covenants
  useEffect(() => {
    if (covenantPipelineStatus !== "running" || !dealId) return;
    const interval = setInterval(() => {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/covenants/pipeline-status`)
        .then((res) => res.json())
        .then((data) => {
          setCovenantPipelineStep(data.step || "");
          if (data.status === "complete") {
            setCovenantPipelineStatus("idle");
            setCovenantStatus("idle"); // trigger re-check
          } else if (data.status === "error") {
            setCovenantPipelineStatus("error");
            setCovenantError(data.error || "Pipeline failed");
          }
        });
    }, 5000);
    return () => clearInterval(interval);
  }, [covenantPipelineStatus, dealId]);

  // Pipeline polling for MAE
  useEffect(() => {
    if (maeStatus !== "running" || !dealId) return;
    const interval = setInterval(() => {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/mae/pipeline-status`)
        .then((res) => res.json())
        .then((data) => {
          setMaePipelineStep(data.step || "");
          if (data.status === "complete") {
            setMaeStatus("idle"); // trigger re-check
          } else if (data.status === "error") {
            setMaeStatus("error");
            setMaeError(data.error || "Pipeline failed");
          }
        });
    }, 5000);
    return () => clearInterval(interval);
  }, [maeStatus, dealId]);

  // Documents tab: fetch all sources when tab opens
  useEffect(() => {
    if (activeTab !== "documents" || !dealId) return;
    setAllDocsLoading(true);
    fetch(`${API_BASE_URL}/api/deals/${dealId}/document-sources`)
      .then((res) => res.json())
      .then((data) => {
        setAllDocSources(data);
        setAllDocsLoading(false);
      })
      .catch(() => setAllDocsLoading(false));
  }, [activeTab, dealId]);

  // DMA Timeline: auto-check when tab opens, auto-generate if missing
  useEffect(() => {
    if (activeTab !== "timeline" || !dealId || dmaStatus !== "idle") return;
    setDmaStatus("checking");
    fetch(`${API_BASE_URL}/api/deals/${dealId}/dma-timeline-data`)
      .then((res) => {
        if (res.ok) {
          setDmaStatus("ready");
        } else if (res.status === 404) {
          setDmaStatus("generating");
          return fetch(
            `${API_BASE_URL}/api/deals/${dealId}/timeline/generate`,
            { method: "POST" }
          )
            .then((genRes) => genRes.json())
            .then((genData) => {
              if (genData.url) {
                setDmaStatus("ready");
              } else {
                setDmaStatus("error");
                setDmaError(genData.detail || "Generation failed");
              }
            });
        } else {
          setDmaStatus("error");
          setDmaError("Failed to check timeline status");
        }
      })
      .catch((err) => {
        setDmaStatus("error");
        setDmaError(err.message);
      });
  }, [activeTab, dealId, dmaStatus]);

  // DMA Summary: fetch DOCX-parsed sections from MongoDB when DMA tab opens
  useEffect(() => {
    if (activeTab !== "dma" || !dealId || dmaSummary) return;
    setDmaSummaryLoading(true);
    fetch(`${API_BASE_URL}/api/deals/${dealId}/dma-summary`)
      .then((res) => {
        if (!res.ok) throw new Error("No DMA summary");
        return res.json();
      })
      .then((data) => {
        setDmaSummary(data);
        setDmaSummaryLoading(false);
        // auto-expand all sections on first load
        const ids = new Set<string>();
        const sections =
          dmaViewMode === "concise"
            ? data.concise_sections
            : data.fulsome_sections;
        (sections || []).forEach((_: any, idx: number) =>
          ids.add(`section-${idx}`)
        );
        setExpandedSections(ids);
      })
      .catch(() => setDmaSummaryLoading(false));
  }, [activeTab, dealId]);

  // Document sources: fetch when timeline tab opens
  const fetchDocSources = () => {
    if (!dealId) return;
    fetch(`${API_BASE_URL}/api/deals/${dealId}/document-sources`)
      .then((res) => res.json())
      .then((data) => setDocSources(data))
      .catch(() => {});
  };

  useEffect(() => {
    if (activeTab === "timeline" && dealId) fetchDocSources();
  }, [activeTab, dealId]);

  // Load per-deal overrides
  useEffect(() => {
    if (!dealId) return;
    fetch(`${API_BASE_URL}/api/deals/${dealId}/overrides`)
      .then((res) => res.json())
      .then((data) => setDealOverrides(data))
      .catch(() => {});
  }, [dealId]);

  // Fetch SOFR rate and global settings
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/sofr`)
      .then((res) => res.json())
      .then((data) => {
        setSofrRate(data.rate);
        setSofrDate(data.effective_date || "");
      })
      .catch(() => {});
    fetch(`${API_BASE_URL}/api/settings`)
      .then((res) => res.json())
      .then((data) =>
        setGlobalSettings({
          long_spread_bps: data.long_spread_bps ?? 50,
          short_spread_bps: data.short_spread_bps ?? 20
        })
      )
      .catch(() => {});
  }, []);

  // Load existing press release + DMA extract when financial or DMA tab opens
  const [unaffectedYf, setUnaffectedYf] = useState<{
    price: number;
    date: string;
  } | null>(null);
  useEffect(() => {
    if (!dealId) return;
    if (activeTab !== "financial" && activeTab !== "dma") return;
    if (!prData && activeTab === "financial") {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/press-release`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "ok" && data.data) setPrData(data.data.extracted);
        })
        .catch(() => {});
    }
    if (!dmaExtract) {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/dma-extract`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "ok" && data.data) {
            setDmaExtract(data.data.extracted);
            setDmaInconsistencies(data.data.inconsistencies || []);
            if (data.data.source_text) setDmaSourceText(data.data.source_text);
          }
        })
        .catch(() => {});
    }
    // Always refresh regulatory data when switching to financial tab
    if (activeTab === "financial") {
      fetch(`${API_BASE_URL}/api/deals/${dealId}/regulatory`)
        .then((res) => {
          if (!res.ok) throw new Error();
          return res.json();
        })
        .then((data) => {
          if (data && data.approvals) setRegData(data);
        })
        .catch(() => {});
    }
  }, [activeTab, dealId]);

  // Auto-fetch live quotes on first load for any deal
  useEffect(() => {
    if (!deal || !dealId || liveQuotes || quotesLoading) return;
    fetchLiveQuotes();
  }, [deal, dealId]);

  // Fetch unaffected price from yfinance when we have undisturbed date from PR
  useEffect(() => {
    if (!prData?.undisturbed_date || !deal?.target_ticker || unaffectedYf)
      return;
    fetch(
      `${API_BASE_URL}/api/stock/historical-price?ticker=${deal.target_ticker}&date_str=${prData.undisturbed_date}`
    )
      .then((res) => res.json())
      .then((data) => {
        if (data.price) setUnaffectedYf({ price: data.price, date: data.date });
      })
      .catch(() => {});
  }, [prData, deal?.target_ticker]);

  // Build 10-K/10-Q period groups from raw filings

  if (loading) {
    return (
      <div className="dashboard">
        <div className="loading">Loading deal details...</div>
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="dashboard">
        <div className="error">Error: {error || "Deal not found"}</div>
        <Link to="/pipeline" className="back-link">
          ← Back to Pipeline
        </Link>
      </div>
    );
  }

  const handleSecProcess = async () => {
    setSecProcessing(true);
    setSecProcessError("");
    setSecProcessSuccess("");
    try {
      if (secBatchMode) {
        const urls = secBatchUrls
          .split("\n")
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) {
          setSecProcessing(false);
          return;
        }
        const res = await fetch(`${API_BASE_URL}/api/sec-ai/process-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls, company_slug: null, deal_id: dealId })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const jobId = data.job_id;
        setSecBatchUrls("");
        setSecProcessSuccess(`Processing 0/${urls.length} filings...`);
        // Poll for progress
        const poll = setInterval(async () => {
          try {
            const statusRes = await fetch(
              `${API_BASE_URL}/api/sec-ai/batch-status/${jobId}`
            );
            if (!statusRes.ok) {
              clearInterval(poll);
              return;
            }
            const status = await statusRes.json();
            const errors = status.results.filter(
              (r: any) => r.status === "error"
            ).length;
            const errText = errors > 0 ? ` (${errors} failed)` : "";
            setSecProcessSuccess(
              `Processing ${status.completed}/${status.total} filings...${errText}`
            );
            if (status.done) {
              clearInterval(poll);
              setSecProcessSuccess(
                `Done: ${status.completed - errors}/${status.total} processed${errText}`
              );
              setTimeout(() => setSecProcessSuccess(""), 8000);
              setSecProcessing(false);
              // Refresh deal data
              const dealRes = await fetch(
                `${API_BASE_URL}/api/deals/${dealId}`
              );
              if (dealRes.ok) setDeal(await dealRes.json());
              refreshDependentData();
            }
          } catch {
            clearInterval(poll);
            setSecProcessing(false);
          }
        }, 3000);
      } else {
        if (!secProcessUrl.trim()) {
          setSecProcessing(false);
          return;
        }
        const res = await fetch(`${API_BASE_URL}/api/sec-ai/process`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: secProcessUrl, deal_id: dealId })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const ticker = data.result?.ticker || "";
        const headline =
          data.result?.L1_headline || data.result?.filing_type || "Filing";
        setSecProcessSuccess(`${ticker} — ${headline.slice(0, 60)}`);
        setSecProcessUrl("");
        setTimeout(() => setSecProcessSuccess(""), 5000);
        // Re-fetch deal to pick up the new AI filing
        const dealRes = await fetch(`${API_BASE_URL}/api/deals/${dealId}`);
        if (dealRes.ok) setDeal(await dealRes.json());
        refreshDependentData();
        setSecProcessing(false);
      }
    } catch (e: any) {
      setSecProcessError(e.message || "Processing failed");
      setTimeout(() => setSecProcessError(""), 8000);
      setSecProcessing(false);
    }
  };

  // Unified refresh: call after any document processing to update dependent tabs
  const refreshDependentData = () => {
    setTimelineRefreshKey((k) => k + 1);
    fetch(`${API_BASE_URL}/api/deals/${dealId}/regulatory`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (data?.approvals) setRegData(data);
      })
      .catch(() => {});
  };

  const handleSyncAll = async () => {
    if (!dealId || syncing) return;
    setSyncing(true);
    try {
      await fetch(`${API_BASE_URL}/api/deals/${dealId}/sync`, {
        method: "POST"
      });
      // Re-fetch the deal itself (picks up new concise/fulsome sections)
      const dealRes = await fetch(`${API_BASE_URL}/api/deals/${dealId}`);
      if (dealRes.ok) setDeal(await dealRes.json());
      // Refresh all data sources
      setPrData(null);
      setDmaExtract(null);
      refreshDependentData();
      // Re-fetch PR and DMA extract
      fetch(`${API_BASE_URL}/api/deals/${dealId}/press-release`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "ok" && data.data) setPrData(data.data.extracted);
        })
        .catch(() => {});
      fetch(`${API_BASE_URL}/api/deals/${dealId}/dma-extract`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "ok" && data.data) {
            setDmaExtract(data.data.extracted);
            setDmaInconsistencies(data.data.inconsistencies || []);
            if (data.data.source_text) setDmaSourceText(data.data.source_text);
          }
        })
        .catch(() => {});
    } catch {
      /* ignore */
    } finally {
      setSyncing(false);
    }
  };

  const refreshDocSources = () => {
    if (!dealId) return;
    fetch(`${API_BASE_URL}/api/deals/${dealId}/document-sources`)
      .then((res) => res.json())
      .then((data) => setAllDocSources(data))
      .catch(() => {});
  };

  const handleViewSourceText = (docType: string, filename?: string) => {
    setDocSourceLoading(true);
    setDocViewSource({ type: docType, filename });
    const url = filename
      ? `${API_BASE_URL}/api/deals/${dealId}/documents/${docType}/source-text?filename=${encodeURIComponent(filename)}`
      : `${API_BASE_URL}/api/deals/${dealId}/documents/${docType}/source-text`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        setDocSourceText(data.source_text || null);
        setDocSourceLoading(false);
      })
      .catch(() => {
        setDocSourceText(null);
        setDocSourceLoading(false);
      });
  };

  const handleDeleteDocument = async (docType: string, filename?: string) => {
    if (
      !dealId ||
      !confirm(`Delete ${docType}${filename ? ` (${filename})` : ""}?`)
    )
      return;
    const url = filename
      ? `${API_BASE_URL}/api/deals/${dealId}/documents/${docType}?filename=${encodeURIComponent(filename)}`
      : `${API_BASE_URL}/api/deals/${dealId}/documents/${docType}`;
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      refreshDocSources();
    } catch (e: any) {
      alert(e.message || "Delete failed");
    }
  };

  const toggleDocPreview = (source: string) => {
    const next = new Set(expandedDocs);
    if (next.has(source)) {
      next.delete(source);
    } else {
      next.add(source);
      if (!docPreviews[source]) {
        fetch(`${API_BASE_URL}/api/deals/${dealId}/documents/${source}/preview`)
          .then((res) => res.json())
          .then((data) =>
            setDocPreviews((prev) => ({ ...prev, [source]: data }))
          )
          .catch(() =>
            setDocPreviews((prev) => ({
              ...prev,
              [source]: {
                fields: [{ label: "Error", value: "Could not load preview" }]
              }
            }))
          );
      }
    }
    setExpandedDocs(next);
  };

  const handleProxyUpload = async () => {
    if (!dealId || !proxyUploadText.trim()) return;
    setProxyUploading(true);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `proxy_summary_${ts}.txt`;
      const res = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/proxy-analysis/upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, content: proxyUploadText })
        }
      );
      if (!res.ok) throw new Error(await res.text());
      setProxyUploadText("");
      setProxyUploadOpen(false);
      // Re-fetch proxy list
      const listRes = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/proxy-analysis`
      );
      const listData = await listRes.json();
      const allFilings = listData.filings || [];
      const filings = deal
        ? allFilings.filter(
            (f: any) => !f.ticker || f.ticker === deal.target_ticker
          )
        : allFilings;
      setProxyAnalyses(filings);
      if (filings.length > 0) setSelectedProxy(filings[filings.length - 1]);
    } catch (e: any) {
      alert(e.message || "Upload failed");
    } finally {
      setProxyUploading(false);
    }
  };

  const saveBorrowRate = async () => {
    // Legacy: single rate mode (if user types a rate directly)
    const val = parseFloat(borrowInput);
    if (isNaN(val) || !dealId) return;
    const rate = val / 100;
    try {
      await fetch(`${API_BASE_URL}/api/deals/${dealId}/overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ borrow_rate_annual: rate })
      });
      setDealOverrides((prev) => ({ ...prev, borrow_rate_annual: rate }));
      setEditingBorrow(false);
    } catch {}
  };

  const saveSpreads = async () => {
    const longVal = parseInt(longSpreadInput);
    const shortVal = parseInt(shortSpreadInput);
    if (isNaN(longVal) || isNaN(shortVal) || !dealId) return;
    try {
      await fetch(`${API_BASE_URL}/api/deals/${dealId}/overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          long_spread_bps: longVal,
          short_spread_bps: shortVal,
          borrow_rate_annual: null
        })
      });
      setDealOverrides((prev) => {
        return {
          ...prev,
          long_spread_bps: longVal,
          short_spread_bps: shortVal,
          borrow_rate_annual: undefined
        };
      });
      setEditingBorrow(false);
    } catch {}
  };

  const saveExpectedClose = async () => {
    if (!closeInput || !dealId) return;
    try {
      await fetch(`${API_BASE_URL}/api/deals/${dealId}/overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_close_date: closeInput })
      });
      setDealOverrides((prev) => ({
        ...prev,
        expected_close_date: closeInput
      }));
      setEditingClose(false);
    } catch {}
  };

  const resetExpectedClose = async () => {
    if (!dealId) return;
    try {
      await fetch(`${API_BASE_URL}/api/deals/${dealId}/overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_close_date: null })
      });
      setDealOverrides((prev) => {
        const n = { ...prev };
        delete n.expected_close_date;
        return n;
      });
      setEditingClose(false);
    } catch {}
  };

  const handleDmaExtract = async () => {
    if (!dmaExText.trim() || !dealId) return;
    setDmaExProcessing(true);
    setDmaExError("");
    setDmaExSuccess("");
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/dma-extract`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: dmaExText })
        }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDmaExtract(data.data.extracted);
      setDmaInconsistencies(data.data.inconsistencies || []);
      setDmaExSuccess("Extracted successfully");
      setDmaExText("");
      setDmaExExpanded(false);
      fetchDocSources();
      refreshDependentData();
      setTimeout(() => setDmaExSuccess(""), 5000);
    } catch (e: any) {
      setDmaExError(e.message || "Extraction failed");
      setTimeout(() => setDmaExError(""), 8000);
    }
    setDmaExProcessing(false);
  };

  const handleTimelineExtract = async () => {
    if (!timelineText.trim() || !dealId) return;
    setTimelineProcessing(true);
    setTimelineError("");
    setTimelineSuccess("");
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/timeline/generate-from-text`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: timelineText })
        }
      );
      if (!res.ok) throw new Error(await res.text());
      setTimelineSuccess("Timeline generated successfully");
      setTimelineText("");
      setTimelineExpanded(false);
      setTimelineRefreshKey((k) => k + 1); // trigger DMATimeline re-fetch
      fetchDocSources();
      setTimeout(() => setTimelineSuccess(""), 5000);
    } catch (e: any) {
      setTimelineError(e.message || "Extraction failed");
      setTimeout(() => setTimelineError(""), 8000);
    }
    setTimelineProcessing(false);
  };

  const handleUnifiedUpload = async () => {
    if (!uploadText.trim() || !dealId) return;
    setUploadProcessing(true);
    setUploadError("");
    setUploadSuccess("");
    try {
      if (uploadDocType === "dma_summary") {
        // Run both timeline generation AND financial extraction from the same text
        const [tlRes, dmaRes] = await Promise.all([
          fetch(
            `${API_BASE_URL}/api/deals/${dealId}/timeline/generate-from-text`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: uploadText })
            }
          ),
          fetch(`${API_BASE_URL}/api/deals/${dealId}/dma-extract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: uploadText })
          })
        ]);
        if (!tlRes.ok)
          throw new Error(
            "Timeline extraction failed: " + (await tlRes.text())
          );
        const dmaData = dmaRes.ok ? await dmaRes.json() : null;
        if (dmaData?.data) {
          setDmaExtract(dmaData.data.extracted);
          setDmaInconsistencies(dmaData.data.inconsistencies || []);
        }
        setTimelineRefreshKey((k) => k + 1); // trigger DMATimeline re-fetch
        setUploadSuccess(
          "DMA summary processed — timeline + financials extracted"
        );
      } else if (uploadDocType === "press_release") {
        const res = await fetch(
          `${API_BASE_URL}/api/deals/${dealId}/press-release`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: uploadText })
          }
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setPrData(data.data.extracted);
        setUploadSuccess("Press release extracted");
      } else if (uploadDocType === "proxy") {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `proxy_summary_${ts}.txt`;
        const res = await fetch(
          `${API_BASE_URL}/api/deals/${dealId}/proxy-analysis/upload`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, content: uploadText })
          }
        );
        if (!res.ok) throw new Error(await res.text());
        setUploadSuccess("Proxy analysis saved");
      } else if (uploadDocType === "tenk") {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `tenk_summary_${ts}.txt`;
        const res = await fetch(
          `${API_BASE_URL}/api/deals/${dealId}/tenk-analysis/upload`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, content: uploadText })
          }
        );
        if (!res.ok) throw new Error(await res.text());
        setUploadSuccess("10-K / 10-Q analysis saved");
      }
      setUploadText("");
      setTimelineExpanded(false);
      fetchDocSources();
      refreshDependentData();
      setTimeout(() => setUploadSuccess(""), 5000);
    } catch (e: any) {
      setUploadError(e.message || "Extraction failed");
      setTimeout(() => setUploadError(""), 8000);
    }
    setUploadProcessing(false);
  };

  const handlePressRelease = async () => {
    if (!prText.trim() || !dealId) return;
    setPrProcessing(true);
    setPrError("");
    setPrSuccess("");
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/press-release`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: prText })
        }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPrData(data.data.extracted);
      setPrSuccess("Extracted successfully");
      setPrText("");
      setPrExpanded(false);
      fetchDocSources();
      refreshDependentData();
      setTimeout(() => setPrSuccess(""), 5000);
    } catch (e: any) {
      setPrError(e.message || "Extraction failed");
      setTimeout(() => setPrError(""), 8000);
    }
    setPrProcessing(false);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return "—";
    // Parse YYYY-MM-DD as local date (not UTC) to avoid timezone shift
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const d = new Date(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2])
      );
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
    }
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  const toggleClause = (clauseId: string) => {
    const newExpanded = new Set(expandedClauses);
    if (newExpanded.has(clauseId)) {
      newExpanded.delete(clauseId);
      // Also collapse clause text when collapsing clause
      const newTexts = new Set(expandedClauseTexts);
      newTexts.delete(clauseId);
      setExpandedClauseTexts(newTexts);
    } else {
      newExpanded.add(clauseId);
    }
    setExpandedClauses(newExpanded);
  };

  const toggleClauseText = (clauseId: string) => {
    const newExpanded = new Set(expandedClauseTexts);
    if (newExpanded.has(clauseId)) {
      newExpanded.delete(clauseId);
    } else {
      newExpanded.add(clauseId);
    }
    setExpandedClauseTexts(newExpanded);
  };

  const expandAllClauses = () => {
    const sectionsToDisplay =
      deal?.concise_sections && deal?.fulsome_sections
        ? dmaViewMode === "concise"
          ? deal.concise_sections
          : deal.fulsome_sections
        : deal?.dma_sections || [];

    const allSectionIds = new Set<string>();
    sectionsToDisplay.forEach((_, idx) => {
      allSectionIds.add(`section-${idx}`);
    });
    setExpandedSections(allSectionIds);
  };

  const collapseAllClauses = () => {
    setExpandedSections(new Set());
    setExpandedClauses(new Set());
    setExpandedClauseTexts(new Set());
  };

  const toggleColumnGroup = (groupName: string) => {
    const newExpanded = new Set(expandedColumnGroups);
    if (newExpanded.has(groupName)) {
      newExpanded.delete(groupName);
    } else {
      newExpanded.add(groupName);
    }
    setExpandedColumnGroups(newExpanded);
  };

  const fetchLiveQuotes = async () => {
    if (!dealId) return;

    setQuotesLoading(true);
    setQuotesError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/deals/${dealId}/quotes`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch quotes");
      }
      const data = await response.json();
      setLiveQuotes(data);
    } catch (err) {
      setQuotesError(
        err instanceof Error ? err.message : "Failed to fetch quotes"
      );
      console.error("Error fetching quotes:", err);
    } finally {
      setQuotesLoading(false);
    }
  };

  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  const toggleSection = (sectionId: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(sectionId)) {
      newExpanded.delete(sectionId);
    } else {
      newExpanded.add(sectionId);
    }
    setExpandedSections(newExpanded);
  };

  const getSpreadClass = (pct: number, isNet: boolean = false): string => {
    const threshold = isNet ? 2 : 3;
    if (pct < threshold) return "spread-tight";
    if (pct < (isNet ? 6 : 8)) return "spread-mid";
    return "spread-wide";
  };

  const getStatusClass = (status: string): string => {
    const classes: Record<string, string> = {
      pending: "status-pending",
      regulatory_review: "status-review",
      shareholder_vote: "status-vote",
      closing: "status-closing",
      at_risk: "status-risk",
      completed: "status-completed"
    };
    return classes[status] || "status-pending";
  };

  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      pending: "Pending",
      regulatory_review: "Regulatory Review",
      shareholder_vote: "Shareholder Vote",
      closing: "Closing",
      at_risk: "At Risk",
      completed: "Completed"
    };
    return labels[status] || status;
  };

  const premium = deal.unaffected_price
    ? ((deal.offer_price - deal.unaffected_price) / deal.unaffected_price) * 100
    : 0;

  // Dynamic offer value for stock/mixed deals
  const acquirerPrice = liveQuotes?.acquirer_quote?.current_price || 0;
  const isStockDeal = deal.stock_ratio > 0;
  const stockComponentValue =
    isStockDeal && acquirerPrice ? deal.stock_ratio * acquirerPrice : 0;
  const liveOfferValue =
    isStockDeal && acquirerPrice
      ? deal.cash_per_share +
        stockComponentValue +
        deal.cvr_per_share +
        deal.special_div
      : deal.offer_price;
  const liveGrossSpread = liveOfferValue - deal.current_price;
  const liveGrossPct = deal.current_price
    ? (liveGrossSpread / deal.current_price) * 100
    : 0;

  // Expected close date: override > computed midpoint from PR guidance > deals.json
  const computedCloseDate: string | null = (() => {
    // Parse expected_close text (e.g. "2H26", "Q3 26") into midpoint date string
    const ec = prData?.expected_close;
    if (!ec) return null;
    const t = ec.toUpperCase().trim();
    const yrFull = t.match(/20\d{2}/);
    const yr2 = t.match(/(\d{2})\s*$/);
    const year = yrFull ? yrFull[0] : yr2 ? "20" + yr2[1] : null;
    if (!year) return prData?.expected_close_date || null;
    let start: Date, end: Date;
    if (/1H/.test(t) || /FIRST HALF/.test(t)) {
      start = new Date(+year, 0, 1);
      end = new Date(+year, 5, 30);
    } else if (/2H/.test(t) || /SECOND HALF/.test(t)) {
      start = new Date(+year, 6, 1);
      end = new Date(+year, 11, 31);
    } else if (/Q1/.test(t)) {
      start = new Date(+year, 0, 1);
      end = new Date(+year, 2, 31);
    } else if (/Q2/.test(t)) {
      start = new Date(+year, 3, 1);
      end = new Date(+year, 5, 30);
    } else if (/Q3/.test(t)) {
      start = new Date(+year, 6, 1);
      end = new Date(+year, 8, 30);
    } else if (/Q4/.test(t)) {
      start = new Date(+year, 9, 1);
      end = new Date(+year, 11, 31);
    } else if (/MID/.test(t)) {
      start = new Date(+year, 3, 1);
      end = new Date(+year, 7, 31);
    } else return prData?.expected_close_date || null;
    // Cap end at outside date if available (deal can't close after outside date)
    if (deal.outside_date) {
      const outsideMs = new Date(deal.outside_date + "T00:00:00").getTime();
      if (end.getTime() > outsideMs) end = new Date(outsideMs);
      if (start.getTime() > outsideMs) start = new Date(outsideMs);
    }
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    const mm = String(mid.getMonth() + 1).padStart(2, "0");
    const dd = String(mid.getDate()).padStart(2, "0");
    return `${mid.getFullYear()}-${mm}-${dd}`;
  })();

  const effectiveCloseDate =
    dealOverrides.expected_close_date ||
    computedCloseDate ||
    deal.expected_close;

  const liveDaysToClose = (() => {
    if (effectiveCloseDate) {
      const parts = effectiveCloseDate.split("-");
      const d = new Date(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2])
      );
      return Math.max(1, Math.round((d.getTime() - Date.now()) / 86400000));
    }
    return deal.days_to_close;
  })();

  // Beta-adjusted break price: unaffected × (SPY_now / SPY_at_announce)
  const spyCurrent = liveQuotes?.spy_price || 0;
  const spyAtAnnounce = deal.spy_at_announce || 0;
  const betaMultiplier =
    spyCurrent && spyAtAnnounce ? spyCurrent / spyAtAnnounce : 1;
  const breakPrice = deal.unaffected_price
    ? deal.unaffected_price * betaMultiplier
    : 0;
  const totalSpread = liveOfferValue - breakPrice;
  const ipc =
    totalSpread > 0
      ? Math.min(
          100,
          Math.max(0, ((deal.current_price - breakPrice) / totalSpread) * 100)
        )
      : 0;
  const downsidePct =
    breakPrice && deal.current_price
      ? ((breakPrice - deal.current_price) / deal.current_price) * 100
      : 0;

  // ── Cost of Funds: deal-type-aware ──
  const useLegacyBorrow = dealOverrides.borrow_rate_annual != null;
  const sofr = sofrRate ?? 0.043;
  const longSpreadBps =
    dealOverrides.long_spread_bps ?? globalSettings.long_spread_bps;
  const shortSpreadBps =
    dealOverrides.short_spread_bps ?? globalSettings.short_spread_bps;
  const longRate = sofr + longSpreadBps / 10000;
  const shortRebateRate = sofr - shortSpreadBps / 10000;
  const longValue = deal.current_price;
  const shortValue = isStockDeal ? deal.stock_ratio * (acquirerPrice || 0) : 0;
  const longCost = longValue * longRate * (liveDaysToClose / 365);
  const shortRebate = shortValue * shortRebateRate * (liveDaysToClose / 365);
  const liveBorrowCost = useLegacyBorrow
    ? deal.current_price *
      dealOverrides.borrow_rate_annual *
      (liveDaysToClose / 365)
    : longCost - shortRebate;
  const liveNetSpread =
    liveGrossSpread - liveBorrowCost + deal.dividend_expected;
  const liveNetPct = deal.current_price
    ? (liveNetSpread / deal.current_price) * 100
    : 0;
  const liveAnnualizedGross = liveDaysToClose
    ? (liveGrossPct / liveDaysToClose) * 365
    : 0;
  const liveAnnualizedNet = liveDaysToClose
    ? (liveNetPct / liveDaysToClose) * 365
    : 0;

  // Deal value: PR extraction → deals.json → live calc from shares outstanding
  const sharesOut = liveQuotes?.target_quote?.shares_outstanding;
  const liveDealValueBn =
    prData?.deal_value_bn ||
    (deal.deal_value_bn > 0 ? deal.deal_value_bn : null) ||
    (sharesOut ? (liveOfferValue * sharesOut) / 1e9 : null);

  return (
    <div className="dashboard">
      {/* Top Navigation */}
      <DashboardNav>
        {activeTab === "timeline" && dmaStatus === "ready" && (
          <button
            className="nav-refresh-btn"
            onClick={() => {
              setDmaStatus("generating");
              fetch(`${API_BASE_URL}/api/deals/${dealId}/timeline/generate`, {
                method: "POST"
              })
                .then((r) => r.json())
                .then((d) => setDmaStatus(d.url ? "ready" : "error"))
                .catch(() => setDmaStatus("error"));
            }}
          >
            ↻ Refresh Stock Data
          </button>
        )}
      </DashboardNav>

      {/* Deal Header + Tabs — sticky together */}
      <div className="sticky-header-group">
        <header className="header-compact">
          <div className="header-left">
            <div className="deal-title-row">
              <h1 className="header-title">{deal.target}</h1>
              <span className="deal-arrow">→</span>
              <span className="acquirer-name">{deal.acquirer}</span>
              <span className="ticker-badge">{deal.target_ticker}</span>
              <span className={`status-badge ${getStatusClass(deal.status)}`}>
                {getStatusLabel(deal.status)}
              </span>
              <button
                className="sync-btn"
                onClick={handleSyncAll}
                disabled={syncing}
                title="Re-sync all document sources to regulatory tracker and refresh all tabs"
              >
                {syncing ? "↻ Syncing…" : "↻ Sync"}
              </button>
            </div>
            <div className="deal-meta-row">
              <span>{deal.deal_type.toUpperCase()}</span>
              <span className="meta-divider">•</span>
              <span>
                {liveDealValueBn ? `$${liveDealValueBn.toFixed(1)}B` : "—"}
              </span>
              <span className="meta-divider">•</span>
              <span>
                Close: {formatDate(effectiveCloseDate)}
                {dealOverrides.expected_close_date ? "" : " (est)"}
              </span>
              <span className="meta-divider">•</span>
              <span>{liveDaysToClose}d remaining</span>
            </div>
          </div>

          <div className="header-metrics">
            <div className="hm">
              <span className="hm-label">Current</span>
              <span className="hm-value">${deal.current_price.toFixed(2)}</span>
            </div>
            <div className="hm">
              <span className="hm-label">Offer</span>
              <span className="hm-value">${liveOfferValue.toFixed(2)}</span>
            </div>
            <div className="hm highlight">
              <span className="hm-label">Gross</span>
              <span className="hm-value">
                ${liveGrossSpread.toFixed(2)} ({liveGrossPct.toFixed(1)}%)
              </span>
            </div>
            <div className="hm">
              <span className="hm-label">Net</span>
              <span className="hm-value">${liveNetSpread.toFixed(2)}</span>
            </div>
            <div className="hm">
              <span className="hm-label">Ann.</span>
              <span className="hm-value">{liveAnnualizedNet.toFixed(1)}%</span>
            </div>
          </div>
        </header>

        {/* Tabs */}
        <div className="tabs-nav">
          <button
            className={`tab-btn tab-ready ${activeTab === "financial" ? "active" : ""}`}
            onClick={() => setActiveTab("financial")}
          >
            Financial Overview
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "tearsheet" ? "active" : ""}`}
            onClick={() => setActiveTab("tearsheet")}
          >
            Tearsheet
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "dma" ? "active" : ""}`}
            onClick={() => setActiveTab("dma")}
          >
            DMA Summary
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "timeline" ? "active" : ""}`}
            onClick={() => setActiveTab("timeline")}
          >
            Timeline
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "sec" ? "active" : ""}`}
            onClick={() => setActiveTab("sec")}
          >
            SEC Filings
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "proxy" ? "active" : ""}`}
            onClick={() => setActiveTab("proxy")}
          >
            Proxy
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "10k" ? "active" : ""}`}
            onClick={() => setActiveTab("10k")}
          >
            10-K / 10-Q
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "mae" ? "active" : ""}`}
            onClick={() => setActiveTab("mae")}
          >
            MAE Review
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "covenants" ? "active" : ""}`}
            onClick={() => setActiveTab("covenants")}
          >
            Covenants
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "regulatory" ? "active" : ""}`}
            onClick={() => setActiveTab("regulatory")}
          >
            Regulatory
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "reg-monitor" ? "active" : ""}`}
            onClick={() => setActiveTab("reg-monitor")}
          >
            Deal Monitor
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "milestones" ? "active" : ""}`}
            onClick={() => setActiveTab("milestones")}
          >
            Milestones
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "termination" ? "active" : ""}`}
            onClick={() => setActiveTab("termination")}
          >
            Termination
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "docket" ? "active" : ""}`}
            onClick={() => setActiveTab("docket")}
          >
            Docket
          </button>
          <button
            className={`tab-btn tab-wip ${activeTab === "reddit" ? "active" : ""}`}
            onClick={() => setActiveTab("reddit")}
          >
            Reddit
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "feed" ? "active" : ""}`}
            onClick={() => setActiveTab("feed")}
          >
            Feed
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "feed-new" ? "active" : ""}`}
            onClick={() => setActiveTab("feed-new")}
          >
            Feed (New)
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "scorecard" ? "active" : ""}`}
            onClick={() => setActiveTab("scorecard")}
          >
            Deal Scorecard
          </button>
          <button
            className={`tab-btn tab-ready ${activeTab === "documents" ? "active" : ""}`}
            onClick={() => setActiveTab("documents")}
          >
            Documents
          </button>
        </div>
      </div>
      {/* end sticky-header-group */}

      <div className="tabs-container">
        {/* Tab Content */}
        <div className="tab-panel active">
          {activeTab === "tearsheet" && (
            <div
              className={`tearsheet-container ${isFullScreen ? "fullscreen" : ""}`}
            >
              <div className="tearsheet-header">
                <h2>Deal Tearsheet</h2>
                <p className="muted">
                  Comprehensive view of all deal metrics and data points
                </p>
              </div>

              <div className="tearsheet-table-wrapper">
                <table className="tearsheet-table">
                  <thead>
                    <tr>
                      {/* Target Information */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("target") ? 3 : 1}
                      >
                        <span className="group-title">Target Information</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("target")}
                        >
                          {expandedColumnGroups.has("target") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Acquirer Information */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("acquirer") ? 3 : 1}
                      >
                        <span className="group-title">
                          Acquirer Information
                        </span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("acquirer")}
                        >
                          {expandedColumnGroups.has("acquirer") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Consideration Details */}
                      <th
                        className="column-group-header"
                        colSpan={
                          expandedColumnGroups.has("consideration") ? 5 : 2
                        }
                      >
                        <span className="group-title">
                          Consideration Details
                        </span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("consideration")}
                        >
                          {expandedColumnGroups.has("consideration")
                            ? "−"
                            : "+"}
                        </button>
                      </th>

                      {/* Trading Quotes */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("trading") ? 5 : 2}
                      >
                        <span className="group-title">Trading Quotes</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("trading")}
                        >
                          {expandedColumnGroups.has("trading") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Gross Spread */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("gross") ? 3 : 2}
                      >
                        <span className="group-title">Gross Spread</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("gross")}
                        >
                          {expandedColumnGroups.has("gross") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Net Spread */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("net") ? 5 : 2}
                      >
                        <span className="group-title">Net Spread</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("net")}
                        >
                          {expandedColumnGroups.has("net") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Timing */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("timing") ? 5 : 3}
                      >
                        <span className="group-title">Timing</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("timing")}
                        >
                          {expandedColumnGroups.has("timing") ? "−" : "+"}
                        </button>
                      </th>

                      {/* Downsides */}
                      <th
                        className="column-group-header"
                        colSpan={expandedColumnGroups.has("downsides") ? 4 : 3}
                      >
                        <span className="group-title">Downsides</span>
                        <button
                          className="expand-column-btn"
                          onClick={() => toggleColumnGroup("downsides")}
                        >
                          {expandedColumnGroups.has("downsides") ? "−" : "+"}
                        </button>
                      </th>
                    </tr>

                    <tr className="column-headers">
                      {/* Target Information */}
                      <th>Target</th>
                      {expandedColumnGroups.has("target") && (
                        <>
                          <th>Shares Out (M)</th>
                          <th>Market Cap</th>
                        </>
                      )}

                      {/* Acquirer Information */}
                      <th>Acquirer</th>
                      {expandedColumnGroups.has("acquirer") && (
                        <>
                          <th>Shares Out (M)</th>
                          <th>Market Cap</th>
                        </>
                      )}

                      {/* Consideration Details */}
                      <th>Cash</th>
                      <th>Stock</th>
                      {expandedColumnGroups.has("consideration") && (
                        <>
                          <th>Per Share Value</th>
                          <th>Premium %</th>
                          <th>Total Value</th>
                        </>
                      )}

                      {/* Trading Quotes */}
                      <th>TGT</th>
                      <th>Acquirer</th>
                      {expandedColumnGroups.has("trading") && (
                        <>
                          <th>Bid</th>
                          <th>Ask</th>
                          <th>Volume</th>
                        </>
                      )}

                      {/* Gross Spread */}
                      <th>$</th>
                      <th>%</th>
                      {expandedColumnGroups.has("gross") && (
                        <>
                          <th>Annualized</th>
                        </>
                      )}

                      {/* Net Spread */}
                      <th>$</th>
                      <th>%</th>
                      {expandedColumnGroups.has("net") && (
                        <>
                          <th>Cost of Funds</th>
                          <th>Dividend</th>
                          <th>Ann. Net</th>
                        </>
                      )}

                      {/* Timing */}
                      <th>Timing Ann (%)</th>
                      <th>Close Date</th>
                      <th>Days</th>
                      {expandedColumnGroups.has("timing") && (
                        <>
                          <th>Announce Date</th>
                          <th>Outside Date</th>
                        </>
                      )}

                      {/* Downsides */}
                      <th>Unaffected</th>
                      <th>Downside</th>
                      <th>IPC</th>
                      {expandedColumnGroups.has("downsides") && (
                        <>
                          <th>Break Price</th>
                        </>
                      )}
                    </tr>
                  </thead>

                  <tbody>
                    <tr className="tearsheet-row">
                      {/* Target Information */}
                      <td className="company-name">
                        <div className="cell-primary">{deal.target}</div>
                        <div className="cell-secondary">
                          {deal.target_ticker}
                        </div>
                      </td>
                      {expandedColumnGroups.has("target") && (
                        <>
                          <td className="number-cell">
                            <span
                              className={
                                liveQuotes?.target_quote?.shares_outstanding
                                  ? "number-value"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.target_quote?.shares_outstanding
                                ? (
                                    liveQuotes.target_quote.shares_outstanding /
                                    1e6
                                  ).toFixed(1)
                                : "—"}
                            </span>
                          </td>
                          <td className="value-cell">
                            <span
                              className={
                                liveQuotes?.target_quote?.market_cap
                                  ? "value-text"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.target_quote?.market_cap
                                ? `$${(liveQuotes.target_quote.market_cap / 1e9).toFixed(1)}B`
                                : "—"}
                            </span>
                          </td>
                        </>
                      )}

                      {/* Acquirer Information */}
                      <td className="company-name">
                        <div className="cell-primary">{deal.acquirer}</div>
                        <div className="cell-secondary">
                          {deal.acquirer_ticker || "N/A"}
                        </div>
                      </td>
                      {expandedColumnGroups.has("acquirer") && (
                        <>
                          <td className="number-cell">
                            <span
                              className={
                                liveQuotes?.acquirer_quote?.shares_outstanding
                                  ? "number-value"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.acquirer_quote?.shares_outstanding
                                ? (
                                    liveQuotes.acquirer_quote
                                      .shares_outstanding / 1e6
                                  ).toFixed(1)
                                : "—"}
                            </span>
                          </td>
                          <td className="value-cell">
                            <span
                              className={
                                liveQuotes?.acquirer_quote?.market_cap
                                  ? "value-text"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.acquirer_quote?.market_cap
                                ? `$${(liveQuotes.acquirer_quote.market_cap / 1e9).toFixed(1)}B`
                                : "—"}
                            </span>
                          </td>
                        </>
                      )}

                      {/* Consideration Details - Cash, Stock */}
                      <td className="price-cell">
                        <span className="price-value">
                          {deal.cash_per_share > 0
                            ? `$${deal.cash_per_share.toFixed(2)}`
                            : deal.stock_ratio === 0
                              ? `$${deal.offer_price.toFixed(2)}`
                              : "—"}
                        </span>
                      </td>
                      <td className="price-cell">
                        <span className="price-value">
                          {deal.stock_ratio > 0 ? `${deal.stock_ratio}x` : "—"}
                        </span>
                      </td>
                      {expandedColumnGroups.has("consideration") && (
                        <>
                          <td className="price-cell">
                            <TearsheetTooltip
                              title="Consideration Details"
                              position="top"
                              content={
                                <div>
                                  <div className="tooltip-section">
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Cash / Share
                                      </span>
                                      <span className="tooltip-value">
                                        {deal.cash_per_share > 0
                                          ? `$${deal.cash_per_share.toFixed(2)}`
                                          : deal.stock_ratio === 0
                                            ? `$${deal.offer_price.toFixed(2)}`
                                            : "—"}
                                      </span>
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Stock Ratio
                                      </span>
                                      <span className="tooltip-value">
                                        {deal.stock_ratio > 0
                                          ? `${deal.stock_ratio} × ${deal.acquirer_ticker}`
                                          : "—"}
                                      </span>
                                    </div>
                                    {deal.stock_ratio > 0 &&
                                      acquirerPrice > 0 && (
                                        <div className="tooltip-row">
                                          <span className="tooltip-label">
                                            Stock Value
                                          </span>
                                          <span className="tooltip-value">
                                            ${stockComponentValue.toFixed(2)}
                                          </span>
                                        </div>
                                      )}
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">CVR</span>
                                      <span className="tooltip-value">
                                        {deal.cvr_per_share > 0
                                          ? `$${deal.cvr_per_share.toFixed(2)}`
                                          : "—"}
                                      </span>
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Special Dividend
                                      </span>
                                      <span className="tooltip-value">
                                        {deal.special_div > 0
                                          ? `$${deal.special_div.toFixed(2)}`
                                          : "—"}
                                      </span>
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Proration
                                      </span>
                                      <span className="tooltip-value">—</span>
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Collar
                                      </span>
                                      <span className="tooltip-value">—</span>
                                    </div>
                                  </div>
                                  <div className="tooltip-section">
                                    <div className="tooltip-section-title">
                                      Totals
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Per Share Value
                                      </span>
                                      <span className="tooltip-value">
                                        ${liveOfferValue.toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="tooltip-row">
                                      <span className="tooltip-label">
                                        Deal Value
                                      </span>
                                      <span className="tooltip-value">
                                        {liveDealValueBn
                                          ? `$${liveDealValueBn.toFixed(1)}B`
                                          : "—"}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              }
                            >
                              <span className="price-value">
                                ${liveOfferValue.toFixed(2)}
                              </span>
                            </TearsheetTooltip>
                          </td>
                          <td className="percent-cell">
                            <span className="percent-value">
                              {deal.unaffected_price > 0
                                ? `${(((liveOfferValue - deal.unaffected_price) / deal.unaffected_price) * 100).toFixed(1)}%`
                                : "—"}
                            </span>
                          </td>
                          <td className="value-cell">
                            <span className="value-text">
                              {liveDealValueBn
                                ? `$${liveDealValueBn.toFixed(1)}B`
                                : "—"}
                            </span>
                          </td>
                        </>
                      )}

                      {/* Trading Quotes - TGT, Acquirer */}
                      <td className="price-cell">
                        <TearsheetTooltip
                          title="Trading Details"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Target
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Target Bid
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.bid
                                      ? `$${liveQuotes.target_quote.bid.toFixed(2)}`
                                      : "—"}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Target Last
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.current_price
                                      ? `$${liveQuotes.target_quote.current_price.toFixed(2)}`
                                      : `$${deal.current_price.toFixed(2)}`}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Target Ask
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.ask
                                      ? `$${liveQuotes.target_quote.ask.toFixed(2)}`
                                      : "—"}
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Spread
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Spread Bid
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.bid
                                      ? `$${(liveOfferValue - liveQuotes.target_quote.bid).toFixed(2)}`
                                      : "—"}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Spread Last
                                  </span>
                                  <span className="tooltip-value">
                                    ${liveGrossSpread.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Spread Ask
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.ask
                                      ? `$${(liveOfferValue - liveQuotes.target_quote.ask).toFixed(2)}`
                                      : "—"}
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Volume
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Vol (mm)
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.volume &&
                                    liveQuotes?.target_quote?.current_price
                                      ? `$${((liveQuotes.target_quote.volume * liveQuotes.target_quote.current_price) / 1000000).toFixed(2)}`
                                      : "—"}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Vol (Shares)
                                  </span>
                                  <span className="tooltip-value">
                                    {liveQuotes?.target_quote?.volume
                                      ? liveQuotes.target_quote.volume.toLocaleString()
                                      : "—"}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    30 Day Volume
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                              </div>
                            </div>
                          }
                        >
                          <span className="price-value">
                            $
                            {(
                              liveQuotes?.target_quote?.current_price ||
                              deal.current_price
                            ).toFixed(2)}
                          </span>
                        </TearsheetTooltip>
                      </td>
                      <td className="price-cell">
                        <span
                          className={
                            liveQuotes?.acquirer_quote?.current_price
                              ? "price-value"
                              : "muted"
                          }
                        >
                          {liveQuotes?.acquirer_quote?.current_price
                            ? `$${liveQuotes.acquirer_quote.current_price.toFixed(2)}`
                            : "—"}
                        </span>
                      </td>
                      {expandedColumnGroups.has("trading") && (
                        <>
                          <td className="price-cell">
                            <span
                              className={
                                liveQuotes?.target_quote?.bid
                                  ? "price-value"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.target_quote?.bid
                                ? `$${liveQuotes.target_quote.bid.toFixed(2)}`
                                : "—"}
                            </span>
                          </td>
                          <td className="price-cell">
                            <span
                              className={
                                liveQuotes?.target_quote?.ask
                                  ? "price-value"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.target_quote?.ask
                                ? `$${liveQuotes.target_quote.ask.toFixed(2)}`
                                : "—"}
                            </span>
                          </td>
                          <td className="volume-cell">
                            <span
                              className={
                                liveQuotes?.target_quote?.volume
                                  ? "volume-value"
                                  : "muted"
                              }
                            >
                              {liveQuotes?.target_quote?.volume
                                ? liveQuotes.target_quote.volume.toLocaleString()
                                : "—"}
                            </span>
                          </td>
                        </>
                      )}

                      {/* Gross Spread */}
                      <td className="spread-cell">
                        <TearsheetTooltip
                          title="Gross Spread Calculation"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Calculation
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Offer Value
                                  </span>
                                  <span className="tooltip-value">
                                    ${liveOfferValue.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Current Price
                                  </span>
                                  <span className="tooltip-value">
                                    ${deal.current_price.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Gross Spread $
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    ${liveGrossSpread.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Gross Spread %
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    {liveGrossPct.toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Returns
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Days to Close
                                  </span>
                                  <span className="tooltip-value">
                                    {liveDaysToClose}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Annualized Gross
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    {liveAnnualizedGross.toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                            </div>
                          }
                        >
                          <span className="spread-dollars">
                            ${liveGrossSpread.toFixed(2)}
                          </span>
                        </TearsheetTooltip>
                      </td>
                      <td className="spread-cell">
                        <span className="spread-pct">
                          {liveGrossPct.toFixed(2)}%
                        </span>
                      </td>
                      {expandedColumnGroups.has("gross") && (
                        <>
                          <td className="spread-cell">
                            <span className="spread-pct">
                              {liveAnnualizedGross.toFixed(2)}%
                            </span>
                          </td>
                        </>
                      )}

                      {/* Net Spread */}
                      <td className="spread-cell">
                        <TearsheetTooltip
                          title="Net Spread After Costs"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Calculation
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Gross Spread
                                  </span>
                                  <span className="tooltip-value">
                                    ${liveGrossSpread.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Borrow Cost
                                  </span>
                                  <span className="tooltip-value tooltip-badge negative">
                                    -${liveBorrowCost.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Expected Dividend
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    +${deal.dividend_expected.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Net Spread $
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    ${liveNetSpread.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Net Spread %
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    {liveNetPct.toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Returns
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Days to Close
                                  </span>
                                  <span className="tooltip-value">
                                    {liveDaysToClose}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Annualized Net
                                  </span>
                                  <span className="tooltip-value tooltip-badge positive">
                                    {liveAnnualizedNet.toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Cost of Funds
                                </div>
                                <div className="tooltip-text">
                                  SOFR: {(sofr * 100).toFixed(2)}%
                                  {sofrDate && ` (${sofrDate})`}
                                </div>
                                <div className="tooltip-text">
                                  Long: SOFR + {longSpreadBps}bps ={" "}
                                  {(longRate * 100).toFixed(2)}% on $
                                  {longValue.toFixed(2)}
                                </div>
                                {isStockDeal && (
                                  <div className="tooltip-text">
                                    Short rebate: SOFR - {shortSpreadBps}bps ={" "}
                                    {(shortRebateRate * 100).toFixed(2)}% on $
                                    {shortValue.toFixed(2)}
                                  </div>
                                )}
                                <div className="tooltip-text">
                                  Net financing: ${liveBorrowCost.toFixed(2)}{" "}
                                  over {liveDaysToClose} days
                                </div>
                              </div>
                            </div>
                          }
                        >
                          <span className="spread-dollars">
                            ${liveNetSpread.toFixed(2)}
                          </span>
                        </TearsheetTooltip>
                      </td>
                      <td className="spread-cell">
                        <span className="spread-pct">
                          {liveNetPct.toFixed(2)}%
                        </span>
                      </td>
                      {expandedColumnGroups.has("net") && (
                        <>
                          <td className="cost-cell">
                            <span className="cost-value">
                              ${liveBorrowCost.toFixed(2)}
                            </span>
                          </td>
                          <td className="cost-cell">
                            <span className="cost-value">
                              ${deal.dividend_expected.toFixed(2)}
                            </span>
                          </td>
                          <td className="spread-cell">
                            <span className="spread-pct">
                              {liveAnnualizedNet.toFixed(2)}%
                            </span>
                          </td>
                        </>
                      )}

                      {/* Timing - Timing Ann (%), Close Date */}
                      <td className="spread-cell">
                        <span className="spread-pct">
                          {liveAnnualizedGross.toFixed(2)}%
                        </span>
                      </td>
                      <td className="date-cell">
                        <TearsheetTooltip
                          title="Timing Details"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Announcement Date
                                  </span>
                                  <span className="tooltip-value">
                                    {new Date(
                                      deal.announce_date
                                    ).toLocaleDateString()}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Closing Guidance
                                  </span>
                                  <span className="tooltip-value">
                                    {deal.outside_date
                                      ? new Date(
                                          deal.outside_date
                                        ).toLocaleDateString()
                                      : "—"}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Our Est. Close
                                  </span>
                                  <span className="tooltip-value">
                                    {new Date(
                                      deal.expected_close
                                    ).toLocaleDateString()}
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Regulatory Timeline
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    HSR Filed Date
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    FTC Second Request Date
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Timing Agreement Entered
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Timing Agreement Expired
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    FTC Lawsuit Filed
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Companies Response Filed
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Deadline for Depositions
                                  </span>
                                  <span className="tooltip-value">—</span>
                                </div>
                              </div>
                            </div>
                          }
                        >
                          <span className="date-text">
                            {prData?.expected_close_date
                              ? new Date(
                                  prData.expected_close_date
                                ).toLocaleDateString()
                              : new Date(
                                  deal.expected_close
                                ).toLocaleDateString()}
                          </span>
                        </TearsheetTooltip>
                      </td>
                      <td className="days-cell">
                        <span className="days-value">{liveDaysToClose}d</span>
                      </td>
                      {expandedColumnGroups.has("timing") && (
                        <>
                          <td className="date-cell">
                            <span className="date-text">
                              {new Date(
                                deal.announce_date
                              ).toLocaleDateString()}
                            </span>
                          </td>
                          <td className="date-cell">
                            <span className="date-text">
                              {deal.outside_date
                                ? new Date(
                                    deal.outside_date
                                  ).toLocaleDateString()
                                : "—"}
                            </span>
                          </td>
                        </>
                      )}

                      {/* Downsides */}
                      <td className="price-cell">
                        <span className="price-value">
                          ${deal.unaffected_price.toFixed(2)}
                        </span>
                      </td>
                      <td className="downside-cell">
                        <TearsheetTooltip
                          title="Downside to Break"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Current Price
                                  </span>
                                  <span className="tooltip-value">
                                    ${deal.current_price.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Break Price
                                  </span>
                                  <span className="tooltip-value">
                                    ${breakPrice.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    $ Downside
                                  </span>
                                  <span className="tooltip-value">
                                    $
                                    {(breakPrice - deal.current_price).toFixed(
                                      2
                                    )}
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Beta-Adjusted Break
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Undisturbed
                                  </span>
                                  <span className="tooltip-value">
                                    ${deal.unaffected_price.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    SPY Move
                                  </span>
                                  <span className="tooltip-value">
                                    {betaMultiplier !== 1
                                      ? `${((betaMultiplier - 1) * 100).toFixed(1)}%`
                                      : "—"}
                                  </span>
                                </div>
                                <div
                                  className="tooltip-text"
                                  style={{
                                    fontSize: "11px",
                                    fontStyle: "italic"
                                  }}
                                >
                                  Break = Undisturbed × (SPY now / SPY at
                                  announce)
                                </div>
                              </div>
                            </div>
                          }
                        >
                          {breakPrice > 0 ? (
                            <span
                              className={`downside-value ${downsidePct < -30 ? "high-risk" : ""}`}
                            >
                              {downsidePct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </TearsheetTooltip>
                      </td>
                      <td className="spread-cell">
                        <TearsheetTooltip
                          title="Implied Probability of Completion"
                          position="top"
                          content={
                            <div>
                              <div className="tooltip-section">
                                <div className="tooltip-row">
                                  <span className="tooltip-label">Formula</span>
                                  <span
                                    className="tooltip-value"
                                    style={{ fontSize: "10px" }}
                                  >
                                    (Current − Break) / (Offer − Break)
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Current Price
                                  </span>
                                  <span className="tooltip-value">
                                    ${deal.current_price.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Break Price
                                  </span>
                                  <span className="tooltip-value">
                                    ${breakPrice.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Offer Value
                                  </span>
                                  <span className="tooltip-value">
                                    ${liveOfferValue.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                              <div className="tooltip-section">
                                <div className="tooltip-section-title">
                                  Beta Adjustment
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    Undisturbed
                                  </span>
                                  <span className="tooltip-value">
                                    ${deal.unaffected_price.toFixed(2)}
                                  </span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">
                                    SPY Move
                                  </span>
                                  <span className="tooltip-value">
                                    {betaMultiplier !== 1
                                      ? `${((betaMultiplier - 1) * 100).toFixed(1)}%`
                                      : "—"}
                                  </span>
                                </div>
                                <div
                                  className="tooltip-text"
                                  style={{
                                    fontSize: "11px",
                                    fontStyle: "italic"
                                  }}
                                >
                                  Break = Undisturbed × (SPY now / SPY at
                                  announce). Clamped to 0–100%.
                                </div>
                              </div>
                            </div>
                          }
                        >
                          <span
                            className={`spread-pct ${ipc >= 90 ? "spread-tight" : ipc >= 70 ? "spread-mid" : "spread-wide"}`}
                          >
                            {breakPrice > 0 ? `${ipc.toFixed(1)}%` : "—"}
                          </span>
                        </TearsheetTooltip>
                      </td>
                      {expandedColumnGroups.has("downsides") && (
                        <>
                          <td className="price-cell">
                            {breakPrice > 0 ? (
                              <span className="price-value">
                                ${breakPrice.toFixed(2)}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="tearsheet-footer">
                <div className="footer-note">
                  {liveQuotes?.timestamp ? (
                    <span className="muted">
                      📊 Quotes updated:{" "}
                      {new Date(liveQuotes.timestamp).toLocaleTimeString()}
                      {liveQuotes.target_quote &&
                        ` • ${liveQuotes.target_quote.market_state}`}
                    </span>
                  ) : (
                    <span className="muted">
                      💡 Click "Refresh Quotes" to load live market data
                    </span>
                  )}
                  {quotesError && (
                    <span
                      className="error-text"
                      style={{ marginLeft: "8px", color: "var(--accent-red)" }}
                    >
                      ⚠️ {quotesError}
                    </span>
                  )}
                </div>
                <div className="footer-actions">
                  <button
                    className="tearsheet-action-btn"
                    onClick={fetchLiveQuotes}
                    disabled={quotesLoading}
                  >
                    <span>
                      {quotesLoading ? "⏳ Loading..." : "🔄 Refresh Quotes"}
                    </span>
                  </button>
                  <button
                    className="tearsheet-action-btn"
                    onClick={toggleFullScreen}
                  >
                    <span>
                      {isFullScreen ? "✕ Exit Full Screen" : "⛶ Full Screen"}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "financial" && (
            <div className="financial-overview">
              {/* Pricing Section */}
              <div className="financial-grid">
                <div className="fin-card">
                  <div className="fin-card-title">Pricing</div>
                  {isStockDeal ? (
                    <>
                      <div className="fin-row">
                        <span className="fin-label">Offer Value</span>
                        <span className="fin-value fin-has-tooltip">
                          {acquirerPrice
                            ? `$${liveOfferValue.toFixed(2)}`
                            : `$${deal.offer_price.toFixed(2)}`}
                          <span className="fin-tooltip">
                            {acquirerPrice
                              ? "Live calculated"
                              : "Static — awaiting live quote"}
                          </span>
                        </span>
                      </div>
                      {deal.cash_per_share > 0 && (
                        <div
                          className="fin-row"
                          style={{ paddingLeft: "12px" }}
                        >
                          <span
                            className="fin-label"
                            style={{
                              fontSize: "11px",
                              color: "var(--text-muted)"
                            }}
                          >
                            Cash
                          </span>
                          <span
                            className="fin-value"
                            style={{ fontSize: "11px" }}
                          >
                            ${deal.cash_per_share.toFixed(2)}
                          </span>
                        </div>
                      )}
                      <div className="fin-row" style={{ paddingLeft: "12px" }}>
                        <span
                          className="fin-label"
                          style={{
                            fontSize: "11px",
                            color: "var(--text-muted)"
                          }}
                        >
                          Stock
                        </span>
                        <span
                          className="fin-value fin-has-tooltip"
                          style={{ fontSize: "11px" }}
                        >
                          {acquirerPrice
                            ? `${deal.stock_ratio} × ${deal.acquirer_ticker} @ $${acquirerPrice.toFixed(2)} = $${stockComponentValue.toFixed(2)}`
                            : `${deal.stock_ratio} × ${deal.acquirer_ticker} (awaiting quote)`}
                          <span className="fin-tooltip">
                            Exchange ratio × acquirer live price
                          </span>
                        </span>
                      </div>
                      {deal.cvr_per_share > 0 && (
                        <div
                          className="fin-row"
                          style={{ paddingLeft: "12px" }}
                        >
                          <span
                            className="fin-label"
                            style={{
                              fontSize: "11px",
                              color: "var(--text-muted)"
                            }}
                          >
                            CVR
                          </span>
                          <span
                            className="fin-value"
                            style={{ fontSize: "11px" }}
                          >
                            ${deal.cvr_per_share.toFixed(2)}
                          </span>
                        </div>
                      )}
                      {deal.special_div > 0 && (
                        <div
                          className="fin-row"
                          style={{ paddingLeft: "12px" }}
                        >
                          <span
                            className="fin-label"
                            style={{
                              fontSize: "11px",
                              color: "var(--text-muted)"
                            }}
                          >
                            Special Div
                          </span>
                          <span
                            className="fin-value"
                            style={{ fontSize: "11px" }}
                          >
                            ${deal.special_div.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="fin-row">
                        <span className="fin-label">Offer Price</span>
                        <span className="fin-value fin-has-tooltip">
                          $
                          {prData?.offer_price_cash != null
                            ? prData.offer_price_cash.toFixed(2)
                            : deal.offer_price.toFixed(2)}
                          <span className="fin-tooltip">
                            Source:{" "}
                            {prData?.offer_price_cash != null
                              ? "Press Release"
                              : "deals.json"}
                          </span>
                        </span>
                      </div>
                      {prData?.cvr_value != null && prData.cvr_value > 0 && (
                        <div
                          className="fin-row"
                          style={{ paddingLeft: "12px" }}
                        >
                          <span
                            className="fin-label"
                            style={{
                              fontSize: "11px",
                              color: "var(--text-muted)"
                            }}
                          >
                            CVR
                          </span>
                          <span
                            className="fin-value"
                            style={{ fontSize: "11px" }}
                          >
                            up to ${prData.cvr_value.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="fin-row">
                    <span className="fin-label">Current Price</span>
                    <span className="fin-value">
                      ${deal.current_price.toFixed(2)}
                    </span>
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">Unaffected Price</span>
                    <span className="fin-value fin-has-tooltip">
                      $
                      {unaffectedYf
                        ? unaffectedYf.price.toFixed(2)
                        : deal.unaffected_price.toFixed(2)}
                      <span className="fin-tooltip">
                        {unaffectedYf
                          ? `yfinance close on ${unaffectedYf.date}`
                          : "deals.json (manual)"}
                        {prData?.undisturbed_date &&
                          ` · Undisturbed: ${prData.undisturbed_date}`}
                        {prData?.undisturbed_reference &&
                          ` · Ref: ${prData.undisturbed_reference}`}
                      </span>
                    </span>
                  </div>
                </div>

                <div className="fin-card">
                  <div className="fin-card-title">Spread</div>
                  <div className="fin-row highlight">
                    <span className="fin-label">Gross Spread</span>
                    <span
                      className={`fin-value ${liveGrossSpread >= 0 ? "positive" : "negative"}`}
                    >
                      ${liveGrossSpread.toFixed(2)} ({liveGrossPct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">
                      Cost of Funds
                      <span
                        className="fin-edit-link"
                        onClick={() => {
                          setLongSpreadInput(String(longSpreadBps));
                          setShortSpreadInput(String(shortSpreadBps));
                          setEditingBorrow(!editingBorrow);
                        }}
                      >
                        {editingBorrow ? "cancel" : "edit"}
                      </span>
                    </span>
                    {editingBorrow ? (
                      <div className="fin-spreads-edit">
                        <div className="fin-spread-row">
                          <span className="fin-spread-label">Long spread</span>
                          <input
                            type="number"
                            step="5"
                            value={longSpreadInput}
                            onChange={(e) => setLongSpreadInput(e.target.value)}
                            className="fin-inline-input"
                            style={{ width: "50px" }}
                          />
                          <span className="fin-spread-unit">bps over SOFR</span>
                        </div>
                        {isStockDeal && (
                          <div className="fin-spread-row">
                            <span className="fin-spread-label">
                              Short spread
                            </span>
                            <input
                              type="number"
                              step="5"
                              value={shortSpreadInput}
                              onChange={(e) =>
                                setShortSpreadInput(e.target.value)
                              }
                              className="fin-inline-input"
                              style={{ width: "50px" }}
                            />
                            <span className="fin-spread-unit">
                              bps under SOFR
                            </span>
                          </div>
                        )}
                        <div className="fin-spread-row">
                          <span
                            className="fin-spread-label"
                            style={{ color: "var(--text-muted)" }}
                          >
                            SOFR: {(sofr * 100).toFixed(2)}%
                            {sofrDate && ` (${sofrDate})`}
                          </span>
                          <button
                            className="fin-inline-save"
                            onClick={saveSpreads}
                          >
                            OK
                          </button>
                        </div>
                      </div>
                    ) : (
                      <span className="fin-value negative">
                        -${liveBorrowCost.toFixed(2)}{" "}
                        <span
                          style={{
                            fontSize: "10px",
                            color: "var(--text-muted)"
                          }}
                        >
                          {useLegacyBorrow
                            ? `(${(dealOverrides.borrow_rate_annual * 100).toFixed(1)}% ann.)`
                            : `(${(longRate * 100).toFixed(2)}% long${isStockDeal ? ` / ${(shortRebateRate * 100).toFixed(2)}% rebate` : ""})`}
                        </span>
                      </span>
                    )}
                  </div>
                  {isStockDeal && !editingBorrow && !useLegacyBorrow && (
                    <>
                      <div className="fin-row" style={{ paddingLeft: "12px" }}>
                        <span
                          className="fin-label"
                          style={{ fontSize: "10px" }}
                        >
                          Long Financing
                        </span>
                        <span
                          className="fin-value negative"
                          style={{ fontSize: "10px" }}
                        >
                          -${longCost.toFixed(2)}
                        </span>
                      </div>
                      <div className="fin-row" style={{ paddingLeft: "12px" }}>
                        <span
                          className="fin-label"
                          style={{ fontSize: "10px" }}
                        >
                          Short Rebate
                        </span>
                        <span
                          className="fin-value positive"
                          style={{ fontSize: "10px" }}
                        >
                          +${shortRebate.toFixed(2)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="fin-row">
                    <span className="fin-label">Expected Dividend</span>
                    <span className="fin-value positive">
                      +${deal.dividend_expected.toFixed(2)}
                    </span>
                  </div>
                  <div className="fin-row highlight">
                    <span className="fin-label">Net Spread</span>
                    <span
                      className={`fin-value ${liveNetSpread >= 0 ? "positive" : "negative"}`}
                    >
                      ${liveNetSpread.toFixed(2)} ({liveNetPct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="fin-row highlight">
                    <span className="fin-label">
                      Unlevered Annualized Return
                    </span>
                    <span
                      className={`fin-value ${liveAnnualizedNet >= 0 ? "positive" : "negative"}`}
                    >
                      {liveAnnualizedNet.toFixed(1)}%
                    </span>
                  </div>
                </div>

                <div className="fin-card">
                  <div className="fin-card-title">Key Dates</div>
                  <div className="fin-row">
                    <span className="fin-label">Announced</span>
                    <span className="fin-value">
                      {formatDate(prData?.announce_date || deal.announce_date)}
                    </span>
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">Expected Close</span>
                    <span className="fin-value">
                      {prData?.expected_close ||
                        formatDate(deal.expected_close)}
                    </span>
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">
                      Est. Close Date
                      <span
                        className="fin-edit-link"
                        onClick={() => {
                          setCloseInput(effectiveCloseDate || "");
                          setEditingClose(!editingClose);
                        }}
                      >
                        {editingClose ? "cancel" : "edit"}
                      </span>
                    </span>
                    {editingClose ? (
                      <span
                        className="fin-value"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "4px"
                        }}
                      >
                        <input
                          type="date"
                          value={closeInput}
                          onChange={(e) => setCloseInput(e.target.value)}
                          onKeyDown={(e) =>
                            e.key === "Enter" && saveExpectedClose()
                          }
                          className="fin-inline-input"
                          style={{ width: "130px", textAlign: "left" }}
                        />
                        <button
                          className="fin-inline-save"
                          onClick={saveExpectedClose}
                        >
                          OK
                        </button>
                        {dealOverrides.expected_close_date && (
                          <button
                            className="fin-inline-save"
                            style={{ background: "var(--text-muted)" }}
                            onClick={resetExpectedClose}
                          >
                            RESET
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="fin-value">
                        {formatDate(effectiveCloseDate)}
                        {dealOverrides.expected_close_date ? (
                          <span
                            style={{
                              fontSize: "9px",
                              color: "var(--accent-blue)",
                              marginLeft: "6px"
                            }}
                          >
                            EDITED
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "9px",
                              color: "var(--text-muted)",
                              marginLeft: "6px"
                            }}
                          >
                            MIDPOINT
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {deal.outside_date && (
                    <div className="fin-row">
                      <span className="fin-label">Outside Date</span>
                      <span className="fin-value">
                        {formatDate(deal.outside_date)}
                      </span>
                    </div>
                  )}
                  <div className="fin-row">
                    <span className="fin-label">Days to Close</span>
                    <span className="fin-value">
                      {dealOverrides.expected_close_date ? "" : "~"}
                      {liveDaysToClose}
                    </span>
                  </div>
                </div>

                <div className="fin-card">
                  <div className="fin-card-title">Deal Info</div>
                  <div className="fin-row">
                    <span className="fin-label">Equity Value</span>
                    {prData?.diluted_shares_mm &&
                    prData?.total_consideration ? (
                      <span className="fin-value fin-calculated fin-has-tooltip">
                        $
                        {(
                          (prData.diluted_shares_mm *
                            prData.total_consideration) /
                          1000
                        ).toFixed(1)}
                        B
                        <span className="fin-tooltip">
                          Calculated: {prData.diluted_shares_mm}M x $
                          {prData.total_consideration}/sh
                          <br />
                          Source: Press Release
                        </span>
                      </span>
                    ) : prData?.deal_value_bn &&
                      prData?.cash_on_hand_bn != null &&
                      prData?.debt_bn != null ? (
                      <span className="fin-value fin-calculated fin-has-tooltip">
                        $
                        {(
                          prData.deal_value_bn -
                          prData.debt_bn +
                          prData.cash_on_hand_bn
                        ).toFixed(1)}
                        B
                        <span className="fin-tooltip">
                          Calculated: EV ${prData.deal_value_bn}B - Debt $
                          {prData.debt_bn}B + Cash ${prData.cash_on_hand_bn}B
                          <br />
                          Source: Press Release
                        </span>
                      </span>
                    ) : prData?.deal_value_bn ? (
                      <span className="fin-value fin-has-tooltip">
                        ~${prData.deal_value_bn.toFixed(1)}B
                        <span className="fin-tooltip">
                          Enterprise Value from Press Release (equity not
                          derivable)
                        </span>
                      </span>
                    ) : (
                      <span className="fin-value">
                        {liveDealValueBn
                          ? `$${liveDealValueBn.toFixed(1)}B`
                          : "—"}
                      </span>
                    )}
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">Deal Type</span>
                    <span className="fin-value">
                      {prData?.deal_type || deal.deal_type}
                    </span>
                  </div>
                  <div className="fin-row">
                    <span className="fin-label">Premium</span>
                    <span className="fin-value positive">
                      {premium.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Notes Section removed */}

              {/* Spread Chart */}
              {deal.spread_history && deal.spread_history.length > 0 && (
                <div>
                  <SpreadChart
                    data={deal.spread_history}
                    events={deal.timeline_events}
                    announceDate={deal.announce_date}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: "4px"
                    }}
                  >
                    <button
                      className="tearsheet-action-btn"
                      onClick={async () => {
                        try {
                          const res = await fetch(
                            `${API_BASE_URL}/api/spread-snapshot`,
                            { method: "POST" }
                          );
                          const result = await res.json();
                          alert(`${result.message}`);
                          // Reload deal to get updated spread history
                          const dealRes = await fetch(
                            `${API_BASE_URL}/api/deals/${dealId}`
                          );
                          const dealData = await dealRes.json();
                          setDeal(dealData);
                        } catch (err) {
                          alert("Failed to take snapshot");
                        }
                      }}
                    >
                      <span>Snapshot Spreads</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Press Release Extraction */}
              <div
                className="fin-card"
                style={{ marginTop: "var(--space-lg)" }}
              >
                <div
                  className="fin-card-title"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  Press Release Extract
                  <button
                    className="pr-toggle-btn"
                    onClick={() => setPrExpanded(!prExpanded)}
                  >
                    {prExpanded ? "COLLAPSE" : prData ? "UPDATE" : "ADD"}
                  </button>
                  {prSuccess && (
                    <span className="sec-process-success">{prSuccess}</span>
                  )}
                  {prError && (
                    <span className="sec-process-error">{prError}</span>
                  )}
                </div>

                {prExpanded && (
                  <div className="pr-submit-box">
                    <textarea
                      placeholder="Paste the L1/L2/L3 press release summary here..."
                      value={prText}
                      onChange={(e) => setPrText(e.target.value)}
                      rows={8}
                      className="pr-textarea"
                      disabled={prProcessing}
                    />
                    <button
                      onClick={handlePressRelease}
                      disabled={prProcessing || !prText.trim()}
                      className="sec-process-btn"
                      style={{ marginTop: "6px" }}
                    >
                      {prProcessing ? "EXTRACTING..." : "EXTRACT"}
                    </button>
                  </div>
                )}

                {prData && (
                  <div className="pr-extracted-grid">
                    {prData.offer_price_cash != null && (
                      <div className="fin-row">
                        <span className="fin-label">Cash Offer</span>
                        <span className="fin-value">
                          ${prData.offer_price_cash}
                        </span>
                      </div>
                    )}
                    {prData.cvr_value != null && prData.cvr_value > 0 && (
                      <div className="fin-row">
                        <span className="fin-label">CVR</span>
                        <span className="fin-value">
                          up to ${prData.cvr_value}
                        </span>
                      </div>
                    )}
                    {prData.total_consideration != null && (
                      <div className="fin-row">
                        <span className="fin-label">Total Consideration</span>
                        <span className="fin-value">
                          ${prData.total_consideration}
                        </span>
                      </div>
                    )}
                    {prData.deal_value_bn != null &&
                      prData.deal_value_bn > 0 && (
                        <div className="fin-row">
                          <span className="fin-label">Enterprise Value</span>
                          <span className="fin-value">
                            ${prData.deal_value_bn}B
                          </span>
                        </div>
                      )}
                    {prData.deal_type && (
                      <div className="fin-row">
                        <span className="fin-label">Deal Type</span>
                        <span className="fin-value">{prData.deal_type}</span>
                      </div>
                    )}
                    {prData.premium_pct != null && (
                      <div className="fin-row">
                        <span className="fin-label">Premium</span>
                        <span className="fin-value positive">
                          {prData.premium_pct}%
                        </span>
                      </div>
                    )}
                    {prData.undisturbed_date && (
                      <div className="fin-row">
                        <span className="fin-label">Undisturbed Date</span>
                        <span className="fin-value">
                          {formatDate(prData.undisturbed_date)}
                        </span>
                      </div>
                    )}
                    {prData.expected_close && (
                      <div className="fin-row">
                        <span className="fin-label">Expected Close</span>
                        <span className="fin-value">
                          {prData.expected_close}
                        </span>
                      </div>
                    )}
                    {prData.go_shop_days != null && (
                      <div className="fin-row">
                        <span className="fin-label">Go-Shop Period</span>
                        <span className="fin-value">
                          {prData.go_shop_days} days
                        </span>
                      </div>
                    )}
                    {prData.financing && (
                      <div className="fin-row">
                        <span className="fin-label">Financing</span>
                        <span className="fin-value">{prData.financing}</span>
                      </div>
                    )}
                    {/* Regulatory — use tracker data if available, fallback to PR list */}
                    {regData &&
                    regData.approvals &&
                    regData.approvals.length > 0 ? (
                      <div
                        className="fin-row"
                        style={{ alignItems: "flex-start" }}
                      >
                        <span className="fin-label">Regulatory</span>
                        <span className="fin-value fin-value-wrap">
                          <span className="fin-reg-list">
                            {regData.approvals
                              .filter((a: any) => a.status !== "not_required")
                              .map((a: any) => {
                                const statusCls: Record<string, string> = {
                                  cleared: "fin-reg-cleared",
                                  cleared_with_conditions: "fin-reg-cleared",
                                  filed: "fin-reg-filed",
                                  under_review: "fin-reg-filed",
                                  phase2: "fin-reg-phase2",
                                  blocked: "fin-reg-blocked",
                                  pending: "fin-reg-pending",
                                  filing_intent: "fin-reg-pending"
                                };
                                const statusLabel: Record<string, string> = {
                                  cleared: "CLEARED",
                                  cleared_with_conditions: "CLEARED*",
                                  filed: "FILED",
                                  under_review: "REVIEW",
                                  phase2: "PHASE 2",
                                  blocked: "BLOCKED",
                                  pending: "PENDING",
                                  filing_intent: "INTENT"
                                };
                                return (
                                  <span
                                    key={a.id}
                                    className={`fin-reg-item ${statusCls[a.status] || "fin-reg-pending"}`}
                                  >
                                    {a.authority_short}
                                    <span className="fin-reg-status">
                                      {statusLabel[a.status] ||
                                        a.status.toUpperCase()}
                                    </span>
                                  </span>
                                );
                              })}
                          </span>
                        </span>
                      </div>
                    ) : prData.regulatory_bodies &&
                      prData.regulatory_bodies.length > 0 ? (
                      <div className="fin-row">
                        <span className="fin-label">Regulatory</span>
                        <span className="fin-value">
                          {prData.regulatory_bodies.join(" · ")}
                        </span>
                      </div>
                    ) : null}
                    {prData.special_conditions && (
                      <div className="fin-row">
                        <span className="fin-label">Special Terms</span>
                        <span className="fin-value fin-value-wrap">
                          {prData.special_conditions}
                        </span>
                      </div>
                    )}
                    {prData.dividend_info &&
                      prData.dividend_info !== "null" && (
                        <div className="fin-row">
                          <span className="fin-label">Dividend Info</span>
                          <span className="fin-value">
                            {prData.dividend_info}
                          </span>
                        </div>
                      )}
                  </div>
                )}
              </div>

              {/* DMA Summary Extraction */}
              <div
                className="fin-card"
                style={{ marginTop: "var(--space-lg)" }}
              >
                <div
                  className="fin-card-title"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  DMA Summary Extract
                  <button
                    className="pr-toggle-btn"
                    onClick={() => setDmaExExpanded(!dmaExExpanded)}
                  >
                    {dmaExExpanded ? "COLLAPSE" : dmaExtract ? "UPDATE" : "ADD"}
                  </button>
                  {dmaExSuccess && (
                    <span className="sec-process-success">{dmaExSuccess}</span>
                  )}
                  {dmaExError && (
                    <span className="sec-process-error">{dmaExError}</span>
                  )}
                </div>

                {dmaExExpanded && (
                  <div className="pr-submit-box">
                    <textarea
                      placeholder="Paste the DMA summary text here..."
                      value={dmaExText}
                      onChange={(e) => setDmaExText(e.target.value)}
                      rows={8}
                      className="pr-textarea"
                      disabled={dmaExProcessing}
                    />
                    <button
                      onClick={handleDmaExtract}
                      disabled={dmaExProcessing || !dmaExText.trim()}
                      className="sec-process-btn"
                      style={{ marginTop: "6px" }}
                    >
                      {dmaExProcessing ? "EXTRACTING..." : "EXTRACT"}
                    </button>
                  </div>
                )}

                {/* Inconsistencies */}
                {dmaInconsistencies.length > 0 && (
                  <div className="dma-inconsistencies">
                    <div className="inconsistency-header">
                      Inconsistencies vs Press Release
                    </div>
                    {dmaInconsistencies.map((inc: any, i: number) => (
                      <div key={i} className="inconsistency-row">
                        <span className="inconsistency-field">{inc.field}</span>
                        <span className="inconsistency-note">{inc.note}</span>
                      </div>
                    ))}
                  </div>
                )}

                {dmaExtract && (
                  <div className="pr-extracted-grid">
                    {dmaExtract.outside_date && (
                      <div className="fin-row">
                        <span className="fin-label">Outside Date</span>
                        <span className="fin-value">
                          {formatDate(dmaExtract.outside_date)}
                          {dmaExtract.outside_date_extension && (
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontWeight: 400
                              }}
                            >
                              {" "}
                              / {formatDate(dmaExtract.outside_date_extension)}
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {dmaExtract.outside_date_extension_condition && (
                      <div className="fin-row">
                        <span className="fin-label">Extension Condition</span>
                        <span className="fin-value fin-value-wrap">
                          {dmaExtract.outside_date_extension_condition}
                        </span>
                      </div>
                    )}
                    {dmaExtract.target_break_fee_mm != null && (
                      <div className="fin-row">
                        <span className="fin-label">Target Break Fee</span>
                        <span className="fin-value">
                          ${dmaExtract.target_break_fee_mm}M
                        </span>
                      </div>
                    )}
                    {dmaExtract.acquirer_reverse_break_fee_mm != null && (
                      <div className="fin-row">
                        <span className="fin-label">Reverse Break Fee</span>
                        <span className="fin-value">
                          ${dmaExtract.acquirer_reverse_break_fee_mm}M
                        </span>
                      </div>
                    )}
                    {dmaExtract.dividend_allowed && (
                      <div className="fin-row">
                        <span className="fin-label">Dividend Allowed</span>
                        <span className="fin-value fin-value-wrap">
                          {dmaExtract.dividend_allowed}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "dma" && (
            <div className="dma-container">
              {dmaSummaryLoading && (
                <div className="placeholder">
                  <p>Loading DMA summary from MongoDB…</p>
                </div>
              )}
              {!dmaSummaryLoading &&
              (dmaSummary?.concise_sections?.length > 0 ||
                dmaSummary?.fulsome_sections?.length > 0 ||
                (deal.concise_sections && deal.concise_sections.length > 0) ||
                (deal.fulsome_sections && deal.fulsome_sections.length > 0) ||
                (deal.dma_sections && deal.dma_sections.length > 0)) ? (
                <>
                  {/* Deal Summary Section */}
                  <div className="dma-deal-summary">
                    <div className="summary-item">
                      <span className="summary-label">Target</span>
                      <span className="summary-value">{deal.target}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Acquirer</span>
                      <span className="summary-value">{deal.acquirer}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Deal Type</span>
                      <span className="summary-value">
                        {deal.deal_type.toUpperCase()}
                      </span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Consideration</span>
                      <span className="summary-value">
                        ${deal.offer_price.toFixed(2)} per share
                      </span>
                    </div>
                  </div>

                  {/* DMA Controls */}
                  <div className="dma-controls">
                    <div className="dma-controls-left">
                      <div className="view-toggle">
                        <button
                          className={dmaViewMode === "concise" ? "active" : ""}
                          onClick={() => setDmaViewMode("concise")}
                        >
                          Concise
                        </button>
                        <button
                          className={dmaViewMode === "fulsome" ? "active" : ""}
                          onClick={() => setDmaViewMode("fulsome")}
                        >
                          Fulsome
                        </button>
                      </div>
                      <div className="expand-controls">
                        <button onClick={expandAllClauses}>Show All</button>
                        <button onClick={collapseAllClauses}>Hide All</button>
                      </div>
                    </div>
                    <div className="dma-search">
                      <input
                        type="text"
                        placeholder="Search clauses..."
                        value={dmaSearchQuery}
                        onChange={(e) => setDmaSearchQuery(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* DMA Sections */}
                  {(() => {
                    // Priority: MongoDB dmaSummary → deal static sections → legacy dma_sections
                    const sectionsToDisplay =
                      dmaSummary?.concise_sections &&
                      dmaSummary?.fulsome_sections
                        ? dmaViewMode === "concise"
                          ? dmaSummary.concise_sections
                          : dmaSummary.fulsome_sections
                        : deal.concise_sections && deal.fulsome_sections
                          ? dmaViewMode === "concise"
                            ? deal.concise_sections
                            : deal.fulsome_sections
                          : deal.dma_sections || [];

                    return sectionsToDisplay.map(
                      (section: any, sectionIdx: number) => {
                        // Filter clauses based on search
                        const filteredClauses = section.clauses.filter(
                          (clause: any) => {
                            if (!dmaSearchQuery) return true;
                            const query = dmaSearchQuery.toLowerCase();
                            const clauseText =
                              clause.text ||
                              clause.concise ||
                              clause.fulsome ||
                              clause.clause_text ||
                              "";
                            return (
                              clauseText.toLowerCase().includes(query) ||
                              section.name.toLowerCase().includes(query)
                            );
                          }
                        );

                        if (filteredClauses.length === 0) return null;

                        const sectionId = `section-${sectionIdx}`;
                        const showSectionClauses =
                          expandedSections.has(sectionId);

                        return (
                          <div key={sectionIdx} className="dma-section">
                            <h3
                              className="dma-section-title clickable"
                              onClick={() => toggleSection(sectionId)}
                            >
                              <span className="section-toggle">
                                {showSectionClauses ? "▾" : "▸"}
                              </span>
                              {section.name}
                              <span className="clause-count">
                                ({filteredClauses.length})
                              </span>
                            </h3>
                            {showSectionClauses && (
                              <div className="dma-clauses">
                                {filteredClauses.map(
                                  (clause: any, clauseIdx: number) => {
                                    const clauseId = `clause-${sectionIdx}-${clauseIdx}`;
                                    const isExpanded =
                                      expandedClauses.has(clauseId);
                                    const refs =
                                      clause.references &&
                                      clause.references.length > 0
                                        ? clause.references.join(", ")
                                        : "—";
                                    const fullText =
                                      clause.text ||
                                      clause.concise ||
                                      clause.fulsome ||
                                      "";

                                    return (
                                      <div
                                        key={clauseId}
                                        className={`dma-clause ${isExpanded ? "expanded" : ""}`}
                                      >
                                        <div
                                          className="clause-header"
                                          onClick={() => toggleClause(clauseId)}
                                        >
                                          <span className="clause-toggle">
                                            {isExpanded ? "▾" : "▸"}
                                          </span>
                                          <span className="clause-concise">
                                            {fullText}
                                          </span>
                                          <span className="clause-refs">
                                            {refs}
                                          </span>
                                        </div>

                                        {isExpanded && (
                                          <div className="clause-expanded">
                                            {clause.references &&
                                              clause.references.length > 0 && (
                                                <div className="clause-references">
                                                  <div className="layer-label">
                                                    Document References
                                                  </div>
                                                  <div className="reference-tags">
                                                    {clause.references.map(
                                                      (
                                                        ref: string,
                                                        i: number
                                                      ) => (
                                                        <span
                                                          key={i}
                                                          className="reference-tag"
                                                        >
                                                          {ref}
                                                        </span>
                                                      )
                                                    )}
                                                  </div>
                                                </div>
                                              )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  }
                                )}
                              </div>
                            )}
                          </div>
                        );
                      }
                    );
                  })()}
                </>
              ) : (
                <div className="placeholder">
                  <p>No DMA sections available for this deal</p>
                </div>
              )}
            </div>
          )}

          {activeTab === "timeline" && (
            <div className="dma-timeline-tab">
              <DMATimeline
                dealId={dealId!}
                refreshKey={timelineRefreshKey}
                onGenerateClick={() => {
                  setDmaStatus("generating");
                  fetch(
                    `${API_BASE_URL}/api/deals/${dealId}/timeline/generate`,
                    { method: "POST" }
                  )
                    .then((r) => r.json())
                    .then(() => {
                      setDmaStatus("ready");
                      refreshDependentData();
                    })
                    .catch(() => {
                      setDmaStatus("error");
                    });
                }}
                generating={dmaStatus === "generating"}
              />

              {/* Document Sources */}
              <div
                className="fin-card"
                style={{
                  marginTop: "var(--space-lg)",
                  marginBottom: "var(--space-md)"
                }}
              >
                <div className="fin-card-title">Document Sources</div>
                <div className="doc-sources-grid">
                  {docSources?.sources ? (
                    docSources.sources.map((src: any) => (
                      <div className="doc-source-row" key={src.source}>
                        <span className="doc-source-label">{src.label}</span>
                        <span
                          className={`doc-source-status ${src.status === "loaded" ? "status-loaded" : "status-missing"}`}
                        >
                          {src.status === "loaded"
                            ? src.count != null
                              ? `${src.count} filing${src.count !== 1 ? "s" : ""}`
                              : "✓ Loaded"
                            : "✗ Not loaded"}
                        </span>
                        <span className="doc-source-date">
                          {src.filing_date ? formatDate(src.filing_date) : ""}
                        </span>
                        <span className="doc-source-updated">
                          {src.extracted_at
                            ? formatDate(src.extracted_at.split("T")[0])
                            : ""}
                        </span>
                      </div>
                    ))
                  ) : (
                    <>
                      <div className="doc-source-row">
                        <span className="doc-source-label">Press Release</span>
                        <span
                          className={`doc-source-status ${prData ? "status-loaded" : "status-missing"}`}
                        >
                          {prData ? "✓ Extracted" : "✗ Not loaded"}
                        </span>
                      </div>
                      <div className="doc-source-row">
                        <span className="doc-source-label">DMA Extract</span>
                        <span
                          className={`doc-source-status ${dmaExtract ? "status-loaded" : "status-missing"}`}
                        >
                          {dmaExtract ? "✓ Extracted" : "✗ Not loaded"}
                        </span>
                      </div>
                    </>
                  )}
                  {/* SEC filings from deal data */}
                  <div className="doc-source-row">
                    <span className="doc-source-label">SEC Filings</span>
                    <span
                      className={`doc-source-status ${(deal?.ai_sec_filings?.length || 0) > 0 ? "status-loaded" : "status-missing"}`}
                    >
                      {(deal?.ai_sec_filings?.length || 0) > 0
                        ? `${deal!.ai_sec_filings!.length} filing${deal!.ai_sec_filings!.length > 1 ? "s" : ""}`
                        : "✗ None"}
                    </span>
                    <span className="doc-source-date"></span>
                    <span className="doc-source-updated"></span>
                  </div>
                </div>

                {/* Cross-Source Discrepancies */}
                {docSources?.discrepancies &&
                  docSources.discrepancies.length > 0 && (
                    <div
                      style={{
                        marginTop: "var(--space-md)",
                        paddingTop: "var(--space-sm)",
                        borderTop: "1px solid var(--border)"
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: "var(--accent-yellow)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          marginBottom: "6px",
                          fontFamily: "var(--font-mono)"
                        }}
                      >
                        Cross-Source Discrepancies
                      </div>
                      {docSources.discrepancies.map((disc: any, i: number) => (
                        <div key={i} className="discrepancy-item">
                          <span className="discrepancy-field">
                            {disc.label}
                          </span>
                          <div className="discrepancy-sources">
                            {disc.sources.map((s: any, j: number) => (
                              <span
                                key={j}
                                className={`discrepancy-source-value ${s.source === disc.most_recent ? "most-recent" : ""}`}
                              >
                                <span className="discrepancy-source-name">
                                  {s.source === "press_release"
                                    ? "PR"
                                    : s.source === "dma_extract"
                                      ? "DMA"
                                      : "TL"}
                                </span>
                                {": "}
                                {typeof s.value === "object"
                                  ? JSON.stringify(s.value)
                                  : String(s.value)}
                                {s.source === disc.most_recent && (
                                  <span className="most-recent-badge">
                                    LATEST
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>

              {/* Document Upload */}
              <div
                className="fin-card"
                style={{ marginTop: "var(--space-lg)" }}
              >
                <div
                  className="fin-card-title"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  Document Input
                  <button
                    className="pr-toggle-btn"
                    onClick={() => setTimelineExpanded(!timelineExpanded)}
                  >
                    {timelineExpanded ? "COLLAPSE" : "ADD"}
                  </button>
                  {uploadSuccess && (
                    <span className="sec-process-success">{uploadSuccess}</span>
                  )}
                  {uploadError && (
                    <span className="sec-process-error">{uploadError}</span>
                  )}
                </div>

                {timelineExpanded && (
                  <div className="pr-submit-box">
                    <div className="doc-type-selector">
                      {[
                        { key: "dma_summary" as const, label: "DMA Summary" },
                        {
                          key: "press_release" as const,
                          label: "Press Release"
                        },
                        { key: "proxy" as const, label: "Proxy" },
                        { key: "tenk" as const, label: "10-K / 10-Q" }
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          className={`doc-type-btn ${uploadDocType === opt.key ? "active" : ""}`}
                          onClick={() => setUploadDocType(opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <textarea
                      placeholder={
                        uploadDocType === "dma_summary"
                          ? "Paste the merger agreement summary here — extracts timeline dates, deadlines, and financial terms..."
                          : uploadDocType === "press_release"
                            ? "Paste the press release summary here — extracts deal terms, pricing, and expected close..."
                            : uploadDocType === "proxy"
                              ? "Paste the proxy analysis summary here..."
                              : "Paste the 10-K / 10-Q analysis summary here..."
                      }
                      value={uploadText}
                      onChange={(e) => setUploadText(e.target.value)}
                      rows={8}
                      className="pr-textarea"
                      disabled={uploadProcessing}
                    />
                    <button
                      onClick={handleUnifiedUpload}
                      disabled={uploadProcessing || !uploadText.trim()}
                      className="sec-process-btn"
                      style={{ marginTop: "6px" }}
                    >
                      {uploadProcessing
                        ? "PROCESSING..."
                        : uploadDocType === "proxy" || uploadDocType === "tenk"
                          ? "SAVE"
                          : "EXTRACT"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "proxy" && (
            <div className="sec-tab-wrapper">
              <div
                className="sec-split-wrapper"
                style={{ height: "calc(100vh - 300px)", minHeight: "400px" }}
              >
                <div className="sec-ai-split">
                  {/* Left: Feed */}
                  <div className="sec-ai-left">
                    <div className="sec-ai-feed-header">
                      <span
                        className="sec-toggle-label"
                        style={{ marginRight: "auto" }}
                      >
                        Proxy Filings
                      </span>
                    </div>
                    <div className="sec-ai-feed">
                      {proxyLoading ? (
                        <div className="sec-ai-empty">
                          Loading proxy analyses...
                        </div>
                      ) : proxyAnalyses.length === 0 ? (
                        <div className="sec-ai-empty">
                          No proxy analyses found.
                        </div>
                      ) : (
                        proxyAnalyses.map((f: any, idx: number) => {
                          const isSelected =
                            selectedProxy?.filename === f.filename;
                          return (
                            <div
                              key={f.filename}
                              className={`sec-ai-feed-item ${isSelected ? "selected" : ""}`}
                              onClick={() => handleSelectProxy(f)}
                            >
                              <div className="feed-item-top">
                                <span
                                  className="filing-type-badge"
                                  style={{
                                    backgroundColor:
                                      f.doc_type === "summary"
                                        ? "var(--accent-green)"
                                        : "var(--accent-yellow)"
                                  }}
                                >
                                  {f.filing_type}
                                </span>
                                <span
                                  className="proxy-doc-type-label"
                                  style={{
                                    fontSize: "9px",
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    color:
                                      f.doc_type === "summary"
                                        ? "var(--accent-green)"
                                        : "var(--accent-yellow)",
                                    fontFamily: "var(--font-mono)"
                                  }}
                                >
                                  {f.doc_type === "summary"
                                    ? "Summary"
                                    : "Changes"}
                                </span>
                              </div>
                              <div className="feed-item-headline">
                                {f.doc_type === "changes" && f.transition
                                  ? f.transition.slice(0, 80)
                                  : `${f.company || f.ticker} — ${f.filing_type}`}
                              </div>
                              <div className="feed-item-meta">
                                <span className="feed-item-ticker">
                                  {f.ticker}
                                </span>
                                {f.generated && (
                                  <span
                                    className="feed-item-date"
                                    style={{ fontSize: "9px" }}
                                  >
                                    {f.generated}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Right: Detail Panel */}
                  <div className="sec-ai-right">
                    {selectedProxy ? (
                      <>
                        <div className="sec-ai-detail-header">
                          <div className="sec-ai-detail-title">
                            <span
                              className="filing-type-badge"
                              style={{
                                backgroundColor:
                                  selectedProxy.doc_type === "summary"
                                    ? "var(--accent-green)"
                                    : "var(--accent-yellow)"
                              }}
                            >
                              {selectedProxy.filing_type}
                            </span>
                            <span className="detail-ticker">
                              {selectedProxy.ticker}
                            </span>
                            <span className="detail-date">
                              {selectedProxy.generated}
                            </span>
                          </div>
                        </div>

                        {selectedProxy.transition && (
                          <div className="proxy-transition-bar">
                            {selectedProxy.transition}
                          </div>
                        )}

                        {proxyDetailLoading && (
                          <div
                            className="sec-ai-empty"
                            style={{
                              margin: "12px 0",
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px"
                            }}
                          >
                            Loading proxy details...
                          </div>
                        )}

                        {/* Tab bar for summary filings with detail sections */}
                        {selectedProxy.doc_type === "summary" &&
                          selectedProxy.detail_sections?.length > 0 && (
                            <div className="proxy-tabs-bar">
                              <button
                                className={`proxy-tab-btn ${proxyDetailTab === "summary" ? "active" : ""}`}
                                onClick={() => setProxyDetailTab("summary")}
                              >
                                Summary
                              </button>
                              {selectedProxy.detail_sections.map((sec: any) => (
                                <button
                                  key={sec.number}
                                  className={`proxy-tab-btn ${proxyDetailTab === `detail-${sec.number}` ? "active" : ""}`}
                                  onClick={() =>
                                    setProxyDetailTab(`detail-${sec.number}`)
                                  }
                                >
                                  {sec.title}
                                </button>
                              ))}
                            </div>
                          )}

                        <div
                          className="sec-ai-detail-content"
                          style={{ padding: "16px 20px" }}
                        >
                          {/* ── SUMMARY (Initial Filing) ── */}
                          {selectedProxy.doc_type === "summary" && (
                            <>
                              {/* Summary tab: Q&A + Background */}
                              {proxyDetailTab === "summary" && (
                                <>
                                  {selectedProxy.qa_items?.length > 0 ? (
                                    <div className="proxy-qa-block">
                                      {selectedProxy.qa_items.map(
                                        (qa: any, i: number) => (
                                          <div
                                            key={i}
                                            className="proxy-qa-item"
                                          >
                                            <div className="proxy-qa-question">
                                              {qa.question}
                                            </div>
                                            <div className="proxy-qa-answer">
                                              {qa.answer}
                                            </div>
                                          </div>
                                        )
                                      )}
                                    </div>
                                  ) : (
                                    <div
                                      style={{
                                        padding: "20px 0",
                                        color: "var(--text-muted)",
                                        fontFamily: "var(--font-mono)",
                                        fontSize: "11px"
                                      }}
                                    >
                                      No proxy summary Q&A available for this
                                      filing.
                                    </div>
                                  )}

                                  {selectedProxy.background && (
                                    <div className="proxy-background-block">
                                      <h5 className="l3-label">
                                        MERGER BACKGROUND ANALYSIS
                                      </h5>
                                      {selectedProxy.background
                                        .chronological_summary && (
                                        <p className="proxy-bg-summary">
                                          {
                                            selectedProxy.background
                                              .chronological_summary
                                          }
                                        </p>
                                      )}
                                      {selectedProxy.background.items?.length >
                                        0 && (
                                        <ol className="proxy-bg-items">
                                          {selectedProxy.background.items.map(
                                            (item: any, i: number) => (
                                              <li
                                                key={i}
                                                value={item.number}
                                                className="proxy-bg-item"
                                              >
                                                {item.text}
                                              </li>
                                            )
                                          )}
                                        </ol>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}

                              {/* Detail section tabs */}
                              {selectedProxy.detail_sections?.map(
                                (sec: any) =>
                                  proxyDetailTab === `detail-${sec.number}` && (
                                    <div
                                      key={sec.number}
                                      className="proxy-detail-tab-content"
                                    >
                                      {renderProxyDetailContent(sec.content)}
                                    </div>
                                  )
                              )}
                            </>
                          )}

                          {/* ── CHANGES (Subsequent Filing): Section diffs ── */}
                          {selectedProxy.doc_type === "changes" && (
                            <>
                              {/* Per-section changes */}
                              {selectedProxy.sections?.map(
                                (section: any, si: number) => {
                                  const collapseKey = `${selectedProxy.filename}-${section.name}`;
                                  const isCollapsed =
                                    proxyCollapsed.has(collapseKey);
                                  return (
                                    <div
                                      key={si}
                                      className={`proxy-analysis-section ${!section.has_changes ? "no-changes" : ""}`}
                                    >
                                      <div
                                        className="proxy-section-header"
                                        onClick={() => {
                                          const next = new Set(proxyCollapsed);
                                          isCollapsed
                                            ? next.delete(collapseKey)
                                            : next.add(collapseKey);
                                          setProxyCollapsed(next);
                                        }}
                                      >
                                        <h5
                                          className="l3-label"
                                          style={{
                                            margin: 0,
                                            cursor: "pointer"
                                          }}
                                        >
                                          <span
                                            style={{
                                              marginRight: "6px",
                                              fontSize: "8px"
                                            }}
                                          >
                                            {isCollapsed ? "▶" : "▼"}
                                          </span>
                                          {section.name}
                                          {!section.has_changes && (
                                            <span className="proxy-no-changes-tag">
                                              No changes
                                            </span>
                                          )}
                                        </h5>
                                      </div>
                                      {!isCollapsed && section.has_changes && (
                                        <div className="proxy-section-body">
                                          {section.raw_text &&
                                          !section.items?.length ? (
                                            <p className="l3-text">
                                              {section.raw_text}
                                            </p>
                                          ) : (
                                            section.items?.map(
                                              (item: any, ii: number) => (
                                                <div
                                                  key={ii}
                                                  className="proxy-change-item"
                                                >
                                                  <div className="proxy-item-header">
                                                    {item.label && (
                                                      <span className="proxy-item-label">
                                                        {item.label}
                                                      </span>
                                                    )}
                                                    {item.tag && (
                                                      <span className="proxy-new-tag">
                                                        {item.tag}
                                                      </span>
                                                    )}
                                                  </div>
                                                  {item.value && (
                                                    <div className="proxy-item-value">
                                                      {item.value}
                                                    </div>
                                                  )}
                                                  {item.was && (
                                                    <div className="proxy-was-now">
                                                      <div className="proxy-was">
                                                        <span>Was:</span>{" "}
                                                        {item.was}
                                                      </div>
                                                      <div className="proxy-now">
                                                        <span>Now:</span>{" "}
                                                        {item.now}
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              )
                                            )
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                }
                              )}
                            </>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="sec-ai-no-selection">
                        <div className="sec-ai-no-selection-msg">
                          <div className="no-sel-icon">PROXY</div>
                          <p>Select a filing to view details</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "sec" && (
            <div className="sec-tab-wrapper">
              {/* URL Input Bar */}
              <div className="sec-url-bar">
                <input
                  type="text"
                  placeholder="Paste SEC filing URL to analyze..."
                  value={secProcessUrl}
                  onChange={(e) => setSecProcessUrl(e.target.value)}
                  disabled={secBatchMode || secProcessing}
                  className="sec-url-input"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !secBatchMode) handleSecProcess();
                  }}
                />
                <button
                  onClick={handleSecProcess}
                  disabled={
                    secProcessing ||
                    (!secProcessUrl.trim() && !secBatchUrls.trim())
                  }
                  className="sec-process-btn"
                >
                  {secProcessing ? "PROCESSING..." : "ANALYZE"}
                </button>
                <button
                  onClick={() => setSecBatchMode(!secBatchMode)}
                  className={`batch-toggle ${secBatchMode ? "active" : ""}`}
                >
                  BATCH
                </button>
                {secProcessError && (
                  <span className="sec-process-error">{secProcessError}</span>
                )}
                {secProcessSuccess && (
                  <span className="sec-process-success">
                    {secProcessSuccess}
                  </span>
                )}
              </div>
              {secBatchMode && (
                <textarea
                  placeholder="Paste one SEC URL per line..."
                  value={secBatchUrls}
                  onChange={(e) => setSecBatchUrls(e.target.value)}
                  rows={4}
                  className="batch-textarea"
                  disabled={secProcessing}
                  style={{
                    margin: "0 0 8px 0",
                    width: "100%",
                    boxSizing: "border-box"
                  }}
                />
              )}

              <div className="sec-split-wrapper">
                <div className="sec-ai-split">
                  {/* Left: Feed */}
                  <div className="sec-ai-left">
                    <div className="sec-ai-feed-header">
                      <div className="sec-role-toggle">
                        <button
                          className={`sec-role-btn ${secFilingRole === "target" ? "active" : ""}`}
                          onClick={() => {
                            setSecFilingRole("target");
                            setSelectedSECFiling(null);
                            setSecTypeFilter("all");
                          }}
                        >
                          {deal.target} ({deal.target_ticker})
                        </button>
                        <button
                          className={`sec-role-btn ${secFilingRole === "acquirer" ? "active" : ""}`}
                          onClick={() => {
                            setSecFilingRole("acquirer");
                            setSelectedSECFiling(null);
                            setSecTypeFilter("all");
                          }}
                        >
                          {deal.acquirer} ({deal.acquirer_ticker})
                        </button>
                      </div>
                      <div className="sec-default-view-toggle">
                        <span className="sec-toggle-label">Default:</span>
                        <button
                          className={`sec-view-btn ${secDefaultView === "summary" ? "active" : ""}`}
                          onClick={() => setSecDefaultView("summary")}
                        >
                          Summary
                        </button>
                        <button
                          className={`sec-view-btn ${secDefaultView === "full" ? "active" : ""}`}
                          onClick={() => setSecDefaultView("full")}
                        >
                          Full Detail
                        </button>
                      </div>
                      {(() => {
                        const roleFilings =
                          deal.ai_sec_filings?.filter(
                            (f: any) => f._role === secFilingRole
                          ) || [];
                        const types = [
                          ...new Set(roleFilings.map((f: any) => f.form_type))
                        ].sort();
                        return types.length > 1 ? (
                          <div className="sec-type-filters">
                            <button
                              className={`sec-type-btn ${secTypeFilter === "all" ? "active" : ""}`}
                              onClick={() => setSecTypeFilter("all")}
                            >
                              All
                            </button>
                            {types.map((t: string) => (
                              <button
                                key={t}
                                className={`sec-type-btn ${secTypeFilter === t ? "active" : ""}`}
                                onClick={() => setSecTypeFilter(t)}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    <div className="sec-ai-feed">
                      {(() => {
                        const roleFilings =
                          deal.ai_sec_filings?.filter(
                            (f: any) => f._role === secFilingRole
                          ) || [];
                        const filtered =
                          secTypeFilter === "all"
                            ? roleFilings
                            : roleFilings.filter(
                                (f: any) => f.form_type === secTypeFilter
                              );
                        const sorted = [...filtered].sort(
                          (a: any, b: any) =>
                            new Date(b.date).getTime() -
                            new Date(a.date).getTime()
                        );
                        return sorted.length > 0 ? (
                          sorted.map((f: any, idx: number) => {
                            const isSelected = selectedSECFiling?.url === f.url;
                            const headline =
                              f.summary?.L1_headline || f.form_type;
                            const person =
                              f.summary?.insider_name ||
                              f.summary?.seller_name ||
                              f.summary?.filer_name ||
                              null;
                            return (
                              <div
                                key={`${f._slug}-${idx}`}
                                className={`sec-ai-feed-item ${isSelected ? "selected" : ""}`}
                                onClick={() => {
                                  setSelectedSECFiling(f);
                                  setSecDetailView(secDefaultView);
                                }}
                              >
                                <div className="feed-item-top">
                                  <span
                                    className="filing-type-badge"
                                    style={{
                                      backgroundColor: getFilingTypeColor(
                                        f.form_type
                                      )
                                    }}
                                  >
                                    {f.form_type}
                                  </span>
                                  <span className="feed-item-date">
                                    {formatDate(f.date)}
                                  </span>
                                </div>
                                <div className="feed-item-headline">
                                  {(headline || "")
                                    .replace(/^\+\s*/, "")
                                    .trim()
                                    .slice(0, 80)}
                                </div>
                                <div className="feed-item-meta">
                                  <span className="feed-item-ticker">
                                    {f.ticker}
                                  </span>
                                  {person && (
                                    <span className="feed-item-person">
                                      {person}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="sec-ai-empty">
                            No SEC filings analyzed yet. Paste a URL above to
                            get started.
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Right: Detail Panel */}
                  <div className="sec-ai-right">
                    {selectedSECFiling ? (
                      <>
                        <div className="sec-ai-detail-header">
                          <div className="sec-ai-detail-title">
                            <span
                              className="filing-type-badge"
                              style={{
                                backgroundColor: getFilingTypeColor(
                                  selectedSECFiling.form_type
                                )
                              }}
                            >
                              {selectedSECFiling.form_type}
                            </span>
                            <span className="detail-ticker">
                              {selectedSECFiling.ticker}
                            </span>
                            <span className="detail-date">
                              {formatDate(selectedSECFiling.date)}
                            </span>
                          </div>
                          <button
                            className="close-detail"
                            onClick={() => setSelectedSECFiling(null)}
                          >
                            &#x2715;
                          </button>
                        </div>

                        <div className="sec-ai-l1">
                          {selectedSECFiling.summary?.L1_headline ||
                            selectedSECFiling.form_type}
                        </div>

                        <div className="sec-ai-detail-tabs">
                          <button
                            className={
                              secDetailView === "summary" ? "active" : ""
                            }
                            onClick={() => setSecDetailView("summary")}
                          >
                            Summary
                          </button>
                          <button
                            className={secDetailView === "full" ? "active" : ""}
                            onClick={() => setSecDetailView("full")}
                          >
                            Full Details
                          </button>
                        </div>

                        <div className="sec-ai-detail-content">
                          {secDetailView === "summary" ? (
                            <>
                              {selectedSECFiling.summary?.items_reported && (
                                <div className="ai-meta-grid">
                                  <div className="ai-meta-item">
                                    <span className="ai-meta-label">Items</span>
                                    <span className="ai-meta-value">
                                      {selectedSECFiling.summary.items_reported.join(
                                        ", "
                                      )}
                                    </span>
                                  </div>
                                  <div className="ai-meta-item">
                                    <span className="ai-meta-label">Filed</span>
                                    <span className="ai-meta-value">
                                      {selectedSECFiling.summary?.filing_date ||
                                        formatDate(selectedSECFiling.date)}
                                    </span>
                                  </div>
                                </div>
                              )}
                              {selectedSECFiling.summary?.L2_brief && (
                                <div className="ai-l2-brief">
                                  <p className="l3-text">
                                    {selectedSECFiling.summary.L2_brief}
                                  </p>
                                </div>
                              )}
                              {selectedSECFiling.url && (
                                <div style={{ marginTop: "16px" }}>
                                  <a
                                    href={selectedSECFiling.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="view-sec-btn primary"
                                  >
                                    View on SEC.gov →
                                  </a>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              {selectedSECFiling.summary?.L3_detailed &&
                                renderL3Detail(
                                  selectedSECFiling.form_type,
                                  selectedSECFiling.summary.L3_detailed
                                )}
                              {selectedSECFiling.url && (
                                <div style={{ marginTop: "16px" }}>
                                  <a
                                    href={selectedSECFiling.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="view-sec-btn primary"
                                  >
                                    View on SEC.gov →
                                  </a>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {selectedSECFiling.url &&
                          ["8-K", "8-K/A"].includes(
                            selectedSECFiling.form_type
                          ) && (
                            <div className="sec-run-termination-bar">
                              <button
                                className="pipeline-run-btn"
                                onClick={() => {
                                  fetch(
                                    `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                                    {
                                      method: "POST",
                                      headers: {
                                        "Content-Type": "application/json"
                                      },
                                      body: JSON.stringify({
                                        url: selectedSECFiling.url
                                      })
                                    }
                                  )
                                    .then((res) => res.json())
                                    .then(() => {
                                      setTerminationPipelineStatus("running");
                                      setTerminationPipelineStep("starting");
                                      setTerminationStatus("error");
                                    });
                                }}
                              >
                                Run Termination from 8-K
                              </button>
                              <span className="sec-run-hint">
                                Extracts fee data from this filing
                              </span>
                            </div>
                          )}
                      </>
                    ) : (
                      <div className="sec-ai-no-selection">
                        <div className="sec-ai-no-selection-msg">
                          <div className="no-sel-icon">SEC</div>
                          <p>Select a filing to view details</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "10k" && (
            <div className="sec-tab-wrapper">
              <div
                className="sec-split-wrapper"
                style={{ height: "calc(100vh - 300px)", minHeight: "400px" }}
              >
                <div className="sec-ai-split">
                  {/* Left: Feed */}
                  <div className="sec-ai-left">
                    <div className="sec-ai-feed-header">
                      <span
                        className="sec-toggle-label"
                        style={{ marginRight: "auto" }}
                      >
                        10-K / 10-Q Filings
                      </span>
                    </div>
                    {selectedTenk?.hasComparison && (
                      <div className="sec-default-view-toggle">
                        <span className="sec-toggle-label">View:</span>
                        <button
                          className={`sec-view-btn ${tenkViewMode === "summary" ? "active" : ""}`}
                          onClick={() => setTenkViewMode("summary")}
                        >
                          Summary
                        </button>
                        <button
                          className={`sec-view-btn ${tenkViewMode === "detail" ? "active" : ""}`}
                          onClick={() => setTenkViewMode("detail")}
                        >
                          Full Detail
                        </button>
                      </div>
                    )}
                    <div className="sec-ai-feed">
                      {tenkLoading ? (
                        <div className="sec-ai-empty">
                          Loading 10-K/10-Q analyses...
                        </div>
                      ) : tenkAnalyses.length === 0 ? (
                        <div className="sec-ai-empty">
                          No 10-K/10-Q analyses found.
                        </div>
                      ) : (
                        tenkAnalyses.map((filing, idx) => {
                          const isSelected = selectedTenk?._id === filing._id;
                          return (
                            <div
                              key={filing._id}
                              className={`sec-ai-feed-item ${isSelected ? "selected" : ""}`}
                              onClick={() => handleSelectTenk(filing)}
                            >
                              <div className="feed-item-top">
                                <span
                                  className="filing-type-badge"
                                  style={{
                                    backgroundColor:
                                      filing.filing_type === "10-K" ||
                                      filing.filing_type === "10-K/A"
                                        ? "var(--accent-green)"
                                        : "var(--accent-blue)"
                                  }}
                                >
                                  {filing.filing_type}
                                </span>
                                {filing.hasComparison ? (
                                  <span
                                    style={{
                                      fontSize: "9px",
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      color: "var(--accent-yellow)",
                                      fontFamily: "var(--font-mono)"
                                    }}
                                  >
                                    Updated
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      fontSize: "9px",
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      color: "var(--text-muted)",
                                      fontFamily: "var(--font-mono)"
                                    }}
                                  >
                                    Summary
                                  </span>
                                )}
                              </div>
                              <div className="feed-item-headline">
                                {filing.filing_label}
                              </div>
                              <div className="feed-item-meta">
                                <span className="feed-item-ticker">
                                  {filing.ticker}
                                </span>
                                {filing.generated && (
                                  <span
                                    className="feed-item-date"
                                    style={{ fontSize: "9px" }}
                                  >
                                    {formatDate(filing.generated.split("T")[0])}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Right: Detail Panel */}
                  <div className="sec-ai-right">
                    {selectedTenk ? (
                      <>
                        <div className="sec-ai-detail-header">
                          <div className="sec-ai-detail-title">
                            <span
                              className="filing-type-badge"
                              style={{
                                backgroundColor:
                                  selectedTenk.filing_type === "10-K" ||
                                  selectedTenk.filing_type === "10-K/A"
                                    ? "var(--accent-green)"
                                    : "var(--accent-blue)"
                              }}
                            >
                              {selectedTenk.filing_type}
                            </span>
                            <span className="detail-ticker">
                              {selectedTenk.filing_label}
                            </span>
                            <span className="detail-date">
                              {formatDate(
                                selectedTenk.generated?.split("T")[0]
                              )}
                            </span>
                          </div>
                        </div>

                        {tenkDetailLoading && (
                          <div
                            className="sec-ai-empty"
                            style={{
                              margin: "12px 0",
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px"
                            }}
                          >
                            Loading 10-K/10-Q details...
                          </div>
                        )}

                        {/* Transition bar for comparison views */}
                        {selectedTenk.hasComparison &&
                          selectedTenk.fulsome?.transition && (
                            <div className="proxy-transition-bar">
                              {selectedTenk.fulsome.transition}
                            </div>
                          )}

                        <div
                          className="sec-ai-detail-content"
                          style={{ padding: "16px 20px" }}
                        >
                          {/* ── STANDALONE FILING (no comparison) ── */}
                          {!selectedTenk.hasComparison &&
                            selectedTenk.summary && (
                              <>
                                {/* Headline (L1/L2/L3 format) */}
                                {selectedTenk.summary.headline && (
                                  <div className="tenk-headline">
                                    {selectedTenk.summary.headline}
                                  </div>
                                )}

                                {/* Overview / Brief text */}
                                {selectedTenk.summary.overview && (
                                  <div className="tenk-overview-line">
                                    {selectedTenk.summary.overview}
                                  </div>
                                )}

                                {/* Category sections with bullets (exec-format standalone) */}
                                {(selectedTenk.summary.sections || []).length >
                                  0 && (
                                  <>
                                    {(selectedTenk.summary.sections || []).map(
                                      (section: any, si: number) => (
                                        <div
                                          key={si}
                                          className="tenk-exec-section"
                                        >
                                          <h5 className="l3-label">
                                            {section.name}
                                          </h5>
                                          <ul className="tenk-exec-items">
                                            {section.items.map(
                                              (item: string, ii: number) => (
                                                <li
                                                  key={ii}
                                                  className="tenk-exec-item"
                                                >
                                                  {item}
                                                </li>
                                              )
                                            )}
                                          </ul>
                                        </div>
                                      )
                                    )}
                                  </>
                                )}

                                {/* Tag filter + key excerpts (overview-format) */}
                                {(selectedTenk.summary.excerpts || []).length >
                                  0 && (
                                  <>
                                    {(() => {
                                      const allTags: string[] = Array.from(
                                        new Set(
                                          (
                                            selectedTenk.summary.excerpts || []
                                          ).flatMap(
                                            (e: any) => e.tags as string[]
                                          )
                                        )
                                      );
                                      return (
                                        <div className="tenk-filter-bar">
                                          <button
                                            className={`tenk-filter-btn ${tenkTagFilter === "ALL" ? "active" : ""}`}
                                            onClick={() =>
                                              setTenkTagFilter("ALL")
                                            }
                                          >
                                            ALL
                                          </button>
                                          {allTags.map((tag: string) => {
                                            const tagColor =
                                              tag === "TIMING"
                                                ? "var(--accent-blue)"
                                                : tag === "REGULATORY"
                                                  ? "var(--accent-yellow)"
                                                  : "#b794f4";
                                            const isActive =
                                              tenkTagFilter === tag;
                                            return (
                                              <button
                                                key={tag}
                                                className={`tenk-filter-btn ${isActive ? "active" : ""}`}
                                                style={
                                                  isActive
                                                    ? {
                                                        background: tagColor,
                                                        borderColor: tagColor,
                                                        color:
                                                          "var(--bg-primary)"
                                                      }
                                                    : {
                                                        borderColor: tagColor,
                                                        color: tagColor
                                                      }
                                                }
                                                onClick={() =>
                                                  setTenkTagFilter(tag)
                                                }
                                              >
                                                {tag}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                    {(selectedTenk.summary.excerpts || [])
                                      .filter(
                                        (e: any) =>
                                          tenkTagFilter === "ALL" ||
                                          e.tags.includes(tenkTagFilter)
                                      )
                                      .map((excerpt: any) => (
                                        <div
                                          key={excerpt.number}
                                          className="tenk-excerpt"
                                        >
                                          <div className="tenk-excerpt-header">
                                            <span className="tenk-excerpt-num">
                                              {excerpt.number}.
                                            </span>
                                            {excerpt.tags.map((tag: string) => (
                                              <span
                                                key={tag}
                                                className={`tenk-tag-badge ${tag === "TIMING" ? "tag-timing" : tag === "REGULATORY" ? "tag-regulatory" : "tag-legal"}`}
                                              >
                                                {tag}
                                              </span>
                                            ))}
                                          </div>
                                          {excerpt.section && (
                                            <div className="tenk-section-source">
                                              {excerpt.section}
                                            </div>
                                          )}
                                          <div className="tenk-excerpt-text">
                                            {excerpt.text}
                                          </div>
                                        </div>
                                      ))}
                                  </>
                                )}
                              </>
                            )}

                          {/* ── SUMMARY VIEW (Exec Summary) ── */}
                          {selectedTenk.hasComparison &&
                            tenkViewMode === "summary" &&
                            selectedTenk.summary && (
                              <>
                                {selectedTenk.summary.overview && (
                                  <div className="tenk-overview-line">
                                    {selectedTenk.summary.overview}
                                  </div>
                                )}
                                {(selectedTenk.summary.sections || []).map(
                                  (section: any, si: number) => (
                                    <div key={si} className="tenk-exec-section">
                                      <h5 className="l3-label">
                                        {section.name}
                                      </h5>
                                      <ul className="tenk-exec-items">
                                        {section.items.map(
                                          (item: string, ii: number) => (
                                            <li
                                              key={ii}
                                              className="tenk-exec-item"
                                            >
                                              {item}
                                            </li>
                                          )
                                        )}
                                      </ul>
                                    </div>
                                  )
                                )}
                              </>
                            )}

                          {/* ── FULL DETAIL VIEW (Redline) ── */}
                          {selectedTenk.hasComparison &&
                            tenkViewMode === "detail" &&
                            selectedTenk.fulsome && (
                              <>
                                {selectedTenk.fulsome.comparison_header && (
                                  <div className="tenk-comparison-header">
                                    {selectedTenk.fulsome.comparison_header}
                                  </div>
                                )}
                                {(
                                  selectedTenk.fulsome.redline_excerpts || []
                                ).map((excerpt: any) => (
                                  <div
                                    key={excerpt.number}
                                    className="tenk-redline-excerpt"
                                  >
                                    <div className="tenk-redline-header">
                                      <span className="tenk-excerpt-num">
                                        {excerpt.number}.
                                      </span>
                                      <span
                                        className={`tenk-significance ${excerpt.significance.toLowerCase()}`}
                                      >
                                        {excerpt.significance}
                                      </span>
                                      {excerpt.tags.map((tag: string) => (
                                        <span
                                          key={tag}
                                          className={`tenk-tag-badge ${tag === "TIMING" ? "tag-timing" : tag === "REGULATORY" ? "tag-regulatory" : "tag-legal"}`}
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                      {excerpt.source && (
                                        <span className="tenk-redline-source">
                                          — {excerpt.source}
                                        </span>
                                      )}
                                    </div>

                                    {/* Current / Prior text blocks */}
                                    {excerpt.is_new ? (
                                      <div className="tenk-text-block tenk-new-disclosure">
                                        <div className="tenk-text-label">
                                          New Disclosure —{" "}
                                          {excerpt.current_label}
                                        </div>
                                        <div className="tenk-text-body">
                                          {excerpt.current_text}
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="tenk-text-comparison">
                                        <div className="tenk-text-block tenk-current">
                                          <div className="tenk-text-label">
                                            Current: {excerpt.current_label}
                                          </div>
                                          <div className="tenk-text-body">
                                            {excerpt.current_text}
                                          </div>
                                        </div>
                                        <div className="tenk-text-block tenk-prior">
                                          <div className="tenk-text-label">
                                            Prior: {excerpt.prior_label}
                                          </div>
                                          <div className="tenk-text-body">
                                            {excerpt.prior_text}
                                          </div>
                                        </div>
                                      </div>
                                    )}

                                    {/* Phrase Changes */}
                                    {excerpt.phrase_changes?.length > 0 && (
                                      <div className="tenk-phrase-changes">
                                        <div className="tenk-phrase-header">
                                          Specific Phrase Changes
                                        </div>
                                        {excerpt.phrase_changes.map(
                                          (pc: any, pi: number) => (
                                            <div
                                              key={pi}
                                              className="tenk-phrase-pair"
                                            >
                                              <div className="tenk-phrase-row">
                                                <div className="tenk-phrase-current">
                                                  <span className="tenk-phrase-label">
                                                    Current
                                                  </span>
                                                  <div className="tenk-phrase-text">
                                                    {pc.current}
                                                  </div>
                                                </div>
                                                {pc.prior && (
                                                  <div className="tenk-phrase-prior">
                                                    <span className="tenk-phrase-label">
                                                      Prior
                                                    </span>
                                                    <div className="tenk-phrase-text">
                                                      {pc.prior}
                                                    </div>
                                                  </div>
                                                )}
                                              </div>
                                              {pc.analysis && (
                                                <div className="tenk-phrase-analysis">
                                                  {pc.analysis}
                                                </div>
                                              )}
                                            </div>
                                          )
                                        )}
                                      </div>
                                    )}

                                    {/* Category Analysis */}
                                    {excerpt.category_analysis?.length > 0 && (
                                      <div className="tenk-cat-analysis">
                                        {excerpt.category_analysis.map(
                                          (ca: any, ci: number) => (
                                            <div
                                              key={ci}
                                              className="tenk-cat-item"
                                            >
                                              <span className="tenk-cat-label">
                                                {ca.category}:
                                              </span>
                                              <span className="tenk-cat-text">
                                                {ca.text}
                                              </span>
                                            </div>
                                          )
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </>
                            )}
                        </div>
                      </>
                    ) : (
                      <div className="sec-ai-no-selection">
                        <div className="sec-ai-no-selection-msg">
                          <div className="no-sel-icon">10-K</div>
                          <p>Select a filing to view details</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "mae" && (
            <div className="dma-timeline-tab">
              {/* Sub-view toggle */}
              <div
                className="mae-view-toggle"
                style={{
                  display: "flex",
                  gap: "8px",
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border)"
                }}
              >
                <button
                  className={
                    maeView === "analysis" ? "tab-btn active" : "tab-btn"
                  }
                  onClick={() => setMaeView("analysis")}
                >
                  Clause Analysis
                </button>
                <button
                  className={
                    maeView === "pipeline" ? "tab-btn active" : "tab-btn"
                  }
                  onClick={() => setMaeView("pipeline")}
                >
                  Pipeline Dashboard
                </button>
              </div>

              {/* Clause Analysis view — structured MAEReview component from MongoDB */}
              {maeView === "analysis" && (
                <>
                  {maeDataLoading && (
                    <div className="placeholder">
                      <p>Loading MAE analysis from MongoDB…</p>
                    </div>
                  )}
                  {!maeDataLoading && maeData && (
                    <MAEReview
                      dealName={
                        maeData.deal_name || `${deal.target} / ${deal.acquirer}`
                      }
                      clauses={maeData.clauses || []}
                    />
                  )}
                  {!maeDataLoading && !maeData && (
                    <div className="placeholder">
                      <p>No MAE analysis available in MongoDB for this deal.</p>
                      <p
                        style={{
                          fontSize: "0.85em",
                          color: "var(--text-muted)"
                        }}
                      >
                        MAE analysis is sourced from the{" "}
                        <code>mae_analyses</code> collection. Switch to Pipeline
                        Dashboard to generate one.
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Pipeline Dashboard view — generated HTML iframe */}
              {maeView === "pipeline" && (
                <>
                  {maeStatus === "checking" && (
                    <div className="placeholder">
                      <p>Checking for MAE pipeline output...</p>
                    </div>
                  )}
                  {maeStatus === "ready" && (
                    <iframe
                      key={maeStatus}
                      src={`${API_BASE_URL}/api/deals/${dealId}/mae`}
                      className="dma-timeline-iframe"
                      title="MAE Analysis"
                    />
                  )}
                  {maeStatus === "running" && (
                    <div className="pipeline-run-card">
                      <div className="pipeline-progress">
                        Running MAE pipeline...
                      </div>
                      <p className="step-label">
                        Step: {maePipelineStep || "starting"}
                      </p>
                    </div>
                  )}
                  {maeStatus === "error" && (
                    <div className="pipeline-run-card">
                      {maeError && (
                        <p style={{ color: "var(--accent-red)" }}>{maeError}</p>
                      )}
                      {mergerUrlSaved ? (
                        <>
                          <p>No MAE dashboard generated yet.</p>
                          <button
                            className="pipeline-run-btn"
                            onClick={() => {
                              setMaeStatus("running");
                              setMaePipelineStep("starting");
                              setMaeError(null);
                              fetch(
                                `${API_BASE_URL}/api/deals/${dealId}/mae/run-pipeline`,
                                { method: "POST" }
                              )
                                .then((res) => res.json())
                                .then((data) => {
                                  if (data.status === "already_running") {
                                    setMaePipelineStep(
                                      data.step || "in progress"
                                    );
                                  }
                                })
                                .catch(() => {
                                  setMaeStatus("error");
                                  setMaeError("Failed to start pipeline");
                                });
                            }}
                          >
                            Run MAE Analysis
                          </button>
                          <p>
                            ~8 min — extracts MAE clause, classifies against
                            benchmark, runs compliance checks
                          </p>
                        </>
                      ) : (
                        <div className="pipeline-no-url">
                          <p>
                            Set the merger agreement URL in the Documents tab to
                            enable MAE analysis.
                          </p>
                          <button
                            className="retry-btn"
                            onClick={() => setMaeStatus("idle")}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === "covenants" && (
            <div className="dma-timeline-tab">
              {covenantStatus === "checking" && (
                <div className="placeholder">
                  <p>Checking for covenant analysis…</p>
                </div>
              )}
              {covenantStatus === "generating" && (
                <div className="placeholder">
                  <p>⏳ Generating covenant dashboard…</p>
                  <p className="muted">
                    Drop stage JSONs in backend/data/covenants/input/{dealId}/
                    to enable auto-generation.
                  </p>
                </div>
              )}
              {covenantStatus === "ready" && (
                <iframe
                  key={covenantStatus}
                  src={`${API_BASE_URL}/api/deals/${dealId}/covenants`}
                  className="dma-timeline-iframe"
                  title="Covenant Analysis"
                />
              )}
              {covenantStatus === "error" &&
                covenantPipelineStatus === "running" && (
                  <div className="pipeline-run-card">
                    <div className="pipeline-progress">
                      Running covenant pipeline...
                    </div>
                    <p className="step-label">
                      Step: {covenantPipelineStep || "starting"}
                    </p>
                  </div>
                )}
              {covenantStatus === "error" &&
                covenantPipelineStatus !== "running" && (
                  <div className="pipeline-run-card">
                    {covenantPipelineStatus === "error" && covenantError && (
                      <p style={{ color: "var(--accent-red)" }}>
                        {covenantError}
                      </p>
                    )}
                    {mergerUrlSaved ? (
                      <>
                        <p>No covenant dashboard generated yet.</p>
                        <button
                          className="pipeline-run-btn"
                          onClick={() => {
                            setCovenantPipelineStatus("running");
                            setCovenantPipelineStep("starting");
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/covenants/run-pipeline`,
                              { method: "POST" }
                            )
                              .then((res) => res.json())
                              .then((data) => {
                                if (data.status === "already_running") {
                                  setCovenantPipelineStep(
                                    data.step || "in progress"
                                  );
                                }
                              })
                              .catch(() => {
                                setCovenantPipelineStatus("error");
                                setCovenantError("Failed to start pipeline");
                              });
                          }}
                        >
                          Run Covenant Analysis
                        </button>
                        <p>
                          ~10 min — scrapes merger agreement, classifies
                          clauses, generates dashboard
                        </p>
                      </>
                    ) : (
                      <div className="pipeline-no-url">
                        <p>
                          Set the merger agreement URL in the Documents tab to
                          enable covenant analysis.
                        </p>
                        <button
                          className="retry-btn"
                          onClick={() => setCovenantStatus("idle")}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                )}
            </div>
          )}

          {activeTab === "regulatory" && (
            <div className="regulatory-wrapper">
              <RegulatoryTab
                dealId={dealId!}
                onProcessed={refreshDependentData}
              />
            </div>
          )}

          {activeTab === "reg-monitor" && (
            <div className="regulatory-wrapper">
              <RegulatoryMonitorTab
                dealId={dealId!}
                dealName={
                  deal
                    ? `${deal.target}${deal.target_ticker ? ` (${deal.target_ticker})` : ""} / ${deal.acquirer}`
                    : undefined
                }
                onProcessed={refreshDependentData}
              />
            </div>
          )}

          {activeTab === "milestones" && (
            <div className="milestones-wrapper">
              <MilestoneLog dealId={dealId!} />
            </div>
          )}

          {activeTab === "docket" && (
            <div className="docket-tab">
              {deal.docket_entries && deal.docket_entries.length > 0 ? (
                <DocketView
                  entries={deal.docket_entries}
                  stakeholders={deal.docket_stakeholders}
                  conditions={deal.docket_conditions}
                  metadata={deal.docket_metadata}
                />
              ) : (
                <div className="content-panel">
                  <h3>Court Docket</h3>
                  <div className="info-message">
                    <p>No docket entries available for this deal.</p>
                    <p className="muted">
                      Docket analysis will be added for deals with regulatory
                      proceedings or litigation.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "reddit" && (
            <div className="content-panel">
              <h3>Reddit Antitrust Analysis</h3>
              <DealRedditAnalysis dealId={dealId || ""} />
            </div>
          )}

          {activeTab === "twitter" && (
            <div className="content-panel">
              <h3>Twitter/X Mentions</h3>
              <div className="info-message">
                <p>
                  🐦 Social media sentiment from Twitter/X, including posts from
                  investors, analysts, and financial news.
                </p>
                <p>
                  <strong>Sources monitored:</strong>
                </p>
                <ul>
                  <li>Financial influencers and verified accounts</li>
                  <li>News outlets and journalists</li>
                  <li>Company official accounts</li>
                  <li>Retail investor discussions</li>
                </ul>
                <p className="muted">
                  Twitter API integration coming soon for real-time mentions and
                  sentiment.
                </p>
              </div>
            </div>
          )}

          {activeTab === "feed" && <FeedTab dealId={dealId!} />}

          {activeTab === "feed-new" && <MongoFeedTab dealId={dealId!} />}

          {activeTab === "termination" && (
            <div className="dma-timeline-tab">
              {terminationStatus === "checking" && (
                <div className="placeholder">
                  <p>Checking for termination analysis…</p>
                </div>
              )}
              {terminationStatus === "ready" && (
                <>
                  <div className="termination-source-bar">
                    <button
                      className="pipeline-run-btn"
                      onClick={() => {
                        setTerminationPipelineStatus("running");
                        setTerminationPipelineStep("starting");
                        setTerminationStatus("error");
                        fetch(
                          `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                          { method: "POST" }
                        ).then((res) => res.json());
                      }}
                    >
                      Re-run from Agreement
                    </button>
                    <input
                      className="termination-url-input"
                      placeholder="Paste 8-K or 99.1 URL to add source..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const url = (
                            e.target as HTMLInputElement
                          ).value.trim();
                          if (!url) return;
                          setTerminationPipelineStatus("running");
                          setTerminationPipelineStep("starting");
                          setTerminationStatus("error");
                          fetch(
                            `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ url })
                            }
                          ).then((res) => res.json());
                          (e.target as HTMLInputElement).value = "";
                        }
                      }}
                    />
                  </div>
                  {terminationHtml ? (
                    <iframe
                      ref={terminationIframeRef}
                      srcDoc={terminationHtml}
                      className="dma-timeline-iframe dma-timeline-iframe-autosize"
                      title="Termination Analysis"
                      onLoad={handleTerminationIframeLoad}
                      scrolling="no"
                    />
                  ) : (
                    <div className="placeholder">
                      <p>Loading termination dashboard...</p>
                    </div>
                  )}
                  {terminationSources.length > 0 && (
                    <div className="termination-audit-footer">
                      <span className="audit-label">Sources processed:</span>
                      {terminationSources.map((s: any, i: number) => (
                        <span key={i} className="audit-source-tag">
                          {s.type}
                          {s.doc_id && (
                            <span className="audit-doc-id">({s.doc_id})</span>
                          )}
                          <span className="audit-ts">
                            {new Date(s.timestamp).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit"
                            })}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
              {terminationStatus === "error" &&
                terminationPipelineStatus === "running" && (
                  <div className="pipeline-run-card">
                    <div className="pipeline-progress">
                      Running termination pipeline...
                    </div>
                    <p className="step-label">
                      Step: {terminationPipelineStep || "starting"}
                    </p>
                  </div>
                )}
              {terminationStatus === "error" &&
                terminationPipelineStatus !== "running" && (
                  <div className="pipeline-run-card">
                    {terminationPipelineStatus === "error" &&
                      terminationError && (
                        <p style={{ color: "var(--accent-red)" }}>
                          {terminationError}
                        </p>
                      )}
                    {mergerUrlSaved && (
                      <>
                        <p>No termination dashboard generated yet.</p>
                        <button
                          className="pipeline-run-btn"
                          onClick={() => {
                            setTerminationPipelineStatus("running");
                            setTerminationPipelineStep("starting");
                            setTerminationError(null);
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                              { method: "POST" }
                            )
                              .then((res) => res.json())
                              .then((data) => {
                                if (data.status === "already_running") {
                                  setTerminationPipelineStep(
                                    data.step || "in progress"
                                  );
                                }
                              })
                              .catch(() => {
                                setTerminationPipelineStatus("error");
                                setTerminationError("Failed to start pipeline");
                              });
                          }}
                        >
                          Run from Merger Agreement
                        </button>
                        <p className="step-label">
                          ~12 min — scrapes merger agreement, classifies
                          termination clauses, runs provision checks
                        </p>
                      </>
                    )}
                    {!mergerUrlSaved && (
                      <p className="step-label">
                        No merger agreement URL stored. Paste a URL below or set
                        it in the Documents tab.
                      </p>
                    )}
                    <div className="termination-alt-url">
                      <span className="step-label">
                        Or run from a specific filing:
                      </span>
                      <input
                        className="termination-url-input"
                        placeholder="Paste 8-K, 99.1, or merger agreement URL..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const url = (
                              e.target as HTMLInputElement
                            ).value.trim();
                            if (!url) return;
                            setTerminationPipelineStatus("running");
                            setTerminationPipelineStep("starting");
                            setTerminationError(null);
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                              {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ url })
                              }
                            ).then((res) => res.json());
                            (e.target as HTMLInputElement).value = "";
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              {terminationStatus === "idle" && (
                <div className="placeholder">
                  <p>Loading…</p>
                </div>
              )}
            </div>
          )}

          {activeTab === "scorecard" && dealId && (
            <ScorecardTab dealId={dealId} />
          )}

          {activeTab === "documents" && (
            <div className="documents-tab">
              {/* Merger Agreement URL */}
              <div className="merger-url-card">
                <div className="merger-url-label">Merger Agreement URL</div>
                {mergerUrlSaved ? (
                  <div className="merger-url-saved-block">
                    <div className="merger-url-saved">
                      <span className="merger-url-badge">STORED</span>
                      <a
                        href={mergerUrlSaved}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {mergerUrlSaved.length > 80
                          ? mergerUrlSaved.slice(0, 80) + "..."
                          : mergerUrlSaved}
                      </a>
                      <button
                        className="merger-url-btn"
                        onClick={() => {
                          setMergerUrlSaved(null);
                          setMergerUrlInput("");
                        }}
                      >
                        CLEAR
                      </button>
                    </div>
                    <div className="pipeline-checkboxes">
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runMaeOnSave}
                          onChange={(e) => setRunMaeOnSave(e.target.checked)}
                        />
                        MAE
                      </label>
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runCovenantsOnSave}
                          onChange={(e) =>
                            setRunCovenantsOnSave(e.target.checked)
                          }
                        />
                        Covenants
                      </label>
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runTerminationOnSave}
                          onChange={(e) =>
                            setRunTerminationOnSave(e.target.checked)
                          }
                        />
                        Termination
                      </label>
                      <button
                        className="merger-url-btn"
                        disabled={
                          !runMaeOnSave &&
                          !runCovenantsOnSave &&
                          !runTerminationOnSave
                        }
                        onClick={() => {
                          const started: string[] = [];
                          if (runMaeOnSave) {
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/mae/run-pipeline`,
                              { method: "POST" }
                            );
                            setMaeStatus("running");
                            setMaePipelineStep("starting");
                            started.push("MAE");
                          }
                          if (runCovenantsOnSave) {
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/covenants/run-pipeline`,
                              { method: "POST" }
                            );
                            setCovenantPipelineStatus("running");
                            setCovenantPipelineStep("starting");
                            setCovenantStatus("error");
                            started.push("Covenants");
                          }
                          if (runTerminationOnSave) {
                            fetch(
                              `${API_BASE_URL}/api/deals/${dealId}/termination/run-pipeline`,
                              { method: "POST" }
                            );
                            setTerminationPipelineStatus("running");
                            setTerminationPipelineStep("starting");
                            setTerminationStatus("error");
                            started.push("Termination");
                          }
                          setPipelineRunFeedback(
                            `Started: ${started.join(", ")}`
                          );
                          setTimeout(() => setPipelineRunFeedback(null), 5000);
                        }}
                      >
                        RUN
                      </button>
                      {pipelineRunFeedback && (
                        <span className="pipeline-run-feedback">
                          {pipelineRunFeedback}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="merger-url-row">
                      <input
                        className="merger-url-input"
                        placeholder="https://www.sec.gov/Archives/edgar/data/..."
                        value={mergerUrlInput}
                        onChange={(e) => setMergerUrlInput(e.target.value)}
                      />
                      <button
                        className="merger-url-btn"
                        disabled={!mergerUrlInput.trim()}
                        onClick={() => {
                          fetch(
                            `${API_BASE_URL}/api/deals/${dealId}/merger-agreement-url`,
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                url: mergerUrlInput.trim(),
                                run_mae: runMaeOnSave,
                                run_covenants: runCovenantsOnSave,
                                run_termination: runTerminationOnSave
                              })
                            }
                          )
                            .then((res) => res.json())
                            .then((data) => {
                              setMergerUrlSaved(mergerUrlInput.trim());
                              if (data.pipelines_started?.includes("mae")) {
                                setMaeStatus("running");
                                setMaePipelineStep("starting");
                              }
                              if (
                                data.pipelines_started?.includes("covenants")
                              ) {
                                setCovenantPipelineStatus("running");
                                setCovenantPipelineStep("starting");
                                setCovenantStatus("error");
                              }
                              if (
                                data.pipelines_started?.includes("termination")
                              ) {
                                setTerminationPipelineStatus("running");
                                setTerminationPipelineStep("starting");
                                setTerminationStatus("error");
                              }
                            })
                            .catch((e) =>
                              console.error("Failed to save URL:", e)
                            );
                        }}
                      >
                        SAVE
                      </button>
                    </div>
                    <div className="pipeline-checkboxes">
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runMaeOnSave}
                          onChange={(e) => setRunMaeOnSave(e.target.checked)}
                        />
                        Run MAE
                      </label>
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runCovenantsOnSave}
                          onChange={(e) =>
                            setRunCovenantsOnSave(e.target.checked)
                          }
                        />
                        Run Covenants
                      </label>
                      <label className="pipeline-checkbox-label">
                        <input
                          type="checkbox"
                          checked={runTerminationOnSave}
                          onChange={(e) =>
                            setRunTerminationOnSave(e.target.checked)
                          }
                        />
                        Run Termination
                      </label>
                    </div>
                  </>
                )}
              </div>

              {/* Upload Section */}
              <div className="fin-card">
                <div
                  className="fin-card-title"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  Upload Document
                  <button
                    className="pr-toggle-btn"
                    onClick={() => setTimelineExpanded(!timelineExpanded)}
                  >
                    {timelineExpanded ? "COLLAPSE" : "ADD"}
                  </button>
                  {uploadSuccess && (
                    <span className="sec-process-success">{uploadSuccess}</span>
                  )}
                  {uploadError && (
                    <span className="sec-process-error">{uploadError}</span>
                  )}
                </div>
                {timelineExpanded && (
                  <div className="pr-submit-box">
                    <div className="doc-type-selector">
                      {[
                        { key: "dma_summary" as const, label: "DMA Summary" },
                        {
                          key: "press_release" as const,
                          label: "Press Release"
                        },
                        { key: "proxy" as const, label: "Proxy" },
                        { key: "tenk" as const, label: "10-K / 10-Q" }
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          className={`doc-type-btn ${uploadDocType === opt.key ? "active" : ""}`}
                          onClick={() => setUploadDocType(opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <textarea
                      placeholder={
                        uploadDocType === "dma_summary"
                          ? "Paste the DMA summary text here..."
                          : uploadDocType === "press_release"
                            ? "Paste the press release text here..."
                            : uploadDocType === "proxy"
                              ? "Paste proxy analysis summary here..."
                              : "Paste 10-K / 10-Q analysis here..."
                      }
                      value={uploadText}
                      onChange={(e) => setUploadText(e.target.value)}
                      rows={8}
                      className="pr-textarea"
                      disabled={uploadProcessing}
                    />
                    <button
                      onClick={() => {
                        handleUnifiedUpload();
                        setTimeout(refreshDocSources, 2000);
                      }}
                      disabled={uploadProcessing || !uploadText.trim()}
                      className="sec-process-btn"
                      style={{ marginTop: "6px" }}
                    >
                      {uploadProcessing
                        ? "PROCESSING..."
                        : uploadDocType === "proxy" || uploadDocType === "tenk"
                          ? "SAVE"
                          : "EXTRACT"}
                    </button>
                  </div>
                )}
              </div>

              {/* Uploaded Documents */}
              <div
                className="fin-card"
                style={{ marginTop: "var(--space-lg)" }}
              >
                <div className="fin-card-title">Uploaded Documents</div>
                {allDocsLoading ? (
                  <div className="docs-loading">Loading documents...</div>
                ) : allDocSources?.sources ? (
                  (() => {
                    const uploadedTypes = [
                      "press_release",
                      "dma_extract",
                      "proxy",
                      "tenk",
                      "sec_filings"
                    ];
                    const uploaded = allDocSources.sources.filter((s: any) =>
                      uploadedTypes.includes(s.source)
                    );
                    return (
                      <div className="docs-inventory">
                        <div className="docs-header-row">
                          <span className="docs-col-type">Type</span>
                          <span className="docs-col-status">Status</span>
                          <span className="docs-col-date">Date</span>
                          <span className="docs-col-processed">Processed</span>
                          <span className="docs-col-detail">Detail</span>
                          <span className="docs-col-actions">Actions</span>
                        </div>
                        {uploaded.map((src: any) => (
                          <React.Fragment key={src.source}>
                            <div
                              className={`docs-row ${src.status === "missing" ? "docs-row-missing" : ""} ${src.status === "loaded" ? "docs-row-clickable" : ""}`}
                              onClick={() =>
                                src.status === "loaded" &&
                                toggleDocPreview(src.source)
                              }
                            >
                              <span className="docs-col-type">
                                {src.status === "loaded" && (
                                  <span className="docs-expand-icon">
                                    {expandedDocs.has(src.source) ? "▾" : "▸"}
                                  </span>
                                )}
                                {src.label}
                              </span>
                              <span
                                className={`docs-col-status ${src.status === "loaded" ? "docs-status-loaded" : "docs-status-missing"}`}
                              >
                                {src.status === "loaded" ? "LOADED" : "—"}
                              </span>
                              <span className="docs-col-date">
                                {src.filing_date
                                  ? formatDate(src.filing_date)
                                  : "—"}
                              </span>
                              <span className="docs-col-processed">
                                {src.extracted_at
                                  ? formatDate(src.extracted_at.split("T")[0])
                                  : src.file_modified
                                    ? formatDate(
                                        src.file_modified.split("T")[0]
                                      )
                                    : "—"}
                              </span>
                              <span className="docs-col-detail">
                                {src.count != null
                                  ? `${src.count} item${src.count !== 1 ? "s" : ""}`
                                  : ""}
                                {src.filled != null
                                  ? ` (${src.filled} filled)`
                                  : ""}
                              </span>
                              <span
                                className="docs-col-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {src.status === "loaded" &&
                                  ["dma_extract", "press_release"].includes(
                                    src.source
                                  ) && (
                                    <button
                                      className="docs-action-btn"
                                      onClick={() =>
                                        handleViewSourceText(src.source)
                                      }
                                    >
                                      SRC
                                    </button>
                                  )}
                                {src.status === "loaded" && (
                                  <button
                                    className="docs-action-btn docs-action-delete"
                                    onClick={() =>
                                      handleDeleteDocument(src.source)
                                    }
                                  >
                                    DEL
                                  </button>
                                )}
                              </span>
                            </div>
                            {/* Expandable preview for single-file types */}
                            {expandedDocs.has(src.source) &&
                              !src.files?.length && (
                                <div className="docs-preview">
                                  {!docPreviews[src.source] ? (
                                    <div className="docs-preview-loading">
                                      Loading...
                                    </div>
                                  ) : (
                                    <div className="docs-preview-fields">
                                      {docPreviews[src.source].fields.map(
                                        (f: any, i: number) => (
                                          <div
                                            key={i}
                                            className="docs-preview-field"
                                          >
                                            <span className="docs-preview-label">
                                              {f.label}
                                            </span>
                                            <span className="docs-preview-value">
                                              {f.value}
                                            </span>
                                          </div>
                                        )
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            {/* Inline file sub-rows for multi-file types (proxy, tenk) */}
                            {expandedDocs.has(src.source) &&
                              src.files?.length > 0 && (
                                <div className="docs-file-group">
                                  {src.files.map((f: any) => (
                                    <div
                                      key={f.filename}
                                      className="docs-file-row"
                                    >
                                      <span className="docs-file-name">
                                        {f.form_type
                                          ? `${f.form_type} — ${f.filename}`
                                          : f.filename}
                                      </span>
                                      <span className="docs-file-size">
                                        {f.size_kb
                                          ? `${f.size_kb} KB`
                                          : f.ticker || ""}
                                      </span>
                                      <span className="docs-file-date">
                                        {f.modified
                                          ? formatDate(f.modified.split("T")[0])
                                          : f.date || "—"}
                                      </span>
                                      <span className="docs-file-actions">
                                        <button
                                          className="docs-action-btn"
                                          onClick={() =>
                                            handleViewSourceText(
                                              src.source,
                                              f.filename
                                            )
                                          }
                                        >
                                          VIEW
                                        </button>
                                        <button
                                          className="docs-action-btn docs-action-delete"
                                          onClick={() =>
                                            handleDeleteDocument(
                                              src.source,
                                              f.filename
                                            )
                                          }
                                        >
                                          DEL
                                        </button>
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                          </React.Fragment>
                        ))}
                      </div>
                    );
                  })()
                ) : (
                  <div className="docs-loading">No document data available</div>
                )}
              </div>

              {/* Generated Data */}
              {!allDocsLoading &&
                allDocSources?.sources &&
                (() => {
                  const generatedTypes = [
                    "dma_sections",
                    "timeline",
                    "regulatory",
                    "tracking",
                    "overrides",
                    "termination",
                    "covenants",
                    "mae",
                    "reddit"
                  ];
                  const generated = allDocSources.sources.filter((s: any) =>
                    generatedTypes.includes(s.source)
                  );
                  return (
                    <div
                      className="fin-card"
                      style={{ marginTop: "var(--space-lg)" }}
                    >
                      <div className="fin-card-title">Generated Data</div>
                      <div className="docs-inventory">
                        <div className="docs-header-row">
                          <span className="docs-col-type">Type</span>
                          <span className="docs-col-status">Status</span>
                          <span className="docs-col-date">Date</span>
                          <span className="docs-col-processed">Processed</span>
                          <span className="docs-col-detail">Detail</span>
                          <span className="docs-col-actions">Actions</span>
                        </div>
                        {generated.map((src: any) => (
                          <React.Fragment key={src.source}>
                            <div
                              className={`docs-row ${src.status === "missing" ? "docs-row-missing" : ""} ${src.status === "loaded" ? "docs-row-clickable" : ""}`}
                              onClick={() =>
                                src.status === "loaded" &&
                                toggleDocPreview(src.source)
                              }
                            >
                              <span className="docs-col-type">
                                {src.status === "loaded" && (
                                  <span className="docs-expand-icon">
                                    {expandedDocs.has(src.source) ? "▾" : "▸"}
                                  </span>
                                )}
                                {src.label}
                              </span>
                              <span
                                className={`docs-col-status ${src.status === "loaded" ? "docs-status-loaded" : "docs-status-missing"}`}
                              >
                                {src.status === "loaded" ? "LOADED" : "—"}
                              </span>
                              <span className="docs-col-date">
                                {src.filing_date
                                  ? formatDate(src.filing_date)
                                  : "—"}
                              </span>
                              <span className="docs-col-processed">
                                {src.extracted_at
                                  ? formatDate(src.extracted_at.split("T")[0])
                                  : src.file_modified
                                    ? formatDate(
                                        src.file_modified.split("T")[0]
                                      )
                                    : "—"}
                              </span>
                              <span className="docs-col-detail">
                                {src.count != null
                                  ? `${src.count} item${src.count !== 1 ? "s" : ""}`
                                  : ""}
                                {src.filled != null
                                  ? ` (${src.filled} filled)`
                                  : ""}
                              </span>
                              <span
                                className="docs-col-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {src.status === "loaded" && (
                                  <button
                                    className="docs-action-btn docs-action-delete"
                                    onClick={() =>
                                      handleDeleteDocument(src.source)
                                    }
                                  >
                                    DEL
                                  </button>
                                )}
                              </span>
                            </div>
                            {expandedDocs.has(src.source) && (
                              <div className="docs-preview">
                                {!docPreviews[src.source] ? (
                                  <div className="docs-preview-loading">
                                    Loading...
                                  </div>
                                ) : (
                                  <div className="docs-preview-fields">
                                    {docPreviews[src.source].fields.map(
                                      (f: any, i: number) => (
                                        <div
                                          key={i}
                                          className="docs-preview-field"
                                        >
                                          <span className="docs-preview-label">
                                            {f.label}
                                          </span>
                                          <span className="docs-preview-value">
                                            {f.value}
                                          </span>
                                        </div>
                                      )
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  );
                })()}

              {/* Source Text Viewer */}
              {docViewSource && (
                <div
                  className="fin-card"
                  style={{ marginTop: "var(--space-lg)" }}
                >
                  <div
                    className="fin-card-title"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px"
                    }}
                  >
                    Source: {docViewSource.type}
                    {docViewSource.filename
                      ? ` / ${docViewSource.filename}`
                      : ""}
                    <button
                      className="pr-toggle-btn"
                      onClick={() => {
                        setDocViewSource(null);
                        setDocSourceText(null);
                      }}
                    >
                      CLOSE
                    </button>
                  </div>
                  {docSourceLoading ? (
                    <div className="docs-loading">Loading...</div>
                  ) : docSourceText ? (
                    <pre className="docs-source-text">{docSourceText}</pre>
                  ) : (
                    <div className="docs-loading">No source text available</div>
                  )}
                </div>
              )}

              {/* Cross-Source Discrepancies */}
              {allDocSources?.discrepancies &&
                allDocSources.discrepancies.length > 0 && (
                  <div
                    className="fin-card"
                    style={{ marginTop: "var(--space-lg)" }}
                  >
                    <div
                      className="fin-card-title"
                      style={{ color: "var(--accent-yellow)" }}
                    >
                      Cross-Source Discrepancies
                    </div>
                    <div className="docs-disc-subtitle">
                      Fields where Press Release, DMA Summary, and Timeline
                      disagree
                    </div>
                    <div className="docs-disc-fields">
                      <div className="docs-disc-checked">
                        Checked: Offer Price, Exchange Ratio, Deal Type, Outside
                        Date, Expected Close, Announce Date
                      </div>
                    </div>
                    <div className="docs-inventory">
                      <div className="docs-header-row">
                        <span className="docs-col-type">Field</span>
                        <span className="docs-col-status">Source</span>
                        <span className="docs-col-detail" style={{ flex: 2 }}>
                          Value
                        </span>
                        <span className="docs-col-actions"></span>
                      </div>
                      {allDocSources.discrepancies.map((d: any, i: number) =>
                        (d.sources || []).map((s: any, j: number) => (
                          <div
                            key={`${i}-${j}`}
                            className={`docs-row ${s.source === d.most_recent ? "docs-row-newest" : ""}`}
                          >
                            <span className="docs-col-type">
                              {j === 0 ? d.label || d.field : ""}
                            </span>
                            <span className="docs-col-status docs-disc-source">
                              {s.source === "press_release"
                                ? "PR"
                                : s.source === "dma_extract"
                                  ? "DMA"
                                  : s.source === "timeline"
                                    ? "Timeline"
                                    : s.source}
                            </span>
                            <span
                              className="docs-col-detail"
                              style={{ flex: 2 }}
                            >
                              {String(s.value)}
                              {s.source === d.most_recent && (
                                <span className="docs-disc-newest">NEWEST</span>
                              )}
                            </span>
                            <span className="docs-col-actions"></span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
