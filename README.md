# Running Tracker

**Live app: <https://toonio.github.io/followme/>**

Static, client-only running tracker built to [`running-tracker-spec.md`](running-tracker-spec.md).
No backend, no accounts, no network calls except the optional Deezer widget.
Runs are stored in the browser (IndexedDB) and never leave the device unless you export them.

Because the data lives in the browser, each device and each browser keeps its own separate
history — use the JSON export/import in Settings to move runs between them.

## Run it

Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8123
```

Then browse to `http://localhost:8123`.

Deploy by copying the folder to any static host. **Use HTTPS on a real host** — the
Geolocation and Wake Lock APIs only work in a secure context (`localhost` and `file://`
count as secure for local testing).

## Layout

| File | Role |
|------|------|
| `index.html` | All four views (Tracker, Stats, Calendar, Settings) as tabs |
| `css/styles.css` | Dark, mobile-first styling |
| `js/utils.js` | Haversine, formatting, ISO week/month keys, Douglas-Peucker, splits |
| `js/settings.js` | Config in `localStorage` |
| `js/db.js` | IndexedDB run store (falls back to `localStorage`) |
| `js/ui.js` | DOM helpers, modal, route-preview SVG |
| `js/wakelock.js` | Reference-counted Screen Wake Lock |
| `js/timer.js` | Interval timer + Web Audio beeps |
| `js/tracker.js` | GPS session, live stats, persistence |
| `js/charts.js` | Hand-rolled SVG bar chart |
| `js/stats.js` | Global + weekly/monthly aggregation and rendering |
| `js/calendar.js` | Month grid and day detail |
| `js/io.js` | JSON export / import |
| `js/app.js` | Tab routing, timer UI, Deezer embed, settings form |

Plain classic scripts on purpose — no build step, and ES modules would be blocked when
the page is opened from `file://`.

## Features

**Tracker** — `watchPosition` streams fixes; distance comes from Haversine between
consecutive points. Fixes reported with an accuracy worse than the threshold (20 m by
default) are discarded so a stationary phone does not accumulate drift. Live readouts:
elapsed, distance, global average pace, trailing-60-second pace, instantaneous speed
(`coords.speed` when the browser provides it, otherwise the last point-to-point delta)
and current GPS accuracy.

- **Start** begins a session and requests the wake lock.
- **Stop** ends it, computes duration/distance/pace/splits and saves the run.
- **New** discards the in-memory session (with a confirmation) and resets the view.

The live trace is kept at full resolution in memory so the rolling-window pace stays
honest; only a decimated trace is written to storage — one point every N seconds
(4 by default) then Douglas-Peucker simplified at ~4 m. A 20-minute run typically
shrinks from ~1200 fixes to ~50 stored points (a few KB).

**Interval timer** — configurable rounds × work/rest, independent of the GPS tracker;
either can run alone or both together. The countdown is derived from `Date.now()`
diffing rather than accumulated ticks, so a throttled background tab cannot make it
drift, and it catches up correctly after the tab is restored. There is no rest after the
final round, and settings edited mid-series are adopted at the next reset rather than
reshaping the set you are already running. It holds the same wake lock as the tracker.

Transitions are announced by Web Audio beeps, each a square-wave fundamental with a sine
an octave above it, run hot through a limiter so they cut through wind and traffic:

| Event | Signature |
|-------|-----------|
| End of work (into rest) | 5 quick beeps, 1046 Hz, 0.14 s apart |
| End of rest (into work) | 3 spaced beeps, 1568 Hz, 0.30 s apart |
| Series complete | rising 1046 → 1319 → 1760 Hz, last one held |

They are distinguishable by count, rhythm and pitch together, so you can tell them apart
without looking at the phone. **Test** in Settings plays both transition signatures back
to back. Beeps use the media volume, and the audio context is unlocked by the tap on
Start, so mobile autoplay policies do not silence them.

**Stats** — all-time totals plus weekly (ISO week) and monthly buckets, everything
derived on render from the stored runs. Bar charts for distance, time, pace or run count;
the pace chart uses a non-zero baseline so differences are visible and skips empty
buckets. Below the chart, a per-bucket table and the recent-run list (with delete).

**Calendar** — Monday-first month grid, a distance badge on every day with a run, today
outlined. Tap a day for its runs: time, distance, duration, pace, per-km splits and a
route preview drawn from the stored trace.

**Backup** — export writes every run to one JSON file; import reads it back and offers
*merge* (dedupe by `id`, existing runs kept) or *replace all*. Since there is no server,
this file is the only backup and the only way to move data between devices or browsers.

**Music** — the Deezer playlist widget is embedded on the Tracker page so it stays
reachable mid-run. Set the playlist ID (or paste a playlist URL) in Settings.

## Known limitations

- Wake lock is reliable on Chrome/Chromium for Android; iOS Safari support is
  inconsistent. The lock is re-acquired on `visibilitychange` after a brief app switch.
- The Deezer widget gives 30-second previews even for Premium subscribers. Your session
  is a first-party cookie on `deezer.com`; inside an iframe on this app's origin it is a
  third-party context, and browsers now partition or block those cookies — so the widget
  sees an anonymous listener. Serving over HTTPS and allowing third-party cookies for the
  site can help, but it is unreliable on mobile. The **Open in the Deezer app** button
  under the widget is the dependable route to full-length playback: start the playlist
  there, then come back to the tracker tab. Autoplay is also usually blocked on mobile.
- No PWA: no manifest, no service worker (Tier 0, per the spec). Tracking, storage, wake
  lock and the timer all keep working offline once the page is loaded, because none of
  them touch the network.
- Reloading or closing the tab mid-session loses that session (the browser shows a
  confirmation prompt first).

## Data model

```json
{
  "id": "uuid",
  "date": "2026-09-09T07:32:00.000Z",
  "durationSec": 1830,
  "distanceMeters": 5120,
  "avgPaceSecPerKm": 357,
  "points": [{ "lat": 43.123, "lng": 5.456, "t": 0, "alt": 12 }],
  "splits": [{ "km": 1, "sec": 340 }]
}
```

`.claude/launch.json` is only a convenience config for serving the folder locally; it is
not used by the app.
