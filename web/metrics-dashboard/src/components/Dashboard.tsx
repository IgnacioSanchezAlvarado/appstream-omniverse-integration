import { useState, useEffect } from 'react';
import { MetricsResponse, Session } from '../types';
import { fetchMetrics, fetchSessions } from '../services/api';
import SummaryCard from './SummaryCard';
import MetricsChart from './MetricsChart';
import SessionSelector from './SessionSelector';
import './Dashboard.css';

const DEFAULT_FLEET = 'appstream-omniverse-fleet';
const DEFAULT_STACK = 'appstream-omniverse-stack';
const REFRESH_INTERVAL = 10000; // 10 seconds

const METRIC_CONFIG = {
  FramesPerSecond: {
    name: 'FPS',
    color: 'var(--color-fps)',
    glowClass: 'glow-fps'
  },
  InSessionLatency: {
    name: 'Latency',
    color: 'var(--color-latency)',
    glowClass: 'glow-latency'
  },
  Bandwidth: {
    name: 'Bandwidth',
    color: 'var(--color-bandwidth)',
    glowClass: 'glow-bandwidth'
  },
  CpuUtilizationInstance: {
    name: 'CPU',
    color: 'var(--color-cpu)',
    glowClass: 'glow-cpu'
  }
};

export default function Dashboard() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [fleetName, setFleetName] = useState(DEFAULT_FLEET);

  // Fetch sessions
  useEffect(() => {
    const loadSessions = async () => {
      try {
        const sessionData = await fetchSessions(DEFAULT_STACK, fleetName);
        setSessions(sessionData);
      } catch (err) {
        console.error('Failed to fetch sessions:', err);
        // Don't set error state - sessions are optional
      }
    };

    loadSessions();
  }, [fleetName]);

  // Fetch metrics
  const loadMetrics = async () => {
    try {
      setError(null);

      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - 3600000).toISOString(); // Last hour

      const options: any = {
        startTime,
        endTime,
        period: 60
      };

      // Add session filter if specific session selected
      if (selectedSession !== 'all') {
        const session = sessions.find(s => s.sessionId === selectedSession);
        if (session) {
          options.sessionId = session.sessionId;
          options.userId = session.userId;
          options.instanceId = session.instanceId;
        }
      }

      const metricsData = await fetchMetrics(fleetName, options);
      setMetrics(metricsData);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics');
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMetrics();
  }, [fleetName, selectedSession]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      loadMetrics();
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [autoRefresh, fleetName, selectedSession]);

  if (loading) {
    return (
      <div className="dashboard-container">
        <div className="loading">
          <div className="loading-spinner"></div>
          <p className="mono">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container">
        <div className="error">
          <h2>ERROR</h2>
          <p className="mono">{error}</p>
          <button onClick={loadMetrics} className="retry-button">
            RETRY CONNECTION
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header fade-in">
        <div className="header-left">
          <h1 className="dashboard-title">
            <span className="title-prefix">AWS</span>
            <span className="title-main">AppStream Omniverse</span>
          </h1>
          <p className="dashboard-subtitle">
            Performance Metrics Dashboard
          </p>
        </div>
        <div className="header-right">
          <div className="fleet-input-container">
            <label className="mono">FLEET:</label>
            <input
              type="text"
              value={fleetName}
              onChange={(e) => setFleetName(e.target.value)}
              className="fleet-input mono"
            />
          </div>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`refresh-toggle ${autoRefresh ? 'active' : ''}`}
          >
            <span>{autoRefresh ? '●' : '○'} Auto-refresh</span>
          </button>
        </div>
      </header>

      {/* Session Selector */}
      {sessions.length > 0 && (
        <div className="session-selector-container fade-in" style={{ animationDelay: '0.1s' }}>
          <SessionSelector
            sessions={sessions}
            selectedSession={selectedSession}
            onChange={setSelectedSession}
          />
        </div>
      )}

      {/* Summary Cards */}
      {metrics && (
        <div className="summary-grid fade-in" style={{ animationDelay: '0.2s' }}>
          {Object.entries(METRIC_CONFIG).map(([metricKey, config]) => {
            const summary = metrics.summary[metricKey];
            if (!summary) return null;

            return (
              <SummaryCard
                key={metricKey}
                metricName={config.name}
                summary={summary}
                unit={summary.unit}
                color={config.color}
                glowClass={config.glowClass}
              />
            );
          })}
        </div>
      )}

      {/* Charts */}
      {metrics && (
        <div className="charts-grid fade-in" style={{ animationDelay: '0.3s' }}>
          {Object.entries(METRIC_CONFIG).map(([metricKey, config]) => {
            const metricData = metrics.metrics[metricKey];
            if (!metricData) return null;

            return (
              <MetricsChart
                key={metricKey}
                metricName={config.name}
                datapoints={metricData.datapoints}
                unit={metricData.unit}
                color={config.color}
              />
            );
          })}
        </div>
      )}

      {/* Footer */}
      <footer className="dashboard-footer mono fade-in" style={{ animationDelay: '0.4s' }}>
        <div>
          Status: <span className="status-active">Connected</span>
        </div>
        {metrics && (
          <div>
            LAST UPDATE: {new Date(metrics.query.endTime).toLocaleTimeString()}
          </div>
        )}
      </footer>
    </div>
  );
}
