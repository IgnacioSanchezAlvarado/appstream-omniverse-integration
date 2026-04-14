import { MetricsResponse, NucleusMetricsResponse } from '../types';
import SummaryCard from './SummaryCard';
import './NucleusMetrics.css';

import { useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const NUCLEUS_METRIC_CONFIG: Record<string, { name: string; color: string; glowClass: string }> = {
  NucleusApiLatency: {
    name: 'API Latency',
    color: '#f97316',
    glowClass: 'glow-nucleus-latency'
  },
  NucleusCpuUtilization: {
    name: 'CPU',
    color: '#8b5cf6',
    glowClass: 'glow-nucleus-cpu'
  },
  NucleusMemoryUtilization: {
    name: 'Memory',
    color: '#ec4899',
    glowClass: 'glow-nucleus-memory'
  },
  NucleusDiskUsage: {
    name: 'Disk',
    color: '#14b8a6',
    glowClass: 'glow-nucleus-disk'
  }
};

interface NucleusMetricsProps {
  nucleusMetrics: NucleusMetricsResponse | null;
  appstreamMetrics: MetricsResponse | null;
  loading: boolean;
  isDark?: boolean;
}

export default function NucleusMetrics({ nucleusMetrics, appstreamMetrics, isDark = true }: NucleusMetricsProps) {
  if (!nucleusMetrics) {
    return null;
  }

  return (
    <div className="nucleus-metrics-section">
      <div className="nucleus-section-header">
        <h2 className="section-title">
          {/* nosemgrep: jsx-not-internationalized */}
          <span className="section-prefix">Nucleus</span>
          {/* nosemgrep: jsx-not-internationalized */}
          Performance Metrics
        </h2>
        {/* nosemgrep: jsx-not-internationalized */}
        <span className="section-subtitle mono">Server-side metrics from NVIDIA Nucleus</span>
      </div>

      <div className="summary-grid">
        {Object.entries(NUCLEUS_METRIC_CONFIG).map(([metricKey, config]) => {
          const summary = nucleusMetrics.summary[metricKey];
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

      {appstreamMetrics && nucleusMetrics.metrics.NucleusApiLatency && appstreamMetrics.metrics.InSessionLatency && (
        <div className="latency-comparison-container fade-in">
          <LatencyComparisonChart
            appstreamLatency={appstreamMetrics.metrics.InSessionLatency.datapoints}
            nucleusLatency={nucleusMetrics.metrics.NucleusApiLatency.datapoints}
            isDark={isDark}
          />
        </div>
      )}
    </div>
  );
}

function LatencyComparisonChart({
  appstreamLatency,
  nucleusLatency,
  isDark = true
}: {
  appstreamLatency: { timestamp: string; average: number; minimum: number; maximum: number }[];
  nucleusLatency: { timestamp: string; average: number; minimum: number; maximum: number }[];
  isDark?: boolean;
}) {
  const chartRef = useRef<ChartJS<'line'>>(null);

  // Theme-aware colors
  const gridColor = isDark ? '#2d3548' : '#e2e8f0';
  const tickColor = isDark ? '#94a3b8' : '#64748b';
  const tooltipBg = isDark ? '#1a1f2e' : '#ffffff';
  const tooltipBorder = isDark ? '#3a4258' : '#e2e8f0';
  const tooltipTextColor = isDark ? '#e2e8f0' : '#1e293b';
  const pointBorderColor = isDark ? '#1e2433' : '#ffffff';
  const legendColor = isDark ? '#94a3b8' : '#64748b';
  const titleColor = isDark ? '#64748b' : '#94a3b8';

  const sortedAppstream = [...appstreamLatency].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const sortedNucleus = [...nucleusLatency].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const labels = sortedAppstream.map((dp) => {
    const date = new Date(dp.timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const data = {
    labels,
    datasets: [
      {
        label: 'AppStream Streaming Latency (ms)',
        data: sortedAppstream.map((dp) => dp.average),
        borderColor: 'var(--color-latency)',
        backgroundColor: 'rgba(251, 191, 36, 0.1)',
        borderWidth: 2,
        fill: false,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: 'var(--color-latency)',
        pointBorderColor: pointBorderColor,
        pointBorderWidth: 2,
      },
      {
        label: 'Nucleus API Latency (ms)',
        data: sortedNucleus.map((dp) => dp.average),
        borderColor: '#f97316',
        backgroundColor: 'rgba(249, 115, 22, 0.1)',
        borderWidth: 2,
        fill: false,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#f97316',
        pointBorderColor: pointBorderColor,
        pointBorderWidth: 2,
      }
    ]
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: {
          color: legendColor,
          font: { family: 'Inter', size: 11 },
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 20,
        }
      },
      title: { display: false },
      tooltip: {
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: 12,
        titleColor: tooltipTextColor,
        bodyColor: tooltipTextColor,
        titleFont: { family: 'Inter', size: 12, weight: 'bold' },
        bodyFont: { family: 'Inter', size: 11 },
        callbacks: {
          label: (context) => `${context.dataset.label}: ${(context.parsed.y ?? 0).toFixed(2)} ms`
        }
      }
    },
    scales: {
      x: {
        grid: { color: gridColor, lineWidth: 1 },
        ticks: { color: tickColor, font: { family: 'Inter', size: 10 }, maxRotation: 45, minRotation: 45 },
        border: { color: tooltipBorder }
      },
      y: {
        grid: { color: gridColor, lineWidth: 1 },
        ticks: {
          color: tickColor,
          font: { family: 'Inter', size: 10 },
          callback: (value) => `${value} ms`
        },
        border: { color: tooltipBorder },
        title: { display: true, text: 'Latency (ms)', color: titleColor, font: { family: 'Inter', size: 11 } }
      }
    }
  };

  return (
    <div className="latency-comparison-chart" style={{ borderTopColor: '#f97316' }}>
      <div className="chart-header">
        {/* nosemgrep: jsx-not-internationalized */}
        <h3 className="chart-title mono" style={{ color: '#f97316' }}>Latency Comparison</h3>
        {/* nosemgrep: jsx-not-internationalized */}
        <span className="chart-unit mono">AppStream vs Nucleus</span>
      </div>
      <div className="chart-body">
        <Line ref={chartRef} data={data} options={options} />
      </div>
      <div className="chart-footer mono">
        <div className="chart-legend">
          <span className="legend-dot" style={{ backgroundColor: 'var(--color-latency)' }}></span>
          {/* nosemgrep: jsx-not-internationalized */}
          <span>AppStream streaming latency (client to server)</span>
        </div>
        <div className="chart-legend">
          <span className="legend-dot" style={{ backgroundColor: '#f97316' }}></span>
          {/* nosemgrep: jsx-not-internationalized */}
          <span>Nucleus API latency (AppStream instance to Nucleus)</span>
        </div>
      </div>
    </div>
  );
}
