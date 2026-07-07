// HelioLamp Backend Server
// Receives commands from the app via HTTPS and forwards them to the lamp via MQTT.
// Deploy on Railway — works from anywhere in the world.

const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- HIVEMQ CREDENTIALS ----------
const MQTT_HOST  = 'mqtts://1b79e318365946ee963e031a5b434aa8.s1.eu.hivemq.cloud:8883';
const MQTT_USER  = 'Test1';
const MQTT_PASS  = 'SunriseTOSunset';
const TOPIC_CMD  = 'heliolamp/command';
const TOPIC_STATUS = 'heliolamp/status';

// ---------- MQTT CONNECTION ----------
let lampStatus = 'unknown';

const mqttClient = mqtt.connect(MQTT_HOST, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `heliolamp-server-${Math.random().toString(16).substring(2, 8)}`,
  reconnectPeriod: 3000,
});

mqttClient.on('connect', () => {
  console.log('Connected to HiveMQ broker');
  mqttClient.subscribe(TOPIC_STATUS);
});

mqttClient.on('message', (topic, payload) => {
  if (topic === TOPIC_STATUS) {
    lampStatus = payload.toString();
    console.log('Lamp status:', lampStatus);
  }
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

// ---------- HELPER ----------
function sendToLamp(message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      reject(new Error('Not connected to MQTT broker'));
      return;
    }
    mqttClient.publish(TOPIC_CMD, message, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------- API ROUTES ----------

// Health check — Railway uses this to confirm the server is running
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    lampStatus,
  });
});

// Get lamp status
app.get('/status', (req, res) => {
  res.json({
    mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    lampStatus,
  });
});

// Switch to automatic mode
// POST /auto  body: { brightness: 200 }
app.post('/auto', async (req, res) => {
  const brightness = req.body?.brightness ?? 200;
  try {
    await sendToLamp(`auto:${brightness}`);
    res.json({ ok: true, command: `auto:${brightness}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Set manual color
// POST /manual  body: { color: '#ff7a30', brightness: 180 }
app.post('/manual', async (req, res) => {
  const color      = req.body?.color ?? '#ffffff';
  const brightness = req.body?.brightness ?? 200;
  try {
    await sendToLamp(`manual:${color}:${brightness}`);
    res.json({ ok: true, command: `manual:${color}:${brightness}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Turn on night light
// POST /night
app.post('/night', async (req, res) => {
  try {
    await sendToLamp('night');
    res.json({ ok: true, command: 'night' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Turn off lamp
// POST /off
app.post('/off', async (req, res) => {
  try {
    await sendToLamp('off');
    res.json({ ok: true, command: 'off' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Set custom schedule
// POST /schedule  body: { sunrise: '06:00', sunset: '20:00' }
app.post('/schedule', async (req, res) => {
  const sunrise = req.body?.sunrise ?? '06:00';
  const sunset  = req.body?.sunset  ?? '20:00';

  const [sh, sm] = sunrise.split(':').map(Number);
  const [eh, em] = sunset.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);

  if (diff < 120) {
    return res.status(400).json({ ok: false, error: 'Sunset must be at least 2 hours after sunrise.' });
  }

  try {
    await sendToLamp(`schedule:${sunrise}:${sunset}`);
    res.json({ ok: true, command: `schedule:${sunrise}:${sunset}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HelioLamp server running on port ${PORT}`);
});
