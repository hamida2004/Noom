/**
 * MonitoringScreen.js — NOOM
 *
 * Data flow:
 *   BLE window (1920 samples) → accGate → predict() [ONNX] → alarmDecision → UI + alarm
 *
 * Every window is logged with its raw probs, EMA probs, action, and deltaMin
 * so you can trace exactly what the model is seeing and what the engine decides.
 *
 * No mockPredict anywhere. Simulation mode is removed — if there is no BLE
 * device, the screen shows "No device connected" and does not start.
 *
 * ── ALARM RELIABILITY ────────────────────────────────────────────────────
 * startMonitoring() arms an OS-level scheduled notification at the alarm
 * deadline (date trigger, sound = alarm.wav). This fires even if the JS
 * thread is suspended (screen off / app backgrounded overnight) — the
 * in-app setInterval watchdog alone is NOT reliable in that situation.
 *
 * The in-app deadline watchdog still drives the live UI + smart WAKE when
 * the app is in the foreground. triggerAlarm() cancels the scheduled OS
 * notification the moment anything actually fires (smart WAKE or deadline),
 * so the user never gets two alarms.
 *
 * All notification scheduling is one-shot (trigger: null / date / seconds).
 * No repeating triggers are used here — repeating triggers were the source
 * of the notification-spam bug (see pvtScheduler.js).
 *
 * ── STARTUP RELIABILITY (v3 — diagnostic logging + non-blocking schedule) ─
 * History of this section, newest first:
 *
 *  v3 (this version): scheduleNotificationAsync(deadline) was STILL timing
 *  out at the bumped 8s ceiling on-device, inconsistently. Rather than keep
 *  guessing at a magic timeout number, this version:
 *    1. Makes scheduleNotificationAsync(deadline) fire-and-forget, same
 *       reasoning as cancel/dismiss: it arms a *background safety-net*
 *       alarm for if the JS thread is suspended. Its own slowness should
 *       never block the live, in-app monitoring loop (state reset, BLE
 *       callback registration, countdown ticker) from starting.
 *    2. Adds explicit start/elapsed-time logging around EVERY notification
 *       call (requestPermissions, ensureChannel, cancelAll, dismissAll,
 *       scheduleNotificationAsync) with wall-clock timestamps, so the next
 *       run shows exactly which call is slow and by how much, instead of
 *       only learning about it after a timeout fires.
 *    3. Adds the same logging to loadAlarmTime/loadUserPrefs, since a slow
 *       AsyncStorage read would otherwise look identical to a slow
 *       notification call in the logs.
 *
 *  v2: cancelAllScheduledNotificationsAsync / dismissAllNotificationsAsync
 *  made fire-and-forget after they were observed hanging 10s+ on a
 *  ColorOS/Realme device and starving the (then 12s) outer
 *  STARTUP_TIMEOUT_MS race before scheduleNotificationAsync ever got a
 *  chance to run. STARTUP_TIMEOUT_MS raised 12s → 20s.
 *
 *  v1: every awaited call wrapped in withTimeout() + outer
 *  STARTUP_TIMEOUT_MS race, since this screen lives inside a
 *  Tab.Navigator and is never unmounted — an unbounded hang previously
 *  left the Start button stuck on "Starting…" forever.
 *
 * ── PREDICT CONCURRENCY GUARD (added) ─────────────────────────────────────
 * ble.js's 64Hz ticker fires _monitoringCallback (→ handleWindow) every 15s
 * via a fire-and-forget call — it does NOT await handleWindow. If a single
 * predict() round-trip to the WebView ever runs long (or hangs), the next
 * window's handleWindow() would previously start a SECOND concurrent
 * predict() call, stacking unbounded injectJavaScript() calls into the
 * WebView with no backpressure. predictingRef guards against this: a new
 * window is logged and dropped (not queued) while a prediction is still in
 * flight, rather than piling on.
 *
 * ── KNOWN ROOT CAUSE OF THE "APP FROZEN" BUG (fixed in OnnxWebViewBridge.js) ─
 * Confirmed via logcat: Android's low-memory killer can kill the WebView's
 * sandboxed Chromium renderer process mid-session on ColorOS/Realme
 * devices ("Killing ...:sandboxed_process0:...(adj 905): remove task"),
 * independent of anything this app does. When that happens mid-predict,
 * the in-flight predict() promise previously hung forever — no
 * PREDICT_RESULT could ever arrive from a renderer that no longer exists.
 * OnnxWebViewBridge.js now detects this (onContentProcessDidTerminate) and
 * rejects all in-flight predicts + forces a reload on the next call. See
 * that file's header for full detail. handleWindow()'s catch block below
 * will now log a real "WebView process died" error instead of the whole
 * session silently hanging.
 *
 * ── triggerAlarm() RELIABILITY (v4 — non-blocking navigation) ─────────────
 * triggerAlarm() previously awaited cancelAllScheduledNotificationsAsync()
 * and dismissAllNotificationsAsync() SEQUENTIALLY, each with its own 10s
 * timeout, before doing anything else — including navigating to the Alarm
 * screen. On a device where both calls are slow (same class of hang as the
 * v2 fix in startMonitoring() above, e.g. ColorOS/Realme), this meant up to
 * ~20+ seconds of dead time between the model deciding WAKE and the user
 * ever seeing the Alarm screen, with the live alarm notification posting
 * even later than that. This is almost certainly why "the alarm doesn't
 * fire correctly" — it DOES fire, just 20+ seconds late, hidden behind two
 * back-to-back await'd timeouts.
 *
 * Fix: apply the exact same lesson as v2 of startMonitoring(). Navigation
 * to the Alarm screen and posting the actual "live alarm" notification
 * (the one the user needs to see/hear NOW) happen FIRST and are not gated
 * on cleanup. cancelAll/dismissAll of stale notifications become
 * fire-and-forget — they only matter for tidiness (clearing old scheduled
 * notifications from the shade), not for the user's alarm experience, so
 * their slowness must never block it.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Animated, AppState, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { colors, spacing, radius, typography } from '../theme';
import { isConnected, accGate, setMonitoringCallback } from '../services/ble';
import { alarmDecision, resetAlarmState, argmax } from '../services/alarmEngine';
import { loadModel, predict, isModelLoaded } from '../services/classifier';
import { navigationRef as rootNavigationRef } from '../navigationRef';
import {
  loadAlarmTime, loadUserPrefs,
  saveSession, generateSessionId, todayDateStr,
} from '../services/storage';

// ─── Notification handler ─────────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge:  false,
  }),
});

// ─── Background task ──────────────────────────────────────────────────────────
const BG_TASK = 'NOOM_BG_MONITOR';
TaskManager.defineTask(BG_TASK, async () => {
  return BackgroundFetch.BackgroundFetchResult.NewData;
});

const STAGE_COLORS = [colors.wake, colors.ndeep, colors.deep];
const STAGE_NAMES  = ['WAKE', 'LIGHT', 'DEEP'];

// ─── Alarm notification config ─────────────────────────────────────────────────
const ALARM_CHANNEL_ID = 'noom-alarm';
const ALARM_SOUND      = 'alarm.wav';

// ─── Startup safety net ─────────────────────────────────────────────────────────
const STARTUP_TIMEOUT_MS = 20_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting on: ${label}`)), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

// ─── Diagnostic timing helper ──────────────────────────────────────────────────
function timed(promise, label) {
  const startedAt = Date.now();
  console.log(`[Timing] ${label} — START @ ${new Date(startedAt).toLocaleTimeString()}`);
  return promise.then(
    v => {
      console.log(`[Timing] ${label} — DONE in ${Date.now() - startedAt}ms`);
      return v;
    },
    e => {
      console.log(`[Timing] ${label} — FAILED after ${Date.now() - startedAt}ms: ${e.message ?? e}`);
      throw e;
    }
  );
}

async function _ensureAlarmChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
    name:                 'NOOM Alarm',
    importance:           Notifications.AndroidImportance.MAX,
    sound:                ALARM_SOUND,
    vibrationPattern:     [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd:            true,
  });
}

export default function MonitoringScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const [active,       setActive]     = useState(false);
  const [bleOk,        setBleOk]      = useState(false);
  const [modelReady,   setModelReady] = useState(false);
  const [starting,     setStarting]   = useState(false);
  const [currentStage, setStage]      = useState(null);
  const [probs,        setProbs]      = useState([0.33, 0.33, 0.34]);
  const [action,       setAction]     = useState('PRE_WINDOW');
  const [deltaMin,     setDeltaMin]   = useState(null);
  const [timeline,     setTimeline]   = useState([]);
  const [windowCount,  setWindowCount]= useState(0);

  const activeRef         = useRef(false);
  const alarmFiredRef     = useRef(false);
  const sessionRef        = useRef(null);
  const deadlineRef       = useRef(null);
  const countdownRef      = useRef(null);
  const predsRef          = useRef([]);
  const prefsRef          = useRef(null);
  const alarmTimeRef      = useRef(null);
  const scheduledAlarmIdRef = useRef(null);
  const startAttemptRef   = useRef(0);
  const predictingRef     = useRef(false);
  const pulseAnim         = useRef(new Animated.Value(1)).current;

  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => () => { _clearAllIntervals(); setMonitoringCallback(null); }, []);

  useFocusEffect(useCallback(() => {
    const connected = isConnected();
    setBleOk(connected);

    if (!isModelLoaded()) {
      loadModel()
        .then(() => setModelReady(true))
        .catch(e => console.warn('[Monitoring] Model load failed:', e));
    } else {
      setModelReady(true);
    }
  }, []));

  useEffect(() => {
    if (active) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.06, duration: 1200, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 1200, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(1);
  }, [active]);

  useEffect(() => {
    BackgroundFetch.registerTaskAsync(BG_TASK, {
      minimumInterval: 15,
      stopOnTerminate: false,
      startOnBoot: false,
    }).catch(() => {});
    return () => { BackgroundFetch.unregisterTaskAsync(BG_TASK).catch(() => {}); };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      console.log('[Monitoring] AppState changed →', s);
      if (s === 'active') setBleOk(isConnected());
    });
    return () => sub.remove();
  }, []);

  function _clearAllIntervals() {
    if (deadlineRef.current)  { clearInterval(deadlineRef.current);  deadlineRef.current  = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }

  function _buildAlarmDate(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }

  async function startMonitoring() {
    if (active || starting) return;

    if (!isConnected()) {
      console.warn('[Monitoring] No BLE device connected — connect your wristband first.');
      return;
    }
    if (!isModelLoaded()) {
      console.warn('[Monitoring] Model not loaded yet — wait for loading to finish.');
      return;
    }

    const myAttempt = ++startAttemptRef.current;

    setStarting(true);
    const attemptStartedAt = Date.now();
    console.log(`[Monitoring] startMonitoring() called — attempt ${myAttempt} @ ${new Date(attemptStartedAt).toLocaleTimeString()}`);

    try {
      await withTimeout((async () => {
        const [timeStr, prefs] = await timed(
          withTimeout(
            Promise.all([loadAlarmTime(), loadUserPrefs()]),
            5_000,
            'loadAlarmTime/loadUserPrefs'
          ),
          'loadAlarmTime/loadUserPrefs'
        );
        prefsRef.current = prefs;
        alarmTimeRef.current  = _buildAlarmDate(timeStr);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[Monitoring] SESSION START');
        console.log('[Monitoring] Alarm time  :', alarmTimeRef.current.toLocaleTimeString());
        console.log('[Monitoring] Wake window :', prefs.wake_window_minutes, 'min');
        console.log('[Monitoring] Deep gate   :', prefs.deep_gate_threshold);
        console.log('[Monitoring] tau_max/min :', prefs.tau_max, '/', prefs.tau_min);
        console.log('[Monitoring] consec_req  :', prefs.consec_required);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        await timed(
          withTimeout(Notifications.requestPermissionsAsync(), 6_000, 'requestPermissionsAsync'),
          'requestPermissionsAsync'
        );
        await timed(
          withTimeout(_ensureAlarmChannel(), 3_000, '_ensureAlarmChannel'),
          '_ensureAlarmChannel'
        );

        timed(Notifications.cancelAllScheduledNotificationsAsync(), 'cancelAllScheduledNotificationsAsync(bg)')
          .catch(e => console.warn('[Monitoring] cancelAllScheduledNotificationsAsync failed:', e.message));
        timed(Notifications.dismissAllNotificationsAsync(), 'dismissAllNotificationsAsync(bg)')
          .catch(e => console.warn('[Monitoring] dismissAllNotificationsAsync failed:', e.message));

        timed(
          Notifications.scheduleNotificationAsync({
            content: {
              title:    '⏰ Wake up!',
              body:     'Your NOOM alarm time has arrived.',
              sound:    ALARM_SOUND,
              priority: Notifications.AndroidNotificationPriority.MAX,
              ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: alarmTimeRef.current,
            },
          }),
          'scheduleNotificationAsync(deadline)(bg)'
        )
          .then(id => {
            scheduledAlarmIdRef.current = id;
            console.log('[Monitoring] Deadline alarm armed for', alarmTimeRef.current.toLocaleTimeString());
          })
          .catch(e => console.warn('[Monitoring] scheduleNotificationAsync(deadline) failed:', e.message));

        resetAlarmState();
        alarmFiredRef.current = false;
        predsRef.current      = [];

        sessionRef.current = {
          id:          generateSessionId(),
          date:        todayDateStr(),
          alarm_time:  timeStr,
          predictions: [],
          started_at:  Date.now(),
        };

        setTimeline([]);
        setStage(null);
        setProbs([0.33, 0.33, 0.34]);
        setAction('PRE_WINDOW');
        setDeltaMin(null);
        setWindowCount(0);

        activeRef.current = true;
        setActive(true);

        _clearAllIntervals();
        countdownRef.current = setInterval(() => {
          if (!activeRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; return; }
          const at = alarmTimeRef.current;
          if (at) setDeltaMin(Math.max(0, (at.getTime() - Date.now()) / 60_000));
        }, 1_000);

        deadlineRef.current = setInterval(() => {
          if (!activeRef.current || alarmFiredRef.current) {
            clearInterval(deadlineRef.current); deadlineRef.current = null; return;
          }
          if (alarmTimeRef.current && Date.now() >= alarmTimeRef.current.getTime()) {
            console.log('[Monitoring] ⏰ DEADLINE REACHED — firing FORCE_WAKE');
            alarmFiredRef.current = true;
            clearInterval(deadlineRef.current); deadlineRef.current = null;
            triggerAlarm('FORCE_WAKE', [0.34, 0.33, 0.33], 0);
          }
        }, 1_000);

        setMonitoringCallback(win => handleWindow(win));
        console.log(`[Monitoring] Live monitoring loop active after ${Date.now() - attemptStartedAt}ms (notification arming continues in background)`);
      })(), STARTUP_TIMEOUT_MS, 'startMonitoring() body');

    } catch (err) {
      console.error(`[Monitoring] startMonitoring failed after ${Date.now() - attemptStartedAt}ms:`, err.message ?? err);
    } finally {
      if (startAttemptRef.current === myAttempt) {
        setStarting(false);
      }
    }
  }

  async function stopMonitoring() {
    activeRef.current = false;
    setActive(false);
    _clearAllIntervals();
    setMonitoringCallback(null);

    if (scheduledAlarmIdRef.current) {
      await Notifications.cancelScheduledNotificationAsync(scheduledAlarmIdRef.current).catch(() => {});
      scheduledAlarmIdRef.current = null;
    }

    if (sessionRef.current) {
      sessionRef.current.predictions = predsRef.current;
      await saveSession(sessionRef.current);
      sessionRef.current = null;
    }
    console.log('[Monitoring] SESSION STOPPED');
  }

  async function handleWindow(window) {
    if (!activeRef.current || alarmFiredRef.current) return;

    const windowIdx = predsRef.current.length + 1;
    const now       = new Date();
    const deltaMs   = alarmTimeRef.current
      ? alarmTimeRef.current.getTime() - now.getTime()
      : null;
    const deltaMinNow = deltaMs != null ? deltaMs / 60_000 : null;

    const threshold = prefsRef.current?.acc_threshold ?? 0.12;
    const moving    = accGate(window, threshold);

    let rawProbs;
    if (moving) {
      rawProbs = [0.90, 0.08, 0.02];
      console.log(`[Win #${windowIdx}] ACC gate → MOVING  rawProbs: W=0.90 L=0.08 D=0.02`);
    } else {
      if (predictingRef.current) {
        console.warn(`[Win #${windowIdx}] Skipped — previous predict() still in flight`);
        return;
      }
      predictingRef.current = true;
      const predictStartedAt = Date.now();
      try {
        rawProbs = await timed(predict(window), `predict(window #${windowIdx})`);
        console.log(
          `[Win #${windowIdx}] ONNX → ` +
          `W=${rawProbs[0].toFixed(3)} L=${rawProbs[1].toFixed(3)} D=${rawProbs[2].toFixed(3)} ` +
          `stage=${STAGE_NAMES[argmax(rawProbs)]}  Δt=${deltaMinNow?.toFixed(1) ?? '—'}min  ` +
          `(predict took ${Date.now() - predictStartedAt}ms)`
        );
      } catch (e) {
        console.error(`[Win #${windowIdx}] ONNX predict failed after ${Date.now() - predictStartedAt}ms:`, e.message);
        return;
      } finally {
        predictingRef.current = false;
      }
    }

    if (!activeRef.current || alarmFiredRef.current) return;

    if (!prefsRef.current || !alarmTimeRef.current) return;

    const result = alarmDecision({
      rawProbs,
      alarmTime: alarmTimeRef.current,
      now,
      prefs: prefsRef.current,
    });

    console.log(
      `[Win #${windowIdx}] decision → ${result.action}` +
      (result.tau != null ? `  τ=${result.tau.toFixed(3)}` : '') +
      `  EMA: W=${result.probs[0].toFixed(3)} L=${result.probs[1].toFixed(3)} D=${result.probs[2].toFixed(3)}`
    );

    setProbs(result.probs);
    setAction(result.action);
    setDeltaMin(result.deltaMin);
    setStage(argmax(result.probs));
    setWindowCount(windowIdx);

    const pred = {
      ts: now.getTime(), stage: argmax(rawProbs),
      pw: rawProbs[0], pn: rawProbs[1], pd: rawProbs[2],
    };
    predsRef.current.push(pred);
    setTimeline(t => [...t.slice(-60), pred]);

    if ((result.action === 'WAKE' || result.action === 'FORCE_WAKE') && !alarmFiredRef.current) {
      console.log(`[Win #${windowIdx}] 🔔 ALARM → ${result.action}`);
      alarmFiredRef.current = true;
      triggerAlarm(result.action, result.probs, result.deltaMin);
    }
  }

  async function triggerAlarm(action, finalProbs, minutesEarly) {
    _clearAllIntervals();
    setMonitoringCallback(null);
    activeRef.current = false;
    setActive(false);

    if (sessionRef.current) {
      sessionRef.current.predictions    = predsRef.current;
      sessionRef.current.alarm_fired_at = Date.now();
      sessionRef.current.minutes_early  = Math.round(minutesEarly ?? 0);
      await saveSession(sessionRef.current);
    }
    const savedSessionId = sessionRef.current?.id;
    sessionRef.current = null;
    scheduledAlarmIdRef.current = null;

    // FIX (v4): navigation and the live alarm notification used to be
    // gated behind two sequential, await'd 10s-timeout cleanup calls below
    // — on a slow device that's 20+ seconds of dead time between the model
    // deciding WAKE and the user seeing/hearing anything. _ensureAlarmChannel
    // is fast (it's a local channel registration, observed ~11ms in logs)
    // so it stays awaited, but it must come before the schedule call below
    // or the sound/importance settings on Android may not apply.
    await timed(_ensureAlarmChannel(), '_ensureAlarmChannel(triggerAlarm)');

    // Post the actual alarm the user needs to see/hear NOW, then navigate
    // immediately — neither is gated on cleanup of old notifications.
    timed(
      Notifications.scheduleNotificationAsync({
        content: {
          title:    action === 'FORCE_WAKE' ? '⏰ Wake up!' : '🌅 Good time to wake up',
          body:     `Stage: ${STAGE_NAMES[argmax(finalProbs)]}`,
          sound:    ALARM_SOUND,
          priority: Notifications.AndroidNotificationPriority.MAX,
          sticky:   false,
          ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
        },
        trigger: null,
      }),
      'scheduleNotificationAsync(live alarm)'
    ).catch(e => console.warn('[Monitoring] scheduleNotificationAsync(live alarm) failed:', e.message));

    // FIX: must use the shared root-level navigationRef (attached to
    // NavigationContainer in AppNavigator.js, same one pvtScheduler.js
    // uses), NOT this screen's own `navigation` prop. MonitoringScreen
    // lives inside the bottom Tab.Navigator ('Sleep' tab) — its injected
    // `navigation` prop is scoped to that tab navigator, which has no
    // 'Alarm' route. Only the root Stack.Navigator (sibling of 'Main')
    // has 'Alarm' / 'Feedback' / 'PVT'. Calling navigate('Alarm') on the
    // tab-scoped prop was silently doing nothing — this is why the live
    // alarm notification posted correctly but the Alarm screen never
    // appeared.
    rootNavigationRef.current?.navigate('Alarm', {
      action,
      probs:       finalProbs,
      sessionId:   savedSessionId,
      minutesEarly,
    });

    // NOTE: scheduleOptionalPVT() removed — PVT now shows automatically
    // right after the user rates their wake-up (FeedbackScreen.submit()
    // navigates straight to 'PVT'), so the old 60s-delayed notification
    // would only ever create a confusing duplicate prompt.

    // Fire-and-forget cleanup of stale scheduled notifications (the
    // background deadline alarm armed in startMonitoring(), plus any
    // stragglers). This is tidiness only — clearing the shade — and must
    // never block the alarm the user is already seeing/hearing above.
    timed(Notifications.cancelAllScheduledNotificationsAsync(), 'cancelAll(triggerAlarm)(bg)')
      .catch(e => console.warn('[Monitoring] cancelAll(triggerAlarm) failed:', e.message));
    timed(Notifications.dismissAllNotificationsAsync(), 'dismissAll(triggerAlarm)(bg)')
      .catch(e => console.warn('[Monitoring] dismissAll(triggerAlarm) failed:', e.message));
  }

  const stageColor   = currentStage != null ? STAGE_COLORS[currentStage] : colors.textDim;
  const canStart     = bleOk && modelReady && !starting && !active;
  const startLabel   = starting         ? 'Starting…'
                     : !bleOk           ? 'No device connected'
                     : !modelReady      ? 'Loading model…'
                     : active           ? 'Stop Monitoring'
                     :                   'Start Sleep Monitoring';

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>Sleep Monitor</Text>

      <View style={styles.orbContainer}>
        <Animated.View style={[styles.orbOuter, { borderColor: stageColor + '30', transform: [{ scale: pulseAnim }] }]}>
          <View style={[styles.orbInner, { borderColor: stageColor + '60', backgroundColor: stageColor + '12' }]}>
            <Text style={styles.orbIcon}>{active ? '◐' : '○'}</Text>
            {active && currentStage != null ? (
              <>
                <Text style={[styles.orbStage, { color: stageColor }]}>{STAGE_NAMES[currentStage]}</Text>
                <Text style={styles.orbProb}>{Math.round(probs[currentStage] * 100)}%</Text>
              </>
            ) : (
              <Text style={styles.orbIdle}>{starting ? 'Starting…' : 'Tap to start'}</Text>
            )}
          </View>
        </Animated.View>
      </View>

      {active && deltaMin != null && (
        <View style={styles.alarmRow}>
          <Text style={styles.alarmLabel}>ALARM IN</Text>
          <Text style={styles.alarmCountdown}>
            {deltaMin > 60
              ? `${Math.floor(deltaMin / 60)}h ${Math.round(deltaMin % 60)}m`
              : deltaMin > 1
                ? `${Math.round(deltaMin)}m`
                : `${Math.round(deltaMin * 60)}s`}
          </Text>
          <ActionBadge action={action} />
        </View>
      )}

      {active && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>
            STAGE PROBABILITIES {windowCount > 0 ? `— window #${windowCount}` : '— waiting for first window…'}
          </Text>
          {['Wake', 'Light', 'Deep'].map((label, i) => (
            <ProbBar key={label} label={label} value={probs[i]} color={STAGE_COLORS[i]} />
          ))}
        </View>
      )}

      {timeline.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>TONIGHT</Text>
          <View style={styles.miniTimeline}>
            {timeline.map((p, i) => (
              <View key={i} style={[styles.timelineBar, { backgroundColor: STAGE_COLORS[p.stage] }]} />
            ))}
          </View>
          <View style={styles.legendRow}>
            {[['W','Wake',colors.wake],['L','Light',colors.ndeep],['D','Deep',colors.deep]].map(([k,l,c]) => (
              <View key={k} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: c }]} />
                <Text style={styles.legendText}>{l}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.statusRow}>
        <View style={styles.statusChip}>
          <View style={[styles.statusDot, { backgroundColor: bleOk ? colors.success : colors.danger }]} />
          <Text style={styles.statusText}>{bleOk ? 'Wristband connected' : 'No wristband'}</Text>
        </View>
        <View style={styles.statusChip}>
          <View style={[styles.statusDot, { backgroundColor: modelReady ? colors.success : colors.warning }]} />
          <Text style={styles.statusText}>{modelReady ? 'Model ready' : 'Loading model…'}</Text>
        </View>
      </View>

      <TouchableOpacity
        style={[
          styles.mainBtn,
          active    ? styles.mainBtnStop  :
          !canStart ? styles.mainBtnDisabled :
                      styles.mainBtnStart,
        ]}
        onPress={active ? stopMonitoring : startMonitoring}
        disabled={starting || (!active && !canStart)}
        activeOpacity={0.85}
      >
        <Text style={styles.mainBtnText}>{startLabel}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function ProbBar({ label, value, color }) {
  return (
    <View style={styles.probRow}>
      <Text style={styles.probLabel}>{label}</Text>
      <View style={styles.probTrack}>
        <View style={[styles.probFill, { width: `${Math.round(value * 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.probValue}>{Math.round(value * 100)}%</Text>
    </View>
  );
}

function ActionBadge({ action }) {
  const cfg = {
    PRE_WINDOW: { label: 'Pre-window', color: colors.textSub },
    WAIT:       { label: 'Waiting…',   color: colors.accent },
    WAKE:       { label: '🌅 WAKE',    color: colors.primary },
    FORCE_WAKE: { label: '⏰ FORCED',  color: colors.danger },
  };
  const { label, color } = cfg[action] ?? cfg.WAIT;
  return (
    <View style={[styles.actionBadge, { borderColor: color + '60', backgroundColor: color + '15' }]}>
      <Text style={[styles.actionBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg },
  content:    { padding: spacing.lg, paddingBottom: spacing.xxl, alignItems: 'center' },
  title:      { ...typography.h1, alignSelf: 'flex-start', marginBottom: spacing.lg },

  orbContainer: { marginVertical: spacing.lg },
  orbOuter:     { width: 220, height: 220, borderRadius: 110, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  orbInner:     { width: 180, height: 180, borderRadius: 90, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  orbIcon:      { fontSize: 40, color: colors.primary, marginBottom: spacing.xs },
  orbStage:     { fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  orbProb:      { ...typography.body, color: colors.textSub, marginTop: 2 },
  orbIdle:      { ...typography.body, color: colors.textSub },

  alarmRow:       { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, width: '100%', borderWidth: 1, borderColor: colors.border },
  alarmLabel:     { ...typography.label },
  alarmCountdown: { fontSize: 28, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  actionBadge:    { marginLeft: 'auto', paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.full, borderWidth: 1 },
  actionBadgeText:{ fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  card:      { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, width: '100%', borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md },
  cardLabel: { ...typography.label, marginBottom: spacing.md },

  probRow:   { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  probLabel: { width: 44, ...typography.caption },
  probTrack: { flex: 1, height: 8, backgroundColor: colors.surface, borderRadius: 4, overflow: 'hidden', marginHorizontal: spacing.sm },
  probFill:  { height: '100%', borderRadius: 4 },
  probValue: { width: 40, ...typography.caption, textAlign: 'right' },

  miniTimeline: { flexDirection: 'row', height: 24, borderRadius: radius.sm, overflow: 'hidden', marginBottom: spacing.sm },
  timelineBar:  { flex: 1, marginHorizontal: 0.5 },
  legendRow:    { flexDirection: 'row' },
  legendItem:   { flexDirection: 'row', alignItems: 'center', marginRight: spacing.md },
  legendDot:    { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  legendText:   { ...typography.caption },

  statusRow:  { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, width: '100%' },
  statusChip: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border },
  statusDot:  { width: 8, height: 8, borderRadius: 4, marginRight: spacing.xs },
  statusText: { ...typography.caption, flex: 1 },

  mainBtn:         { width: '100%', borderRadius: radius.full, paddingVertical: spacing.lg, alignItems: 'center' },
  mainBtnStart:    { backgroundColor: colors.primary },
  mainBtnStop:     { backgroundColor: colors.danger + '30', borderWidth: 1, borderColor: colors.danger },
  mainBtnDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  mainBtnText:     { ...typography.h3, fontWeight: '700', color: colors.text },
});