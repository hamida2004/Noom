/**
 * OnnxWebViewBridge.js — NOOM (Fixed for Large Models)
 *
 * FIX: The v4 CNN-TCN model is larger than v1. Passing it as a base64 string
 * via injectJavaScript hits Android's IPC string limit (~1-2MB), silently
 * truncating the string. This corrupts the ONNX protobuf, causing the WASM
 * backend to crash and throw a raw C++ pointer (e.g., 16987040).
 *
 * SOLUTION: We now pass the local file URI (a very short string) to the WebView.
 * The WebView uses XMLHttpRequest to load the file directly from the device
 * storage, bypassing the base64 encoding and the IPC size limit entirely.
 */

import React, { useRef, forwardRef, useImperativeHandle, useEffect } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';

const ONNX_ASSET = require('../assets/model/noom_model.onnx');

const LOAD_TIMEOUT_MS    = 90_000;
const PREDICT_TIMEOUT_MS = 20_000;

const pending = new Map();
let _msgId = 0;

// Get the local file URI instead of reading as base64
async function getModelLocalUri(assetModule) {
  const [asset] = await Asset.loadAsync(assetModule);
  if (!asset.localUri) throw new Error('Asset has no localUri: ' + JSON.stringify(asset));
  return asset.localUri;
}

// ── Bridge HTML ───────────────────────────────────────────────────────────────
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
</script>

<script
  src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js"
  crossorigin="anonymous"
  onerror="window.ReactNativeWebView.postMessage(JSON.stringify({type:'ERROR',ctx:'CDN',error:'Failed to load ORT from CDN'}))"
></script>

<script>
(function() {
  console.log('Bridge runtime starting, ort defined: ' + (typeof ort !== 'undefined'));

  if (typeof ort === 'undefined') {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'ERROR', ctx: 'INIT', error: 'ort undefined after CDN script tag'
    }));
    return;
  }

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd       = false;
  ort.env.wasm.proxy      = false;

  var session = null;

  function toRN(obj) {
    window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  }

  function softmax(arr) {
    var m = Math.max.apply(null, arr);
    var e = arr.map(function(v) { return Math.exp(v - m); });
    var s = e.reduce(function(a, b) { return a + b; }, 0);
    return e.map(function(v) { return v / s; });
  }

  // Load local file using XHR (more reliable than fetch for file:// URIs in Android WebView)
  function loadLocalFile(uri) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', uri, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (xhr.status === 0 || xhr.status === 200) {
          resolve(xhr.response);
        } else {
          reject(new Error('XHR failed with status: ' + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error('XHR network error')); };
      xhr.send();
    });
  }

  window.addEventListener('message', function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch(e) { return; }
    if      (msg.type === 'LOAD_MODEL') handleLoad(msg);
    else if (msg.type === 'PREDICT')    handlePredict(msg);
  });

  async function handleLoad(msg) {
    try {
      if (session) {
        toRN({ type: 'MODEL_LOADED' });
        return;
      }
      console.log('Loading model from local URI: ' + msg.modelUri);
      
      // Load the file directly from storage (no base64, no size limit!)
      var buf = await loadLocalFile(msg.modelUri);
      console.log('Model buffer loaded: ' + buf.byteLength + ' bytes — creating InferenceSession...');
      
      session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      console.log('Session ready. Inputs: ' + session.inputNames.join(', ') + '  Outputs: ' + session.outputNames.join(', '));
      toRN({ type: 'MODEL_LOADED' });
    } catch(e) {
      var errMsg = (e && e.message) ? e.message : String(e);
      if (typeof e === 'number') {
        errMsg = 'ORT WASM backend crashed (unsupported op or corrupted model). Code: ' + e;
      }
      console.error('handleLoad failed: ' + errMsg);
      toRN({ type: 'ERROR', ctx: 'LOAD_MODEL', error: errMsg });
    }
  }

  async function handlePredict(msg) {
    if (!session) {
      toRN({ type: 'PREDICT_ERROR', id: msg.id, error: 'No session loaded' });
      return;
    }
    try {
      var seqT  = new ort.Tensor('float32', new Float32Array(msg.scaledMatrix),   [1, msg.SEQ_LEN, msg.N_SIGNALS]);
      var featT = new ort.Tensor('float32', new Float32Array(msg.scaledFeatures), [1, msg.N_FEAT]);
      
      // FIX: Use actual input names from the session to avoid hardcoding issues
      var feeds = {};
      feeds[session.inputNames[0]] = seqT;
      feeds[session.inputNames[1]] = featT;

      var out   = await session.run(feeds);
      var key   = session.outputNames[0];
      var probs = softmax(Array.from(out[key].data));
      
      toRN({ type: 'PREDICT_RESULT', id: msg.id, probs: probs });
    } catch(e) {
      console.error('handlePredict failed: ' + e.message);
      toRN({ type: 'PREDICT_ERROR', id: msg.id, error: e.message });
    }
  }

  toRN({ type: 'WEBVIEW_READY' });
})();
</script>
</body>
</html>`;

// ── Component ─────────────────────────────────────────────────────────────────
const OnnxWebViewBridge = forwardRef((_props, ref) => {
  const webviewRef = useRef(null);

  const wvReady   = useRef(false);
  const wvWaiters = useRef([]);

  const mdLoadPromise = useRef(null);
  const mdLoaded      = useRef(false);
  const mdResolve     = useRef(null);
  const mdReject      = useRef(null);

  useEffect(() => {
    console.log('[OnnxBridge] mounted — ORT will load from CDN');
  }, []);

  useImperativeHandle(ref, () => ({
    loadModel,
    predict,
    isModelLoaded: () => mdLoaded.current,
  }));

  function waitForWebView() {
    if (wvReady.current) return Promise.resolve();
    return new Promise((res, rej) => wvWaiters.current.push({ res, rej }));
  }

  function loadModel() {
    if (mdLoaded.current)      return Promise.resolve();
    if (mdLoadPromise.current) return mdLoadPromise.current;

    mdLoadPromise.current = (async () => {
      console.log('[OnnxBridge] Waiting for WebView ready...');
      await waitForWebView();

      // Get the local file URI instead of reading base64
      console.log('[OnnxBridge] Getting local URI for ONNX model...');
      const modelUri = await getModelLocalUri(ONNX_ASSET);
      console.log('[OnnxBridge] Model URI: ' + modelUri);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mdResolve.current = null;
          mdReject.current  = null;
          reject(new Error('[OnnxBridge] loadModel timed out after 90 s'));
        }, LOAD_TIMEOUT_MS);

        mdResolve.current = () => { clearTimeout(timer); resolve(); };
        mdReject.current  = (e) => { clearTimeout(timer); reject(e); };

        // Send the short URI string instead of the massive base64 string
        _inject(JSON.stringify({ type: 'LOAD_MODEL', modelUri }));
      });

      mdLoaded.current = true;
      console.log('[OnnxBridge] Model loaded ✓');
    })().catch(e => {
      mdLoadPromise.current = null;
      mdLoaded.current      = false;
      console.error('[OnnxBridge] loadModel failed:', e.message);
      throw e;
    });

    return mdLoadPromise.current;
  }

  function predict(scaledMatrix, scaledFeatures, SEQ_LEN, N_SIGNALS, N_FEAT) {
    if (!mdLoaded.current) {
      return loadModel().then(() =>
        predict(scaledMatrix, scaledFeatures, SEQ_LEN, N_SIGNALS, N_FEAT));
    }
    return new Promise((resolve, reject) => {
      const id    = _msgId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('[OnnxBridge] predict timed out id=' + id));
      }, PREDICT_TIMEOUT_MS);
      pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject:  e => { clearTimeout(timer); reject(e); },
      });
      _inject(JSON.stringify({
        type: 'PREDICT', id,
        scaledMatrix:   Array.from(scaledMatrix),
        scaledFeatures: Array.from(scaledFeatures),
        SEQ_LEN, N_SIGNALS, N_FEAT,
      }));
    });
  }

  function _inject(jsonStr) {
    const escaped = JSON.stringify(jsonStr);
    webviewRef.current?.injectJavaScript(
      `(function(){ window.postMessage(${escaped}, '*'); })(); true;`
    );
  }

  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }

    switch (msg.type) {
      case 'LOG':
        console.log('[WV]', msg.msg);
        break;
      case 'WEBVIEW_READY':
        console.log('[OnnxBridge] WebView ready ✓');
        wvReady.current = true;
        wvWaiters.current.forEach(w => w.res());
        wvWaiters.current = [];
        break;
      case 'MODEL_LOADED':
        console.log('[OnnxBridge] MODEL_LOADED ✓');
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
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        style={{ width: 1, height: 1 }}
        onError={e => {
          console.error('[OnnxBridge] WebView error:', e.nativeEvent?.description);
          _rejectLoad('WebView error: ' + e.nativeEvent?.description);
        }}
        onContentProcessDidTerminate={() => {
          console.error('[OnnxBridge] WebView process terminated');
          _rejectLoad('WebView process terminated');
        }}
      />
    </View>
  );
});

export default OnnxWebViewBridge;