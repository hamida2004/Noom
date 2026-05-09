import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Animated,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, radius, typography } from '../theme';
import * as Notifications from 'expo-notifications';
import {
  connectToDevice, isConnected, accGate, extractFeatures,
} from '../services/ble';
import {
  alarmDecision, resetAlarmState, argmax,
} from '../services/alarmEngine';
import { loadModel, predict, isModelLoaded } from '../services/classifier';
import {
  loadAlarmTime, loadCalibration, loadUserPrefs,
  saveSession, generateSessionId, todayDateStr,
} from '../services/storage';


const STAGE_COLORS = [colors.wake, colors.ndeep, colors.deep];
const STAGE_NAMES  = ['WAKE', 'LIGHT', 'DEEP'];

export default function MonitoringScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  async function testOnnx() {
  try {

    console.log('Loading model...');

    await loadModel();

    console.log('Model loaded.');

    const dummyWindow = Array.from({ length: 1920 }, () => ({
      bvp: 300,
      acc_x: 0.01,
      acc_y: 0.01,
      acc_z: 0.01,
      temp: 36.5,
      hr: 65,
      ibi: 900,
    }));

    const probs = await predict(dummyWindow);

    console.log('Inference OK:', probs);

  } catch (e) {
    console.error('ONNX TEST FAILED:', e);
  }
}

  const [active, setActive]       = useState(false);
  const [bleOk, setBleOk]         = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [currentStage, setStage]  = useState(null);    // 0,1,2
  const [probs, setProbs]         = useState([0.33,0.33,0.34]);
  const [action, setAction]       = useState('PRE_WINDOW');
  const [deltaMin, setDeltaMin]   = useState(null);
  const [alarmTime, setAlarmTime] = useState(null);
  const [timeline, setTimeline]   = useState([]);      // { stage, ts }

  const sessionRef   = useRef(null);
  const simRef = useRef(null);
  const predsRef     = useRef([]);
  const prefsRef     = useRef(null);
  const pulseAnim    = useRef(new Animated.Value(1)).current;

  // Load alarm + prefs
  useFocusEffect(useCallback(() => {
    loadAlarmTime().then(t => {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d < new Date()) d.setDate(d.getDate() + 1);
      setAlarmTime(d);
    });
    loadUserPrefs().then(p => { prefsRef.current = p; });
    setBleOk(isConnected());

    // Pre-load the ONNX model so first window is fast
    if (!isModelLoaded()) {
      loadModel()
        .then(() => setModelReady(true))
        .catch(e => console.warn('[Monitoring] Model load failed:', e));
    } else {
      setModelReady(true);
    }
  }, []));

  // Pulse animation when active
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
    } else {
      pulseAnim.setValue(1);
    }
  }, [active]);

  function startMonitoring() {
    if (!bleOk) {
      // Demo mode: run with simulated data
    }
    resetAlarmState();
    sessionRef.current = {
      id:        generateSessionId(),
      date:      todayDateStr(),
      alarm_time: alarmTime?.toTimeString().slice(0,5),
      predictions: [],
      started_at: Date.now(),
    };
    predsRef.current = [];
    setTimeline([]);
    setActive(true);

    // Connect data handler if device is live
    if (isConnected()) {
      connectToDevice(
        null, // already connected
        (window) => handleWindow(window),
        null, null
      );
    } else {
      // Simulate windows every 15 s for demo
      startSimulation();
    }
  }

  // Simple heuristic used only if ONNX model fails to load
  function _heuristicFallback(window) {
    const mags = window.map(s => Math.sqrt((s.acc_x||0)**2+(s.acc_y||0)**2+(s.acc_z||0)**2));
    const mean = mags.reduce((a,b)=>a+b,0)/mags.length;
    const std  = Math.sqrt(mags.reduce((a,b)=>a+(b-mean)**2,0)/mags.length);
    if (std > 0.3)  return [0.75, 0.20, 0.05];
    if (std < 0.05) return [0.05, 0.40, 0.55];
    return [0.15, 0.70, 0.15];
  }

  function startSimulation() {
    simRef.current = setInterval(() => {
      // Fake window of 1920 samples
      const fakeWindow = Array.from({ length: 1920 }, (_, i) => ({
        acc_x: (Math.random()-0.5)*0.1,
        acc_y: (Math.random()-0.5)*0.1,
        acc_z: (Math.random()-0.5)*0.05,
        bvp:   300 + Math.sin(i/10)*50 + Math.random()*20,
        hr:    60 + Math.random()*5,
        ibi:   900 + Math.random()*50,
        temp:  36.5 + Math.random()*0.1,
      }));
      handleWindow(fakeWindow);
    }, 15000);
  }

  async function stopMonitoring() {
    clearInterval(simRef.current);
    setActive(false);

    if (sessionRef.current) {
      sessionRef.current.predictions = predsRef.current;
      await saveSession(sessionRef.current);
    }
  }

  async function handleWindow(window) {
    if (!active && !sessionRef.current) return;

    // 1. ACC gate (rule-based, no model needed)
    const moving = accGate(window, prefsRef.current?.acc_threshold ?? 0.12);
    let rawProbs;

    if (moving) {
      rawProbs = [0.90, 0.08, 0.02];  // Hard-assign Wake
    } else {
      // 2. Real ONNX inference (falls back to heuristic if model not ready)
      try {
        rawProbs = await predict(window);
      } catch (e) {
        console.warn('[Monitoring] Inference error, using heuristic:', e.message);
        rawProbs = _heuristicFallback(window);
      }
    }

    const now   = new Date();
    const stage = argmax(rawProbs);

    // 3. Alarm decision
    if (alarmTime && prefsRef.current) {
      const result = alarmDecision({ rawProbs, alarmTime, now, prefs: prefsRef.current });
      setProbs(result.probs);
      setAction(result.action);
      setDeltaMin(result.deltaMin);
      setStage(argmax(result.probs));

      // Log prediction
      const pred = { ts: now.getTime(), stage, pw: rawProbs[0], pn: rawProbs[1], pd: rawProbs[2] };
      predsRef.current.push(pred);
      setTimeline(t => [...t.slice(-60), pred]);

      // Trigger alarm
      if (result.action === 'WAKE' || result.action === 'FORCE_WAKE') {
        triggerAlarm(result.action, result.probs, result.deltaMin);
      }
    }
  }

  async function triggerAlarm(action, finalProbs, minutesEarly) {
    clearInterval(simRef.current);
    setActive(false);

    if (sessionRef.current) {
      sessionRef.current.predictions  = predsRef.current;
      sessionRef.current.alarm_fired_at = Date.now();
      sessionRef.current.minutes_early  = Math.round(minutesEarly);
      await saveSession(sessionRef.current);
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: action === 'FORCE_WAKE' ? '⏰ Wake up!' : '🌅 Good time to wake up',
        body:  `Sleep stage: ${STAGE_NAMES[argmax(finalProbs)]}`,
        sound: true,
      },
      trigger: null,
    });

    navigation.navigate('Alarm', {
      action,
      probs:      finalProbs,
      sessionId:  sessionRef.current?.id,
      minutesEarly,
    });
  }

  const stageColor = currentStage != null ? STAGE_COLORS[currentStage] : colors.textDim;

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sleep Monitor</Text>

      {/* ── Main status orb ───────────────────────────────────── */}
      <View style={styles.orbContainer}>
        <Animated.View style={[styles.orbOuter, { borderColor: stageColor + '30', transform: [{ scale: pulseAnim }] }]}>
          <View style={[styles.orbInner, { borderColor: stageColor + '60', backgroundColor: stageColor + '12' }]}>
            <Text style={styles.orbIcon}>{active ? '◐' : '○'}</Text>
            {active && currentStage != null && (
              <>
                <Text style={[styles.orbStage, { color: stageColor }]}>
                  {STAGE_NAMES[currentStage]}
                </Text>
                <Text style={styles.orbProb}>{Math.round(probs[currentStage] * 100)}%</Text>
              </>
            )}
            {!active && <Text style={styles.orbIdle}>Tap to start</Text>}
          </View>
        </Animated.View>
      </View>

      {/* ── Alarm countdown ───────────────────────────────────── */}
      {active && deltaMin != null && (
        <View style={styles.alarmRow}>
          <Text style={styles.alarmLabel}>ALARM IN</Text>
          <Text style={styles.alarmCountdown}>
            {deltaMin > 60
              ? `${Math.floor(deltaMin/60)}h ${Math.round(deltaMin%60)}m`
              : `${Math.round(deltaMin)}m`}
          </Text>
          <ActionBadge action={action} />
        </View>
      )}
  <View>
    <Pressable
    onPress={testOnnx}
    >
      <Text>test</Text>
    </Pressable>
  </View>
      {/* ── Probability bars ──────────────────────────────────── */}
      {active && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>STAGE PROBABILITIES</Text>
          {['Wake', 'Light', 'Deep'].map((label, i) => (
            <ProbBar key={label} label={label} value={probs[i]} color={STAGE_COLORS[i]} />
          ))}
        </View>
      )}

      {/* ── Mini timeline ─────────────────────────────────────── */}
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

      {/* ── BLE status ────────────────────────────────────────── */}
      <View style={styles.bleRow}>
        <View style={[styles.bleDot, { backgroundColor: bleOk ? colors.success : colors.warning }]} />
        <Text style={styles.bleText}>
          {bleOk ? 'Live data from wristband' : 'Demo mode — no device connected'}
        </Text>
      </View>

      {/* ── Start / Stop button ───────────────────────────────── */}
      <TouchableOpacity
        style={[styles.mainBtn, active ? styles.mainBtnStop : styles.mainBtnStart]}
        onPress={active ? stopMonitoring : startMonitoring}
        activeOpacity={0.85}
      >
        <Text style={styles.mainBtnText}>
          {active
            ? 'Stop Monitoring'
            : modelReady
              ? 'Start Sleep Monitoring'
              : 'Loading model…'}
        </Text>
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
        <View style={[styles.probFill, { width: `${Math.round(value*100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.probValue}>{Math.round(value*100)}%</Text>
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

  // Orb
  orbContainer: { marginVertical: spacing.lg },
  orbOuter:     { width: 220, height: 220, borderRadius: 110, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  orbInner:     { width: 180, height: 180, borderRadius: 90,  borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  orbIcon:      { fontSize: 40, color: colors.primary, marginBottom: spacing.xs },
  orbStage:     { fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  orbProb:      { ...typography.body, color: colors.textSub, marginTop: 2 },
  orbIdle:      { ...typography.body, color: colors.textSub },

  // Alarm
  alarmRow:      { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, width: '100%', borderWidth: 1, borderColor: colors.border },
  alarmLabel:    { ...typography.label },
  alarmCountdown:{ fontSize: 28, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  actionBadge:   { marginLeft: 'auto', paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.full, borderWidth: 1 },
  actionBadgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  card:       { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, width: '100%', borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md },
  cardLabel:  { ...typography.label, marginBottom: spacing.md },

  // Prob bars
  probRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  probLabel:  { width: 44, ...typography.caption },
  probTrack:  { flex: 1, height: 8, backgroundColor: colors.surface, borderRadius: 4, overflow: 'hidden', marginHorizontal: spacing.sm },
  probFill:   { height: '100%', borderRadius: 4 },
  probValue:  { width: 40, ...typography.caption, textAlign: 'right' },

  // Mini timeline
  miniTimeline: { flexDirection: 'row', height: 24, borderRadius: radius.sm, overflow: 'hidden', marginBottom: spacing.sm },
  timelineBar:  { flex: 1, marginHorizontal: 0.5 },
  legendRow:    { flexDirection: 'row' },
  legendItem:   { flexDirection: 'row', alignItems: 'center', marginRight: spacing.md },
  legendDot:    { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  legendText:   { ...typography.caption },

  bleRow:   { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  bleDot:   { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  bleText:  { ...typography.caption },

  mainBtn:       { width: '100%', borderRadius: radius.full, paddingVertical: spacing.lg, alignItems: 'center' },
  mainBtnStart:  { backgroundColor: colors.primary },
  mainBtnStop:   { backgroundColor: colors.danger + '30', borderWidth: 1, borderColor: colors.danger },
  mainBtnText:   { ...typography.h3, fontWeight: '700', color: colors.text },
});