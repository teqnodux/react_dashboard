# Scorecard Signal Plan — Data Sources & Computation Method

## Approach
- **Pre-computed signals**: Where we have structured data, compute the answer BEFORE Claude sees it
- **Text-extraction signals**: Where we need Claude to read proxy/DMA text, send targeted context
- **Estimated signals**: Where we lack data entirely, Claude estimates with `estimated: true`

## Architecture — Group-by-Group LLM Calls

Instead of one massive prompt with all data + all 46 signals, we make focused calls:

| Call | Signals | Context Sent | Pre-computed Fields |
|------|---------|-------------|---------------------|
| 1. Context Panels | Deal Overview + Deal Protection | yfinance info + DMA extract | MCap, revenue, fees, go-shop |
| 2. PD-A: Initiation | A1-A5 | Proxy fulsome only | — |
| 3. PD-B: Premium | B1-B5 | Pre-computed values + proxy bid timeline + DMA | B1 premium, B2 vs 52w, B4 cash% |
| 4. PD-C: Protective | C1-C7 | DMA extract + termination + covenants | C1 RTF% |
| 5. PD-D: Market | D1-D5 | Pre-computed yfinance values | All D1-D5 |
| 6. RR-A: Structural | A1-A6 | Regulatory timeline + DMA | A1 count, A3 cross-border count |
| 7. RR-B: Agreement | B1-B6 | DMA extract + termination + covenants | B1 outside date, B3 RTF% |
| 8. RR-C: Conditionality | C1-C5 | DMA extract + covenants + termination | — |
| 9. RR-D: External | D1-D7 | Regulatory timeline + LLM general knowledge | — |

**Benefits**: Each call gets ~5-10K context instead of ~50K. More accurate answers, cheaper, faster.
**PD-D can potentially skip the LLM entirely** — just apply rubric to pre-computed values programmatically.

---

## CONTEXT PANELS (displayed at top of scorecard, not scored)

### Deal Overview Panel
| Field | Source | Example (PEN/BSX) |
|-------|--------|--------------------|
| Industry | yfinance: info.industry | Medical Devices |
| Sector | yfinance: info.sector | Healthcare |
| Target MCap | yfinance: info.marketCap | $12.4B |
| Acquirer MCap | yfinance: acquirer info.marketCap | $128.6B |
| Target Revenue | yfinance: info.totalRevenue | $2.1B |
| Target EBITDA | yfinance: info.ebitda | $320M |
| Closest Competitors | LLM knowledge based on industry | MDT, SYK, ABT |
| Combined Overlap | LLM reads proxy/10-K + industry knowledge | Neuro, Vascular |

### Deal Protection Panel
| Field | Source | Example (PEN/BSX) |
|-------|--------|--------------------|
| Structure | DMA: go_shop_days (>0 = Go-Shop, 0/null = No-Shop) + covenants | No-Shop |
| Go-Shop Duration | DMA: go_shop_days | None |
| Fiduciary Out | Covenants: no_shop___go_shop.fiduciary_out_present/scope | Standard |
| Match Right | Covenants: matching_timeframe | 4 business days |
| Target Break Fee | DMA: target_break_fee_mm + pre-compute % TEV | $525M (3.5% TEV) |
| Reverse Break Fee | DMA: acquirer_reverse_break_fee_mm + pre-compute % TEV | $900M (6.0% TEV) |
| Outside Date | DMA: outside_date | Jan 14, 2027 |
| Extension | DMA: outside_date_extension + condition | +12 months for regulatory |

---

## DEAL POWER DYNAMICS (22 signals, max 110)

### A. Initiation & Alternatives (A1-A5)
**Context sent to Claude**: Proxy fulsome summary only (merger background, process structure, bid timeline sections)

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| A1 | Who Initiated Contact | LLM reads proxy | Proxy: Chronological Summary / Starting Point | Ticker of initiator | BSX |
| A2 | Time from NDA to Signing | LLM reads proxy | Proxy: Starting Point date → signing date | N Days | 17 Days |
| A3 | Competitive Process | LLM reads proxy | Proxy: Process Structure + Sales Process Metrics | Type (N parties) | Bilateral (0 parties contacted) |
| A4 | Target's Standalone Viability | LLM reads proxy | Proxy: Board rationale + financial context | One-liner assessment | Strong — no activist pressure |
| A5 | Industry Buyer Universe | LLM reads proxy | Proxy: Sales Process Metrics + board assessment | Count + qualifier | 1 realistic buyer, no other interest |

### B. Premium & Consideration Structure (B1-B5)
**Context sent to Claude**: Pre-computed values + proxy bid timeline for B3 + DMA for B5

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| B1 | Headline Premium (vs unaffected) | Pre-compute | deals.json: (offer - unaffected) / unaffected | N.N% | 18.8% |
| B2 | Premium vs 52-Week High | Pre-compute | yfinance 52w_high + offer price | N.N% above/below | -2.3% below |
| B3 | Price Movement During Negotiation | LLM reads proxy | Proxy: Complete Bid Timeline | +$N (+N.N%) | +$9 (+2.5%) |
| B4 | Cash as % of Total | Pre-compute | deals.json: cash/offer or cash/(cash + ratio*acq_price) | N% cash | 73% cash |
| B5 | Collar or Walk-Away on Buyer Stock | LLM reads DMA/proxy | DMA source text + proxy consideration section | Descriptor | No collar — fixed ratio |

### C. Protective Terms (C1-C7)
**Context sent to Claude**: DMA extract + termination assessment + covenant provisions

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| C1 | RTF as % of Deal Value | Pre-compute | DMA: acquirer_reverse_break_fee_mm ÷ equity value | $NM (N.N% TEV) | $900M (6.0% TEV) |
| C2 | RTF Trigger Breadth | LLM reads DMA/termination | Termination triggers + fee implications | Descriptor | Denial + conditions + End Date |
| C3 | Ticking Fee / Consideration Increase | LLM reads DMA | DMA source text | Descriptor or "None" | None |
| C4 | Fiduciary Out Breadth | LLM reads DMA/covenants | Covenant provisions: no_shop/go_shop | Descriptor | Standard fiduciary out |
| C5 | Match Right Duration (biz days) | LLM reads DMA/covenants | Covenant provisions: matching_timeframe | N business days | 4 business days |
| C6 | Specific Performance Right | LLM reads DMA | DMA source text | Descriptor | Full specific performance |
| C7 | Appraisal Rights | LLM reads proxy/DMA | Proxy appraisal section | Descriptor | Available, low dissent risk |

### D. Market Signal (D1-D5)
**Pre-computed from yfinance** — Claude only scores based on rubric

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| D1 | Target Reaction to Announcement | Pre-compute | yfinance: announce-day price change | +/-N.N% | +18.7% |
| D2 | Buyer Reaction to Announcement | Pre-compute | yfinance: acquirer announce-day change | +/-N.N% | -3.2% |
| D3 | Current Spread | Pre-compute | yfinance: (offer - current) / current | N.N% | 2.1% |
| D4 | Institutional Ownership Shift | Pre-compute | yfinance: heldPercentInstitutions | N.N% institutional | 88.2% institutional |
| D5 | Short Interest Trend | Pre-compute | yfinance: sharesShort vs prior month | Direction + N shares | Down 826K shares |

---

## REGULATORY RISK (24 signals, max 120)

### A. Structural Complexity (RR-A1 to A6)
**Context sent to Claude**: Regulatory timeline JSON + DMA extract

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| RR-A1 | Number of Required Approvals | Pre-compute | Regulatory timeline: count of approvals | N | 15 |
| RR-A2 | Substantive Review Agencies | LLM reads regulatory + DMA | Regulatory timeline + agency profiles | N (list) | 3 (DOJ, EC, SAMR) |
| RR-A3 | Cross-Border Exposure | Pre-compute | Regulatory timeline: non-US jurisdictions | N foreign jurisdictions | 7 foreign jurisdictions |
| RR-A4 | Novel Regulatory Framework | LLM (general knowledge) | Industry + agency context | Descriptor | Well-established precedent |
| RR-A5 | Parallel vs Sequential | LLM reads DMA/regulatory | DMA + dependency analysis | Descriptor | Mostly parallel, 1 dependency |
| RR-A6 | HSR Filing Deadline | LLM reads DMA | DMA source text: HSR filing obligation | Descriptor | Within 10 business days |

### B. Agreement Structure Signals (RR-B1 to B6)
**Context sent to Claude**: DMA extract + termination + covenant provisions

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| RR-B1 | Outside Date Length | Pre-compute | DMA: outside_date - announce_date | N months | 12 months |
| RR-B2 | End Date Extension | LLM reads DMA | DMA source text: extension provisions | Type + length | Auto for regulatory, +6 months |
| RR-B3 | RTF Size (% TEV) | Pre-compute | Same as PD-C1 | $NM (N.N% TEV) | $900M (6.0% TEV) |
| RR-B4 | Efforts Standard | LLM reads DMA/covenants | DMA source text: regulatory covenant | Descriptor | RBE with narrow carveout |
| RR-B5 | Burdensome Condition Walk-Away | LLM reads DMA | DMA source text: MBRC definition | Descriptor | Partially hidden in schedules |
| RR-B6 | Divestiture Caps | LLM reads DMA/proxy | DMA + proxy regulatory commitments | Descriptor + amount | Up to $300M revenue |

### C. Conditionality Architecture (RR-C1 to C5)
**Context sent to Claude**: DMA extract + covenant provisions + termination

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| RR-C1 | Condition Asymmetry | LLM reads DMA | DMA: conditions_to_closing | Descriptor | 1 buyer-only condition |
| RR-C2 | Requisite vs Total Approvals Gap | LLM reads DMA/regulatory | DMA: requisite vs total approvals list | N requisite / N total | 8 / 15 |
| RR-C3 | Voting Trust Structure | LLM reads DMA | DMA source text | Descriptor | Not addressed |
| RR-C4 | Pre-Committed Remedies | LLM reads DMA/proxy | DMA + proxy: remedy commitments | Descriptor | $300M divestiture cap |
| RR-C5 | Anti-Frustration + Willful Breach | LLM reads DMA/termination | DMA + termination provisions | Descriptor | Standard anti-frustration |

### D. External Risk Factors (RR-D1 to D7)
**Context sent to Claude**: Regulatory timeline + general knowledge — these are mostly LLM judgment calls

| ID | Signal | Method | Data Source | short_answer format | Example (PEN/BSX) |
|----|--------|--------|-------------|--------------------|--------------------|
| RR-D1 | Political Environment | LLM (general knowledge) | Industry context + news | Descriptor | Neutral |
| RR-D2 | Known Opposition Filed | LLM (general knowledge) | News / agency dockets | Descriptor | No opposition filed |
| RR-D3 | Precedent Transaction Outcome | LLM (general knowledge) | Historical deal precedent | Descriptor | Recent comparable approved clean |
| RR-D4 | Competitive Overlap | LLM reads proxy/10-K | Industry analysis + deal context | Descriptor | Significant horizontal overlap |
| RR-D5 | Agency Capacity / Timeline Stress | LLM (general knowledge) | Agency workload context | Descriptor | Normal workload |
| RR-D6 | Litigation Control | LLM reads DMA | DMA source text: litigation provisions | Descriptor | Joint control |
| RR-D7 | Buyer's Regulatory Track Record | LLM (general knowledge) | Historical deal outcomes | Descriptor | Clean record |

---

## Notes
- File created 2026-03-12 to preserve signal planning discussion
- Previous session's work on this was lost in a crash on 2026-03-11
