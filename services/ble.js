/**
 * ble.js — NOOM-BAND  v4
 *
 * Changes vs previous version:
 *  1. extractFeatures moved to features.js to break circular import with
 *     classifier.js. Import it from there for any external use.
 *  2. resetSubjectBuffer() imported from classifier.js and called in
 *     connectToDevice() to clear the per-subject feature buffer on new session.
 *  3. setOnDataCallback() REMOVED — was deprecated and only aliased to
 *     setCalibrationCallback(). CalibrationScreen now uses setCalibrationCallback()
 *     directly. No other callers existed.
 *  4. All other logic unchanged (ticker, guards, parsers, accGate, callbacks).
 */

import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { Platform, PermissionsAndroid } from 'react-native';
import { resetSubjectBuffer } from './classifier';
import { extractFeatures } from './features';   // re-exported below for back-compat

// ─────────────────────────────────────────────────────────────────────────────
// Re-export extractFeatures so any existing import { extractFeatures } from
// './ble' keeps working without changes.
// ─────────────────────────────────────────────────────────────────────────────
export { extractFeatures };

// ─────────────────────────────────────────────────────────────────────────────
// NOOM-BAND UUIDs — must match main.c exactly
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_NAME_PREFIX  = 'NOOM-BAND';

const NOOM_STREAM_SERVICE = '12341234-5678-1234-1234-123456789abc';
const NOOM_BVP_CHAR_UUID  = '11111111-1111-1111-1111-111111111111';
const NOOM_ACC_CHAR_UUID  = '22222222-2222-2222-2222-222222222222';
const NOOM_TEMP_CHAR_UUID = '33333333-3333-3333-3333-333333333333';
const NOOM_HR_CHAR_UUID   = '44444444-4444-4444-4444-444444444444';
const NOOM_IBI_CHAR_UUID  = '55555555-5555-5555-5555-555555555555';

// ─────────────────────────────────────────────────────────────────────────────
// Window / ticker parameters (must match Python training)
// ─────────────────────────────────────────────────────────────────────────────
const WINDOW_SIZE = 1920;
const STEP_SIZE   = 960;
const SAMPLE_MS   = 1000 / 64;

// ─────────────────────────────────────────────────────────────────────────────
// BLE state
// ─────────────────────────────────────────────────────────────────────────────
let bleManager            = null;
let connectedDevice       = null;
let onConnectionCallback  = null;
let onDisconnectCallback  = null;

let _monitoringCallback   = null;
let _calibrationCallback  = null;

/**
 * Set by MonitoringScreen. Receives every BLE window for sleep inference.
 */
export function setMonitoringCallback(cb)  { _monitoringCallback  = cb; }

/**
 * Set by CalibrationScreen. Receives every BLE window during calibration.
 * Runs in parallel with _monitoringCallback (both fire per window).
 */
export function setCalibrationCallback(cb) { _calibrationCallback = cb; }

// ─────────────────────────────────────────────────────────────────────────────
// Rolling buffer
// ─────────────────────────────────────────────────────────────────────────────
let sampleBuffer = [];
let lastStep     = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Latest values — held-last-value scheme: ticker stamps these at 64 Hz
// ─────────────────────────────────────────────────────────────────────────────
const latestValues = {
  bvp: 0, acc_x: 0, acc_y: 0, acc_z: 0, temp: 36.0, hr: 60, ibi: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Log throttle — one log per channel per second max
// ─────────────────────────────────────────────────────────────────────────────
const _lastLogTime = {};
function _throttleLog(channel, message) {
  const now = Date.now();
  if (!_lastLogTime[channel] || now - _lastLogTime[channel] >= 1000) {
    _lastLogTime[channel] = now;
    console.log(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plausibility guards — out-of-range values keep previous good value
// ─────────────────────────────────────────────────────────────────────────────
const GUARDS = {
  bvp:   { min: -50000, max: 50000 },
  acc_x: { min: -8,     max: 8     },
  acc_y: { min: -8,     max: 8     },
  acc_z: { min: -8,     max: 8     },
  temp:  { min: 10,     max: 45    },
  hr:    { min: 20,     max: 250   },
  ibi:   { min: 200,    max: 3000  },
};

function _guard(key, value) {
  const g = GUARDS[key];
  if (!g) return value;
  if (!isFinite(value)) return latestValues[key];
  if (value < g.min || value > g.max) {
    console.warn(`[BLE] ${key} out of range: ${value} — keeping previous (${latestValues[key]})`);
    return latestValues[key];
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 64 Hz ticker — stamps latestValues into sampleBuffer
// ─────────────────────────────────────────────────────────────────────────────
let tickerHandle = null;

function _startTicker() {
  if (tickerHandle) return;
  console.log('[BLE] 64 Hz ticker started');
  tickerHandle = setInterval(() => {
    _addToBuffer({ ...latestValues, ts: Date.now() });
  }, SAMPLE_MS);
}

function _stopTicker() {
  if (tickerHandle) {
    clearInterval(tickerHandle);
    tickerHandle = null;
    console.log('[BLE] 64 Hz ticker stopped');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BleManager singleton
// ─────────────────────────────────────────────────────────────────────────────
function getBleManager() {
  if (!bleManager) bleManager = new BleManager();
  return bleManager;
}

function _resetBleManager() {
  try { bleManager?.destroy(); } catch (_) {}
  bleManager = new BleManager();
  console.log('[BLE] BleManager reset');
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────────────────────────────────────
export async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true;
  const apiLevel = parseInt(Platform.Version, 10);
  if (apiLevel >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  } else {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BLE state check
// ─────────────────────────────────────────────────────────────────────────────
export async function checkBleState() {
  return new Promise(resolve => {
    getBleManager().onStateChange(state => resolve(state), true);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanning
// ─────────────────────────────────────────────────────────────────────────────
export function scanForDevices(onFound, onError) {
  console.log('[BLE] Starting scan...');
  getBleManager().startDeviceScan(
    null,
    { allowDuplicates: false, scanMode: 2 },
    (error, device) => {
      if (error) {
        console.error('[BLE] Scan error:', error);
        onError?.(error);
        return;
      }
      if (!device) return;
      const deviceName = device.name || device.localName || 'Unknown Device';
      console.log('[BLE] Found device:', {
        id: device.id, localName: device.localName,
        name: device.name, rssi: device.rssi,
      });
      device.displayName = deviceName;
      onFound(device);
    }
  );
}

export function stopScan() {
  getBleManager().stopDeviceScan();
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect
// ─────────────────────────────────────────────────────────────────────────────
export async function connectToDevice(device, onData, onConnect, onDisconnect) {
  if (onData)       _monitoringCallback  = onData;
  if (onConnect)    onConnectionCallback = onConnect;
  if (onDisconnect) onDisconnectCallback = onDisconnect;

  if (device === null) {
    if (connectedDevice) {
      console.log('[BLE] Reusing existing connection');
      await _subscribeToCharacteristics(connectedDevice);
    }
    return connectedDevice;
  }

  sampleBuffer = [];
  lastStep     = 0;
  Object.assign(latestValues, {
    bvp: 0, acc_x: 0, acc_y: 0, acc_z: 0, temp: 36.0, hr: 60, ibi: 0,
  });
  resetSubjectBuffer();   // v4: clear per-subject feature buffer for new session

  try {
    const connected = await device.connect({ autoConnect: false });
    await connected.discoverAllServicesAndCharacteristics();
    connectedDevice = connected;
    console.log('[BLE] Connected:', connected.id);

    connected.onDisconnected((_err, dev) => {
      console.log('[BLE] Disconnected:', dev?.id);
      connectedDevice = null;
      _stopTicker();
      Object.assign(latestValues, {
        bvp: 0, acc_x: 0, acc_y: 0, acc_z: 0, temp: 36.0, hr: 60, ibi: 0,
      });
      sampleBuffer = [];
      lastStep     = 0;
      resetSubjectBuffer();   // v4: also clear on disconnect so reconnect starts fresh
      onDisconnectCallback?.('disconnected');
      _resetBleManager();
    });

    await _subscribeToCharacteristics(connected);
    _startTicker();
    onConnectionCallback?.('connected', connected);
    return connected;

  } catch (error) {
    console.error('[BLE] Connection failed:', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────────────────────────
export async function disconnectDevice() {
  _stopTicker();
  if (connectedDevice) {
    try { await connectedDevice.cancelConnection(); } catch (_) {}
    connectedDevice = null;
  }
  _resetBleManager();
}

export function isConnected()        { return connectedDevice !== null; }
export function getConnectedDevice() { return connectedDevice; }
export function resetBuffer()        { sampleBuffer = []; lastStep = 0; }

// ─────────────────────────────────────────────────────────────────────────────
// getRawSample — snapshot of latest sensor values
// ─────────────────────────────────────────────────────────────────────────────
export function getRawSample() {
  return { ...latestValues, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscribe to characteristics
// ─────────────────────────────────────────────────────────────────────────────
async function _subscribeToCharacteristics(device) {
  const services = await device.services();
  console.log('[BLE] Services:', services.map(s => s.uuid));

  _monitor(device, NOOM_STREAM_SERVICE, NOOM_BVP_CHAR_UUID, buf => {
    const val = _guard('bvp', _parseFloat32(buf));
    latestValues.bvp = val;
    _throttleLog('bvp', `[BLE] BVP  = ${val.toFixed(2)}`);
  });

  _monitor(device, NOOM_STREAM_SERVICE, NOOM_ACC_CHAR_UUID, buf => {
    const [x, y, z] = _parseMPU6050Accel(buf);
    latestValues.acc_x = _guard('acc_x', x);
    latestValues.acc_y = _guard('acc_y', y);
    latestValues.acc_z = _guard('acc_z', z);
    _throttleLog('acc',
      `[BLE] ACC  x=${latestValues.acc_x.toFixed(4)}g  y=${latestValues.acc_y.toFixed(4)}g  z=${latestValues.acc_z.toFixed(4)}g`
    );
  });

  _monitor(device, NOOM_STREAM_SERVICE, NOOM_TEMP_CHAR_UUID, buf => {
    const val = _guard('temp', _parseFloat32(buf));
    latestValues.temp = val;
    _throttleLog('temp', `[BLE] TEMP = ${val.toFixed(2)} °C`);
  });

  _monitor(device, NOOM_STREAM_SERVICE, NOOM_HR_CHAR_UUID, buf => {
    const val = _guard('hr', _parseUint8(buf));
    latestValues.hr = val;
    _throttleLog('hr', `[BLE] HR   = ${val} BPM`);
  });

  _monitor(device, NOOM_STREAM_SERVICE, NOOM_IBI_CHAR_UUID, buf => {
    if (buf.length >= 4) {
      const val = _guard('ibi', _parseFloat32(buf));
      latestValues.ibi = val;
      _throttleLog('ibi', `[BLE] IBI  = ${val.toFixed(1)} ms`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic monitor helper
// ─────────────────────────────────────────────────────────────────────────────
function _monitor(device, serviceUUID, charUUID, callback) {
  device.monitorCharacteristicForService(serviceUUID, charUUID, (error, char) => {
    if (error) {
      console.warn(`[BLE] Monitor error (${charUUID.slice(0, 8)}…):`, error.message);
      return;
    }
    if (char?.value) callback(Buffer.from(char.value, 'base64'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer management
//
// Window fires when:
//   • sampleBuffer has >= WINDOW_SIZE (1920) samples  AND
//   • at least STEP_SIZE (960) new samples since the last window
//
// This gives 50% overlap: one 30-second window every 15 seconds.
// Buffer is capped at 2×WINDOW_SIZE to avoid unbounded growth.
// ─────────────────────────────────────────────────────────────────────────────
function _addToBuffer(sample) {
  sampleBuffer.push(sample);

  if (sampleBuffer.length > WINDOW_SIZE * 2) {
    sampleBuffer = sampleBuffer.slice(-WINDOW_SIZE * 2);
    lastStep = Math.max(0, lastStep - WINDOW_SIZE);
  }

  if (sampleBuffer.length >= WINDOW_SIZE) {
    const newSamples = sampleBuffer.length - lastStep;
    if (newSamples >= STEP_SIZE) {
      const window = sampleBuffer.slice(-WINDOW_SIZE);
      lastStep = sampleBuffer.length;
      _monitoringCallback?.(window);
      _calibrationCallback?.(window);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary parsers
// ─────────────────────────────────────────────────────────────────────────────
function _parseFloat32(buf) {
  if (buf.length < 4) return 0;
  return buf.readFloatLE(0);
}

function _parseUint8(buf) {
  if (buf.length < 1) return 60;
  return buf.readUInt8(0);
}

const MPU6050_SCALE = 16384.0;
function _parseMPU6050Accel(buf) {
  if (buf.length < 6) return [0, 0, 0];
  return [
    buf.readInt16LE(0) / MPU6050_SCALE,
    buf.readInt16LE(2) / MPU6050_SCALE,
    buf.readInt16LE(4) / MPU6050_SCALE,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// ACC Gate
//
// Returns true (moving / awake) when the std-deviation of ACC magnitudes
// across the window exceeds `threshold`.
//
// The threshold is calibrated by CalibrationScreen as the midpoint between:
//   • the mean window-std during the "lie still" phase
//   • the mean window-std during the "walk" phase
//
// This means the threshold and the gate output are in the same unit (g std),
// so they are directly comparable.
// ─────────────────────────────────────────────────────────────────────────────
export function accGate(window, threshold = 0.12) {
  const mags = window.map(s =>
    Math.sqrt((s.acc_x || 0) ** 2 + (s.acc_y || 0) ** 2 + (s.acc_z || 0) ** 2)
  );
  const mean     = mags.reduce((a, b) => a + b, 0) / mags.length;
  const variance = mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length;
  return Math.sqrt(variance) > threshold;
}