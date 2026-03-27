// TypeScript types matching backend models

export type DealCategory =
  | "Mkt Perceived as Low-risk / Near-Term Timing"
  | "Mkt Perceived as Low-risk / Mid-to-Long-Term Timing"
  | "Mkt Perceived as Higher-risk"
  | "Fluctuating Consideration / CVRs / Hard to Borrow"
  | "LBOs"
  | "Bank Deals"
  | "Proposed / Non-definitive";

export type DealStatus =
  | "pending"
  | "regulatory_review"
  | "shareholder_vote"
  | "closing"
  | "at_risk"
  | "completed";

export interface Deal {
  id: string;
  target: string;
  target_ticker: string;
  acquirer: string;
  acquirer_ticker: string;
  deal_value_bn: number;
  deal_type: string;
  category: DealCategory;

  // Pricing
  offer_price: number;
  current_price: number;
  unaffected_price: number;

  // Costs
  borrow_rate_annual: number;
  dividend_expected: number;

  // Consideration breakdown
  cash_per_share: number;
  stock_ratio: number;
  cvr_per_share: number;
  special_div: number;

  // Beta adjustment
  spy_at_announce: number;

  // Dates
  announce_date: string; // ISO date string
  expected_close: string; // ISO date string
  outside_date: string | null;

  // Status
  status: DealStatus;
  regulatory_bodies: string[];
  next_milestone: string;
  next_milestone_date: string | null;

  // Calculated fields
  gross_spread_dollars: number;
  gross_spread_pct: number;
  days_to_close: number;
  borrow_cost_to_close: number;
  net_spread_dollars: number;
  net_spread_pct: number;
  annualized_gross: number;
  annualized_net: number;

  notes: string | null;
}

export interface DashboardSummary {
  total_deals: number;
  total_value_bn: number;
  at_risk_count: number;
  avg_gross_spread: number;
}

export interface Pagination {
  page: number;
  page_size: number;
  total_deals: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface DealsResponse {
  deals: Deal[];
  summary: DashboardSummary;
  pagination: Pagination;
}

export interface DMAClause {
  topic: string;
  concise: string;
  fulsome: string;
  clause_text: string;
  references: string[];
}

export interface DMASection {
  name: string;
  clauses: DMAClause[];
}

// New separate format for concise/fulsome
export interface SimpleDMAClause {
  text: string;
  references: string[];
}

export interface SimpleDMASection {
  name: string;
  clauses: SimpleDMAClause[];
}

export interface TimelineEvent {
  event_date: string;
  event_type: string;
  title: string;
  description: string;
  status: string;
}

export interface RegulatoryEvent {
  agency: string;
  event: string;
  event_date: string | null;
  status: string;
  notes: string;
}

export interface DocketEntry {
  entry_no: number;
  received_date: string;
  title: string;
  relevance_level: string;
  filer_role: string;
  filer_name: string;
  position_on_deal: string;
  entry_summary: string;
  key_arguments: string[];
  cumulative_impact: string;
  download_link: string;
  opposition_type?: string;
  intervenor_type?: string;
  key_excerpts?: string[];
}

export interface DocketStakeholder {
  name: string;
  role: string;
  filing_count: number;
  position: string;
  opposition_type: string;
  status: string;
  intervenor_type?: string;
}

export interface DocketCondition {
  text: string;
  status: string;
  source: string;
}

export interface SECFiling {
  filing_type: string;
  filed_date: string;
  description: string;
  sec_url: string;
  summary: string;
  accession_number?: string;
  sections?: Record<string, string>;
  documents?: Array<{
    seq: number;
    description: string;
    filename: string;
    doc_type: string;
    url: string;
  }>;
}

export interface ProxyFiling {
  filing_type: string;
  filed_date: string;
  description: string;
  sec_url: string;
  is_amendment: boolean;
  amendment_number: number;
  shareholder_dates: string;
  consideration_details: string;
  regulatory_updates: string;
  closing_guidance: string;
  background_summary: string;
  other_items: string;
  changes_summary: string;
}

// AI Summary types for the batch summarizer output
export interface AISummaryL3Detailed {
  [key: string]: any;
}

export interface AISummarySummary {
  L1_headline: string;
  L2_brief: string;
  L3_detailed: AISummaryL3Detailed;
  items_reported?: string[];
  ticker?: string;
  filing_date?: string;
  filing_type?: string;
  // Form 4 specific
  insider_name?: string;
  insider_title?: string;
  relationship?: string;
  issuer?: string;
  // Form 144 specific
  seller_name?: string;
  seller_relationship?: string;
  // SC 13D specific
  filer_name?: string;
  subject_company?: string;
  filer_type?: string;
}

export interface AISummaryResult {
  index: number;
  date: string;
  form_type: string;
  url: string;
  ticker: string;
  summary: AISummarySummary;
  _company?: string;
  _slug?: string;
  _filename?: string;
}

export interface AISummaryResponse {
  company: string;
  total_filings: number;
  results: AISummaryResult[];
}

export interface SecAIAllResponse {
  filings: AISummaryResult[];
  total: number;
  companies: number;
  by_type: { type: string; count: number }[];
}

export interface DealDetail extends Deal {
  dma_sections: DMASection[];
  concise_sections?: SimpleDMASection[]; // New separate format
  fulsome_sections?: SimpleDMASection[]; // New separate format
  timeline_events: TimelineEvent[];
  regulatory_timeline: RegulatoryEvent[];
  docket_entries: DocketEntry[];
  docket_stakeholders: DocketStakeholder[];
  docket_conditions: DocketCondition[];
  docket_metadata: {
    docket_number?: string;
    case_name?: string;
    jurisdiction?: string;
    status?: string;
  };
  sec_filings: SECFiling[];
  ai_sec_filings?: AISummaryResult[];
  proxy_filings: ProxyFiling[];
  spread_history: Array<{
    date: string;
    target_price: number;
    acquirer_price?: number;
    offer_value: number;
    spread_dollars: number;
    spread_pct: number;
  }>;
}

// Proxy Analysis types
export interface ProxyAnalysisItem {
  label: string;
  value: string;
  was?: string;
  now?: string;
  tag?: string | null;
}

export interface ProxyAnalysisSection {
  name: string;
  has_changes: boolean;
  items: ProxyAnalysisItem[];
  raw_text?: string | null;
}

export interface ProxyAnalysisQA {
  question: string;
  answer: string;
}

export interface ProxyBackgroundItem {
  number: number;
  text: string;
}

export interface ProxyBackground {
  header: string;
  chronological_summary: string;
  items: ProxyBackgroundItem[];
}

export interface ProxyAnalysisFiling {
  ticker: string;
  company: string;
  filing_type: string;
  doc_type: 'summary' | 'changes';
  transition?: string;
  generated: string;
  filename: string;
  overview: string;
  sections: ProxyAnalysisSection[];
  qa_items?: ProxyAnalysisQA[];
  background?: ProxyBackground | null;
}

// 10-K/10-Q Analysis types
export interface TenKExcerpt {
  number: number;
  tags: string[];
  category: string;
  section: string;
  text: string;
}

export interface TenKExecSection {
  name: string;
  items: string[];
}

export interface TenKPhraseChange {
  current: string;
  prior: string;
  analysis: string;
}

export interface TenKCategoryAnalysis {
  category: string;
  text: string;
}

export interface TenKRedlineExcerpt {
  number: number;
  significance: string;
  tags: string[];
  source: string;
  current_label: string;
  prior_label: string;
  is_new: boolean;
  current_text: string;
  prior_text: string;
  phrase_changes: TenKPhraseChange[];
  category_analysis: TenKCategoryAnalysis[];
}

export interface TenKAnalysisFiling {
  company: string;
  ticker: string;
  filing_type: string;
  filing_label?: string;
  transition?: string;
  comparison_header?: string;
  doc_type: 'overview' | 'exec' | 'redline';
  generated: string;
  filename: string;
  overview?: string;
  excerpts?: TenKExcerpt[];
  sections?: TenKExecSection[];
  redline_excerpts?: TenKRedlineExcerpt[];
}