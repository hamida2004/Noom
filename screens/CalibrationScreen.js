/**
 * CalibrationScreen.js — NOOM (v2 fixed)
 *
 * Fixes vs previous version:
 *
 * 1. Uses setCalibrationCallback() instead of the removed setOnDataCallback().
 *
 * 2. Collects window-level ACC std values (one per BLE window) rather than
 *    per-sample magnitudes. This matches exactly what accGate() in ble.js
 *    computes at runtime, so the calibrated threshold is in the same unit
 *    and directly comparable.
 *
 *    accGate()          → std of ACC magnitudes across the window > threshold?
 *    CalibrationScreen  → collects those same std values per phase, then
 *                         threshold = (still_std_mean + walk_std_mean) / 2
 *
 * 3. Phase duration extended to 90 seconds so each phase collects ~5 BLE
 *    windows (at STEP_SIZE=960 @ 64 Hz → one window every 15 s).
 *    30 s only yielded 1–2 windows, making the mean/std of stds meaningless.
 *
 * 4. Simulation branch (no device connected) now pushes simulated std values
 *    at the same rate as a real BLE window would arrive (~1 per 15 s) so the
 *    collected data has the same shape as the live-device path.
 *
 * 5. Display values on the phase-2 done card now show std-of-stds correctly.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, typography } from '../theme';
import { saveCalibration, saveUserPrefs } from '../services/storage';
import { isConnected, setCalibrationCallback } from '../services/ble';

// ─────────────────────────────────────────────────────────────────────────────
// Phase config
//
// Duration is 90 s so that ~5 BLE windows arrive per phase.
// (WINDOW_SIZE=1920, STEP_SIZE=960 @ 64 Hz → one window every 15 s)
// With 30 s only 1 window arrives, giving a single-point "mean" which is
// unreliable. 90 s gives 5 windows → stable mean/std of window-level stds.
// ─────────────────────────────────────────────────────────────────────────────
const PHASE_DURATION_S = 90;

const PHASES = [
  {
    id:          'still',
    label:       'Lie Still',
    icon:        '◎',
    color:       colors.deep,
    duration:    PHASE_DURATION_S,
    instruction: 'Place your wrist on the bed and lie completely still for 90 seconds.',
    simStd:      0.008,   // realistic still-wrist std in g
  },
  {
    id:          'walk',
    label:       'Walk',
    icon:        '▶',
    color:       colors.wake,
    duration:    PHASE_DURATION_S,
    instruction: 'Walk normally for 90 seconds while wearing the wristband.',
    simStd:      0.28,    // realistic walking std in g
  },
];

// Simulated window interval — matches real BLE window rate (15 s)
const SIM_WINDOW_INTERVAL_MS = 15_000;

export default function CalibrationScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  // phase: -1=intro  0=still  0.5=between  1=walk  2=done
  const [phase,      setPhase]      = useState(-1);
  const [countdown,  setCd]         = useState(0);
  const [results,    setResults]    = useState({});
  const [liveDevice, setLiveDevice] = useState(false);
  const [windowCount, setWindowCount] = useState(0);  // live feedback during phase

  const timerRef      = useRef(null);
  const simRef        = useRef(null);
  const samplesRef    = useRef([]);   // one ACC-std value per BLE window
  const phaseRef      = useRef(-1);
  const progressAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Check BLE connection on mount ─────────────────────────────────────────
  useEffect(() => {
    setLiveDevice(isConnected());
  }, []);

  // ── BLE window subscription ───────────────────────────────────────────────
  //
  // Each BLE window is 1920 samples @ 64 Hz = 30 s of data.
  // We compute the std of ACC magnitudes across that window — the same
  // quantity that accGate() computes at runtime — and push it to samplesRef.
  // One value per window, not per sample.
  //
  useEffect(() => {
    setCalibrationCallback((window) => {
      // Guard: only collect during active phases
      if (phaseRef.current !== 0 && phaseRef.current !== 1) return;

      const mags = window.map(s =>
        Math.sqrt((s.acc_x || 0) ** 2 + (s.acc_y || 0) ** 2 + (s.acc_z || 0) ** 2)
      );
      const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
      const std  = Math.sqrt(
        mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length
      );

      samplesRef.current.push(std);
      setWindowCount(samplesRef.current.length);
      console.log(
        `[Calibration] phase=${phaseRef.current === 0 ? 'still' : 'walk'}` +
        `  window std=${std.toFixed(5)} g` +
        `  total=${samplesRef.current.length} windows`
      );
    });

    return () => setCalibrationCallback(null);
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => {
    _clearPhaseTimers();
    setCalibrationCallback(null);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  function _clearPhaseTimers() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (simRef.current)   { clearInterval(simRef.current);   simRef.current   = null; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  function startPhase(idx) {
    setPhase(idx);
    phaseRef.current  = idx;
    samplesRef.current = [];
    setWindowCount(0);

    const dur = PHASES[idx].duration;
    setCd(dur);
    progressAnim.setValue(0);

    Animated.timing(progressAnim, {
      toValue:         1,
      duration:        dur * 1000,
      useNativeDriver: false,
    }).start();

    // ── Simulation path (no device connected) ──────────────────────────────
    // Pushes one simulated std value every 15 s, matching the real BLE window
    // rate. Values include slight random noise around the expected still/walk
    // std so the mean/std of stds is realistic.
    if (!isConnected()) {
      const baseStd = PHASES[idx].simStd;
      simRef.current = setInterval(() => {
        if (phaseRef.current !== 0 && phaseRef.current !== 1) return;
        const jitter = (Math.random() - 0.5) * baseStd * 0.3;
        const simVal = Math.max(0, baseStd + jitter);
        samplesRef.current.push(simVal);
        setWindowCount(samplesRef.current.length);
        console.log(
          `[Calibration] SIM phase=${idx === 0 ? 'still' : 'walk'}` +
          `  std=${simVal.toFixed(5)} g  total=${samplesRef.current.length}`
        );
      }, SIM_WINDOW_INTERVAL_MS);
    }

    // ── Countdown ticker ──────────────────────────────────────────────────
    timerRef.current = setInterval(() => {
      setCd(prev => {
        if (prev <= 1) {
          _clearPhaseTimers();
          finishPhase(idx);
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  function finishPhase(idx) {
    const stds = samplesRef.current;

    if (stds.length === 0) {
      Alert.alert(
        'No data collected',
        'No ACC window data arrived during this phase.\n\n' +
        'Make sure your wristband is connected and streaming. ' +
        'At least one 30-second BLE window must complete before data arrives.',
        [{ text: 'Retry', onPress: () => setPhase(idx === 0 ? -1 : 0.5) }]
      );
      return;
    }

    // mean and std of the collected window-level std values
    const mean = stds.reduce((a, b) => a + b, 0) / stds.length;
    const std  = stds.length > 1
      ? Math.sqrt(stds.reduce((a, b) => a + (b - mean) ** 2, 0) / stds.length)
      : 0;

    console.log(
      `[Calibration] phase=${PHASES[idx].id} done` +
      `  n=${stds.length} windows` +
      `  mean_std=${mean.toFixed(5)} g  std_of_stds=${std.toFixed(5)} g`
    );

    setResults(prev => ({ ...prev, [PHASES[idx].id]: { mean, std, n: stds.length } }));
    progressAnim.setValue(0);

    setPhase(idx + 1 < PHASES.length ? idx + 0.5 : 2);
  }

  // ─────────────────────────────────────────────────────────────────────────
  async function saveAndFinish() {
    const still = results.still ?? { mean: 0.008, std: 0.002 };
    const walk  = results.walk  ?? { mean: 0.28,  std: 0.05  };

    // Threshold = midpoint between mean still-window-std and mean walk-window-std.
    // Both values are in the same unit as accGate()'s output (g std), so the
    // comparison is valid.
    const threshold = (still.mean + walk.mean) / 2;

    await saveCalibration({
      still_mean_std:  still.mean,
      still_std_of_std: still.std,
      still_n_windows: still.n,
      walk_mean_std:   walk.mean,
      walk_std_of_std: walk.std,
      walk_n_windows:  walk.n,
      threshold,
      calibrated_at:   new Date().toISOString(),
    });

    // Write acc_threshold into user prefs so MonitoringScreen picks it up
    // via loadUserPrefs() → prefsRef.current?.acc_threshold
    await saveUserPrefs({ acc_threshold: threshold });

    console.log(
      `[Calibration] Saved  still_mean_std=${still.mean.toFixed(5)}` +
      `  walk_mean_std=${walk.mean.toFixed(5)}` +
      `  threshold=${threshold.toFixed(5)} g`
    );

    Alert.alert(
      'Calibration complete ✓',
      `ACC gate threshold: ${threshold.toFixed(4)} g\n\n` +
      `Still: ${still.mean.toFixed(4)} g (${still.n} windows)\n` +
      `Walk:  ${walk.mean.toFixed(4)} g (${walk.n} windows)`,
      [{ text: 'OK', onPress: () => navigation.goBack() }]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  const barWidth = progressAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0%', '100%'],
  });

  const activePhaseIdx = phase === 0 || phase === 1 ? phase : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Calibration</Text>
      <Text style={styles.subtitle}>
        Two 90-second samples to set your personal movement threshold.
      </Text>

      {/* ── No-device warning ─────────────────────────────── */}
      {!liveDevice && (
        <View style={styles.warnBanner}>
          <Text style={styles.warnText}>
            ⚠ No wristband connected — calibration will use simulated data.
            Connect your NOOM-BAND in Setup for accurate results.
          </Text>
        </View>
      )}

      {/* ── Phase indicator cards ─────────────────────────── */}
      <View style={styles.phasesRow}>
        {PHASES.map((p, i) => {
          const done   = results[p.id] != null;
          const active = phase === i;
          return (
            <View
              key={p.id}
              style={[
                styles.phaseCard,
                active && styles.phaseCardActive,
                done   && styles.phaseCardDone,
              ]}
            >
              <Text style={[styles.phaseIcon, { color: p.color }]}>{done ? '✓' : p.icon}</Text>
              <Text style={styles.phaseLabel}>{p.label}</Text>
              <Text style={styles.phaseDur}>{p.duration}s</Text>
            </View>
          );
        })}
      </View>

      {/* ── Main content area ─────────────────────────────── */}
      <View style={styles.mainArea}>

        {/* Intro */}
        {phase === -1 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>Ready?</Text>
            <Text style={styles.instructionBody}>
              You'll complete two short tests so NOOM can tell the difference
              between sleep movement and waking movement.{'\n\n'}
              Each phase is 90 seconds. Stay still during the first, then walk
              normally during the second.
            </Text>
            <TouchableOpacity style={styles.startBtn} onPress={() => startPhase(0)}>
              <Text style={styles.startBtnText}>Start Calibration</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Active phase (still or walk) */}
        {activePhaseIdx !== null && (
          <View style={styles.centred}>
            <Text style={[styles.phaseTitle, { color: PHASES[activePhaseIdx].color }]}>
              {PHASES[activePhaseIdx].label}
            </Text>
            <Text style={styles.instructionBody}>
              {PHASES[activePhaseIdx].instruction}
            </Text>
            <Text style={styles.countdown}>{countdown}</Text>
            <View style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  { width: barWidth, backgroundColor: PHASES[activePhaseIdx].color },
                ]}
              />
            </View>
            <Text style={styles.sampleCount}>
              {windowCount} window{windowCount !== 1 ? 's' : ''} collected
            </Text>
          </View>
        )}

        {/* Between phases */}
        {phase === 0.5 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>Phase 1 done ✓</Text>
            <View style={styles.resultsCard}>
              <ResultRow
                label="Still mean std"
                value={results.still?.mean != null ? `${results.still.mean.toFixed(5)} g` : '—'}
              />
              <ResultRow
                label="σ of stds"
                value={results.still?.std != null ? `${results.still.std.toFixed(5)} g` : '—'}
              />
              <ResultRow
                label="Windows"
                value={String(results.still?.n ?? '—')}
              />
            </View>
            <Text style={styles.instructionBody}>
              Now stand up and walk normally for 90 seconds.
            </Text>
            <TouchableOpacity
              style={[styles.startBtn, { backgroundColor: colors.wake }]}
              onPress={() => startPhase(1)}
            >
              <Text style={styles.startBtnText}>Start Walking Phase</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Done */}
        {phase === 2 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>All done! 🎉</Text>
            <View style={styles.resultsCard}>
              <ResultRow
                label="Still mean std"
                value={results.still?.mean != null ? `${results.still.mean.toFixed(5)} g` : '—'}
              />
              <ResultRow
                label="Walk mean std"
                value={results.walk?.mean != null ? `${results.walk.mean.toFixed(5)} g` : '—'}
              />
              <ResultRow
                label="ACC gate τ"
                value={
                  results.still && results.walk
                    ? `${((results.still.mean + results.walk.mean) / 2).toFixed(5)} g`
                    : '—'
                }
                highlight
              />
            </View>
            <Text style={styles.instructionBody}>
              Threshold is the midpoint between your still and walking movement levels.
              The system uses this to skip model inference when you're clearly moving.
            </Text>
            <TouchableOpacity style={styles.startBtn} onPress={saveAndFinish}>
              <Text style={styles.startBtnText}>Save & Continue</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ResultRow({ label, value, highlight }) {
  return (
    <View style={styles.resultRow}>
      <Text style={styles.resultLabel}>{label}</Text>
      <Text style={[styles.resultValue, highlight && { color: colors.primary }]}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
  back:       { marginBottom: spacing.lg },
  backText:   { ...typography.body, color: colors.primary },
  title:      { ...typography.displayMed, marginBottom: spacing.sm },
  subtitle:   { ...typography.body, color: colors.textSub, marginBottom: spacing.lg },

  warnBanner: {
    backgroundColor: colors.warning + '20',
    borderRadius:    radius.md,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     colors.warning + '60',
    marginBottom:    spacing.md,
  },
  warnText: { ...typography.caption, color: colors.warning },

  phasesRow:       { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  phaseCard:       {
    flex:            1,
    backgroundColor: colors.card,
    borderRadius:    radius.lg,
    padding:         spacing.md,
    alignItems:      'center',
    borderWidth:     1,
    borderColor:     colors.border,
  },
  phaseCardActive: { borderColor: colors.primary },
  phaseCardDone:   { borderColor: colors.success },
  phaseIcon:       { fontSize: 28, marginBottom: spacing.xs },
  phaseLabel:      { ...typography.h3 },
  phaseDur:        { ...typography.caption },

  mainArea:         { flex: 1 },
  centred:          { flex: 1, alignItems: 'center', justifyContent: 'center' },
  instructionTitle: { ...typography.h1, marginBottom: spacing.md, textAlign: 'center' },
  instructionBody:  {
    ...typography.body,
    color:        colors.textSub,
    textAlign:    'center',
    marginBottom: spacing.xl,
    maxWidth:     320,
  },
  phaseTitle:   { fontSize: 36, fontWeight: '800', marginBottom: spacing.md },
  countdown:    { fontSize: 80, fontWeight: '800', color: colors.primary, letterSpacing: -3 },
  sampleCount:  { ...typography.caption, color: colors.textSub, marginTop: spacing.sm },
  progressTrack: {
    width:           '80%',
    height:          4,
    backgroundColor: colors.border,
    borderRadius:    2,
    overflow:        'hidden',
    marginTop:       spacing.lg,
  },
  progressFill: { height: '100%', borderRadius: 2 },

  startBtn:     {
    backgroundColor:  colors.primary,
    borderRadius:     radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical:  spacing.md,
    marginTop:        spacing.xl,
  },
  startBtnText: { ...typography.h3, color: colors.bg, fontWeight: '700' },

  resultsCard: {
    backgroundColor: colors.card,
    borderRadius:    radius.lg,
    padding:         spacing.lg,
    width:           '90%',
    marginBottom:    spacing.md,
    borderWidth:     1,
    borderColor:     colors.border,
  },
  resultRow:   {
    flexDirection:  'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  resultLabel: { ...typography.body, color: colors.textSub },
  resultValue: { ...typography.h3 },
});