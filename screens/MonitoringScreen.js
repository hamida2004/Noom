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
import { scheduleOptionalPVT } from '../services/pvtScheduler';
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

/**
 * Android requires a notification channel with the custom sound attached
 * for it to actually play (the `sound` field on the content alone is not
 * enough on Android 8+). No-op on iOS — there the `sound` field on the
 * content is sufficient as long as the file is bundled into the app.
 */
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

  // ── UI state ──────────────────────────────────────────────────────────────
  const [active,       setActive]     = useState(false);
  const [bleOk,        setBleOk]      = useState(false);
  const [modelReady,   setModelReady] = useState(false);
  const [starting,     setStarting]   = useState(false);
  const [currentStage, setStage]      = useState(null);
  const [probs,        setProbs]      = useState([0.33, 0.33, 0.34]);
  const [action,       setAction]     = useState('PRE_WINDOW');
  const [deltaMin,     setDeltaMin]   = useState(null);
  const [timeline,     setTimeline]   = useState([]);
  const [windowCount,  setWindowCount]= useState(0);   // how many windows processed

  // ── Refs ──────────────────────────────────────────────────────────────────
  const navigationRef     = useRef(navigation);
  const activeRef         = useRef(false);
  const alarmFiredRef     = useRef(false);
  const sessionRef        = useRef(null);
  const deadlineRef       = useRef(null);
  const countdownRef      = useRef(null);
  const predsRef          = useRef([]);
  const prefsRef          = useRef(null);
  const alarmTimeRef      = useRef(null);
  const scheduledAlarmIdRef = useRef(null);   // id of the OS-level deadline notification
  const pulseAnim         = useRef(new Animated.Value(1)).current;

  useEffect(() => { navigationRef.current = navigation; }, [navigation]);
  useEffect(() => { activeRef.current = active; }, [active]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => { _clearAllIntervals(); setMonitoringCallback(null); }, []);

  // ── Load model on focus ───────────────────────────────────────────────────
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

  // ── Pulse animation ───────────────────────────────────────────────────────
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

  // ── Background fetch ──────────────────────────────────────────────────────
  useEffect(() => {
    BackgroundFetch.registerTaskAsync(BG_TASK, {
      minimumInterval: 15,
      stopOnTerminate: false,
      startOnBoot: false,
    }).catch(() => {});
    return () => { BackgroundFetch.unregisterTaskAsync(BG_TASK).catch(() => {}); };
  }, []);

  // ── AppState ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') setBleOk(isConnected());
    });
    return () => sub.remove();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // startMonitoring
  // ─────────────────────────────────────────────────────────────────────────
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

    setStarting(true);
    try {
      // ── 1. Load alarm time and prefs ──────────────────────────────────────
      const [timeStr, prefs] = await Promise.all([loadAlarmTime(), loadUserPrefs()]);
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

      // ── 1b. Arm the OS-level deadline alarm ───────────────────────────────
      // Guarantees the alarm fires at the deadline (with alarm.wav) even if
      // the JS thread is suspended overnight. Clear any stale notifications
      // from a previous session first so they never pile up.
      await Notifications.requestPermissionsAsync();
      await _ensureAlarmChannel();
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();

      scheduledAlarmIdRef.current = await Notifications.scheduleNotificationAsync({
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
    });
      console.log('[Monitoring] Deadline alarm armed for', alarmTimeRef.current.toLocaleTimeString());

      // ── 2. Reset state ────────────────────────────────────────────────────
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

      // ── 3. Countdown ticker ───────────────────────────────────────────────
      _clearAllIntervals();
      countdownRef.current = setInterval(() => {
        if (!activeRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; return; }
        const at = alarmTimeRef.current;
        if (at) setDeltaMin(Math.max(0, (at.getTime() - Date.now()) / 60_000));
      }, 1_000);

      // ── 4. Deadline watchdog ──────────────────────────────────────────────
      // Drives the in-app FORCE_WAKE experience while the app is foregrounded.
      // The OS-level notification armed above is the safety net for when it's not.
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

      // ── 5. Register BLE window callback ───────────────────────────────────
      setMonitoringCallback(win => handleWindow(win));

    } catch (err) {
      console.error('[Monitoring] startMonitoring failed:', err);
    } finally {
      setStarting(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  async function stopMonitoring() {
    activeRef.current = false;
    setActive(false);
    _clearAllIntervals();
    setMonitoringCallback(null);

    // User ended the session early — the deadline alarm is no longer wanted.
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

  // ─────────────────────────────────────────────────────────────────────────
  // BLE window handler — every 15 s (STEP_SIZE=960 @ 64 Hz)
  // ─────────────────────────────────────────────────────────────────────────
  async function handleWindow(window) {
    if (!activeRef.current || alarmFiredRef.current) return;

    const windowIdx = predsRef.current.length + 1;
    const now       = new Date();
    const deltaMs   = alarmTimeRef.current
      ? alarmTimeRef.current.getTime() - now.getTime()
      : null;
    const deltaMinNow = deltaMs != null ? deltaMs / 60_000 : null;

    // ── ACC gate ─────────────────────────────────────────────────────────────
    const threshold = prefsRef.current?.acc_threshold ?? 0.12;
    const moving    = accGate(window, threshold);

    let rawProbs;
    if (moving) {
      rawProbs = [0.90, 0.08, 0.02];
      console.log(`[Win #${windowIdx}] ACC gate → MOVING  rawProbs: W=0.90 L=0.08 D=0.02`);
    } else {
      // ── ONNX inference ────────────────────────────────────────────────────
      try {
        rawProbs = await predict(window);
        console.log(
          `[Win #${windowIdx}] ONNX → ` +
          `W=${rawProbs[0].toFixed(3)} L=${rawProbs[1].toFixed(3)} D=${rawProbs[2].toFixed(3)} ` +
          `stage=${STAGE_NAMES[argmax(rawProbs)]}  Δt=${deltaMinNow?.toFixed(1) ?? '—'}min`
        );
      } catch (e) {
        console.error(`[Win #${windowIdx}] ONNX predict failed:`, e.message);
        return;   // skip this window — do NOT fall back to heuristic
      }
    }

    if (!activeRef.current || alarmFiredRef.current) return;

    // ── alarmDecision ─────────────────────────────────────────────────────
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

    // ── Update UI ─────────────────────────────────────────────────────────
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

    // ── Trigger alarm ─────────────────────────────────────────────────────
    if ((result.action === 'WAKE' || result.action === 'FORCE_WAKE') && !alarmFiredRef.current) {
      console.log(`[Win #${windowIdx}] 🔔 ALARM → ${result.action}`);
      alarmFiredRef.current = true;
      triggerAlarm(result.action, result.probs, result.deltaMin);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
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

    // Clear the scheduled deadline alarm (whether this IS that alarm firing,
    // or a smart WAKE preempting it) plus any stragglers, and clear the
    // notification shade, before firing the single "live" alarm notification.
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
    scheduledAlarmIdRef.current = null;

    await _ensureAlarmChannel();
    await Notifications.scheduleNotificationAsync({
    content: {
      title:    action === 'FORCE_WAKE' ? '⏰ Wake up!' : '🌅 Good time to wake up',
      body:     `Stage: ${STAGE_NAMES[argmax(finalProbs)]}`,
      sound:    ALARM_SOUND,
      priority: Notifications.AndroidNotificationPriority.MAX,
      sticky:   false,
      ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
    },
    trigger: null,
  });

    // Optional post-alarm PVT, fires ~1 minute from now. Fire-and-forget —
    // don't block navigation on it.
    scheduleOptionalPVT().catch(e =>
      console.warn('[Monitoring] scheduleOptionalPVT failed:', e)
    );

    navigationRef.current.navigate('Alarm', {
      action,
      probs:       finalProbs,
      sessionId:   savedSessionId,
      minutesEarly,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
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

      {/* ── Status orb ───────────────────────────────────────── */}
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

      {/* ── Alarm countdown ──────────────────────────────────── */}
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

      {/* ── Probability bars ─────────────────────────────────── */}
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

      {/* ── Mini timeline ────────────────────────────────────── */}
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

      {/* ── BLE + model status ───────────────────────────────── */}
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

      {/* ── Start / Stop ─────────────────────────────────────── */}
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

// ─── Sub-components ───────────────────────────────────────────────────────────

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