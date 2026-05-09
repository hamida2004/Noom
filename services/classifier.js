/**
 * classifier.js  —  NOOM on-device inference
 * ===========================================
 *
 * Delegates ONNX inference to OnnxWebViewBridge (a hidden WebView running
 * onnxruntime-web). This avoids all JSI/New-Arch conflicts entirely.
 *
 * Setup:
 *   1. Mount <OnnxBridge ref={onnxBridgeRef} /> once in App.js (or root layout)
 *   2. Call setBridge(onnxBridgeRef.current) once after mount
 *   3. Then call loadModel() and predict() as before
 */

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { extractFeatures } from './ble';
import scalersJson from '../assets/model/noom_scalers.json';
// ── Module-scope requires — Metro must see these statically ───────────────────
const ONNX_ASSET    = require('../assets/model/noom_model.onnx');
const SCALERS_ASSET = require('../assets/model/noom_scalers.json');

// ── Constants matching Python training ────────────────────────────────────────
const SEQ_LEN   = 1920;
const N_SIGNALS = 7;
const N_FEAT    = 14;
const SIGNAL_ORDER = ['bvp', 'acc_x', 'acc_y', 'acc_z', 'temp', 'hr', 'ibi'];

// ── State ─────────────────────────────────────────────────────────────────────
let bridge      = null;   // OnnxWebViewBridge ref set by caller
let scalers     = null;
let modelLoaded = false;
let loadPromise = null;

// ── Bridge registration ───────────────────────────────────────────────────────
export function setBridge(bridgeInstance) {
  bridge = bridgeInstance;
}

// ── Load scalers + trigger model load in WebView ──────────────────────────────
export async function loadModel() {
  if (modelLoaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (!bridge) {
        throw new Error('[Classifier] Bridge not set.');
      }

      // JSON already bundled by Metro
      scalers = scalersJson;

      // Load ONNX model inside WebView
      await bridge.loadModel();

      modelLoaded = true;

      console.log('[Classifier] Ready ✓');

    } catch (err) {

      console.error('[Classifier] Load failed:', err);

      scalers = null;
      modelLoaded = false;
      loadPromise = null;

      throw err;
    }
  })();

  return loadPromise;
}

export function isModelLoaded() {
  return modelLoaded && scalers !== null;
}

// ── Preprocessing (runs on RN side, JS-only) ──────────────────────────────────
function windowToRawMatrix(window) {
  const matrix = new Float32Array(SEQ_LEN * N_SIGNALS);
  for (let row = 0; row < SEQ_LEN; row++) {
    const sample = window[row] ?? {};
    for (let col = 0; col < N_SIGNALS; col++) {
      matrix[row * N_SIGNALS + col] = sample[SIGNAL_ORDER[col]] ?? 0;
    }
  }
  return matrix;
}

function scaleSignalMatrix(rawMatrix) {
  const { mean, scale } = scalers.signal_scaler;
  const scaled = new Float32Array(rawMatrix.length);
  for (let row = 0; row < SEQ_LEN; row++) {
    for (let col = 0; col < N_SIGNALS; col++) {
      const idx = row * N_SIGNALS + col;
      scaled[idx] = (rawMatrix[idx] - mean[col]) / ((scale[col] || 1e-8) + 1e-8);
    }
  }
  return scaled;
}

function applyScaler(values, mean, scale) {
  return values.map((v, i) => (v - mean[i]) / ((scale[i] || 1e-8) + 1e-8));
}

// ── Main predict ──────────────────────────────────────────────────────────────
/**
 * @param {object[]} window  — 1920 sample objects
 * @returns {Promise<number[]>} [P_Wake, P_NDeep, P_Deep]
 */
export async function predict(window) {
  if (!isModelLoaded()) await loadModel();

  // 1. Scale signal matrix (on RN side)
  const rawMatrix    = windowToRawMatrix(window);
  const scaledMatrix = scaleSignalMatrix(rawMatrix);

  // 2. Build scaled window objects for feature extraction
  const scaledWindow = [];
  for (let row = 0; row < SEQ_LEN; row++) {
    const obj = {};
    for (let col = 0; col < N_SIGNALS; col++) {
      obj[SIGNAL_ORDER[col]] = scaledMatrix[row * N_SIGNALS + col];
    }
    scaledWindow.push(obj);
  }

  // 3. Extract + scale handcrafted features (on RN side)
  const rawFeatures    = extractFeatures(scaledWindow);
  const scaledFeatures = applyScaler(
    rawFeatures,
    scalers.feat_scaler.mean,
    scalers.feat_scaler.scale,
  );

  // 4. Send tensors to WebView for inference
  const probs = await bridge.predict(
    scaledMatrix,
    scaledFeatures,
    SEQ_LEN,
    N_SIGNALS,
    N_FEAT,
  );

  return probs;
}