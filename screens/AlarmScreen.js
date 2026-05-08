import React, { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, typography } from '../theme';
import { argmax } from '../services/alarmEngine';

export default function AlarmScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { action, probs = [0.33,0.33,0.34], sessionId, minutesEarly } = route.params ?? {};

  const isForced   = action === 'FORCE_WAKE';
  const stageIdx   = argmax(probs);
  const stageNames = ['Wake', 'Light Sleep', 'Deep Sleep'];
  const stageColors= [colors.wake, colors.ndeep, colors.deep];

  // Radial pulse animation
  const scale1 = useRef(new Animated.Value(1)).current;
  const scale2 = useRef(new Animated.Value(1)).current;
  const opacity1= useRef(new Animated.Value(0.5)).current;
  const opacity2= useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const loop1 = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale1,   { toValue: 2.4, duration: 1500, useNativeDriver: true }),
          Animated.timing(opacity1, { toValue: 0,   duration: 1500, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale1,   { toValue: 1,   duration: 0,    useNativeDriver: true }),
          Animated.timing(opacity1, { toValue: 0.5, duration: 0,    useNativeDriver: true }),
        ]),
      ])
    );
    const loop2 = Animated.loop(
      Animated.sequence([
        Animated.delay(750),
        Animated.parallel([
          Animated.timing(scale2,   { toValue: 2.4, duration: 1500, useNativeDriver: true }),
          Animated.timing(opacity2, { toValue: 0,   duration: 1500, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale2,   { toValue: 1,   duration: 0,    useNativeDriver: true }),
          Animated.timing(opacity2, { toValue: 0.3, duration: 0,    useNativeDriver: true }),
        ]),
      ])
    );
    loop1.start();
    loop2.start();
    return () => { loop1.stop(); loop2.stop(); };
  }, []);

  function dismiss() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.replace('Feedback', { sessionId, minutesEarly, stageIdx });
  }

  const ringColor = isForced ? colors.danger : colors.primary;
  const bgColor   = isForced ? colors.danger + '08' : colors.primary + '06';

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: bgColor }]}>

      {/* ── Pulsing rings ──────────────────────────────────── */}
      <View style={styles.orbWrapper}>
        <Animated.View style={[styles.ring, { borderColor: ringColor, transform: [{ scale: scale1 }], opacity: opacity1 }]} />
        <Animated.View style={[styles.ring, { borderColor: ringColor, transform: [{ scale: scale2 }], opacity: opacity2 }]} />
        <View style={[styles.orbCore, { borderColor: ringColor + '80', backgroundColor: ringColor + '15' }]}>
          <Text style={styles.orbEmoji}>{isForced ? '⏰' : '🌅'}</Text>
        </View>
      </View>

      {/* ── Text ──────────────────────────────────────────── */}
      <Text style={[styles.mainTitle, { color: ringColor }]}>
        {isForced ? 'Time to wake up' : 'Perfect moment to wake'}
      </Text>

      <Text style={styles.subtitle}>
        {isForced
          ? 'Alarm deadline reached.'
          : `You're in ${stageNames[stageIdx].toLowerCase()} — ideal for waking.`}
      </Text>

      {minutesEarly > 0 && !isForced && (
        <View style={styles.earlyBadge}>
          <Text style={styles.earlyText}>↑ {Math.round(minutesEarly)} min early</Text>
        </View>
      )}

      {/* ── Stage probs ───────────────────────────────────── */}
      <View style={styles.probsRow}>
        {['W','L','D'].map((l, i) => (
          <View key={l} style={[styles.probChip, i === stageIdx && styles.probChipActive, { borderColor: stageColors[i] + (i === stageIdx ? 'CC' : '30') }]}>
            <Text style={[styles.probChipLabel, { color: stageColors[i] }]}>{l}</Text>
            <Text style={[styles.probChipValue, i === stageIdx && { color: stageColors[i] }]}>
              {Math.round((probs[i] ?? 0)*100)}%
            </Text>
          </View>
        ))}
      </View>

      {/* ── Dismiss button ────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.dismissBtn, { backgroundColor: ringColor }]}
        onPress={dismiss}
        activeOpacity={0.85}
      >
        <Text style={styles.dismissText}>Dismiss</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>Rate your wake-up quality on the next screen</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  orbWrapper: { position: 'relative', width: 160, height: 160, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl },
  ring:       { position: 'absolute', width: 160, height: 160, borderRadius: 80, borderWidth: 1.5 },
  orbCore:    { width: 120, height: 120, borderRadius: 60, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  orbEmoji:   { fontSize: 48 },

  mainTitle:  { fontSize: 30, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center', marginBottom: spacing.sm },
  subtitle:   { ...typography.body, color: colors.textSub, textAlign: 'center', marginBottom: spacing.lg, maxWidth: 280 },

  earlyBadge: { backgroundColor: colors.success + '20', borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderWidth: 1, borderColor: colors.success + '40', marginBottom: spacing.lg },
  earlyText:  { ...typography.caption, color: colors.success },

  probsRow:   { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.xxl },
  probChip:   { alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, backgroundColor: colors.card, minWidth: 64 },
  probChipActive: { backgroundColor: colors.card },
  probChipLabel:  { ...typography.label, marginBottom: 2 },
  probChipValue:  { fontSize: 20, fontWeight: '700', color: colors.text },

  dismissBtn: { width: '80%', borderRadius: radius.full, paddingVertical: spacing.lg, alignItems: 'center', marginBottom: spacing.md },
  dismissText:{ fontSize: 18, fontWeight: '700', color: colors.bg },
  hint:       { ...typography.caption, textAlign: 'center' },
});