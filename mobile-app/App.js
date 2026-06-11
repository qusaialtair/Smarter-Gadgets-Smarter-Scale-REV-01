import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  Vibration,
  View,
  Appearance,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import useBLE, { BLE_STATUS } from './useBLE';

let Accelerometer = null;
try {
  Accelerometer = require('expo-sensors').Accelerometer;
} catch (e) {
  console.warn('[sensors] Accelerometer unavailable:', e?.message);
}

/* ================================================================== *
 * CONFIGURATION
 * ================================================================== */

const TARGET_NAME = 'MagSafe Scale';
const WEIGHT_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const WEIGHT_CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

const SCAN_TIMEOUT_MS = 12000;
const OZ_PER_GRAM = 0.035274;
const LB_PER_GRAM = 0.00220462262;
const UNITS = ['g', 'oz', 'lb'];
const MAX_LOAD_G = 5000;
const MAX_RECENT = 20;
const MAX_SAVED = 50;

const STORAGE = {
  SAVED: '@magsafe/saved',
  RECENT: '@magsafe/recent',
  NEXT_ID: '@magsafe/nextId',
  SETTINGS: '@magsafe/settings',
};

const AUTO_CAPTURE_MS = 3000;
const AUTO_CAPTURE_MIN_G = 1;
const STRAIN_G = 3500;
const LIMIT_G = 5000;
const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const SHEET_MIN_Y = 60;
const SHEET_HEIGHT = SCREEN_H - SHEET_MIN_Y;

const SNAP_TOP = 0;
const SNAP_MID = SHEET_HEIGHT / 2;
const SNAP_LOW = SHEET_HEIGHT - 120;

const MAX_TRANSLATE_Y = SNAP_LOW;
const MIN_TRANSLATE_Y = SNAP_TOP;
const DATE_FMT = { DMY: 'dmy', MDY: 'mdy' };

const ORB_BASE = 160;

/** Fragment configs for overload shatter animation */
const FRAG = [
  { dx: -40, dy: 420, rot: -130, sz: 38 },
  { dx: 30, dy: 500, rot: 95, sz: 52 },
  { dx: -12, dy: 460, rot: -195, sz: 30 },
  { dx: 45, dy: 540, rot: 155, sz: 44 },
  { dx: -5, dy: 580, rot: 50, sz: 26 },
  { dx: 22, dy: 440, rot: -65, sz: 34 },
];

/* ================================================================== *
 * STORAGE LAYER
 * ================================================================== */

const memoryCache = {};
function createStorage() {
  let native = null;
  try {
    native = require('@react-native-async-storage/async-storage').default;
  } catch (e) {
    console.warn('[storage] AsyncStorage unavailable:', e?.message);
  }
  return {
    getItem: (key) =>
      native ? native.getItem(key) : Promise.resolve(memoryCache[key] ?? null),
    setItem: (key, value) =>
      native
        ? native.setItem(key, value)
        : Promise.resolve(void (memoryCache[key] = value)),
    multiSet: (entries) =>
      native
        ? native.multiSet(entries)
        : Promise.resolve(
            entries.forEach(([k, v]) => {
              memoryCache[k] = v;
            }),
          ),
  };
}
const storage = createStorage();

/* ================================================================== *
 * BLE STATUS (matches useBLE's BLE_STATUS values)
 * ================================================================== */

const STATUS = BLE_STATUS;

function normalizeThemeMode(mode) {
  if (mode === 'dark' || mode === 'DARK') return 'dark';
  if (mode === 'light' || mode === 'LIGHT') return 'light';
  return 'sys';
}

/* ================================================================== *
 * PLATFORM & THEME
 * ================================================================== */

const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const THEMES = {
  dark: {
    bg: '#000000',
    surface: '#0A0A0A',
    card: '#111111',
    text: '#FFFFFF',
    textSoft: '#EDEDED',
    muted: '#888888',
    faint: '#3A3A3A',
    dim: '#1A1A1A',
    line: '#222222',
    danger: '#FF453A',
    orange: '#FF6B00',
    green: '#34C759',
    yellow: '#FFD60A',
    accent: '#FFFFFF',
    invert: '#000000',
    led: '#0A84FF',
    statusBar: 'light',
    backdrop: 'rgba(0,0,0,0.82)',
    press: 'rgba(255,255,255,0.06)',
  },
  light: {
    bg: '#F2F2ED',
    surface: '#E8E8E3',
    card: '#FFFFFF',
    text: '#0A0A0A',
    textSoft: '#1A1A1A',
    muted: '#777777',
    faint: '#BBBBBB',
    dim: '#E0E0E0',
    line: '#CCCCCC',
    danger: '#FF3B30',
    orange: '#E06000',
    green: '#28A745',
    yellow: '#E5A800',
    accent: '#0A0A0A',
    invert: '#FFFFFF',
    led: '#007AFF',
    statusBar: 'dark',
    backdrop: 'rgba(0,0,0,0.35)',
    press: 'rgba(0,0,0,0.05)',
  },
};

/* ================================================================== *
 * UTILITY FUNCTIONS
 * ================================================================== */

function gramsToUnit(grams, unit) {
  if (unit === 'oz') return grams * OZ_PER_GRAM;
  if (unit === 'lb') return grams * LB_PER_GRAM;
  return grams;
}

function cycleUnit(current) {
  if (current === 'g') return 'oz';
  if (current === 'oz') return 'lb';
  return 'g';
}

function formatNumber(value, unit) {
  const decimals = unit === 'g' ? 1 : unit === 'lb' ? 3 : 2;
  let v = value;
  if (Math.abs(v) < Math.pow(10, -decimals) / 2) v = 0;
  return v.toFixed(decimals);
}

function formatEntry(entry) {
  return formatNumber(gramsToUnit(entry.grams, entry.unit), entry.unit);
}

const pad = (n) => String(n).padStart(2, '0');

function normalizeEntry(entry) {
  if (entry.at != null) return entry;
  return { ...entry, at: Date.now() };
}

function entryAt(entry) {
  return entry.at != null ? entry.at : Date.now();
}

function formatDisplayDate(at, fmt) {
  const d = new Date(at);
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  if (fmt === DATE_FMT.MDY) return `${month}/${day}/${year}`;
  return `${day}/${month}/${year}`;
}

/* isTargetScale, decodeBlePayload, parseScaleNotification — moved into useBLE.js */

function captionFor(status, name) {
  switch (status) {
    case STATUS.SCANNING:
      return 'SCANNING';
    case STATUS.CONNECTING:
      return 'LINKING';
    case STATUS.CONNECTED:
      return name ? name.toUpperCase() : 'CONNECTED';
    default:
      return 'STANDBY';
  }
}

function buttonLabel(status) {
  switch (status) {
    case STATUS.SCANNING:
      return 'SCANNING';
    case STATUS.CONNECTING:
      return 'CONNECTING';
    case STATUS.CONNECTED:
      return 'DISCONNECT';
    default:
      return 'SCAN';
  }
}

function batteryColor(level, T) {
  if (level <= 20) return T.danger;
  if (level <= 50) return T.yellow;
  return T.green;
}

/** Clipboard copy — resolves true on success */
async function copyText(text) {
  try {
    const { Clipboard } = require('react-native');
    if (Clipboard && typeof Clipboard.setString === 'function') {
      Clipboard.setString(text);
      return true;
    }
  } catch (e) {
    console.warn('[clipboard fallback error]:', e);
  }
  return false;
}

/* ================================================================== *
 * GearIcon — precision-drawn gear (pure View)
 * ================================================================== */

function GearIcon({ size = 14, color }) {
  const teeth = 8;
  const hubSize = size * 0.45;
  const toothWidth = size * 0.25;
  const toothHeight = size * 0.35;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: hubSize,
          height: hubSize,
          borderRadius: hubSize / 2,
          borderWidth: 1.5,
          borderColor: color,
          position: 'absolute',
          zIndex: 2,
        }}
      />
      {Array.from({ length: teeth }).map((_, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            width: toothWidth,
            height: toothHeight,
            backgroundColor: color,
            borderRadius: 0.5,
            transform: [
              { rotate: `${(360 / teeth) * i}deg` },
              { translateY: -(size * 0.38) },
            ],
          }}
        />
      ))}
      <View style={{ width: size * 0.65, height: size * 0.65, backgroundColor: '#000', borderRadius: size, position: 'absolute', zIndex: 1 }} />
    </View>
  );
}

/* ================================================================== *
 * LEDIndicator — glows blue when connected
 * ================================================================== */

function LEDIndicator({ connected, T }) {
  const glowAnim = useRef(new Animated.Value(connected ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(glowAnim, {
      toValue: connected ? 1 : 0,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [connected, glowAnim]);

  const bgColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [T.dim, T.led],
  });

  const shadowOp = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.85],
  });

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: bgColor,
        shadowColor: T.led,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: shadowOp,
        shadowRadius: 6,
        elevation: connected ? 4 : 0,
      }}
    />
  );
}

/* ================================================================== *
 * BatteryIndicator — colored fill bar shaped like a battery
 * ================================================================== */

function BatteryIndicator({ level, T }) {
  const pct = level == null ? null : Math.round(level);
  const fill = batteryColor(pct ?? 0, T);
  const fillW = Math.max(0, ((pct ?? 0) / 100) * 20);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ color: T.faint, fontSize: 10, marginRight: 6, fontWeight: '600' }}>
        {pct == null ? '--' : `${pct}%`}
      </Text>
      <View
        style={{
          width: 24,
          height: 12,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: T.muted,
          padding: 1,
          flexDirection: 'row',
        }}
      >
        <View
          style={{
            width: fillW,
            height: 8,
            backgroundColor: fill,
            borderRadius: 2,
          }}
        />
      </View>
      <View
        style={{
          width: 2,
          height: 4,
          backgroundColor: T.muted,
          borderTopRightRadius: 3,
          borderBottomRightRadius: 3,
        }}
      />
    </View>
  );
}

/* ================================================================== *
 * ScaleLines — precision mechanical ruler visualization
 * ================================================================== */

function ScaleLines({ grams, active, T }) {
  const BARS = 45;
  const MAX_G = 5000;
  
  // Calculate active ratio of the scale
  const activeRatio = active ? Math.min(grams, MAX_G) / MAX_G : 0;
  const activeIndex = Math.floor(activeRatio * BARS);
  
  return (
    <View style={{ height: 120, width: SCREEN_W, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ 
        flexDirection: 'row', 
        alignItems: 'flex-end', 
        justifyContent: 'space-between',
        width: SCREEN_W - 60,
        height: 60,
      }}>
        {Array.from({ length: BARS }).map((_, i) => {
          const ratio = i / (BARS - 1);
          
          // Thickness increases towards the right (red end)
          const barWidth = 1 + (ratio * 4);
          // Height fluctuates a bit for organic mechanical look, but generally gets taller
          const baseHeight = 20 + (ratio * 30);
          const height = i % 5 === 0 ? baseHeight + 10 : baseHeight;
          
          const isActive = i <= activeIndex && active;
          
          let color = T.dim;
          if (isActive) {
            if (ratio < 0.5) color = T.green;
            else if (ratio < 0.85) color = T.yellow;
            else if (ratio < 0.98) color = T.orange;
            else color = T.danger;
          }
          
          return (
            <View 
              key={i} 
              style={{ 
                width: barWidth, 
                height: height, 
                backgroundColor: color, 
                borderRadius: 2,
                opacity: isActive ? 1 : 0.3
              }} 
            />
          );
        })}
      </View>
      
      {/* Baseline */}
      <View style={{ width: SCREEN_W - 50, height: 2, backgroundColor: active ? T.faint : T.dim, marginTop: 4, borderRadius: 1 }} />
    </View>
  );
}


/* ================================================================== *
 * CopyToast — slides up from bottom on clipboard copy
 * ================================================================== */

function CopyToast({ visible, anim, T }) {
  if (!visible) return null;
  const opacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const slide = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [20, 0],
  });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 90,
        alignSelf: 'center',
        backgroundColor: T.card,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: T.line,
        borderRadius: 999,
        opacity,
        transform: [{ translateY: slide }],
      }}
      pointerEvents="none"
    >
      <Text
        style={{
          fontFamily: MONO,
          color: T.text,
          fontSize: 10,
          letterSpacing: 2,
        }}
      >
        COPIED TO CLIPBOARD
      </Text>
    </Animated.View>
  );
}

/* ================================================================== *
 * HistoryPanels — flat borderless log feed + CLEAR for recents
 * ================================================================== */

function HistoryPanels({
  recent,
  saved,
  activeTab,
  onTabChange,
  toggleSheet,
  dateFormat,
  onTapRecent,
  onTapSaved,
  onDeleteSaved,
  onLongPressEntry,
  onClearRecent,
  T,
  translateY,
  panHandlers,
  searchQuery,
  onSearchQueryChange,
  isExpanded,
  listScrollY,
}) {
  const filteredSaved = useMemo(() => {
    if (!searchQuery) return saved;
    const q = searchQuery.toLowerCase();
    return saved.filter((e) => e.label && e.label.toLowerCase().includes(q));
  }, [saved, searchQuery]);

  const list = activeTab === 'recent' ? recent : filteredSaved;

  const fontSz = isExpanded ? 16 : 10;
  const padSz = isExpanded ? 8 : 0;
  const tabFontSz = isExpanded ? 13 : 9;

  return (
    <Animated.View
      {...panHandlers}
      style={[
        logS.sheet,
        {
          backgroundColor: T.surface,
          borderColor: T.line,
          transform: [{ translateY }],
        },
      ]}
    >
      {/* Drag Handle Area */}
      <View style={logS.dragArea}>
        <View style={[logS.dragHandle, { backgroundColor: T.faint }]} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
        keyboardVerticalOffset={60}
      >
        {/* tab selectors */}
        <View style={logS.tabRow}>
          <Pressable onPress={() => onTabChange('recent')}>
            <Text
              style={[
                logS.tabText,
                { color: activeTab === 'recent' ? T.text : T.faint, fontSize: tabFontSz },
              ]}
            >
              RECENT {recent.length}
            </Text>
          </Pressable>
          <Text style={{ color: T.faint, fontSize: tabFontSz }}>·</Text>
          <Pressable onPress={() => onTabChange('saved')}>
            <Text
              style={[
                logS.tabText,
                { color: activeTab === 'saved' ? T.text : T.faint, fontSize: tabFontSz },
              ]}
            >
              SAVED {saved.length}
            </Text>
          </Pressable>

          {activeTab === 'recent' && recent.length > 0 ? (
            <>
              <Text style={{ color: T.faint, fontSize: tabFontSz }}>·</Text>
              <Pressable onPress={onClearRecent}>
                <Text style={[logS.tabText, { color: T.danger, fontSize: tabFontSz }]}>CLEAR</Text>
              </Pressable>
            </>
          ) : null}
        </View>

        {/* Helper Hint Text for Recents */}
        {activeTab === 'recent' && recent.length > 0 && (
          <Text style={[logS.helpHint, { color: T.faint }]}>
            PRESS ON A CAPTURED MEASUREMENT TO SAVE
          </Text>
        )}

        {/* Search Input for Saved Tab */}
        {activeTab === 'saved' && (
          <View style={[logS.searchContainer, { borderColor: T.line }]}>
            <TextInput
              style={[logS.searchInput, { color: T.text }]}
              value={searchQuery}
              onChangeText={onSearchQueryChange}
              placeholder="SEARCH BY NAME..."
              placeholderTextColor={T.faint}
              autoCapitalize="none"
              autoCorrect={false}
              selectionColor={T.text}
            />
            {searchQuery ? (
              <Pressable
                onPress={() => onSearchQueryChange('')}
                hitSlop={8}
                style={logS.searchClear}
              >
                <Text style={{ color: T.muted, fontFamily: MONO, fontSize: 14 }}>
                  ×
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
          scrollEnabled={isExpanded}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            if (listScrollY) {
              listScrollY.current = y;
            }
            if (y < -40 && isExpanded) {
              toggleSheet(false);
            }
          }}
          scrollEventThrottle={16}
        >
          {list.length === 0 ? (
            <Text style={[logS.empty, { color: T.faint }]}>
              {activeTab === 'recent'
                ? 'no captures'
                : searchQuery
                ? 'no matches found'
                : 'no saved entries'}
            </Text>
          ) : activeTab === 'recent' ? (
            list.map((e) => (
              <Pressable
                key={e.id}
                onPress={() => onTapRecent(e)}
                onLongPress={() =>
                  onLongPressEntry(`${formatEntry(e)} ${e.unit}`)
                }
                delayLongPress={400}
                style={logS.entry}
              >
                <Text style={[logS.entryText, { color: T.muted, fontSize: fontSz, paddingVertical: padSz }]}>
                  {formatEntry(e)} {e.unit}
                  {'  '}
                  <Text style={{ color: T.faint, fontSize: fontSz }}>
                    {formatDisplayDate(entryAt(e), dateFormat)}
                  </Text>
                </Text>
              </Pressable>
            ))
          ) : (
            list.map((e) => {
              const contentW = Dimensions.get('window').width - 40;
              return (
              <View key={e.id} style={{ marginBottom: 2, borderRadius: 8, overflow: 'hidden' }}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  snapToOffsets={[0, 80]}
                  snapToEnd={false}
                  decelerationRate="fast"
                >
                  <Pressable
                    onPress={() => onTapSaved(e)}
                    onLongPress={() =>
                      onLongPressEntry(
                        `${e.label}: ${formatEntry(e)} ${e.unit}`,
                      )
                    }
                    delayLongPress={400}
                    style={[logS.entry, { width: contentW, marginHorizontal: 0 }]}
                  >
                    <Text
                      style={[logS.entryText, { color: T.textSoft, fontSize: fontSz, paddingVertical: padSz }]}
                      numberOfLines={1}
                    >
                      {e.label}
                      {'  '}
                      <Text style={{ color: T.muted, fontSize: fontSz }}>
                        {formatEntry(e)} {e.unit}
                      </Text>
                      {'  '}
                      <Text style={{ color: T.faint, fontSize: fontSz }}>
                        {formatDisplayDate(entryAt(e), dateFormat)}
                      </Text>
                      {e.description ? (
                        <>
                          {'  '}
                          <Text style={{ color: T.textSoft, fontSize: fontSz, fontStyle: 'italic' }}>
                            {e.description}
                          </Text>
                        </>
                      ) : null}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={{ width: 80, backgroundColor: T.danger, justifyContent: 'center', alignItems: 'center' }}
                    onPress={() => onDeleteSaved && onDeleteSaved(e.id)}
                  >
                    <Text style={{ color: T.bg, fontSize: 12, fontWeight: 'bold', fontFamily: MONO }}>DELETE</Text>
                  </Pressable>
                </ScrollView>
              </View>
            )})
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

const logS = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SHEET_HEIGHT,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 20,
    zIndex: 40,
    elevation: 40,
  },
  dragArea: {
    width: '100%',
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabText: { fontFamily: MONO, fontSize: 9, letterSpacing: 2 },
  helpHint: {
    fontFamily: MONO,
    fontSize: 8,
    textAlign: 'center',
    letterSpacing: 1,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    height: 36,
    marginBottom: 12,
    borderRadius: 999,
  },
  searchInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 10,
    height: '100%',
    padding: 0,
  },
  searchClear: {
    paddingHorizontal: 8,
    height: '100%',
    justifyContent: 'center',
  },
  empty: {
    fontFamily: MONO,
    fontSize: 9,
    textAlign: 'center',
    letterSpacing: 1,
    paddingVertical: 12,
  },
  entry: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  entryText: {
    fontFamily: MONO,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
});

/* ================================================================== *
 * Settings Components
 * ================================================================== */

function SettingsToggle({ label, hint, value, onToggle, T }) {
  return (
    <Pressable
      onPress={() => onToggle(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      style={({ pressed }) => [
        sRowBase,
        { borderBottomColor: T.line, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={[sLabel, { color: T.textSoft }]}>{label}</Text>
        {hint ? <Text style={[sHint, { color: T.faint }]}>{hint}</Text> : null}
      </View>
      <View
        style={[
          sTrack,
          { borderColor: value ? T.muted : T.line, backgroundColor: T.bg },
        ]}
      >
        <View
          style={[
            sThumb,
            {
              backgroundColor: value ? T.accent : T.dim,
              alignSelf: value ? 'flex-end' : 'flex-start',
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

const sRowBase = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingVertical: 14,
  borderBottomWidth: StyleSheet.hairlineWidth,
};
const sLabel = { fontFamily: MONO, fontSize: 11, letterSpacing: 2 };
const sHint = { fontFamily: MONO, fontSize: 9, marginTop: 4, lineHeight: 13 };
const sTrack = {
  width: 38,
  height: 20,
  borderRadius: 10,
  borderWidth: 1,
  padding: 2,
  justifyContent: 'center',
};
const sThumb = { width: 14, height: 14, borderRadius: 7 };

function DateFormatPicker({ value, onChange, T }) {
  return (
    <View style={[sRowBase, { borderBottomColor: T.line, opacity: 1 }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={[sLabel, { color: T.textSoft }]}>DATE FORMAT</Text>
        <Text style={[sHint, { color: T.faint }]}>
          Saved & recent entries
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[
          { key: DATE_FMT.DMY, label: 'DD/MM' },
          { key: DATE_FMT.MDY, label: 'MM/DD' },
        ].map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderWidth: 1,
              borderColor: value === key ? T.muted : T.line,
              borderRadius: 999,
            }}
          >
            <Text
              style={{
                fontFamily: MONO,
                color: value === key ? T.text : T.faint,
                fontSize: 9,
                letterSpacing: 1,
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ThemePicker({ value, onChange, T }) {
  return (
    <View style={[sRowBase, { borderBottomColor: T.line, opacity: 1 }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={[sLabel, { color: T.textSoft }]}>APPEARANCE</Text>
        <Text style={[sHint, { color: T.faint }]}>
          Dark, Light, or System
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[
          { key: 'dark', label: 'DARK' },
          { key: 'light', label: 'LIGHT' },
          { key: 'sys', label: 'SYS' },
        ].map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => onChange(normalizeThemeMode(key))}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderWidth: 1,
              borderColor: value === key ? T.muted : T.line,
              borderRadius: 999,
            }}
          >
            <Text
              style={{
                fontFamily: MONO,
                color: value === key ? T.text : T.faint,
                fontSize: 9,
                letterSpacing: 1,
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function HapticIncrementPicker({ value, onChange, T }) {
  const isCustom = !['OFF', '10g', '100g'].includes(value);
  return (
    <View style={[sRowBase, { borderBottomColor: T.line, flexDirection: 'column', alignItems: 'stretch' }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={[sLabel, { color: T.textSoft }]}>HAPTIC PULSE</Text>
          <Text style={[sHint, { color: T.faint }]}>
            Pulse on crossings
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[
            { key: 'OFF', label: 'OFF' },
            { key: '10g', label: '10G' },
            { key: '100g', label: '100G' },
            { key: 'CUSTOM', label: 'CUST' },
          ].map(({ key, label }) => {
            const selected = key === 'CUSTOM' ? isCustom : value === key;
            return (
              <Pressable
                key={key}
                onPress={() => onChange(key === 'CUSTOM' ? '50g' : key)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderWidth: 1,
                  borderColor: selected ? T.muted : T.line,
                  borderRadius: 999,
                }}
              >
                <Text
                  style={{
                    fontFamily: MONO,
                    color: selected ? T.text : T.faint,
                    fontSize: 9,
                    letterSpacing: 1,
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {isCustom && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, alignSelf: 'flex-end' }}>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: T.faint, marginRight: 8 }}>CUSTOM INTERVAL:</Text>
          <TextInput
            style={{ fontFamily: MONO, fontSize: 12, color: T.text, borderBottomWidth: 1, borderBottomColor: T.accent, paddingVertical: 4, minWidth: 60, textAlign: 'center' }}
            value={(value || '').replace('g', '')}
            onChangeText={(v) => onChange(v.replace(/[^0-9]/g, '') + 'g')}
            placeholder="0"
            placeholderTextColor={T.faint}
            keyboardType="numeric"
            returnKeyType="done"
          />
          <Text style={{ fontFamily: MONO, fontSize: 12, color: T.text, marginLeft: 4 }}>g</Text>
        </View>
      )}
    </View>
  );
}

/* ================================================================== *
 * APP — all BLE logic preserved verbatim
 * ================================================================== */

function App() {
  /* ──────── BLE (all logic lives in useBLE hook) ──────── */
  const ble = useBLE();

  // Alias hook values so the rest of the file Just Works™
  const status = ble.status;
  const deviceName = ble.deviceName;
  const rawWeightG = ble.weight;

  /* ──────── Refs ──────── */
  const stableBatteryRef = useRef(null);
  
  let batteryLevel = null;
  if (ble.battery !== null) {
    const rounded = Math.round(ble.battery);
    if (stableBatteryRef.current === null) {
      stableBatteryRef.current = rounded;
    } else if (rounded < stableBatteryRef.current || rounded > stableBatteryRef.current + 5) {
      stableBatteryRef.current = rounded;
    }
    batteryLevel = stableBatteryRef.current;
  }

  const idRef = useRef(0);
  const stableRef = useRef({ gram: null, since: 0 });
  const lastAutoGramRef = useRef(null);
  const lastHapticTime = useRef(0);
  const lastHapticGrams = useRef(0);

  /* ──────── State ──────── */
  const [tareOffsetG, setTareOffsetG] = useState(0);
  const [unit, setUnit] = useState('g');
  const [note, setNote] = useState('');
  const [hydrated, setHydrated] = useState(false);

  const [recent, setRecent] = useState([]);
  const [saved, setSaved] = useState([]);

  const [modalVisible, setModalVisible] = useState(false);
  const [labelText, setLabelText] = useState('');
  const [pending, setPending] = useState(null);
  const [isEditingDescription, setIsEditingDescription] = useState(false);

  /* ──────── Settings & UI ──────── */
  const systemColorScheme = useColorScheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState('recent');
  const [autoCapture, setAutoCapture] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [previewGrams, setPreviewGrams] = useState(155);
  const [dateFormat, setDateFormat] = useState(DATE_FMT.DMY);
  const [themeMode, setThemeMode] = useState('sys');
  const [appearanceVersion, setAppearanceVersion] = useState(0);

  const [toastVisible, setToastVisible] = useState(false);
  const toastAnim = useRef(new Animated.Value(0)).current;

  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const translateY = useRef(new Animated.Value(MAX_TRANSLATE_Y)).current;
  const currentTranslateY = useRef(MAX_TRANSLATE_Y);
  const readoutScale = useRef(new Animated.Value(1)).current;

  const [hapticIncrement, setHapticIncrement] = useState('OFF');
  const [targetGrams, setTargetGrams] = useState(null);
  const [targetInputActive, setTargetInputActive] = useState(false);
  const [targetText, setTargetText] = useState('');
  const [copiedVisible, setCopiedVisible] = useState(false);
  const copiedOpacity = useRef(new Animated.Value(0)).current;
  const targetFillAnim = useRef(new Animated.Value(0)).current;
  const fluidTransAnim = useRef(new Animated.Value(0)).current;
  const accelTiltX = useRef(new Animated.Value(0)).current;
  const accelTiltY = useRef(new Animated.Value(0)).current;
  
  const targetTapTimeout = useRef(null);
  const lastTargetTap = useRef(0);

  const lastHapticIncGrams = useRef(null);
  const lastHapticIncTime = useRef(0);
  const emergencyVibrating = useRef(false);

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await ble.disconnect();
    setTareOffsetG(0);
    if (!previewMode) {
      await ble.connect();
    }
    setTimeout(() => setRefreshing(false), 800);
  }, [ble, previewMode]);

  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      currentTranslateY.current = value;
    });
    return () => {
      translateY.removeListener(id);
    };
  }, [translateY]);

  // (slosh animation is set up below after displayGrams is defined)

  const toggleSheet = useCallback((expand) => {
    const toValue = expand ? SNAP_TOP : SNAP_MID;
    setIsSheetExpanded(expand);
    Animated.spring(translateY, {
      toValue,
      tension: 120,
      friction: 12,
      useNativeDriver: true,
    }).start();
  }, [translateY]);

  const handleTabChange = useCallback((tab) => {
    setHistoryTab(tab);
    if (!isSheetExpanded) {
      toggleSheet(true);
    }
  }, [isSheetExpanded, toggleSheet]);

  const listScrollY = useRef(0);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) => {
          const isDraggingDown = gestureState.dy > 5;
          if (!isSheetExpanded) return Math.abs(gestureState.dy) > 5;
          if (isDraggingDown && listScrollY.current <= 0) return true;
          return false;
        },
        onPanResponderGrant: () => {
          translateY.setOffset(currentTranslateY.current);
          translateY.setValue(0);
        },
        onPanResponderMove: (_, gestureState) => {
          const offset = currentTranslateY.current;
          const minDy = -offset;
          const maxDy = MAX_TRANSLATE_Y - offset;
          const clampedDy = Math.min(Math.max(gestureState.dy, minDy), maxDy);
          translateY.setValue(clampedDy);
        },
        onPanResponderRelease: (_, gestureState) => {
          translateY.flattenOffset();
          const velocityY = gestureState.vy;
          let toValue = SNAP_MID;

          if (velocityY < -0.5) {
            if (currentTranslateY.current > SNAP_MID) toValue = SNAP_MID;
            else toValue = SNAP_TOP;
          } else if (velocityY > 0.5) {
            if (currentTranslateY.current < SNAP_MID) toValue = SNAP_MID;
            else toValue = SNAP_LOW;
          } else {
            const dTop = Math.abs(currentTranslateY.current - SNAP_TOP);
            const dMid = Math.abs(currentTranslateY.current - SNAP_MID);
            const dLow = Math.abs(currentTranslateY.current - SNAP_LOW);
            if (dTop < dMid && dTop < dLow) toValue = SNAP_TOP;
            else if (dMid < dTop && dMid < dLow) toValue = SNAP_MID;
            else toValue = SNAP_LOW;
          }

          setIsSheetExpanded(toValue === SNAP_TOP);
          Animated.spring(translateY, {
            toValue,
            tension: 120,
            friction: 12,
            useNativeDriver: true,
          }).start();
        },
      }),
    [translateY],
  );

  /* ──────── Theme (SYS follows iOS / system via useColorScheme) ──────── */
  useEffect(() => {
    const sub = Appearance.addChangeListener(() => {
      setAppearanceVersion((v) => v + 1);
    });
    return () => sub.remove();
  }, []);

  const resolvedTheme = normalizeThemeMode(themeMode);
  const isDarkMode = useMemo(() => {
    if (resolvedTheme === 'dark') return true;
    if (resolvedTheme === 'light') return false;
    const scheme = systemColorScheme ?? Appearance.getColorScheme();
    return scheme === 'dark';
  }, [resolvedTheme, systemColorScheme, appearanceVersion]);

  const T = useMemo(
    () => (isDarkMode ? THEMES.dark : THEMES.light),
    [isDarkMode],
  );

  /* ──────── BLE error → note sync ──────── */
  useEffect(() => {
    if (ble.error) setNote(ble.error);
  }, [ble.error]);

  /* ──────── Storage Hydration ──────── */
  useEffect(() => {
    (async () => {
      try {
        const [savedJson, recentJson, nextId, settingsJson] =
          await Promise.all([
            storage.getItem(STORAGE.SAVED),
            storage.getItem(STORAGE.RECENT),
            storage.getItem(STORAGE.NEXT_ID),
            storage.getItem(STORAGE.SETTINGS),
          ]);
        if (savedJson) {
          const parsed = JSON.parse(savedJson);
          if (Array.isArray(parsed)) setSaved(parsed.map(normalizeEntry));
        }
        if (recentJson) {
          const parsed = JSON.parse(recentJson);
          if (Array.isArray(parsed)) setRecent(parsed.map(normalizeEntry));
        }
        if (nextId)
          idRef.current = Math.max(0, parseInt(nextId, 10) || 0);
        if (settingsJson) {
          const cfg = JSON.parse(settingsJson);
          if (typeof cfg.autoCapture === 'boolean')
            setAutoCapture(cfg.autoCapture);
          if (typeof cfg.previewMode === 'boolean')
            setPreviewMode(cfg.previewMode);
          if (typeof cfg.previewGrams === 'number')
            setPreviewGrams(cfg.previewGrams);
          if (typeof cfg.dateFormat === 'string')
            setDateFormat(cfg.dateFormat);
          if (typeof cfg.themeMode === 'string')
            setThemeMode(normalizeThemeMode(cfg.themeMode));
          else if (typeof cfg.isDark === 'boolean')
            setThemeMode(cfg.isDark ? 'dark' : 'light');
          if (typeof cfg.hapticIncrement === 'string')
            setHapticIncrement(cfg.hapticIncrement);
        }
      } catch {
        setNote('Could not load saved data');
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  /* ──────── Persist ──────── */
  useEffect(() => {
    if (!hydrated) return;
    storage
      .multiSet([
        [STORAGE.SAVED, JSON.stringify(saved)],
        [STORAGE.NEXT_ID, String(idRef.current)],
      ])
      .catch(() => setNote('Failed to save to device'));
  }, [saved, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    storage.setItem(STORAGE.RECENT, JSON.stringify(recent)).catch(() => {});
  }, [recent, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    storage
      .setItem(
        STORAGE.SETTINGS,
        JSON.stringify({
          autoCapture,
          previewMode,
          previewGrams,
          dateFormat,
          themeMode,
          hapticIncrement,
        }),
      )
      .catch(() => {});
  }, [autoCapture, previewMode, previewGrams, dateFormat, themeMode, hapticIncrement, hydrated]);

  /* ──────── BLE Lifecycle — handled entirely by useBLE hook ──────── */

  /* ──────── Actions ──────── */
  const onPressPrimary = () => {
    try { Vibration.vibrate(10); } catch {}
    if (status === STATUS.IDLE) ble.connect();
    else if (status === STATUS.SCANNING) ble.disconnect();
    else if (status === STATUS.CONNECTED) ble.disconnect();
  };

  const onTare = () => {
    try { Vibration.vibrate(12); } catch {}
    const offset = ble.weight;
    setTareOffsetG(offset);
    setNote(`Tare · ${offset.toFixed(1)} g`);
  };

  /* ──────── Derived ──────── */
  const netG = rawWeightG - tareOffsetG;
  const isConnected = status === STATUS.CONNECTED;
  const readoutActive = isConnected || previewMode;
  const displayGrams = previewMode ? previewGrams : netG;
  const displayValue = gramsToUnit(displayGrams, unit);
  const displayStr = readoutActive ? formatNumber(displayValue, unit) : '-----';
  const tareActive = tareOffsetG !== 0;

  // ── Accelerometer slosh (target fill stays level with gravity) ──
  useEffect(() => {
    if (!Accelerometer || targetGrams === null || !readoutActive) {
      accelTiltX.setValue(0);
      accelTiltY.setValue(0);
      return undefined;
    }

    Accelerometer.setUpdateInterval(50);
    const sub = Accelerometer.addListener(({ x, y }) => {
      const cx = Math.max(-1, Math.min(1, x ?? 0));
      const cy = Math.max(-1, Math.min(1, y ?? 0));
      accelTiltX.setValue(cx);
      accelTiltY.setValue(cy);
    });

    return () => sub.remove();
  }, [targetGrams, readoutActive, accelTiltX, accelTiltY]);

  // Brief vertical jolt when weight changes under a target
  const prevDisplayGramsRef = useRef(0);
  useEffect(() => {
    const delta = displayGrams - prevDisplayGramsRef.current;
    prevDisplayGramsRef.current = displayGrams;
    if (targetGrams === null || !readoutActive || Math.abs(delta) <= 0.5) {
      if (targetGrams === null || !readoutActive) fluidTransAnim.setValue(0);
      return;
    }
    const jolt = Math.min(Math.abs(delta) * 0.35, 10) * (delta > 0 ? 1 : -1);
    Animated.sequence([
      Animated.spring(fluidTransAnim, {
        toValue: jolt,
        friction: 4,
        tension: 90,
        useNativeDriver: false,
      }),
      Animated.spring(fluidTransAnim, {
        toValue: 0,
        friction: 6,
        tension: 50,
        useNativeDriver: false,
      }),
    ]).start();
  }, [displayGrams, targetGrams, readoutActive, fluidTransAnim]);

  /* ──────── Clipboard ──────── */
  const handleCopy = useCallback(
    async (text) => {
      const ok = await copyText(text);
      if (ok) {
        setToastVisible(true);
        toastAnim.setValue(0);
        Animated.sequence([
          Animated.timing(toastAnim, {
            toValue: 1,
            duration: 200,
            useNativeDriver: true,
          }),
          Animated.delay(1400),
          Animated.timing(toastAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ]).start(() => setToastVisible(false));
      } else {
        setNote('Clipboard unavailable');
      }
    },
    [toastAnim],
  );

  /* ──────── Continuous & Settings Haptics Engine ──────── */
  // Success copy feedback helper
  const showCopiedFeedback = () => {
    setCopiedVisible(true);
    copiedOpacity.setValue(1);
    try {
      Vibration.vibrate(10); // soft premium click
    } catch {}
    Animated.sequence([
      Animated.delay(1000),
      Animated.timing(copiedOpacity, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setCopiedVisible(false);
    });
  };

  // Continuous heavy emergency 5kg vibration
  useEffect(() => {
    if (!readoutActive) {
      if (emergencyVibrating.current) {
        emergencyVibrating.current = false;
        try { Vibration.cancel(); } catch {}
      }
      return;
    }
    const isEmergency = displayGrams >= 5000;
    if (isEmergency) {
      if (!emergencyVibrating.current) {
        emergencyVibrating.current = true;
        try {
          Vibration.vibrate([0, 300, 100, 300], true);
        } catch {}
      }
    } else {
      if (emergencyVibrating.current) {
        emergencyVibrating.current = false;
        try {
          Vibration.cancel();
        } catch {}
      }
    }
  }, [displayGrams, readoutActive]);

  // Target fill & alarm logic
  const alarmFiredRef = useRef(false);
  useEffect(() => {
    if (targetGrams === null || !readoutActive) {
      alarmFiredRef.current = false;
      Animated.spring(targetFillAnim, {
        toValue: 0,
        useNativeDriver: false,
      }).start();
      return;
    }
    
    // Fill fraction logic
    const ratio = Math.max(0, Math.min(1, displayGrams / targetGrams));
    Animated.spring(targetFillAnim, {
      toValue: ratio,
      useNativeDriver: false,
      friction: 8,
      tension: 40,
    }).start();

    // Alarm logic
    const reached = displayGrams >= targetGrams;
    if (reached) {
      if (!alarmFiredRef.current) {
        alarmFiredRef.current = true;
        try {
          Vibration.vibrate([0, 80, 40, 80]); // double-purr
        } catch {}
        try {
          const { Audio } = require('expo-av');
          Audio.Sound.createAsync(
            require('./assets/beep.mp3')
          ).then(({ sound }) => sound.playAsync());
        } catch (e) {
          // No-op fallback
        }
      }
    } else {
      if (displayGrams < targetGrams - 5) {
        alarmFiredRef.current = false;
      }
    }
  }, [displayGrams, targetGrams, readoutActive]);

  // Incremental haptic ticks crossing logic
  useEffect(() => {
    if (!readoutActive || hapticIncrement === 'OFF' || displayGrams >= 5000) {
      lastHapticIncGrams.current = null;
      return;
    }
    const inc = parseInt((hapticIncrement || '').replace('g', ''), 10);
    if (isNaN(inc) || inc <= 0) return;
    
    const currentWeight = displayGrams;
    
    if (lastHapticIncGrams.current === null) {
      lastHapticIncGrams.current = currentWeight;
      return;
    }
    
    const prevSector = Math.floor(lastHapticIncGrams.current / inc);
    const currSector = Math.floor(currentWeight / inc);
    
    if (prevSector !== currSector && Math.abs(currentWeight - lastHapticIncGrams.current) >= 1) {
      const now = Date.now();
      if (now - lastHapticIncTime.current > 120) {
        try {
          Vibration.vibrate(5); // tiny discrete haptic pulse
        } catch {}
        lastHapticIncTime.current = now;
        lastHapticIncGrams.current = currentWeight;
      }
    }
  }, [displayGrams, readoutActive, hapticIncrement]);

  /* ──────── Capture ──────── */
  const addRecentEntry = useCallback((grams, sourceUnit, silent) => {
    const entry = {
      id: idRef.current++,
      grams,
      unit: sourceUnit,
      at: Date.now(),
    };
    setRecent((prev) => [entry, ...prev].slice(0, MAX_RECENT));
    setHistoryTab('recent');
    if (!silent) {
      const v = gramsToUnit(grams, sourceUnit);
      setNote(`Captured ${formatNumber(v, sourceUnit)} ${sourceUnit}`);
    }
  }, []);

  const captureReading = () => {
    try { Vibration.vibrate(12); } catch {}
    const grams = previewMode ? previewGrams : netG;
    addRecentEntry(grams, unit, false);
  };

  /* ──────── Auto-Capture ──────── */
  useEffect(() => {
    if (!autoCapture) {
      stableRef.current = { gram: null, since: 0 };
      return;
    }
    const canRun = previewMode || status === STATUS.CONNECTED;
    if (!canRun) {
      stableRef.current = { gram: null, since: 0 };
      return;
    }

    const tick = setInterval(() => {
      const sourceG = previewMode ? previewGrams : netG;
      const rounded = Math.round(sourceG);

      if (rounded < AUTO_CAPTURE_MIN_G) {
        stableRef.current = { gram: null, since: 0 };
        lastAutoGramRef.current = null;
        return;
      }

      if (
        lastAutoGramRef.current !== null &&
        rounded !== lastAutoGramRef.current
      ) {
        lastAutoGramRef.current = null;
      }

      const now = Date.now();
      const st = stableRef.current;

      if (st.gram !== rounded) {
        stableRef.current = { gram: rounded, since: now };
        return;
      }

      if (now - st.since < AUTO_CAPTURE_MS) return;
      if (lastAutoGramRef.current === rounded) return;

      lastAutoGramRef.current = rounded;
      stableRef.current = { gram: rounded, since: now };
      addRecentEntry(rounded, 'g', true);
      setNote(`Auto · ${rounded} g`);
    }, 200);

    return () => clearInterval(tick);
  }, [autoCapture, previewMode, previewGrams, netG, status, addRecentEntry]);

  /* ──────── Label Modal ──────── */
  const openLabelModal = (grams, entryUnit, existingEntry = null) => {
    if (existingEntry) {
      setPending({ ...existingEntry, isEdit: true });
      setLabelText(existingEntry.description || '');
      setIsEditingDescription(!existingEntry.description);
    } else {
      setPending({ grams, unit: entryUnit });
      setLabelText('');
      setIsEditingDescription(true);
    }
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setPending(null);
    setLabelText('');
    setIsEditingDescription(false);
  };

  const saveLabeled = () => {
    if (!pending) return;
    if (pending.isEdit) {
      const description = labelText.trim();
      setSaved((prev) =>
        prev.map((item) =>
          item.id === pending.id ? { ...item, description } : item
        )
      );
      closeModal();
      setNote(`Updated description`);
    } else {
      const label = labelText.trim() || 'Unlabeled';
      const entry = {
        id: idRef.current++,
        label,
        grams: pending.grams,
        unit: pending.unit,
        at: Date.now(),
      };
      setSaved((prev) => [entry, ...prev].slice(0, MAX_SAVED));
      setHistoryTab('saved');
      closeModal();
      setNote(`Saved "${label}"`);
    }
  };

  const deleteSaved = (id) => {
    setSaved((prev) => prev.filter((item) => item.id !== id));
  };

  const toggleSettings = () => setSettingsOpen((o) => !o);
  const onCycleUnit = () => setUnit((u) => cycleUnit(u));

  const isConnecting = status === STATUS.CONNECTING;
  const isScanning = status === STATUS.SCANNING;
  const isPrimaryAction = status === STATUS.IDLE;

  const statusCaption = previewMode
    ? 'PREVIEW'
    : `${tareActive ? 'NET' : 'GROSS'} · ${captionFor(status, deviceName)}`;

  let targetFillColor = isDarkMode
    ? 'rgba(10, 132, 255, 0.25)'
    : 'rgba(0, 122, 255, 0.15)';
  if (targetGrams !== null && readoutActive) {
    if (displayGrams >= targetGrams + 5) {
      targetFillColor = isDarkMode
        ? 'rgba(255, 69, 58, 0.3)'
        : 'rgba(255, 59, 48, 0.25)';
    } else if (displayGrams >= targetGrams - 1) {
      targetFillColor = isDarkMode
        ? 'rgba(48, 209, 88, 0.3)'
        : 'rgba(52, 199, 89, 0.25)';
    }
  }

  /* ================================================================ *
   *  RENDER
   * ================================================================ */
  return (
    <SafeAreaView style={[s.safe, { backgroundColor: T.bg }]}>
      <StatusBar style={T.statusBar} />

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.text} />}
        showsVerticalScrollIndicator={false}
      >
        {/* ──────── HEADER ──────── */}
        <View style={s.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <LEDIndicator connected={isConnected || previewMode} T={T} />
            <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, color: T.faint }}>
              {(isConnected || previewMode) ? 'CONNECTED' : 'DISCONNECTED'}
            </Text>
          </View>
          <View style={s.headerRight}>
            <Pressable
              onPress={toggleSettings}
              hitSlop={16}
              style={({ pressed }) => ({
                padding: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              {({ pressed }) => (
                <GearIcon
                  size={16}
                  color={settingsOpen || pressed ? T.text : T.muted}
                />
              )}
            </Pressable>
            <BatteryIndicator level={batteryLevel} T={T} />
          </View>
        </View>

        {/* ──────── BODY ──────── */}
        <View style={s.body}>
          {/* ---- weight stage ---- */}
          <View style={[s.stage, targetGrams !== null && readoutActive && { borderWidth: 1, borderColor: isDarkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)' }]}>
            {/* The Visual Fill background layer */}
            {targetGrams !== null && readoutActive && (
              <Animated.View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: targetFillColor,
                  height: targetFillAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '115%'],
                  }),
                  width: '140%',
                  left: '-20%',
                  bottom: '-15%',
                  zIndex: 0,
                }}
              />
            )}

            <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', paddingVertical: 40, zIndex: 1 }}>

              {/* weight readout — tap to capture, long press to copy */}
              <Animated.View style={[s.readoutRow, { transform: [{ scale: readoutScale }] }]}>
                {readoutActive ? (
                  <View style={{ width: 140, marginRight: 6 }} pointerEvents="none" />
                ) : null}
                <Pressable
                  onPress={() => {
                    if (readoutActive) {
                      if (status !== STATUS.CONNECTED && !previewMode) return;
                      captureReading();
                    }
                  }}
                  onLongPress={() => {
                    if (readoutActive) {
                      const cleanVal = displayValue.toFixed(1);
                      copyText(cleanVal).then((ok) => {
                        if (ok) showCopiedFeedback();
                      });
                    }
                  }}
                  delayLongPress={400}
                  onPressIn={() => {
                    if (readoutActive) {
                      Animated.spring(readoutScale, {
                        toValue: 0.95,
                        useNativeDriver: true,
                      }).start();
                    }
                  }}
                  onPressOut={() => {
                    Animated.spring(readoutScale, {
                      toValue: 1,
                      friction: 4,
                      tension: 60,
                      useNativeDriver: true,
                    }).start();
                  }}
                  hitSlop={30}
                  style={s.readoutHit}
                >
                  <Text
                    style={[
                      s.readoutWeight,
                      { 
                        color: readoutActive ? T.text : T.dim,
                        fontSize: displayStr.length > 5 ? 74 : displayStr.length > 4 ? 86 : 96
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {displayStr}
                  </Text>
                </Pressable>
                {readoutActive ? (
                  <Pressable
                    onPress={onCycleUnit}
                    hitSlop={16}
                    style={s.unitHit}
                  >
                    <Text style={[s.unitLabel, { color: T.text }]}>{unit}</Text>
                    <Text 
                      style={[s.note, { color: T.faint, marginTop: 6, marginLeft: 2, paddingHorizontal: 0 }]}
                      numberOfLines={1}
                    >
                      [ TAP TO CHANGE ]
                    </Text>
                  </Pressable>
                ) : null}
              </Animated.View>

              {/* copied feedback or instruction text */}
              {copiedVisible ? (
                <Animated.Text style={[s.note, { opacity: copiedOpacity, color: T.accent, marginTop: 8 }]}>
                  [ COPIED ]
                </Animated.Text>
              ) : readoutActive ? (
                <Text style={[s.note, { color: T.faint, marginTop: 8 }]}>
                  TAP TO CAPTURE
                </Text>
              ) : null}

              {/* Target weight controller */}
              {readoutActive && (
                <View style={{ marginTop: 14, zIndex: 2 }}>
                  {targetInputActive ? (
                    <TextInput
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: 2,
                        color: T.text,
                        borderBottomWidth: 1,
                        borderBottomColor: T.accent,
                        paddingVertical: 4,
                        minWidth: 120,
                        textAlign: 'center',
                      }}
                      value={targetText}
                      onChangeText={(val) => setTargetText(val.replace(/[^0-9.]/g, ''))}
                      placeholder={`TARGET (${unit})`}
                      placeholderTextColor={T.faint}
                      keyboardType="numeric"
                      autoFocus
                      onSubmitEditing={() => {
                        const num = parseFloat(targetText);
                        if (!isNaN(num) && num > 0) {
                          const grams = unit === 'g' ? num : num / OZ_PER_GRAM;
                          setTargetGrams(grams);
                        } else {
                          setTargetGrams(null);
                        }
                        setTargetInputActive(false);
                      }}
                      onBlur={() => {
                        const num = parseFloat(targetText);
                        if (!isNaN(num) && num > 0) {
                          const grams = unit === 'g' ? num : num / OZ_PER_GRAM;
                          setTargetGrams(grams);
                        } else {
                          setTargetGrams(null);
                        }
                        setTargetInputActive(false);
                      }}
                      returnKeyType="done"
                    />
                  ) : (
                    <Pressable
                      onPress={() => {
                        const now = Date.now();
                        const isDouble = (now - lastTargetTap.current) < 300;
                        lastTargetTap.current = now;

                        if (isDouble) {
                          if (targetTapTimeout.current) clearTimeout(targetTapTimeout.current);
                          setTargetText(targetGrams !== null ? String(gramsToUnit(targetGrams, unit).toFixed(0)) : '');
                          setTargetInputActive(true);
                        } else {
                          targetTapTimeout.current = setTimeout(() => {
                            if (targetGrams !== null) {
                              setTargetGrams(null);
                            } else {
                              setTargetText('');
                              setTargetInputActive(true);
                            }
                          }, 300);
                        }
                      }}
                      style={({ pressed }) => ({
                        opacity: pressed ? 0.7 : 1,
                        paddingVertical: 6,
                        paddingHorizontal: 12,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: T.line,
                        backgroundColor: targetGrams !== null
                          ? isDarkMode
                            ? 'rgba(255, 255, 255, 0.05)'
                            : 'rgba(0, 0, 0, 0.02)'
                          : 'transparent',
                      })}
                    >
                      <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: targetGrams !== null ? T.accent : T.faint }}>
                        {targetGrams !== null
                          ? `[ TARGET: ${gramsToUnit(targetGrams, unit).toFixed(unit === 'g' ? 0 : 1)}${unit} ]`
                          : '[ TARGET: OFF ]'}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}

              {/* scale visualizer */}
              <View style={{ marginTop: 24 }}>
                <ScaleLines grams={displayGrams} active={readoutActive} T={T} />
              </View>

              {/* limit badge */}
              {displayGrams >= LIMIT_G && readoutActive ? (
                <Text style={[s.limitBadge, { color: T.danger }]}>
                  [ LIMIT REACHED ]
                </Text>
              ) : null}
            </View>
          </View>

          {/* ---- bottom controls ---- */}
          <View style={s.bottom}>
            <Text style={[s.statusCaption, { color: T.faint }]}>
              {statusCaption}
            </Text>
            <Text style={[s.statusCaption, { color: T.faint, fontSize: 8, marginTop: -6 }]}>
              LONG PRESS TO COPY
            </Text>

            {/* TARE / CAPTURE */}
            <View style={s.controlRow}>
              <Pressable
                onPress={onTare}
                disabled={!isConnected}
                style={({ pressed }) => [
                  s.controlBtn,
                  {
                    borderColor: !isConnected ? T.dim : T.accent,
                    backgroundColor:
                      pressed && isConnected ? T.press : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[
                    s.controlLabel,
                    { color: !isConnected ? T.faint : T.text },
                  ]}
                >
                  TARE
                </Text>
              </Pressable>

              <Pressable
                onPress={captureReading}
                style={({ pressed }) => [
                  s.controlBtn,
                  {
                    borderColor: T.accent,
                    backgroundColor: pressed ? T.press : 'transparent',
                  },
                ]}
              >
                <Text style={[s.controlLabel, { color: T.text }]}>CAPTURE</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* ──────── NOTE ──────── */}
        {note ? (
          <Text style={[s.note, { color: T.faint }]} numberOfLines={1}>
            {note}
          </Text>
        ) : null}

        {/* ──────── SCAN BUTTON ──────── */}
        <Pressable
          onPress={onPressPrimary}
          disabled={isConnecting}
          style={({ pressed }) => [
            s.scanBtn,
            {
              borderColor: T.accent,
              backgroundColor: isPrimaryAction
                ? pressed
                  ? isDarkMode
                    ? '#D8D8D8'
                    : '#333333'
                  : T.accent
                : pressed
                  ? T.press
                  : T.bg,
            },
          ]}
        >
          {isScanning || isConnecting ? (
            <ActivityIndicator
              color={isPrimaryAction ? T.invert : T.text}
              size="small"
              style={{ marginRight: 8 }}
            />
          ) : null}
          <Text
            style={[
              s.scanLabel,
              { color: isPrimaryAction ? T.invert : T.text },
            ]}
          >
            {buttonLabel(status)}
          </Text>
        </Pressable>
      </ScrollView>

      {/* ──────── HISTORY SHEET / DRAWER ──────── */}
      <HistoryPanels
        recent={recent}
        saved={saved}
        activeTab={historyTab}
        onTabChange={handleTabChange}
        toggleSheet={toggleSheet}
        dateFormat={dateFormat}
        onTapRecent={(e) => openLabelModal(e.grams, e.unit)}
        onTapSaved={(e) => openLabelModal(e.grams, e.unit, e)}
        onDeleteSaved={(id) => deleteSaved(id)}
        onLongPressEntry={handleCopy}
        onClearRecent={() => {
          setRecent([]);
          setNote('Recent cleared');
        }}
        T={T}
        translateY={translateY}
        panHandlers={panResponder.panHandlers}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        isExpanded={isSheetExpanded}
        listScrollY={listScrollY}
      />

      {/* ──────── COPY TOAST ──────── */}
      <CopyToast visible={toastVisible} anim={toastAnim} T={T} />

      {/* ──────── SETTINGS OVERLAY ──────── */}
      {settingsOpen ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.settingsOverlay}
          pointerEvents="box-none"
        >
          <Pressable
            style={[s.settingsBackdrop, { backgroundColor: T.backdrop }]}
            onPress={() => setSettingsOpen(false)}
          />
          <View
            style={[
              s.settingsSheet,
              {
                backgroundColor: isDarkMode ? '#050505' : '#FAFAFA',
                borderColor: T.line,
              },
            ]}
          >
            <View style={s.settingsHeader}>
              <Text style={[s.settingsTitle, { color: T.muted }]}>
                SETTINGS
              </Text>
            </View>

            <ScrollView
              style={s.settingsScroll}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <ThemePicker
                value={resolvedTheme}
                onChange={(mode) => setThemeMode(normalizeThemeMode(mode))}
                T={T}
              />
              <SettingsToggle
                label="AUTO-CAPTURE"
                hint="Same gram held 3 s → log below"
                value={autoCapture}
                onToggle={setAutoCapture}
                T={T}
              />
              <SettingsToggle
                label="PREVIEW MODE"
                hint="Simulate load to develop & test UI"
                value={previewMode}
                onToggle={(on) => {
                  setPreviewMode(on);
                  if (on) lastAutoGramRef.current = null;
                }}
                T={T}
              />
              <DateFormatPicker
                value={dateFormat}
                onChange={setDateFormat}
                T={T}
              />
              <HapticIncrementPicker
                value={hapticIncrement}
                onChange={setHapticIncrement}
                T={T}
              />

              {previewMode ? (
                <View style={{ paddingVertical: 12, gap: 10 }}>
                  <Text
                    style={{
                      fontFamily: MONO,
                      color: T.faint,
                      fontSize: 9,
                      letterSpacing: 2,
                    }}
                  >
                    SIMULATED LOAD
                  </Text>
                  <Text
                    style={{
                      fontFamily: MONO,
                      color: T.text,
                      fontSize: 22,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {previewGrams} g
                  </Text>
                  <View
                    style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
                  >
                    {[0, 155, 500, 2500, 3800, 5200].map((g) => (
                      <Pressable
                        key={g}
                        onPress={() => {
                          setPreviewGrams(g);
                          lastAutoGramRef.current = null;
                          stableRef.current = { gram: null, since: 0 };
                        }}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderWidth: 1,
                          borderColor:
                            previewGrams === g ? T.muted : T.line,
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: MONO,
                            color: previewGrams === g ? T.text : T.faint,
                            fontSize: 10,
                          }}
                        >
                          {g >= 1000 ? `${g / 1000}k` : g}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
            </ScrollView>

            <Pressable
              onPress={() => setSettingsOpen(false)}
              style={({ pressed }) => [
                s.settingsExit,
                { backgroundColor: pressed ? '#D6D6D6' : '#E8E8E8' },
              ]}
            >
              <Text style={s.settingsExitText}>EXIT</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      ) : null}

      {/* ──────── LABEL MODAL ──────── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.modalCenter}
        >
          <Pressable
            style={[
              s.modalBackdrop,
              {
                backgroundColor: isDarkMode
                  ? 'rgba(0,0,0,0.85)'
                  : 'rgba(0,0,0,0.40)',
              },
            ]}
            onPress={closeModal}
          />
          <View
            style={[
              s.labelCard,
              {
                borderColor: T.line,
                backgroundColor: isDarkMode ? '#050505' : '#FFFFFF',
              },
            ]}
          >
            <Text style={[s.labelTitle, { color: T.faint }]}>
              {pending?.isEdit ? 'DESCRIPTION' : 'LABEL'}
            </Text>
            <Pressable
              onLongPress={() => {
                if (pending)
                  handleCopy(
                    `${formatEntry(pending)} ${pending.unit}`,
                  );
              }}
              delayLongPress={400}
            >
              <Text style={[s.labelWeight, { color: T.text }]}>
                {pending ? formatEntry(pending) : '0.0'}
                <Text style={{ color: T.muted, fontSize: 16 }}>
                  {' '}
                  {pending?.unit ?? unit}
                </Text>
              </Text>
            </Pressable>
            {pending?.isEdit && !isEditingDescription ? (
              <Text
                style={[
                  s.labelInput,
                  { color: T.text, marginTop: 10, paddingVertical: 10, minHeight: 48 },
                ]}
              >
                {labelText || 'No description'}
              </Text>
            ) : (
              <TextInput
                style={[
                  s.labelInput,
                  { borderBottomColor: T.accent, color: T.text },
                ]}
                value={labelText}
                onChangeText={setLabelText}
                placeholder={pending?.isEdit ? "Description" : "Name"}
                placeholderTextColor={T.faint}
                autoFocus
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={saveLabeled}
                selectionColor={T.text}
              />
            )}
            <View style={s.labelActions}>
              {pending?.isEdit && !isEditingDescription ? (
                <>
                  <Pressable
                    onPress={() => setIsEditingDescription(true)}
                    style={[s.labelBtnGhost, { borderColor: T.line }]}
                  >
                    <Text style={[s.labelBtnGhostText, { color: T.muted }]}>
                      EDIT
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={closeModal}
                    style={[s.labelBtnSolid, { backgroundColor: T.accent }]}
                  >
                    <Text style={[s.labelBtnSolidText, { color: T.invert }]}>
                      CLOSE
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    onPress={closeModal}
                    style={[s.labelBtnGhost, { borderColor: T.line }]}
                  >
                    <Text style={[s.labelBtnGhostText, { color: T.muted }]}>
                      CANCEL
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={saveLabeled}
                    style={[s.labelBtnSolid, { backgroundColor: T.accent }]}
                  >
                    <Text style={[s.labelBtnSolidText, { color: T.invert }]}>
                      SAVE
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const msg = error?.message ?? String(error ?? '');
    if (msg.includes('BleError')) {
      logBleError('render', error);
      this.setState({ error: null });
      return;
    }
    console.warn('[App] boundary:', msg, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: '#000',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
          }}
        >
          <Text style={{ fontFamily: MONO, color: '#fff', fontSize: 12 }}>
            Something went wrong.
          </Text>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: 12 }}
          >
            <Text style={{ fontFamily: MONO, color: '#888', fontSize: 11 }}>RETRY</Text>
          </Pressable>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

export default function AppRoot() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

/* ================================================================== *
 * STYLES
 * ================================================================== */

const s = StyleSheet.create({
  safe: { flex: 1 },

  /* header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 6,
    zIndex: 100,
    elevation: 100,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },

  /* body */
  body: { flex: 1, minHeight: 0 },
  stage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 20,
    marginVertical: 10,
    borderWidth: 0,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
  },

  /* readout */
  readoutHit: { alignItems: 'center' },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  readoutWeight: {
    fontSize: 96,
    fontWeight: '100',
    letterSpacing: -4,
    lineHeight: 100,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
  unitHit: {
    marginLeft: 6,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingBottom: 4,
    width: 140,
  },
  unitHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 3,
    flexWrap: 'wrap',
  },
  unitHintArrow: {
    fontSize: 9,
    lineHeight: 11,
  },
  unitHint: {
    fontFamily: MONO,
    fontSize: 6.5,
    letterSpacing: 0.2,
    lineHeight: 9,
    flexShrink: 1,
  },
  unitLabel: {
    fontFamily: MONO,
    fontSize: 28,
    fontWeight: '200',
    letterSpacing: 1,
  },

  limitBadge: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: 3,
    marginTop: 14,
    opacity: 0.9,
  },

  /* bottom */
  bottom: { flexShrink: 0, paddingHorizontal: 20, paddingBottom: 4 },
  statusCaption: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: 2.5,
    marginBottom: 12,
    textAlign: 'center',
  },
  controlRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
    width: '100%',
    maxWidth: 340,
    alignSelf: 'center',
  },
  controlBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 999,
  },
  controlLabel: { fontFamily: MONO, fontSize: 11, letterSpacing: 3 },

  /* note */
  note: {
    fontFamily: MONO,
    fontSize: 9,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 20,
  },

  /* scan button */
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 20,
    marginBottom: 12,
    paddingVertical: 15,
    borderWidth: 1,
    borderRadius: 999,
  },
  scanLabel: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: 4,
    fontWeight: '600',
  },

  /* settings */
  settingsOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 46,
    justifyContent: 'flex-end',
    zIndex: 50,
    elevation: 50,
  },
  settingsBackdrop: { ...StyleSheet.absoluteFillObject },
  settingsSheet: {
    width: '100%',
    maxHeight: '78%',
    borderTopWidth: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    zIndex: 51,
    elevation: 51,
  },
  settingsHeader: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
  },
  settingsTitle: { fontFamily: MONO, fontSize: 10, letterSpacing: 4 },
  settingsScroll: { maxHeight: 400, paddingHorizontal: 20 },
  settingsExit: {
    alignItems: 'center',
    paddingVertical: 18,
    borderTopWidth: 1,
    borderTopColor: '#C4C4C4',
  },
  settingsExitText: {
    fontFamily: MONO,
    color: '#000000',
    fontSize: 12,
    letterSpacing: 6,
    fontWeight: '700',
  },

  /* modal */
  modalCenter: { flex: 1, justifyContent: 'center', padding: 24 },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  labelCard: { width: '100%', borderWidth: 1, borderRadius: 24, padding: 20, gap: 12 },
  labelTitle: { fontFamily: MONO, fontSize: 10, letterSpacing: 3 },
  labelWeight: {
    fontFamily: MONO,
    fontSize: 32,
    fontVariant: ['tabular-nums'],
  },
  labelInput: {
    borderBottomWidth: 1,
    paddingVertical: 10,
    fontFamily: MONO,
    fontSize: 16,
  },
  labelActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  labelBtnGhost: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 999,
  },
  labelBtnGhostText: { fontFamily: MONO, fontSize: 11, letterSpacing: 2 },
  labelBtnSolid: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 999 },
  labelBtnSolidText: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
  },
});
