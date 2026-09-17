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
| `js/geocode.js` | Reverse geocoding: coordinate to commune name |
| `js/ui.js` | DOM helpers, modal, route SVG and the speed ramp |
| `js/routeview.js` | Route thumbnail and the linked map + speed chart |
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
and ascent. The accuracy figure is not shown — it is not actionable mid-run; the saved
run reports how many fixes were discarded instead.

Their size is set in **Settings → Session display** (`--session-scale`, 100–200%,
default 115%), scoped to the tracker so the Stats page keeps its base sizes.

The grid reflows with the type rather than clipping it. The column minimum is derived
from the widest value the tracker can show — elapsed past an hour, `1:07:32`, which
measures 103 px per 100% of scale — so two columns survive exactly as long as that value
fits, and the grid drops to one when it stops fitting. Tabular figures mean a 3-hour run
is no wider than a 1-hour one. On a phone the page, card, gap and tile padding are
trimmed (8/8/6/8 px against 14/14/10/12) to buy that width back: on a 393 px screen —
a 1080 px panel at 2.75× — **150% still holds two columns**, with 161 px of text room
against the 154 px needed, and the Start/Stop buttons stay above the fold. 155% and up
stack into one column. Above 480 px the original spacing is untouched.

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

**Elevation** — cumulative ascent and descent, from the altitudes the GPS already
reports. Raw altitude is far noisier than position, so summing every delta would invent
hundreds of metres on flat ground; instead the series is smoothed over a 15-sample
moving average and changes only count once they clear a 4 m hysteresis band. Measured
against synthetic profiles at ±8 m of noise: a flat 10-minute run reports ~10–20 m
instead of the 1650 m a naive sum would claim, a real 100 m hill reads 96–98 m, and
200 m of rollers read ~180 m. The bias is deliberately downward — gentle undulations
are under-counted by roughly a quarter, which is the price of not inventing climb on the
flat. A phone with a barometer will do better than one without. D+ shows live during a
session, on the saved run, per day, and per week/month in the stats.

**Commune** — the name of the municipality a run started in, resolved once when the run
is saved and then stored on it. This is the app's **only data request**, and a deliberate
exception to the spec's no-API rule: a commune cannot be derived from a coordinate
offline without shipping a boundary dataset. It is narrow by construction — the start
point is rounded to about 100 m before it is sent, the answer is cached on the run so it
is never asked twice, failure is silent (the run is already saved), and the whole thing
is one checkbox in Settings. [BAN](https://adresse.data.gouv.fr/) (the French government
address base) is asked first and returns the INSEE code; Nominatim covers runs outside
France. Runs saved with mobile data off keep an empty commune until **Fill gaps** in
Settings resolves them.

**Stats** — all-time totals plus weekly (ISO week) and monthly buckets, everything
derived on render from the stored runs. Bar charts for distance, time, pace or run count;
the pace chart uses a non-zero baseline so differences are visible and skips empty
buckets, plus ascent. Below the chart, a per-bucket table and the recent-run list
(with commune, D+ and delete).

**Calendar** — Monday-first month grid, a distance badge on every day with a run, today
outlined. Tap a day for its runs: time, distance, duration, pace, per-km splits and the
route trace.

**Route trace** — the stored trace is drawn coloured by speed, segment by segment, from
the time and distance between consecutive stored points. Decimation is not a problem
here: points sit a few seconds apart, which is a longer baseline than a single fix and
therefore a *steadier* speed estimate than raw fixes would give.

Tap the trace (or focus it and press Enter) to open the enlarged view: the map with
`Start`/`Finish` labelled, and a **speed chart** underneath. The two are projections of
the same samples — click anywhere on the chart (or use ← →) and the picked sample gets a
rule and a dot on the chart, a ring on the map, and a readout of its time, distance,
speed and pace. The chart is a plain line in the app's accent, not the ramp: the y
position already says how fast, so colouring it too would re-encode what the shape shows.
Both viewBoxes shrink on narrow screens, otherwise a 640-wide viewBox squeezed into a
300px phone renders 10px type at under 5px.

The colour is a sequential encoding, so it follows the rule for one: a single hue,
monotone lightness — never a rainbow. The five steps are blue 100/200/350/450/550 running
**light = slow → dark = fast**, chosen against this app's own surface rather than by eye
and checked with the palette validator: the darkest step clears 2.39:1 on `#1c232c`, and
every adjacent pair clears ΔL 0.06, so all five read apart.

Be aware of what that direction costs on a dark surface: the *fastest* stretches sit at
2.39:1 while the slowest glow at 11.96:1, so the eye is drawn to the slow parts — the
reverse of the usual dark-mode anchoring, where magnitude rises toward the brighter end.
On a test run where 43 of 65 segments were fast, the 21 slow ones still dominated the
picture. Swap `SPEED_RAMP` in `js/ui.js` to flip it back.

The scale is clipped to the run's 5th–95th percentile so one GPS glitch cannot own both
ends, and a minimum span stops a steady run from being stretched across the whole ramp to
display noise as variation. The legend is labelled in pace at both ends, and start/finish
are marked by *shape*, not colour — the colour channel is spoken for.

**Backup** — export writes every run to one JSON file; import reads it back and offers
*merge* (dedupe by `id`, existing runs kept) or *replace all*. Since there is no server,
this file is the only backup and the only way to move data between devices or browsers.

**Music** — the Deezer playlist widget is embedded on the Tracker page so it stays
reachable mid-run. Set the playlist ID (or paste a playlist URL) in Settings.

**The bottom bar and the URL bar** — Chrome on Android anchors `position: fixed` to the
*layout* viewport, which keeps the height it has with the URL bar hidden. Scroll up, the
URL bar slides back in, the visible area shrinks, and a `bottom: 0` bar is left sitting
below it with only its top half showing. The Visual Viewport API reports that gap;
`js/app.js` publishes it as `--chrome-gap`, and the tab bar lifts by it while the
full-screen dialogs — clipped by the same chrome — inset by it. A keyboard-sized gap
(over 180 px) is deliberately ignored: correcting for it would fling the tab bar up onto
the keyboard, over the field being typed into.

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
- GPS altitude is the weak input behind D+. The filtering above keeps it sane, but treat
  the number as an estimate: expect it to run low on gently rolling ground, and to differ
  from what a barometric watch reports.
- The commune is where the run *started*. A run crossing into the next commune is still
  filed under the first one.

## Data model

```json
{
  "id": "uuid",
  "date": "2026-09-09T07:32:00.000Z",
  "durationSec": 1830,
  "distanceMeters": 5120,
  "avgPaceSecPerKm": 357,
  "elevationGainM": 117,
  "elevationLossM": 119,
  "place": {
    "commune": "Toulon",
    "postcode": "83000",
    "insee": "83137",
    "source": "ban",
    "at": "2026-09-09T07:35:12.000Z"
  },
  "points": [{ "lat": 43.123, "lng": 5.456, "t": 0, "alt": 12 }],
  "splits": [{ "km": 1, "sec": 340 }]
}
```

`place` is `null` until it is resolved, and older exports without the new fields import
cleanly — elevation defaults to 0 and the commune to none.

`.claude/launch.json` is only a convenience config for serving the folder locally; it is
not used by the app.
