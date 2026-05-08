/**
 * Smart Alarm Decision Engine
 * Implements Algorithm 2 from the NOOM paper.
 *
 * Actions: PRE_WINDOW | WAIT | WAKE | FORCE_WAKE
 */

// ─── EMA state (persists across windows) ─────────────────────────────────────
let emaProbs = [1/3, 1/3, 1/3]; // [PW, PN, PD]
let consecGood = 0;

export function resetAlarmState() {
  emaProbs    = [1/3, 1/3, 1/3];
  consecGood  = 0;
}

/**
 * @param {object} opts
 * @param {number[]} opts.rawProbs   - [PW, PN, PD] from model (or mock)
 * @param {Date}    opts.alarmTime   - target alarm time
 * @param {Date}    opts.now         - current time
 * @param {object}  opts.prefs       - user preferences from storage
 * @returns {{ action: string, probs: number[], deltaMin: number }}
 */
export function alarmDecision({ rawProbs, alarmTime, now, prefs }) {
  const {
    wake_window_minutes: Tw = 30,
    deep_gate_threshold: deepGate = 0.40,
    tau_max: tauMax = 0.55,
    tau_min: tauMin = 0.25,
    ema_alpha: alpha = 0.4,
    consec_required: consecReq = 3,
  } = prefs;

  // Δt in minutes
  const deltaMs  = alarmTime.getTime() - now.getTime();
  const deltaMin = deltaMs / 60000;

  // Forced alarm at or past deadline
  if (deltaMin <= 0) {
    resetAlarmState();
    return { action: 'FORCE_WAKE', probs: emaProbs, deltaMin };
  }

  // ── EMA smoothing ──────────────────────────────────────────────────────────
  emaProbs = emaProbs.map((prev, i) => alpha * rawProbs[i] + (1 - alpha) * prev);
  const [PW, PN, PD] = emaProbs;
  const Pgood = PW + PN;

  // Still outside wake window
  if (deltaMin > Tw) {
    consecGood = 0;
    return { action: 'PRE_WINDOW', probs: emaProbs, deltaMin };
  }

  // ── Dynamic threshold τ(Δt) ────────────────────────────────────────────────
  // Linearly decays from tauMax (30 min left) to tauMin (0 min left)
  const tau = tauMax - ((tauMax - tauMin) * (Tw - deltaMin)) / Tw;

  // ── Deep gate: suppress wake during N3 if time permits ────────────────────
  if (PD > deepGate && deltaMin > 5) {
    consecGood = 0;
    return { action: 'WAIT', probs: emaProbs, deltaMin, tau };
  }

  // ── Consecutive good-window counter ───────────────────────────────────────
  const predClass = argmax(emaProbs); // 0=Wake, 1=NDeep, 2=Deep
  if (predClass === 0 || predClass === 1) {
    consecGood += 1;
  } else {
    consecGood = 0;
  }

  if (Pgood >= tau && consecGood >= consecReq) {
    return { action: 'WAKE', probs: emaProbs, deltaMin, tau };
  }

  return { action: 'WAIT', probs: emaProbs, deltaMin, tau };
}

// ─── Mock classifier (placeholder until real model is loaded) ─────────────────
/**
 * Mock sleep stage predictor that simulates realistic probabilities.
 * Replace with real ONNX model inference when available.
 */
export function mockPredict(features, window) {
  // Use acc_mag_std (feature[1]) as a heuristic:
  // High movement → Wake, Low → Deep, Medium → NDeep
  const accMagStd = features[1] ?? 0.1;
  const bvpRange  = features[4] ?? 100;
  const hrMean    = features[6] ?? 65;

  let PW, PN, PD;

  if (accMagStd > 0.3) {
    // High movement = Wake
    PW = 0.7 + Math.random() * 0.2;
    PN = 0.1 + Math.random() * 0.1;
    PD = 1 - PW - PN;
  } else if (accMagStd < 0.05 && bvpRange < 200) {
    // Very still + low BVP = Deep sleep
    PD = 0.55 + Math.random() * 0.25;
    PN = 0.3 + Math.random() * 0.1;
    PW = 1 - PD - PN;
  } else {
    // Normal NDeep
    PN = 0.55 + Math.random() * 0.25;
    PW = 0.15 + Math.random() * 0.15;
    PD = 1 - PN - PW;
  }

  // Clamp to [0,1] and normalize
  const probs = [PW, PN, PD].map(p => Math.max(0, Math.min(1, p)));
  const sum = probs.reduce((a,b)=>a+b, 0);
  return probs.map(p => p/sum);
}

export function stageName(classIdx) {
  return ['Wake', 'NDeep', 'Deep'][classIdx] ?? 'Unknown';
}

export function stageLabel(classIdx) {
  return ['WAKE', 'LIGHT\nSLEEP', 'DEEP\nSLEEP'][classIdx] ?? '—';
}

function argmax(arr) {
  return arr.reduce((best, v, i) => v > arr[best] ? i : best, 0);
}

export { argmax };