import { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config';

interface Signal {
  id: string;
  signal: string;
  raw_input: string;
  short_answer?: string;
  score: number | null;
  rationale: string;
  estimated?: boolean;
}

interface Category {
  label: string;
  subtotal: number;
  signals: Signal[];
}

interface ScorecardSection {
  score: number;
  max_score: number;
  interpretation: string;
  categories: Record<string, Category>;
}

interface ContextPanel {
  [key: string]: string | number | null;
}

interface ScorecardData {
  deal_id: string;
  generated_at: string;
  sources_used?: string[];
  context_panels?: {
    deal_overview: ContextPanel;
    deal_protection: ContextPanel;
  };
  deal_identification: Record<string, string>;
  power_dynamics: ScorecardSection;
  regulatory_risk: ScorecardSection;
}

interface SourceInfo {
  name: string;
  label: string;
  available: boolean;
  stat: string | null;
}

// ── Context panels ──────────────────────────────────────────────────────────

function ContextPanelBox({ title, data }: { title: string; data?: ContextPanel | null }) {
  if (!data) return null;
  const entries = Object.entries(data).filter(([, v]) => v != null);
  if (entries.length === 0) return null;

  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Combined Overlap', 'Outside Date', 'Extension']));

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div className="sc-panel">
      <div className="sc-panel-header">
        <div className="sc-panel-title">{title}</div>
      </div>
      <div className="sc-context-rows">
        {entries.map(([key, val]) => (
          <div
            key={key}
            className={`sc-context-row ${expanded.has(key) ? 'sc-context-row-expanded' : ''}`}
            onClick={() => toggle(key)}
          >
            <span className="sc-context-label">{key}</span>
            <span className="sc-context-value">{String(val)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Fallback: extract short answer from raw_input ────────────────────────────

function fallbackAnswer(raw: string): string {
  const first = raw.split(/[.!]\s/)[0];
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

// ── Scorecard panel ──────────────────────────────────────────────────────────

function ScorecardPanel({
  title,
  data,
  hideEstimated,
}: {
  title: string;
  data: ScorecardSection;
  hideEstimated: boolean;
}) {
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(Object.keys(data.categories)));
  const [expandedSignals, setExpandedSignals] = useState<Set<string>>(new Set());

  function toggleCat(key: string) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleSignal(key: string) {
    setExpandedSignals(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div className="sc-panel">
      {/* Panel header — just title */}
      <div className="sc-panel-header">
        <div className="sc-panel-title">{title}</div>
      </div>

      {/* Categories — collapsible */}
      {Object.entries(data.categories).map(([catKey, cat]) => {
        const visibleSignals = hideEstimated
          ? cat.signals.filter(s => !s.estimated)
          : cat.signals;
        if (visibleSignals.length === 0) return null;

        const isOpen = expandedCats.has(catKey);

        return (
          <div key={catKey} className="sc-category">
            <div className="sc-cat-header" onClick={() => toggleCat(catKey)}>
              <span className="sc-cat-key">{catKey}</span>
              <span className="sc-cat-label">{cat.label}</span>
              <span className="sc-cat-chevron">{isOpen ? '▾' : '▸'}</span>
            </div>

            {isOpen && (
              <div className="sc-signals">
                {visibleSignals.map(sig => {
                  const sigKey = `${catKey}-${sig.id}`;
                  const isExpanded = expandedSignals.has(sigKey);
                  const answer = sig.short_answer || fallbackAnswer(sig.raw_input);

                  return (
                    <div
                      key={sig.id}
                      className={`sc-signal-row ${sig.estimated ? 'sc-signal-estimated' : ''}`}
                      onClick={() => toggleSignal(sigKey)}
                    >
                      <div className="sc-signal-main">
                        <span className="sc-signal-id">{sig.id}</span>
                        <span className="sc-signal-name">{sig.signal}</span>
                        <div className="sc-signal-right">
                          {sig.estimated && <span className="sc-est-badge">est.</span>}
                          <span className="sc-short-answer">
                            {answer}
                          </span>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="sc-signal-detail">
                          <div className="sc-signal-finding">
                            <span className="sc-detail-label">Finding</span>
                            <span className="sc-detail-text">{sig.raw_input}</span>
                          </div>
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

// ── Source-aware input form ──────────────────────────────────────────────────

function ScorecardSourcesForm({
  dealId,
  onGenerated,
}: {
  dealId: string;
  onGenerated: () => void;
}) {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSupplement, setShowSupplement] = useState(false);
  const [supplement, setSupplement] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [proxyText, setProxyText] = useState('');
  const [maText, setMaText] = useState('');

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/deals/${dealId}/scorecard/sources`)
      .then(res => res.json())
      .then(data => {
        setSources(data.sources || []);
        setReady(data.ready || false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [dealId]);

  const availableCount = sources.filter(s => s.available).length;

  async function handleAutoGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/deals/${dealId}/scorecard/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_gather: true,
          supplement_text: supplement,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onGenerated();
      } else {
        setError(data.detail || 'Generation failed');
        setGenerating(false);
      }
    } catch (e: any) {
      setError(e.message);
      setGenerating(false);
    }
  }

  async function handleManualGenerate() {
    if (!proxyText.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/deals/${dealId}/scorecard/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_gather: false,
          proxy_text: proxyText,
          merger_agreement_text: maText,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onGenerated();
      } else {
        setError(data.detail || 'Generation failed');
        setGenerating(false);
      }
    } catch (e: any) {
      setError(e.message);
      setGenerating(false);
    }
  }

  if (loading) {
    return <div className="placeholder"><p>Checking available sources...</p></div>;
  }

  return (
    <div className="sc-input-form">
      <div className="sc-input-header">
        <h3>Generate Deal Scorecard</h3>
        <p className="sc-input-sub">
          Claude Sonnet scores 40 signals across two frameworks: Deal Power Dynamics and Regulatory Risk.
          Estimated cost: ~$0.12.
        </p>
      </div>

      <div className="sc-sources-grid">
        <div className="sc-sources-header">Available Sources</div>
        {sources.map(s => (
          <div key={s.name} className={`sc-source-row ${s.available ? 'sc-source-ready' : 'sc-source-missing'}`}>
            <span className="sc-source-dot">{s.available ? '\u25CF' : '\u25CB'}</span>
            <span className="sc-source-label">{s.label}</span>
            {s.stat && <span className="sc-source-stat">{s.stat}</span>}
          </div>
        ))}
      </div>

      {!showManual && (
        <div className="sc-supplement-section">
          {!showSupplement ? (
            <button className="sc-supplement-toggle" onClick={() => setShowSupplement(true)}>
              + Add supplemental context
            </button>
          ) : (
            <div className="sc-input-group">
              <label className="sc-input-label">
                Supplemental Context <span className="sc-optional">optional</span>
              </label>
              <textarea
                className="sc-textarea sc-textarea-sm"
                placeholder="Paste any additional context not captured by the pipelines above..."
                value={supplement}
                onChange={e => setSupplement(e.target.value)}
                rows={4}
              />
            </div>
          )}
        </div>
      )}

      {error && <div className="sc-error">{error}</div>}

      {!showManual && (
        <>
          <button
            className="sc-generate-btn"
            onClick={handleAutoGenerate}
            disabled={!ready || generating}
          >
            {generating
              ? 'Scoring with Claude Sonnet...'
              : `Generate Scorecard from ${availableCount} Source${availableCount !== 1 ? 's' : ''}`}
          </button>
          {!ready && (
            <p className="sc-input-sub" style={{ textAlign: 'center', marginTop: '8px' }}>
              Need at least 2 pipeline sources to auto-generate.
            </p>
          )}
          <button className="sc-manual-fallback" onClick={() => setShowManual(true)}>
            Or paste text manually
          </button>
        </>
      )}

      {showManual && (
        <>
          <div className="sc-input-group">
            <label className="sc-input-label">
              Proxy Background Section <span className="sc-required">required</span>
            </label>
            <textarea
              className="sc-textarea sc-textarea-lg"
              placeholder="Paste the 'Background of the Merger' section from the proxy statement..."
              value={proxyText}
              onChange={e => setProxyText(e.target.value)}
              rows={12}
            />
            <div className="sc-char-count">{proxyText.length.toLocaleString()} chars</div>
          </div>

          <div className="sc-input-group">
            <label className="sc-input-label">
              Merger Agreement Sections <span className="sc-optional">optional</span>
            </label>
            <textarea
              className="sc-textarea sc-textarea-sm"
              placeholder="Paste relevant sections: termination fees, regulatory covenants, conditions to closing..."
              value={maText}
              onChange={e => setMaText(e.target.value)}
              rows={6}
            />
          </div>

          <button
            className="sc-generate-btn"
            onClick={handleManualGenerate}
            disabled={!proxyText.trim() || generating}
          >
            {generating ? 'Scoring with Claude Sonnet...' : 'Generate Scorecard'}
          </button>
          <button className="sc-manual-fallback" onClick={() => setShowManual(false)}>
            Back to auto-gather
          </button>
        </>
      )}
    </div>
  );
}

// ── Helper: count estimated signals ──────────────────────────────────────────

function countSignals(data: ScorecardData): { total: number; estimated: number; fromDocs: number } {
  let total = 0;
  let estimated = 0;
  for (const section of [data.power_dynamics, data.regulatory_risk]) {
    for (const cat of Object.values(section.categories)) {
      for (const sig of cat.signals) {
        total++;
        if (sig.estimated) estimated++;
      }
    }
  }
  return { total, estimated, fromDocs: total - estimated };
}

// ── Source label map ─────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  press_release: 'Press Release',
  dma_extract: 'DMA Extract',
  proxy: 'Proxy',
  covenants: 'Covenants',
  termination: 'Termination',
  regulatory: 'Regulatory',
  mae: 'MAE',
  yfinance: 'Market Data',
  manual_input: 'Manual Input',
};

// ── Main export ──────────────────────────────────────────────────────────────

export default function ScorecardTab({ dealId }: { dealId: string }) {
  const [status, setStatus] = useState<'checking' | 'input' | 'ready' | 'error'>('checking');
  const [data, setData] = useState<ScorecardData | null>(null);
  const [hideEstimated, setHideEstimated] = useState(false);

  function loadScorecard() {
    setStatus('checking');
    fetch(`${API_BASE_URL}/api/deals/${dealId}/scorecard`)
      .then(res => {
        if (res.ok) return res.json();
        if (res.status === 404) { setStatus('input'); return null; }
        throw new Error(`HTTP ${res.status}`);
      })
      .then(json => { if (json) { setData(json); setStatus('ready'); } })
      .catch(() => setStatus('input'));
  }

  useEffect(() => { loadScorecard(); }, [dealId]);

  if (status === 'checking') {
    return <div className="placeholder"><p>Loading scorecard...</p></div>;
  }

  if (status === 'input') {
    return <ScorecardSourcesForm dealId={dealId} onGenerated={loadScorecard} />;
  }

  if (!data) return null;

  const genDate = new Date(data.generated_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const { total, fromDocs, estimated } = countSignals(data);
  const sourcesUsed = data.sources_used || [];
  const di = data.deal_identification || {};

  return (
    <div className="sc-container">
      {/* Top bar: deal info + controls */}
      <div className="sc-top-bar">
        <div>
          <div className="sc-deal-id">{di.deal_name || di.target || dealId}</div>
          {di.industry && <span className="sc-deal-industry">{di.industry}</span>}
          {di.deal_value && <span className="sc-deal-industry">{di.deal_value}</span>}
        </div>
        <div className="sc-meta">
          {sourcesUsed.length > 0 && (
            <div className="sc-sources-used-bar">
              {sourcesUsed.map(s => (
                <span key={s} className="sc-source-badge">{SOURCE_LABELS[s] || s}</span>
              ))}
            </div>
          )}
          <span className="sc-signal-count">{fromDocs}/{total} from docs, {estimated} estimated</span>
          <span className="sc-gen-date">Scored {genDate}</span>
          <button className="sc-rescore-btn" onClick={() => setStatus('input')}>
            Re-score
          </button>
        </div>
      </div>

      {/* Controls */}
      {estimated > 0 && (
        <div className="sc-controls-bar">
          <label className="sc-toggle-label">
            <input
              type="checkbox"
              checked={hideEstimated}
              onChange={e => setHideEstimated(e.target.checked)}
            />
            <span>Hide estimated ({estimated})</span>
          </label>
        </div>
      )}

      {/* All panels in one grid */}
      <div className="sc-panels">
        <ContextPanelBox title="DEAL OVERVIEW" data={data.context_panels?.deal_overview} />
        <ContextPanelBox title="DEAL PROTECTION" data={data.context_panels?.deal_protection} />
        <ScorecardPanel
          title="DEAL POWER DYNAMICS"
          data={data.power_dynamics}
          hideEstimated={hideEstimated}
        />
        <ScorecardPanel
          title="REGULATORY RISK"
          data={data.regulatory_risk}
          hideEstimated={hideEstimated}
        />
      </div>
    </div>
  );
}
