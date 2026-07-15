const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- SUPABASE ----------
const SUPABASE_URL    = 'https://dsgzxxcpiqjcaztifgrj.supabase.co';
const SUPABASE_ANON   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzZ3p4eGNwaXFqY2F6dGlmZ3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwODEwOTMsImV4cCI6MjA5OTY1NzA5M30.1DIKbu_g52DAi412IJC9BaQHoEYDrCCwgC0FbPXXD_Y';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------- MQTT ----------
const TOPIC_STATUS = 'heliolamp/status';
let mqttClient = null;

function getLampTopic(deviceId) {
  return `heliolamp/${deviceId}/command`;
}

function sendToLamp(deviceId, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      reject(new Error('MQTT not connected'));
      return;
    }
    mqttClient.publish(getLampTopic(deviceId), message, { qos: 0 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------- AUTH MIDDLEWARE ----------
// Verifies the user's Supabase JWT token and attaches user to request
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No token provided' });
  }
  const token = authHeader.substring(7);
  try {
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ ok: false, error: 'Invalid token' });
    }
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token verification failed' });
  }
}

// Helper: get a lamp and verify it belongs to the current user
async function getUserLamp(lampId, userId, token) {
  const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data, error } = await userSupabase
    .from('lamps')
    .select('*')
    .eq('id', lampId)
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data;
}

// ---------- PUBLIC ROUTES ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', mqtt: mqttClient?.connected ? 'connected' : 'disconnected' });
});

// ---------- AUTH ROUTES ----------

// POST /auth/signup — create a new account
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email and password required' });
  }
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, user: data.user, session: data.session });
});

// POST /auth/login — log in
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, user: data.user, session: data.session });
});

// ---------- LAMP MANAGEMENT ROUTES ----------

// GET /lamps — get all lamps for the logged-in user
app.get('/lamps', requireAuth, async (req, res) => {
  const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${req.token}` } }
  });
  const { data, error } = await userSupabase
    .from('lamps')
    .select('*, lamp_settings(*)')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, lamps: data });
});

// POST /lamps — register a new lamp
app.post('/lamps', requireAuth, async (req, res) => {
  const { name, device_id } = req.body;
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });

  const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${req.token}` } }
  });

  // Create lamp
  const { data: lamp, error: lampError } = await userSupabase
    .from('lamps')
    .insert({ user_id: req.user.id, name: name || 'My Lamp', device_id })
    .select()
    .single();

  if (lampError) return res.status(500).json({ ok: false, error: lampError.message });

  // Create default settings for the lamp
  await userSupabase
    .from('lamp_settings')
    .insert({ lamp_id: lamp.id });

  // Subscribe to this lamp's status topic
  if (mqttClient?.connected) {
    mqttClient.subscribe(`heliolamp/${device_id}/status`);
  }

  res.json({ ok: true, lamp });
});

// DELETE /lamps/:id — remove a lamp
app.delete('/lamps/:id', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });

  const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${req.token}` } }
  });
  await userSupabase.from('lamps').delete().eq('id', lamp.id);
  res.json({ ok: true });
});

// ---------- LAMP COMMAND ROUTES ----------
// All commands now require a lamp ID and auth token

app.post('/lamps/:id/auto', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });

  const brightness = req.body?.brightness ?? 200;
  const latitude   = req.body?.latitude;
  const longitude  = req.body?.longitude;
  let command = `auto:${brightness}`;
  if (latitude !== undefined && longitude !== undefined) {
    command = `auto:${brightness}:${latitude}:${longitude}`;
  }
  try {
    await sendToLamp(lamp.device_id, command);
    // Save settings to database
    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${req.token}` } }
    });
    await userSupabase.from('lamp_settings').upsert({
      lamp_id: lamp.id, brightness, mode: 'auto',
      ...(latitude && { latitude }),
      ...(longitude && { longitude }),
      updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/lamps/:id/nightlight', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });

  const enabled = req.body?.enabled ?? false;
  try {
    await sendToLamp(lamp.device_id, enabled ? 'nightlight:on' : 'nightlight:off');
    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${req.token}` } }
    });
    await userSupabase.from('lamp_settings').upsert({
      lamp_id: lamp.id, night_light: enabled, updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/lamps/:id/schedule', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });

  const sunrise = req.body?.sunrise ?? '06:00';
  const sunset  = req.body?.sunset  ?? '20:00';
  const [sh, sm] = sunrise.split(':').map(Number);
  const [eh, em] = sunset.split(':').map(Number);
  if ((eh * 60 + em) - (sh * 60 + sm) < 120) {
    return res.status(400).json({ ok: false, error: 'Sunset must be at least 2 hours after sunrise.' });
  }
  try {
    await sendToLamp(lamp.device_id, `schedule:${sunrise}:${sunset}`);
    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${req.token}` } }
    });
    await userSupabase.from('lamp_settings').upsert({
      lamp_id: lamp.id, sunrise, sunset, mode: 'custom', updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/lamps/:id/off', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });
  try {
    await sendToLamp(lamp.device_id, 'off');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- START EXPRESS FIRST ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HelioLamp server running on port ${PORT}`);

  // Connect to MQTT after Express is listening
  mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883', {
    clientId: `heliolamp-server-${Math.random().toString(16).substring(2, 8)}`,
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
  mqttClient.on('error', (err) => console.error('MQTT error:', err.message));
  mqttClient.on('message', (topic, payload) => {
    console.log(`Status from ${topic}: ${payload.toString()}`);
  });
});
