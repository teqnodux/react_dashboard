import { useState, useEffect } from 'react';
import { AISummaryResult, SecAIAllResponse } from '../types/deal';
import DashboardNav from '../components/DashboardNav';
import { getFilingTypeColor, renderL3Detail } from '../components/SECFilingRenderers';
import '../styles/CrossDeal.css';
import '../styles/SECFilings.css';
import { API_BASE_URL } from '../config';

// ── Main Component ──

export default function SECFilings() {
  // AI filings state
  const [aiFilings, setAiFilings] = useState<AISummaryResult[]>([]);
  const [aiByType, setAiByType] = useState<{ type: string; count: number }[]>([]);
  const [aiTotal, setAiTotal] = useState(0);
  const [aiCompanies, setAiCompanies] = useState(0);
  const [aiLoading, setAiLoading] = useState(true);
  const [aiFilter, setAiFilter] = useState<string>('all');
  const [aiSearch, setAiSearch] = useState('');
  const [selectedFiling, setSelectedFiling] = useState<AISummaryResult | null>(null);
  const [detailView, setDetailView] = useState<'summary' | 'full'>('summary');
  const [defaultView, setDefaultView] = useState<'summary' | 'full'>('summary');

  // URL processing state
  const [processUrl, setProcessUrl] = useState('');
  const [processSlug, setProcessSlug] = useState('');
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [batchUrls, setBatchUrls] = useState('');
  const [showUrlBar, setShowUrlBar] = useState(false);

  useEffect(() => {
    fetchAIFilings();
  }, []);

  const fetchAIFilings = async () => {
    setAiLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/sec-ai/all`);
      console.log('[SEC] fetch status:', res.status);
      const data: SecAIAllResponse = await res.json();
      console.log('[SEC] filings received:', data.filings?.length, 'total:', data.total);
      setAiFilings(data.filings);
      setAiByType(data.by_type);
      setAiTotal(data.total);
      setAiCompanies(data.companies);
    } catch (e) {
      console.error('[SEC] Error fetching AI filings:', e);
    }
    setAiLoading(false);
  };

  const [batchProgress, setBatchProgress] = useState('');

  const handleProcess = async () => {
    setProcessing(true);
    setProcessError('');
    try {
      if (batchMode) {
        const urls = batchUrls.split('\n').map(u => u.trim()).filter(Boolean);
        if (urls.length === 0) { setProcessing(false); return; }
        const res = await fetch(`${API_BASE_URL}/api/sec-ai/process-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls, company_slug: processSlug || null })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const jobId = data.job_id;
        setBatchUrls('');
        setBatchProgress(`Processing 0/${urls.length} filings...`);
        const poll = setInterval(async () => {
          try {
            const statusRes = await fetch(`${API_BASE_URL}/api/sec-ai/batch-status/${jobId}`);
            if (!statusRes.ok) { clearInterval(poll); return; }
            const status = await statusRes.json();
            const errors = status.results.filter((r: any) => r.status === 'error').length;
            const errText = errors > 0 ? ` (${errors} failed)` : '';
            setBatchProgress(`Processing ${status.completed}/${status.total} filings...${errText}`);
            if (status.done) {
              clearInterval(poll);
              setBatchProgress(`Done: ${status.completed - errors}/${status.total} processed${errText}`);
              setTimeout(() => setBatchProgress(''), 8000);
              setProcessing(false);
              await fetchAIFilings();
            }
          } catch { clearInterval(poll); setProcessing(false); }
        }, 3000);
      } else {
        if (!processUrl.trim()) { setProcessing(false); return; }
        const res = await fetch(`${API_BASE_URL}/api/sec-ai/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: processUrl, company_slug: processSlug || null })
        });
        if (!res.ok) throw new Error(await res.text());
        setProcessUrl('');
        await fetchAIFilings();
        setProcessing(false);
      }
    } catch (e: any) {
      setProcessError(e.message || 'Processing failed');
      setProcessing(false);
    }
  };

  // Filtered filings (sorted most recent first)
  const filteredFilings = aiFilings.filter(f => {
    const matchesType = aiFilter === 'all' || f.form_type === aiFilter;
    const matchesSearch = aiSearch === '' ||
      (f.summary?.L1_headline || '').toLowerCase().includes(aiSearch.toLowerCase()) ||
      (f.ticker || '').toLowerCase().includes(aiSearch.toLowerCase()) ||
      (f._company || '').toLowerCase().includes(aiSearch.toLowerCase()) ||
      (f.form_type || '').toLowerCase().includes(aiSearch.toLowerCase());
    return matchesType && matchesSearch;
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const formatDate = (dateStr: string) => {
    if (!dateStr) return 'N/A';
    if (dateStr.includes('/')) return dateStr;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const truncateL1 = (headline: string, maxLen = 80) => {
    let text = headline.replace(/^\+\s*/, '').trim();
    if (text.length > maxLen) text = text.slice(0, maxLen) + '...';
    return text;
  };

  const getFilingPerson = (summary: AISummaryResult['summary']) => {
    return summary?.insider_name || summary?.seller_name || summary?.filer_name || null;
  };

  return (
    <div className="dashboard sec-filings-page">
      <DashboardNav />

      {/* Compact toolbar: search + filters + add button */}
      <div className="sec-toolbar">
        <input
          type="text"
          placeholder="Search filings, tickers, companies..."
          value={aiSearch}
          onChange={(e) => setAiSearch(e.target.value)}
          className="sec-toolbar-search"
        />
        <div className="sec-toolbar-filters">
          <button
            className={`type-filter-btn ${aiFilter === 'all' ? 'active' : ''}`}
            onClick={() => setAiFilter('all')}
          >
            All
          </button>
          {aiByType.map((t) => (
            <button
              key={t.type}
              className={`type-filter-btn ${aiFilter === t.type ? 'active' : ''}`}
              onClick={() => setAiFilter(t.type)}
            >
              {t.type} ({t.count})
            </button>
          ))}
        </div>
        <button
          className={`sec-add-btn ${showUrlBar ? 'active' : ''}`}
          onClick={() => setShowUrlBar(!showUrlBar)}
        >
          + ADD
        </button>
      </div>

      {/* Collapsible URL Input Bar */}
      {showUrlBar && (
        <div className="sec-url-input-bar">
          <div className="url-input-row">
            <input
              type="text"
              placeholder="Paste SEC filing URL..."
              value={processUrl}
              onChange={(e) => setProcessUrl(e.target.value)}
              disabled={batchMode || processing}
              className="url-input"
              onKeyDown={(e) => { if (e.key === 'Enter' && !batchMode) handleProcess(); }}
            />
            <button
              onClick={handleProcess}
              disabled={processing || (!processUrl && !batchUrls)}
              className="process-btn"
            >
              {processing ? 'PROCESSING...' : 'PROCESS'}
            </button>
            <button
              onClick={() => setBatchMode(!batchMode)}
              className={`batch-toggle ${batchMode ? 'active' : ''}`}
            >
              BATCH
            </button>
          </div>
          {batchMode && (
            <textarea
              placeholder="Paste one SEC URL per line..."
              value={batchUrls}
              onChange={(e) => setBatchUrls(e.target.value)}
              rows={4}
              className="batch-textarea"
              disabled={processing}
            />
          )}
          {batchProgress && <div className="url-success">{batchProgress}</div>}
          {processError && <div className="url-error">{processError}</div>}
        </div>
      )}

      {/* Split Panel Content */}
      <div className="sec-split-wrapper">
        <div className="sec-ai-split">
          {/* Left: Feed */}
          <div className="sec-ai-left">
            <div className="sec-ai-feed-header">
              <div className="sec-default-view-toggle">
                <span className="sec-toggle-label">Default:</span>
                <button
                  className={`sec-view-btn ${defaultView === 'summary' ? 'active' : ''}`}
                  onClick={() => setDefaultView('summary')}
                >Summary</button>
                <button
                  className={`sec-view-btn ${defaultView === 'full' ? 'active' : ''}`}
                  onClick={() => setDefaultView('full')}
                >Full Detail</button>
              </div>
            </div>
            <div className="sec-ai-feed">
              {aiLoading ? (
                <div className="sec-ai-empty">Loading filings...</div>
              ) : filteredFilings.length === 0 ? (
                <div className="sec-ai-empty">No filings found.</div>
              ) : (
                filteredFilings.map((f, idx) => {
                  const isSelected = selectedFiling?.url === f.url;
                  const headline = f.summary?.L1_headline || f.form_type;
                  const person = getFilingPerson(f.summary);
                  return (
                    <div
                      key={`${f._slug}-${idx}`}
                      className={`sec-ai-feed-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => { setSelectedFiling(f); setDetailView(defaultView); }}
                    >
                      <div className="feed-item-top">
                        <span
                          className="filing-type-badge"
                          style={{ backgroundColor: getFilingTypeColor(f.form_type) }}
                        >
                          {f.form_type}
                        </span>
                        <span className="feed-item-date">{formatDate(f.date)}</span>
                      </div>
                      <div className="feed-item-headline">{truncateL1(headline)}</div>
                      <div className="feed-item-meta">
                        <span className="feed-item-ticker">{f.ticker}</span>
                        {person && <span className="feed-item-person">{person}</span>}
                        {f._company && <span className="feed-item-company">{f._company}</span>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Detail Panel */}
          <div className={`sec-ai-right ${selectedFiling ? 'open' : ''}`}>
            {selectedFiling ? (
              <>
                <div className="sec-ai-detail-header">
                  <div className="sec-ai-detail-title">
                    <span
                      className="filing-type-badge"
                      style={{ backgroundColor: getFilingTypeColor(selectedFiling.form_type) }}
                    >
                      {selectedFiling.form_type}
                    </span>
                    <span className="detail-ticker">{selectedFiling.ticker}</span>
                    <span className="detail-date">{formatDate(selectedFiling.date)}</span>
                    {selectedFiling._company && (
                      <span className="detail-company">{selectedFiling._company}</span>
                    )}
                  </div>
                  <button className="close-detail" onClick={() => setSelectedFiling(null)}>&#x2715;</button>
                </div>

                <div className="sec-ai-l1">
                  {selectedFiling.summary?.L1_headline || selectedFiling.form_type}
                </div>

                <div className="sec-ai-detail-tabs">
                  <button
                    className={detailView === 'summary' ? 'active' : ''}
                    onClick={() => setDetailView('summary')}
                  >
                    Summary
                  </button>
                  <button
                    className={detailView === 'full' ? 'active' : ''}
                    onClick={() => setDetailView('full')}
                  >
                    Full Details
                  </button>
                </div>

                <div className="sec-ai-detail-content">
                  {detailView === 'summary' ? (
                    <div className="sec-ai-summary-view">
                      <div className="ai-meta-grid">
                        {selectedFiling.ticker && (
                          <div className="ai-meta-item">
                            <span className="ai-meta-label">Ticker</span>
                            <span className="ai-meta-value">{selectedFiling.ticker}</span>
                          </div>
                        )}
                        <div className="ai-meta-item">
                          <span className="ai-meta-label">Filed</span>
                          <span className="ai-meta-value">{formatDate(selectedFiling.date)}</span>
                        </div>
                        <div className="ai-meta-item">
                          <span className="ai-meta-label">Form Type</span>
                          <span className="ai-meta-value">{selectedFiling.form_type}</span>
                        </div>
                        {selectedFiling.summary?.items_reported && (
                          <div className="ai-meta-item">
                            <span className="ai-meta-label">Items</span>
                            <span className="ai-meta-value">{selectedFiling.summary.items_reported.join(', ')}</span>
                          </div>
                        )}
                        {getFilingPerson(selectedFiling.summary) && (
                          <div className="ai-meta-item">
                            <span className="ai-meta-label">Person</span>
                            <span className="ai-meta-value">{getFilingPerson(selectedFiling.summary)}</span>
                          </div>
                        )}
                        {selectedFiling.summary?.relationship && (
                          <div className="ai-meta-item">
                            <span className="ai-meta-label">Relationship</span>
                            <span className="ai-meta-value">{selectedFiling.summary.relationship}</span>
                          </div>
                        )}
                      </div>

                      <div className="ai-l2-brief">
                        <h5 className="l3-label">ANALYST BRIEF</h5>
                        <p className="l3-text">{selectedFiling.summary?.L2_brief || 'No summary available.'}</p>
                      </div>

                      {selectedFiling.url && (
                        <a
                          href={selectedFiling.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="view-sec-btn primary"
                        >
                          View on SEC.gov
                        </a>
                      )}
                    </div>
                  ) : (
                    <div className="sec-ai-full-view">
                      {selectedFiling.summary?.L3_detailed ? (
                        renderL3Detail(selectedFiling.form_type, selectedFiling.summary.L3_detailed)
                      ) : (
                        <p className="l3-text" style={{ color: 'var(--text-muted)' }}>No detailed analysis available.</p>
                      )}

                      {selectedFiling.url && (
                        <a
                          href={selectedFiling.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="view-sec-btn primary"
                          style={{ marginTop: '20px' }}
                        >
                          View on SEC.gov
                        </a>
                      )}
                    </div>
                  )}
                </div>
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
  );
}
