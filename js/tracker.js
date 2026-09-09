/* Tracker — live GPS session: start / stop / new, real-time stats, persistence.
   Full-resolution points are kept in memory for the rolling-window maths;
   only a decimated trace is written to storage. */
var Tracker = (function () {
  'use strict';

  var UI_TICK_MS = 500;
  var LAST_WINDOW_SEC = 60;

  var session = null;   // active in-memory run
  var watchId = null;
  var tickId = null;
  var lastSaved = null;

  var dom = {};

  function cacheDom() {
    dom.elapsed = UI.$('#statElapsed');
    dom.distance = UI.$('#statDistance');
    dom.avgPace = UI.$('#statAvgPace');
    dom.lastPace = UI.$('#statLastPace');
    dom.speed = UI.$('#statSpeed');
    dom.accuracy = UI.$('#statAccuracy');
    dom.ascent = UI.$('#statAscent');
    dom.state = UI.$('#gpsState');
    dom.msg = UI.$('#trackerMsg');
    dom.btnStart = UI.$('#btnStart');
    dom.btnStop = UI.$('#btnStop');
    dom.btnNew = UI.$('#btnNew');
    dom.summary = UI.$('#lastRunSummary');
    dom.summaryGrid = UI.$('#lastRunGrid');
    dom.summaryRoute = UI.$('#lastRunRoute');
  }

  function newSession() {
    return {
      id: Utils.uuid(),
      startTs: Date.now(),
      points: [],       // {lat,lng,alt,t,acc,cum}
      distance: 0,
      lastFix: null,
      instantSpeed: 0,
      fixes: 0,
      rejected: 0
    };
  }

  function elapsedSec() {
    return session ? (Date.now() - session.startTs) / 1000 : 0;
  }

  /* ------------------------------ geolocation --------------------------- */

  function onPosition(pos) {
    if (!session) return;
    var c = pos.coords;
    session.fixes++;

    var threshold = parseInt(Settings.get('accuracyThresholdM'), 10) || 20;
    var acc = (c.accuracy === null || c.accuracy === undefined) ? 0 : c.accuracy;
    setAccuracy(acc);

    if (acc > threshold) {
      session.rejected++;
      // Too fuzzy to trust: counting it would inflate distance while standing still.
      return;
    }

    var t = Math.max(0, (pos.timestamp - session.startTs) / 1000);
    var point = {
      lat: c.latitude,
      lng: c.longitude,
      alt: (c.altitude === null || c.altitude === undefined) ? null : c.altitude,
      altAcc: (c.altitudeAccuracy === null || c.altitudeAccuracy === undefined) ? null : c.altitudeAccuracy,
      t: t,
      acc: acc,
      cum: session.distance
    };

    var prev = session.points[session.points.length - 1];
    if (prev) {
      var dt = point.t - prev.t;
      if (dt <= 0) return;               // duplicate / out-of-order fix
      var d = Utils.haversine(prev, point);
      session.distance += d;
      point.cum = session.distance;
      session.instantSpeed = (c.speed !== null && c.speed !== undefined && c.speed >= 0)
        ? c.speed
        : d / dt;
    } else {
      session.instantSpeed = (c.speed !== null && c.speed !== undefined && c.speed >= 0) ? c.speed : 0;
    }

    session.points.push(point);
    session.lastFix = Date.now();
    setState('live', 'tracking');
    render();
  }

  function onGeoError(err) {
    var text;
    if (err.code === 1) text = 'Location permission denied — allow it in the browser site settings, then press Start again.';
    else if (err.code === 2) text = 'Position unavailable. Check that location is enabled on the device.';
    else if (err.code === 3) text = 'Waiting for a GPS fix…';
    else text = 'Geolocation error: ' + (err.message || 'unknown');
    UI.message(dom.msg, text, err.code === 3 ? '' : 'err');
    if (err.code === 1 && session) stop(true);
  }

  /* -------------------------------- stats ------------------------------- */

  /** Pace over the trailing 60 s, computed from the raw in-memory trace. */
  function lastMinutePace() {
    if (!session || session.points.length < 2) return 0;
    var pts = session.points;
    var last = pts[pts.length - 1];
    var windowStart = elapsedSec() - LAST_WINDOW_SEC;

    var startIdx = 0;
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i].t <= windowStart) { startIdx = i; break; }
    }
    var from = pts[startIdx];
    var dist = last.cum - from.cum;
    var time = last.t - from.t;
    if (time < 15 || dist < 10) return 0;
    return Utils.paceFrom(dist, time);
  }

  function render() {
    if (!session) return;
    var el = elapsedSec();
    UI.setText(dom.elapsed, Utils.formatDuration(el));
    UI.setStat(dom.distance, Utils.formatKm(session.distance), 'km');
    UI.setStat(dom.avgPace, Utils.formatPace(Utils.paceFrom(session.distance, el)), '/km');
    UI.setStat(dom.lastPace, Utils.formatPace(lastMinutePace()), '/km');

    // Speed decays to 0 if no fix has landed for a while.
    var stale = session.lastFix && (Date.now() - session.lastFix) > 10000;
    UI.setStat(dom.speed, Utils.formatSpeed(stale ? 0 : session.instantSpeed), 'km/h');

    var elev = Utils.computeElevation(session.points);
    UI.setStat(dom.ascent, elev.samples ? '+' + elev.gainM : '--', 'm');
  }

  function setAccuracy(acc) {
    UI.setStat(dom.accuracy, acc ? Math.round(acc) : '--', 'm');
  }

  function setState(kind, label) {
    dom.state.className = 'pill ' + (kind === 'live' ? 'pill-live' : kind === 'warn' ? 'pill-warn' : 'pill-idle');
    dom.state.textContent = label;
  }

  function setButtons(active) {
    dom.btnStart.disabled = active;
    dom.btnStop.disabled = !active;
    dom.btnNew.disabled = !active && !lastSaved;
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function start() {
    if (session) return;
    if (!navigator.geolocation) {
      UI.message(dom.msg, 'This browser has no Geolocation API — GPS tracking is unavailable.', 'err');
      return;
    }

    session = newSession();
    lastSaved = null;
    dom.summary.hidden = true;
    UI.message(dom.msg, 'Acquiring GPS…');
    setState('warn', 'acquiring');
    setButtons(true);
    render();

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });

    tickId = setInterval(render, UI_TICK_MS);

    WakeLock.acquire('tracker').then(function (s) {
      if (!session) return;      // already stopped: don't overwrite the closing message
      if (!s && WakeLock.supported()) {
        UI.message(dom.msg, 'Screen wake lock refused — the screen may sleep during the run.', '');
      }
    });
  }

  function teardown() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
    WakeLock.release('tracker');
  }

  /** Build the persisted record from the in-memory session. */
  function finalize(s) {
    var durationSec = Math.round((Date.now() - s.startTs) / 1000);
    var decimateSec = parseInt(Settings.get('decimateSec'), 10) || 4;
    var elev = Utils.computeElevation(s.points);
    return {
      id: s.id,
      date: new Date(s.startTs).toISOString(),
      durationSec: durationSec,
      distanceMeters: Math.round(s.distance),
      avgPaceSecPerKm: Math.round(Utils.paceFrom(s.distance, durationSec)),
      // Computed here, from the full-resolution trace — the decimated one that gets
      // stored has too few samples to smooth honestly.
      elevationGainM: elev.gainM,
      elevationLossM: elev.lossM,
      place: null,
      points: Utils.decimate(s.points, decimateSec),
      splits: Utils.computeSplits(s.points)
    };
  }

  function stop(silent) {
    if (!session) return Promise.resolve(null);
    var s = session;
    session = null;
    teardown();
    setState('idle', 'idle');

    var run = finalize(s);
    setButtons(false);

    // A stray Start→Stop that never got a fix is not a run. Saving it would leave a
    // 0 km entry dragging the averages down and a blank day marker on the calendar.
    if (!run.points.length && run.durationSec < 15) {
      UI.message(dom.msg, 'Nothing to save — no GPS fix in ' + run.durationSec + ' s.', '', 8000);
      dom.btnNew.disabled = true;
      return Promise.resolve(null);
    }

    return DB.put(run).then(function () {
      lastSaved = run;
      dom.btnNew.disabled = false;
      showSummary(run, s);
      resolvePlace(run, s);          // fire and forget: the run is already saved
      if (!silent) {
        UI.message(dom.msg, 'Run saved — ' + Utils.formatKm(run.distanceMeters) + ' km in ' +
          Utils.formatDuration(run.durationSec) + '.', 'ok', 6000);
      }
      return run;
    }).catch(function (err) {
      UI.message(dom.msg, 'Could not save the run: ' + (err.message || err), 'err');
      return null;
    });
  }

  /**
   * Name the commune the run started in. Deliberately after the save and off the
   * critical path: no network, no permission and no patience is required for the run
   * itself to be stored — this only decorates it.
   */
  function resolvePlace(run, rawSession) {
    if (!Settings.get('placeLookup')) return;
    var origin = Geocode.runOrigin(run);
    if (!origin) return;

    Geocode.reverse(origin.lat, origin.lng).then(function (place) {
      if (!place) return;
      return DB.get(run.id).then(function (stored) {
        var target = stored || run;
        target.place = place;
        return DB.put(target).then(function () {
          if (lastSaved && lastSaved.id === target.id) {
            lastSaved = target;
            showSummary(target, rawSession);
          }
        });
      });
    }).catch(function () { /* offline or blocked: the run keeps its empty place */ });
  }

  function showSummary(run, rawSession) {
    UI.clear(dom.summaryGrid);
    var rows = [
      ['Distance', Utils.formatKm(run.distanceMeters) + ' km'],
      ['Duration', Utils.formatDuration(run.durationSec)],
      ['Avg pace', Utils.formatPace(run.avgPaceSecPerKm) + ' /km'],
      ['Ascent / descent', '+' + (run.elevationGainM || 0) + ' / -' + (run.elevationLossM || 0) + ' m'],
      ['Stored points', String(run.points.length) + (rawSession ? ' of ' + rawSession.points.length : '')]
    ];
    if (run.place && run.place.commune) rows.splice(3, 0, ['Commune', Geocode.label(run.place)]);
    if (rawSession && rawSession.rejected) {
      rows.push(['Fixes ignored', rawSession.rejected + ' (low accuracy)']);
    }
    rows.forEach(function (r) {
      dom.summaryGrid.appendChild(UI.el('div', {}, [
        UI.el('span', { text: r[0] }),
        UI.el('span', { text: r[1] })
      ]));
    });

    UI.clear(dom.summaryRoute);
    var route = UI.routeSvg(run.points, { width: 320, height: 150 });
    if (route) dom.summaryRoute.appendChild(route);

    dom.summary.hidden = false;
  }

  /** Discard the live session (if any) and reset the view for a fresh one. */
  function fresh() {
    var doReset = function () {
      teardown();
      session = null;
      lastSaved = null;
      setState('idle', 'idle');
      setButtons(false);
      dom.summary.hidden = true;
      UI.message(dom.msg, '');
      UI.setText(dom.elapsed, '0:00');
      UI.setStat(dom.distance, '0.00', 'km');
      UI.setStat(dom.avgPace, '--:--', '/km');
      UI.setStat(dom.lastPace, '--:--', '/km');
      UI.setStat(dom.speed, '0.0', 'km/h');
      UI.setStat(dom.accuracy, '--', 'm');
      UI.setStat(dom.ascent, '--', 'm');
    };

    if (session) {
      UI.confirm('Discard session?', 'The current session has not been saved. Discard it and start over?', 'Discard')
        .then(function (ok) { if (ok) doReset(); });
    } else {
      doReset();
    }
  }

  function isActive() { return !!session; }

  function init() {
    cacheDom();
    setButtons(false);
    dom.btnStart.addEventListener('click', start);
    dom.btnStop.addEventListener('click', function () { stop(false); });
    dom.btnNew.addEventListener('click', fresh);

    // A page unload mid-session would silently lose the run.
    window.addEventListener('beforeunload', function (ev) {
      if (session) { ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  return { init: init, start: start, stop: stop, fresh: fresh, isActive: isActive };
})();
