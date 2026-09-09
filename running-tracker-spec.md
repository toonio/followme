# Running Tracker — Project Spec

A static, client-only web app for logging running sessions via phone GPS. No backend, no server-side database — everything lives in the browser.

## Architecture

- **Static page**: plain HTML/CSS/JS (or a small bundle), deployable as-is to any static host (or opened locally as a single file).
- **No server**: no API calls, no accounts, no login.
- **Storage**: browser-only, via `localStorage` or `IndexedDB` (see Data Model below). Data never leaves the device unless exported.
- **Pages/views** (can be tabs within one page, or separate routes):
  1. Tracker (start/stop/new run, Deezer playlist embed, interval timer — see Features below; timer and GPS tracker are independent tools usable together or separately)
  2. Stats (global + weekly/monthly, chart-based)
  3. Calendar (visual run history)
  4. Settings (Deezer playlist ID, interval timer config, export/import)

## Data Model

Stored as JSON, one record per run:

```json
{
  "id": "uuid",
  "date": "2026-09-09T07:32:00Z",
  "durationSec": 1830,
  "distanceMeters": 5120,
  "avgPaceSecPerKm": 357,
  "points": [
    { "lat": 43.123, "lng": 5.456, "t": 0, "alt": 12 },
    { "lat": 43.124, "lng": 5.457, "t": 5, "alt": 13 }
  ],
  "splits": [
    { "km": 1, "sec": 340 }
  ]
}
```

- `points`: raw GPS trace, used for distance calc and (optionally) a route preview. Can get large for long runs — `IndexedDB` handles this better than `localStorage` if traces are kept in full.
- **Decision**: store a **decimated** version of `points` (e.g., one point per 3–5 sec, or simplified via Douglas-Peucker) to keep storage lean. Full-resolution traces are only kept transiently in memory during the live session (see real-time stats below), not persisted.

**Storage choice**: `IndexedDB` recommended over `localStorage` — no ~5–10MB ceiling, better suited to many runs with full GPS traces, still 100% client-side (this is *not* a server database, just a browser-native structured store).

## Features

### 1. GPS Tracker (start / stop / new)
- `navigator.geolocation.watchPosition()` to stream position updates during a session.
- **Start**: begin `watchPosition`, initialize timer, create new in-memory run object.
- **Stop**: clear `watchPosition`, finalize duration/distance/pace, persist run to storage.
- **New**: reset in-memory state to start a fresh session (separate from "start" if you want a distinct "discard current, begin another" action).
- Distance calculated client-side via Haversine formula between consecutive points.
- Handle GPS inaccuracy: consider ignoring points with high `accuracy` values (e.g., > 20m) to avoid distance drift while stationary.
- **Real-time stats displayed during a session**:
  - Elapsed time (running clock since start)
  - Distance so far (running total)
  - Pace — both **global average pace** (total distance / total elapsed time) and **last-minute pace** (recomputed from points within the trailing 60-second window)
  - Speed (instantaneous — from the most recent point-to-point delta, or from `coords.speed` if the browser reports it)
- Last-minute pace needs a rolling window: keep raw, non-decimated points in memory for the live session so the short-window calc stays accurate; decimate only when the run is persisted to storage.

### 2. Wake Lock (stay awake during session)
- `navigator.wakeLock.request('screen')` when a session starts; `.release()` on stop.
- Must re-acquire on `visibilitychange` (lock is auto-released when tab is backgrounded, e.g., brief app switch).
- Requires HTTPS if hosted; works for local testing in most browsers.
- Best support: Chrome/Chromium on Android. iOS Safari support is inconsistent — flag this as a known limitation given the Android use case already discussed.

### 3. Stats Page
- **Global**: total distance, total time, total runs, average pace, longest run, etc.
- **Per week / per month**: group stored runs by ISO week and by calendar month, show the same metrics per bucket.
- All computed client-side from the stored run list — no aggregation needed at storage time, just derive on render (fine at personal-use scale).
- **Decision**: charts, not just raw numbers — e.g., a bar chart for distance and/or pace per week/month. Lightweight enough to hand-roll with SVG or a small chart lib.

### 4. Calendar View
- Month grid, one cell per day; days with a run get a marker (dot, distance badge, etc.).
- Clicking a day shows that day's run(s) detail (distance, duration, pace, maybe route preview).
- Pure client-side calendar logic — no library strictly required, though a lightweight one can save time.

### 5. Export / Import (run database)
- **Export**: serialize all stored runs to a single JSON file, trigger download via a `Blob` + temporary `<a download>` link.
- **Import**: file `<input type="file">`, read via `FileReader`, parse JSON, merge or replace into `IndexedDB`.
- Recommended: on import, dedupe by `id` and let the user choose "merge" vs "replace all".
- This export file *is* the backup/portability mechanism — since there's no server database, it's also the only way to move data between devices or browsers.

### 6. Deezer Playlist Embed
- **Placement**: embedded directly on the **Tracker page** (alongside real-time stats), so music stays visible/controllable during a run — not tucked away in Settings.
- User sets the playlist ID once in Settings (stored in `localStorage`); the Tracker page reads it to render the iframe.
- Rendered as an iframe:
  ```html
  <iframe src="https://widget.deezer.com/widget/dark/playlist/{PLAYLIST_ID}"
          width="100%" height="300" frameborder="0" allowtransparency="true" allow="encrypted-media"></iframe>
  ```
- Known limitations (carried over from earlier discussion): 30-second previews without a logged-in Premium session inside the widget; autoplay often blocked on mobile, requiring a manual tap; adds an external dependency mid-run. Fine as a "pick music before/after" widget; not recommended as the sole music source during tracking.

### 7. Configurable Interval Timer (series/rest)
- Settings: number of rounds, work duration, rest duration (e.g., 3 min work / 1 min rest × N).
- Countdown driven by `setInterval` or, more precisely, by timestamp diffing against `Date.now()` (to avoid drift from tab throttling).
- Sound alert: use the Web Audio API (`AudioContext` + oscillator, or a short preloaded audio file) to beep at transitions (work → rest, rest → work, session end).
- Should work concurrently with GPS tracking (e.g., interval-based track workouts logged as a single run).
- Respect the same wake-lock as the GPS tracker so the screen doesn't sleep mid-series.

## Tech Stack Summary

| Concern            | Approach                                  |
|--------------------|--------------------------------------------|
| Hosting             | Static host (or local file) — no backend  |
| Storage             | IndexedDB (JSON run records)              |
| GPS                 | Geolocation API (`watchPosition`)         |
| Stay awake          | Screen Wake Lock API                      |
| Stats/Calendar      | Derived client-side from stored runs      |
| Backup              | Manual JSON export/import                 |
| Music               | Deezer widget iframe (playlist only)      |
| Interval timer      | Timestamp-based countdown + Web Audio API |
| Real-time stats     | In-memory rolling window (last-minute pace, speed) |

## Decisions

- GPS traces: decimated for storage (not full-resolution).
- Interval timer and GPS tracker: independent tools, usable together or separately.
- Stats visual style: charts.
- Offline/PWA support: **Tier 0 — none**. No manifest, no service worker. The app is used as a local file (or opened while online if hosted); all tracking, storage, wake lock, and timer features already work offline once the page is loaded, since none of them depend on a network call.
