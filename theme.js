export const colors = {
  // Backgrounds
  bg:       '#050A14',
  surface:  '#0C1628',
  card:     '#101F38',
  cardAlt:  '#0E1A30',
  border:   '#1C2E4A',

  // Brand
  primary:  '#00D9C0',   // teal – NDeep/sleep indicator
  primaryDim:'#00D9C020',
  accent:   '#6C63FF',   // purple
  accentDim:'#6C63FF20',

  // Sleep stage colours
  wake:     '#FF8C42',
  ndeep:    '#00D9C0',
  deep:     '#4A90E2',
  unknown:  '#3A4A66',

  // Semantic
  success:  '#34D399',
  warning:  '#FBBF24',
  danger:   '#F87171',

  // Text
  text:     '#E4EDF8',
  textSub:  '#6B7FA3',
  textDim:  '#3A4A66',

  // Alarm states
  alarmWake:  '#FF8C42',
  alarmForce: '#F87171',
  alarmWait:  '#6C63FF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  full: 999,
};

export const typography = {
  // Use system font weights – looks clean on both iOS/Android
  displayLarge: { fontSize: 48, fontWeight: '800', letterSpacing: -1.5, color: colors.text },
  displayMed:   { fontSize: 32, fontWeight: '700', letterSpacing: -0.8, color: colors.text },
  h1:           { fontSize: 24, fontWeight: '700', letterSpacing: -0.4, color: colors.text },
  h2:           { fontSize: 20, fontWeight: '600', letterSpacing: -0.2, color: colors.text },
  h3:           { fontSize: 16, fontWeight: '600', color: colors.text },
  body:         { fontSize: 15, fontWeight: '400', color: colors.text, lineHeight: 22 },
  caption:      { fontSize: 12, fontWeight: '500', color: colors.textSub, letterSpacing: 0.4 },
  label:        { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: colors.textSub },
};

export default { colors, spacing, radius, typography };