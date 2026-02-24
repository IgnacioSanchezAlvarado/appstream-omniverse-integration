import { useEffect, useRef } from 'react';
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
import { MetricDatapoint } from '../types';
import './MetricsChart.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface MetricsChartProps {
  metricName: string;
  datapoints: MetricDatapoint[];
  unit: string;
  color: string;
  stat?: 'average' | 'maximum' | 'minimum';
  isDark?: boolean;
}

export default function MetricsChart({
  metricName,
  datapoints,
  unit,
  color,
  stat = 'average',
  isDark = true
}: MetricsChartProps) {
  const chartRef = useRef<ChartJS<'line'>>(null);

  // Resolve CSS variable to computed color value for Canvas API
  const resolveColor = (cssColor: string): string => {
    if (cssColor.startsWith('var(')) {
      const varName = cssColor.slice(4, -1).trim();
      return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    }
    return cssColor;
  };
  const resolvedColor = resolveColor(color);

  // Theme-aware colors
  const gridColor = isDark ? '#2d3548' : '#e2e8f0';
  const tickColor = isDark ? '#94a3b8' : '#64748b';
  const tooltipBg = isDark ? '#1a1f2e' : '#ffffff';
  const tooltipBorder = isDark ? '#2d3548' : '#e2e8f0';
  const tooltipTextColor = isDark ? '#e2e8f0' : '#1e293b';
  const pointBorderColor = isDark ? '#1e2433' : '#ffffff';
  const pointHoverBorderColor = isDark ? '#e2e8f0' : '#1e293b';

  // Sort datapoints by timestamp
  const sortedDatapoints = [...datapoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const labels = sortedDatapoints.map((dp) => {
    const date = new Date(dp.timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const data = {
    labels,
    datasets: [
      {
        label: `${metricName} (${unit})`,
        data: sortedDatapoints.map((dp) => dp[stat]),
        borderColor: color,
        backgroundColor: `${resolvedColor}33`,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        pointBorderColor: pointBorderColor,
        pointBorderWidth: 2,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: pointHoverBorderColor,
      }
    ]
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: {
        display: false
      },
      title: {
        display: false
      },
      tooltip: {
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: 12,
        titleColor: color,
        bodyColor: tooltipTextColor,
        titleFont: {
          family: 'Inter',
          size: 12,
          weight: 'bold'
        },
        bodyFont: {
          family: 'Inter',
          size: 11
        },
        callbacks: {
          label: function (context) {
            return `${(context.parsed.y ?? 0).toFixed(2)} ${unit}`;
          }
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: gridColor,
          lineWidth: 1
        },
        ticks: {
          color: tickColor,
          font: {
            family: 'Inter',
            size: 10
          },
          maxRotation: 45,
          minRotation: 45
        },
        border: {
          color: color
        }
      },
      y: {
        grid: {
          color: gridColor,
          lineWidth: 1
        },
        ticks: {
          color: tickColor,
          font: {
            family: 'Inter',
            size: 10
          },
          callback: function (value) {
            return `${value} ${unit}`;
          }
        },
        border: {
          color: color
        }
      }
    }
  };

  // Add gradient effect on mount and theme change
  useEffect(() => {
    if (chartRef.current) {
      const chart = chartRef.current;
      const ctx = chart.ctx;
      const gradient = ctx.createLinearGradient(0, 0, 0, chart.height);
      gradient.addColorStop(0, `${resolvedColor}66`);
      gradient.addColorStop(1, `${resolvedColor}00`);
      chart.data.datasets[0].backgroundColor = gradient;
      chart.update();
    }
  }, [resolvedColor, isDark]);

  return (
    <div className="metrics-chart-container" style={{ borderTopColor: color }}>
      <div className="chart-header">
        <h3 className="chart-title mono" style={{ color }}>
          {metricName}
        </h3>
        <span className="chart-unit mono">{unit}</span>
      </div>
      <div className="chart-body">
        <Line ref={chartRef} data={data} options={options} />
      </div>
      <div className="chart-footer mono">
        <div className="chart-legend">
          <span className="legend-dot" style={{ backgroundColor: color }}></span>
          <span>{stat.charAt(0).toUpperCase() + stat.slice(1)} over time</span>
        </div>
        <div className="chart-info">
          {sortedDatapoints.length} data points
        </div>
      </div>
    </div>
  );
}
