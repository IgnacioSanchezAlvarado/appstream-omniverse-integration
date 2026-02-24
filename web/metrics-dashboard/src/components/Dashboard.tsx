import { useState, useEffect } from 'react';
import { MetricsResponse, Session, NucleusStatus as NucleusStatusType, NucleusMetricsResponse } from '../types';
import { fetchMetrics, fetchSessions, loadConfig, fetchNucleusStatus, fetchNucleusMetrics } from '../services/api';
import SummaryCard from './SummaryCard';
import MetricsChart from './MetricsChart';
import SessionSelector from './SessionSelector';
import NucleusStatusComponent from './NucleusStatus';
import NucleusMetrics from './NucleusMetrics';
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
  const [nucleusEnabled, setNucleusEnabled] = useState(false);
  const [nucleusStatus, setNucleusStatus] = useState<NucleusStatusType | null>(null);
  const [nucleusMetrics, setNucleusMetrics] = useState<NucleusMetricsResponse | null>(null);
  const [nucleusLoading, setNucleusLoading] = useState(false);
  const [nucleusError, setNucleusError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkNucleus = async () => {
      const config = await loadConfig();
      setNucleusEnabled(config.nucleusEnabled ?? false);
    };
    checkNucleus();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const loadNucleusData = async () => {
    if (!nucleusEnabled) return;
    setNucleusLoading(true);
    try {
      setNucleusError(null);
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - 3600000).toISOString();

      const [statusData, metricsData] = await Promise.all([
        fetchNucleusStatus().catch(err => { setNucleusError(err.message); return null; }),
        fetchNucleusMetrics({ startTime, endTime, period: 60 }).catch(err => { setNucleusError(err.message); return null; })
      ]);

      setNucleusStatus(statusData);
      setNucleusMetrics(metricsData);
    } finally {
      setNucleusLoading(false);
    }
  };

  useEffect(() => {
    if (nucleusEnabled) {
      loadNucleusData();
    }
  }, [nucleusEnabled]);

  useEffect(() => {
    const loadSessions = async () => {
      try {
        const sessionData = await fetchSessions(DEFAULT_STACK, fleetName);
        setSessions(sessionData);
      } catch (err) {
        console.error('Failed to fetch sessions:', err);
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

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      loadMetrics();
      if (nucleusEnabled) loadNucleusData();
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [autoRefresh, fleetName, selectedSession, nucleusEnabled]);

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
            className="theme-toggle"
            onClick={() => setIsDark(!isDark)}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
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
                primaryStat={metricKey === 'FramesPerSecond' ? 'maximum' : 'current'}
              />
            );
          })}
        </div>
      )}

      {/* Charts — FPS and Latency only */}
      {metrics && (
        <div className="charts-grid fade-in" style={{ animationDelay: '0.3s' }}>
          {(['FramesPerSecond', 'InSessionLatency'] as const).map((metricKey) => {
            const config = METRIC_CONFIG[metricKey];
            const metricData = metrics.metrics[metricKey];
            if (!metricData) return null;

            return (
              <MetricsChart
                key={metricKey}
                metricName={config.name}
                datapoints={metricData.datapoints}
                unit={metricData.unit}
                color={config.color}
                stat={metricKey === 'FramesPerSecond' ? 'maximum' : 'average'}
                isDark={isDark}
              />
            );
          })}
        </div>
      )}

      {/* Nucleus Section */}
      {nucleusEnabled && (
        <>
          <div className="nucleus-status-container fade-in" style={{ animationDelay: '0.35s' }}>
            <NucleusStatusComponent
              status={nucleusStatus}
              loading={nucleusLoading}
              error={nucleusError}
            />
          </div>
          <div className="fade-in" style={{ animationDelay: '0.4s' }}>
            <NucleusMetrics
              nucleusMetrics={nucleusMetrics}
              appstreamMetrics={metrics}
              loading={nucleusLoading}
              isDark={isDark}
            />
          </div>
        </>
      )}

      {/* Footer */}
      <footer className="dashboard-footer mono fade-in" style={{ animationDelay: '0.5s' }}>
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
