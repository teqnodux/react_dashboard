"""
Data loader - imports from existing generate_dashboard.py or recreates needed functions
"""

from pathlib import Path
from datetime import date
import json
import sys

# Try to import from existing code
try:
    # Add parent directory to import generate_dashboard
    parent_dir = Path(__file__).parent.parent
    sys.path.insert(0, str(parent_dir))
    
    from generate_dashboard import (
        Deal, DealCategory, DMAClause, DMASection, 
        TimelineEvent, RegulatoryEvent, ProxyFiling,
        load_deals_from_json as _load_from_json,
        create_sample_deals as _create_sample
    )
    
    def load_deals_from_json():
        return _load_from_json()
    
    def create_sample_deals():
        return _create_sample()
    
except ImportError as e:
    print(f"Warning: Could not import from generate_dashboard.py: {e}")
    print("Using standalone implementation")
    
    # Standalone implementation (fallback)
    from models import Deal, DealCategory, DMAClause, DMASection, TimelineEvent, RegulatoryEvent, DocketEntry, DocketStakeholder, DocketCondition, SECFiling, ProxyFiling
    
    BASE_DIR = Path(__file__).parent.parent
    DATA_DIR = BASE_DIR / "data"
    
    def load_deals_from_json():
        """Load deals from JSON files with detailed data"""
        deals_file = DATA_DIR / "deals.json"

        if not deals_file.exists():
            print(f"No data file found at {deals_file}, using sample data")
            return create_sample_deals()

        with open(deals_file) as f:
            data = json.load(f)

        def parse_date(s):
            if not s:
                return date.today()
            try:
                return date.fromisoformat(s)
            except:
                return date.today()

        deals = []
        for d in data.get("deals", []):
            # Map category
            category_map = {
                "Low-risk / Near-Term": DealCategory.LOW_RISK_NEAR_TERM,
                "Low-risk / Mid-to-Long-Term": DealCategory.LOW_RISK_MID_LONG,
                "Higher Risk": DealCategory.HIGHER_RISK,
                "Fluctuating / CVR / HTB": DealCategory.FLUCTUATING_CVR_HTB,
                "LBO": DealCategory.LBO,
                "Bank Deals": DealCategory.BANK_DEAL,
                "Proposed": DealCategory.PROPOSED,
            }
            category = category_map.get(d.get("category", ""), DealCategory.HIGHER_RISK)

            deal = Deal(
                id=d["id"],
                target=d["target"],
                target_ticker=d["target_ticker"],
                acquirer=d["acquirer"],
                acquirer_ticker=d["acquirer_ticker"],
                deal_value_bn=d.get("deal_value_bn", 0),
                deal_type=d.get("deal_type", "cash"),
                category=category,
                offer_price=d.get("offer_price", 0),
                current_price=d.get("current_price", 0),
                unaffected_price=d.get("unaffected_price", 0),
                borrow_rate_annual=d.get("borrow_rate_annual", 0.05),
                dividend_expected=d.get("dividend_expected", 0),
                announce_date=parse_date(d.get("announce_date")),
                expected_close=parse_date(d.get("expected_close")),
                outside_date=parse_date(d.get("outside_date")) if d.get("outside_date") else None,
                cash_per_share=d.get("_cash", 0.0),
                stock_ratio=d.get("_stock", 0.0),
                cvr_per_share=d.get("_cvr", 0.0),
                special_div=d.get("_special_div", 0.0),
                spy_at_announce=d.get("spy_at_announce", 0.0),
                status=d.get("status", "pending"),
                regulatory_bodies=d.get("regulatory_bodies", []),
                next_milestone=d.get("next_milestone", ""),
                next_milestone_date=parse_date(d.get("next_milestone_date")) if d.get("next_milestone_date") else None,
                notes=d.get("notes", ""),
            )

            # Load spread history
            deal.spread_history = d.get("_spread_history", [])

            # Override with PR-extracted data when available
            deal_id = d["id"]
            backend_data = Path(__file__).parent / "data"
            pr_file = backend_data / "press_release" / f"{deal_id}.json"
            if pr_file.exists():
                try:
                    with open(pr_file) as f:
                        pr_data = json.load(f)
                    ext = pr_data.get("extracted", {})
                    # Use PR midpoint close date if available
                    if ext.get("expected_close_date"):
                        deal.expected_close = parse_date(ext["expected_close_date"])
                    # Use PR deal value if deals.json has 0
                    if ext.get("deal_value_bn") and deal.deal_value_bn == 0:
                        deal.deal_value_bn = ext["deal_value_bn"]
                except Exception as e:
                    print(f"Warning: Error loading PR data for {deal_id}: {e}")

            # Load detailed data from separate files
            details_dir = DATA_DIR / "details"
            dockets_dir = DATA_DIR / "dockets"

            # Load main detail file (timeline, DMA, etc.)
            detail_file = details_dir / f"{deal_id}.json"
            if detail_file.exists():
                try:
                    with open(detail_file) as f:
                        detail_data = json.load(f)

                    # Load timeline events
                    for evt in detail_data.get("timeline_events", []):
                        deal.timeline_events.append(TimelineEvent(
                            event_date=parse_date(evt.get("event_date")),
                            event_type=evt.get("event_type", ""),
                            title=evt.get("title", ""),
                            description=evt.get("description", ""),
                            status=evt.get("status", "")
                        ))

                    # Load DMA sections (try new format first, fall back to old)
                    if "concise_sections" in detail_data and "fulsome_sections" in detail_data:
                        # New format: separate concise and fulsome
                        deal.concise_sections = []
                        deal.fulsome_sections = []

                        for sec in detail_data.get("concise_sections", []):
                            clauses = []
                            for cl in sec.get("clauses", []):
                                clauses.append({
                                    'text': cl.get("text", ""),
                                    'references': cl.get("references", [])
                                })
                            deal.concise_sections.append({
                                'name': sec.get("name", ""),
                                'clauses': clauses
                            })

                        for sec in detail_data.get("fulsome_sections", []):
                            clauses = []
                            for cl in sec.get("clauses", []):
                                clauses.append({
                                    'text': cl.get("text", ""),
                                    'references': cl.get("references", [])
                                })
                            deal.fulsome_sections.append({
                                'name': sec.get("name", ""),
                                'clauses': clauses
                            })
                    else:
                        # Old format: merged dma_sections
                        for sec in detail_data.get("dma_sections", []):
                            clauses = []
                            for cl in sec.get("clauses", []):
                                clauses.append(DMAClause(
                                    topic=cl.get("topic", ""),
                                    concise=cl.get("concise", ""),
                                    fulsome=cl.get("fulsome", ""),
                                    clause_text=cl.get("clause_text", ""),
                                    references=cl.get("references", [])
                                ))
                            deal.dma_sections.append(DMASection(
                                name=sec.get("name", ""),
                                clauses=clauses
                            ))
                    # Load proxy filings
                    for pf in detail_data.get("proxy_filings", []):
                        deal.proxy_filings.append(ProxyFiling(
                            filing_type=pf.get("filing_type", ""),
                            filed_date=parse_date(pf.get("filed_date")),
                            description=pf.get("description", ""),
                            sec_url=pf.get("sec_url", ""),
                            is_amendment=pf.get("is_amendment", False),
                            amendment_number=pf.get("amendment_number", 0),
                            shareholder_dates=pf.get("shareholder_dates", ""),
                            consideration_details=pf.get("consideration_details", ""),
                            regulatory_updates=pf.get("regulatory_updates", ""),
                            closing_guidance=pf.get("closing_guidance", ""),
                            background_summary=pf.get("background_summary", ""),
                            other_items=pf.get("other_items", ""),
                            changes_summary=pf.get("changes_summary", ""),
                        ))

                except Exception as e:
                    print(f"Error loading details for {deal_id}: {e}")

            # Load regulatory timeline
            reg_file = details_dir / f"{deal_id}_regulatory.json"
            if reg_file.exists():
                try:
                    with open(reg_file) as f:
                        reg_data = json.load(f)
                    for evt in reg_data.get("regulatory_timeline", []):
                        deal.regulatory_timeline.append(RegulatoryEvent(
                            agency=evt.get("agency", ""),
                            event=evt.get("event", ""),
                            event_date=parse_date(evt.get("event_date")) if evt.get("event_date") else None,
                            status=evt.get("status", ""),
                            notes=evt.get("notes", "")
                        ))
                except Exception as e:
                    print(f"Error loading regulatory data for {deal_id}: {e}")

            # Load docket entries
            docket_file = dockets_dir / f"{deal_id}.json"
            if docket_file.exists():
                try:
                    with open(docket_file) as f:
                        docket_data = json.load(f)

                    # Load docket metadata (handle both nested and top-level keys)
                    deal.docket_metadata = docket_data.get("docket_metadata") or {
                        "docket_number": docket_data.get("docket_number", ""),
                        "case_name": docket_data.get("case_name", ""),
                        "jurisdiction": docket_data.get("jurisdiction", ""),
                        "status": docket_data.get("deal_status") or docket_data.get("status", ""),
                    }

                    # Load docket entries (handle both key formats)
                    for entry in (docket_data.get("docket_entries") or docket_data.get("entries", [])):
                        deal.docket_entries.append(DocketEntry(
                            entry_no=entry.get("entry_no", 0),
                            received_date=parse_date(entry.get("received_date")),
                            title=entry.get("title", ""),
                            relevance_level=entry.get("relevance_level", "medium"),
                            filer_role=entry.get("filer_role", ""),
                            filer_name=entry.get("filer_name", ""),
                            position_on_deal=entry.get("position_on_deal", ""),
                            entry_summary=entry.get("entry_summary", ""),
                            key_arguments=entry.get("key_arguments", []),
                            cumulative_impact=entry.get("cumulative_impact", ""),
                            download_link=entry.get("download_link", ""),
                            opposition_type=entry.get("opposition_type", ""),
                            intervenor_type=entry.get("intervenor_type", ""),
                            key_excerpts=entry.get("key_excerpts", [])
                        ))

                    # Load docket stakeholders (handle both key formats)
                    for sh in (docket_data.get("docket_stakeholders") or docket_data.get("stakeholders", [])):
                        deal.docket_stakeholders.append(DocketStakeholder(
                            name=sh.get("name", ""),
                            role=sh.get("role", ""),
                            filing_count=sh.get("filing_count", 0),
                            position=sh.get("position", ""),
                            opposition_type=sh.get("opposition_type", ""),
                            status=sh.get("status", ""),
                            intervenor_type=sh.get("intervenor_type", "")
                        ))

                    # Load docket conditions (handle both key formats)
                    for cond in (docket_data.get("docket_conditions") or docket_data.get("conditions", [])):
                        deal.docket_conditions.append(DocketCondition(
                            text=cond.get("text", ""),
                            status=cond.get("status", ""),
                            source=cond.get("source", ""),
                            category=cond.get("category", ""),
                            opposition_type=cond.get("opposition_type", ""),
                            relief_type=cond.get("relief_type", ""),
                            asked_in=cond.get("asked_in"),
                            resolved_in=cond.get("resolved_in"),
                        ))
                except Exception as e:
                    print(f"Error loading docket data for {deal_id}: {e}")

            deals.append(deal)

        # Add sample deal with rich example data
        sample_deals = create_sample_deals()
        deals.extend(sample_deals)

        return deals
    
    def create_sample_deals():
        """Create sample deals for testing"""
        # Simple sample - real samples come from generate_dashboard.py
        deal = Deal(
            id="SAMPLE001",
            target="HashiCorp",
            target_ticker="HCP",
            acquirer="IBM",
            acquirer_ticker="IBM",
            deal_value_bn=6.4,
            deal_type="cash",
            category=DealCategory.LOW_RISK_NEAR_TERM,
            offer_price=35.00,
            current_price=34.65,
            unaffected_price=26.50,
            borrow_rate_annual=0.005,
            dividend_expected=0.0,
            announce_date=date(2024, 4, 24),
            expected_close=date(2025, 2, 28),
            status="closing",
            regulatory_bodies=["EC"],
            next_milestone="Expected Close",
            next_milestone_date=date(2025, 2, 28),
            notes="EC clearance received Dec 2024"
        )

        # Add sample regulatory timeline for testing
        deal.regulatory_timeline = [
            RegulatoryEvent(
                agency="FTC/DOJ",
                event="HSR Filing Submitted",
                event_date=date(2024, 5, 15),
                status="completed",
                notes="Initial Hart-Scott-Rodino premerger notification filed"
            ),
            RegulatoryEvent(
                agency="FTC/DOJ",
                event="HSR Waiting Period Expired",
                event_date=date(2024, 6, 30),
                status="completed",
                notes="No second request issued; clearance granted"
            ),
            RegulatoryEvent(
                agency="European Commission",
                event="Phase I Filing",
                event_date=date(2024, 11, 15),
                status="completed",
                notes="Form CO submitted under EU Merger Regulation"
            ),
            RegulatoryEvent(
                agency="European Commission",
                event="Phase I Clearance",
                event_date=date(2024, 12, 18),
                status="completed",
                notes="Unconditional clearance under Article 6(1)(b)"
            ),
            RegulatoryEvent(
                agency="UK CMA",
                event="Not Applicable",
                event_date=None,
                status="not_required",
                notes="Transaction does not meet UK jurisdictional thresholds"
            )
        ]

        # Add sample timeline events for testing
        deal.timeline_events = [
            TimelineEvent(
                event_date=date(2024, 4, 24),
                event_type="milestone",
                title="Deal Announced",
                description="IBM announces acquisition of HashiCorp for $6.4 billion",
                status="completed"
            ),
            TimelineEvent(
                event_date=date(2024, 5, 15),
                event_type="regulatory",
                title="HSR Filing",
                description="Hart-Scott-Rodino premerger notification filed with FTC and DOJ",
                status="completed"
            ),
            TimelineEvent(
                event_date=date(2024, 6, 20),
                event_type="milestone",
                title="Shareholder Vote",
                description="HashiCorp shareholders approve merger agreement",
                status="completed"
            ),
            TimelineEvent(
                event_date=date(2024, 11, 15),
                event_type="regulatory",
                title="EU Commission Filing",
                description="Merger notification submitted to European Commission",
                status="completed"
            ),
            TimelineEvent(
                event_date=date(2024, 12, 18),
                event_type="regulatory",
                title="EU Clearance",
                description="European Commission approves merger without conditions",
                status="completed"
            ),
            TimelineEvent(
                event_date=date(2025, 2, 28),
                event_type="milestone",
                title="Expected Close",
                description="Anticipated closing date for the transaction",
                status="pending"
            )
        ]

        # Add docket metadata
        deal.docket_metadata = {
            "docket_number": "FTC-2024-SAMPLE-001",
            "case_name": "In the Matter of IBM / HashiCorp",
            "jurisdiction": "FTC",
            "status": "PENDING"
        }

        # Add sample docket stakeholders
        deal.docket_stakeholders = [
            DocketStakeholder(
                name="Federal Trade Commission",
                role="Commission",
                filing_count=1,
                position="Neutral",
                opposition_type="",
                status="active"
            ),
            DocketStakeholder(
                name="IBM Corporation",
                role="Party",
                filing_count=2,
                position="Support",
                opposition_type="",
                status="active"
            ),
            DocketStakeholder(
                name="Enterprise Customers Coalition",
                role="Intervenor",
                filing_count=1,
                position="Oppose",
                opposition_type="outright",
                status="active",
                intervenor_type="Business Customer"
            )
        ]

        # Add sample docket conditions
        deal.docket_conditions = [
            DocketCondition(
                text="Maintain HashiCorp pricing structure for 3 years post-closing",
                status="proposed",
                source="IBM Corporation"
            ),
            DocketCondition(
                text="Continue open-source model for HashiCorp products",
                status="proposed",
                source="IBM Corporation"
            ),
            DocketCondition(
                text="Separate business unit structure for HashiCorp",
                status="proposed",
                source="IBM Corporation"
            )
        ]

        # Add sample docket entries for testing
        deal.docket_entries = [
            DocketEntry(
                entry_no=1,
                received_date=date(2024, 5, 20),
                title="IBM Files Merger Application",
                relevance_level="high",
                filer_role="Party",
                filer_name="IBM Corporation",
                position_on_deal="Support",
                entry_summary="IBM submits formal merger application with all required documentation and financial disclosures.",
                key_arguments=["Strategic fit with cloud infrastructure goals", "No antitrust concerns", "Maintains HashiCorp's open-source commitments"],
                cumulative_impact="Sets baseline for regulatory review process",
                download_link=""
            ),
            DocketEntry(
                entry_no=5,
                received_date=date(2024, 6, 15),
                title="Customer Coalition Files Opposition",
                relevance_level="high",
                filer_role="Intervenor",
                filer_name="Enterprise Customers Coalition",
                position_on_deal="Oppose",
                entry_summary="Group of 15 enterprise customers express concerns about potential price increases and reduced innovation post-merger.",
                key_arguments=["Risk of monopolistic pricing in infrastructure-as-code market", "Potential loss of vendor neutrality", "Concerns about IBM's track record with acquisitions"],
                cumulative_impact="Raises pricing and competition concerns that regulators must address",
                download_link="",
                opposition_type="outright",
                intervenor_type="Business Customer",
                key_excerpts=["The merger would give IBM undue market power in the cloud infrastructure tooling space."]
            ),
            DocketEntry(
                entry_no=8,
                received_date=date(2024, 7, 10),
                title="IBM Response to Customer Concerns",
                relevance_level="medium",
                filer_role="Party",
                filer_name="IBM Corporation",
                position_on_deal="Support",
                entry_summary="IBM files response committing to maintain HashiCorp's pricing structure and open-source model for 3 years post-closing.",
                key_arguments=["Binding commitment to pricing freeze", "Continued investment in HashiCorp products", "Separate business unit structure"],
                cumulative_impact="Addresses key customer concerns with concrete commitments",
                download_link=""
            ),
            DocketEntry(
                entry_no=12,
                received_date=date(2024, 8, 5),
                title="Commission Staff Analysis",
                relevance_level="high",
                filer_role="Commission",
                filer_name="Regulatory Staff",
                position_on_deal="Neutral",
                entry_summary="Staff report recommends approval subject to conditions including pricing commitments and regular reporting requirements.",
                key_arguments=["Market analysis shows sufficient competition", "IBM commitments are enforceable", "Public interest served by merger"],
                cumulative_impact="Staff recommendation strongly favors approval with conditions",
                download_link=""
            )
        ]

        # Add sample spread history (3 months of data)
        from datetime import timedelta
        deal.spread_history = []
        base_date = date(2024, 11, 1)
        for i in range(90):  # 90 days of history
            day = base_date + timedelta(days=i)
            # Simulate realistic spread narrowing over time
            spread_pct = 3.5 - (i * 0.02) + (0.5 if i % 7 == 0 else 0)  # Weekly volatility
            current_price = 35.00 - (spread_pct / 100 * 35.00)
            deal.spread_history.append({
                'date': day.isoformat(),
                'target_price': round(current_price, 2),
                'offer_value': 35.00,
                'spread_dollars': round(35.00 - current_price, 2),
                'spread_pct': round(spread_pct, 2)
            })

        # Add sample DMA sections for testing
        deal.dma_sections = [
            DMASection(
                name="Consideration",
                clauses=[
                    DMAClause(
                        topic="Cash Consideration",
                        concise="$35.00 per share in cash",
                        fulsome="IBM will acquire all outstanding shares of HashiCorp for $35.00 per share in cash. The total transaction value is approximately $6.4 billion.",
                        clause_text="Each share of HashiCorp common stock issued and outstanding immediately prior to the Effective Time shall be converted into the right to receive $35.00 in cash, without interest.",
                        references=["Section 2.1(a)"]
                    ),
                    DMAClause(
                        topic="Payment Process",
                        concise="Payment through exchange agent within 5 business days",
                        fulsome="Payment of merger consideration will be made through an exchange agent appointed by IBM. Shareholders must surrender their stock certificates to receive payment within 5 business days of closing.",
                        clause_text="The Surviving Corporation shall deposit, or shall cause to be deposited, with the Exchange Agent, for the benefit of the holders of shares of Company Common Stock, cash in an amount sufficient to pay the aggregate Merger Consideration.",
                        references=["Section 2.2(a)", "Section 2.2(b)"]
                    )
                ]
            ),
            DMASection(
                name="Conditions & Financing",
                clauses=[
                    DMAClause(
                        topic="Regulatory Approvals",
                        concise="EU Commission approval required",
                        fulsome="Completion of the merger is conditioned upon receipt of approval from the European Commission under EU merger control regulations. No other significant regulatory approvals are required.",
                        clause_text="The waiting period applicable to the Transactions under the EU Merger Regulation shall have expired or been terminated, and any approval required thereunder shall have been obtained.",
                        references=["Section 7.1(b)"]
                    ),
                    DMAClause(
                        topic="No Financing Condition",
                        concise="Not subject to financing condition",
                        fulsome="IBM's obligation to complete the merger is not conditioned upon obtaining financing. IBM has sufficient cash on hand and committed credit facilities to fund the transaction.",
                        clause_text="IBM has represented that it has sufficient funds available to pay the aggregate Merger Consideration and all related fees and expenses.",
                        references=["Section 4.8"]
                    )
                ]
            )
        ]

        # Add sample SEC filings
        deal.sec_filings = [
            SECFiling(
                filing_type="S-4",
                filed_date=date(2024, 5, 30),
                description="Registration Statement - Initial Filing",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="IBM filed the initial S-4 registration statement covering the merger with HashiCorp. Includes preliminary proxy statement/prospectus detailing merger terms, fairness opinion, and pro forma financials."
            ),
            SECFiling(
                filing_type="DEFM14A",
                filed_date=date(2024, 6, 15),
                description="Definitive Proxy Statement",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="HashiCorp filed definitive proxy materials for special shareholder meeting scheduled for July 20, 2024. Includes detailed disclosure of merger consideration, go-shop period results, and board recommendation."
            ),
            SECFiling(
                filing_type="8-K",
                filed_date=date(2024, 4, 24),
                description="Current Report - Merger Agreement Announcement",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="IBM and HashiCorp announced entry into definitive merger agreement. IBM to acquire HashiCorp for $35.00 per share in cash, representing total equity value of approximately $6.4 billion."
            ),
            SECFiling(
                filing_type="8-K",
                filed_date=date(2024, 7, 22),
                description="Current Report - Shareholder Approval",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="HashiCorp shareholders approved the merger agreement with IBM at special meeting. Over 96% of votes cast were in favor of the transaction."
            ),
            SECFiling(
                filing_type="8-K",
                filed_date=date(2024, 11, 18),
                description="Current Report - EC Phase I Filing",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="IBM announced submission of merger notification to European Commission. Parties expect EC Phase I review process to complete within standard 25 working day timeline."
            ),
            SECFiling(
                filing_type="DEFA14A",
                filed_date=date(2024, 6, 8),
                description="Additional Proxy Soliciting Materials",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="Supplemental materials addressing shareholder questions regarding merger consideration, including comparison with go-shop period results and fairness opinion methodologies."
            ),
            SECFiling(
                filing_type="S-4/A",
                filed_date=date(2024, 6, 10),
                description="Registration Statement - Amendment No. 1",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="First amendment to S-4 registration statement incorporating SEC staff comments. Updates include enhanced disclosure of HashiCorp's financial projections and synergy estimates."
            ),
            SECFiling(
                filing_type="SC 13D",
                filed_date=date(2024, 5, 1),
                description="Beneficial Ownership Report - IBM",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143",
                summary="IBM filed Schedule 13D reporting beneficial ownership of 0% of HashiCorp common stock, with intent to acquire 100% through merger at $35.00 per share."
            )
        ]

        # Add sections to SAMPLE001 filings
        deal.sec_filings[0].accession_number = "0000051143-24-000042"
        deal.sec_filings[0].sections = {
            "consideration": "IBM to acquire all outstanding HashiCorp shares for $35.00 per share in cash. Total equity value approximately $6.4 billion.",
            "financing": "IBM has sufficient cash on hand and committed credit facilities. Not subject to financing condition.",
            "closing": "Expected to close in Q4 2024, subject to EC approval and customary conditions.",
        }
        deal.sec_filings[0].documents = [
            {"seq": 1, "description": "S-4 Registration Statement", "filename": "d715374ds4.htm", "doc_type": "S-4", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143"},
        ]
        deal.sec_filings[1].accession_number = "0000794619-24-000087"
        deal.sec_filings[1].sections = {
            "dates": "HashiCorp special shareholder meeting scheduled for July 20, 2024. Record date June 11, 2024. Mail date June 17, 2024.",
            "consideration": "$35.00 per share in cash. Premium of approximately 43% to the 60-day VWAP prior to announcement.",
            "shareholder_approval": "HashiCorp: Majority of outstanding shares entitled to vote.",
            "closing": "Expected close Q4 2024 upon EC approval.",
        }
        deal.sec_filings[2].accession_number = "0000051143-24-000018"
        deal.sec_filings[2].sections = {
            "dates": "Merger agreement executed April 24, 2024.",
            "consideration": "IBM to acquire HashiCorp for $35.00 per share in an all-cash transaction valued at approximately $6.4 billion.",
            "closing": "Subject to HashiCorp shareholder approval, EC clearance, and other customary conditions.",
        }
        deal.sec_filings[2].documents = [
            {"seq": 1, "description": "Form 8-K Current Report", "filename": "tm245913d1_8k.htm", "doc_type": "8-K", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143"},
            {"seq": 2, "description": "Exhibit 2.1 – Merger Agreement", "filename": "tm245913d1_ex2-1.htm", "doc_type": "EX-2.1", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143"},
            {"seq": 3, "description": "Exhibit 99.1 – Press Release", "filename": "tm245913d1_ex99-1.htm", "doc_type": "EX-99.1", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143"},
        ]

        # SAMPLE002: American Woodmark / MasterBrand Cabinets
        # Real ArbJ data from Guggenheim proxy summary emails
        deal2 = Deal(
            id="SAMPLE002",
            target="American Woodmark",
            target_ticker="AMWD",
            acquirer="MasterBrand Cabinets",
            acquirer_ticker="MBC",
            deal_value_bn=2.1,
            deal_type="stock",
            category=DealCategory.LOW_RISK_NEAR_TERM,
            offer_price=73.50,
            current_price=72.90,
            unaffected_price=57.80,
            borrow_rate_annual=0.004,
            dividend_expected=0.0,
            announce_date=date(2025, 6, 12),
            expected_close=date(2026, 1, 31),
            outside_date=date(2026, 6, 12),
            status="closing",
            regulatory_bodies=["FTC", "COFECE"],
            next_milestone="Shareholder Votes",
            next_milestone_date=date(2025, 10, 30),
        )

        deal2.sec_filings = [
            SECFiling(
                filing_type="DEFM14A",
                filed_date=date(2025, 9, 25),
                description="Definitive Proxy Statement",
                sec_url="https://www.sec.gov/Archives/edgar/data/794619/000119312525217480/d77274ddefm14a.htm",
                accession_number="0001193125-25-217480",
                summary="Definitive proxy materials for AMWD/MBC all-stock merger. Shareholder votes scheduled for October 30, 2025. Exchange ratio: 5.150 MBC shares per AMWD share. Record date: September 22, 2025.",
                sections={
                    "dates": "AMWD SH vote: October 30, 2025 at 9:00 AM ET. Record date: September 22, 2025. MBC SH vote: October 30, 2025 at 9:00 AM ET. Record date: September 22, 2025. Mail date: on or about September 25, 2025.",
                    "consideration": "Each share of AMWD common stock will be automatically canceled and converted into the right to receive 5.150 validly issued, fully paid and non-assessable shares of MBC common stock. No fractional shares — cash in lieu at MBC closing price.",
                    "financing": "N/A — all-stock transaction. No financing condition.",
                    "shareholder_approval": "AMWD: Affirmative vote of more than two-thirds of outstanding AMWD shares entitled to vote. MBC: Majority of votes present or represented by proxy at the MBC stockholder meeting (assuming quorum).",
                    "hsr": "Filed September 5, 2025. FTC notified MasterBrand and American Woodmark of clearance to review on September 15, 2025. HSR waiting period expires October 6, 2025, unless second request issued or early termination granted.",
                    "other_regulatory": "COFECE (Mexico): Filed September 2, 2025. Review expected to conclude by October 2025. VT Department of Financial Regulation: Filed September 3, 2025. Approval granted September 11, 2025.",
                    "closing": "Expected to close in early 2026, subject to satisfaction or waiver of conditions including regulatory approvals (FTC and COFECE) and approval by both companies' shareholders.",
                },
                documents=[
                    {"seq": 1, "description": "Definitive Proxy Statement", "filename": "d77274ddefm14a.htm", "doc_type": "DEFM14A", "url": "https://www.sec.gov/Archives/edgar/data/794619/000119312525217480/d77274ddefm14a.htm"},
                ],
            ),
            SECFiling(
                filing_type="S-4/A",
                filed_date=date(2025, 9, 23),
                description="Registration Statement - Amendment No. 1",
                sec_url="https://www.sec.gov/Archives/edgar/data/1941365/000119312525213439/d26471ds4a.htm",
                accession_number="0001193125-25-213439",
                summary="Amendment No. 1 to S-4 registration statement. Vote dates set for October 30, 2025. Record dates: September 22, 2025. No mail date set. HSR expires October 6, 2025. Mexico review expected October 2025. VT DFR approval granted September 11, 2025. Closing guidance: early 2026.",
                sections={
                    "dates": "SH vote dates set: October 30, 2025 for both AMWD and MBC shareholders. Record dates: September 22, 2025. No mail date set as of filing — expect final S-4 shortly.",
                    "hsr": "HSR filed September 5, 2025. Waiting period expires October 6, 2025.",
                    "other_regulatory": "Mexico (COFECE): Filed September 2, 2025. Expected conclusion October 2025. VT DFR: Filed September 3, 2025. Approval granted September 11, 2025.",
                    "closing": "Expected to close in early 2026.",
                },
                documents=[
                    {"seq": 1, "description": "S-4/A Amendment No. 1", "filename": "d26471ds4a.htm", "doc_type": "S-4/A", "url": "https://www.sec.gov/Archives/edgar/data/1941365/000119312525213439/d26471ds4a.htm"},
                ],
            ),
            SECFiling(
                filing_type="S-4",
                filed_date=date(2025, 9, 5),
                description="Registration Statement - Initial Filing",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1941365&type=S-4",
                accession_number="0001193125-25-198721",
                summary="Initial S-4 registration statement filed by MasterBrand Cabinets. Covers merger terms, exchange ratio of 5.150 MBC shares per AMWD share, financial projections, and required regulatory approvals.",
                sections={},
                documents=[],
            ),
            SECFiling(
                filing_type="8-K",
                filed_date=date(2025, 6, 12),
                description="Current Report - Merger Agreement Announcement",
                sec_url="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=794619&type=8-K",
                accession_number="0000794619-25-000041",
                summary="American Woodmark and MasterBrand Cabinets announced entry into a definitive merger agreement. MasterBrand to acquire all outstanding AMWD shares at a fixed exchange ratio of 5.150 MBC shares per AMWD share.",
                sections={
                    "consideration": "Fixed exchange ratio of 5.150 MBC shares per AMWD share. No financing condition — all-stock transaction.",
                    "closing": "Subject to shareholder approvals from both companies, regulatory approvals, and customary closing conditions. Expected to close in early 2026.",
                },
                documents=[
                    {"seq": 1, "description": "Form 8-K Current Report", "filename": "d794619d8k.htm", "doc_type": "8-K", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=794619&type=8-K"},
                    {"seq": 2, "description": "Exhibit 2.1 – Merger Agreement", "filename": "d794619dex2-1.htm", "doc_type": "EX-2.1", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=794619&type=8-K"},
                    {"seq": 3, "description": "Exhibit 99.1 – Press Release", "filename": "d794619dex99-1.htm", "doc_type": "EX-99.1", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=794619&type=8-K"},
                ],
            ),
        ]

        return [deal, deal2]