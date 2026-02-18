# AppStream Omniverse Metrics Dashboard

Mission Control-style monitoring dashboard for AppStream Omniverse GPU streaming performance.

## Features

- Real-time performance monitoring (FPS, Latency, Bandwidth, CPU)
- Session filtering (fleet-wide or per-session)
- Auto-refresh with 10-second interval
- Distinctive aerospace-inspired UI design
- Responsive layout for desktop and mobile

## Local Development

### Prerequisites

- Node.js 18+ and npm

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file with API configuration:
   ```
   VITE_API_URL=http://localhost:3000
   VITE_API_KEY=your-dev-api-key
   ```

3. Run development server:
   ```bash
   npm run dev
   ```

   Dashboard will be available at `http://localhost:5173`

## Production Build

Build the static site:

```bash
npm run build
```

The built files will be in the `dist/` directory, ready for deployment to S3 + CloudFront.

## Runtime Configuration

In production, the dashboard fetches `/runtime-config.json` from the deployed site. This file is written by CDK at deploy time and contains:

```json
{
  "apiUrl": "https://xxx.execute-api.eu-central-1.amazonaws.com/prod",
  "apiKey": "xxx"
}
```

## API Endpoints

The dashboard expects these API endpoints:

- `GET /metrics?fleet=<name>&startTime=<iso>&endTime=<iso>&period=<seconds>`
  - Optional query params: `sessionId`, `userId`, `instanceId`
  - Returns: MetricsResponse with datapoints and summary

- `GET /sessions?stackName=<name>&fleetName=<name>`
  - Returns: Array of Session objects

- `POST /sessions` (optional, for session creation)
  - Body: `{ stackName, fleetName, userId }`
  - Returns: `{ streamingUrl }`

## Design

The dashboard features a **Mission Control aesthetic** inspired by aerospace command centers:

- Dark space-themed background with animated grid
- Monospace fonts (JetBrains Mono) and technical display fonts (Rajdhani)
- Color-coded metrics: FPS=green, Latency=amber, Bandwidth=blue, CPU=magenta
- Glowing effects and scan line animations
- Professional, data-focused layout

## Tech Stack

- React 18 + TypeScript
- Vite (fast dev server and build tool)
- Chart.js + react-chartjs-2 (time-series charts)
- CSS custom properties (no UI framework dependencies)

## Metrics Displayed

1. **FramesPerSecond (FPS)** - Streaming frame rate to user
2. **InSessionLatency** - Round-trip latency (ms)
3. **Bandwidth** - Network throughput (Kbps)
4. **CpuUtilizationInstance** - Instance CPU usage (%)

All metrics are automatically collected by AppStream and queried from CloudWatch.
