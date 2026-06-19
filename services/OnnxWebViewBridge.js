/**
 * OnnxWebViewBridge.js — NOOM (WASM-only)
 *
 * Conv1d (rank-3 Conv op) is unsupported by WebGL's 2-D-only conv kernel,
 * so we use WASM exclusively. The previous abort (status 14070960) was an
 * emscripten OOM/stack-overflow during InferenceSession.create() caused by
 * the WebView's constrained JS heap. Fixes applied:
 *
 *   1. ort.env.wasm.initialMemory = 64  — pre-allocates a 64 MB WASM heap
 *      so ORT doesn't start small and hit an internal realloc abort.
 *   2. ORT-Web bumped to 1.19.0 — meaningfully better WASM memory management
 *      vs 1.17.3.
 *   3. wasmPaths pinned to the same CDN version so .wasm binaries resolve
 *      correctly from the WebView's blank origin.
 *
 * If the model still OOMs after these changes, quantize offline:
 *   from onnxruntime.quantization import quantize_dynamic, QuantType
 *   quantize_dynamic("noom_model.onnx", "noom_model_int8.onnx",
 *                    weight_type=QuantType.QInt8,
 *                    op_types_to_quantize=['Conv','Gemm','MatMul','LSTM'])
 * and swap the ONNX_ASSET require() below to the int8 file.
 */

import React, { useRef, forwardRef, useImperativeHandle, useEffect } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

const ONNX_ASSET = require('../assets/model/noom_model.onnx');
const LOAD_TIMEOUT_MS    = 90_000;
const PREDICT_TIMEOUT_MS = 20_000;
const CHUNK_SIZE         = 512 * 1024;
const pending = new Map();
let _msgId = 0;

async function readB64(assetModule) {
  const [asset] = await Asset.loadAsync(assetModule);
  if (!asset.localUri) throw new Error('Asset has no localUri');
  return FileSystem.readAsStringAsync(asset.localUri, { encoding: 'base64' });
}

const BRIDGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<script>
  var _log = console.log.bind(console);
  console.log = function() {
    var m = Array.prototype.join.call(arguments, ' ');
    _log(m);
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOG', msg: m })); } catch(e) {}
  };
  var _err = console.error.bind(console);
  console.error = function() {
    var m = 'ERROR: ' + Array.prototype.join.call(arguments, ' ');
    _err(m);
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOG', msg: m })); } catch(e) {}
  };
  window.addEventListener('error', function(e) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'ERROR', ctx: 'WINDOW_ERROR',
        error: (e.message || 'unknown') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')
      }));
    } catch(_) {}
  });
  window.addEventListener('unhandledrejection', function(e) {
    try {
      var reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ERROR', ctx: 'UNHANDLED_REJECTION', error: reason }));
    } catch(_) {}
  });
<\/script>

<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort.min.js" crossorigin="anonymous"
  onerror="window.ReactNativeWebView.postMessage(JSON.stringify({type:'ERROR',ctx:'CDN',error:'Failed to load ORT from CDN'}))"><\/script>

<script>
(function() {
  console.log('Bridge runtime starting, ort defined: ' + (typeof ort !== 'undefined'));
  if (typeof ort === 'undefined') {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ERROR', ctx: 'INIT', error: 'ort undefined' }));
    return;
  }

  // ── WASM environment config ───────────────────────────────────────────────
  ort.env.wasm.numThreads   = 1;
  ort.env.wasm.simd         = false;
  ort.env.wasm.proxy        = false;
  // Pin .wasm binary paths to CDN — required when WebView has a blank origin
  // (source={{ html: ... }}) because relative-path resolution fails silently.
  ort.env.wasm.wasmPaths    = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/';
  // Pre-declare a 64 MB initial WASM heap. Default is ~16 MB, which is too
  // small for InferenceSession.create() on a 2.7 MB float32 model — ORT
  // needs 4–6× the raw weight size during graph construction, pushing the
  // internal allocator into abort() before any JS exception can be caught.
  ort.env.wasm.initialMemory = 64;   // MB

  var session      = null;
  var modelChunks  = [];
  var expectedChunks = 0;

  function toRN(obj) { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var u8  = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  }

  function softmax(arr) {
    var m = Math.max.apply(null, arr);
    var e = arr.map(function(v) { return Math.exp(v - m); });
    var s = e.reduce(function(a, b) { return a + b; }, 0);
    return e.map(function(v) { return v / s; });
  }

  function describeError(e) {
    if (typeof e === 'number') {
      return 'ORT backend aborted with raw status code ' + e + ' (likely an emscripten ' +
             'abort/OOM inside the WASM module itself, not a JS exception).';
    }
    if (e && e.message) return e.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  window.addEventListener('message', function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch(e) { return; }

    if (msg.type === 'MODEL_CHUNK') {
      if (msg.chunkIndex === 0) { modelChunks = []; expectedChunks = msg.totalChunks; }
      modelChunks.push(msg.chunk);
      console.log('Received chunk ' + (msg.chunkIndex + 1) + '/' + expectedChunks);
      if (msg.isLast) {
        var fullB64 = modelChunks.join('');
        modelChunks = [];
        console.log('All chunks received. Length: ' + fullB64.length);
        handleLoad({ modelB64: fullB64 });
      }
    } else if (msg.type === 'PREDICT') {
      handlePredict(msg);
    }
  });

  // WASM only — WebGL cannot run Conv1d (rank-3 Conv ops).
  var PROVIDER_CHAINS = [
    { name: 'wasm', eps: ['wasm'] }
  ];

  async function tryCreateSession(buf) {
    var errors = [];
    for (var i = 0; i < PROVIDER_CHAINS.length; i++) {
      var chain = PROVIDER_CHAINS[i];
      try {
        console.log('Attempting session creation with EP: ' + chain.name);
        var s = await ort.InferenceSession.create(buf, {
          executionProviders: chain.eps,
          graphOptimizationLevel: 'basic'
        });
        console.log('Session created successfully with EP: ' + chain.name);
        return { session: s, ep: chain.name };
      } catch (e) {
        var desc = describeError(e);
        console.error('EP ' + chain.name + ' failed: ' + desc);
        errors.push(chain.name + ': ' + desc);
      }
    }
    throw new Error('All execution providers failed -> ' + errors.join(' | '));
  }

  async function handleLoad(msg) {
    try {
      if (session) { toRN({ type: 'MODEL_LOADED' }); return; }
      console.log('Decoding model...');
      var buf = b64ToBuffer(msg.modelB64);
      console.log('Model buffer: ' + buf.byteLength + ' bytes');

      var result = await tryCreateSession(buf);
      session = result.session;

      console.log('Session ready (EP=' + result.ep + '). Inputs: ' + session.inputNames.join(', '));
      toRN({ type: 'MODEL_LOADED', ep: result.ep });
    } catch(e) {
      var errMsg = describeError(e);
      console.error('handleLoad failed: ' + errMsg);
      toRN({ type: 'ERROR', ctx: 'LOAD_MODEL', error: errMsg });
    }
  }

  async function handlePredict(msg) {
    if (!session) { toRN({ type: 'PREDICT_ERROR', id: msg.id, error: 'No session loaded' }); return; }
    try {
      var seqT  = new ort.Tensor('float32', new Float32Array(msg.scaledMatrix),   [1, msg.SEQ_LEN, msg.N_SIGNALS]);
      var featT = new ort.Tensor('float32', new Float32Array(msg.scaledFeatures), [1, msg.N_FEAT]);
      var feeds = {};
      feeds[session.inputNames[0]] = seqT;
      feeds[session.inputNames[1]] = featT;
      var out   = await session.run(feeds);
      var key   = session.outputNames[0];
      var probs = softmax(Array.from(out[key].data));
      toRN({ type: 'PREDICT_RESULT', id: msg.id, probs: probs });
    } catch(e) {
      var errMsg = describeError(e);
      console.error('handlePredict failed: ' + errMsg);
      toRN({ type: 'PREDICT_ERROR', id: msg.id, error: errMsg });
    }
  }

  toRN({ type: 'WEBVIEW_READY' });
})();
<\/script>
</body>
</html>`;

// ── Component ─────────────────────────────────────────────────────────────────
const OnnxWebViewBridge = forwardRef((_props, ref) => {
  const webviewRef    = useRef(null);
  const wvReady       = useRef(false);
  const wvWaiters     = useRef([]);
  const mdLoadPromise = useRef(null);
  const mdLoaded      = useRef(false);
  const mdResolve     = useRef(null);
  const mdReject      = useRef(null);

  useEffect(() => { console.log('[OnnxBridge] mounted'); }, []);
  useImperativeHandle(ref, () => ({ loadModel, predict, isModelLoaded: () => mdLoaded.current }));

  function waitForWebView() {
    if (wvReady.current) return Promise.resolve();
    return new Promise((res, rej) => wvWaiters.current.push({ res, rej }));
  }

  function loadModel() {
    if (mdLoaded.current || mdLoadPromise.current) return Promise.resolve(mdLoadPromise.current);
    mdLoadPromise.current = (async () => {
      await waitForWebView();
      const modelB64 = await readB64(ONNX_ASSET);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mdResolve.current = null;
          mdReject.current  = null;
          reject(new Error('Timeout'));
        }, LOAD_TIMEOUT_MS);
        mdResolve.current = () => { clearTimeout(timer); resolve(); };
        mdReject.current  = (e) => { clearTimeout(timer); reject(e); };
        const total = Math.ceil(modelB64.length / CHUNK_SIZE);
        (async () => {
          for (let i = 0; i < total; i++) {
            const chunk = modelB64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            _inject(JSON.stringify({
              type: 'MODEL_CHUNK', chunk,
              isLast: i === total - 1,
              chunkIndex: i,
              totalChunks: total
            }));
            if (i < total - 1) await new Promise(r => setTimeout(r, 30));
          }
        })().catch(reject);
      });
      mdLoaded.current = true;
    })().catch(e => {
      mdLoadPromise.current = null;
      mdLoaded.current      = false;
      console.error('[OnnxBridge] loadModel failed:', e);
      throw e;
    });
    return mdLoadPromise.current;
  }

  function predict(scaledMatrix, scaledFeatures, SEQ_LEN, N_SIGNALS, N_FEAT) {
    if (!mdLoaded.current) {
      return loadModel().then(() => predict(scaledMatrix, scaledFeatures, SEQ_LEN, N_SIGNALS, N_FEAT));
    }
    return new Promise((resolve, reject) => {
      const id    = _msgId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Predict timeout')); }, PREDICT_TIMEOUT_MS);
      pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject:  e => { clearTimeout(timer); reject(e); }
      });
      _inject(JSON.stringify({
        type: 'PREDICT', id,
        scaledMatrix:    Array.from(scaledMatrix),
        scaledFeatures:  Array.from(scaledFeatures),
        SEQ_LEN, N_SIGNALS, N_FEAT
      }));
    });
  }

  function _inject(jsonStr) {
    const escaped = JSON.stringify(jsonStr);
    webviewRef.current?.injectJavaScript(`(function(){ window.postMessage(${escaped}, '*'); })(); true;`);
  }

  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    switch (msg.type) {
      case 'LOG':
        console.log('[WV]', msg.msg);
        break;
      case 'WEBVIEW_READY':
        wvReady.current = true;
        wvWaiters.current.forEach(w => w.res());
        wvWaiters.current = [];
        break;
      case 'MODEL_LOADED':
        console.log('[OnnxBridge] Model loaded using EP:', msg.ep);
        mdResolve.current?.();
        mdResolve.current = null;
        mdReject.current  = null;
        break;
      case 'PREDICT_RESULT': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg.probs); }
        break;
      }
      case 'PREDICT_ERROR': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.reject(new Error(msg.error)); }
        break;
      }
      case 'ERROR':
        console.error('[OnnxBridge] Error ctx=' + msg.ctx + ':', msg.error);
        if (['LOAD_MODEL', 'CDN', 'INIT'].includes(msg.ctx)) {
          _rejectLoad(msg.ctx + ': ' + msg.error);
        }
        break;
    }
  }

  function _rejectLoad(reason) {
    if (mdReject.current) {
      mdReject.current(new Error(reason));
      mdReject.current      = null;
      mdResolve.current     = null;
      mdLoadPromise.current = null;
    }
    wvWaiters.current.forEach(w => w.rej(new Error(reason)));
    wvWaiters.current = [];
  }

  return (
    <View style={{ width: 0, height: 0, overflow: 'hidden' }}>
      <WebView
        ref={webviewRef}
        originWhitelist={['*']}
        source={{ html: BRIDGE_HTML }}
        onMessage={onMessage}
        javaScriptEnabled
        mixedContentMode="always"
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        style={{ width: 1, height: 1 }}
        onError={() => _rejectLoad('WebView error')}
        onContentProcessDidTerminate={() => _rejectLoad('WebView terminated')}
      />
    </View>
  );
});

export default OnnxWebViewBridge;