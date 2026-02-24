import { MetricsResponse, Session, RuntimeConfig, NucleusStatus, NucleusMetricsResponse } from '../types';

let cachedConfig: RuntimeConfig | null = null;

export async function loadConfig(): Promise<RuntimeConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    // Try to fetch runtime-config.json (production)
    const response = await fetch('/runtime-config.json');
    if (response.ok) {
      cachedConfig = await response.json();
      return cachedConfig!;
    }
  } catch (error) {
    console.warn('Could not load runtime-config.json, falling back to environment variables');
  }

  // Fallback to environment variables (local development)
  cachedConfig = {
    apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
    apiKey: import.meta.env.VITE_API_KEY || 'dev-key'
  };

  return cachedConfig;
}

async function getHeaders(): Promise<HeadersInit> {
  const config = await loadConfig();
  return {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey
  };
}

interface FetchMetricsOptions {
  startTime?: string;
  endTime?: string;
  period?: number;
  sessionId?: string;
  userId?: string;
  instanceId?: string;
}

export async function fetchMetrics(
  fleet: string,
  options: FetchMetricsOptions = {}
): Promise<MetricsResponse> {
  const config = await loadConfig();
  const params = new URLSearchParams({
    fleet,
    ...(options.startTime && { startTime: options.startTime }),
    ...(options.endTime && { endTime: options.endTime }),
    ...(options.period && { period: options.period.toString() }),
    ...(options.sessionId && { sessionId: options.sessionId }),
    ...(options.userId && { userId: options.userId }),
    ...(options.instanceId && { instanceId: options.instanceId })
  });

  const response = await fetch(`${config.apiUrl}/metrics?${params}`, {
    headers: await getHeaders()
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.statusText}`);
  }

  return response.json();
}

export async function fetchSessions(
  stackName: string,
  fleetName: string
): Promise<Session[]> {
  const config = await loadConfig();
  const params = new URLSearchParams({
    stackName,
    fleetName
  });

  const response = await fetch(`${config.apiUrl}/sessions?${params}`, {
    headers: await getHeaders()
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch sessions: ${response.statusText}`);
  }

  const data = await response.json();
  return data.sessions || [];
}

export async function createSession(
  stackName: string,
  fleetName: string,
  userId: string
): Promise<{ streamingUrl: string }> {
  const config = await loadConfig();

  const response = await fetch(`${config.apiUrl}/sessions`, {
    method: 'POST',
    headers: await getHeaders(),
    body: JSON.stringify({
      stackName,
      fleetName,
      userId
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.statusText}`);
  }

  return response.json();
}

export async function fetchNucleusStatus(): Promise<NucleusStatus> {
  const config = await loadConfig();
  const response = await fetch(`${config.apiUrl}/nucleus/status`, {
    headers: await getHeaders()
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Nucleus status: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchNucleusMetrics(
  options: { startTime?: string; endTime?: string; period?: number } = {}
): Promise<NucleusMetricsResponse> {
  const config = await loadConfig();
  const params = new URLSearchParams({
    ...(options.startTime && { startTime: options.startTime }),
    ...(options.endTime && { endTime: options.endTime }),
    ...(options.period && { period: options.period.toString() })
  });
  const response = await fetch(`${config.apiUrl}/nucleus/metrics?${params}`, {
    headers: await getHeaders()
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Nucleus metrics: ${response.statusText}`);
  }
  return response.json();
}
