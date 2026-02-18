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
}

export default function MetricsChart({
  metricName,
  datapoints,
  unit,
  color
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
        data: sortedDatapoints.map((dp) => dp.average),
        borderColor: color,
        backgroundColor: `${resolvedColor}33`,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        pointBorderColor: '#1e2433',
        pointBorderWidth: 2,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#e2e8f0',
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
        backgroundColor: '#1a1f2e',
        borderColor: color,
        borderWidth: 1,
        padding: 12,
        titleColor: color,
        bodyColor: '#e2e8f0',
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
          color: '#2d3548',
          lineWidth: 1
        },
        ticks: {
          color: '#94a3b8',
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
          color: '#2d3548',
          lineWidth: 1
        },
        ticks: {
          color: '#94a3b8',
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

  // Add gradient effect on mount
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
  }, [resolvedColor]);

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
          <span>Average over time</span>
        </div>
        <div className="chart-info">
          {sortedDatapoints.length} data points
        </div>
      </div>
    </div>
  );
}
