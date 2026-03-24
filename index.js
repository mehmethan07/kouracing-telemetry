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

let lastKnownGood = {
    rpm: 0,
    speed: 0,
    motor_temp: 20,
    battery_voltage: 400,
    throttle: 0
};

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

        // 1. DATA SANITIZATION
        if (data.rpm < 0 || data.rpm > 15000) data.rpm = lastKnownGood.rpm;
        else lastKnownGood.rpm = data.rpm;

        if (data.speed < 0 || data.speed > 160) data.speed = lastKnownGood.speed;
        else lastKnownGood.speed = data.speed;

        if (data.motor_temp < -10 || data.motor_temp > 150) data.motor_temp = lastKnownGood.motor_temp;
        else lastKnownGood.motor_temp = data.motor_temp;

        if (data.throttle < 0 || data.throttle > 1) data.throttle = lastKnownGood.throttle;
        else lastKnownGood.throttle = data.throttle;

        latestTelemetryCache = data;

        // 2. REAL-TIME BROADCAST
        io.emit('telemetry_update', data);

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

        // 5. MOTOR AND BATTERY ANOMALY DETECTION (DOĞRU YER)
        if (data.motor_temp > 100 && !isMotorOverheating) {
            const tempEvent = new Point('system_events')
                .tag('event_type', 'Threshold Alert')
                .stringField('description', `WARNING: Motor overheating! Temp: ${data.motor_temp}°C`)
                .stringField('severity', 'Warning');
            writeApi.writePoint(tempEvent);
            io.emit('critical_alarm', { type: 'MOTOR_OVERHEAT', value: data.motor_temp, timestamp: new Date() });
            isMotorOverheating = true;
            console.log(`[ALERT] Motor overheating detected: ${data.motor_temp}°C`);
        } else if (data.motor_temp <= 100 && isMotorOverheating) {
            isMotorOverheating = false;
        }

        if ((data.battery_voltage < 300 || data.battery_voltage > 420) && !isBatteryAnomaly) {
            const batteryEvent = new Point('system_events')
                .tag('event_type', 'Threshold Alert')
                .stringField('description', `WARNING: Battery voltage anomaly! Voltage: ${data.battery_voltage}V`)
                .stringField('severity', 'Critical');
            writeApi.writePoint(batteryEvent);
            io.emit('critical_alarm', { type: 'BATTERY_ANOMALY', value: data.battery_voltage, timestamp: new Date() });
            isBatteryAnomaly = true;
            console.log(`[ALERT] Battery anomaly detected: ${data.battery_voltage}V`);
        } else if (data.battery_voltage >= 300 && data.battery_voltage <= 420 && isBatteryAnomaly) {
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
        next: (row, tableMeta) => resultRows.push(tableMeta.toObject(row)),
        error: (error) => res.status(500).json({ error: "Failed to retrieve historical data." }),
        complete: () => res.json(resultRows)
    });
});

app.get('/api/events', (req, res) => {
    const hours = req.query.hours || 24; 
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