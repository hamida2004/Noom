import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, typography } from '../theme';
import { saveCalibration } from '../services/storage';
import { accGate } from '../services/ble';

const PHASES = [
  { id: 'still', label: 'Lie Still', icon: '◎', color: colors.deep,  duration: 30, instruction: 'Place your wrist on the bed and lie completely still for 30 seconds.' },
  { id: 'walk',  label: 'Walk',      icon: '▶', color: colors.wake,  duration: 30, instruction: 'Walk normally for 30 seconds.' },
];

export default function CalibrationScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase]     = useState(-1); // -1=intro, 0=still, 1=walk, 2=done
  const [countdown, setCd]    = useState(0);
  const [results, setResults] = useState({});
  const timerRef              = useRef(null);
  const samplesRef            = useRef([]);
  const progressAnim          = useRef(new Animated.Value(0)).current;

  // In a real app, BLE data would stream here.
  // We simulate ACC magnitude readings for the demo.
  function collectSamples(phaseDuration) {
    samplesRef.current = [];
    const interval = setInterval(() => {
      // TODO: Replace with real ACC samples from BLE stream
      // For now, simulate: still ≈ 0.02, walk ≈ 0.4
      const base = phase === 0 ? 0.02 : 0.35;
      const mag  = base + (Math.random() - 0.5) * 0.05;
      samplesRef.current.push(mag);
    }, 100); // 10 Hz sample collection
    return interval;
  }

  function startPhase(idx) {
    setPhase(idx);
    const dur = PHASES[idx].duration;
    setCd(dur);

    Animated.timing(progressAnim, {
      toValue: 1,
      duration: dur * 1000,
      useNativeDriver: false,
    }).start();

    const sampleInterval = collectSamples(dur);

    timerRef.current = setInterval(() => {
      setCd(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          clearInterval(sampleInterval);
          finishPhase(idx);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function finishPhase(idx) {
    const mags  = samplesRef.current;
    const mean  = mags.reduce((a,b)=>a+b,0)/mags.length;
    const std   = Math.sqrt(mags.reduce((a,b)=>a+(b-mean)**2,0)/mags.length);

    setResults(prev => ({ ...prev, [PHASES[idx].id]: { mean, std } }));
    progressAnim.setValue(0);

    if (idx + 1 < PHASES.length) {
      setPhase(idx + 0.5); // show "next phase" prompt
    } else {
      setPhase(2); // done
    }
  }

  async function saveAndFinish() {
    const still = results.still ?? { mean: 0.05, std: 0.02 };
    const walk  = results.walk  ?? { mean: 0.40, std: 0.08 };
    const threshold = (still.mean + walk.mean) / 2;

    await saveCalibration({
      still_mean:   still.mean,
      still_std:    still.std,
      walk_mean:    walk.mean,
      walk_std:     walk.std,
      threshold,
      calibrated_at: new Date().toISOString(),
    });

    Alert.alert(
      'Calibration complete',
      `ACC gate threshold set to ${threshold.toFixed(3)}`,
      [{ text: 'OK', onPress: () => navigation.goBack() }]
    );
  }

  useEffect(() => () => { clearInterval(timerRef.current); }, []);

  const barWidth = progressAnim.interpolate({
    inputRange: [0, 1], outputRange: ['0%', '100%'],
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Calibration</Text>
      <Text style={styles.subtitle}>
        We need two 30-second samples to set your personal movement threshold.
      </Text>

      {/* ── Phase cards ─────────────────────────────────────── */}
      <View style={styles.phasesRow}>
        {PHASES.map((p, i) => {
          const done    = results[p.id] != null;
          const active  = phase === i;
          const waiting = phase < i || phase === i - 0.5;
          return (
            <View key={p.id} style={[styles.phaseCard, active && styles.phaseCardActive, done && styles.phaseCardDone]}>
              <Text style={[styles.phaseIcon, { color: p.color }]}>{done ? '✓' : p.icon}</Text>
              <Text style={styles.phaseLabel}>{p.label}</Text>
              <Text style={styles.phaseDur}>{p.duration}s</Text>
            </View>
          );
        })}
      </View>

      {/* ── Content area ─────────────────────────────────────── */}
      <View style={styles.mainArea}>
        {phase === -1 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>Ready?</Text>
            <Text style={styles.instructionBody}>
              You'll complete two short tests so NOOM can tell the difference between sleep movement and waking movement.
            </Text>
            <TouchableOpacity style={styles.startBtn} onPress={() => startPhase(0)}>
              <Text style={styles.startBtnText}>Start Calibration</Text>
            </TouchableOpacity>
          </View>
        )}

        {(phase === 0 || phase === 1) && (
          <View style={styles.centred}>
            <Text style={[styles.phaseTitle, { color: PHASES[phase].color }]}>
              {PHASES[phase].label}
            </Text>
            <Text style={styles.instructionBody}>{PHASES[phase].instruction}</Text>
            <Text style={styles.countdown}>{countdown}</Text>
            <View style={styles.progressTrack}>
              <Animated.View style={[styles.progressFill, { width: barWidth, backgroundColor: PHASES[phase].color }]} />
            </View>
          </View>
        )}

        {phase === 0.5 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>Phase 1 done ✓</Text>
            <Text style={styles.instructionBody}>
              Now get up and walk normally for 30 seconds.
            </Text>
            <TouchableOpacity style={[styles.startBtn, { backgroundColor: colors.wake }]} onPress={() => startPhase(1)}>
              <Text style={styles.startBtnText}>Start Walking Phase</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 2 && (
          <View style={styles.centred}>
            <Text style={styles.instructionTitle}>All done! 🎉</Text>
            <View style={styles.resultsCard}>
              <ResultRow label="Still threshold" value={results.still?.mean?.toFixed(3) ?? '—'} />
              <ResultRow label="Walk threshold"  value={results.walk?.mean?.toFixed(3)  ?? '—'} />
              <ResultRow
                label="ACC gate τ"
                value={results.still && results.walk
                  ? (((results.still.mean + results.walk.mean)/2).toFixed(3))
                  : '—'}
                highlight
              />
            </View>
            <TouchableOpacity style={styles.startBtn} onPress={saveAndFinish}>
              <Text style={styles.startBtnText}>Save & Continue</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

function ResultRow({ label, value, highlight }) {
  return (
    <View style={styles.resultRow}>
      <Text style={styles.resultLabel}>{label}</Text>
      <Text style={[styles.resultValue, highlight && { color: colors.primary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
  back:       { marginBottom: spacing.lg },
  backText:   { ...typography.body, color: colors.primary },
  title:      { ...typography.displayMed, marginBottom: spacing.sm },
  subtitle:   { ...typography.body, color: colors.textSub, marginBottom: spacing.lg },

  phasesRow:  { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  phaseCard:  { flex: 1, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  phaseCardActive: { borderColor: colors.primary },
  phaseCardDone:   { borderColor: colors.success },
  phaseIcon:  { fontSize: 28, marginBottom: spacing.xs },
  phaseLabel: { ...typography.h3 },
  phaseDur:   { ...typography.caption },

  mainArea:   { flex: 1 },
  centred:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  instructionTitle: { ...typography.h1, marginBottom: spacing.md, textAlign: 'center' },
  instructionBody:  { ...typography.body, color: colors.textSub, textAlign: 'center', marginBottom: spacing.xl, maxWidth: 300 },
  phaseTitle: { fontSize: 36, fontWeight: '800', marginBottom: spacing.md },
  countdown:  { fontSize: 80, fontWeight: '800', color: colors.primary, letterSpacing: -3 },
  progressTrack: { width: '80%', height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden', marginTop: spacing.lg },
  progressFill:  { height: '100%', borderRadius: 2 },

  startBtn:     { backgroundColor: colors.primary, borderRadius: radius.full, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, marginTop: spacing.xl },
  startBtnText: { ...typography.h3, color: colors.bg, fontWeight: '700' },

  resultsCard:  { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, width: '90%', marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border },
  resultRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm },
  resultLabel:  { ...typography.body, color: colors.textSub },
  resultValue:  { ...typography.h3 },
});