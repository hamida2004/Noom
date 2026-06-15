
/**
 * classifier.js — NOOM on-device inference  v4 (CNN-TCN)
 *
 * Changes vs v1:
 *  1. extractFeatures imported from features.js (not ble.js) — breaks the
 *     ble → classifier → ble circular dependency that caused Metro cold-start
 *     failures where extractFeatures arrived as undefined.
 *  2. Per-subject feature normalisation added (v4 OOD fix).
 *  3. resetSubjectBuffer() exported for ble.js to call on connect/disconnect.
 *  4. predict() signature unchanged — still takes (window) only.
 */

import { extractFeatures } from './features';
import scalersJson from '../assets/model/noom_scalers.json';

// ── Constants ─────────────────────────────────────────────────────────────────
const SEQ_LEN      = 1920;
const N_SIGNALS    = 7;
const N_FEAT       = 14;
const SIGNAL_ORDER = ['bvp', 'acc_x', 'acc_y', 'acc_z', 'temp', 'hr', 'ibi'];

// ── State ─────────────────────────────────────────────────────────────────────
let bridge      = null;
let scalers     = null;
let modelLoaded = false;
let loadPromise = null;

// ── Per-subject feature buffer (v4) ───────────────────────────────────────────
let _subjectFeatVecs = [];

export function resetSubjectBuffer() {
  _subjectFeatVecs = [];
  console.log('[Classifier] Subject buffer reset');
}

function _pushToSubjectBuffer(globalScaledFeats) {
  _subjectFeatVecs.push(Float32Array.from(globalScaledFeats));
  if (_subjectFeatVecs.length > 200) _subjectFeatVecs.shift();
}

function _subjectStats() {
  const n = _subjectFeatVecs.length;
  if (n < 2) {
    return {
      mean: new Float32Array(N_FEAT).fill(0),
      std:  new Float32Array(N_FEAT).fill(1),
    };
  }
  const mean = new Float64Array(N_FEAT);
  for (const v of _subjectFeatVecs)
    for (let j = 0; j < N_FEAT; j++) mean[j] += v[j];
  for (let j = 0; j < N_FEAT; j++) mean[j] /= n;

  const std = new Float64Array(N_FEAT);
  for (const v of _subjectFeatVecs)
    for (let j = 0; j < N_FEAT; j++) std[j] += (v[j] - mean[j]) ** 2;
  for (let j = 0; j < N_FEAT; j++)
    std[j] = Math.sqrt(std[j] / n) + 1e-8;

  return {
    mean: Float32Array.from(mean),
    std:  Float32Array.from(std),
  };
}

// ── Bridge registration ───────────────────────────────────────────────────────
export function setBridge(bridgeInstance) {
  if (!bridgeInstance) {
    console.warn('[Classifier] setBridge called with null — ignoring');
    return;
  }
  bridge = bridgeInstance;
  console.log('[Classifier] Bridge registered ✓');
}

// ── Load model ────────────────────────────────────────────────────────────────
export async function loadModel() {
  if (modelLoaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (!bridge) {
        throw new Error(
          '[Classifier] Bridge not set. Mount <OnnxWebViewBridge> at the app ' +
          'root and call setBridge(ref.current) before loadModel().'
        );
      }
      scalers = scalersJson;
      await bridge.loadModel();
      modelLoaded = true;
      console.log('[Classifier] Ready ✓  (v4 CNN-TCN, per-subject norm ON)');
    } catch (err) {
      console.error('[Classifier] Load failed:', err);
      scalers     = null;
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

// ── Preprocessing ─────────────────────────────────────────────────────────────
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
      scaled[idx] = (rawMatrix[idx] - mean[col]) / (scale[col] + 1e-8);
    }
  }
  return scaled;
}

function scaleFeatsGlobal(rawFeats) {
  const { mean, scale } = scalers.feat_scaler;
  const out = new Float32Array(N_FEAT);
  for (let j = 0; j < N_FEAT; j++)
    out[j] = (rawFeats[j] - mean[j]) / (scale[j] + 1e-8);
  return out;
}

function scaleFeatsPerSubject(globalScaled, stats) {
  const out = new Float32Array(N_FEAT);
  for (let j = 0; j < N_FEAT; j++)
    out[j] = (globalScaled[j] - stats.mean[j]) / stats.std[j];
  return out;
}

// ── Main predict ──────────────────────────────────────────────────────────────
export async function predict(window) {
  if (!bridge) {
    throw new Error('[Classifier] Bridge not set. Call setBridge(ref.current) in App.js.');
  }
  if (!isModelLoaded()) await loadModel();

  // 1. Scale signal matrix
  const rawMatrix    = windowToRawMatrix(window);
  const scaledMatrix = scaleSignalMatrix(rawMatrix);

  // 2. Rebuild scaled window objects for extractFeatures
  const scaledWindow = [];
  for (let row = 0; row < SEQ_LEN; row++) {
    const obj = {};
    for (let col = 0; col < N_SIGNALS; col++)
      obj[SIGNAL_ORDER[col]] = scaledMatrix[row * N_SIGNALS + col];
    scaledWindow.push(obj);
  }
  const rawFeats = extractFeatures(scaledWindow);

  // 3. Global feat scaling
  const globalFeats = scaleFeatsGlobal(rawFeats);

  // 4. Per-subject normalisation (v4 addition)
  _pushToSubjectBuffer(globalFeats);
  const finalFeats = scaleFeatsPerSubject(globalFeats, _subjectStats());

  // 5. Inference via WebView bridge
  const probs = await bridge.predict(
    scaledMatrix,
    finalFeats,
    SEQ_LEN,
    N_SIGNALS,
    N_FEAT,
  );

  return probs;
}