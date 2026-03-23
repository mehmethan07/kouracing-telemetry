/**
 * KOU Racing Telemetry Simulator
 * Generates realistic Formula Student EV telemetry data via UDP.
 * Includes fault injection and EMI noise simulation for testing gateway robustness.
 */

const dgram = require('dgram');
const client = dgram.createSocket('udp4');

const UDP_PORT = 5000;
const UDP_HOST = 'localhost';

function generateRandomTelemetry() {
    // 15% probability of a system fault
    const isFault = Math.random() > 0.85;
    
    let faultType = "None";
    let faultSeverity = "None";
    
    // Baseline operational values
    let motorTemp = parseFloat((Math.random() * (85 - 40) + 40).toFixed(1));
    let batteryVoltage = parseFloat((Math.random() * (400 - 350) + 350).toFixed(1));
    let currentRpm = Math.floor(Math.random() * (12000 - 800) + 800);
    let currentSpeed = Math.floor(Math.random() * 120);

    // Fault state handling
    if (isFault) {
        const faultTypes = ["Motor Overheating", "Battery Anomaly", "Inverter Failure"];
        faultType = faultTypes[Math.floor(Math.random() * faultTypes.length)];
        faultSeverity = "Critical"; 
        
        if (faultType === "Motor Overheating") motorTemp = parseFloat((Math.random() * (120 - 95) + 95).toFixed(1));
        if (faultType === "Battery Anomaly") batteryVoltage = parseFloat((Math.random() * (300 - 250) + 250).toFixed(1));
    }

    // Construct telemetry payload
    const payload = {
        rpm: currentRpm, 
        speed: currentSpeed, 
        motor_temp: motorTemp, 
        battery_voltage: batteryVoltage,
        throttle: parseFloat(Math.random().toFixed(2)),
        vehicle_state: "Drive",
        inverter_status: isFault && faultType === "Inverter Failure" ? "Fault" : "Active",
        battery_status: isFault && faultType === "Battery Anomaly" ? "Error" : "Normal",
        fault: isFault,
        fault_type: faultType,
        fault_severity: faultSeverity,
        fault_timestamp: isFault ? new Date().toISOString() : null
    };

    return JSON.stringify(payload);
}

console.log(`[SIMULATOR] Starting KOU Racing Telemetry Simulator...`);
console.log(`[SIMULATOR] Target: ${UDP_HOST}:${UDP_PORT}`);

// Broadcast telemetry data every 1000ms
setInterval(() => {
    const data = generateRandomTelemetry();
    client.send(data, UDP_PORT, UDP_HOST, (err) => {
        if (err) console.error("[SIMULATOR ERROR] UDP Transmission failed:", err);
    });
}, 1000);