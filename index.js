/**
 * KOU Racing Telemetry Gateway
 * Captures UDP packets from the vehicle, sanitizes data, logs system events,
 * persists to InfluxDB, broadcasts via WebSockets, and serves a rate-limited REST API.
 */

const express = require('express');
const cors = require('cors');
const dgram = require('dgram');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- CONFIGURATION ---
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const INFLUX_ORG = 'KOURACING';
const INFLUX_BUCKET = 'telemetry_data';
const INFLUX_URL = 'http://localhost:8086';

const UDP_PORT = 5000;
const API_PORT = 3001;

// Threshold Configurations (with fallbacks)
const MAX_MOTOR_TEMP = process.env.MAX_MOTOR_TEMP ? parseFloat(process.env.MAX_MOTOR_TEMP) : 100;
const MIN_BATTERY_VOLTAGE = process.env.MIN_BATTERY_VOLTAGE ? parseFloat(process.env.MIN_BATTERY_VOLTAGE) : 300;
const MAX_BATTERY_VOLTAGE = process.env.MAX_BATTERY_VOLTAGE ? parseFloat(process.env.MAX_BATTERY_VOLTAGE) : 420;

// --- INITIALIZATION ---
const app = express();
app.use(cors());

// DDoS Protection: Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, 
    message: { error: "Too many requests from this IP. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const client = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });

// InfluxDB Write API with Batch Writing Optimization
const writeApi = client.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ns', {
    batchSize: 50,
    flushInterval: 1000,
    maxBufferLines: 10000,
});

const queryApi = client.getQueryApi(INFLUX_ORG);
const udpServer = dgram.createSocket('udp4');

// --- STATE MANAGEMENT ---
let latestTelemetryCache = {};
let lastFaultState = false;
let lastVehicleState = "None";
let isMotorOverheating = false;
let isBatteryAnomaly = false;

let lastSequenceId = -1;
let lastBroadcastTime = 0;
const BROADCAST_INTERVAL_MS = 50; // 20Hz max WebSocket broadcast rate

// Log system initialization
const startEvent = new Point('system_events')
    .tag('event_type', 'System Start')
    .stringField('description', 'Telemetry Gateway, WebSocket, and Security Shield initialized.')
    .stringField('severity', 'Info');
writeApi.writePoint(startEvent);

// --- WEBSOCKET EVENT HANDLERS ---
io.on('connection', (socket) => {
    console.log(`[WEBSOCKET] Client connected: ${socket.id}`);
    
    if (Object.keys(latestTelemetryCache).length !== 0) {
        socket.emit('telemetry_update', latestTelemetryCache);
    }

    socket.on('disconnect', () => {
        console.log(`[WEBSOCKET] Client disconnected: ${socket.id}`);
    });
});

// --- UDP DATA INGESTION & PROCESSING ---
udpServer.on('message', (msg) => {
    try {
        const data = JSON.parse(msg.toString());

        // 0. PACKET ORDERING GUARD — drop out-of-order UDP packets
        if (typeof data.sequence_id === 'number') {
            if (data.sequence_id <= lastSequenceId) {
                return; // stale / duplicate packet — silently discard
            }
            lastSequenceId = data.sequence_id;
        }

        // 1. DATA SANITIZATION — null-out invalid readings, fire SENSOR_FAULT
        const sensorFaults = [];
        if (typeof data.rpm !== 'number' || data.rpm < 0 || data.rpm > 15000) {
            data.rpm = null; sensorFaults.push('rpm');
        }
        if (typeof data.speed !== 'number' || data.speed < 0 || data.speed > 160) {
            data.speed = null; sensorFaults.push('speed');
        }
        if (typeof data.motor_temp !== 'number' || data.motor_temp < -10 || data.motor_temp > 150) {
            data.motor_temp = null; sensorFaults.push('motor_temp');
        }
        if (typeof data.battery_voltage !== 'number' || data.battery_voltage < 0 || data.battery_voltage > 500) {
            data.battery_voltage = null; sensorFaults.push('battery_voltage');
        }
        if (typeof data.throttle !== 'number' || data.throttle < 0 || data.throttle > 1) {
            data.throttle = null; sensorFaults.push('throttle');
        }

        if (sensorFaults.length > 0) {
            const faultPoint = new Point('system_events')
                .tag('event_type', 'SENSOR_FAULT')
                .stringField('description', `Sensor fault detected on: ${sensorFaults.join(', ')}`)
                .stringField('severity', 'Critical');
            writeApi.writePoint(faultPoint);
            io.emit('sensor_fault', { fields: sensorFaults, timestamp: new Date() });
            console.log(`[ALERT] SENSOR_FAULT: ${sensorFaults.join(', ')}`);
        }

        latestTelemetryCache = data;

        // 2. THROTTLED REAL-TIME BROADCAST (max 20Hz to protect clients)
        const now = Date.now();
        if (now - lastBroadcastTime >= BROADCAST_INTERVAL_MS) {
            io.emit('telemetry_update', data);
            lastBroadcastTime = now;
        }

        // 3. PERSIST TELEMETRY DATA
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

        // 4. EVENT ENGINE
        if (data.fault === true && lastFaultState === false) {
            const faultEvent = new Point('system_events')
                .tag('event_type', 'Fault Occurred')
                .stringField('description', `CRITICAL FAULT: ${data.fault_type} detected.`)
                .stringField('severity', data.fault_severity);
            writeApi.writePoint(faultEvent);
            console.log(`[ALERT] Fault Initiated: ${data.fault_type}`);
            
            io.emit('critical_alarm', { type: data.fault_type, timestamp: new Date() });
        } 
        else if (data.fault === false && lastFaultState === true) {
            const resolveEvent = new Point('system_events')
                .tag('event_type', 'Fault Resolved')
                .stringField('description', 'System normalized. Fault cleared.')
                .stringField('severity', 'Info');
            writeApi.writePoint(resolveEvent);
            console.log(`[INFO] System normalized. Fault cleared.`);
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

        // 5. MOTOR AND BATTERY ANOMALY DETECTION
        if (data.motor_temp > MAX_MOTOR_TEMP && !isMotorOverheating) {
            const tempEvent = new Point('system_events')
                .tag('event_type', 'Threshold Alert')
                .stringField('description', `WARNING: Motor overheating! Temp: ${data.motor_temp}°C`)
                .stringField('severity', 'Warning');
            writeApi.writePoint(tempEvent);
            io.emit('critical_alarm', { type: 'MOTOR_OVERHEAT', value: data.motor_temp, timestamp: new Date() });
            isMotorOverheating = true;
            console.log(`[ALERT] Motor overheating detected: ${data.motor_temp}°C`);
        } else if (data.motor_temp <= MAX_MOTOR_TEMP && isMotorOverheating) {
            isMotorOverheating = false;
        }

        if ((data.battery_voltage < MIN_BATTERY_VOLTAGE || data.battery_voltage > MAX_BATTERY_VOLTAGE) && !isBatteryAnomaly) {
            const batteryEvent = new Point('system_events')
                .tag('event_type', 'Threshold Alert')
                .stringField('description', `WARNING: Battery voltage anomaly! Voltage: ${data.battery_voltage}V`)
                .stringField('severity', 'Critical');
            writeApi.writePoint(batteryEvent);
            io.emit('critical_alarm', { type: 'BATTERY_ANOMALY', value: data.battery_voltage, timestamp: new Date() });
            isBatteryAnomaly = true;
            console.log(`[ALERT] Battery anomaly detected: ${data.battery_voltage}V`);
        } else if (data.battery_voltage >= MIN_BATTERY_VOLTAGE && data.battery_voltage <= MAX_BATTERY_VOLTAGE && isBatteryAnomaly) {
            isBatteryAnomaly = false;
        }

    } catch (error) {
        console.error("[GATEWAY ERROR] Malformed payload received. Packet dropped.", error);
    }
});

udpServer.on('listening', () => {
    console.log(`[GATEWAY] UDP Listener active on port ${UDP_PORT}`);
});

// --- REST API ENDPOINTS ---

app.get('/api/telemetry/latest', (req, res) => {
    if (Object.keys(latestTelemetryCache).length === 0) {
        return res.status(404).json({ message: "No telemetry data available." });
    }
    res.json(latestTelemetryCache);
});

app.get('/api/status', (req, res) => {
    res.json({ 
        status: "operational", 
        gateway_memory_ok: true,
        last_vehicle_state: lastVehicleState,
        active_websocket_connections: io.engine.clientsCount
    });
});

app.get('/api/telemetry/history', (req, res) => {
    let minutes = parseInt(req.query.minutes, 10);
    if (isNaN(minutes) || minutes <= 0 || minutes > 1440) minutes = 5;
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
            |> range(start: -${minutes}m)
            |> filter(fn: (r) => r["_measurement"] == "telemetry")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> drop(columns: ["_start", "_stop", "_measurement"])
    `;

    const resultRows = [];
    queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => resultRows.push(tableMeta.toObject(row)),
        error: (error) => res.status(500).json({ error: "Failed to retrieve historical data." }),
        complete: () => res.json(resultRows)
    });
});

app.get('/api/events', (req, res) => {
    let hours = parseInt(req.query.hours, 10);
    if (isNaN(hours) || hours <= 0 || hours > 720) hours = 24;
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
            |> range(start: -${hours}h)
            |> filter(fn: (r) => r["_measurement"] == "system_events")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> drop(columns: ["_start", "_stop", "_measurement"])
            |> sort(columns: ["_time"], desc: true)
    `;

    const resultRows = [];
    queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => resultRows.push(tableMeta.toObject(row)),
        error: (error) => res.status(500).json({ error: "Failed to retrieve system events and faults." }),
        complete: () => res.json(resultRows)
    });
});

process.on('SIGINT', async () => {
    console.log('\n[SYSTEM] Shutting down gracefully...');
    try {
        await writeApi.close();
        console.log('[SYSTEM] InfluxDB write buffer flushed.');
    } catch (e) {
        console.error('[SYSTEM] Error closing InfluxDB connection:', e);
    }
    process.exit(0);
});

httpServer.listen(API_PORT, () => {
    console.log(`[API] REST and WebSocket Server active on port ${API_PORT}`);
});

udpServer.bind(UDP_PORT);