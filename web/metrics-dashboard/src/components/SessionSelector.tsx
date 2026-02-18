import { Session } from '../types';
import './SessionSelector.css';

interface SessionSelectorProps {
  sessions: Session[];
  selectedSession: string;
  onChange: (sessionId: string) => void;
}

export default function SessionSelector({
  sessions,
  selectedSession,
  onChange
}: SessionSelectorProps) {
  const formatSessionLabel = (session: Session): string => {
    return `${session.userId} - ${session.sessionId.substring(0, 8)}... (${session.state})`;
  };

  const getStateColor = (state: string): string => {
    switch (state.toLowerCase()) {
      case 'active':
        return 'var(--color-fps)';
      case 'pending':
        return 'var(--color-latency)';
      case 'stopped':
        return 'var(--color-cpu)';
      default:
        return 'var(--color-cyan-primary)';
    }
  };

  return (
    <div className="session-selector">
      <label className="session-label mono">
        <span className="label-icon">◈</span>
        SESSION FILTER:
      </label>
      <div className="session-select-container">
        <select
          value={selectedSession}
          onChange={(e) => onChange(e.target.value)}
          className="session-select mono"
        >
          <option value="all">ALL SESSIONS (FLEET-WIDE)</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {formatSessionLabel(session)}
            </option>
          ))}
        </select>
        <div className="select-arrow">▼</div>
      </div>
      {selectedSession !== 'all' && (
        <div className="session-info">
          {(() => {
            const session = sessions.find((s) => s.sessionId === selectedSession);
            if (!session) return null;
            return (
              <>
                <div className="info-item">
                  <span className="info-label">STATUS:</span>
                  <span
                    className="info-value state-badge"
                    style={{ color: getStateColor(session.state) }}
                  >
                    {session.state.toUpperCase()}
                  </span>
                </div>
                <div className="info-divider"></div>
                <div className="info-item">
                  <span className="info-label">INSTANCE:</span>
                  <span className="info-value">{session.instanceId}</span>
                </div>
                <div className="info-divider"></div>
                <div className="info-item">
                  <span className="info-label">START:</span>
                  <span className="info-value">
                    {new Date(session.startTime).toLocaleString()}
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
