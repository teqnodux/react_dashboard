// Shared SEC Filing renderers — used by both SECFilings.tsx and DealDetail.tsx

export function getFilingTypeColor(type: string) {
  const colors: Record<string, string> = {
    'S-4': 'var(--accent-blue)',
    'S-4/A': 'var(--accent-blue)',
    'DEFM14A': 'var(--accent-green)',
    'DEF 14A': 'var(--accent-green)',
    'PREM14A': 'var(--accent-green)',
    '8-K': 'var(--accent-yellow)',
    '8-K/A': 'var(--accent-yellow)',
    'SC 13D': '#b388ff',
    'SC 13D/A': '#b388ff',
    'SC 13G': '#b388ff',
    'SC 13G/A': '#b388ff',
    '13E-3': 'var(--accent-red)',
    'DEFA14A': '#ffb74d',
    '10-K': '#ce93d8',
    '10-Q': '#ce93d8',
    '4': '#80cbc4',
    'FORM 4': '#80cbc4',
    '144': '#a1887f',
    'FORM 144': '#a1887f',
    'SC TO-T': 'var(--accent-red)',
    'SC 14D-9': 'var(--accent-red)',
    '425': '#90caf9',
    'FORM 25': '#ef9a9a',
  };
  return colors[type] || 'var(--text-secondary)';
}

export function render8KDetail(l3: Record<string, any>) {
  return (
    <div className="l3-8k">
      {l3.event && (
        <div className="l3-section">
          <h5 className="l3-label">EVENT</h5>
          <p className="l3-text">{l3.event}</p>
        </div>
      )}
      {l3.key_figures?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">KEY FIGURES</h5>
          <ul className="l3-list">
            {l3.key_figures.map((fig: string, i: number) => (
              <li key={i}>{fig}</li>
            ))}
          </ul>
        </div>
      )}
      {l3.deal_implications && (
        <div className="l3-section">
          <h5 className="l3-label">DEAL IMPLICATIONS</h5>
          <p className="l3-text">{l3.deal_implications}</p>
        </div>
      )}
      {l3.remaining_conditions?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">REMAINING CONDITIONS</h5>
          <ul className="l3-list">
            {l3.remaining_conditions.map((c: string, i: number) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {l3.risks_flagged?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">RISKS FLAGGED</h5>
          <ul className="l3-list l3-risks">
            {l3.risks_flagged.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function renderForm4Detail(l3: Record<string, any>) {
  return (
    <div className="l3-form4">
      {l3.transactions?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">TRANSACTIONS</h5>
          <table className="l3-table">
            <thead>
              <tr>
                <th>Type</th><th>Date</th><th>Shares</th><th>Price</th><th>Value</th><th>A/D</th>
              </tr>
            </thead>
            <tbody>
              {l3.transactions.map((tx: any, i: number) => (
                <tr key={i}>
                  <td>{tx.type}</td><td>{tx.date}</td><td>{tx.shares}</td>
                  <td>{tx.price_per_share}</td><td>{tx.total_value}</td><td>{tx.acquired_or_disposed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {l3.post_transaction_holdings && (
        <div className="l3-section">
          <h5 className="l3-label">POST-TRANSACTION HOLDINGS</h5>
          <p className="l3-text">{l3.post_transaction_holdings}</p>
        </div>
      )}
      {l3.deal_signal && l3.deal_signal !== 'N/A' && (
        <div className="l3-section">
          <h5 className="l3-label">DEAL SIGNAL</h5>
          <p className="l3-text">{l3.deal_signal}</p>
        </div>
      )}
      {l3.pattern_notes && (
        <div className="l3-section">
          <h5 className="l3-label">PATTERN NOTES</h5>
          <p className="l3-text">{l3.pattern_notes}</p>
        </div>
      )}
      {l3.risks_flagged?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">RISKS FLAGGED</h5>
          <ul className="l3-list l3-risks">
            {l3.risks_flagged.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function renderForm144Detail(l3: Record<string, any>) {
  const sale = l3.proposed_sale || {};
  return (
    <div className="l3-form144">
      {Object.keys(sale).length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">PROPOSED SALE</h5>
          <div className="l3-kv-grid">
            {sale.shares_to_sell && <div className="l3-kv"><span>Shares:</span><span>{sale.shares_to_sell}</span></div>}
            {sale.estimated_value && <div className="l3-kv"><span>Est. Value:</span><span>{sale.estimated_value}</span></div>}
            {sale.securities_type && <div className="l3-kv"><span>Security:</span><span>{sale.securities_type}</span></div>}
            {sale.acquisition_date && <div className="l3-kv"><span>Acquired:</span><span>{sale.acquisition_date}</span></div>}
            {sale.acquisition_method && <div className="l3-kv"><span>Method:</span><span>{sale.acquisition_method}</span></div>}
          </div>
        </div>
      )}
      {l3.broker_info && (
        <div className="l3-section">
          <h5 className="l3-label">BROKER</h5>
          <p className="l3-text">{l3.broker_info}</p>
        </div>
      )}
      {l3.deal_signal && l3.deal_signal !== 'N/A' && (
        <div className="l3-section">
          <h5 className="l3-label">DEAL SIGNAL</h5>
          <p className="l3-text">{l3.deal_signal}</p>
        </div>
      )}
      {l3.risks_flagged?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">RISKS FLAGGED</h5>
          <ul className="l3-list l3-risks">
            {l3.risks_flagged.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function renderSC13DDetail(l3: Record<string, any>) {
  const own = l3.ownership_details || {};
  return (
    <div className="l3-sc13d">
      {Object.keys(own).length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">OWNERSHIP DETAILS</h5>
          <div className="l3-kv-grid">
            {own.shares_held && <div className="l3-kv"><span>Shares Held:</span><span>{own.shares_held}</span></div>}
            {own.percentage_owned && <div className="l3-kv"><span>% Owned:</span><span>{own.percentage_owned}</span></div>}
            {own.sole_voting_power && <div className="l3-kv"><span>Sole Voting:</span><span>{own.sole_voting_power}</span></div>}
            {own.shared_voting_power && <div className="l3-kv"><span>Shared Voting:</span><span>{own.shared_voting_power}</span></div>}
            {own.sole_dispositive_power && <div className="l3-kv"><span>Sole Dispositive:</span><span>{own.sole_dispositive_power}</span></div>}
            {own.shared_dispositive_power && <div className="l3-kv"><span>Shared Dispositive:</span><span>{own.shared_dispositive_power}</span></div>}
          </div>
        </div>
      )}
      {l3.position_change && (
        <div className="l3-section">
          <h5 className="l3-label">POSITION CHANGE</h5>
          <p className="l3-text">{l3.position_change}</p>
        </div>
      )}
      {l3.purpose_of_transaction && (
        <div className="l3-section">
          <h5 className="l3-label">PURPOSE OF TRANSACTION</h5>
          <p className="l3-text">{l3.purpose_of_transaction}</p>
        </div>
      )}
      {l3.activist_intentions && (
        <div className="l3-section">
          <h5 className="l3-label">ACTIVIST INTENTIONS</h5>
          <p className="l3-text">{l3.activist_intentions}</p>
        </div>
      )}
      {l3.deal_implications && (
        <div className="l3-section">
          <h5 className="l3-label">DEAL IMPLICATIONS</h5>
          <p className="l3-text">{l3.deal_implications}</p>
        </div>
      )}
      {l3.risks_flagged?.length > 0 && (
        <div className="l3-section">
          <h5 className="l3-label">RISKS FLAGGED</h5>
          <ul className="l3-list l3-risks">
            {l3.risks_flagged.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function renderGenericDetail(l3: Record<string, any>) {
  return (
    <div className="l3-generic">
      {Object.entries(l3).map(([key, value]) => (
        <div key={key} className="l3-section">
          <h5 className="l3-label">{key.replace(/_/g, ' ').toUpperCase()}</h5>
          {Array.isArray(value) ? (
            <ul className="l3-list">
              {value.map((item: any, i: number) => (
                <li key={i}>{typeof item === 'object' ? JSON.stringify(item, null, 2) : String(item)}</li>
              ))}
            </ul>
          ) : typeof value === 'object' && value !== null ? (
            <div className="l3-kv-grid">
              {Object.entries(value).map(([k, v]) => (
                <div key={k} className="l3-kv">
                  <span>{k.replace(/_/g, ' ')}:</span>
                  <span>{String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="l3-text">{String(value)}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function renderL3Detail(formType: string, l3: Record<string, any>) {
  const t = formType.toUpperCase().replace(/[^A-Z0-9/\-]/g, '');
  if (t.startsWith('8-K') || t.startsWith('8K')) return render8KDetail(l3);
  if (t.includes('FORM4') || t === '4' || t.includes('FORM 4')) return renderForm4Detail(l3);
  if (t.includes('FORM144') || t === '144' || t.includes('FORM 144')) return renderForm144Detail(l3);
  if (t.includes('SC13') || t.includes('SC 13')) return renderSC13DDetail(l3);
  return renderGenericDetail(l3);
}
