/**
 * pvtScheduler.js — PVT scheduling logic (NOOM)
 *
 * Two triggers, both ONE-SHOT (no recurring/repeating notifications —
 * repeating triggers were the source of the notification-spam bug, since
 * cancellation of a previous repeating ID is best-effort and can leave
 * stale repeating alarms behind across app launches):
 *
 * 1. POST-ALARM (optional): fires ~1 minute after the sleep alarm goes off.
 *    Scheduled by MonitoringScreen.triggerAlarm() via scheduleOptionalPVT().
 *
 * 2. LOW-SCORE check: if the average sleep rating over the last 14 days
 *    is below 3/5, fire a one-shot "low score" PVT notification.
 *    Checked by HomeScreen on focus via checkAndScheduleWeeklyPVT().
 *    Gated by a 14-day cooldown so it doesn't re-fire on every app open.
 *
 * Navigation:
 *   Tapping either notification navigates to 'PVT' with
 *   { mode: 'post_alarm' | 'weekly' }.
 *   Wire up navigationRef in App.js:
 *     export const navigationRef = createNavigationContainerRef();
 *     await initPVTScheduler({ navigationRef });
 */

import * as Notifications from 'expo-notifications';
import { loadRecentRatings, loadPVTPrefs, savePVTPrefs } from './storage';

// ─── Post-alarm PVT ─────────────────────────────────────────────────────────
const POST_ALARM_DELAY_SEC = 60;   // 1 minute after the alarm fires

// ─── Low-score PVT (formerly "weekly") ───────────────────────────────────────
const LOW_SCORE_WINDOW_DAYS   = 14;  // average over the last 14 days
const LOW_SCORE_THRESHOLD     = 3;   // trigger if avg < 3/5
const LOW_SCORE_MIN_RATINGS   = 3;   // need at least this many ratings to judge
const LOW_SCORE_COOLDOWN_DAYS = 14;  // don't re-fire for 14 days

let _navigationRef = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once from App.js after notification permissions are granted.
 * Sets up the tap handler that routes PVT notifications to the PVT screen.
 *
 * @param {{ navigationRef: object }} opts
 */
export async function initPVTScheduler({ navigationRef } = {}) {
  _navigationRef = navigationRef;

  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const data = response.notification.request.content.data ?? {};
    if (data.pvt) {
      _navigationRef?.current?.navigate?.('PVT', { mode: data.pvt });
    }
  });

  return () => sub.remove();
}

/**
 * Schedule the OPTIONAL post-alarm PVT, ~1 minute after the alarm fires.
 * Call this from MonitoringScreen.triggerAlarm() — one-shot, not repeating.
 */
export async function scheduleOptionalPVT() {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '🧠 Quick alertness check',
      body:  "Optional: take a 1-minute reaction time test now that you're up.",
      data:  { pvt: 'post_alarm' },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: POST_ALARM_DELAY_SEC,
    },
  });
}

/**
 * Call from HomeScreen.useFocusEffect.
 * Fires a one-shot "low score" PVT if the average rating over the last
 * LOW_SCORE_WINDOW_DAYS days is below LOW_SCORE_THRESHOLD, gated by a
 * LOW_SCORE_COOLDOWN_DAYS cooldown.
 */
export async function checkAndScheduleWeeklyPVT() {
  const prefs = await loadPVTPrefs();
  const last  = prefs?.last_low_score_pvt_ts ?? 0;
  const cooldownMs = LOW_SCORE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  if (Date.now() - last < cooldownMs) return;   // still in cooldown

  const ratings = await loadRecentRatings(LOW_SCORE_WINDOW_DAYS);
  if (ratings.length < LOW_SCORE_MIN_RATINGS) return;   // not enough data

  const avg = ratings.reduce((a, r) => a + r.rating, 0) / ratings.length;
  if (avg >= LOW_SCORE_THRESHOLD) return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: '⚠ Sleep quality check',
      body:  `Your sleep ratings have averaged below 3★ over the last ${LOW_SCORE_WINDOW_DAYS} days. Take a quick alertness test.`,
      data:  { pvt: 'weekly' },
      sound: true,
    },
    trigger: null,   // immediate, one-shot
  });

  await savePVTPrefs({ ...prefs, last_low_score_pvt_ts: Date.now() });
}