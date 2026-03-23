# KOU Racing Telemetry Gateway

A comprehensive telemetry system for Formula Student Electric vehicles developed by Kocaeli University Racing Team. This gateway captures real-time vehicle data via UDP, sanitizes it for reliability, stores it in InfluxDB for time-series analysis, and provides REST API endpoints for data access.

## Features

- **UDP Data Ingestion**: Receives telemetry packets from vehicles at 5000 port
- **Data Sanitization**: Outlier rejection with Last Known Good (LKG) fallback values
- **Time-Series Storage**: InfluxDB integration for high-performance data persistence
- **Event Logging**: Automatic detection and logging of system faults and state changes
- **REST API**: HTTP endpoints for real-time and historical telemetry data
- **Fault Detection**: Real-time monitoring and alerting for critical system issues
- **Simulator**: Built-in telemetry simulator for testing and development

## Architecture

```
Vehicle → UDP (5000) → Gateway → InfluxDB
                    ↓
               REST API (3001) → Clients (Grafana, Dashboard, etc.)
```

## Prerequisites

- Node.js (v14 or higher)
- InfluxDB 2.x running on localhost:8086
- InfluxDB token with write permissions

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd kouracing-telemetry
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
Create a `.env` file in the root directory:
```env
INFLUX_TOKEN=your-influxdb-token-here
```

4. Ensure InfluxDB is running and configured with:
- Organization: `KOURACING`
- Bucket: `telemetry_data`

## Usage

### Starting the Gateway

```bash
node index.js
```

The gateway will start:
- UDP listener on port 5000
- REST API server on port 3001

### Testing with Simulator

In a separate terminal, run the simulator:

```bash
node simulator.js
```

This will generate realistic telemetry data every second, including occasional faults for testing.

## API Endpoints

### GET /api/telemetry/latest
Returns the most recent telemetry frame.

**Response:**
```json
{
  "rpm": 8500,
  "speed": 45,
  "motor_temp": 65.2,
  "battery_voltage": 378.5,
  "throttle": 0.75,
  "vehicle_state": "Drive",
  "inverter_status": "Active",
  "battery_status": "Normal",
  "fault": false,
  "fault_type": "None",
  "fault_severity": "None"
}
```

### GET /api/telemetry/history?minutes=5
Returns historical telemetry data for the specified time range (default: 5 minutes).

**Query Parameters:**
- `minutes` (optional): Number of minutes of history to retrieve

### GET /api/status
Returns system health status.

**Response:**
```json
{
  "status": "operational",
  "gateway_memory_ok": true,
  "last_vehicle_state": "Drive"
}
```

## Data Sanitization

The gateway implements robust data validation:

- **RPM**: 0-15000 range
- **Speed**: 0-160 km/h range
- **Motor Temperature**: -10°C to 150°C range
- **Throttle**: 0-1 range

Out-of-bounds values are rejected and replaced with Last Known Good (LKG) values.

## Event System

Automatic event detection and logging:

- **System Start/Stop**: Gateway initialization events
- **Fault Detection**: Critical fault alerts with severity levels
- **Fault Resolution**: Recovery event logging
- **State Changes**: Vehicle state transitions

## Configuration

Key configuration parameters in `index.js`:

```javascript
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const INFLUX_ORG = 'KOURACING';
const INFLUX_BUCKET = 'telemetry_data';
const INFLUX_URL = 'http://localhost:8086';

const UDP_PORT = 5000;
const API_PORT = 3001;
```

## Monitoring & Visualization

The telemetry data is optimized for integration with:

- **Grafana**: Real-time dashboards and historical analysis
- **InfluxDB UI**: Direct database queries and visualization
- **Custom Dashboards**: REST API integration for web/mobile apps

## Development

### Project Structure

```
kouracing-telemetry/
├── index.js          # Main gateway application
├── simulator.js      # Telemetry data simulator
├── package.json      # Dependencies and scripts
└── README.md         # This file
```

### Adding New Telemetry Fields

1. Update the UDP message parsing in `index.js`
2. Add sanitization logic if needed
3. Include the field in the InfluxDB Point creation
4. Update API responses

### Testing

Run the simulator alongside the gateway to test:
- Data ingestion and sanitization
- Fault detection and event logging
- API endpoint functionality
- InfluxDB data persistence

## License

ISC License

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly with the simulator
5. Submit a pull request

## Support

For questions or issues, please contact the KOU Racing Team development team.</content>
<parameter name="filePath">c:\Users\dev\Desktop\kouracing-telemetry\README.md