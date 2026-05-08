/**
 * BLE Service — Empatica E4 Wristband
 *
 * The E4 exposes a GATT streaming service. UUIDs below are the standard
 * Empatica E4 BLE UUIDs. Adjust if using a different wristband.
 *
 * Data channels used by NOOM: BVP, ACC_X/Y/Z, TEMP, HR, IBI
 */

import { BleManager, State } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// ── Empatica E4 Service & Characteristic UUIDs ─────────────────────────────
const E4_SERVICE_UUID            = 'FFFE';
const E4_BVP_CHAR_UUID           = '2A37';   // Blood Volume Pulse
const E4_ACC_CHAR_UUID           = '2A53';   // Accelerometer (X,Y,Z)
const E4_TEMP_CHAR_UUID          = '2A6E';   // Temperature
const E4_HR_CHAR_UUID            = '2A37';   // Heart Rate
const E4_IBI_CHAR_UUID           = '2A92';   // Inter-beat Interval
// ───────────────────────────────────────────────────────────────────────────

const DEVICE_NAME_PREFIX = 'Empatica E4';

let bleManager = null;
let connectedDevice = null;

// Callbacks registered by consumers
let onDataCallback = null;
let onConnectionCallback = null;
let onDisconnectCallback = null;

// ─── 64 Hz rolling buffer (30 s = 1920 samples) ────────────────────────────
// Each sample: { bvp, acc_x, acc_y, acc_z, temp, hr, ibi, ts }
const WINDOW_SIZE = 1920;
const STEP_SIZE   = 960;  // 50% overlap

let sampleBuffer = [];
let lastStep     = 0;

function getBleManager() {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function checkBleState() {
  return new Promise((resolve) => {
    getBleManager().onStateChange((state) => {
      resolve(state);
    }, true);
  });
}

export function scanForDevices(onFound, onError) {
  const manager = getBleManager();
  manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
    if (error) {
      console.error('[BLE] Scan error:', error);
      onError?.(error);
      return;
    }
    if (device && device.name && device.name.startsWith(DEVICE_NAME_PREFIX)) {
      onFound(device);
    }
  });
}

export function stopScan() {
  getBleManager().stopDeviceScan();
}

export async function connectToDevice(device, onData, onConnect, onDisconnect) {
  onDataCallback       = onData;
  onConnectionCallback = onConnect;
  onDisconnectCallback = onDisconnect;

  try {
    const connected = await device.connect({ autoConnect: false });
    await connected.discoverAllServicesAndCharacteristics();
    connectedDevice = connected;

    // Monitor for disconnection
    connected.onDisconnected((error, dev) => {
      console.log('[BLE] Device disconnected:', dev?.id);
      connectedDevice = null;
      onDisconnectCallback?.('disconnected');
    });

    // Subscribe to all channels
    await _subscribeToCharacteristics(connected);

    onConnectionCallback?.('connected', connected);
    return connected;
  } catch (error) {
    console.error('[BLE] Connection failed:', error);
    throw error;
  }
}

export async function disconnectDevice() {
  if (connectedDevice) {
    await connectedDevice.cancelConnection();
    connectedDevice = null;
  }
}

export function isConnected() {
  return connectedDevice !== null;
}

export function getConnectedDevice() {
  return connectedDevice;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function _subscribeToCharacteristics(device) {
  const services = await device.services();
  console.log('[BLE] Services found:', services.map(s => s.uuid));

  // Subscribe BVP
  _monitorCharacteristic(device, E4_SERVICE_UUID, E4_BVP_CHAR_UUID, (val) => {
    _pushSample('bvp', _parseFloat32(val));
  });

  // Subscribe ACC (3-axis packed)
  _monitorCharacteristic(device, E4_SERVICE_UUID, E4_ACC_CHAR_UUID, (val) => {
    const [x, y, z] = _parseAccelerometer(val);
    _pushSampleMulti({ acc_x: x, acc_y: y, acc_z: z });
  });

  // Subscribe TEMP
  _monitorCharacteristic(device, E4_SERVICE_UUID, E4_TEMP_CHAR_UUID, (val) => {
    _pushSample('temp', _parseFloat32(val));
  });

  // Subscribe HR
  _monitorCharacteristic(device, E4_SERVICE_UUID, E4_HR_CHAR_UUID, (val) => {
    _pushSample('hr', _parseUint8(val));
  });

  // Subscribe IBI
  _monitorCharacteristic(device, E4_SERVICE_UUID, E4_IBI_CHAR_UUID, (val) => {
    _pushSample('ibi', _parseFloat32(val));
  });
}

function _monitorCharacteristic(device, serviceUUID, charUUID, callback) {
  device.monitorCharacteristicForService(serviceUUID, charUUID, (error, char) => {
    if (error) {
      // Non-fatal: some UUIDs may not be available
      return;
    }
    if (char?.value) {
      const decoded = Buffer.from(char.value, 'base64');
      callback(decoded);
    }
  });
}

// Rolling sample assembly — fills gaps with NaN for missing channels
let pendingSample = {};

function _pushSample(channel, value) {
  pendingSample[channel] = value;
  _tryFlushSample();
}

function _pushSampleMulti(channels) {
  Object.assign(pendingSample, channels);
  _tryFlushSample();
}

function _tryFlushSample() {
  const required = ['bvp', 'acc_x', 'acc_y', 'acc_z', 'temp', 'hr', 'ibi'];
  const hasAll = required.every(k => pendingSample[k] !== undefined);
  if (hasAll) {
    const sample = { ...pendingSample, ts: Date.now() };
    pendingSample = {};
    _addToBuffer(sample);
  }
}

function _addToBuffer(sample) {
  sampleBuffer.push(sample);

  // Keep only last WINDOW_SIZE samples
  if (sampleBuffer.length > WINDOW_SIZE * 2) {
    sampleBuffer = sampleBuffer.slice(-WINDOW_SIZE * 2);
  }

  // Emit window every STEP_SIZE new samples
  const newSamples = sampleBuffer.length - lastStep;
  if (sampleBuffer.length >= WINDOW_SIZE && newSamples >= STEP_SIZE) {
    const window = sampleBuffer.slice(-WINDOW_SIZE);
    lastStep = sampleBuffer.length;
    onDataCallback?.(window);
  }
}

// ─── Binary parsers ──────────────────────────────────────────────────────────

function _parseFloat32(buffer) {
  if (buffer.length < 4) return 0;
  return buffer.readFloatLE(0);
}

function _parseUint8(buffer) {
  if (buffer.length < 1) return 0;
  return buffer.readUInt8(0);
}

function _parseAccelerometer(buffer) {
  // E4 packs ACC as 3x int16 little-endian, scaled by 64
  if (buffer.length < 6) return [0, 0, 0];
  const x = buffer.readInt16LE(0) / 64.0;
  const y = buffer.readInt16LE(2) / 64.0;
  const z = buffer.readInt16LE(4) / 64.0;
  return [x, y, z];
}

// ─── ACC Gate (rule-based wake detection) ────────────────────────────────────
// σ(‖a‖) > threshold → WAKE
export function accGate(window, threshold = 0.12) {
  const mags = window.map(s => Math.sqrt(
    (s.acc_x || 0) ** 2 +
    (s.acc_y || 0) ** 2 +
    (s.acc_z || 0) ** 2
  ));
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  const variance = mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length;
  const std = Math.sqrt(variance);
  return std > threshold;
}

// ─── Feature extraction (14 physiological features – Branch B) ───────────────
export function extractFeatures(window) {
  const acc_x = window.map(s => s.acc_x || 0);
  const acc_y = window.map(s => s.acc_y || 0);
  const acc_z = window.map(s => s.acc_z || 0);
  const bvp   = window.map(s => s.bvp   || 0);
  const hr    = window.map(s => s.hr    || 0);
  const ibi   = window.map(s => s.ibi   || 0).filter(v => !isNaN(v) && v > 0);
  const temp  = window.map(s => s.temp  || 0);

  const mag   = acc_x.map((x, i) => Math.sqrt(x**2 + acc_y[i]**2 + acc_z[i]**2));

  const mean   = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const std    = arr => { const m = mean(arr); return Math.sqrt(mean(arr.map(v=>(v-m)**2))); };
  const ptp    = arr => Math.max(...arr) - Math.min(...arr);
  const energy = arr => mean(arr.map(v=>v**2));

  // HRV from IBI differences
  let rmssd = 0, sdnn = 0;
  if (ibi.length > 2) {
    const diffs = ibi.slice(1).map((v, i) => v - ibi[i]);
    rmssd = Math.sqrt(mean(diffs.map(d => d**2)));
    sdnn  = std(ibi);
  }

  // TEMP linear slope (negative at N3 onset)
  const n = temp.length;
  const x_mean = (n - 1) / 2;
  const slope = temp.reduce((acc, v, i) => acc + (i - x_mean) * (v - mean(temp)), 0) /
                temp.reduce((acc, _, i) => acc + (i - x_mean)**2, 0);

  // Low-movement ratio (fraction below P10 magnitude)
  const sorted   = [...mag].sort((a,b)=>a-b);
  const p10      = sorted[Math.floor(sorted.length * 0.1)];
  const low_mov  = mag.filter(v => v <= p10 + 1e-6).length / mag.length;

  const hr_std = std(hr);

  return [
    mean(mag),           // 0: acc_mag_mean
    std(mag),            // 1: acc_mag_std
    ptp(mag),            // 2: acc_mag_range
    ptp(acc_z),          // 3: acc_z_range (strongest N3 marker)
    ptp(bvp),            // 4: bvp_range
    energy(bvp),         // 5: bvp_energy
    mean(hr),            // 6: hr_mean
    hr_std,              // 7: hr_std
    rmssd,               // 8: hrv_rmssd
    sdnn,                // 9: hrv_sdnn
    rmssd * hr_std,      // 10: hrv_instability
    mean(temp),          // 11: temp_mean
    slope,               // 12: temp_slope
    low_mov,             // 13: low_mov_ratio
  ];
}