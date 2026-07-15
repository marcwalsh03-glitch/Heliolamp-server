const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const MQTT_HOST    = 'mqtt://broker.hivemq.com:1883';
const TOPIC_CMD    = 'heliolamp/command';
const TOPIC_STATUS = 'heliolamp/status';

let lampStatus = 'unknown';

const mqttClient = mqtt.connect(MQTT_HOST, {
  clientId: 'heliolamp-server-permanent',
  reconnectPeriod: 3000,
  keepalive: 30,
  connectTimeout: 10000,
  clean: true,
});

mqttClient.on('connect', () => {
  console.log('Connected to HiveMQ public broker');
  mqttClient.subscribe(TOPIC_STATUS);
});

mqttClient.on('reconnect', () => console.log('Reconnecting...'));
mqttClient.on('offline', () => console.log('MQTT offline'));
mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
  // Don't crash the process on MQTT errors
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
mqttClient.on('message', (topic, payload) => {
  if (topic === TOPIC_STATUS) lampStatus = payload.toString();
});

function sendToLamp(message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      reject(new Error('MQTT not connected - please try again in a moment'));
      return;
    }
    mqttClient.publish(TOPIC_CMD, message, { qos: 0 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', mqtt: mqttClient.connected ? 'connected' : 'disconnected', lampStatus });
});

app.post('/auto', async (req, res) => {
  const brightness = req.body?.brightness ?? 200;
  const latitude   = req.body?.latitude;
  const longitude  = req.body?.longitude;
  let command = `auto:${brightness}`;
  if (latitude !== undefined && longitude !== undefined) {
    command = `auto:${brightness}:${latitude}:${longitude}`;
  }
  try {
    await sendToLamp(command);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/manual', async (req, res) => {
  const color = req.body?.color ?? '#ffffff';
  const brightness = req.body?.brightness ?? 200;
  try {
    await sendToLamp(`manual:${color}:${brightness}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/nightlight', async (req, res) => {
  const enabled = req.body?.enabled ?? false;
  try {
    await sendToLamp(enabled ? 'nightlight:on' : 'nightlight:off');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post