/**
 * KOU Racing Telemetry Gateway
 * Captures UDP packets from the vehicle, sanitizes data, logs system events,
 * writes to InfluxDB, and serves data via Express REST API.
 */

const express = require('express');
const cors = require('cors');
const dgram = require('dgram');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
require('dotenv').config();

// --- CONFIGURATION ---
// IMPORTANT: Use environment variables in production (e.g., process.env.INFLUX_TOKEN)
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;const INFLUX_ORG = 'KOURACING';
const INFLUX_BUCKET = 'telemetry_data';
const INFLUX_URL = 'http://localhost:8086';

const UDP_PORT = 5000;
const API_PORT = 3001;

// --- INITIALIZATION ---
const app = express();
app.use(cors());

const client = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = client.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ns');
const queryApi = client.getQueryApi(INFLUX_ORG);
const udpServer = dgram.createSocket('udp4');

// --- STATE MANAGEMENT ---
let latestTelemetryCache = {};
let lastFaultState = false;
let lastVehicleState = "None";

// Last Known Good (LKG) values for Data Sanitization
let lastKnownGood = {
    rpm: 0,
    speed: 0,
    motor_temp: 20,
    battery_voltage: 400,
    throttle: 0
};

// Initialize system log
const startEvent = new Point('system_events')
    .tag('event_type', 'System Start')
    .stringField('description', 'KOU Racing Telemetry Gateway initialized.')
    .stringField('severity', 'Info');
writeApi.writePoint(startEvent);
writeApi.flush();

// --- UDP DATA INGESTION & PROCESSING ---
udpServer.on('message', (msg) => {
    try {
        const data = JSON.parse(msg.toString());

        // 1. DATA SANITIZATION (Outlier Rejection)
        // Ensure sensor values are within physical physical bounds. Fallback to LKG if anomalous.
        if (data.rpm < 0 || data.rpm > 15000) {
            console.warn(`[SANITIZATION] Outlier detected. RPM: ${data.rpm}. Falling back to ${lastKnownGood.rpm}`);
            data.rpm = lastKnownGood.rpm;
        } else {
            lastKnownGood.rpm = data.rpm;
        }

        if (data.speed < 0 || data.speed > 160) {
            console.warn(`[SANITIZATION] Outlier detected. Speed: ${data.speed}. Falling back to ${lastKnownGood.speed}`);
            data.speed = lastKnownGood.speed;
        } else {
            lastKnownGood.speed = data.speed;
        }

        if (data.motor_temp < -10 || data.motor_temp > 150) {
            data.motor_temp = lastKnownGood.motor_temp;
        } else {
            lastKnownGood.motor_temp = data.motor_temp;
        }

        if (data.throttle < 0 || data.throttle > 1) {
            data.throttle = lastKnownGood.throttle;
        } else {
            lastKnownGood.throttle = data.throttle;
        }

        // Update cache for API serving
        latestTelemetryCache = data;

        // 2. PERSIST TELEMETRY DATA
        const telemetryPoint = new Point('telemetry')
            .floatField('rpm', data.rpm)
            .floatField('speed', data.speed)
            .floatField('motor_temp', data.motor_temp)
            .floatField('battery_voltage', data.battery_voltage)
            .floatField('throttle', data.throttle)
            .stringField('vehicle_state', data.vehicle_state)
            .stringField('inverter_status', data.inverter_status)
            .stringField('battery_status', data.battery_status)
            .booleanField('fault', data.fault)
            .stringField('fault_type', data.fault_type)
            .stringField('fault_severity', data.fault_severity);
        writeApi.writePoint(telemetryPoint);

        // 3. EVENT ENGINE (State Change & Fault Detection)
        if (data.fault === true && lastFaultState === false) {
            const faultEvent = new Point('system_events')
                .tag('event_type', 'Fault Occurred')
                .stringField('description', `CRITICAL FAULT: ${data.fault_type} detected.`)
                .stringField('severity', data.fault_severity);
            writeApi.writePoint(faultEvent);
            console.log(`[ALERT] Fault Initiated: ${data.fault_type}`);
        } 
        else if (data.fault === false && lastFaultState === true) {
            const resolveEvent = new Point('system_events')
                .tag('event_type', 'Fault Resolved')
                .stringField('description', 'System normalized. Fault cleared.')
                .stringField('severity', 'Info');
            writeApi.writePoint(resolveEvent);
            console.log(`[INFO] System normalized.`);
        }
        lastFaultState = data.fault;

        if (data.vehicle_state !== lastVehicleState && lastVehicleState !== "None") {
            const stateEvent = new Point('system_events')
                .tag('event_type', 'State Change')
                .stringField('description', `State transition: ${lastVehicleState} -> ${data.vehicle_state}`)
                .stringField('severity', 'Info');
            writeApi.writePoint(stateEvent);
            console.log(`[INFO] State transition: ${data.vehicle_state}`);
        }
        lastVehicleState = data.vehicle_state;

        // Force write to ensure <1s latency for Grafana
        writeApi.flush();

    } catch (error) {
        console.error("[GATEWAY ERROR] Malformed payload received. Packet dropped.", error.message);
    }
});

udpServer.on('listening', () => {
    console.log(`[GATEWAY] UDP Listener active on port ${UDP_PORT}`);
});

// --- REST API ENDPOINTS ---

// GET: Fetch the most recent telemetry frame
app.get('/api/telemetry/latest', (req, res) => {
    if (Object.keys(latestTelemetryCache).length === 0) {
        return res.status(404).json({ message: "No telemetry data available." });
    }
    res.json(latestTelemetryCache);
});

// GET: System health status
app.get('/api/status', (req, res) => {
    res.json({ 
        status: "operational", 
        gateway_memory_ok: true,
        last_vehicle_state: lastVehicleState
    });
});

// GET: Fetch historical telemetry data
app.get('/api/telemetry/history', (req, res) => {
    const minutes = req.query.minutes || 5; 
    
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
            |> range(start: -${minutes}m)
            |> filter(fn: (r) => r["_measurement"] == "telemetry")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> drop(columns: ["_start", "_stop", "_measurement"])
    `;

    const resultRows = [];

    queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
            resultRows.push(tableMeta.toObject(row));
        },
        error: (error) => {
            console.error('[API ERROR] Failed to fetch historical data:', error);
            res.status(500).json({ error: "Failed to retrieve historical data." });
        },
        complete: () => {
            res.json(resultRows);
        }
    });
});

// Start services
app.listen(API_PORT, () => {
    console.log(`[API] REST Server active on port ${API_PORT}`);
});

udpServer.bind(UDP_PORT);