import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../../theme';

import HomeScreen        from '../../screens/HomeScreen';
import SetupScreen       from '../../screens/SetupScreen';
import CalibrationScreen from '../../screens/CalibrationScreen';
import MonitoringScreen  from '../../screens/MonitoringScreen';
import AlarmScreen       from '../../screens/AlarmScreen';
import FeedbackScreen    from '../../screens/FeedbackScreen';
import PVTScreen from '../../screens/PVTScreen';
import { navigationRef } from '../../navigationRef';

const Tab   = createBottomTabNavigator();
const Stack = createStackNavigator();

// ─── Tab Icons ────────────────────────────────────────────────────────────────
function TabIcon({ name, focused }) {
  const icons = { Home: '◎', Sleep: '◐', Setup: '◈' };
  return (
    <View style={[styles.tabIcon, focused && styles.tabIconFocused]}>
      <Text style={[styles.tabIconText, focused && styles.tabIconTextFocused]}>
        {icons[name] ?? '●'}
      </Text>
    </View>
  );
}

// ─── Main Tabs ────────────────────────────────────────────────────────────────
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarLabel: ({ focused }) => (
          <Text style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
            {route.name.toUpperCase()}
          </Text>
        ),
        tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      })}
    >
      <Tab.Screen name="Home"  component={HomeScreen} />
      <Tab.Screen name="Sleep" component={MonitoringScreen} />
      <Tab.Screen name="Setup" component={SetupStack} />
    </Tab.Navigator>
  );
}

// ─── Setup Stack ──────────────────────────────────────────────────────────────
function SetupStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="SetupMain"    component={SetupScreen} />
      <Stack.Screen name="Calibration"  component={CalibrationScreen} />
    </Stack.Navigator>
  );
}

// ─── Root Stack (for full-screen alarm + feedback modals) ────────────────────
export default function AppNavigator() {
  return (
    <NavigationContainer
     ref={navigationRef}
      theme={{
        dark: true,
        colors: {
          background: colors.bg,
          card: colors.surface,
          text: colors.text,
          border: colors.border,
          primary: colors.primary,
          notification: colors.primary,
        },
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false, presentation: 'modal' }}>
        <Stack.Screen name="Main"     component={MainTabs} options={{ presentation: 'card' }} />
        <Stack.Screen name="Alarm"    component={AlarmScreen} />
        <Stack.Screen name="Feedback" component={FeedbackScreen} />
        <Stack.Screen name="PVT" component={PVTScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    height: 64,
    paddingBottom: 8,
    paddingTop: 4,
  },
  tabIcon: {
    width: 32,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconFocused: {
    // subtle glow handled by text color
  },
  tabIconText: {
    fontSize: 18,
    color: colors.textDim,
  },
  tabIconTextFocused: {
    color: colors.primary,
  },
  tabLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.textDim,
  },
  tabLabelFocused: {
    color: colors.primary,
  },
});