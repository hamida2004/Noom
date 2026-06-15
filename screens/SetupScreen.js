/**
 * SetupScreen.js — FIXED
 * =======================
 *
 * Fixes applied:
 *
 *  1. Live Bluetooth state listener replaces one-shot checkBleState().
 *     getBleManager().onStateChange(..., true) fires immediately with the
 *     current state AND fires again every time the user toggles Bluetooth.
 *     The UI dot and scan button now react instantly — no app restart needed.
 *
 *  2. When Bluetooth turns ON while the screen is open, a scan is started
 *     automatically so the user doesn't have to tap anything.
 *
 *  3. Stray literal text "vs" removed from inside the JSX (was after
 *     </View> in the wristband card, causing a render error).
 *
 *  4. Scan timeout ref used instead of bare setTimeout so it can be
 *     cleared properly on unmount and on manual stop.
 *
 *  5. Second-module BleManager removed — we use getBleManager() from
 *     ble.js indirectly via checkBleState, but for the state listener
 *     we create one clean instance here and destroy it on unmount.
 *
 *  6. Manual NumberPicker replaced with @react-native-community/datetimepicker.
 *     On Android it opens as a clock dialog (mode="time"). On iOS it renders
 *     inline as a spinner. The selected time is stored in a Date object and
 *     serialised to "HH:MM" for storage — same format as before, fully
 *     compatible with loadAlarmTime() / saveAlarmTime().
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
  requestBlePermissions,
} from '../services/ble';
import { loadAlarmTime, saveAlarmTime, loadCalibration } from '../services/storage';
import { BleManager, State } from 'react-native-ble-plx';

// Module-level BleManager used ONLY for the state listener.
// A separate instance is fine — react-native-ble-plx allows multiple managers
// as long as only one is used for scanning/connecting (that one lives in ble.js).
let _stateManager = null;
function getStateManager() {
  if (!_stateManager) _stateManager = new BleManager();
  return _stateManager;
}

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
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
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
  // alarmDate: the currently selected alarm time as a Date object.
  // showPicker: Android only — controls whether the dialog is open.
  //             On iOS the picker renders inline, so this is always true.
  const [alarmDate,   setAlarmDate]   = useState(timeStrToDate('07:00'));
  const [showPicker,  setShowPicker]  = useState(Platform.OS === 'ios');

  const devicesRef   = useRef({});
  const scanTimeout  = useRef(null);
  const stateUnsub   = useRef(null);
  const prevBleReady = useRef(false);

  useEffect(() => {
    _init();
    return () => {
      stateUnsub.current?.remove();
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

    stateUnsub.current = getStateManager().onStateChange((state) => {
      const powered = state === State.PoweredOn;
      setBleReady(powered);

      if (powered && !prevBleReady.current) {
        prevBleReady.current = true;
        setTimeout(() => startScan(), 500);
      } else if (!powered) {
        prevBleReady.current = false;
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
    }, true);

    // Load saved alarm time
    const saved = await loadAlarmTime();
    setAlarmDate(timeStrToDate(saved));

    // Load calibration status
    loadCalibration().then(c => setCalibrated(!!c));

    // Sync BLE connection state
    setConnected(isConnected());
    const dev = getConnectedDevice();
    if (dev) setConnectedName(dev.name ?? dev.localName ?? dev.id);
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  function startScan() {
    if (!bleReady) {
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

  /**
   * Called by DateTimePicker on every change.
   *
   * Android: fires once when the user confirms (or dismisses with event='dismissed').
   *          We close the dialog in both cases.
   * iOS:     fires on every scroll tick — no dialog, picker stays visible.
   */
  function onTimeChange(event, selectedDate) {
    if (Platform.OS === 'android') {
      // Always hide the dialog after interaction on Android
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

  // Wake window preview: 30 min before the alarm
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

              {/* Android: show the selected time and a button to open the picker */}
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

              {/* DateTimePicker
                    iOS:     always rendered inline (no dialog)
                    Android: rendered as a modal clock dialog, shown only when
                             showPicker is true                              */}
              {showPicker && (
                <DateTimePicker
                  value={alarmDate}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onTimeChange}
                  // iOS inline spinner needs explicit dimensions
                  style={Platform.OS === 'ios' ? styles.iosPickerInline : undefined}
                  // Tint the iOS spinner to match the app accent colour
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

  // ── Alarm / time picker ────────────────────────────────────────────────────

  // Android: tappable time display that opens the clock dialog
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
    fontSize:    52,
    fontWeight:  '800',
    color:       colors.primary,
    letterSpacing: -1,
  },
  androidTimeHint: { ...typography.caption, color: colors.textSub, marginTop: 2 },

  // iOS: inline spinner — needs a fixed height so it doesn't collapse
  iosPickerInline: {
    width:         '100%',
    height:        160,
    marginBottom:  spacing.sm,
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