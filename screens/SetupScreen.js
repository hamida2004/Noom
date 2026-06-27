/**
 * SetupScreen.js — FIXED (v2)
 * ============================
 *
 * All fixes from v1 retained, plus:
 *
 *  8. FIX: "Please enable Bluetooth first" alert firing even when BLE is ON.
 *
 *     Root cause: startScan() captured `bleReady` from the React state closure
 *     at the time the function was created. When subscribeToBleState() fired
 *     with PoweredOn, it called setBleReady(true) and then scheduled startScan()
 *     via setTimeout(). But startScan still held the old closure value
 *     (bleReady = false) from before the re-render, so the guard always failed.
 *
 *     Fix: a `bleReadyRef` ref is kept in sync with the `bleReady` state.
 *     startScan() and stopScanning() now read from bleReadyRef.current, which
 *     is always the live value regardless of when the function was captured.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  FlatList, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, spacing, radius, typography } from '../theme';
import {
  scanForDevices, stopScan,
  connectToDevice, disconnectDevice, isConnected, getConnectedDevice,
  requestBlePermissions, subscribeToBleState,
} from '../services/ble';
import { loadAlarmTime, saveAlarmTime, loadCalibration } from '../services/storage';
import { State } from 'react-native-ble-plx';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse "HH:MM" string into a Date object (today's date, at that time). */
function timeStrToDate(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/** Serialise a Date to "HH:MM" string for storage. */
function dateToTimeStr(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':');
}

/** Format a Date for the wake-window preview label. */
function fmtTime(date) {
  return [
    String(date.getHours()).padStart(2, '00'),
    String(date.getMinutes()).padStart(2, '00'),
  ].join(':');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SetupScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const [bleReady, setBleReady]           = useState(false);
  const [scanning, setScanning]           = useState(false);
  const [devices, setDevices]             = useState([]);
  const [connecting, setConnecting]       = useState(null);
  const [connected, setConnected]         = useState(false);
  const [connectedName, setConnectedName] = useState('');
  const [calibrated, setCalibrated]       = useState(false);

  // ── Alarm time state ───────────────────────────────────────────────────────
  const [alarmDate,  setAlarmDate]  = useState(timeStrToDate('07:00'));
  const [showPicker, setShowPicker] = useState(Platform.OS === 'ios');

  const devicesRef  = useRef({});
  const scanTimeout = useRef(null);
  const stateUnsub  = useRef(null);
  const hasBeenReady = useRef(false);

  // ── FIX #8: ref that always mirrors the live bleReady state ───────────────
  // React state updates are async; functions that capture `bleReady` from the
  // closure can read a stale value. bleReadyRef.current is synchronously set
  // alongside every setBleReady() call, so it is always current.
  const bleReadyRef = useRef(false);

  useEffect(() => {
    _init();
    return () => {
      stateUnsub.current?.();
      stopScan();
      clearTimeout(scanTimeout.current);
    };
  }, []);

  async function _init() {
    const ok = await requestBlePermissions();
    if (!ok) {
      Alert.alert(
        'Permissions required',
        'Bluetooth permissions are required. Go to Settings → Apps → NOOM → Permissions.',
      );
    }

    stateUnsub.current = subscribeToBleState((state) => {
      const powered = state === State.PoweredOn;

      // Always update both state (for UI) AND ref (for logic functions).
      setBleReady(powered);
      bleReadyRef.current = powered;  // ← FIX #8

      if (powered) {
        if (!hasBeenReady.current) {
          hasBeenReady.current = true;
          setTimeout(() => startScan(), 500);
        } else {
          setTimeout(() => startScan(), 500);
        }
      } else {
        if (hasBeenReady.current) {
          stopScan();
          setScanning(false);
          clearTimeout(scanTimeout.current);
          if (Platform.OS === 'android') {
            Alert.alert(
              'Bluetooth turned off',
              'Please enable Bluetooth to connect your NOOM wristband.',
            );
          }
        }
        hasBeenReady.current = false;
      }
    });

    const saved = await loadAlarmTime();
    setAlarmDate(timeStrToDate(saved));

    loadCalibration().then(c => setCalibrated(!!c));

    setConnected(isConnected());
    const dev = getConnectedDevice();
    if (dev) setConnectedName(dev.name ?? dev.localName ?? dev.id);
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  function startScan() {
    // FIX #8: read from ref, not from the `bleReady` state closure.
    if (!bleReadyRef.current) {
      Alert.alert('Bluetooth off', 'Please enable Bluetooth first.');
      return;
    }
    devicesRef.current = {};
    setDevices([]);
    setScanning(true);

    scanForDevices(
      (device) => {
        if (!devicesRef.current[device.id]) {
          devicesRef.current[device.id] = device;
          setDevices(Object.values(devicesRef.current));
        }
      },
      (err) => {
        setScanning(false);
        Alert.alert('Scan error', err.message);
      },
    );

    scanTimeout.current = setTimeout(() => {
      stopScan();
      setScanning(false);
    }, 15_000);
  }

  function stopScanning() {
    stopScan();
    clearTimeout(scanTimeout.current);
    setScanning(false);
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async function connect(device) {
    stopScanning();
    setConnecting(device.id);
    try {
      await connectToDevice(
        device,
        null,
        (_status, dev) => {
          setConnected(true);
          setConnectedName(dev?.name ?? dev?.localName ?? device.displayName ?? device.id);
          setConnecting(null);
        },
        () => {
          setConnected(false);
          setConnectedName('');
        },
      );
    } catch (e) {
      setConnecting(null);
      Alert.alert('Connection failed', e.message);
    }
  }

  async function disconnect() {
    await disconnectDevice();
    setConnected(false);
    setConnectedName('');
  }

  // ── Alarm time ────────────────────────────────────────────────────────────

  function onTimeChange(event, selectedDate) {
    if (Platform.OS === 'android') {
      setShowPicker(false);
      if (event.type === 'dismissed' || !selectedDate) return;
    }
    setAlarmDate(selectedDate ?? alarmDate);
  }

  function saveAlarm() {
    const timeStr = dateToTimeStr(alarmDate);
    saveAlarmTime(timeStr);
    Alert.alert('Alarm saved', `Wake-up alarm set for ${timeStr}`);
  }

  const wakeWindowStart = new Date(alarmDate.getTime() - 30 * 60 * 1000);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.screenTitle}>Setup</Text>

      <FlatList
        data={[]}
        renderItem={null}
        keyExtractor={() => ''}
        ListHeaderComponent={() => (
          <View style={styles.content}>

            {/* ── Wristband ──────────────────────────────── */}
            <SectionHeader title="WRISTBAND" />
            <View style={styles.card}>
              {connected ? (
                <View style={styles.connectedRow}>
                  <View style={styles.connectedDot} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.connectedLabel}>Connected</Text>
                    <Text style={styles.connectedName}>{connectedName}</Text>
                  </View>
                  <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
                    <Text style={styles.disconnectText}>Disconnect</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <View style={styles.bleStatusRow}>
                    <View style={[
                      styles.bleDot,
                      { backgroundColor: bleReady ? colors.success : colors.danger },
                    ]} />
                    <Text style={styles.bleStatus}>
                      Bluetooth {bleReady ? 'ready' : 'off'}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryBtn, !bleReady && styles.btnDisabled]}
                    onPress={scanning ? stopScanning : startScan}
                    disabled={!bleReady}
                  >
                    {scanning ? (
                      <>
                        <ActivityIndicator color={colors.bg} style={{ marginRight: 8 }} />
                        <Text style={styles.primaryBtnText}>Scanning… Tap to stop</Text>
                      </>
                    ) : (
                      <Text style={styles.primaryBtnText}>Scan for Wristband</Text>
                    )}
                  </TouchableOpacity>

                  {devices.length > 0 && (
                    <View style={styles.deviceList}>
                      <Text style={styles.deviceListLabel}>FOUND DEVICES</Text>
                      {devices.map(d => (
                        <TouchableOpacity
                          key={d.id}
                          style={[
                            styles.deviceItem,
                            connecting === d.id && styles.deviceItemConnecting,
                          ]}
                          onPress={() => connect(d)}
                          disabled={!!connecting}
                        >
                          <View>
                            <Text style={styles.deviceName}>
                              {d.displayName || d.name || d.localName || 'Unknown Device'}
                            </Text>
                            <Text style={styles.deviceId}>{d.id.slice(0, 17)}…</Text>
                          </View>
                          {connecting === d.id
                            ? <ActivityIndicator color={colors.primary} size="small" />
                            : <Text style={styles.connectArrow}>›</Text>
                          }
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>

            {/* ── Calibration ────────────────────────────── */}
            <SectionHeader title="CALIBRATION" />
            <View style={styles.card}>
              <View style={styles.calibRow}>
                <View style={[styles.calibStatus, {
                  backgroundColor: calibrated ? colors.success + '20' : colors.warning + '20',
                  borderColor:     calibrated ? colors.success        : colors.warning,
                }]}>
                  <Text style={{ color: calibrated ? colors.success : colors.warning, fontWeight: '700' }}>
                    {calibrated ? '✓ Calibrated' : '⚠ Not calibrated'}
                  </Text>
                </View>
              </View>
              <Text style={styles.calibNote}>
                Calibration sets your personal ACC gate threshold so the app
                can distinguish stillness from movement.
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, !connected && styles.btnDisabled]}
                onPress={() => navigation.navigate('Calibration')}
                disabled={!connected}
              >
                <Text style={styles.primaryBtnText}>
                  {calibrated ? 'Re-calibrate' : 'Run Calibration'}
                </Text>
              </TouchableOpacity>
              {!connected && (
                <Text style={styles.requiresConnection}>Requires wristband connection</Text>
              )}
            </View>

            {/* ── Alarm Time ─────────────────────────────── */}
            <SectionHeader title="ALARM TIME" />
            <View style={styles.card}>

              {Platform.OS === 'android' && (
                <TouchableOpacity
                  style={styles.androidTimeDisplay}
                  onPress={() => setShowPicker(true)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.androidTimeValue}>{dateToTimeStr(alarmDate)}</Text>
                  <Text style={styles.androidTimeHint}>Tap to change</Text>
                </TouchableOpacity>
              )}

              {showPicker && (
                <DateTimePicker
                  value={alarmDate}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onTimeChange}
                  style={Platform.OS === 'ios' ? styles.iosPickerInline : undefined}
                  accentColor={colors.primary}
                  textColor={colors.text}
                />
              )}

              <Text style={styles.alarmPreview}>
                Wake window: {fmtTime(wakeWindowStart)} – {fmtTime(alarmDate)}
              </Text>

              <TouchableOpacity style={styles.primaryBtn} onPress={saveAlarm}>
                <Text style={styles.primaryBtnText}>Save Alarm Time</Text>
              </TouchableOpacity>
            </View>

          </View>
        )}
      />
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: colors.bg },
  content:      { padding: spacing.lg, paddingBottom: spacing.xxl },
  screenTitle:  { ...typography.h1, padding: spacing.lg, paddingBottom: 0 },
  sectionHeader:{ ...typography.label, marginTop: spacing.lg, marginBottom: spacing.sm },
  card:         {
    backgroundColor: colors.card,
    borderRadius:    radius.lg,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     colors.border,
    marginBottom:    spacing.sm,
  },

  bleStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  bleDot:       { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  bleStatus:    { ...typography.body },

  deviceList:           { marginTop: spacing.md },
  deviceListLabel:      { ...typography.label, marginBottom: spacing.sm },
  deviceItem:           {
    backgroundColor: colors.surface,
    borderRadius:    radius.md,
    padding:         spacing.md,
    marginBottom:    spacing.sm,
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    borderWidth:     1,
    borderColor:     colors.border,
  },
  deviceItemConnecting: { borderColor: colors.primary },
  deviceName:           { ...typography.h3 },
  deviceId:             { ...typography.caption },
  connectArrow:         { fontSize: 22, color: colors.textSub, fontWeight: '300' },

  connectedRow:   { flexDirection: 'row', alignItems: 'center' },
  connectedDot:   { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, marginRight: spacing.sm },
  connectedLabel: { ...typography.caption, color: colors.success },
  connectedName:  { ...typography.h3 },
  disconnectBtn:  {
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       colors.danger + '60',
  },
  disconnectText: { ...typography.caption, color: colors.danger },

  requiresConnection: { ...typography.caption, color: colors.textSub, marginTop: spacing.sm, textAlign: 'center' },
  calibRow:     { marginBottom: spacing.sm },
  calibStatus:  {
    alignSelf:         'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.xs,
    borderRadius:      radius.full,
    borderWidth:       1,
  },
  calibNote:    { ...typography.body, color: colors.textSub, marginVertical: spacing.sm, fontSize: 13 },

  androidTimeDisplay: {
    alignItems:      'center',
    paddingVertical: spacing.md,
    marginBottom:    spacing.sm,
    borderRadius:    radius.md,
    backgroundColor: colors.surface,
    borderWidth:     1,
    borderColor:     colors.border,
  },
  androidTimeValue: {
    fontSize:      52,
    fontWeight:    '800',
    color:         colors.primary,
    letterSpacing: -1,
  },
  androidTimeHint: { ...typography.caption, color: colors.textSub, marginTop: 2 },

  iosPickerInline: {
    width:        '100%',
    height:       160,
    marginBottom: spacing.sm,
  },

  alarmPreview: { ...typography.caption, textAlign: 'center', marginBottom: spacing.md, color: colors.textSub },

  primaryBtn:     {
    backgroundColor: colors.primary,
    borderRadius:    radius.full,
    paddingVertical: spacing.md,
    alignItems:      'center',
    flexDirection:   'row',
    justifyContent:  'center',
  },
  primaryBtnText: { ...typography.h3, color: colors.bg, fontWeight: '700' },
  btnDisabled:    { backgroundColor: colors.border, opacity: 0.5 },
});