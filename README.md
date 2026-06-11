# Smarter Scale Rev 1.0

![Smarter Scale](https://via.placeholder.com/1200x400?text=Smarter+Scale+Rev+1.0)

A custom hardware ecosystem and React Native mobile application for a highly portable, MagSafe-compatible smart scale. This project combines a custom 2-layer carrier board, ESP32-C3-Mini microarchitecture, and a seamless Bluetooth Low Energy (BLE) frontend to create an ultra-thin, highly responsive macro scale.

## Table of Contents
1. [System Overview & Problem Statement](#system-overview--problem-statement)
2. [Technical Architecture](#technical-architecture)
3. [Engineering Decisions](#engineering-decisions)
4. [Deployment Guide](#deployment-guide)

---

## 1. System Overview & Problem Statement

**The Problem:** Traditional smart scales and kitchen macro scales are bulky, inherently non-portable, and rely on cumbersome physical interfaces. For fitness enthusiasts and mobile professionals, carrying a standard scale is impractical.

**The Solution:** Smarter Scale Rev 1.0 solves this by bridging custom miniaturized hardware with a modern mobile frontend. Designed to snap directly onto the back of an iPhone via a MagSafe-compatible magnetic ring, the scale offers an ultra-thin profile without sacrificing measurement accuracy. The entire physical UI has been eliminated—calibration, taring, and unit switching are all handled wirelessly through the React Native app.

---

## 2. Technical Architecture

The Smarter Scale ecosystem is divided into two primary subsystems: the ESP32 Hardware Firmware and the React Native Mobile Client.

### Hardware Stack
- **Microcontroller:** ESP32-C3-Mini (RISC-V architecture)
- **ADC / Load Cell Driver:** HX711 24-Bit Analog-to-Digital Converter
- **Power Management:** TP4056 Lithium Battery Charger IC
- **Communication:** Bluetooth Low Energy (BLE) GATT Server

### Software Stack
- **Firmware:** C++/Arduino (ESP32 Core)
- **Frontend:** React Native (Expo)
- **BLE Library:** `react-native-ble-plx`

### Data Flow
1. The **HX711** samples the load cell at a high frequency and passes raw differential data to the ESP32.
2. The **ESP32-C3** applies calibration factors, applies noise-filtering, and structures a string payload: `W:150.5|B:85`.
3. The payload is **Base64 encoded** and published to a custom BLE Characteristic every ~200ms.
4. The **React Native** app subscribes to this characteristic, decodes the stream in real-time, and reactively updates the UI via isolated state hooks (`useBLE.js`) to prevent main-thread blockage.

---

## 3. Engineering Decisions

Designing a precision analog instrument in a highly compact, wireless form factor required strict electronic design considerations:

#### 1. 0.6mm Power Traces
To ensure safe and reliable current capacity—especially during peak Wi-Fi/BLE transmission bursts from the ESP32—the primary power traces from the TP4056 and the LiPo battery were routed at a minimum of `0.6mm` width. This prevents localized heating and voltage drops that could disrupt the highly sensitive HX711 ADC.

#### 2. C1 Decoupling Capacitor
The ESP32-C3 exhibits significant current spikes (up to 300mA+) during wireless transmission. A large `C1` bulk decoupling capacitor was placed directly adjacent to the ESP32's power input pins to act as a localized energy reservoir, preventing catastrophic brownouts or MCU resets during these transmission spikes.

#### 3. Ground Plane Isolation
Because the HX711 operates at 24-bit resolution, it is extremely susceptible to electromagnetic interference (EMI). To isolate the analog signals from the noisy digital and RF switching of the ESP32, strict ground planes were utilized on the 2-layer board. Additionally, this layout mitigates induced noise from the physical MagSafe magnetic array housed in the chassis.

---

## 4. Deployment Guide

### Mobile Application (React Native / Expo)
1. Navigate to the `mobile-app` directory:
   ```bash
   cd mobile-app
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the Expo development server:
   ```bash
   npm run start
   ```
4. **iOS Compilation:** To build a native IPA or run on a physical iOS device, use `expo prebuild` and compile via Xcode, ensuring that Bluetooth permissions (`NSBluetoothAlwaysUsageDescription`) are configured in `Info.plist`.

### ESP32 Firmware
1. Navigate to the `esp32-firmware` directory.
2. Open the project in the Arduino IDE or PlatformIO.
3. Select the **ESP32C3 Dev Module** as the target board.
4. Compile and flash via USB.

---

*Designed and engineered by Qusai Altair.*
