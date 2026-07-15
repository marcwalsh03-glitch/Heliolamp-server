const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL  = 'https://dsgzxxcpiqjcaztifgrj.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzZ3p4eGNwaXFqY2F6dGlmZ3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwODEwOTMsImV4cCI6MjA5OTY1NzA5M30.1DIKbu_g52DAi412IJC9BaQHoEYDrCCwgC0FbPXXD_Y';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

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

function getUserSupabase(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No token provided' });
  }
  const token = authHeader.substring(7);
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ ok: false, error: 'Invalid token' });
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token verification failed' });
  }
}

async function getUserLamp(lampId, userId, token) {
  const { data, error } = await getUserSupabase(token)
    .from('lamps')
    .select('*')
    .eq('id', lampId)
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data;
}

async function saveSettings(lampId, settings, token) {
  await getUserSupabase(token)
    .from('lamp_settings')
    .upsert({ lamp_id: lampId, ...settings, updated_at: new Date().toISOString() },
      { onConflict: 'lamp_id' });
}

// ---------- PUBLIC ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', mqtt: mqttClient?.connected ? 'connected' : 'disconnected' });
});

// ---------- AUTH ----------
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, user: data.user, session: data.session });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, user: data.user, session: data.session });
});

// ---------- LAMPS ----------
app.get('/lamps', requireAuth, async (req, res) => {
  const { data, error } = await getUserSupabase(req.token)
    .from('lamps')
    .select('*, lamp_settings(*)')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, lamps: data });
});

app.post('/lamps', requireAuth, async (req, res) => {
  const { name, device_id } = req.body;
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });

  const db = getUserSupabase(req.token);

  // Check if this is the user's first lamp — if so, make it default
  const { data: existingLamps } = await db.from('lamps').select('id').eq('user_id', req.user.id);
  const isFirst = !existingLamps || existingLamps.length === 0;

  const { data: lamp, error: lampError } = await db
    .from('lamps')
    .insert({ user_id: req.user.id, name: name || 'My Lamp', device_id, is_default: isFirst })
    .select()
    .single();

  if (lampError) return res.status(500).json({ ok: false, error: lampError.message });

  // Create default settings
  await db.from('lamp_settings').insert({ lamp_id: lamp.id });

  if (mqttClient?.connected) mqttClient.subscribe(`heliolamp/${device_id}/status`);

  res.json({ ok: true, lamp });
});

app.delete('/lamps/:id', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });
  await getUserSupabase(req.token).from('lamps').delete().eq('id', lamp.id);
  res.json({ ok: true });
});

// PATCH /lamps/:id/default — set a lamp as the default
app.patch('/lamps/:id/default', requireAuth, async (req, res) => {
  const lamp = await getUserLamp(req.params.id, req.user.id, req.token);
  if (!lamp) return res.status(404).json({ ok: false, error: 'Lamp not found' });

  const db = getUserSupabase(req.token);
  // Clear default from all user's lamps
  await db.from('lamps').update({ is_default: false }).eq('user_id', req.user.id);
  // Set this lamp as default
  await db.from('lamps').update({ is_default: true }).eq('id', lamp.id);
  res.json({ ok: true });
});

// ---------- LAMP COMMANDS ----------
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
    await saveSettings(lamp.id, {
      brightness, mode: 'auto',
      ...(latitude && { latitude }),
      ...(longitude && { longitude }),
    }, req.token);
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
    await saveSettings(lamp.id, { night_light: enabled }, req.token);
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
    await saveSettings(lamp.id, { sunrise, sunset, mode: 'custom' }, req.token);
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

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HelioLamp server running on port ${PORT}`);

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
