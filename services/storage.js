import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  SESSIONS:       'noom:sessions',
  CALIBRATION:    'noom:calibration',
  ALARM_TIME:     'noom:alarm_time',
  USER_PREFS:     'noom:user_prefs',
};

// ─── Calibration ─────────────────────────────────────────────────────────────

export async function saveCalibration(data) {
  // data: { still_mean, still_std, walk_mean, walk_std, threshold, calibrated_at }
  await AsyncStorage.setItem(KEYS.CALIBRATION, JSON.stringify(data));
}

export async function loadCalibration() {
  const raw = await AsyncStorage.getItem(KEYS.CALIBRATION);
  return raw ? JSON.parse(raw) : null;
}

// ─── Alarm Time ──────────────────────────────────────────────────────────────

export async function saveAlarmTime(timeStr) {
  // timeStr: "07:00"
  await AsyncStorage.setItem(KEYS.ALARM_TIME, timeStr);
}

export async function loadAlarmTime() {
  return await AsyncStorage.getItem(KEYS.ALARM_TIME) ?? '07:00';
}

// ─── Sleep Sessions ──────────────────────────────────────────────────────────

export async function saveSession(session) {
  /**
   * session: {
   *   id, date, alarm_time,
   *   predictions: [{ ts, stage, pw, pn, pd }],
   *   alarm_fired_at, minutes_early,
   *   rating, rating_ts
   * }
   */
  const all = await loadAllSessions();
  const idx = all.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    all[idx] = session;
  } else {
    all.unshift(session); // newest first
  }
  // Keep last 60 sessions
  const trimmed = all.slice(0, 60);
  await AsyncStorage.setItem(KEYS.SESSIONS, JSON.stringify(trimmed));
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
  const all = await loadAllSessions();
  const session = all.find(s => s.id === sessionId);
  if (session) {
    session.rating = rating;
    session.rating_ts = Date.now();
    await AsyncStorage.setItem(KEYS.SESSIONS, JSON.stringify(all));
  }
}

export async function loadRecentRatings(days = 30) {
  const all = await loadAllSessions();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return all
    .filter(s => s.rating != null && new Date(s.date).getTime() > cutoff)
    .map(s => ({ date: s.date, rating: s.rating }));
}

// ─── User Prefs ───────────────────────────────────────────────────────────────

export async function saveUserPrefs(prefs) {
  const existing = await loadUserPrefs();
  await AsyncStorage.setItem(KEYS.USER_PREFS, JSON.stringify({ ...existing, ...prefs }));
}

export async function loadUserPrefs() {
  const raw = await AsyncStorage.getItem(KEYS.USER_PREFS);
  return raw ? JSON.parse(raw) : {
    wake_window_minutes: 30,
    deep_gate_threshold: 0.40,
    tau_max: 0.55,
    tau_min: 0.25,
    ema_alpha: 0.4,
    consec_required: 3,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function todayDateStr() {
  return new Date().toISOString().split('T')[0];
}