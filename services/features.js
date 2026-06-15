/**
 * features.js — NOOM shared feature extraction
 *
 * Extracted from ble.js to break the circular import:
 *   ble.js → classifier.js → ble.js  (❌ Metro resolves this wrong at cold start)
 *
 * Both ble.js and classifier.js import from here instead.
 * Nothing else changes.
 */

/**
 * Extract 14 handcrafted physiological features from a 1920-sample window.
 *
 * Input : array of objects { bvp, acc_x, acc_y, acc_z, temp, hr, ibi }
 *         (scaled or raw — caller decides, must be consistent with training)
 *
 * Output: number[14] in this exact order:
 *   acc_mag_mean, acc_mag_std, acc_mag_range, acc_z_range,
 *   bvp_range, bvp_energy,
 *   hr_mean, hr_std, hrv_rmssd, hrv_sdnn, hrv_instability,
 *   temp_mean, temp_slope, low_mov_ratio
 *
 * Must match extract_features_batch() in noom_v4_best.py exactly.
 */
export function extractFeatures(window) {
  const acc_x = window.map(s => s.acc_x || 0);
  const acc_y = window.map(s => s.acc_y || 0);
  const acc_z = window.map(s => s.acc_z || 0);
  const bvp   = window.map(s => s.bvp   || 0);
  const hr    = window.map(s => s.hr    || 0);
  const ibi   = window.map(s => s.ibi   || 0).filter(v => !isNaN(v) && v > 0);
  const temp  = window.map(s => s.temp  || 0);
  const mag   = acc_x.map((x, i) => Math.sqrt(x ** 2 + acc_y[i] ** 2 + acc_z[i] ** 2));

  const _mean   = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const _std    = arr => { const m = _mean(arr); return Math.sqrt(_mean(arr.map(v => (v - m) ** 2))); };
  const _ptp    = arr => Math.max(...arr) - Math.min(...arr);
  const _energy = arr => _mean(arr.map(v => v ** 2));

  let rmssd = 0, sdnn = 0;
  if (ibi.length > 2) {
    const diffs = ibi.slice(1).map((v, i) => v - ibi[i]);
    rmssd = Math.sqrt(_mean(diffs.map(d => d ** 2)));
    sdnn  = _std(ibi);
  }

  const n      = temp.length;
  const x_mean = (n - 1) / 2;
  const denom  = temp.reduce((acc, _, i) => acc + (i - x_mean) ** 2, 0);
  const slope  = denom > 0
    ? temp.reduce((acc, v, i) => acc + (i - x_mean) * (v - _mean(temp)), 0) / denom
    : 0;

  const sorted  = [...mag].sort((a, b) => a - b);
  const p10     = sorted[Math.floor(sorted.length * 0.1)];
  const low_mov = mag.filter(v => v <= p10 + 1e-6).length / mag.length;
  const hr_std  = _std(hr);

  return [
    _mean(mag), _std(mag), _ptp(mag), _ptp(acc_z),
    _ptp(bvp),  _energy(bvp),
    _mean(hr),  hr_std, rmssd, sdnn, rmssd * hr_std,
    _mean(temp), slope, low_mov,
  ];
}