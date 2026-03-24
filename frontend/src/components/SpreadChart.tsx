import { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  AreaChart,
} from 'recharts';
import '../styles/SpreadChart.css';

interface SpreadDataPoint {
  date: string;
  target_price: number;
  acquirer_price?: number;
  offer_value: number;
  spread_dollars: number;
  spread_pct: number;
}

interface TimelineEvent {
  event_date: string;
  title: string;
  status: string;
  event_type: string;
}

interface SpreadChartProps {
  data: SpreadDataPoint[];
  events?: TimelineEvent[];
  announceDate: string;
}

type ViewMode = 'spread-pct' | 'spread-dollar' | 'price';

export default function SpreadChart({ data, events = [], announceDate }: SpreadChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('spread-pct');

  // Filter to post-announcement data
  const chartData = data.filter(d => d.date >= announceDate);

  if (chartData.length === 0) {
    return (
      <div className="spread-chart-container">
        <div className="chart-empty">No spread history data available</div>
      </div>
    );
  }

  // Find events within data range
  const dataStartDate = chartData[0]?.date;
  const dataEndDate = chartData[chartData.length - 1]?.date;
  const relevantEvents = events.filter(e => {
    return e.event_date >= dataStartDate && e.event_date <= dataEndDate;
  });

  // Calculate dynamic Y-axis domain
  const getYAxisDomain = () => {
    let values: number[] = [];

    if (viewMode === 'spread-pct') {
      values = chartData.map(d => d.spread_pct);
    } else if (viewMode === 'spread-dollar') {
      values = chartData.map(d => d.spread_dollars);
    } else {
      // Price view
      values = chartData.flatMap(d => [d.target_price, d.offer_value]);
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const padding = range * 0.15; // 15% padding on each side

    return [
      Math.floor((min - padding) * 10) / 10, // Round down
      Math.ceil((max + padding) * 10) / 10   // Round up
    ];
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;

    const data = payload[0].payload;
    return (
      <div className="spread-tooltip">
        <div className="tooltip-date">{new Date(data.date).toLocaleDateString()}</div>
        {viewMode === 'spread-pct' && (
          <div className="tooltip-value">Spread: {data.spread_pct.toFixed(2)}%</div>
        )}
        {viewMode === 'spread-dollar' && (
          <div className="tooltip-value">Spread: ${data.spread_dollars.toFixed(2)}</div>
        )}
        {viewMode === 'price' && (
          <>
            <div className="tooltip-value target">Target: ${data.target_price.toFixed(2)}</div>
            <div className="tooltip-value offer">Offer: ${data.offer_value.toFixed(2)}</div>
            {data.acquirer_price && (
              <div className="tooltip-value acquirer">Acquirer: ${data.acquirer_price.toFixed(2)}</div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="spread-chart-container">
      {/* View Toggle Buttons */}
      <div className="chart-controls">
        <div className="view-toggle">
          <button
            className={`toggle-btn ${viewMode === 'spread-pct' ? 'active' : ''}`}
            onClick={() => setViewMode('spread-pct')}
          >
            Spread %
          </button>
          <button
            className={`toggle-btn ${viewMode === 'spread-dollar' ? 'active' : ''}`}
            onClick={() => setViewMode('spread-dollar')}
          >
            Spread $
          </button>
          <button
            className={`toggle-btn ${viewMode === 'price' ? 'active' : ''}`}
            onClick={() => setViewMode('price')}
          >
            Price View
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="chart-wrapper">
        <ResponsiveContainer width="100%" height={400}>
          {viewMode === 'price' ? (
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(92, 207, 230, 0.2)"
                vertical={true}
                horizontal={true}
              />
              <XAxis
                dataKey="date"
                stroke="#a0a0a0"
                tick={{ fill: '#a0a0a0', fontSize: 11 }}
                tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                minTickGap={30}
              />
              <YAxis
                stroke="#a0a0a0"
                tick={{ fill: '#a0a0a0', fontSize: 11 }}
                tickFormatter={(value) => `$${value.toFixed(2)}`}
                domain={getYAxisDomain()}
                width={60}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ color: '#e6e6e6', fontSize: '12px' }} />

              {/* Event markers */}
              {relevantEvents.map((event, idx) => (
                <ReferenceLine
                  key={idx}
                  x={event.event_date}
                  stroke={event.status === 'completed' ? '#c792ea' : '#ffcc66'}
                  strokeDasharray={event.status === 'completed' ? '0' : '4 4'}
                  strokeWidth={2}
                  label={{
                    value: event.title.substring(0, 15),
                    position: 'top',
                    fill: '#e6e6e6',
                    fontSize: 10,
                  }}
                />
              ))}

              <Line
                type="monotone"
                dataKey="target_price"
                stroke="#87d96c"
                strokeWidth={2}
                dot={false}
                name="Target Price"
              />
              <Line
                type="monotone"
                dataKey="offer_value"
                stroke="#5ccfe6"
                strokeWidth={2}
                dot={false}
                name="Offer Value"
              />
            </LineChart>
          ) : (
            <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <defs>
                <linearGradient id="colorSpread" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={viewMode === 'spread-pct' ? '#5ccfe6' : '#87d96c'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={viewMode === 'spread-pct' ? '#5ccfe6' : '#87d96c'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(92, 207, 230, 0.2)"
                vertical={true}
                horizontal={true}
              />
              <XAxis
                dataKey="date"
                stroke="#a0a0a0"
                tick={{ fill: '#a0a0a0', fontSize: 11 }}
                tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              />
              <YAxis
                stroke="#a0a0a0"
                tick={{ fill: '#a0a0a0', fontSize: 11 }}
                tickFormatter={(value) =>
                  viewMode === 'spread-pct' ? `${value.toFixed(1)}%` : `$${value.toFixed(2)}`
                }
                domain={getYAxisDomain()}
                width={60}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ color: '#e6e6e6', fontSize: '12px' }} />

              {/* Zero line - always show */}
              <ReferenceLine
                y={0}
                stroke="#666"
                strokeWidth={2}
                label={{ value: '0', position: 'right', fill: '#888', fontSize: 11 }}
              />

              {/* Threshold lines for spread % view */}
              {viewMode === 'spread-pct' && (
                <>
                  <ReferenceLine
                    y={5}
                    stroke="#ffcc66"
                    strokeDasharray="6 4"
                    strokeWidth={1}
                    label={{ value: '5% warning', position: 'right', fill: '#ffcc66', fontSize: 10 }}
                  />
                  <ReferenceLine
                    y={10}
                    stroke="#f07178"
                    strokeDasharray="6 4"
                    strokeWidth={1}
                    label={{ value: '10% danger', position: 'right', fill: '#f07178', fontSize: 10 }}
                  />
                </>
              )}

              {/* Event markers */}
              {relevantEvents.map((event, idx) => (
                <ReferenceLine
                  key={idx}
                  x={event.event_date}
                  stroke={event.status === 'completed' ? '#c792ea' : '#ffcc66'}
                  strokeDasharray={event.status === 'completed' ? '0' : '4 4'}
                  strokeWidth={2}
                  label={{
                    value: event.title.substring(0, 15),
                    position: 'top',
                    fill: '#e6e6e6',
                    fontSize: 10,
                  }}
                />
              ))}

              <Area
                type="monotone"
                dataKey={viewMode === 'spread-pct' ? 'spread_pct' : 'spread_dollars'}
                stroke={viewMode === 'spread-pct' ? '#5ccfe6' : '#87d96c'}
                strokeWidth={2}
                fill="url(#colorSpread)"
                name={viewMode === 'spread-pct' ? 'Spread %' : 'Spread $'}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Chart Legend/Info */}
      <div className="chart-info">
        <div className="info-item">
          <span className="info-label">Data Points:</span>
          <span className="info-value">{chartData.length} days</span>
        </div>
        <div className="info-item">
          <span className="info-label">Date Range:</span>
          <span className="info-value">
            {new Date(chartData[0].date).toLocaleDateString()} - {new Date(chartData[chartData.length - 1].date).toLocaleDateString()}
          </span>
        </div>
        {viewMode === 'spread-pct' && (
          <div className="info-item">
            <span className="info-label">Avg Spread:</span>
            <span className="info-value">
              {(chartData.reduce((sum, d) => sum + d.spread_pct, 0) / chartData.length).toFixed(2)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
