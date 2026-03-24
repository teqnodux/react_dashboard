/**
 * StatusProgression — Visual status state-machine bar for regulatory approvals.
 *
 * Shows the ordered status_states from the master file with the current position highlighted.
 * Completed states are green, current is blue/pulsing, future is gray.
 * Jumped states (skipped in history) show dashed orange connecting lines.
 */

import './StatusProgression.css';

interface StatusHistoryEntry {
  status:        string;
  date:          string | null;
  source_doc:    string;
  excerpt:       string | null;
  detected_at:   string;
}

interface Props {
  states:         string[];
  currentStatus:  string;
  statusHistory?: StatusHistoryEntry[];
}

export default function StatusProgression({ states, currentStatus, statusHistory = [] }: Props) {
  if (!states || states.length === 0) return null;

  // Find current position (fuzzy match)
  const currentIdx = findIdx(currentStatus, states);

  // Build set of states that appear in history (were actually visited)
  const visitedStatuses = new Set(
    statusHistory.map(h => h.status?.toLowerCase().trim())
  );

  return (
    <div className="status-progression">
      <div className="status-track">
        {states.map((state, i) => {
          const isCompleted = currentIdx !== null && i < currentIdx;
          const isCurrent   = currentIdx !== null && i === currentIdx;
          const isFuture    = currentIdx === null || i > currentIdx;
          const wasVisited  = visitedStatuses.has(state.toLowerCase().trim());
          const wasSkipped  = isCompleted && !wasVisited && !isCurrent;

          // Find history entry for this state (for date tooltip)
          const histEntry = statusHistory.find(
            h => h.status?.toLowerCase().trim() === state.toLowerCase().trim()
          );

          const dotClass = [
            'status-dot',
            isCompleted ? 'dot-completed' : '',
            isCurrent   ? 'dot-current'   : '',
            isFuture    ? 'dot-future'    : '',
            wasSkipped  ? 'dot-skipped'   : '',
          ].filter(Boolean).join(' ');

          // Connector line (before each dot except the first)
          const lineClass = [
            'status-line',
            isCompleted || isCurrent ? 'line-completed' : 'line-future',
            wasSkipped ? 'line-skipped' : '',
          ].filter(Boolean).join(' ');

          return (
            <div key={i} className="status-step">
              {i > 0 && <div className={lineClass} />}
              <div className={dotClass} title={histEntry?.date ? `${state} — ${histEntry.date}` : state}>
                {isCompleted && !wasSkipped && <span className="dot-check">&#10003;</span>}
                {wasSkipped && <span className="dot-skip">&#8212;</span>}
              </div>
              <div className={`status-label ${isCurrent ? 'label-current' : ''}`}>
                {abbreviate(state)}
                {histEntry?.date && (
                  <span className="status-date">{fmtShort(histEntry.date)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function findIdx(status: string, states: string[]): number | null {
  const s = status.toLowerCase().trim();
  for (let i = 0; i < states.length; i++) {
    const st = states[i].toLowerCase().trim();
    if (st === s || s.includes(st) || st.includes(s)) return i;
  }
  return null;
}

function abbreviate(s: string): string {
  // Shorten long status names for display
  if (s.length <= 20) return s;
  return s
    .replace(' — ', ': ')
    .replace('Waiting Period Running', 'WP Running')
    .replace('Second Request ', '2nd Req. ')
    .replace('Complied', 'Complied')
    .replace('Applications Filed', 'Apps Filed')
    .replace('Evidentiary Hearings', 'Hearings')
    .replace('with Conditions', 'w/ Cond.')
    .replace('Investigation', 'Invest.')
    .replace('Negotiations', 'Negot.');
}

function fmtShort(d: string): string {
  try {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}
