/**
 * ============================================================================
 * Smarter Scale Rev 1.0 - Bluetooth Low Energy (BLE) Operations & State Management
 * ============================================================================
 * 
 * Overview:
 * This module encapsulates the asynchronous data streaming protocol established 
 * between the React Native frontend and the ESP32-C3-Mini microarchitecture.
 * 
 * BLE State Management:
 * The hook implements a strictly structured finite state machine (FSM) utilizing
 * the `react-native-ble-plx` library. State transitions (IDLE -> SCANNING -> 
 * CONNECTING -> CONNECTED) are asynchronously controlled, guaranteeing 
 * resilient reconnection protocols upon arbitrary signal degradation.
 * 
 * Async Characteristic Subscriptions:
 * Upon connection, the module performs peripheral discovery and binds a
 * persistent listener to the generic GATT characteristic. Incoming payloads
 * are base64 encoded by the ESP32 to maintain transmission integrity.
 * 
 * UI Data-Binding:
 * The data ingestion pipeline intercepts the structured payload (e.g. `W:150.5|B:85`), 
 * decodes the base64 string, and propagates atomic updates to the React context. 
 * This decoupled architecture allows for pure reactive UI renders without 
 * blocking the main JavaScript execution thread.
 * 
 * @module useBLE
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State as BleState } from 'react-native-ble-plx';

/* ─── ESP32 BLE identifiers ─── */
const DEVICE_NAME = 'MagSafe Scale';
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const SCAN_TIMEOUT_MS = 12000;

/* ─── Connection status enum ─── */
export const BLE_STATUS = Object.freeze({
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
});

/* ─── Base64 → UTF-8 string decoder ─── */
function decodeBase64(base64) {
  if (!base64) return null;
  try {
    // Hermes / modern RN has global.atob
    if (typeof global.atob === 'function') return global.atob(base64);
  } catch { /* fall through */ }
  // Manual fallback
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < base64.length; i++) {
    const c = base64[i];
    if (c === '=') break;
    const idx = chars.indexOf(c);
    if (idx === -1) continue;
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Parse "W:150.5|B:85" into { weight, battery }.
 * Returns null when the payload is invalid.
 */
function parsePayload(base64Value) {
  const raw = decodeBase64(base64Value)?.trim();
  if (!raw) return null;

  let weight = null;
  let battery = null;

  for (const segment of raw.split('|')) {
    const part = segment.trim();
    if (part.startsWith('W:')) {
      const w = parseFloat(part.slice(2));
      if (!Number.isNaN(w)) weight = w;
    } else if (part.startsWith('B:')) {
      const b = parseInt(part.slice(2), 10);
      if (!Number.isNaN(b)) battery = Math.max(0, Math.min(100, b));
    }
  }

  return weight !== null || battery !== null ? { weight, battery } : null;
}

/* ─── Permission helper ─── */
async function requestBlePermissions() {
  if (Platform.OS === 'ios') return true; // iOS handled by Info.plist
  if (Platform.OS !== 'android') return true;

  const wanted = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ].filter(Boolean);

  const result = await PermissionsAndroid.requestMultiple(wanted);
  return Object.values(result).every(
    (s) => s === PermissionsAndroid.RESULTS.GRANTED,
  );
}

/* ════════════════════════════════════════════════════════════════════
 *  HOOK
 * ════════════════════════════════════════════════════════════════════ */

export default function useBLE() {
  /* ── Singleton BleManager (survives re-renders) ── */
  const [manager] = useState(() => {
    try {
      return new BleManager();
    } catch (e) {
      console.warn('[useBLE] BleManager init failed:', e?.message);
      return null;
    }
  });

  /* ── State exposed to the consumer ── */
  const [weight, setWeight] = useState(0);          // grams (float)
  const [battery, setBattery] = useState(null);      // 0-100 (int) or null
  const [status, setStatus] = useState(BLE_STATUS.IDLE);
  const [deviceName, setDeviceName] = useState(null);
  const [error, setError] = useState(null);          // latest error string

  /* ── Internal refs ── */
  const deviceRef = useRef(null);
  const monitorRef = useRef(null);
  const disconnectSubRef = useRef(null);
  const scanTimeoutRef = useRef(null);
  const scanActiveRef = useRef(false);
  const connectingRef = useRef(false);

  /* ── Helpers ── */
  const stopScan = useCallback(() => {
    if (!manager || !scanActiveRef.current) return;
    scanActiveRef.current = false;
    try { manager.stopDeviceScan(); } catch { /* ok */ }
  }, [manager]);

  const cleanup = useCallback(() => {
    stopScan();
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    monitorRef.current?.remove();
    monitorRef.current = null;
    disconnectSubRef.current?.remove();
    disconnectSubRef.current = null;
    connectingRef.current = false;
    deviceRef.current = null;
  }, [stopScan]);

  /* ── Start monitoring the weight characteristic ── */
  const startMonitor = useCallback(
    (device) => {
      monitorRef.current?.remove();
      monitorRef.current = device.monitorCharacteristicForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        (err, char) => {
          if (err) {
            console.warn('[useBLE] monitor error:', err.message);
            setError(`Sensor: ${err.message}`);
            return;
          }
          const parsed = parsePayload(char?.value);
          if (!parsed) return;
          if (parsed.weight !== null) setWeight(parsed.weight);
          if (parsed.battery !== null) setBattery(parsed.battery);
        },
      );
    },
    [],
  );

  /* ── Connect to a discovered device ── */
  const connectToDevice = useCallback(
    async (device) => {
      connectingRef.current = true;
      stopScan();
      if (scanTimeoutRef.current) {
        clearTimeout(scanTimeoutRef.current);
        scanTimeoutRef.current = null;
      }

      const name = device.name || device.localName || 'Scale';
      setStatus(BLE_STATUS.CONNECTING);
      setDeviceName(name);
      setError(null);

      try {
        const connected = await device.connect();
        await connected.discoverAllServicesAndCharacteristics();
        deviceRef.current = connected;

        // Auto-reconnect awareness
        disconnectSubRef.current = manager.onDeviceDisconnected(
          connected.id,
          () => {
            setError('Scale disconnected, reconnecting...');
            cleanup();
            setStatus(BLE_STATUS.IDLE);
            setDeviceName(null);
            // AUTO RECONNECT: trigger a new scan
            setTimeout(() => {
              connect();
            }, 1000);
          },
        );

        setStatus(BLE_STATUS.CONNECTED);
        setError(null);
        startMonitor(connected);
      } catch (e) {
        setError(`Connect failed: ${e?.message ?? 'unknown'}`);
        cleanup();
        setStatus(BLE_STATUS.IDLE);
        // AUTO RECONNECT: retry if connect failed
        setTimeout(() => {
          connect();
        }, 2000);
      }
    },
    [manager, cleanup, startMonitor, stopScan],
  );

  /* ══════════════════════════════════════════════════
   *  PUBLIC: scan + connect
   * ══════════════════════════════════════════════════ */
  const connect = useCallback(async () => {
    if (!manager) {
      setError('BLE unavailable — rebuild dev client');
      return;
    }

    const granted = await requestBlePermissions();
    if (!granted) {
      setError('Bluetooth permission denied');
      return;
    }

    const adapterState = await manager.state();
    if (adapterState !== BleState.PoweredOn) {
      setError('Turn on Bluetooth');
      return;
    }

    // Tear down any previous connection
    cleanup();
    setStatus(BLE_STATUS.SCANNING);
    setError(null);

    scanActiveRef.current = true;
    connectingRef.current = false;

    manager.startDeviceScan(
      [SERVICE_UUID],            // Filter purely by Service UUID at the OS level
      { allowDuplicates: false },// No need for duplicates if we filter by UUID
      (err, device) => {
        if (err) {
          scanActiveRef.current = false;
          setError(`Scan: ${err.message}`);
          setStatus(BLE_STATUS.IDLE);
          return;
        }
        
        // --- DEBUG LOGGING ---
        console.log(`[BLE DEBUG] Found matching UUID! Name: ${device?.name || device?.localName || 'null'}`, {
          id: device?.id,
        });

        if (connectingRef.current) return; // already connecting

        // Since we filtered by SERVICE_UUID at the scan level, any device that 
        // triggers this callback IS our ESP32. Stop scanning and connect!
        connectToDevice(device);
      },
    );

    // No scan timeout. We want it to scan continuously until it finds the scale.
  }, [manager, cleanup, connectToDevice, stopScan]);

  /* ══════════════════════════════════════════════════
   *  PUBLIC: disconnect
   * ══════════════════════════════════════════════════ */
  const disconnect = useCallback(async () => {
    const device = deviceRef.current;
    try {
      if (device) await manager?.cancelDeviceConnection(device.id);
    } catch { /* already gone */ }
    cleanup();
    setStatus(BLE_STATUS.IDLE);
    setDeviceName(null);
    setError(null);
  }, [manager, cleanup]);

  /* ── Lifecycle: auto-connect on mount/powered on & destroy manager on unmount ── */
  useEffect(() => {
    if (!manager) return undefined;

    const sub = manager.onStateChange((state) => {
      if (state === BleState.PoweredOff) setError('Bluetooth is off');
      else if (state === BleState.Unauthorized) setError('Bluetooth denied');
      else if (state === BleState.PoweredOn) {
        setError(null);
        connect(); // Auto-start scanning when powered on
      }
    }, true);

    return () => {
      sub.remove();
      cleanup();
      const dev = deviceRef.current;
      if (dev) manager.cancelDeviceConnection(dev.id).catch(() => {});
      manager.destroy();
    };
  }, [manager, cleanup, connect]);

  /* ── Return the public API ── */
  return {
    // State
    weight,        // number — current weight in grams
    battery,       // number|null — battery percentage (0–100)
    status,        // 'idle' | 'scanning' | 'connecting' | 'connected'
    deviceName,    // string|null — e.g. "MagSafe Scale"
    error,         // string|null — latest error message

    // Derived booleans (convenience)
    isConnected: status === BLE_STATUS.CONNECTED,
    isScanning: status === BLE_STATUS.SCANNING,

    // Actions
    connect,       // () => Promise<void>  — scan + auto-connect
    disconnect,    // () => Promise<void>  — tear down
  };
}
