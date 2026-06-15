/**
 * storage.js — NOOM (updated)
 *
 * Added:
 *  - savePVTResult() / loadPVTResults()
 *  - savePVTPrefs()  / loadPVTPrefs()
 *
 * All existing API is unchanged.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  SESSIONS:       'noom:sessions',
  CALIBRATION:    'noom:calibration',
  ALARM_TIME:     'noom:alarm_time',
  USER_PREFS:     'noom:user_prefs',
  PVT_RESULTS:    'noom:pvt_results',
  PVT_PREFS:      'noom:pvt_prefs',
};

// ─── Calibration ──────────────────────────────────────────────────────────────

export async function saveCalibration(data) {
  await AsyncStorage.setItem(KEYS.CALIBRATION, JSON.stringify(data));
}

export async function loadCalibration() {
  const raw = await AsyncStorage.getItem(KEYS.CALIBRATION);
  return raw ? JSON.parse(raw) : null;
}

// ─── Alarm Time ───────────────────────────────────────────────────────────────

export async function saveAlarmTime(timeStr) {
  await AsyncStorage.setItem(KEYS.ALARM_TIME, timeStr);
}

export async function loadAlarmTime() {
  return (await AsyncStorage.getItem(KEYS.ALARM_TIME)) ?? '07:00';
}

// ─── Sleep Sessions ───────────────────────────────────────────────────────────

export async function saveSession(session) {
  const all = await loadAllSessions();
  const idx = all.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    all[idx] = session;
  } else {
    all.unshift(session);
  }
  await AsyncStorage.setItem(KEYS.SESSIONS, JSON.stringify(all.slice(0, 60)));
}

export async function loadAllSessions() {
  const raw = await AsyncStorage.getItem(KEYS.SESSIONS);
  return raw ? JSON.parse(raw) : [];
}

export async function loadLastSession() {
  const all = await loadAllSessions();
  return all.length > 0 ? all[0] : null;
}

export async function saveRatingForSession(sessionId, rating) {
  const all     = await loadAllSessions();
  const session = all.find(s => s.id === sessionId);
  if (session) {
    session.rating    = rating;
    session.rating_ts = Date.now();
    await AsyncStorage.setItem(KEYS.SESSIONS, JSON.stringify(all));
  }
}

export async function loadRecentRatings(days = 30) {
  const all    = await loadAllSessions();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return all
    .filter(s => s.rating != null && new Date(s.date).getTime() > cutoff)
    .map(s => ({ date: s.date, rating: s.rating }));
}

// ─── User Prefs ───────────────────────────────────────────────────────────────

const DEFAULT_PREFS = {
  wake_window_minutes: 30,
  deep_gate_threshold: 0.40,
  tau_max:             0.55,
  tau_min:             0.25,
  ema_alpha:           0.4,
  consec_required:     3,
  acc_threshold:       0.12,  // calibrated value written here by CalibrationScreen
};

export async function saveUserPrefs(prefs) {
  const existing = await loadUserPrefs();
  await AsyncStorage.setItem(
    KEYS.USER_PREFS,
    JSON.stringify({ ...existing, ...prefs })
  );
}

export async function loadUserPrefs() {
  const raw = await AsyncStorage.getItem(KEYS.USER_PREFS);
  return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
}

// ─── PVT Results ─────────────────────────────────────────────────────────────

/**
 * result: {
 *   mode: 'daily' | 'weekly',
 *   date: ISO string,
 *   meanRt, medianRt, lapses, falseStarts, trials
 * }
 */
export async function savePVTResult(result) {
  const all = await loadPVTResults();
  all.unshift(result);
  await AsyncStorage.setItem(KEYS.PVT_RESULTS, JSON.stringify(all.slice(0, 90)));
}

export async function loadPVTResults() {
  const raw = await AsyncStorage.getItem(KEYS.PVT_RESULTS);
  return raw ? JSON.parse(raw) : [];
}

// ─── PVT Scheduler Prefs ─────────────────────────────────────────────────────
// { daily_pvt_notification_id, last_weekly_pvt_ts }

export async function savePVTPrefs(prefs) {
  await AsyncStorage.setItem(KEYS.PVT_PREFS, JSON.stringify(prefs));
}

export async function loadPVTPrefs() {
  const raw = await AsyncStorage.getItem(KEYS.PVT_PREFS);
  return raw ? JSON.parse(raw) : {};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function todayDateStr() {
  return new Date().toISOString().split('T')[0];
}