import { MetricSummary } from '../types';
import './SummaryCard.css';

interface SummaryCardProps {
  metricName: string;
  summary: MetricSummary;
  unit: string;
  color: string;
  glowClass?: string;
  primaryStat?: 'current' | 'maximum';
}

export default function SummaryCard({
  metricName,
  summary,
  unit,
  color,
  glowClass,
  primaryStat = 'current'
}: SummaryCardProps) {
  const formatValue = (value: number): string => {
    // Round to 2 decimal places
    return value.toFixed(2);
  };

  return (
    <div className="summary-card" style={{ borderColor: color }}>
      <div className="card-header">
        <h3 className={`card-title mono ${glowClass}`} style={{ color }}>
          {metricName}
        </h3>
        <div className="card-indicator" style={{ backgroundColor: color }}></div>
      </div>

      <div className="card-body">
        <div className="primary-value">
          <span className={`value-large mono ${glowClass}`} style={{ color }}>
            {formatValue(primaryStat === 'maximum' ? summary.maximum : (summary.current ?? summary.average))}
          </span>
          <span className="value-unit mono">{unit}</span>
        </div>
        {/* nosemgrep: jsx-not-internationalized */}
        <div className="primary-stat-label mono">
          {primaryStat === 'maximum' ? 'peak / 60s' : 'avg / 60s'}
        </div>

        <div className="secondary-values">
          <div className="stat-item">
            {/* nosemgrep: jsx-not-internationalized */}
            <span className="stat-label mono">AVG</span>
            <span className="stat-value mono">{formatValue(summary.average)}</span>
          </div>
          <div className="stat-divider"></div>
          <div className="stat-item">
            {/* nosemgrep: jsx-not-internationalized */}
            <span className="stat-label mono">MIN</span>
            <span className="stat-value mono">{formatValue(summary.minimum)}</span>
          </div>
          <div className="stat-divider"></div>
          <div className="stat-item">
            {/* nosemgrep: jsx-not-internationalized */}
            <span className="stat-label mono">MAX</span>
            <span className="stat-value mono">{formatValue(summary.maximum)}</span>
          </div>
        </div>
      </div>

      <div className="card-footer">
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{
              backgroundColor: color,
              width: `${Math.min(((primaryStat === 'maximum' ? summary.maximum : (summary.current ?? summary.average)) / summary.maximum) * 100, 100)}%`
            }}
          ></div>
        </div>
      </div>
    </div>
  );
}
