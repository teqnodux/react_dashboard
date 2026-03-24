import { useEffect, useRef, useState } from 'react';
import './DMATimeline.css';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StaticEvent  { label: string; date: string; ref: string | null; filed_date?: string | null; source?: string | null; }
interface DeadlineEvent {
  label: string;
  date: string | null;          // contractual deadline (calculated from agreement)
  filed_date?: string | null;   // actual filed date (from tracking layer)
  filed_source?: string | null;
  trigger_key?: string | null;  // links this row to a triggered chain
  calculation: string;
  ref: string | null;
}
interface DownstreamItem {
  label: string;
  rule: string;
  calc_days?: number | null;
  calc_days_type?: string | null;
  calc_from?: string;
  resolved_date?: string | null; // calculated when trigger date is known
  ref: string | null;
}
interface TriggeredChain {
  trigger_label: string;
  trigger_key: string;
  trigger_date?: string | null;  // actual filed date (from tracking)
  downstream: DownstreamItem[];
}

interface RegulatoryApproval {
  name: string;
  filing_days: number | null;
  filing_days_type: string | null;
  required: boolean;
  notes?: string | null;
  status?: string | null;       // from regulatory tracker
  filed_date?: string | null;   // from regulatory tracker
  cleared_date?: string | null; // from regulatory tracker
  jurisdiction?: string | null;
  category?: string | null;
}

interface StockPoint { date: string; price: number; }
interface StockData  { available: boolean; tickers: string[]; series: Record<string, StockPoint[]>; error?: string; }

interface OutsideDateExtension {
  date: string | null;
  extension_months: number | null;
  auto: boolean;
  condition: string | null;
  note: string | null;
}

interface TimelineData {
  deal_name: string;
  acquirer: string;
  acquirer_ticker: string;
  target: string;
  target_ticker: string;
  signing_date: string;
  announce_date?: string | null;
  nda_date: string;
  outside_date_initial: string;
  // New format: array of extensions
  outside_date_extensions?: OutsideDateExtension[];
  // Legacy format (backwards compat for already-generated JSONs)
  outside_date_extended?: string | null;
  outside_date_extension_note?: string | null;
  extension_note?: string;
  estimated_close_start?: string | null;
  estimated_close_end?: string | null;
  estimated_close_guidance?: string | null;
  offer_price_per_share: number | null;
  exchange_ratio: number | null;
  financing_type: string | null;
  requires_s4: boolean;
  is_going_private?: boolean;
  schedule_13e3_required?: boolean;
  regulatory_approvals?: RegulatoryApproval[];
  static_events: StaticEvent[];
  deadline_events: DeadlineEvent[];
  triggered_chains: TriggeredChain[];
  checklist: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function today(): Date { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }
function daysFromToday(s: string): number { return Math.round((parseDate(s).getTime() - today().getTime()) / 86400000); }
function daysBetween(a: string, b: string): number { return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000); }
function tPlus(signing: string, s: string): number { return Math.round((parseDate(s).getTime() - parseDate(signing).getTime()) / 86400000); }
function fmtDate(s: string): string { return parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDays(n: number): string { if (n === 0) return 'TODAY'; return (n > 0 ? '+' : '') + n + 'd'; }
function fmtT(n: number): string { return (n >= 0 ? 'T+' : 'T') + n; }
function pctOf(dateStr: string, rangeStart: Date, rangeSpan: number): number {
  return (parseDate(dateStr).getTime() - rangeStart.getTime()) / rangeSpan * 100;
}

// ── Visual Timeline (SVG) ──────────────────────────────────────────────────────

interface TimelineChartProps { deal: TimelineData; }

function TimelineChart({ deal }: TimelineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; text: string } | null>(null);

  // Normalise extensions: support both new array format and legacy single field
  const extensions: OutsideDateExtension[] = deal.outside_date_extensions ?? (
    deal.outside_date_extended
      ? [{ date: deal.outside_date_extended, extension_months: null, auto: true,
           condition: null, note: deal.outside_date_extension_note ?? null }]
      : []
  );
  const _extDates = extensions.map(e => e.date).filter(Boolean) as string[];
  const lastExtDate = _extDates.length ? _extDates[_extDates.length - 1] : null;

  const ndaDate    = parseDate(deal.nda_date);
  // Include estimated close end in range calculation
  const allEndDates = [lastExtDate, deal.outside_date_initial, deal.estimated_close_end, deal.estimated_close_start].filter(Boolean) as string[];
  const lastDate   = parseDate(allEndDates.sort().pop()!);
  const rangeStart = new Date(ndaDate); rangeStart.setDate(rangeStart.getDate() - 45);
  const rangeEnd   = new Date(lastDate); rangeEnd.setDate(rangeEnd.getDate() + 14);
  const rangeSpan  = rangeEnd.getTime() - rangeStart.getTime();
  const pct = (s: string) => pctOf(s, rangeStart, rangeSpan);
  const todayPct   = (today().getTime() - rangeStart.getTime()) / rangeSpan * 100;
  const tToday     = Math.round((today().getTime() - parseDate(deal.signing_date).getTime()) / 86400000);

  const gridMonths: Date[] = [];
  const cur = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cur <= rangeEnd) { gridMonths.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

  type Milestone = { dateStr: string; row: 'top' | 'bottom'; color: string; tLabel: string; name: string; isFiled?: boolean; };
  const milestones: Milestone[] = [];

  milestones.push({ dateStr: deal.nda_date,     row: 'top',    color: 'rgba(92,207,230,0.6)', tLabel: fmtT(tPlus(deal.signing_date, deal.nda_date)),     name: 'NDA' });
  milestones.push({ dateStr: deal.signing_date, row: 'bottom', color: '#5ccfe6',              tLabel: 'T=0',                                              name: deal.announce_date && deal.announce_date !== deal.signing_date ? 'Signing' : 'Announce' });
  if (deal.announce_date && deal.announce_date !== deal.signing_date) {
    milestones.push({ dateStr: deal.announce_date, row: 'top', color: '#5ccfe6', tLabel: fmtT(tPlus(deal.signing_date, deal.announce_date)), name: 'Announced' });
  }

  // For deadline milestones: prefer filed_date over deadline date
  const proxyEv = deal.deadline_events.find(e => e.trigger_key === 'proxy_filed');
  const hsrEv   = deal.deadline_events.find(e => e.trigger_key === 'hsr_filed');
  const regDlEv = deal.deadline_events.find(e => e.date && (e.label.includes('S-4') || e.label.includes('F-4')));

  const proxyDate = proxyEv?.filed_date || proxyEv?.date;
  const hsrDate   = hsrEv?.filed_date   || hsrEv?.date;
  const regDate   = regDlEv?.filed_date || regDlEv?.date;

  if (hsrDate)   milestones.push({ dateStr: hsrDate,   row: 'top',    color: '#ffcc66', isFiled: !!hsrEv?.filed_date,   tLabel: fmtT(tPlus(deal.signing_date, hsrDate)),   name: 'HSR' });
  if (regDate)   milestones.push({ dateStr: regDate,   row: 'bottom', color: '#ffcc66', isFiled: !!regDlEv?.filed_date, tLabel: fmtT(tPlus(deal.signing_date, regDate)),   name: regDlEv!.label });
  if (proxyDate) milestones.push({ dateStr: proxyDate, row: 'top',    color: proxyEv?.filed_date ? '#87d96c' : '#ffcc66', isFiled: !!proxyEv?.filed_date, tLabel: fmtT(tPlus(deal.signing_date, proxyDate)), name: 'Proxy' });

  milestones.push({ dateStr: deal.outside_date_initial, row: 'bottom', color: '#f07178', tLabel: fmtT(tPlus(deal.signing_date, deal.outside_date_initial)), name: 'Outside Date' });
  extensions.filter(e => e.date).forEach((e, i) => {
    milestones.push({ dateStr: e.date!, row: 'top', color: '#f07178',
      tLabel: fmtT(tPlus(deal.signing_date, e.date!)),
      name: extensions.length > 1 ? `Outside (Ext. ${i+1})` : 'Outside (Ext)' });
  });

  // Estimated close range milestones (purple — distinct from signing cyan and outside red)
  if (deal.estimated_close_start) {
    milestones.push({ dateStr: deal.estimated_close_start, row: 'top', color: '#c3a6ff',
      tLabel: fmtT(tPlus(deal.signing_date, deal.estimated_close_start)), name: 'Est. Close' });
    if (deal.estimated_close_end && deal.estimated_close_end !== deal.estimated_close_start) {
      milestones.push({ dateStr: deal.estimated_close_end, row: 'bottom', color: '#c3a6ff',
        tLabel: fmtT(tPlus(deal.signing_date, deal.estimated_close_end)), name: 'Est. Close (End)' });
    }
  }

  const dOut    = daysFromToday(deal.outside_date_initial);
  const upcoming = [...deal.static_events, ...deal.deadline_events]
    .filter(e => { const d = e.filed_date || e.date; return d && daysFromToday(d) > 0; })
    .sort((a, b) => {
      const da = a.filed_date || a.date!;
      const db = b.filed_date || b.date!;
      return daysFromToday(da) - daysFromToday(db);
    });

  const VW = 1000, VH = 280;
  const AXIS_Y = 140, TOP_LBL_Y = 8, BOT_LBL_BOTTOM = 42;

  return (
    <div className="dma-tl-chart-wrap">
      <div className="dma-alert-bar">
        <span className="dma-deal-name">{deal.deal_name}</span>
        <span className="dma-alert-div">|</span>
        <span className="dma-flag flag-today">{fmtT(tToday)}  TODAY</span>
        <span className="dma-alert-div">|</span>
        <span className={`dma-flag ${dOut < 90 ? 'flag-outside' : 'flag-outside-ok'}`}>
          {dOut < 90 ? '⚠ ' : ''}OUTSIDE: {fmtDate(deal.outside_date_initial)} ({fmtDays(dOut)})
        </span>
        {deal.estimated_close_start && (
          <>
            <span className="dma-alert-div">|</span>
            <span className="dma-flag flag-est-close">
              EST. CLOSE{deal.estimated_close_guidance ? ` (${deal.estimated_close_guidance})` : ''}: {fmtDate(deal.estimated_close_start)}
              {deal.estimated_close_end && deal.estimated_close_end !== deal.estimated_close_start
                ? ` – ${fmtDate(deal.estimated_close_end)}`
                : ''}
            </span>
          </>
        )}
        <span className="dma-alert-div">|</span>
        <span className="dma-flag flag-nextup">
          {upcoming.length
            ? `NEXT: ${upcoming[0].label} (${fmtDays(daysFromToday(upcoming[0].filed_date || (upcoming[0] as DeadlineEvent).date || (upcoming[0] as StaticEvent).date))})`
            : 'NO UPCOMING DEADLINES'}
        </span>
      </div>

      <div className="dma-tl-track-wrap">
        <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="dma-tl-svg" onMouseLeave={() => setTooltip(null)}>
          {gridMonths.map((m, i) => {
            const x = pctOf(m.toISOString().split('T')[0], rangeStart, rangeSpan) / 100 * VW;
            return (
              <g key={i}>
                <line x1={x} y1={0} x2={x} y2={VH} stroke="rgba(255,255,255,0.035)" strokeWidth={1} />
                <text x={x} y={VH - 5} textAnchor="middle" fontSize={9} fill="#5c6370" fontFamily="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif">
                  {m.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
                </text>
              </g>
            );
          })}

          {(() => {
            const l = pct(deal.nda_date) / 100 * VW;
            const r = pct(deal.signing_date) / 100 * VW;
            return <rect x={l} y={0} width={r - l} height={VH} fill="rgba(92,207,230,0.055)" />;
          })()}
          <line x1={0} y1={AXIS_Y} x2={VW} y2={AXIS_Y} stroke="#1a232e" strokeWidth={2} />

          {/* Outside Date Extension range — stripe above axis */}
          {lastExtDate && (() => {
            const l = pct(deal.outside_date_initial) / 100 * VW;
            const r = pct(lastExtDate) / 100 * VW;
            const bandW = Math.max(r - l, 4);
            const bandH = 22;
            const bandY = AXIS_Y - bandH - 3;
            return (
              <g>
                <rect x={l} y={bandY} width={bandW} height={bandH} rx={4}
                  fill="rgba(240,113,120,0.10)" stroke="rgba(240,113,120,0.35)" strokeWidth={1} strokeDasharray="4,3" />
                <text x={l + bandW / 2} y={bandY + bandH / 2 + 3} textAnchor="middle"
                  fontSize={8} fill="rgba(240,113,120,0.7)" fontFamily="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" fontWeight={600}>
                  OUTSIDE DATE EXTENSION
                </text>
              </g>
            );
          })()}

          {/* Estimated Close range — stripe below axis */}
          {deal.estimated_close_start && (() => {
            const l = pct(deal.estimated_close_start) / 100 * VW;
            const r = pct(deal.estimated_close_end || deal.estimated_close_start) / 100 * VW;
            const bandW = Math.max(r - l, 4);
            const bandH = 22;
            const bandY = AXIS_Y + 3;
            return (
              <g>
                <rect x={l} y={bandY} width={bandW} height={bandH} rx={4}
                  fill="rgba(195,166,255,0.12)" stroke="rgba(195,166,255,0.35)" strokeWidth={1} strokeDasharray="4,3" />
                <text x={l + bandW / 2} y={bandY + bandH / 2 + 3} textAnchor="middle"
                  fontSize={8} fill="rgba(195,166,255,0.7)" fontFamily="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" fontWeight={600}>
                  EST. CLOSE WINDOW
                </text>
              </g>
            );
          })()}

          {todayPct >= 0 && todayPct <= 100 && (() => {
            const x = todayPct / 100 * VW;
            const todayLabel = `${fmtT(tToday)} TODAY`;
            const todayBoxW = Math.max(50, todayLabel.length * 5.8 + 14);
            return (
              <g>
                <line x1={x} y1={0} x2={x} y2={VH} stroke="rgba(135,217,108,0.70)" strokeWidth={1} strokeDasharray="5,4" />
                <rect x={x - todayBoxW / 2} y={AXIS_Y - 31} width={todayBoxW} height={16} rx={3} fill="rgba(135,217,108,0.12)" stroke="rgba(135,217,108,0.35)" strokeWidth={0.8} />
                <text x={x} y={AXIS_Y - 19} textAnchor="middle" fontSize={8} fill="#87d96c" fontFamily="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" fontWeight={600}>{todayLabel}</text>
                <rect x={x - 6} y={0} width={12} height={VH} fill="transparent" style={{ cursor: 'crosshair' }}
                  onMouseEnter={() => setTooltip({ x, text: `TODAY · ${fmtDate(today().toISOString().split('T')[0])} · ${fmtT(tToday)}` })}
                />
              </g>
            );
          })()}

          {milestones.map((m, i) => {
            const x  = pct(m.dateStr) / 100 * VW;
            const isTop = m.row === 'top';
            const connY1 = isTop ? TOP_LBL_Y + 42 : AXIS_Y + 4;
            const connY2 = isTop ? AXIS_Y - 4     : VH - BOT_LBL_BOTTOM - 42;
            const lblY   = isTop ? TOP_LBL_Y       : VH - BOT_LBL_BOTTOM - 42;
            const lblX   = Math.min(x - 55, VW - 112);
            const dtd    = daysFromToday(m.dateStr);
            const filedMark = m.isFiled ? ' ✓' : '';
            return (
              <g key={i}>
                <line x1={x} y1={connY1} x2={x} y2={connY2} stroke={m.color} strokeWidth={1} opacity={0.45} />
                <circle cx={x} cy={AXIS_Y} r={m.isFiled ? 5 : 4} fill={m.color}
                  style={{ cursor: 'pointer', filter: `drop-shadow(0 0 4px ${m.color})` }}
                  onMouseEnter={() => setTooltip({ x, text: `${m.name}${filedMark}  ·  ${fmtDate(m.dateStr)}  ·  ${m.tLabel}  ·  ${fmtDays(dtd)}` })}
                  onMouseLeave={() => setTooltip(null)}
                />
                <foreignObject x={lblX} y={lblY} width={110} height={42} style={{ overflow: 'visible' }}>
                  <div className="dma-tl-lbl" style={{ borderColor: m.color }}>
                    <span className="dma-tl-lbl-t" style={{ color: m.color }}>{m.tLabel}{filedMark}</span>
                    <span className="dma-tl-lbl-name" style={{ color: m.color }}>{m.name}</span>
                    <span className="dma-tl-lbl-date">{fmtDate(m.dateStr)}</span>
                  </div>
                </foreignObject>
              </g>
            );
          })}

          {tooltip && (() => {
            const tx = Math.min(Math.max(tooltip.x, 90), VW - 90);
            return (
              <g>
                <rect x={tx - 110} y={8} width={220} height={20} rx={3} fill="#151c24" stroke="#1a232e" />
                <text x={tx} y={21} textAnchor="middle" fontSize={9} fill="#e6e6e6" fontFamily="'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif">{tooltip.text}</text>
              </g>
            );
          })()}
        </svg>
      </div>

      <div className="dma-legend">
        <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: '#5ccfe6' }} />{deal.announce_date && deal.announce_date !== deal.signing_date ? 'Signing / Announced' : 'Announce'}</div>
        <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: 'rgba(92,207,230,0.45)' }} />NDA</div>
        <div className="dma-legend-item"><div className="dma-lg-bar dma-lg-today" />Today</div>
        <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: '#ffcc66' }} />Filing Deadline</div>
        <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: '#87d96c' }} />Filed ✓</div>
        <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: '#f07178' }} />Outside Date{lastExtDate ? ' + Extension' : ''}</div>
        {deal.estimated_close_start && <div className="dma-legend-item"><div className="dma-lg-bar" style={{ background: '#c3a6ff' }} />Est. Close Range</div>}
      </div>
    </div>
  );
}

// ── Table rows ─────────────────────────────────────────────────────────────────

type RowKind = 'static' | 'deadline' | 'trigger-head' | 'trigger-result' | 'regulatory';
interface TableRow {
  label: string;
  subLabel?: string;
  date: string | null;         // primary display date
  deadlineDate?: string | null; // secondary (contractual deadline) — only when filed_date set
  ref: string | null;
  kind: RowKind;
  isFiled?: boolean;
  trigger_key?: string | null;
  source?: string | null;      // document source attribution
  regStatus?: string | null;   // regulatory tracker status
}

function buildRows(data: TimelineData, filter: string): TableRow[] {
  const rows: TableRow[] = [];

  if (filter === 'all' || filter === 'static') {
    data.static_events.filter(e => e.date).forEach(e => rows.push({ label: e.label, date: e.date, ref: e.ref, kind: 'static', source: e.source }));
  }

  if (filter === 'all' || filter === 'deadline') {
    data.deadline_events.filter(e => e.date || e.filed_date).forEach(e => {
      const isFiled = !!e.filed_date;
      rows.push({
        label:        e.label,
        subLabel:     !isFiled && e.calculation && e.calculation !== 'Date not yet disclosed' ? e.calculation : undefined,
        date:         isFiled ? e.filed_date! : e.date,
        deadlineDate: isFiled ? e.date : undefined,
        ref:          e.ref,
        kind:         'deadline',
        isFiled,
        trigger_key:  e.trigger_key,
      });
    });
  }

  // Regulatory approvals as rows — use tracker status/dates when available
  if (filter === 'all' || filter === 'static') {
    (data.regulatory_approvals || []).forEach(a => {
      const effectiveDate = a.cleared_date || a.filed_date || null;
      rows.push({
        label: a.name + (a.jurisdiction ? ` (${a.jurisdiction})` : ''),
        subLabel: a.notes || undefined,
        date: effectiveDate,
        ref: null,
        kind: 'regulatory',
        source: 'press_release',
        isFiled: !!(a.cleared_date || a.filed_date),
        regStatus: a.status || null,
      });
    });
  }

  // Sort static + deadline rows chronologically (dated first, then regulatory/TBD last)
  rows.sort((a, b) => {
    if (a.date && b.date) return parseDate(a.date).getTime() - parseDate(b.date).getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  // Triggered chains appended after — they stay grouped by chain
  if (filter === 'all' || filter === 'triggered') {
    data.triggered_chains.forEach(chain => {
      rows.push({
        label:  '⏳ ' + chain.trigger_label,
        date:   chain.trigger_date || null,
        ref:    null,
        kind:   'trigger-head',
        isFiled: !!chain.trigger_date,
      });
      chain.downstream.forEach(ds => rows.push({
        label:    '↳ ' + ds.label,
        subLabel: ds.rule,
        date:     ds.resolved_date || null,
        ref:      ds.ref,
        kind:     'trigger-result',
      }));
    });
  }

  return rows;
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props { dealId: string; onGenerateClick: () => void; generating: boolean; refreshKey?: number; }

export default function DMATimeline({ dealId, onGenerateClick, generating, refreshKey }: Props) {
  const [data,          setData]          = useState<TimelineData | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [notFound,      setNotFound]      = useState(false);
  const [checked,       setChecked]       = useState<Set<number>>(new Set());
  const [dateFilter,    setDateFilter]    = useState<string>('all');
  const [checklistOpen, setChecklistOpen] = useState(false);

  useEffect(() => {
    setLoading(true); setNotFound(false); setData(null);
    fetch(`http://localhost:8000/api/deals/${dealId}/dma-timeline-data`)
      .then(async r => {
        if (r.status === 404) { setNotFound(true); return; }
        setData(await r.json());
      }).catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [dealId, refreshKey]);

  const toggleCheck = (i: number) => setChecked(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  if (loading)  return <div className="dma-tl-loading">Loading timeline data…</div>;

  if (notFound) return (
    <div className="dma-tl-empty">
      <p>No timeline data found for this deal.</p>
      <p className="dma-tl-hint">Click Generate to build from an existing DMA extract, or paste the DMA summary via Document Input on the Financial Overview tab.</p>
      <button className="dma-tl-generate-btn" onClick={onGenerateClick} disabled={generating}>
        {generating ? 'Generating...' : 'Generate Now'}
      </button>
    </div>
  );

  if (!data) return null;

  const outsideDate = data.outside_date_initial;
  const rows = buildRows(data, dateFilter);
  const extensions: OutsideDateExtension[] = data.outside_date_extensions ?? (
    data.outside_date_extended
      ? [{ date: data.outside_date_extended, extension_months: null, auto: true,
           condition: null, note: data.outside_date_extension_note ?? null }]
      : []
  );

  return (
    <div className="dma-tl">

      {/* ── Visual Timeline ── */}
      <div className="dma-section">
        <div className="dma-section-hdr">
          Visual Timeline
          <span className="dma-section-hdr-note">T=0 = {data.announce_date && data.announce_date !== data.signing_date ? 'Signing' : 'Announce'} · {fmtDate(data.signing_date)}</span>
        </div>
        <TimelineChart deal={data} />
      </div>

      {/* ── Dates Table ── */}
      <div className="dma-section">
        <div className="dma-section-hdr">Dates</div>
        <div className="dma-filters">
          {(['all', 'static', 'deadline', 'triggered'] as const).map(f => (
            <button key={f}
              className={`dma-filter-btn ${dateFilter === f ? 'active' : ''}`}
              onClick={() => setDateFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'static' ? 'Static' : f === 'deadline' ? 'Deadlines' : 'Triggered'}
            </button>
          ))}
        </div>
        <table className="dma-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Date</th>
              <th>T+N</th>
              <th>From Today</th>
              <th>To Outside</th>
              <th>Status</th>
              <th>Ref</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const dtd    = row.date ? daysFromToday(row.date) : null;
              const dto    = row.date ? daysBetween(row.date, outsideDate) : null;
              const tp     = row.date ? tPlus(data.signing_date, row.date) : null;
              const isPast = row.date ? dtd! < 0 : false;

              let rowClass = '';
              if      (row.isFiled && row.kind === 'deadline')  rowClass = 'row-filed';
              else if (isPast && row.kind === 'deadline')        rowClass = 'row-overdue';
              else if (row.kind === 'static')                    rowClass = 'row-static';
              else if (row.kind === 'deadline')                  rowClass = 'row-deadline';
              else if (row.kind === 'trigger-head' && row.isFiled) rowClass = 'row-filed';
              else if (row.kind === 'trigger-head')              rowClass = 'row-trigger';
              else if (row.kind === 'trigger-result')            rowClass = 'row-trigger-result';
              else if (row.kind === 'regulatory') {
                const rs = row.regStatus;
                if (rs === 'cleared' || rs === 'cleared_with_conditions') rowClass = 'row-filed';
                else if (rs === 'blocked') rowClass = 'row-overdue';
                else rowClass = 'row-regulatory';
              }

              let badge: React.ReactNode = null;
              if (row.kind === 'static') {
                badge = isPast
                  ? <span className="dma-badge badge-muted">PAST</span>
                  : <span className="dma-badge badge-blue">FIXED</span>;
              } else if (row.kind === 'deadline') {
                if (row.isFiled)
                  badge = <span className="dma-badge badge-green">FILED</span>;
                else if (isPast)
                  badge = <span className="dma-badge badge-red">OVERDUE</span>;
                else if (!row.date)
                  badge = <span className="dma-badge badge-muted">TBD</span>;
                else
                  badge = <span className="dma-badge badge-yellow">PENDING</span>;
              } else if (row.kind === 'regulatory') {
                const rs = row.regStatus;
                if (rs === 'cleared' || rs === 'cleared_with_conditions')
                  badge = <span className="dma-badge badge-green">{rs === 'cleared_with_conditions' ? 'CLEARED*' : 'CLEARED'}</span>;
                else if (rs === 'filed' || rs === 'under_review')
                  badge = <span className="dma-badge badge-blue">{rs === 'under_review' ? 'REVIEW' : 'FILED'}</span>;
                else if (rs === 'phase2')
                  badge = <span className="dma-badge badge-yellow">PHASE 2</span>;
                else if (rs === 'blocked')
                  badge = <span className="dma-badge badge-red">BLOCKED</span>;
                else
                  badge = <span className="dma-badge badge-yellow">PENDING</span>;
              } else if (row.kind === 'trigger-head') {
                badge = row.isFiled
                  ? <span className="dma-badge badge-green">FILED</span>
                  : <span className="dma-badge badge-muted">AWAITING</span>;
              } else {
                badge = row.date
                  ? <span className="dma-badge badge-blue">EST.</span>
                  : <span className="dma-badge badge-muted">PENDING</span>;
              }

              const tpColor  = tp  === null ? 'var(--text-muted)' : tp  < 0 ? 'var(--text-secondary)' : 'var(--text-primary)';
              const dtdColor = dtd === null ? 'var(--text-muted)' : dtd < 0 ? '#f07178' : dtd === 0 ? '#87d96c' : 'var(--text-primary)';

              return (
                <tr key={i} className={rowClass}>
                  <td>
                    {row.label}
                    {row.source && <span className="dma-source-tag">{row.source === 'press_release' ? 'PR' : row.source === 'dma_extract' ? 'DMA' : row.source.toUpperCase()}</span>}
                    {row.subLabel && <span className="dma-sub-label">{row.subLabel}</span>}
                  </td>
                  <td className="mono">
                    {row.date
                      ? <span style={{ color: row.isFiled ? '#87d96c' : undefined }}>
                          {row.isFiled ? '✓ ' : ''}{fmtDate(row.date)}
                        </span>
                      : <span className="muted">TBD</span>
                    }
                    {row.deadlineDate && (
                      <span className="dma-sub-label muted">Due: {fmtDate(row.deadlineDate)}</span>
                    )}
                  </td>
                  <td className="mono">
                    {tp !== null
                      ? <span style={{ color: tpColor, fontWeight: 600 }}>{fmtT(tp)}</span>
                      : <span className="muted">—</span>
                    }
                  </td>
                  <td className="mono">
                    {dtd !== null
                      ? <span style={{ color: dtdColor }}>{fmtDays(dtd)}</span>
                      : <span className="muted">—</span>
                    }
                  </td>
                  <td className="mono">
                    {dto !== null && dto !== 0
                      ? <span className="muted">{fmtDays(dto)}</span>
                      : <span className="muted">—</span>
                    }
                  </td>
                  <td>{badge}</td>
                  <td className="mono muted">{row.ref || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {extensions.filter(e => e.note || e.condition).map((e, i) => (
          <div key={i} className="dma-ext-note">
            <span className="dma-ext-label">
              {extensions.length > 1 ? `Ext. ${i+1}${e.auto ? ' (Auto)' : ' (Consent)'}:` : `Extension${e.auto ? ' (Auto)' : ' (Consent)'}:`}
            </span>{' '}
            {e.note || e.condition}
          </div>
        ))}
        {/* Legacy single-extension note */}
        {extensions.length === 0 && (data.outside_date_extension_note || data.extension_note) && (
          <div className="dma-ext-note">
            <span className="dma-ext-label">Extension Note:</span> {data.outside_date_extension_note || data.extension_note}
          </div>
        )}
      </div>

      {/* ── Triggered Date Chains ── */}
      <div className="dma-section">
        <div className="dma-section-hdr">Triggered Date Chains</div>
        <div className="dma-chains">
          {data.triggered_chains.map((chain, i) => (
            <div key={i} className="dma-chain">
              <div className={`dma-chain-trigger ${chain.trigger_date ? 'filed' : ''}`}>
                {chain.trigger_date ? '✓' : '⏳'} {chain.trigger_label}
                {chain.trigger_date && (
                  <span className="dma-chain-trigger-date">{fmtDate(chain.trigger_date)}</span>
                )}
              </div>
              <div className="dma-chain-ds-wrap">
                {chain.downstream.map((item, j) => (
                  <div key={j} className="dma-chain-ds">
                    <span className="dma-chain-arrow">→</span>
                    <div>
                      <div className="dma-chain-ds-label">
                        {item.label}
                        {item.resolved_date && (
                          <span className="dma-chain-resolved">{fmtDate(item.resolved_date)}</span>
                        )}
                      </div>
                      <div className="dma-chain-ds-rule">{item.rule}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {data.extension_note && (
            <div className="dma-chain">
              <div className="dma-chain-trigger">📋 Outside Date Extension</div>
              <div className="dma-chain-ds-wrap">
                <div className="dma-chain-ds">
                  <span className="dma-chain-arrow">→</span>
                  <div>
                    <div className="dma-chain-ds-label">No fixed extension length</div>
                    <div className="dma-chain-ds-rule">{data.extension_note}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Checklist ── */}
      <div className="dma-section">
        <div className="dma-section-hdr">
          Items to Collect
          <div className="dma-checklist-right">
            <span>{checked.size} / {data.checklist.length} collected</span>
            <button className="dma-toggle-btn" onClick={() => setChecklistOpen(o => !o)}>
              {checklistOpen ? 'COLLAPSE' : 'EXPAND'}
            </button>
          </div>
        </div>
        {checklistOpen && (
          <div className="dma-checklist">
            {data.checklist.map((item, i) => (
              <div key={i} className={`dma-check-item ${checked.has(i) ? 'done' : ''}`} onClick={() => toggleCheck(i)}>
                <div className="dma-check-box">{checked.has(i) ? '✓' : ''}</div>
                <span className="dma-check-label">{item}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
