const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const MQTT_HOST  = 'mqtts://1b79e318365946ee963e031a5b434aa8.s1.eu.hivemq.cloud:8883';
const MQTT_USER  = 'Test1';
const MQTT_PASS  = 'SunriseTOSunset';
const TOPIC_CMD  = 'heliolamp/command';
const TOPIC_STATUS = 'heliolamp/status';

let lampStatus = 'unknown';
let mqttConnected = false;

const mqttClient = mqtt.connect(MQTT_HOST, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `heliolamp-server-${Math.random().toString(16).substring(2, 8)}`,
  reconnectPeriod: 2000,
  keepalive: 10,
  clean: false,        // send keepalive ping every 30 seconds
  connectTimeout: 10000,
});

mqttClient.on('connect', () => {
  console.log('Connected to HiveMQ broker');
  mqttConnected = true;
  mqttClient.subscribe(TOPIC_STATUS);
});

mqttClient.on('reconnect', () => {
  console.log('Reconnecting to HiveMQ...');
  mqttConnected = false;
});

mqttClient.on('offline', () => {
  console.log('MQTT offline');
  mqttConnected = false;
});

mqttClient.on('message', (topic, payload) => {
  if (topic === TOPIC_STATUS) {
    lampStatus = payload.toString();
  }
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
  mqttConnected = false;
});

function sendToLamp(message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      reject(new Error('MQTT broker not connected — retrying, please try again in a moment'));
      return;
    }
    mqttClient.publish(TOPIC_CMD, message, { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', mqtt: mqttClient.connected ? 'connected' : 'disconnected', lampStatus });
});

app.get('/status', (req, res) => {
  res.json({ mqtt: mqttClient.connected ? 'connected' : 'disconnected', lampStatus });
});

app.post('/auto', async (req, res) => {
  const brightness = req.body?.brightness ?? 200;
  try {
    await sendToLamp(`auto:${brightness}`);
    res.json({ ok: true, command: `auto:${brightness}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/manual', async (req, res) => {
  const color      = req.body?.color ?? '#ffffff';
  const brightness = req.body?.brightness ?? 200;
  try {
    await sendToLamp(`manual:${color}:${brightness}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/night', async (req, res) => {
  try {
    await sendToLamp('night');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/off', async (req, res) => {
  try {
    await sendToLamp('off');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/schedule', async (req, res) => {
  const sunrise = req.body?.sunrise ?? '06:00';
  const sunset  = req.body?.sunset  ?? '20:00';
  const [sh, sm] = sunrise.split(':').map(Number);
  const [eh, em] = sunset.split(':').map(Number);
  if ((eh * 60 + em) - (sh * 60 + sm) < 120) {
    return res.status(400).json({ ok: false, error: 'Sunset must be at least 2 hours after sunrise.' });
  }
  try {
    await sendToLamp(`schedule:${sunrise}:${sunset}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HelioLamp server running on port ${PORT}`));
