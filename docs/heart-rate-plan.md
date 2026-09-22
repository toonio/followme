# Heart rate monitor — plan (not built)

**Status: waiting on hardware.** No strap owned yet, so nothing is implemented. This
file exists so none of the groundwork has to be redone when one arrives.

Everything below marked *verified* was actually checked; everything marked *unverified*
needs the real device.

## Verdict

Feasible, and easier than the cadence work, because the Bluetooth SIG standardised the
profile — there is no vendor protocol to reverse-engineer. Read the standard BLE
**Heart Rate Service `0x180D`** and subscribe to notifications on the **Heart Rate
Measurement characteristic `0x2A37`**. Straps notify about once a second, so there is no
sampling or filtering problem of the kind cadence had.

## What was verified (2026-09-22, on https://toonio.github.io/followme/)

| Check | Result |
|---|---|
| `navigator.bluetooth` | present |
| `requestDevice` | present |
| `getAvailability()` | `true` — an adapter exists |
| Permissions-Policy `bluetooth` | allowed on our origin |
| Secure context | yes (Pages is HTTPS) |
| `getDevices()` | **undefined** |
| `BluetoothDevice.prototype.watchAdvertisements` | **undefined** |

The last two are the silent-reconnect APIs. Without them the browser's device chooser
has to be opened by a tap every session. They sit behind a flag on desktop Chrome and
are inconsistent on Android, so **design for a "Connect strap" button and treat silent
reconnect as a bonus**, detected at runtime rather than assumed.

## Characteristic layout (`0x2A37`)

```
byte 0   flags
         bit 0     value format   0 = uint8, 1 = uint16
         bits 1-2  sensor contact 0b00/0b01 unsupported, 0b10 no contact, 0b11 contact
         bit 3     energy expended present (uint16 LE, kJ)
         bit 4     RR intervals present (uint16 LE each, units of 1/1024 s)
         bits 5-7  reserved
then     heart rate        uint8 or uint16 LE
then     energy expended   uint16 LE, only if bit 3
then     RR intervals      uint16 LE each, filling the remainder
```

## Parser — written and tested, ready to lift

14 cases pass, including the malformed ones. Drop this into `js/heartrate.js`.

```js
/**
 * Decode a Heart Rate Measurement notification. Returns null for a packet too short
 * to be meaningful; `bpm: 0` with `implausible: true` when the value decodes but
 * cannot be a heart rate (a strap that has lost skin contact sends 0).
 */
function parseHeartRate(view) {
  if (!view || view.byteLength < 2) return null;
  var flags = view.getUint8(0);
  var uint16 = (flags & 0x01) !== 0;
  var offset = 1;

  if (uint16 && view.byteLength < 3) return null;      // truncated
  var bpm = uint16 ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += uint16 ? 2 : 1;

  var contactBits = (flags >> 1) & 0x03;
  var contact = contactBits < 2 ? null : contactBits === 3;

  var energy = null;
  if (flags & 0x08) {
    if (view.byteLength >= offset + 2) { energy = view.getUint16(offset, true); offset += 2; }
    else return { bpm: bpm, contact: contact, energyKJ: null, rr: [] };
  }

  var rr = [];
  if (flags & 0x10) {
    while (offset + 1 < view.byteLength) {
      rr.push(view.getUint16(offset, true) / 1024);    // seconds
      offset += 2;
    }
  }
  if (bpm < 20 || bpm > 250) {
    return { bpm: 0, contact: contact, energyKJ: energy, rr: rr, implausible: true };
  }
  return { bpm: bpm, contact: contact, energyKJ: energy, rr: rr };
}
```

Cases covered: uint8 HR · uint16 little-endian · contact supported+detected ·
supported+not detected · unsupported · energy expended · RR intervals · all flags at
once · resting 48 bpm · empty buffer · flags only · uint16 flagged but truncated ·
zero bpm · energy flagged but absent.

RR intervals are a free bonus where the strap sends them: beat-to-beat timing gives
instantaneous HR (`60 / lastRR`) and HRV. A test packet of `[1.000, 1.031, 0.969] s`
yields 61.9 bpm and an RMSSD of 49.4 ms.

## Connection sketch

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: ['heart_rate'] }],
  optionalServices: ['battery_service']        // strap battery, if wanted
});
const server = await device.gatt.connect();
const service = await server.getPrimaryService('heart_rate');
const char = await service.getCharacteristic('heart_rate_measurement');
await char.startNotifications();
char.addEventListener('characteristicvaluechanged', e => onReading(parseHeartRate(e.target.value)));
device.addEventListener('gattserverdisconnected', onDrop);   // straps do drop
```

## Constraints to design around

- **No iOS, at all.** Web Bluetooth is absent from every iOS browser (all WebKit). This
  would be the first feature that is simply missing there rather than merely unreliable.
  Gate the UI on `navigator.bluetooth` and say so plainly rather than failing silently.
- **Foreground only**, like cadence. Backgrounding suspends the page; a discarded tab
  drops the GATT link. Reconnect on `gattserverdisconnected` rather than assuming the
  link survives.
- **One connection at a time.** If the Polar/Garmin app holds the strap, the browser
  cannot have it. Worth saying in the error message — it is the likeliest failure.
- **Android 11 and below couple BLE scanning to location services**, so the chooser can
  fail with location off. Chrome prompts, but the message is confusing.
- **A dropped strap should blank the readout, not freeze it.** Same rule as cadence:
  stale readings go to `--`, never linger.

## Integration plan

1. `js/heartrate.js` — connect, notifications, reconnect, `current()`, mirroring the
   shape of `js/cadence.js`.
2. Tracker tile `heartRate`, added to the `TILES` registry — it then appears in the
   Settings readout picker automatically.
3. Run record: `hrAvgBpm`, `hrMaxBpm`, `hrSamples: [{t, bpm}]` every ~5 s, matching
   `cadenceSamples`. Add to `js/io.js` `normalize()` and to the live checkpoint.
4. Enlarged view: a third stacked chart, non-zero-based like cadence, sharing the one
   time axis and the existing selection. `seriesChart()` already takes `value`, `unit`,
   `colour`, `zeroBased` and `maxT`, so this is a call, not a rewrite. Pick a line
   colour clear of the speed green `#4cc9a0` and the cadence purple `#c69cf5`.
5. Settings: a Heart rate card with a Connect button, the connected device name, and
   the same honest diagnostics as the cadence sensor check.

## Open questions for when the strap arrives

- Which model, and does it expose RR intervals? (Polar H10 does; cheaper straps often
  do not.) HRV is only worth building if it does.
- Does `navigator.bluetooth.getDevices()` exist on the phone's Chrome? If yes, silent
  reconnect is possible and the connect tap can be skipped on later runs.
- How long does reconnection take after a drop mid-run, and is it reliable enough to
  do automatically or better left to a tap?
- Does the strap keep notifying with the screen on but the app behind the lock screen?
