// Reads "x,y,z" lines from the Arduino over Web Serial, compares the tilt to a
// calibrated "good posture" reading, and tells every tab to dim when you slouch.

const $ = (id) => document.getElementById(id);
const DEFAULTS = { threshold: 15, delay: 3, dim: 60, useModel: true };
const HYSTERESIS = 3; // degrees: must sit up this far past the threshold to un-dim (stops flicker)
const BAD_ON = 0.6;   // AI: bad-posture probability needed to start the dim timer
const BAD_OFF = 0.4;  // AI: must drop below this to un-dim (stops flicker)

let settings = { ...DEFAULTS };
let baseline = null;   // [x, y, z] when sitting up straight
let smoothed = null;   // smoothed current reading
let slouchSince = null;
let slouching = false;
let connected = false;
let pendingCal = 0;           // readings left before a device-triggered calibration
const CAL_READINGS = 10;      // about 1 second at 10 readings/s

let model = null;      // trained posture model from model.json, if there is one
let recent = [];       // last few raw readings, for the model's window
let sinceLast = 0;     // readings since the model last ran
let probs = null;      // smoothed model output
let dimLevel = 0;      // current dim strength sent to tabs
let recording = null;  // { rows, label, person, start } while recording training data

init();

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'baseline', 'person']);
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  baseline = stored.baseline || null;
  setupSliders();
  updateCalStatus();
  chrome.storage.local.set({ slouchState: { slouching: false } });
  setupRecorder(stored.person || '');

  model = await PostureML.load();
  $('useModel').checked = settings.useModel;
  $('useModel').disabled = !model;
  $('useModel').addEventListener('change', () => {
    settings.useModel = $('useModel').checked;
    chrome.storage.local.set({ settings });
    resetDecision();
  });
  $('modelStatus').textContent = model
    ? `Trained ${model.trained_at} · ${model.classes.length} postures · ${(model.cv_accuracy * 100).toFixed(0)}% on unseen data`
    : 'No model yet. Record data and run ml/train.py. Using tilt angle.';

  if (!('serial' in navigator)) {
    setStatus('Web Serial is not available. Use Chrome or Edge on a computer.', true);
    $('connect').disabled = true;
    return;
  }

  $('connect').addEventListener('click', async () => {
    try {
      const port = await navigator.serial.requestPort();
      await connect(port);
    } catch (e) {
      if (e.name !== 'NotFoundError') {
        setStatus('Could not connect: ' + e.message + ' (Close the Arduino Serial Monitor first.)', true);
      }
    }
  });
  $('calibrate').addEventListener('click', calibrate);

  // Reconnect when the Arduino is plugged back in.
  navigator.serial.addEventListener('connect', (e) => {
    if (!connected) connect(e.target).catch(() => {});
  });

  // Reconnect automatically to a port you already allowed.
  const ports = await navigator.serial.getPorts();
  if (ports.length) {
    connect(ports[0]).catch((e) =>
      setStatus('Auto-connect failed: ' + e.message + ' (Is the Arduino Serial Monitor closed?)', true)
    );
  }
}

async function connect(port) {
  await port.open({ baudRate: 9600 });
  connected = true;
  setStatus('Connected');
  $('connect').disabled = true;
  $('calibrate').disabled = false;
  updateRecordButton();
  readLoop(port);
}

async function readLoop(port) {
  const decoder = new TextDecoderStream();
  const piped = port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line.trim());
    }
  } catch (e) {
    // usually the USB cable was unplugged
  } finally {
    reader.releaseLock();
    await piped;
    try { await port.close(); } catch (e) {}
    connected = false;
    smoothed = null;
    resetDecision();
    if (recording) stopRecording();
    $('angle').textContent = '--';
    setStatus('Disconnected. Plug the Arduino back in or click Connect.', true);
    $('connect').disabled = false;
    $('calibrate').disabled = true;
    updateRecordButton();
  }
}

function handleLine(line) {
  // The Arduino sends "CAL" on reset or when its calibrate button is pressed.
  if (line === 'CAL') {
    startCalibrationFromDevice();
    return;
  }

  const v = line.split(',').map(Number);
  if (v.length !== 3 || v.some(Number.isNaN)) return;

  // Smooth out the sensor's jitter.
  smoothed = smoothed ? smoothed.map((s, i) => s * 0.8 + v[i] * 0.2) : v;

  // Collect about a second of fresh readings, then save them as good posture.
  if (pendingCal > 0) {
    pendingCal--;
    if (pendingCal === 0) calibrate();
    return;
  }

  if (!baseline) {
    $('angle').textContent = '--';
    return;
  }

  const angle = angleBetween(smoothed, baseline);
  $('angle').textContent = angle.toFixed(0) + '°';

  if (recording && Date.now() >= recording.start) {
    recording.rows.push([Date.now() - recording.start, ...v, ...baseline]);
    updateRecStatus();
  }

  if (model && settings.useModel) {
    recent.push(v);
    if (recent.length > model.window) recent.shift();
    if (recent.length === model.window && ++sinceLast >= model.hop) {
      sinceLast = 0;
      modelStep();
    }
    return;
  }

  const now = Date.now();
  if (!slouching) {
    if (angle > settings.threshold) {
      if (slouchSince === null) slouchSince = now;
      if (now - slouchSince >= settings.delay * 1000) setSlouching(true);
    } else {
      slouchSince = null;
    }
  } else if (angle < settings.threshold - HYSTERESIS) {
    slouchSince = null;
    setSlouching(false);
  }
}

// Runs the model on the last couple of seconds of readings and decides whether to dim.
function modelStep() {
  const p = PostureML.predict(model, PostureML.features(recent, baseline));
  probs = probs ? probs.map((s, i) => s * 0.5 + p[i] * 0.5) : p;

  const top = probs.indexOf(Math.max(...probs));
  const label = model.classes[top];
  const bad = probs.reduce((s, x, i) => (model.good_classes.includes(model.classes[i]) ? s : s + x), 0);
  $('prediction').textContent = `AI sees: ${label.replace('_', ' ')} (${(probs[top] * 100).toFixed(0)}%) · bad posture ${(bad * 100).toFixed(0)}%`;

  // Moving around (reaching, turning) is not slouching: leave the current state alone.
  if (label === 'moving') {
    slouchSince = null;
    return;
  }

  const now = Date.now();
  if (!slouching) {
    if (bad > BAD_ON) {
      if (slouchSince === null) slouchSince = now;
      if (now - slouchSince >= settings.delay * 1000) setSlouching(true, bad);
    } else {
      slouchSince = null;
    }
  } else if (bad < BAD_OFF) {
    slouchSince = null;
    setSlouching(false);
  } else {
    setSlouching(true, bad); // the worse it looks, the darker it gets
  }
}

function resetDecision() {
  recent = [];
  sinceLast = 0;
  probs = null;
  slouchSince = null;
  $('prediction').textContent = '';
  setSlouching(false);
}

// Angle in degrees between the current gravity direction and the calibrated one.
function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const mag = Math.hypot(...a) * Math.hypot(...b);
  if (!mag) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180 / Math.PI;
}

function startCalibrationFromDevice() {
  smoothed = null;        // throw away readings from before the press
  pendingCal = CAL_READINGS;
  resetDecision();
  $('angle').textContent = '...';
  $('calStatus').textContent = 'Calibrating, hold still...';
}

async function calibrate() {
  if (!smoothed) return;
  baseline = [...smoothed];
  await chrome.storage.local.set({ baseline });
  resetDecision();
  updateCalStatus();
  updateRecordButton();
}

// strength: 0..1 scales the dim slider (the AI passes how sure it is that you're slouching).
function setSlouching(value, strength = 1) {
  const level = value ? (settings.dim / 100) * strength : 0;
  // Skip tiny changes so every tab isn't re-rendering twice a second.
  if (value === slouching && Math.abs(level - dimLevel) < 0.05) return;
  slouching = value;
  dimLevel = level;
  chrome.storage.local.set({ slouchState: { slouching: value, dim: level } });
  $('state').textContent = value ? 'Slouching: screen dimmed' : 'Good posture';
  $('state').className = 'state ' + (value ? 'bad' : 'ok');
}

// --- Recording training data ---

function setupRecorder(person) {
  $('person').value = person;
  $('person').addEventListener('change', () => chrome.storage.local.set({ person: $('person').value.trim() }));
  $('record').addEventListener('click', () => (recording ? stopRecording() : startRecording()));
  updateRecordButton();
}

function startRecording() {
  const person = $('person').value.trim();
  if (!person) {
    $('recStatus').textContent = 'Enter your name first.';
    return;
  }
  // 3 second countdown so you can get into position after clicking.
  recording = { rows: [], label: $('label').value, person, start: Date.now() + 3000 };
  $('label').disabled = $('person').disabled = true;
  updateRecordButton();
  updateRecStatus();
}

function stopRecording() {
  const { rows, label, person } = recording;
  recording = null;
  $('label').disabled = $('person').disabled = false;
  updateRecordButton();
  if (rows.length < 20) {
    $('recStatus').textContent = 'Too short, discarded. Record for at least a few seconds.';
    return;
  }
  const safe = person.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const csv = 't,x,y,z,bx,by,bz,label,person\n' +
    rows.map((r) => [...r, label, safe].join(',')).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `posture_${safe}_${label}_${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('recStatus').textContent = `Saved ${rows.length} readings (${(rows.length / 10).toFixed(0)} s) of ${label}.`;
}

function updateRecStatus() {
  const wait = recording.start - Date.now();
  $('recStatus').textContent = wait > 0
    ? `Get into position... ${Math.ceil(wait / 1000)}`
    : `Recording ${recording.label}: ${(recording.rows.length / 10).toFixed(0)} s`;
}

function updateRecordButton() {
  const btn = $('record');
  btn.disabled = !recording && !(connected && baseline);
  btn.textContent = recording ? 'Stop' : 'Record';
  btn.className = recording ? 'stop' : '';
}

function setupSliders() {
  for (const key of ['threshold', 'delay', 'dim']) {
    const input = $(key);
    const out = $(key + 'Out');
    input.value = settings[key];
    out.textContent = settings[key];
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = input.value;
      chrome.storage.local.set({ settings });
      if (key === 'dim' && slouching) setSlouching(true);
    });
  }
}

function updateCalStatus() {
  $('calStatus').textContent = baseline ? 'Calibrated' : 'Not calibrated';
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

// Closing this tab turns dimming off everywhere.
window.addEventListener('pagehide', () => {
  chrome.storage.local.set({ slouchState: { slouching: false } });
});
