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
| `js/db.js` | IndexedDB run store + live-session checkpoints (falls back to `localStorage`) |
| `js/geocode.js` | Reverse geocoding: coordinate to commune name |
| `js/cadence.js` | Steps per minute from the accelerometer |
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

**Which readouts appear is yours to choose** — Settings → Session display lists all
seven (elapsed, distance, average pace, last-minute pace, speed, cadence, ascent) and the
grid is built from whatever is ticked. The order is fixed so the layout never shuffles
under you mid-run, and the last box cannot be unticked: a Tracker page with nothing on it
is not a state worth supporting.

Their size is set in the same place (`--session-scale`, 100–200%, default 115%), scoped
to the tracker so the Stats page keeps its base sizes.

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

**A run in progress survives the app dying.** It is checkpointed to its own IndexedDB
store every 10 seconds, and — the case that actually matters — the moment the page is
hidden, frozen or unloaded, which is what a mistouch, an incoming call or the system
reclaiming memory looks like. The worst a hard kill can cost is the last 10 seconds.
Nothing about this is configurable; it is not a feature to opt into.

On the next launch an unfinished run is offered back: **Resume** picks up tracking where
it left off, **Save it** files it as a finished run, **Discard** deletes it behind a
confirmation. Dismissing the dialog keeps the checkpoint, so a stray tap cannot lose the
run either — the offer simply returns next time.

Resuming treats the dead stretch as a **pause**, not as running time. Elapsed is
therefore accumulated active seconds rather than wall-clock since Start: there is no GPS
behind the gap, so counting it would stretch the duration and flatten the pace with data
that does not exist. The dialog says how long ago the last checkpoint was, since that is
the fact that decides whether you are still out running or looking at this the next
morning.

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

**Cadence** — steps per minute from the accelerometer, live on the Tracker, averaged
onto the saved run, and charted in the enlarged route view.

The sample rate was never the constraint: a running cadence is 2.2–3.4 Hz and browsers
deliver 50–60 Hz, so there is an order of magnitude spare. Measured against synthetic
running signals, the detector lands within ~1 spm at 25 Hz and above, and within 1.3 spm
even at 16 Hz.

The constraint is the **octave**. Arm swing happens once per *stride* — half the cadence
— and with the phone in a hand it is the strongest thing in the signal. Correlating the
raw stream locks onto it and reports half the true cadence with total confidence, and it
cannot be rescued afterwards by checking the half-lag, because at that lag the arm swing
is in antiphase and actively cancels the step. So the stride is filtered out *before*
correlating: a band-pass confined to the running band, built from **three** stacked
moving-average high-pass stages. One stage is not enough — measured, it keeps 0.86 of a
1.43 Hz stride against 1.12 of a 2.87 Hz step, a ratio of 1.3 that a hand-swung phone
beats easily; three stages take that ratio to 2.44, which is what makes the hand-held
case work at all.

What it will not do is guess. The window is 8 s (4 s minimum), the search runs wider than
the reported 130–220 spm band so an out-of-band peak is *seen* and rejected rather than
clamped onto the edge, and a correlation peak below 0.35 reports nothing. Standing still,
a jostled phone, road vibration in a car and walking at 110 spm are all correctly silent.

Two practical limits. Motion events stop when the page is not in front, so cadence pauses
if you switch away — distance keeps accruing, cadence does not. And iOS gates motion
behind a permission prompt that needs a user tap, which the Start button provides.
**Settings → Cadence → Check sensor** measures what your phone actually delivers: which
API, the real sample rate, and a live reading if you jog on the spot.

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
`Start`/`Finish` labelled, then a **speed chart**, then a **cadence chart** when the run
has cadence. Cadence gets its own plot rather than a second y-axis on the speed one —
two measures at different scales sharing an axis is the classic way to make a chart say
whatever you like; stacked plots on a common time axis compare honestly. Speed is
zero-based because standing still is a real zero; cadence is not, because every running
cadence sits in a narrow band and a zero baseline would flatten the whole run into a line.

All of it is one selection: click either chart (or use ← →) and the picked moment gets a
rule and dot on both charts, a ring on the map, and a readout of time, distance, speed,
pace and cadence. How close a click must land to count as "that moment" comes from each
series' own spacing rather than a fixed number of seconds — the decimated GPS trace can
have samples half a minute apart on a straight road while cadence lands every five — and
the same decision drives both the marker and the readout, so the two can never disagree.
The chart lines are plain, not the map's ramp: the y position already says how fast, so
colouring them too would re-encode what the shape shows.
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

## Planned

**Heart rate** from a Bluetooth chest strap, over Web Bluetooth and the standard BLE
Heart Rate Service. Not built — no strap owned yet. The groundwork is done and written
up in [`docs/heart-rate-plan.md`](docs/heart-rate-plan.md): what was verified about the
browser's Bluetooth support, the characteristic layout, a parser tested against 14 cases
including malformed packets, the connection sketch, and the constraints (absent from
every iOS browser, foreground only, one connection at a time).

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
- A hard kill can still cost the last few seconds of a run — up to the 10-second
  checkpoint interval, less if the browser gave the page a chance to run its hide
  handler. The `beforeunload` prompt is kept as a second line of defence.
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
