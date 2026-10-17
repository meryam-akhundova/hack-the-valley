// Reads "x,y,z" lines from the Arduino over Web Serial, compares the tilt to a
// calibrated "good posture" reading, and tells every tab to dim when you slouch.

const $ = (id) => document.getElementById(id);
const DEFAULTS = { threshold: 15, delay: 3, dim: 60 };
const HYSTERESIS = 3; // degrees: must sit up this far past the threshold to un-dim (stops flicker)

let settings = { ...DEFAULTS };
let baseline = null;   // [x, y, z] when sitting up straight
let smoothed = null;   // smoothed current reading
let slouchSince = null;
let slouching = false;
let connected = false;
let pendingCal = 0;           // readings left before a device-triggered calibration
const CAL_READINGS = 10;      // about 1 second at 10 readings/s

init();

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'baseline']);
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  baseline = stored.baseline || null;
  setupSliders();
  updateCalStatus();
  setSlouching(false);

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
    slouchSince = null;
    setSlouching(false);
    $('angle').textContent = '--';
    setStatus('Disconnected. Plug the Arduino back in or click Connect.', true);
    $('connect').disabled = false;
    $('calibrate').disabled = true;
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
  slouchSince = null;
  setSlouching(false);
  $('angle').textContent = '...';
  $('calStatus').textContent = 'Calibrating, hold still...';
}

async function calibrate() {
  if (!smoothed) return;
  baseline = [...smoothed];
  await chrome.storage.local.set({ baseline });
  slouchSince = null;
  setSlouching(false);
  updateCalStatus();
}

function setSlouching(value) {
  slouching = value;
  chrome.storage.local.set({ slouchState: { slouching: value, dim: settings.dim / 100 } });
  $('state').textContent = value ? 'Slouching: screen dimmed' : 'Good posture';
  $('state').className = 'state ' + (value ? 'bad' : 'ok');
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
