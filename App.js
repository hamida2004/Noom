import React, { useEffect, useRef, useCallback } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Alert,
} from 'react-native';

import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { Buffer } from 'buffer';

import AppNavigator from './src/navigation/AppNavigator';
import OnnxWebViewBridge from './services/OnnxWebViewBridge';
import { setBridge } from './services/classifier';

global.Buffer = Buffer;

// ─────────────────────────────────────────────────────────────────────────────
// Notification handler
// ─────────────────────────────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE + Notification Permissions
// ─────────────────────────────────────────────────────────────────────────────

async function requestAndroidPermissions() {




  if (Platform.OS !== 'android') return true;

  try {
    // Android 12+
    if (Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      const allGranted =
        granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED;

      if (!allGranted) {
        Alert.alert(
          'Permissions required',
          'Bluetooth and location permissions are required for wristband connectivity.'
        );
      }

      return allGranted;
    }

    // Android < 12
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );

    const ok = granted === PermissionsAndroid.RESULTS.GRANTED;

    if (!ok) {
      Alert.alert(
        'Permission required',
        'Location permission is required for Bluetooth scanning.'
      );
    }

    return ok;

  } catch (err) {
    console.warn('[Permissions] Error:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Callback ref: fires immediately when OnnxWebViewBridge mounts,
  // guaranteeing setBridge() is called before any screen tries loadModel().
  // A useRef+useEffect combo fires one render-tick too late.
  const bridgeRef = useCallback((node) => {
    if (node !== null) {
      setBridge(node);
      console.log('[App] OnnxBridge ref set.');
    }
  }, []);


  useEffect(() => {

    async function setupPermissions() {

      // Notifications
      await Notifications.requestPermissionsAsync();

      // BLE
      await requestAndroidPermissions();
    }

    setupPermissions();

  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>

      <SafeAreaProvider>
        <StatusBar style="light" />
        <OnnxWebViewBridge ref={bridgeRef} />
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}