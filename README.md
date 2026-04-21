# KOU Racing Telemetry Gateway

A robust, real-time telemetry gateway designed for Formula Student Electric vehicles. This system securely captures high-frequency UDP vehicle data, performs advanced sanitization, and persists normalized time-series data to InfluxDB. It features a scalable REST API and a throttled WebSocket broadcaster optimized for low-latency dashboards.

## Features

- **UDP Data Ingestion**: High-throughput receiver capturing raw vehicle telemetry on UDP port 5000.
- **Data Sanitization & Validation**: Outlier rejection mapping invalid sensor data to `null` while emitting asynchronous `SENSOR_FAULT` events.
- **Packet Ordering Enforcement**: Drops out-of-order UDP packets via strict `sequence_id` tracking, ensuring time-series monotonicity.
- **Time-Series Persistence**: Integrated with InfluxDB via batch writing (50-point buffer, 1s interval) for nanosecond-precision state storage.
- **Throttled WebSocket Broadcaster**: Downsamples high-frequency incoming telemetry to a smooth 20Hz stream, optimizing connected client performance.
- **State Machine Logging**: Tracks `vehicle_state` transitions, system startup, and dynamically writes fault occurrences/resolutions into an InfluxDB `system_events` measurement.
- **Advanced Anomaly Detection**: Real-time evaluation of motor temperature and battery voltage against environment-defined thresholds.
- **Security & DDoS Mitigation**: REST APIs protected by `express-rate-limit` with strict parameter enforcement to prevent Flux Injection.
- **In-Memory Caching**: Rapid O(1) retrieval of the latest normalized telemetry frame via the `/api/telemetry/latest` endpoint.

## Architecture

```text
Vehicle (Telemetry Unit)
        │ (UDP 5000)
        ▼
Telemetry Gateway ──(Batch Write)──> InfluxDB
        │
        ├─(REST API 3001)─> Historical Analysis (Grafana)
        └─(WebSocket)─────> Real-Time Dashboard
```

## Setup & Deployment

### Prerequisites

- **Environment**: Node.js v18 or later.
- **Database**: InfluxDB v2.x (running locally or within a container network).
- **Hardware Profile**: Fully compatible with ARM64/x64 architectures, including native optimization for Raspberry Pi 5 deployments.

### 1. Environment Configuration

Create a `.env` file in the project root. Only `INFLUX_TOKEN` is mandatory; all other values retain fail-safe defaults.

```dotenv
INFLUX_TOKEN=your-influxdb-token-here

# Database Routing 
# -> Default is 'http://influxdb:8086' for docker networks
# -> Override to 'http://localhost:8086' or Docker Host IP if running bare-metal
INFLUX_URL=http://localhost:8086
INFLUX_ORG=your-org-name
INFLUX_BUCKET=your-bucket-name

# Safety Thresholds (Configurable)
MAX_MOTOR_TEMP=100
MIN_BATTERY_VOLTAGE=300
MAX_BATTERY_VOLTAGE=420
```

### 2. Standard Deployment (Bare-Metal)

For direct host installations:

```bash
git clone https://github.com/mehmethan07/kouracing-telemetry.git
cd kouracing-telemetry
npm install
node index.js
```

### 3. Containerized Deployment (Recommended for Raspberry Pi 5)

The included `Dockerfile` leverages an `alpine` image optimized for ARM64 edge runtime performance. 

Build and run the container:

```bash
docker build -t kouracing-telemetry .

docker run -d \
  --name telemetry-gateway \
  --env-file .env \
  -p 5000:5000/udp \
  -p 3001:3001 \
  kouracing-telemetry
```
*(Note: If InfluxDB is running on the host machine, ensure `INFLUX_URL` in your `.env` points to the host's bridge IP rather than `localhost`, as `localhost` inside the container resolves to the container itself).*

## API Reference

### Telemetry Schema
All incoming UDP packets, API responses, and WebSocket payloads conform strictly to the following structure:

- `sequence_id` (Number)
- `rpm` (Number: 0-15000)
- `speed` (Number: 0-160)
- `motor_temp` (Number: -10 to 150)
- `battery_voltage` (Number: 0-500)
- `throttle` (Number: 0.0-1.0 incoming UDP -> 0-100 normalized outbound)
- `vehicle_state` (String)
- `inverter_status` (String)
- `battery_status` (String)
- `fault` (Boolean)
- `fault_type` (String)
- `fault_severity` (String)
- `fault_timestamp` (ISO 8601 String or null)

### Endpoints
- **`GET /api/telemetry/latest`**: Yields the most recent state frame from memory.
- **`GET /api/telemetry/history?minutes=5`**: Yields historical `telemetry` timeseries arrays.
- **`GET /api/events?hours=24`**: Yields system state changes and critical fault records.
- **`GET /api/status`**: Gateway operational status, WebSocket load, and active memory checks.

## Simulator & Testing

The repository provides an isolated data generator (`simulator.js`) which broadcasts arbitrary UDP telemetry to port 5000. It deterministically injects failure states (motor overheating, inverter faults) for validation.

```bash
node simulator.js
```

## Contributing

Architectural enhancements, integration protocols, and testing optimizations are welcome. When extending the telemetry schema, ensure new properties are explicitly implemented in the sanitization pipeline mapped within `index.js`.

**License**: MIT
