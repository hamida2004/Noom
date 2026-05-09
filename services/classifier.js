/**
 * classifier.js  —  NOOM on-device inference
 * ===========================================
 *
 * Loads noom_model.onnx + noom_scalers.json from the app's asset bundle
 * and exposes a single `predict(window)` function that returns [PW, PN, PD].
 *
 * Column order (CRITICAL — must match Python training):
 *   FEATURES = [BVP, ACC_X, ACC_Y, ACC_Z, TEMP, HR, IBI]   (indices 0–6)
 *
 * Install dependency:
 *   npm install onnxruntime-react-native
 *
 * Place model files at:
 *   noom-app/assets/model/noom_model.onnx
 *   noom-app/assets/model/noom_scalers.json
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { extractFeatures } from './ble';

// ── Constants matching Python training config ─────────────────────────────────
const SEQ_LEN     = 1920;   // 30 s × 64 Hz
const N_SIGNALS   = 7;      // BVP, ACC_X, ACC_Y, ACC_Z, TEMP, HR, IBI
const N_FEAT      = 14;     // hand-crafted feature branch inputs

// Column order for the 7 raw signals — MUST match FEATURES in cnn-tcn.py
const SIGNAL_ORDER = ['bvp', 'acc_x', 'acc_y', 'acc_z', 'temp', 'hr', 'ibi'];

// ── Module-level state ─────────────────────────────────────────────────────────
let session     = null;   // onnxruntime InferenceSession
let scalers     = null;   // { signal_scaler, feat_scaler }
let loadPromise = null;   // ensures we only load once

// ── Load model + scalers ──────────────────────────────────────────────────────

async function _copyAssetToCache(assetModule) {
  // expo-asset downloads the file if not already cached
  const [asset] = await Asset.loadAsync(assetModule);
  return asset.localUri;   // file:// path
}

export async function loadModel() {
  if (session && scalers) return; // already loaded
  if (loadPromise)        return loadPromise;

  loadPromise = (async () => {
    console.log('[Classifier] Loading model…');

    // 1. Copy bundled assets to a readable file URI
    const onnxUri    = await _copyAssetToCache(require('../../assets/model/noom_model.onnx'));
    const scalersUri = await _copyAssetToCache(require('../../assets/model/noom_scalers.json'));

    // 2. Load scalers JSON
    const scalersRaw = await FileSystem.readAsStringAsync(scalersUri);
    scalers = JSON.parse(scalersRaw);
    console.log('[Classifier] Scalers loaded. Features:', scalers.signal_scaler.feature_names);

    // 3. Create ONNX inference session
    session = await InferenceSession.create(onnxUri, {
      executionProviders: ['cpu'],  // 'nnapi' on Android, 'coreml' on iOS if available
    });
    console.log('[Classifier] ONNX session ready. Inputs:', session.inputNames);
  })();

  return loadPromise;
}

export function isModelLoaded() {
  return session !== null && scalers !== null;
}

// ── Z-score normalisation (replicates sklearn StandardScaler.transform) ────────

function applyScaler(values, mean, scale) {
  return values.map((v, i) => (v - mean[i]) / (scale[i] + 1e-8));
}

// ── Build (SEQ_LEN × N_SIGNALS) Float32Array from window ─────────────────────
// The window is an array of {bvp, acc_x, acc_y, acc_z, temp, hr, ibi, ts} objects.
// We must output columns in SIGNAL_ORDER to match the training scaler.

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

// Apply signal scaler row-by-row (each row = one time step, 7 values)
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

// ── Main inference function ───────────────────────────────────────────────────

/**
 * Predict sleep stage probabilities for one 30-second window.
 *
 * @param {object[]} window  Array of 1920 samples: { bvp, acc_x, acc_y, acc_z, temp, hr, ibi }
 * @returns {number[]}       [P_Wake, P_NDeep, P_Deep]  (sum = 1)
 */
export async function predict(window) {
  if (!isModelLoaded()) {
    await loadModel();
  }

  // ── 1. Build raw matrix and apply signal scaler ────────────────────────────
  const rawMatrix    = windowToRawMatrix(window);
  const scaledMatrix = scaleSignalMatrix(rawMatrix);

  // ── 2. Extract 14 hand-crafted features from the SCALED window ────────────
  // extractFeatures() expects an array of objects with named properties.
  // We rebuild that from the scaled matrix so features are on the same
  // normalised scale as the CNN input — exactly like the Python code does.
  const scaledWindow = [];
  for (let row = 0; row < SEQ_LEN; row++) {
    const obj = {};
    for (let col = 0; col < N_SIGNALS; col++) {
      obj[SIGNAL_ORDER[col]] = scaledMatrix[row * N_SIGNALS + col];
    }
    scaledWindow.push(obj);
  }
  const rawFeatures = extractFeatures(scaledWindow);   // Float32Array (14,)

  // ── 3. Apply feature scaler ─────────────────────────────────────────────────
  const scaledFeatures = applyScaler(
    rawFeatures,
    scalers.feat_scaler.mean,
    scalers.feat_scaler.scale,
  );

  // ── 4. Build ONNX tensors ───────────────────────────────────────────────────
  // Model expects:
  //   x_seq  : (1, 1920, 7)  — batch first, then (time, channels)
  //   x_feat : (1, 14)

  const seqTensor  = new Tensor('float32', scaledMatrix,    [1, SEQ_LEN, N_SIGNALS]);
  const featTensor = new Tensor('float32', new Float32Array(scaledFeatures), [1, N_FEAT]);

  // ── 5. Run inference ────────────────────────────────────────────────────────
  const output = await session.run({ x_seq: seqTensor, x_feat: featTensor });
  const logits = output['logits'].data;   // Float32Array of length 3

  // ── 6. Softmax ──────────────────────────────────────────────────────────────
  const maxL = Math.max(...logits);
  const exps = Array.from(logits).map(v => Math.exp(v - maxL));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);   // [PW, PN, PD]
}