import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  TouchableOpacity, RefreshControl, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, radius, typography } from '../theme';
import { loadLastSession, loadRecentRatings, loadAlarmTime } from '../services/storage';

const { width: SCREEN_W } = Dimensions.get('window');
const CHART_W = SCREEN_W - spacing.lg * 2;

// ─── Stage colour map ─────────────────────────────────────────────────────────
const STAGE_COLORS = {
  0: colors.wake,   // Wake
  1: colors.ndeep,  // NDeep
  2: colors.deep,   // Deep
};
const STAGE_LABELS = { 0: 'W', 1: 'L', 2: 'D' };

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [lastSession, setLastSession]   = useState(null);
  const [ratings, setRatings]           = useState([]);
  const [alarmTime, setAlarmTime]       = useState('07:00');
  const [refreshing, setRefreshing]     = useState(false);

  const loadData = useCallback(async () => {
    const [session, recentRatings, time] = await Promise.all([
      loadLastSession(),
      loadRecentRatings(7),
      loadAlarmTime(),
    ]);
    setLastSession(session);
    setRatings(recentRatings);
    setAlarmTime(time);
  }, []);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const avgRating = ratings.length > 0
    ? (ratings.reduce((a, r) => a + r.rating, 0) / ratings.length).toFixed(1)
    : null;

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>{getGreeting()}</Text>
          <Text style={styles.title}>NOOM</Text>
        </View>
        <View style={styles.alarmBadge}>
          <Text style={styles.alarmBadgeLabel}>ALARM</Text>
          <Text style={styles.alarmBadgeTime}>{alarmTime}</Text>
        </View>
      </View>

      {/* ── Last night card ──────────────────────────────────────────── */}
      {lastSession ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LAST NIGHT</Text>
          <View style={styles.ratingRow}>
            <StarDisplay rating={lastSession.rating} />
            {lastSession.minutes_early != null && (
              <Text style={styles.minutesEarly}>
                {lastSession.minutes_early > 0
                  ? `↑ ${lastSession.minutes_early}m early`
                  : 'On time'}
              </Text>
            )}
          </View>
          <Text style={styles.sessionDate}>
            {formatDate(lastSession.date)}
          </Text>

          {/* Sleep stage timeline */}
          {lastSession.predictions?.length > 0 && (
            <SleepTimeline predictions={lastSession.predictions} />
          )}
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>◐</Text>
          <Text style={styles.emptyTitle}>No sleep data yet</Text>
          <Text style={styles.emptyBody}>Set your alarm in Setup, then start monitoring before bed.</Text>
          <TouchableOpacity
            style={styles.setupBtn}
            onPress={() => navigation.navigate('Setup')}
          >
            <Text style={styles.setupBtnText}>Go to Setup →</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 7-day trend ─────────────────────────────────────────────── */}
      {ratings.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>7-DAY TREND</Text>
          <View style={styles.trendRow}>
            <Text style={styles.avgRating}>{avgRating}</Text>
            <Text style={styles.avgLabel}>avg score</Text>
          </View>
          <RatingBars ratings={ratings} />
        </View>
      )}

      {/* ── Quick actions ────────────────────────────────────────────── */}
      <View style={styles.actionsRow}>
        <ActionCard
          icon="◐"
          label="Start Sleep"
          color={colors.primary}
          onPress={() => navigation.navigate('Sleep')}
        />
        <ActionCard
          icon="◈"
          label="Setup"
          color={colors.accent}
          onPress={() => navigation.navigate('Setup')}
        />
      </View>
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SleepTimeline({ predictions }) {
  const W = CHART_W - spacing.md * 2;
  const H = 32;
  const barW = Math.max(1, W / predictions.length);

  return (
    <View style={styles.timeline}>
      <Text style={styles.timelineLabel}>SLEEP STAGES</Text>
      <View style={{ height: H, flexDirection: 'row', borderRadius: radius.sm, overflow: 'hidden' }}>
        {predictions.map((p, i) => (
          <View
            key={i}
            style={{
              width: barW,
              height: H,
              backgroundColor: STAGE_COLORS[p.stage] ?? colors.unknown,
              opacity: 0.85,
            }}
          />
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
  );
}

function StarDisplay({ rating }) {
  if (!rating) return <Text style={styles.noRating}>Not rated</Text>;
  return (
    <View style={styles.starRow}>
      {[1,2,3,4,5].map(i => (
        <Text key={i} style={[styles.star, { color: i <= rating ? colors.warning : colors.border }]}>
          ★
        </Text>
      ))}
    </View>
  );
}

function RatingBars({ ratings }) {
  const maxRating = 5;
  return (
    <View style={styles.barsContainer}>
      {ratings.slice(0, 7).reverse().map((r, i) => (
        <View key={i} style={styles.barItem}>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, {
              height: `${(r.rating / maxRating) * 100}%`,
              backgroundColor: ratingColor(r.rating),
            }]} />
          </View>
          <Text style={styles.barDay}>{shortDay(r.date)}</Text>
        </View>
      ))}
    </View>
  );
}

function ActionCard({ icon, label, color, onPress }) {
  return (
    <TouchableOpacity style={[styles.actionCard, { borderColor: color + '40' }]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.actionIcon, { color }]}>{icon}</Text>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function shortDay(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2);
}

function ratingColor(r) {
  if (r >= 4) return colors.success;
  if (r >= 3) return colors.warning;
  return colors.danger;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg },
  content:    { padding: spacing.lg, paddingBottom: spacing.xxl },

  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: spacing.lg },
  greeting:   { ...typography.caption, marginBottom: 2 },
  title:      { ...typography.displayMed, color: colors.primary },
  alarmBadge: { alignItems: 'flex-end', backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border },
  alarmBadgeLabel: { ...typography.label, color: colors.textSub },
  alarmBadgeTime:  { ...typography.h2, color: colors.primary },

  card:       { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border },
  cardLabel:  { ...typography.label, marginBottom: spacing.sm },
  emptyCard:  { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.xl, marginBottom: spacing.md, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  emptyIcon:  { fontSize: 40, color: colors.textDim, marginBottom: spacing.md },
  emptyTitle: { ...typography.h2, marginBottom: spacing.sm },
  emptyBody:  { ...typography.body, color: colors.textSub, textAlign: 'center', marginBottom: spacing.lg },
  setupBtn:   { backgroundColor: colors.primary + '20', borderRadius: radius.full, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.primary + '60' },
  setupBtnText: { ...typography.h3, color: colors.primary },

  ratingRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  starRow:    { flexDirection: 'row' },
  star:       { fontSize: 22, marginRight: 2 },
  noRating:   { ...typography.body, color: colors.textSub },
  minutesEarly: { ...typography.caption, color: colors.success },
  sessionDate:  { ...typography.caption, marginBottom: spacing.md },

  timeline:      { marginTop: spacing.md },
  timelineLabel: { ...typography.label, marginBottom: spacing.sm },
  legendRow:     { flexDirection: 'row', marginTop: spacing.sm },
  legendItem:    { flexDirection: 'row', alignItems: 'center', marginRight: spacing.md },
  legendDot:     { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  legendText:    { ...typography.caption },

  trendRow:  { flexDirection: 'row', alignItems: 'baseline', marginBottom: spacing.md },
  avgRating: { fontSize: 40, fontWeight: '800', color: colors.primary, marginRight: spacing.sm },
  avgLabel:  { ...typography.caption },
  barsContainer: { flexDirection: 'row', justifyContent: 'space-between', height: 60, alignItems: 'flex-end' },
  barItem:   { flex: 1, alignItems: 'center', marginHorizontal: 2 },
  barTrack:  { flex: 1, width: '70%', backgroundColor: colors.surface, borderRadius: 4, justifyContent: 'flex-end', marginBottom: 4 },
  barFill:   { width: '100%', borderRadius: 4, minHeight: 4 },
  barDay:    { ...typography.caption, fontSize: 9 },

  actionsRow:  { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  actionCard:  { flex: 1, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, alignItems: 'center', borderWidth: 1 },
  actionIcon:  { fontSize: 28, marginBottom: spacing.sm },
  actionLabel: { ...typography.h3 },
});