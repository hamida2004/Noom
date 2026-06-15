/**
 * PVTScreen.js — Psychomotor Vigilance Task
 *
 * Modes, governed by route param `mode`:
 *   'post_alarm' — optional, fires ~1 minute after the sleep alarm goes off
 *   'weekly'     — fires if the last-14-days avg rating < 3 (same task, different framing)
 *   'daily'      — generic fallback framing
 *
 * Algorithm:
 *   - Random ISI between 2 000 – 10 000 ms (standard PVT protocol)
 *   - Measure reaction time (RT) in ms from stimulus onset to button press
 *   - False starts (RT < 100 ms) are penalised (shown as "Too fast!")
 *   - Lapses (RT > 500 ms) are counted separately
 *   - Summary: mean RT, median RT, lapse count, false starts
 *
 * Scheduling (see pvtScheduler.js for how this screen gets triggered):
 *   post_alarm → scheduleOptionalPVT(), one-shot, ~60 s after triggerAlarm()
 *   weekly     → checkAndScheduleWeeklyPVT(), one-shot when avg(last 14 ratings) < 3
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Vibration,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, typography } from '../theme';
import { savePVTResult } from '../services/storage';

// ─── PVT config ───────────────────────────────────────────────────────────────
const DURATION_MS  = 60_000;   // 1 minute
const ISI_MIN      = 2_000;
const ISI_MAX      = 10_000;
const FALSE_START  = 100;      // ms — too fast
const LAPSE_THRESH = 500;      // ms — too slow

export default function PVTScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const mode   = route.params?.mode ?? 'daily';   // 'daily' | 'weekly'

  // ── Phase: 'intro' | 'running' | 'stimulus' | 'done' ───────────────────────
  const [phase,       setPhase]       = useState('intro');
  const [timeLeft,    setTimeLeft]    = useState(DURATION_MS / 1000);
  const [rt,          setRt]          = useState(null);    // last RT in ms
  const [rtLabel,     setRtLabel]     = useState('');
  const [trialCount,  setTrialCount]  = useState(0);
  const [results,     setResults]     = useState([]);      // { rt, lapse, falseStart }

  // Refs for timers and stimulus onset
  const sessionStartRef  = useRef(null);
  const stimulusOnsetRef = useRef(null);
  const waitTimerRef     = useRef(null);
  const countdownRef     = useRef(null);
  const phaseRef         = useRef('intro');

  // Animation
  const dotScale   = useRef(new Animated.Value(0)).current;
  const dotOpacity = useRef(new Animated.Value(0)).current;
  const rtFade     = useRef(new Animated.Value(0)).current;

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => () => {
    clearTimeout(waitTimerRef.current);
    clearInterval(countdownRef.current);
  }, []);

  // ── Start session ───────────────────────────────────────────────────────────
  function startSession() {
    sessionStartRef.current = Date.now();
    setPhase('running');
    phaseRef.current = 'running';
    setResults([]);
    setTrialCount(0);
    setTimeLeft(DURATION_MS / 1000);

    // Countdown timer
    countdownRef.current = setInterval(() => {
      const elapsed = Date.now() - sessionStartRef.current;
      const left    = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000));
      setTimeLeft(left);
      if (elapsed >= DURATION_MS) {
        clearInterval(countdownRef.current);
        endSession();
      }
    }, 500);

    scheduleNextStimulus();
  }

  // ── Schedule next stimulus after random ISI ─────────────────────────────────
  function scheduleNextStimulus() {
    if (phaseRef.current === 'done') return;

    const elapsed = Date.now() - (sessionStartRef.current ?? Date.now());
    if (elapsed >= DURATION_MS) { endSession(); return; }

    const isi = ISI_MIN + Math.random() * (ISI_MAX - ISI_MIN);

    // Make sure the stimulus fires before the session ends
    const safeIsi = Math.min(isi, DURATION_MS - elapsed - 200);
    if (safeIsi < 500) { endSession(); return; }

    waitTimerRef.current = setTimeout(() => {
      showStimulus();
    }, safeIsi);
  }

  // ── Show the stimulus dot ───────────────────────────────────────────────────
  function showStimulus() {
    if (phaseRef.current === 'done') return;

    stimulusOnsetRef.current = Date.now();
    setPhase('stimulus');
    phaseRef.current = 'stimulus';
    setRt(null);
    setRtLabel('');

    // Animate dot in
    dotScale.setValue(0);
    dotOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(dotScale,   { toValue: 1, useNativeDriver: true, tension: 80, friction: 5 }),
      Animated.timing(dotOpacity, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  // ── Handle tap ──────────────────────────────────────────────────────────────
  function handleTap() {
    const now = Date.now();

    if (phaseRef.current === 'running') {
      // Tapped before stimulus — false start
      const entry = { rt: 0, falseStart: true, lapse: false };
      setResults(r => [...r, entry]);
      setRtLabel('Too fast!');
      flashRt();
      return;
    }

    if (phaseRef.current !== 'stimulus') return;

    const reactionTime = now - stimulusOnsetRef.current;
    clearTimeout(waitTimerRef.current);

    // Dismiss dot
    Animated.parallel([
      Animated.timing(dotScale,   { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(dotOpacity, { toValue: 0, duration: 100, useNativeDriver: true }),
    ]).start();

    const isLapse      = reactionTime > LAPSE_THRESH;
    const isFalseStart = reactionTime < FALSE_START;
    const entry = { rt: reactionTime, falseStart: isFalseStart, lapse: isLapse };

    setResults(r => [...r, entry]);
    setTrialCount(c => c + 1);
    setRt(reactionTime);
    setRtLabel(
      isFalseStart ? 'Too fast!'
      : isLapse    ? `${reactionTime} ms — lapse!`
      :              `${reactionTime} ms`
    );

    flashRt();
    setPhase('running');
    phaseRef.current = 'running';
    scheduleNextStimulus();
  }

  function flashRt() {
    rtFade.setValue(1);
    Animated.timing(rtFade, { toValue: 0, duration: 1200, useNativeDriver: true }).start();
  }

  // ── End session ─────────────────────────────────────────────────────────────
  async function endSession() {
    if (phaseRef.current === 'done') return;  // ← add this guard
    clearInterval(countdownRef.current);
    clearTimeout(waitTimerRef.current);
    phaseRef.current = 'done';
    setPhase('done');
  }

  // We need results in endSession — use a ref mirror
  const resultsRef = useRef([]);
  useEffect(() => { resultsRef.current = results; }, [results]);

  // Use a separate effect to save when phase becomes 'done'
  useEffect(() => {
    if (phase !== 'done') return;
    const valid  = resultsRef.current.filter(r => !r.falseStart && r.rt > 0);
    const lapses = resultsRef.current.filter(r => r.lapse).length;
    const falseStarts = resultsRef.current.filter(r => r.falseStart).length;
    const meanRt   = valid.length ? Math.round(valid.reduce((a, r) => a + r.rt, 0) / valid.length) : null;
    const sorted   = [...valid].sort((a, b) => a.rt - b.rt);
    const medianRt = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)].rt) : null;

    savePVTResult({
      mode,
      date:        new Date().toISOString(),
      meanRt,
      medianRt,
      lapses,
      falseStarts,
      trials:      resultsRef.current.length,
    }).catch(e => console.warn('[PVT] Save failed:', e));
  }, [phase]);

  // ── Computed summary ────────────────────────────────────────────────────────
  const valid      = results.filter(r => !r.falseStart && r.rt > 0);
  const lapses     = results.filter(r => r.lapse).length;
  const falseStarts= results.filter(r => r.falseStart).length;
  const meanRt     = valid.length ? Math.round(valid.reduce((a, r) => a + r.rt, 0) / valid.length) : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* ── Intro ─────────────────────────────────────────────── */}
      {phase === 'intro' && (
        <View style={styles.centred}>
         <Text style={styles.modeTag}>
          {mode === 'weekly'     ? '⚠ Sleep Quality Check-in'
          : mode === 'post_alarm' ? '🧠 Post-Wake Check'
          : 'Daily Readiness Test'}
        </Text>
          <Text style={styles.title}>Reaction Time Test</Text>
          <Text style={styles.body}>
            A red dot will appear at random intervals.{'\n'}
            Tap the screen as quickly as possible when you see it.{'\n\n'}
            The test lasts 1 minute.
          </Text>
          {mode === 'weekly' && (
            <View style={styles.warnBox}>
              <Text style={styles.warnText}>
                Your average sleep quality over the last 2 weeks was below 3 ★.
                This test checks if your alertness has been affected.
              </Text>
            </View>
          )}
          <TouchableOpacity style={styles.primaryBtn} onPress={startSession}>
            <Text style={styles.primaryBtnText}>Start</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Running / Stimulus ────────────────────────────────── */}
      {(phase === 'running' || phase === 'stimulus') && (
        <TouchableOpacity
          style={styles.tapArea}
          onPress={handleTap}
          activeOpacity={1}
        >
          {/* Timer */}
          <View style={styles.timerRow}>
            <Text style={styles.timerText}>{timeLeft}s</Text>
            <Text style={styles.trialText}>{trialCount} taps</Text>
          </View>

          {/* Stimulus dot */}
          <Animated.View
            style={[
              styles.dot,
              {
                transform:  [{ scale: dotScale }],
                opacity:    dotOpacity,
              },
            ]}
          />

          {/* RT feedback */}
          <Animated.Text style={[styles.rtFeedback, { opacity: rtFade }]}>
            {rtLabel}
          </Animated.Text>

          <Text style={styles.tapHint}>Tap anywhere when you see the dot</Text>
        </TouchableOpacity>
      )}

      {/* ── Done ──────────────────────────────────────────────── */}
      {phase === 'done' && (
        <View style={styles.centred}>
          <Text style={styles.title}>Done!</Text>

          <View style={styles.summaryCard}>
            <SummaryRow label="Mean RT"    value={meanRt != null ? `${meanRt} ms` : '—'} />
            <SummaryRow label="Trials"     value={String(valid.length)} />
            <SummaryRow label="Lapses"     value={String(lapses)}      highlight={lapses > 3} />
            <SummaryRow label="False starts" value={String(falseStarts)} />
          </View>

          {lapses > 3 && (
            <View style={styles.warnBox}>
              <Text style={styles.warnText}>
                {lapses} lapses detected. Consider going to bed earlier tonight.
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Main' }] })}
          >
            <Text style={styles.primaryBtnText}>Back to home</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function SummaryRow({ label, value, highlight }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, highlight && { color: colors.danger }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centred:   { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  modeTag:  { ...typography.label, color: colors.accent, marginBottom: spacing.sm },
  title:    { fontSize: 30, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: spacing.md },
  body:     { ...typography.body, color: colors.textSub, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 24 },

  warnBox:  { backgroundColor: colors.warning + '20', borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.warning + '60', marginBottom: spacing.lg, maxWidth: 300 },
  warnText: { ...typography.caption, color: colors.warning, textAlign: 'center' },

  primaryBtn:     { backgroundColor: colors.primary, borderRadius: radius.full, paddingHorizontal: spacing.xxl, paddingVertical: spacing.md, marginBottom: spacing.md },
  primaryBtnText: { ...typography.h3, color: colors.bg, fontWeight: '700' },
  skipBtn:        { paddingVertical: spacing.sm },
  skipText:       { ...typography.body, color: colors.textSub },

  // Tap area
  tapArea:  { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  timerRow: { position: 'absolute', top: spacing.xl, flexDirection: 'row', justifyContent: 'space-between', width: '100%', paddingHorizontal: spacing.lg },
  timerText:{ fontSize: 24, fontWeight: '800', color: colors.text },
  trialText:{ fontSize: 16, color: colors.textSub, alignSelf: 'center' },

  dot: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: colors.danger,
  },

  rtFeedback: { position: 'absolute', bottom: 120, fontSize: 22, fontWeight: '700', color: colors.text },
  tapHint:    { position: 'absolute', bottom: spacing.xl, ...typography.caption, color: colors.textDim },

  // Summary
  summaryCard:  { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, width: '90%', borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  summaryRow:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  summaryLabel: { ...typography.body, color: colors.textSub },
  summaryValue: { ...typography.h3 },
});
