/**
 * alarmEngine.js — NOOM
 *
 * No logic changes from the last reviewed version. Included here as a
 * clean, self-contained copy so every service file ships together.
 *
 * Summary of rules:
 *  - EMA-smooth rawProbs each window.
 *  - PRE_WINDOW while Δt > wake_window_minutes.
 *  - Inside wake window: dynamic threshold τ(Δt) tightens toward deadline.
 *  - Deep gate holds alarm if PD > deep_gate_threshold and time remains.
 *  - WAKE fires when Pgood ≥ τ for consec_required consecutive windows.
 *  - FORCE_WAKE fires at Δt ≤ 0 regardless of sleep stage.
 *  - resetAlarmState() MUST be called at session start (clears EMA + counter).
 */

// ─── EMA state ────────────────────────────────────────────────────────────────
let emaProbs   = [1/3, 1/3, 1/3];
let consecGood = 0;

export function resetAlarmState() {
  emaProbs   = [1/3, 1/3, 1/3];
  consecGood = 0;
}

/**
 * @param {object}   opts
 * @param {number[]} opts.rawProbs   [PW, PN, PD]
 * @param {Date}     opts.alarmTime  target alarm Date (already adjusted to
 *                                   tomorrow if the target hour has passed)
 * @param {Date}     opts.now        current time
 * @param {object}   opts.prefs      user preferences from storage
 * @returns {{ action: string, probs: number[], deltaMin: number, tau?: number }}
 */
export function alarmDecision({ rawProbs, alarmTime, now, prefs }) {
  const {
    wake_window_minutes: Tw        = 30,
    deep_gate_threshold: deepGate  = 0.40,
    tau_max:             tauMax    = 0.55,
    tau_min:             tauMin    = 0.25,
    ema_alpha:           alpha     = 0.4,
    consec_required:     consecReq = 3,
  } = prefs;

  // ── Δt (minutes until alarm) ──────────────────────────────────────────────
  const deltaMs  = alarmTime.getTime() - now.getTime();
  const deltaMin = deltaMs / 60_000;

  // ── Hard deadline ─────────────────────────────────────────────────────────
  if (deltaMin <= 0) {
    resetAlarmState();
    return { action: 'FORCE_WAKE', probs: emaProbs, deltaMin };
  }

  // ── EMA smoothing ─────────────────────────────────────────────────────────
  emaProbs = emaProbs.map((prev, i) => alpha * rawProbs[i] + (1 - alpha) * prev);
  const [PW, PN, PD] = emaProbs;
  const Pgood = PW + PN;

  // ── Still outside wake window ─────────────────────────────────────────────
  if (deltaMin > Tw) {
    consecGood = 0;
    return { action: 'PRE_WINDOW', probs: emaProbs, deltaMin };
  }

  // ── Dynamic threshold τ(Δt) ───────────────────────────────────────────────
  // At Δt=Tw  → tau = tauMax (conservative — plenty of time)
  // At Δt→0   → tau = tauMin (permissive — deadline approaching)
  const tau = tauMin + (tauMax - tauMin) * (deltaMin / Tw);

  // ── Deep gate: hold if N3 confidence is high and time remains ─────────────
  if (PD > deepGate && deltaMin > 5) {
    consecGood = 0;
    return { action: 'WAIT', probs: emaProbs, deltaMin, tau };
  }

  // ── Consecutive good-window counter ──────────────────────────────────────
  const predClass = argmax(emaProbs); // 0=Wake, 1=Light, 2=Deep
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function argmax(arr) {
  return arr.reduce((best, v, i) => (v > arr[best] ? i : best), 0);
}

export function stageName(classIdx)  { return ['Wake', 'NDeep', 'Deep'][classIdx] ?? 'Unknown'; }
export function stageLabel(classIdx) { return ['WAKE', 'LIGHT\nSLEEP', 'DEEP\nSLEEP'][classIdx] ?? '—'; }