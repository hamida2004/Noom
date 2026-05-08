import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  FlatList, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, typography } from '../theme';
import {
  checkBleState, scanForDevices, stopScan,
  connectToDevice, disconnectDevice, isConnected, getConnectedDevice,
} from '../services/ble';
import { loadAlarmTime, saveAlarmTime, loadCalibration } from '../services/storage';
import { State } from 'react-native-ble-plx';

export default function SetupScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  // BLE
  const [bleReady, setBleReady]         = useState(false);
  const [scanning, setScanning]         = useState(false);
  const [devices, setDevices]           = useState([]);
  const [connecting, setConnecting]     = useState(null);
  const [connected, setConnected]       = useState(false);
  const [connectedName, setConnectedName] = useState('');

  // Alarm
  const [alarmHour, setAlarmHour]       = useState(7);
  const [alarmMinute, setAlarmMinute]   = useState(0);

  // Calibration
  const [calibrated, setCalibrated]     = useState(false);

  const devicesRef = useRef({});

  useEffect(() => {
    checkBleReady();
    loadAlarmTime().then(t => {
      const [h, m] = t.split(':').map(Number);
      setAlarmHour(h);
      setAlarmMinute(m);
    });
    loadCalibration().then(c => setCalibrated(!!c));

    return () => { stopScan(); };
  }, []);

  useEffect(() => {
    setConnected(isConnected());
    const dev = getConnectedDevice();
    if (dev) setConnectedName(dev.name ?? dev.id);
  }, []);

  async function checkBleReady() {
    const state = await checkBleState();
    setBleReady(state === State.PoweredOn);
    if (state !== State.PoweredOn && Platform.OS === 'android') {
      Alert.alert('Bluetooth', 'Please enable Bluetooth to connect your wristband.');
    }
  }

  function startScan() {
    if (!bleReady) { Alert.alert('Bluetooth off', 'Please enable Bluetooth first.'); return; }
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
      }
    );

    // Auto-stop after 15s
    setTimeout(() => {
      stopScan();
      setScanning(false);
    }, 15000);
  }

  async function connect(device) {
    stopScan();
    setScanning(false);
    setConnecting(device.id);
    try {
      await connectToDevice(
        device,
        null, // data handler set during monitoring
        (status, dev) => {
          setConnected(true);
          setConnectedName(dev?.name ?? device.name ?? device.id);
          setConnecting(null);
        },
        () => {
          setConnected(false);
          setConnectedName('');
        }
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

  function saveAlarm() {
    const timeStr = `${String(alarmHour).padStart(2,'0')}:${String(alarmMinute).padStart(2,'0')}`;
    saveAlarmTime(timeStr);
    Alert.alert('Alarm saved', `Wake-up alarm set for ${timeStr}`);
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.screenTitle}>Setup</Text>

      <FlatList
        data={[]}
        ListHeaderComponent={() => (
          <View style={styles.content}>

            {/* ── BLE Connection ───────────────────────────── */}
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
                    <View style={[styles.bleDot, { backgroundColor: bleReady ? colors.success : colors.danger }]} />
                    <Text style={styles.bleStatus}>
                      Bluetooth {bleReady ? 'ready' : 'off'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.primaryBtn, !bleReady && styles.btnDisabled]}
                    onPress={scanning ? () => { stopScan(); setScanning(false); } : startScan}
                    disabled={!bleReady}
                  >
                    {scanning
                      ? <><ActivityIndicator color={colors.bg} style={{ marginRight: 8 }} /><Text style={styles.primaryBtnText}>Scanning… Tap to stop</Text></>
                      : <Text style={styles.primaryBtnText}>Scan for E4 Wristband</Text>
                    }
                  </TouchableOpacity>
                  {devices.length > 0 && (
                    <View style={styles.deviceList}>
                      <Text style={styles.deviceListLabel}>FOUND DEVICES</Text>
                      {devices.map(d => (
                        <TouchableOpacity
                          key={d.id}
                          style={[styles.deviceItem, connecting === d.id && styles.deviceItemConnecting]}
                          onPress={() => connect(d)}
                          disabled={!!connecting}
                        >
                          <Text style={styles.deviceName}>{d.name ?? 'Unknown'}</Text>
                          <Text style={styles.deviceId}>{d.id.slice(0, 16)}…</Text>
                          {connecting === d.id && <ActivityIndicator color={colors.primary} size="small" />}
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>

            {/* ── Calibration ──────────────────────────────── */}
            <SectionHeader title="CALIBRATION" />
            <View style={styles.card}>
              <View style={styles.calibRow}>
                <View style={[styles.calibStatus, { backgroundColor: calibrated ? colors.success + '20' : colors.warning + '20', borderColor: calibrated ? colors.success : colors.warning }]}>
                  <Text style={{ color: calibrated ? colors.success : colors.warning, fontWeight: '700' }}>
                    {calibrated ? '✓ Calibrated' : '⚠ Not calibrated'}
                  </Text>
                </View>
              </View>
              <Text style={styles.calibNote}>
                Calibration sets your personal ACC gate threshold so the app can distinguish stillness from movement.
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

            {/* ── Alarm Time ────────────────────────────────── */}
            <SectionHeader title="ALARM TIME" />
            <View style={styles.card}>
              <View style={styles.timePicker}>
                <NumberPicker value={alarmHour} min={0} max={23} onChange={setAlarmHour} label="HH" />
                <Text style={styles.colon}>:</Text>
                <NumberPicker value={alarmMinute} min={0} max={59} step={5} onChange={setAlarmMinute} label="MM" />
              </View>
              <Text style={styles.alarmPreview}>
                Wake window: {`${String((alarmHour - 0 + 23) % 24).padStart(2,'0')}:${String(alarmMinute).padStart(2,'0')}`} – {`${String(alarmHour).padStart(2,'0')}:${String(alarmMinute).padStart(2,'0')}`}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={saveAlarm}>
                <Text style={styles.primaryBtnText}>Save Alarm Time</Text>
              </TouchableOpacity>
            </View>

          </View>
        )}
        renderItem={null}
        keyExtractor={() => ''}
      />
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function NumberPicker({ value, min, max, step = 1, onChange, label }) {
  const inc = () => onChange(Math.min(max, value + step));
  const dec = () => onChange(Math.max(min, value - step));

  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={inc}>
        <Text style={styles.pickerArrow}>▲</Text>
      </TouchableOpacity>
      <Text style={styles.pickerValue}>{String(value).padStart(2, '0')}</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={dec}>
        <Text style={styles.pickerArrow}>▼</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: colors.bg },
  content:     { padding: spacing.lg, paddingBottom: spacing.xxl },
  screenTitle: { ...typography.h1, padding: spacing.lg, paddingBottom: 0 },

  sectionHeader: { ...typography.label, marginTop: spacing.lg, marginBottom: spacing.sm },
  card:          { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },

  // BLE
  bleStatusRow:   { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  bleDot:         { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  bleStatus:      { ...typography.body },
  deviceList:     { marginTop: spacing.md },
  deviceListLabel:{ ...typography.label, marginBottom: spacing.sm },
  deviceItem:     { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border },
  deviceItemConnecting: { borderColor: colors.primary },
  deviceName:     { ...typography.h3 },
  deviceId:       { ...typography.caption },

  connectedRow:   { flexDirection: 'row', alignItems: 'center' },
  connectedDot:   { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, marginRight: spacing.sm },
  connectedLabel: { ...typography.caption, color: colors.success },
  connectedName:  { ...typography.h3 },
  disconnectBtn:  { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, borderWidth: 1, borderColor: colors.danger + '60' },
  disconnectText: { ...typography.caption, color: colors.danger },

  requiresConnection: { ...typography.caption, color: colors.textSub, marginTop: spacing.sm, textAlign: 'center' },

  // Calibration
  calibRow:   { marginBottom: spacing.sm },
  calibStatus:{ alignSelf: 'flex-start', paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.full, borderWidth: 1 },
  calibNote:  { ...typography.body, color: colors.textSub, marginVertical: spacing.sm, fontSize: 13 },

  // Alarm time picker
  timePicker:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  colon:       { fontSize: 40, fontWeight: '700', color: colors.primary, marginHorizontal: spacing.md },
  picker:      { alignItems: 'center' },
  pickerLabel: { ...typography.label, marginBottom: spacing.xs },
  pickerBtn:   { padding: spacing.sm },
  pickerArrow: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  pickerValue: { fontSize: 48, fontWeight: '800', color: colors.text, letterSpacing: -1 },
  alarmPreview:{ ...typography.caption, textAlign: 'center', marginBottom: spacing.md },

  // Buttons
  primaryBtn:     { backgroundColor: colors.primary, borderRadius: radius.full, paddingVertical: spacing.md, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  primaryBtnText: { ...typography.h3, color: colors.bg, fontWeight: '700' },
  btnDisabled:    { backgroundColor: colors.border, opacity: 0.5 },
});