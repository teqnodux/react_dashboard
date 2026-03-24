"""
Data models for Merger Arbitrage Dashboard
Matches structure from generate_dashboard.py
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Optional
from enum import Enum


class DealCategory(Enum):
    LOW_RISK_NEAR_TERM = "Mkt Perceived as Low-risk / Near-Term Timing"
    LOW_RISK_MID_LONG = "Mkt Perceived as Low-risk / Mid-to-Long-Term Timing"
    HIGHER_RISK = "Mkt Perceived as Higher-risk"
    FLUCTUATING_CVR_HTB = "Fluctuating Consideration / CVRs / Hard to Borrow"
    LBO = "LBOs"
    BANK_DEAL = "Bank Deals"
    PROPOSED = "Proposed / Non-definitive"


@dataclass
class DMAClause:
    """A single clause item with three layers of detail."""
    topic: str
    concise: str
    fulsome: str
    clause_text: str
    references: list[str] = field(default_factory=list)


@dataclass
class DMASection:
    """A section of the DMA summary containing multiple clauses."""
    name: str
    clauses: list[DMAClause] = field(default_factory=list)


@dataclass 
class TimelineEvent:
    """A timeline event for the deal."""
    event_date: date
    event_type: str
    title: str
    description: str
    status: str


@dataclass
class RegulatoryEvent:
    """Regulatory timeline event."""
    agency: str
    event: str
    event_date: Optional[date]
    status: str
    notes: str


@dataclass
class SECFiling:
    """General SEC filing (8-K, S-4, DEFM14A, 10-K, etc.)"""
    filing_type: str
    filed_date: date
    description: str
    sec_url: str = ""
    summary: str = ""
    accession_number: str = ""
    sections: dict = field(default_factory=dict)
    documents: list = field(default_factory=list)


@dataclass
class ProxyFiling:
    """Proxy statement filing with structured analyst summary fields.
    Covers S-4, S-4/A, PREM14A, DEFM14A, DEFA14A and amendments.
    """
    filing_type: str
    filed_date: date
    description: str
    sec_url: str = ""
    is_amendment: bool = False
    amendment_number: int = 0
    # Initial filing fields
    shareholder_dates: str = ""
    consideration_details: str = ""
    regulatory_updates: str = ""
    closing_guidance: str = ""
    background_summary: str = ""
    other_items: str = ""
    # Amendment-specific
    changes_summary: str = ""


@dataclass
class DocketStakeholder:
    """Stakeholder in the docket"""
    name: str
    role: str             # Commission, Party, Intervenor
    filing_count: int
    position: str         # Support, Oppose, Neutral
    opposition_type: str  # outright, conditional, ideological
    status: str           # active, settled, withdrawn
    intervenor_type: str = ""  # Business Customer, Special Interest, etc.


@dataclass
class DocketCondition:
    """Condition or commitment"""
    text: str
    status: str           # filed, proposed, required
    source: str           # who proposed it
    category: str = ""    # practical, fallback, demand
    opposition_type: str = ""  # conditional, outright, ideological
    relief_type: str = ""      # Approve_Conditional, Deny_With_Fallback, Deny
    asked_in: Optional[dict] = None    # {entry_no, date, filer}
    resolved_in: Optional[dict] = None # {entry_no, date, filer}


@dataclass
class DocketEntry:
    """Single docket filing entry"""
    entry_no: int
    received_date: date
    title: str
    relevance_level: str  # high, medium, low
    filer_role: str       # Commission, Party, Intervenor, Other
    filer_name: str
    position_on_deal: str  # Support, Oppose, Neutral, Procedural
    entry_summary: str
    key_arguments: list[str] = field(default_factory=list)
    cumulative_impact: str = ""
    download_link: str = ""
    opposition_type: str = ""  # outright, conditional
    intervenor_type: str = ""  # Special Interest, Government, etc.
    key_excerpts: list[str] = field(default_factory=list)


@dataclass
class Deal:
    """Core deal data structure."""
    id: str
    target: str
    target_ticker: str
    acquirer: str
    acquirer_ticker: str
    deal_value_bn: float
    deal_type: str
    category: DealCategory
    
    # Pricing
    offer_price: float
    current_price: float
    unaffected_price: float
    
    # Costs
    borrow_rate_annual: float
    dividend_expected: float

    # Dates
    announce_date: date
    expected_close: date
    outside_date: Optional[date] = None

    # Consideration breakdown
    cash_per_share: float = 0.0
    stock_ratio: float = 0.0
    cvr_per_share: float = 0.0
    special_div: float = 0.0

    # Beta adjustment
    spy_at_announce: float = 0.0

    # Status
    status: str = "pending"
    regulatory_bodies: list[str] = field(default_factory=list)
    next_milestone: str = ""
    next_milestone_date: Optional[date] = None
    
    # Nested data
    dma_sections: list[DMASection] = field(default_factory=list)
    timeline_events: list[TimelineEvent] = field(default_factory=list)
    regulatory_timeline: list[RegulatoryEvent] = field(default_factory=list)
    docket_entries: list[DocketEntry] = field(default_factory=list)
    docket_stakeholders: list[DocketStakeholder] = field(default_factory=list)
    docket_conditions: list[DocketCondition] = field(default_factory=list)
    docket_metadata: dict = field(default_factory=dict)  # docket_number, case_name, etc.
    sec_filings: list[SECFiling] = field(default_factory=list)
    proxy_filings: list[ProxyFiling] = field(default_factory=list)
    
    notes: Optional[str] = None
    
    # Price history for charts
    spread_history: list[dict] = field(default_factory=list)
    
    @property
    def gross_spread_dollars(self) -> float:
        return self.offer_price - self.current_price
    
    @property
    def gross_spread_pct(self) -> float:
        if self.current_price == 0:
            return 0.0
        return (self.gross_spread_dollars / self.current_price) * 100
    
    @property
    def days_to_close(self) -> int:
        return max(1, (self.expected_close - date.today()).days)
    
    @property
    def borrow_cost_to_close(self) -> float:
        return self.current_price * self.borrow_rate_annual * (self.days_to_close / 365)
    
    @property
    def net_spread_dollars(self) -> float:
        return self.gross_spread_dollars - self.borrow_cost_to_close + self.dividend_expected
    
    @property
    def net_spread_pct(self) -> float:
        if self.current_price == 0:
            return 0.0
        return (self.net_spread_dollars / self.current_price) * 100
    
    @property
    def annualized_gross(self) -> float:
        return (self.gross_spread_pct / self.days_to_close) * 365
    
    @property
    def annualized_net(self) -> float:
        return (self.net_spread_pct / self.days_to_close) * 365