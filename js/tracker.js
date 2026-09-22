/* Tracker — live GPS session: start / stop / new, real-time stats, persistence.
   Full-resolution points are kept in memory for the rolling-window maths;
   only a decimated trace is written to storage. */
var Tracker = (function () {
  'use strict';

  var UI_TICK_MS = 500;
  var LAST_WINDOW_SEC = 60;
  var CHECKPOINT_MS = 10000;   // worst case lost to a kill: ten seconds of running
  var ACQUIRING = 'Acquiring GPS…';

  var session = null;   // active in-memory run
  var watchId = null;
  var tickId = null;
  var checkpointId = null;
  var checkpointing = false;
  var checkpointQueued = false;
  var lastSaved = null;

  var dom = {};

  /* Every readout the Tracker can show, in canonical order. Settings picks which of
     them appear; the order is fixed so the layout does not shuffle under you. */
  var TILES = [
    { key: 'elapsed',  label: 'Elapsed',       big: true, idle: '0:00' },
    { key: 'distance', label: 'Distance',      big: true, idle: '0.00', unit: 'km' },
    { key: 'avgPace',  label: 'Avg pace',      idle: '--:--', unit: '/km' },
    { key: 'lastPace', label: 'Last min pace', idle: '--:--', unit: '/km' },
    { key: 'speed',    label: 'Speed',         idle: '0.0',   unit: 'km/h' },
    { key: 'cadence',  label: 'Cadence',       idle: '--',    unit: 'spm' },
    { key: 'ascent',   label: 'Ascent',        idle: '--',    unit: 'm' }
  ];

  function tileDefs() { return TILES.slice(); }

  function selectedTiles() {
    var want = Settings.tileList();
    var picked = TILES.filter(function (t) { return want.indexOf(t.key) > -1; });
    return picked.length ? picked : TILES.slice(0, 2);   // never render an empty grid
  }

  /** Build the grid from the chosen readouts. Cheap, so it can simply be rebuilt. */
  function renderTiles() {
    var host = UI.$('#sessionTiles');
    if (!host) return;
    UI.clear(host);
    dom.tile = {};
    selectedTiles().forEach(function (t) {
      var value = UI.el('span', { class: 'stat-value' });
      UI.setStat(value, t.idle, t.unit);
      host.appendChild(UI.el('div', { class: 'stat' + (t.big ? ' stat-lg' : '') }, [
        UI.el('span', { class: 'stat-label', text: t.label }),
        value
      ]));
      dom.tile[t.key] = value;
    });
    if (session) render();
  }

  function cacheDom() {
    dom.state = UI.$('#gpsState');
    dom.msg = UI.$('#trackerMsg');
    dom.btnStart = UI.$('#btnStart');
    dom.btnStop = UI.$('#btnStop');
    dom.btnNew = UI.$('#btnNew');
    dom.summary = UI.$('#lastRunSummary');
    dom.summaryGrid = UI.$('#lastRunGrid');
    dom.summaryRoute = UI.$('#lastRunRoute');
    dom.btnPocket = UI.$('#btnPocket');
  }

  /** The two figures worth showing on a locked screen. */
  function liveFigures() {
    if (!session) return { elapsed: '0:00', distance: '0.00 km' };
    return {
      elapsed: Utils.formatDuration(elapsedSec()),
      distance: Utils.formatKm(session.distance) + ' km'
    };
  }

  function newSession() {
    return {
      id: Utils.uuid(),
      startTs: Date.now(),      // wall clock of the original Start — the run's date
      elapsedBase: 0,           // active seconds banked by earlier segments
      segmentStartTs: Date.now(),
      points: [],               // {lat,lng,alt,t,acc,cum}, t = active seconds
      cadenceSamples: [],       // {t, spm}
      distance: 0,
      lastFix: null,
      instantSpeed: 0,
      fixes: 0,
      rejected: 0
    };
  }

  /**
   * Active seconds, not wall-clock since Start. The two differ after a recovery: the
   * stretch where the app was dead has no GPS behind it, so counting it as running
   * time would stretch the duration and flatten the pace with a gap we know nothing
   * about. It is banked as a pause instead.
   */
  function elapsedSec() {
    if (!session) return 0;
    return session.elapsedBase + (Date.now() - session.segmentStartTs) / 1000;
  }

  /* ------------------------------ geolocation --------------------------- */

  function onPosition(pos) {
    if (!session) return;
    var c = pos.coords;
    session.fixes++;

    var threshold = parseInt(Settings.get('accuracyThresholdM'), 10) || 20;
    var acc = (c.accuracy === null || c.accuracy === undefined) ? 0 : c.accuracy;

    if (acc > threshold) {
      session.rejected++;
      // Too fuzzy to trust: counting it would inflate distance while standing still.
      return;
    }

    var t = Math.max(0, session.elapsedBase + (pos.timestamp - session.segmentStartTs) / 1000);
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
    if (!session || !dom.tile) return;
    var el = elapsedSec();
    // Speed decays to 0 if no fix has landed for a while.
    var stale = session.lastFix && (Date.now() - session.lastFix) > 10000;
    var cad = Cadence.current();

    var values = {
      elapsed: [Utils.formatDuration(el), ''],
      distance: [Utils.formatKm(session.distance), 'km'],
      avgPace: [Utils.formatPace(Utils.paceFrom(session.distance, el)), '/km'],
      lastPace: [Utils.formatPace(lastMinutePace()), '/km'],
      speed: [Utils.formatSpeed(stale ? 0 : session.instantSpeed), 'km/h'],
      cadence: [cad.spm ? String(Math.round(cad.spm)) : '--', 'spm']
    };
    if (dom.tile.ascent) {
      var elev = Utils.computeElevation(session.points);
      values.ascent = [elev.samples ? '+' + elev.gainM : '--', 'm'];
    }

    for (var key in values) {
      if (dom.tile[key]) UI.setStat(dom.tile[key], values[key][0], values[key][1]);
    }
    recordCadence(el, cad);
  }

  /* One cadence reading every few seconds is plenty for the chart, and keeps the
     stored series comparable in size to the decimated GPS trace. */
  var CADENCE_SAMPLE_SEC = 5;
  function recordCadence(elapsed, reading) {
    if (!session || !reading.spm) return;
    var series = session.cadenceSamples;
    if (series.length && elapsed - series[series.length - 1].t < CADENCE_SAMPLE_SEC) return;
    series.push({ t: Math.round(elapsed), spm: Math.round(reading.spm) });
  }

  function setState(kind, label) {
    dom.state.className = 'pill ' + (kind === 'live' ? 'pill-live' : kind === 'warn' ? 'pill-warn' : 'pill-idle');
    dom.state.textContent = label;
  }

  function setButtons(active) {
    dom.btnStart.disabled = active;
    dom.btnStop.disabled = !active;
    dom.btnNew.disabled = !active && !lastSaved;
    // Locking is only meaningful over a run in progress — there is nothing to protect
    // otherwise, and no way to get the screen back that is not just "unlock".
    if (dom.btnPocket) dom.btnPocket.disabled = !active;
  }

  /* ----------------------------- crash safety --------------------------- */

  /**
   * Write the session to storage. Called on a timer, and — more importantly — the
   * moment the page is hidden or being torn down, which is when a mistouch, an
   * incoming call or the system reclaiming memory would otherwise take the run with
   * it. The whole raw trace goes in: a recovered run should be as good as one that
   * was never interrupted.
   */
  function checkpoint() {
    if (!session) return Promise.resolve();
    if (checkpointing) {
      // A write is already in flight. Never drop this request — the one that gets
      // dropped is the `visibilitychange` checkpoint, the one the whole feature
      // exists for. Queue a follow-up instead so the final state always lands.
      checkpointQueued = true;
      return Promise.resolve();
    }
    checkpointing = true;

    // `points` is copied, not referenced: the write completes a tick or more later,
    // and a live array would keep growing in the meantime, storing a trace that does
    // not match the distance and duration recorded beside it.
    var record = {
      runId: session.id,
      startTs: session.startTs,
      elapsedSec: elapsedSec(),
      distance: session.distance,
      points: session.points.slice(),
      cadenceSamples: session.cadenceSamples.slice(),
      fixes: session.fixes,
      rejected: session.rejected,
      savedAt: Date.now()
    };

    return DB.saveLive(record)
      .catch(function () { /* a failed checkpoint must never disturb the run */ })
      .then(function () {
        checkpointing = false;
        if (checkpointQueued) {
          checkpointQueued = false;
          return checkpoint();
        }
      });
  }

  /** Anything worth offering back to the user? */
  function isRecoverable(record) {
    if (!record || !record.savedAt) return false;
    return (record.points && record.points.length >= 2) || record.elapsedSec >= 15;
  }

  /** The stored checkpoint, if there is one worth resuming. */
  function pendingRecovery() {
    return DB.loadLive().then(function (record) {
      if (!record) return null;
      if (!isRecoverable(record)) {           // a stray Start with nothing behind it
        DB.clearLive();
        return null;
      }
      return record;
    });
  }

  /** Rebuild the in-memory session from a checkpoint and carry on tracking. */
  function resume(record) {
    if (session) return;
    session = {
      id: record.runId || Utils.uuid(),
      startTs: record.startTs || Date.now(),
      elapsedBase: record.elapsedSec || 0,   // the dead stretch counts as a pause
      segmentStartTs: Date.now(),
      points: (record.points || []).slice(),
      cadenceSamples: (record.cadenceSamples || []).slice(),
      distance: record.distance || 0,
      lastFix: null,
      instantSpeed: 0,
      fixes: record.fixes || 0,
      rejected: record.rejected || 0
    };
    lastSaved = null;
    dom.summary.hidden = true;
    UI.message(dom.msg, 'Run recovered — ' + Utils.formatKm(session.distance) + ' km at ' +
      Utils.formatDuration(session.elapsedBase) + ' carried over. Tracking again.', 'ok', 12000);
    beginWatching();
  }

  /** Finish a checkpointed run without resuming it, as if Stop had been pressed. */
  function finishRecovered(record) {
    var s = {
      id: record.runId || Utils.uuid(),
      startTs: record.startTs || Date.now(),
      elapsedBase: record.elapsedSec || 0,
      segmentStartTs: Date.now(),            // banks zero extra time
      points: (record.points || []).slice(),
      cadenceSamples: (record.cadenceSamples || []).slice(),
      distance: record.distance || 0,
      fixes: record.fixes || 0,
      rejected: record.rejected || 0
    };
    var run = finalize(s);
    return DB.put(run).then(function () {
      DB.clearLive();
      lastSaved = run;
      dom.btnNew.disabled = false;
      showSummary(run, s);
      UI.message(dom.msg, 'Recovered run saved — ' + Utils.formatKm(run.distanceMeters) +
        ' km in ' + Utils.formatDuration(run.durationSec) + '.', 'ok', 9000);
      return run;
    });
  }

  function discardRecovery() {
    return DB.clearLive();
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
    UI.message(dom.msg, ACQUIRING);
    beginWatching();
  }

  /** Everything a session needs running, whether freshly started or recovered. */
  function beginWatching() {
    setState('warn', 'acquiring');
    setButtons(true);
    render();

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });

    tickId = setInterval(render, UI_TICK_MS);
    checkpointId = setInterval(checkpoint, CHECKPOINT_MS);

    // Started from the Start/Resume tap, which is the user gesture iOS demands
    // before it will hand over motion data at all.
    if (Settings.get('cadence')) Cadence.start();
    checkpoint();               // one immediately, so even an instant kill leaves a trace

    WakeLock.acquire('tracker').then(function (s) {
      if (!session) return;      // already stopped: don't overwrite the closing message
      // This is a soft warning and it resolves late, so it must not talk over
      // something more important that is already on screen — the recovery notice.
      if (dom.msg.textContent && dom.msg.textContent !== ACQUIRING) return;
      if (!s && WakeLock.supported()) {
        UI.message(dom.msg, 'Screen wake lock refused — the screen may sleep during the run.', '');
      }
    });
  }

  function teardown() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
    if (checkpointId) { clearInterval(checkpointId); checkpointId = null; }
    Cadence.stop();
    WakeLock.release('tracker');
  }

  function averageCadence(samples) {
    if (!samples || !samples.length) return 0;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i].spm;
    return Math.round(sum / samples.length);
  }

  /** Build the persisted record from the in-memory session. */
  function finalize(s) {
    var durationSec = Math.round(s.elapsedBase + (Date.now() - s.segmentStartTs) / 1000);
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
      cadenceAvgSpm: averageCadence(s.cadenceSamples),
      cadenceSamples: (s.cadenceSamples || []).slice(),
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
      DB.clearLive();
      UI.message(dom.msg, 'Nothing to save — no GPS fix in ' + run.durationSec + ' s.', '', 8000);
      dom.btnNew.disabled = true;
      return Promise.resolve(null);
    }

    return DB.put(run).then(function () {
      DB.clearLive();            // it is a finished run now, not a recoverable one
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
      run.cadenceAvgSpm ? ['Avg cadence', run.cadenceAvgSpm + ' spm'] : null,
      ['Stored points', String(run.points.length) + (rawSession ? ' of ' + rawSession.points.length : '')]
    ];
    if (run.place && run.place.commune) rows.splice(3, 0, ['Commune', Geocode.label(run.place)]);
    if (rawSession && rawSession.rejected) {
      rows.push(['Fixes ignored', rawSession.rejected + ' (low accuracy)']);
    }
    rows.filter(Boolean).forEach(function (r) {
      dom.summaryGrid.appendChild(UI.el('div', {}, [
        UI.el('span', { text: r[0] }),
        UI.el('span', { text: r[1] })
      ]));
    });

    UI.clear(dom.summaryRoute);
    var route = RouteView.figure(run);
    if (route) dom.summaryRoute.appendChild(route);

    dom.summary.hidden = false;
  }

  /** Discard the live session (if any) and reset the view for a fresh one. */
  function fresh() {
    var doReset = function () {
      teardown();
      session = null;
      DB.clearLive();
      lastSaved = null;
      setState('idle', 'idle');
      setButtons(false);
      dom.summary.hidden = true;
      UI.message(dom.msg, '');
      renderTiles();          // rebuilds every chosen tile at its idle value
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
    renderTiles();
    document.addEventListener('settings-changed', renderTiles);
    setButtons(false);
    dom.btnStart.addEventListener('click', start);
    dom.btnStop.addEventListener('click', function () { stop(false); });
    dom.btnNew.addEventListener('click', fresh);
    if (dom.btnPocket) dom.btnPocket.addEventListener('click', function () { Pocket.lock(); });

    // The moments a run gets lost: switching away (the mistouch case), the tab being
    // frozen or discarded, or the page going away. Checkpoint at every one of them —
    // `visibilitychange` is the important one, since it still has time to finish the
    // write, whereas a tab being killed outright does not.
    document.addEventListener('visibilitychange', function () {
      if (session && document.visibilityState === 'hidden') checkpoint();
    });
    window.addEventListener('pagehide', function () { if (session) checkpoint(); });
    if ('onfreeze' in document) {
      document.addEventListener('freeze', function () { if (session) checkpoint(); });
    }

    // Belt and braces: the checkpoint means a reload no longer loses the run, but a
    // deliberate warning still beats an accidental navigation.
    window.addEventListener('beforeunload', function (ev) {
      if (session) { ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  return {
    init: init, start: start, stop: stop, fresh: fresh, isActive: isActive,
    checkpoint: checkpoint, pendingRecovery: pendingRecovery, isRecoverable: isRecoverable,
    resume: resume, finishRecovered: finishRecovered, discardRecovery: discardRecovery,
    tileDefs: tileDefs, renderTiles: renderTiles, liveFigures: liveFigures
  };
})();
