import { NucleusStatus as NucleusStatusType } from '../types';
import './NucleusStatus.css';

interface NucleusStatusProps {
  status: NucleusStatusType | null;
  loading: boolean;
  error: string | null;
}

export default function NucleusStatus({ status, loading, error }: NucleusStatusProps) {
  const getStatusColor = (state: string): string => {
    switch (state.toLowerCase()) {
      case 'running': return 'var(--color-fps)';
      case 'stopped': return 'var(--color-latency)';
      case 'terminated': return '#ef4444';
      default: return 'var(--color-text-muted)';
    }
  };

  if (loading && !status) {
    return (
      <div className="nucleus-status-card">
        <div className="nucleus-status-header">
          {/* nosemgrep: jsx-not-internationalized */}
          <h3 className="nucleus-status-title mono">Nucleus Server</h3>
        </div>
        <div className="nucleus-status-loading">
          <div className="loading-spinner small"></div>
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="mono">Checking server status...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="nucleus-status-card error-state">
        <div className="nucleus-status-header">
          {/* nosemgrep: jsx-not-internationalized */}
          <h3 className="nucleus-status-title mono">Nucleus Server</h3>
          <div className="status-badge" style={{ color: '#ef4444', borderColor: '#ef4444' }}>
            {/* nosemgrep: jsx-not-internationalized */}
            Error
          </div>
        </div>
        <p className="nucleus-status-error mono">{error}</p>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="nucleus-status-card">
      <div className="nucleus-status-header">
        {/* nosemgrep: jsx-not-internationalized */}
        <h3 className="nucleus-status-title mono">Nucleus Server</h3>
        <div
          className="status-badge"
          style={{ color: getStatusColor(status.status), borderColor: getStatusColor(status.status) }}
        >
          <span className="status-dot" style={{ backgroundColor: getStatusColor(status.status) }}></span>
          {status.status.toUpperCase()}
        </div>
      </div>
      <div className="nucleus-status-details">
        <div className="detail-row">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="detail-label mono">Instance</span>
          <span className="detail-value mono">{status.instanceId}</span>
        </div>
        <div className="detail-row">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="detail-label mono">Private IP</span>
          <span className="detail-value mono">{status.privateIp}</span>
        </div>
        <div className="detail-row">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="detail-label mono">Connection</span>
          <span className="detail-value connection-string mono">{status.connectionString}</span>
        </div>
        <div className="detail-row">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="detail-label mono">Web UI</span>
          <span className="detail-value mono">{status.webUiUrl}</span>
        </div>
        <div className="detail-row">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="detail-label mono">SSM Agent</span>
          <span className="detail-value mono" style={{ color: status.ssmOnline ? 'var(--color-fps)' : 'var(--color-latency)' }}>
            {/* nosemgrep: jsx-not-internationalized */}
            {status.ssmOnline ? 'Online' : 'Offline'}
          </span>
        </div>
        {status.launchTime && (
          <div className="detail-row">
            {/* nosemgrep: jsx-not-internationalized */}
            <span className="detail-label mono">Launch Time</span>
            <span className="detail-value mono">{new Date(status.launchTime).toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
