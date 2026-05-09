/**
 * OnnxWebViewBridge.js
 * ====================
 * Runs ONNX inference inside a hidden WebView (real browser engine) so
 * onnxruntime-web's WebAssembly backend works without JSI/New-Arch issues.
 *
 * FULLY OFFLINE — ort.min.js + all .wasm files are read from the app bundle
 * and injected as base64 data URIs. Zero network requests at runtime.
 *
 * Required assets (download once — see README below):
 *   assets/webview/ort.min.js
 *   assets/webview/ort-wasm.wasm
 *   assets/webview/ort-wasm-simd.wasm
 *   assets/webview/ort-wasm-simd-threaded.wasm
 *   assets/model/noom_model.onnx
 *   assets/model/noom_scalers.json
 *
 * Mount ONCE in App.js:
 *   const bridgeRef = useRef(null);
 *   useEffect(() => { setBridge(bridgeRef.current); }, []);
 *   return (
 *     <>
 *       <OnnxWebViewBridge ref={bridgeRef} />
 *       <NavigationContainer>...</NavigationContainer>
 *     </>
 *   );
 *
 * ─── Download commands (run from project root) ────────────────────────────────
 *   mkdir -p assets/webview
 *   V=1.20.1
 *   BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@$V/dist"
 *   curl -L "$BASE/ort.min.js"                        -o assets/webview/ort.min.js
 *   curl -L "$BASE/ort-wasm.wasm"                     -o assets/webview/ort-wasm.wasm
 *   curl -L "$BASE/ort-wasm-simd.wasm"                -o assets/webview/ort-wasm-simd.wasm
 *   curl -L "$BASE/ort-wasm-simd-threaded.wasm"       -o assets/webview/ort-wasm-simd-threaded.wasm
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

// ── Module-scope requires — Metro must see these at parse time ────────────────
const ORT_JS_ASSET    = require('../assets/webview/ort-runtime.bin'); // renamed from ort.min.js — Metro can't transform minified ORT
const WASM_PLAIN      = require('../assets/webview/ort-wasm.wasm');
const WASM_SIMD       = require('../assets/webview/ort-wasm-simd.wasm');
const WASM_SIMD_THR   = require('../assets/webview/ort-wasm-simd-threaded.wasm');
const ONNX_ASSET      = require('../assets/model/noom_model.onnx');

// ── Pending inference map ─────────────────────────────────────────────────────
const pending = new Map();
let _msgId = 0;

// ── Asset helpers ─────────────────────────────────────────────────────────────
async function readB64(assetModule) {
  const [asset] = await Asset.loadAsync(assetModule);
  if (!asset.localUri) throw new Error('Asset has no localUri');
  return FileSystem.readAsStringAsync(asset.localUri, {
    encoding: 'base64',  // EncodingType enum is undefined in some expo-file-system versions
  });
}

// ── Build the full self-contained HTML string ─────────────────────────────────
// All JS and WASM are inlined as base64 data URIs so the WebView never hits
// the network. This takes a few seconds on first mount but runs fully offline.
async function buildOfflineHtml() {
  const [ortJs, wasmPlain, wasmSimd, wasmSimdThr] = await Promise.all([
    readB64(ORT_JS_ASSET),
    readB64(WASM_PLAIN),
    readB64(WASM_SIMD),
    readB64(WASM_SIMD_THR),
  ]);

  // Build data URIs
  const ortJsSrc        = `data:text/javascript;base64,${ortJs}`;
  const wasmPlainSrc    = `data:application/wasm;base64,${wasmPlain}`;
  const wasmSimdSrc     = `data:application/wasm;base64,${wasmSimd}`;
  const wasmSimdThrSrc  = `data:application/wasm;base64,${wasmSimdThr}`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script src="${ortJsSrc}"></script>
<script>
(function () {
  'use strict';

  // ── ort config: single-threaded, no SIMD, use our local WASM files ────────
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd       = false;
  ort.env.wasm.proxy      = false;
  ort.env.wasm.wasmPaths  = {
    'ort-wasm.wasm':                '${wasmPlainSrc}',
    'ort-wasm-simd.wasm':           '${wasmSimdSrc}',
    'ort-wasm-simd-threaded.wasm':  '${wasmSimdThrSrc}',
  };

  var session = null;

  function toRN(obj) {
    window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  }

  function b64ToBuffer(b64) {
    var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  }

  async function onMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    if (msg.type === 'LOAD_MODEL') {
      try {
        var buf = b64ToBuffer(msg.modelB64);
        session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
        toRN({ type: 'MODEL_LOADED' });
      } catch (e) {
        toRN({ type: 'ERROR', ctx: 'LOAD_MODEL', error: e.message });
      }
      return;
    }

    if (msg.type === 'PREDICT') {
      if (!session) { toRN({ type: 'PREDICT_ERROR', id: msg.id, error: 'No session' }); return; }
      try {
        var seqT  = new ort.Tensor('float32', new Float32Array(msg.scaledMatrix),   [1, msg.SEQ_LEN, msg.N_SIGNALS]);
        var featT = new ort.Tensor('float32', new Float32Array(msg.scaledFeatures), [1, msg.N_FEAT]);
        var out   = await session.run({ x_seq: seqT, x_feat: featT });
        var logits = Array.from(out.logits.data);
        var maxL  = Math.max.apply(null, logits);
        var exps  = logits.map(function(v) { return Math.exp(v - maxL); });
        var sum   = exps.reduce(function(a, b) { return a + b; }, 0);
        var probs = exps.map(function(v) { return v / sum; });
        toRN({ type: 'PREDICT_RESULT', id: msg.id, probs: probs });
      } catch (e) {
        toRN({ type: 'PREDICT_ERROR', id: msg.id, error: e.message });
      }
      return;
    }
  }

  // Android fires 'message' on document, iOS on window — listen to both
  document.addEventListener('message', onMessage);
  window.addEventListener('message',   onMessage);

  // Tell RN the context is alive
  toRN({ type: 'WEBVIEW_READY' });
})();
</script>
</body>
</html>`;
}

// ── Component ─────────────────────────────────────────────────────────────────
const OnnxWebViewBridge = forwardRef((_props, ref) => {
  const webviewRef    = useRef(null);
  const [html, setHtml] = useState(null);   // null until assets are read

  // flags & queues
  const wvReady     = useRef(false);
  const mdLoaded    = useRef(false);
  const mdLoading   = useRef(false);
  const wvCbs       = useRef([]);
  const mdCbs       = useRef([]);

  // ── Build HTML once on mount ───────────────────────────────────────────────
  useEffect(() => {
    buildOfflineHtml()
      .then(h => {
        setHtml(h);
        console.log('[OnnxBridge] offline HTML ready');
      })
      .catch(e => console.error('[OnnxBridge] buildOfflineHtml failed:', e));
  }, []);

  // ── Expose API ─────────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({ loadModel, predict, isModelLoaded: () => mdLoaded.current }));

  // ── Wait helpers ──────────────────────────────────────────────────────────
  const waitWV = () => wvReady.current
    ? Promise.resolve()
    : new Promise((res, rej) => wvCbs.current.push({ res, rej }));

  // ── loadModel ─────────────────────────────────────────────────────────────
  async function loadModel() {
    if (mdLoaded.current) return;
    if (mdLoading.current) {
      return new Promise((res, rej) => mdCbs.current.push({ res, rej }));
    }
    mdLoading.current = true;
    try {
      await waitWV();
      const modelB64 = await readB64(ONNX_ASSET);
      console.log('[OnnxBridge] Sending model to WebView...');
      await new Promise((res, rej) => {
        mdCbs.current.push({ res, rej });
        _inject(JSON.stringify({ type: 'LOAD_MODEL', modelB64 }));
      });
      mdLoaded.current  = true;
      mdLoading.current = false;
      console.log('[OnnxBridge] Model loaded ✓');
    } catch (err) {
      mdLoading.current = false;
      console.error('[OnnxBridge] loadModel error:', err);
      mdCbs.current.forEach(cb => cb.rej(err));
      mdCbs.current = [];
      throw err;
    }
  }

  // ── predict ───────────────────────────────────────────────────────────────
  async function predict(scaledMatrix, scaledFeatures, SEQ_LEN, N_SIGNALS, N_FEAT) {
    if (!mdLoaded.current) await loadModel();
    return new Promise((resolve, reject) => {
      const id = _msgId++;
      pending.set(id, { resolve, reject });
      _inject(JSON.stringify({
        type: 'PREDICT', id,
        scaledMatrix:   Array.from(scaledMatrix),
        scaledFeatures: Array.from(scaledFeatures),
        SEQ_LEN, N_SIGNALS, N_FEAT,
      }));
    });
  }

  // ── dispatch a message into the WebView ───────────────────────────────────
  function _inject(jsonStr) {
    // JSON.stringify the payload again so it's a safe JS string literal
    const escaped = JSON.stringify(jsonStr);
    webviewRef.current?.injectJavaScript(`
      (function(){
        var e = new MessageEvent('message', { data: ${escaped} });
        document.dispatchEvent(e);
      })();
      true;
    `);
  }

  // ── Handle messages from WebView ──────────────────────────────────────────
  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }

    switch (msg.type) {
      case 'WEBVIEW_READY':
        wvReady.current = true;
        wvCbs.current.forEach(cb => cb.res());
        wvCbs.current = [];
        break;

      case 'MODEL_LOADED': {
        const cb = mdCbs.current.shift();
        cb?.res();
        break;
      }

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
        console.error('[OnnxBridge WebView]', msg.ctx, msg.error);
        if (msg.ctx === 'LOAD_MODEL') {
          const cb = mdCbs.current.shift();
          cb?.rej(new Error(msg.error));
        }
        break;

      default: break;
    }
  }

  return (
    <View style={{ width: 0, height: 0, overflow: 'hidden' }}>
      {html ? (
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          source={{ html }}
          onMessage={onMessage}
          javaScriptEnabled
          mixedContentMode="always"
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          style={{ width: 1, height: 1 }}
          onError={e => console.error('[OnnxBridge] WebView error:', e.nativeEvent)}
        />
      ) : null}
    </View>
  );
});

export default OnnxWebViewBridge;