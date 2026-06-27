import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, typography } from '../theme';
import { saveRatingForSession } from '../services/storage';

const LABELS = [
  '',
  'Groggy — hard to wake up',
  'Tired — took effort',
  'OK — manageable',
  'Good — felt rested',
  'Great — energised!',
];

export default function FeedbackScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { sessionId, minutesEarly, stageIdx } = route.params ?? {};

  const [rating, setRating]   = useState(0);
  const [saved,  setSaved]    = useState(false);
  const starAnims             = useRef([...Array(5)].map(() => new Animated.Value(1))).current;
  const fadeAnim              = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  function selectRating(r) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRating(r);
    // Bounce animation for selected stars
    starAnims.forEach((anim, i) => {
      if (i < r) {
        Animated.sequence([
          Animated.timing(anim, { toValue: 1.3, duration: 80 + i*30, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1,   duration: 100,        useNativeDriver: true }),
        ]).start();
      }
    });
  }

  async function submit() {
    if (!rating) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (sessionId) {
      await saveRatingForSession(sessionId, rating);
    }
    setSaved(true);
    setTimeout(() => {
      // FIX: after rating, go straight into the PVT alertness check instead
      // of resetting to Main. This makes PVT a natural next step in the
      // wake-up flow rather than something that only ever appeared via a
      // notification tap ~60s later. We use navigate (not reset) so the
      // stack still has something underneath PVT — PVTScreen's own Skip
      // button (navigation.goBack()) and its "done" action (which already
      // resets to Main) both keep working unchanged.
      navigation.navigate('PVT', { mode: 'post_alarm' });
    }, 1500);
  }

  function skip() {
    navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
  }

  return (
    <Animated.View style={[styles.container, { paddingTop: insets.top, opacity: fadeAnim }]}>

      {saved ? (
        <View style={styles.savedView}>
          <Text style={styles.savedEmoji}>✓</Text>
          <Text style={styles.savedText}>Thanks! Saved.</Text>
        </View>
      ) : (
        <>
          <Text style={styles.question}>How did you feel{'\n'}when you woke up?</Text>

          {minutesEarly > 0 && (
            <Text style={styles.context}>
              You were woken {Math.round(minutesEarly)} minute{minutesEarly !== 1 ? 's' : ''} early
              during {['wake', 'light sleep', 'deep sleep'][stageIdx ?? 1]}.
            </Text>
          )}

          {/* ── Stars ─────────────────────────────────────── */}
          <View style={styles.starsRow}>
            {[1,2,3,4,5].map(i => (
              <TouchableOpacity key={i} onPress={() => selectRating(i)} activeOpacity={0.7}>
                <Animated.Text
                  style={[
                    styles.star,
                    { color: i <= rating ? colors.warning : colors.border,
                      transform: [{ scale: starAnims[i-1] }] },
                  ]}
                >
                  ★
                </Animated.Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Label ─────────────────────────────────────── */}
          <Text style={styles.ratingLabel}>
            {rating ? LABELS[rating] : 'Tap a star'}
          </Text>

          {/* ── Buttons ───────────────────────────────────── */}
          <TouchableOpacity
            style={[styles.submitBtn, !rating && styles.submitBtnDisabled]}
            onPress={submit}
            disabled={!rating}
            activeOpacity={0.85}
          >
            <Text style={styles.submitText}>Save Rating</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.skipBtn} onPress={skip}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  question:     { fontSize: 30, fontWeight: '800', color: colors.text, textAlign: 'center', letterSpacing: -0.5, marginBottom: spacing.md },
  context:      { ...typography.body, color: colors.textSub, textAlign: 'center', marginBottom: spacing.xl, maxWidth: 260 },

  starsRow:     { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  star:         { fontSize: 52 },

  ratingLabel:  { ...typography.h3, color: colors.textSub, textAlign: 'center', minHeight: 24, marginBottom: spacing.xl },

  submitBtn:     { width: '80%', backgroundColor: colors.primary, borderRadius: radius.full, paddingVertical: spacing.lg, alignItems: 'center', marginBottom: spacing.md },
  submitBtnDisabled: { backgroundColor: colors.border, opacity: 0.5 },
  submitText:    { ...typography.h3, fontWeight: '700', color: colors.bg },

  skipBtn:   { paddingVertical: spacing.sm },
  skipText:  { ...typography.body, color: colors.textSub },

  savedView:  { alignItems: 'center' },
  savedEmoji: { fontSize: 64, color: colors.success, marginBottom: spacing.md },
  savedText:  { ...typography.h1, color: colors.success },
});