/**
 * MagSafe Scale — ESP32-C3 BLE Firmware
 * ------------------------------------------------------------------
 * GATT server that streams calibrated weight over Bluetooth LE and
 * accepts tare / unit commands. Implements an idle deep-sleep power
 * saving rule. See ../../bluetooth_protocol.md for the wire spec.
 *
 * Framework : Arduino (arduino-esp32, Bluedroid BLE)
 * Sensor    : HX711 24-bit load-cell ADC (bogde/HX711)
 * Wiring    : DT  -> GPIO2   (LOADCELL_DOUT_PIN)
 *             SCK -> GPIO3   (LOADCELL_SCK_PIN)
 */

#include <Arduino.h>
#include <math.h>
#include "HX711.h"

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include <esp_sleep.h>

// ---------------------------------------------------------------------------
// Hardware pinout
// ---------------------------------------------------------------------------
const int LOADCELL_DOUT_PIN = 2;   // HX711 DT
const int LOADCELL_SCK_PIN  = 3;   // HX711 SCK

// On-board BOOT button on the ESP32-C3-DevKitM-1 (active-low). Used as a
// manual wake source out of deep sleep.
#define WAKE_BUTTON_PIN 9

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
// HX711 reports raw counts; set_scale(factor) divides (raw - offset) by this
// factor to yield grams. The value is load-cell specific.
//
// >>> PLACEHOLDER VALUE — replace with your measured calibration factor. <<<
//
// Calibration procedure:
//   1. Flash with CALIBRATION_FACTOR = 1.0 and an empty platform.
//   2. After boot (auto-tare), place a known reference mass (e.g. 100.0 g).
//   3. Read the raw grams value `R` printed on Serial.
//   4. CALIBRATION_FACTOR = R / known_mass_in_grams.
//   5. Re-flash with that value; the scale should now read the known mass.
const float CALIBRATION_FACTOR = 420.0f;

// ---------------------------------------------------------------------------
// BLE UUIDs — Standard GATT Segmented Architecture
// (shared 128-bit base; 2nd field enumerates service/characteristics)
// ---------------------------------------------------------------------------
#define SERVICE_UUID      "5a3c0001-9b1d-4c8e-8f2a-6e7d4c3b2a10"
#define WEIGHT_CHAR_UUID  "5a3c0002-9b1d-4c8e-8f2a-6e7d4c3b2a10"
#define TARE_CHAR_UUID    "5a3c0003-9b1d-4c8e-8f2a-6e7d4c3b2a10"
#define UNIT_CHAR_UUID    "5a3c0004-9b1d-4c8e-8f2a-6e7d4c3b2a10"
#define BATTERY_CHAR_UUID "5a3c0005-9b1d-4c8e-8f2a-6e7d4c3b2a10"
#define DEVICE_NAME       "MagSafe Scale"

// ---------------------------------------------------------------------------
// Timing & power constants
// ---------------------------------------------------------------------------
const unsigned long WEIGHT_UPDATE_INTERVAL_MS  = 500;                 // 2 Hz stream
const unsigned long BATTERY_UPDATE_INTERVAL_MS = 60UL * 1000UL;       // battery stub @ 1/min
const unsigned long SLEEP_TIMEOUT_MS          = 5UL * 60UL * 1000UL;  // 5 minutes
const uint64_t      IDLE_RECHECK_INTERVAL_S   = 30;                   // periodic re-check
const float         ZERO_THRESHOLD_G          = 0.05f;  // |g| < 0.05 displays as 0.0
const float         GRAMS_TO_OUNCES           = 0.0352739619f;

// ---------------------------------------------------------------------------
// State preserved across deep sleep (lives in RTC memory)
// ---------------------------------------------------------------------------
RTC_DATA_ATTR bool useOunces   = false;  // active display unit
RTC_DATA_ATTR long savedOffset = 0;      // HX711 tare offset
RTC_DATA_ATTR bool haveOffset  = false;  // false only on a cold boot

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
HX711 scale;

BLEServer*         pServer      = nullptr;
BLECharacteristic* pWeightChar  = nullptr;
BLECharacteristic* pTareChar    = nullptr;
BLECharacteristic* pUnitChar    = nullptr;
BLECharacteristic* pBatteryChar = nullptr;  // reserved stub (see loop)
BLEAdvertising*    pAdvertising = nullptr;

bool          deviceConnected   = false;
unsigned long lastWeightUpdateMs = 0;
unsigned long lastBatteryUpdateMs = 0;
unsigned long lastNonZeroMs      = 0;  // last time a load (>= threshold) was seen

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------
void  initBLE();
float readGrams();
void  enterDeepSleep();

// ---------------------------------------------------------------------------
// BLE callbacks
// ---------------------------------------------------------------------------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* /*s*/) override {
    deviceConnected = true;
    Serial.println("[BLE] Client connected");
  }
  void onDisconnect(BLEServer* /*s*/) override {
    deviceConnected = false;
    Serial.println("[BLE] Client disconnected -> re-advertising");
    BLEDevice::startAdvertising();
  }
};

// Tare_Char: any write triggers a tare (0x01 is the documented command).
class TareCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* /*c*/) override {
    scale.tare();
    savedOffset   = scale.get_offset();
    haveOffset    = true;
    lastNonZeroMs = millis();  // user is interacting -> not idle
    Serial.println("[CMD] Tare -> zero reference reset");
  }
};

// Unit_Char: 0x00 = grams, 0x01 = ounces, anything else / empty = toggle.
class UnitCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    uint8_t* data = c->getData();
    size_t   len  = c->getLength();
    if (len == 0 || data == nullptr) {
      useOunces = !useOunces;
    } else if (data[0] == 0x00) {
      useOunces = false;
    } else if (data[0] == 0x01) {
      useOunces = true;
    } else {
      useOunces = !useOunces;
    }
    Serial.printf("[CMD] Unit -> %s\n", useOunces ? "oz" : "g");
  }
};

// ---------------------------------------------------------------------------
// Sensor helpers (Data Acquisition Pipeline)
// ---------------------------------------------------------------------------
/**
 * Executes a blocking, multi-sample read against the HX711 ADC to mitigate 
 * physical analog noise and electrical interference.
 * 
 * Strategy: A 5-sample moving average is accumulated. To prevent firmware stall 
 * conditions during severe hardware disconnects, a 200ms strict timeout is enforced.
 */
float readGrams() {
  if (scale.wait_ready_timeout(200)) {
    return scale.get_units(5);
  }
  Serial.println("[HX711] not ready — check wiring on GPIO2 (DT) / GPIO3 (SCK)");
  return 0.0f;
}

// ---------------------------------------------------------------------------
// BLE setup
// ---------------------------------------------------------------------------
void initBLE() {
  BLEDevice::init(DEVICE_NAME);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  // Weight_Char: Read + Notify
  pWeightChar = pService->createCharacteristic(
      WEIGHT_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pWeightChar->addDescriptor(new BLE2902());  // CCCD for notifications
  pWeightChar->setValue("0.0");

  // Tare_Char: Write
  pTareChar = pService->createCharacteristic(
      TARE_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
  pTareChar->setCallbacks(new TareCallbacks());

  // Unit_Char: Write
  pUnitChar = pService->createCharacteristic(
      UNIT_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
  pUnitChar->setCallbacks(new UnitCallbacks());

  // Battery_Char (STUB): Read + Notify. Hardcoded telemetry for now; see loop().
  pBatteryChar = pService->createCharacteristic(
      BATTERY_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pBatteryChar->addDescriptor(new BLE2902());  // CCCD for notifications
  uint8_t initialBattery = 85;
  pBatteryChar->setValue(&initialBattery, 1);

  pService->start();

  pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising as \"" DEVICE_NAME "\"");
}

// ---------------------------------------------------------------------------
// Deep sleep
// ---------------------------------------------------------------------------
void enterDeepSleep() {
  Serial.println("[POWER] Idle at 0.0 g for 5 min -> entering deep sleep");
  Serial.flush();

  if (pAdvertising) pAdvertising->stop();
  if (pServer)      BLEDevice::deinit(true);  // free BLE radio + memory

  scale.power_down();  // drop HX711 to low-power mode

  // Wake source 1: periodic timer to re-check for a load.
  esp_sleep_enable_timer_wakeup(IDLE_RECHECK_INTERVAL_S * 1000000ULL);

  // Wake source 2: manual BOOT button (active-low) where supported (C3/S3...).
#if defined(SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP) && SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
  esp_deep_sleep_enable_gpio_wakeup((1ULL << WAKE_BUTTON_PIN),
                                    ESP_GPIO_WAKEUP_GPIO_LOW);
#endif

  esp_deep_sleep_start();  // does not return
}

// ---------------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  scale.begin(LOADCELL_DOUT_PIN, LOADCELL_SCK_PIN);
  scale.power_up();
  scale.set_scale(CALIBRATION_FACTOR);

  // Establish or restore the zero reference.
  if (haveOffset) {
    scale.set_offset(savedOffset);  // keep tare across sleep cycles
  } else {
    scale.tare();                   // cold-boot baseline
    savedOffset = scale.get_offset();
    haveOffset  = true;
  }

  // If we woke from the idle timer, probe quickly and go back to sleep while
  // the platform is still empty (keeps the awake window tiny).
  if (cause == ESP_SLEEP_WAKEUP_TIMER) {
    float g = readGrams();
    Serial.printf("[POWER] Timer wake probe = %.1f g\n", g);
    if (fabsf(g) < ZERO_THRESHOLD_G) {
      enterDeepSleep();
    }
  }

  initBLE();
  lastNonZeroMs      = millis();
  lastWeightUpdateMs = 0;
  Serial.println("[BOOT] MagSafe Scale ready");
}

void loop() {
  unsigned long now = millis();

  // --- Battery telemetry STUB (temporary) ----------------------------------
  // TODO: replace the hardcoded 85 % with a real ADC read of the battery
  // voltage divider once that hardware is wired. Notifies once per minute.
  if (pBatteryChar && now - lastBatteryUpdateMs >= BATTERY_UPDATE_INTERVAL_MS) {
    lastBatteryUpdateMs = now;
    uint8_t batteryLevel = 85;  // 85 %
    pBatteryChar->setValue(&batteryLevel, 1);
    if (deviceConnected) {
      pBatteryChar->notify();
    }
    Serial.printf("[BATTERY] %u%% (stub)\n", batteryLevel);
  }

  if (now - lastWeightUpdateMs < WEIGHT_UPDATE_INTERVAL_MS) {
    return;
  }
  lastWeightUpdateMs = now;

  // -------------------------------------------------------------------------
  // Data Streaming Loop & BLE Broadcasting Strategy
  // -------------------------------------------------------------------------
  // 1. Data Ingestion: Acquire the multi-sample calibrated mass.
  float grams = readGrams();

  // 2. Data Transformation: Apply scalar transformations based on active unit state.
  float shown = useOunces ? (grams * GRAMS_TO_OUNCES) : grams;
  
  // 3. Payload Construction: Format the floating point scalar into an ASCII buffer.
  char  buf[16];
  snprintf(buf, sizeof(buf), "%.1f", shown);

  // 4. BLE Publication: Push the buffered string to the Generic Attribute Profile (GATT)
  //    characteristic. If a central device (Mobile App) is connected, emit an async
  //    Notification packet to bypass polling latency.
  pWeightChar->setValue((uint8_t*)buf, strlen(buf));
  if (deviceConnected) {
    pWeightChar->notify();
  }

  // Serial debug (kept for bring-up / monitoring).
  Serial.printf("[WEIGHT] %s %s  (%.1f g raw-cal)\n",
                buf, useOunces ? "oz" : "g", grams);

  // Idle tracking: a load resets the 5-minute countdown.
  if (fabsf(grams) >= ZERO_THRESHOLD_G) {
    lastNonZeroMs = now;
  } else if (now - lastNonZeroMs >= SLEEP_TIMEOUT_MS) {
    enterDeepSleep();
  }
}
