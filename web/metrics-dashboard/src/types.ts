export interface MetricDatapoint {
  timestamp: string;
  average: number;
  minimum: number;
  maximum: number;
}

export interface MetricData {
  datapoints: MetricDatapoint[];
  unit: string;
}

export interface MetricSummary {
  current: number;
  average: number;
  minimum: number;
  maximum: number;
  unit: string;
}

export interface MetricsResponse {
  metrics: Record<string, MetricData>;
  summary: Record<string, MetricSummary>;
  query: {
    fleet: string;
    startTime: string;
    endTime: string;
    period: number;
  };
}

export interface Session {
  sessionId: string;
  userId: string;
  state: string;
  startTime: string;
  instanceId: string;
}

export interface RuntimeConfig {
  apiUrl: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  cognitoDomain: string;
  cognitoRedirectUri: string;
  nucleusEnabled?: boolean;
}

export interface NucleusStatus {
  status: string;
  instanceId: string;
  privateIp: string;
  connectionString: string;
  launchTime: string;
  ssmOnline: boolean;
  webUiUrl: string;
}

export interface NucleusMetricsResponse {
  metrics: Record<string, MetricData>;
  summary: Record<string, MetricSummary>;
  query: {
    instanceId: string;
    startTime: string;
    endTime: string;
    period: number;
  };
}
