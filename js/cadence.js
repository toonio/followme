/* Cadence — steps per minute from the phone's accelerometer.
 *
 * Why this works at all: running cadence is 2.2–3.4 Hz, and browsers deliver motion
 * samples at 50–60 Hz, so there is an order of magnitude of headroom. The sample rate
 * was never the difficulty.
 *
 * The difficulty is the octave. Arm swing happens once per *stride* — half the
 * cadence — and when the phone is in a hand it is the strongest thing in the signal.
 * Correlating the raw stream locks onto it and reports half the true cadence with
 * complete confidence, and it cannot be rescued afterwards by testing the half-lag:
 * at that lag the arm-swing component is in antiphase and actively cancels the step.
 * So the stride is filtered out *before* correlating, and the search is confined to
 * the band a running cadence can actually occupy.
 */
var Cadence = (function () {
  'use strict';

  var WINDOW_SEC = 8;         // correlation window
  var MIN_WINDOW_SEC = 4;     // below this there is not enough signal to lock on
  var MIN_SPM = 130;          // reported band: a running cadence
  var MAX_SPM = 220;
  var SEARCH_MIN_SPM = 110;   // searched wider, so a peak below the band is *seen*
  var SEARCH_MAX_SPM = 235;   // and rejected, instead of being clamped onto the edge
  var MIN_CONFIDENCE = 0.35;  // below this it is noise, not running — see calibration
  var RECOMPUTE_MS = 1000;

  var buffer = [];            // { t: ms, m: acceleration magnitude }
  var sensor = null;
  var motionHandler = null;
  var running = false;
  var api = null;             // 'sensor' | 'devicemotion'
  var firstSampleAt = 0;
  var sampleCount = 0;
  var lastComputeAt = 0;
  var last = { spm: 0, confidence: 0, at: 0 };

  /* ------------------------------- maths -------------------------------- */

  /** Trailing moving average. Causal, so it delays the signal — harmless here,
      since autocorrelation is shift invariant. */
  function movavg(x, L) {
    if (L < 2) return x.slice();
    var out = new Array(x.length);
    var sum = 0;
    for (var i = 0; i < x.length; i++) {
      sum += x[i];
      if (i >= L) sum -= x[i - L];
      out[i] = sum / Math.min(i + 1, L);
    }
    return out;
  }

  /* Three high-pass stages, not one. A single moving-average subtraction has a very
     gentle roll-off: measured against the two components that matter, it keeps 0.86 of
     a 1.43 Hz stride and 1.12 of a 2.87 Hz step — a ratio of 1.3, which a hand-swung
     phone beats easily. Stacking three stages takes that ratio to 2.44 and is what
     makes the hand-held case work. */
  var HP_STAGES = 3;

  function hpWindow(hz) {
    return Math.max(2, Math.round(0.44 * hz / ((MIN_SPM / 60) * 0.85)));
  }

  /** Keep only the band a running cadence can occupy; the stride sits below it. */
  function bandpass(x, hz) {
    var lpCut = (MAX_SPM / 60) * 1.6;
    var L = hpWindow(hz);
    var y = x;
    for (var stage = 0; stage < HP_STAGES; stage++) {
      var base = movavg(y, L);
      var hp = new Array(y.length);
      for (var i = 0; i < y.length; i++) hp[i] = y[i] - base[i];
      y = hp;
    }
    return movavg(y, Math.max(1, Math.round(0.44 * hz / lpCut)));
  }

  /**
   * Dominant periodicity of a magnitude series, as steps per minute.
   * `samples` is plain numbers sampled at `hz`. Returns null when the window is too
   * short or nothing periodic is in the band.
   */
  function analyse(samples, hz) {
    var raw = samples.length;
    if (!raw || raw < hz * MIN_WINDOW_SEC) return null;
    var i;

    // Centre first. The high-pass is a trailing moving average, so feeding it a large
    // DC offset (gravity) leaves a big transient over its first window — which then
    // dominates the correlation and buries the real signal.
    var dc = 0;
    for (i = 0; i < raw; i++) dc += samples[i];
    dc /= raw;
    var centred = new Array(raw);
    for (i = 0; i < raw; i++) centred[i] = samples[i] - dc;

    var filtered = bandpass(centred, hz);

    // Drop the filter's warm-up, where the moving average is still averaging fewer
    // samples than its window and the output is not yet meaningful.
    var warmup = Math.min(raw - 1, hpWindow(hz) * HP_STAGES);
    var x = filtered.slice(warmup);
    var n = x.length;
    if (n < hz * (MIN_WINDOW_SEC - 1)) return null;

    var mean = 0;
    for (i = 0; i < n; i++) mean += x[i];
    mean /= n;
    var c = new Array(n);
    for (i = 0; i < n; i++) c[i] = x[i] - mean;

    function acf(k) {
      var s = 0;
      for (var j = 0; j + k < n; j++) s += c[j] * c[j + k];
      return s / (n - k);
    }
    var r0 = acf(0);
    if (!r0) return null;

    var kMin = Math.max(1, Math.floor(hz * 60 / SEARCH_MAX_SPM));
    var kMax = Math.ceil(hz * 60 / SEARCH_MIN_SPM);
    if (kMax >= n - 2) kMax = n - 3;
    if (kMax <= kMin) return null;

    var best = kMin, bestV = -Infinity;
    for (var k = kMin; k <= kMax; k++) {
      var v = acf(k) / r0;
      if (v > bestV) { bestV = v; best = k; }
    }
    if (bestV < MIN_CONFIDENCE) return { spm: 0, confidence: +bestV.toFixed(3) };

    // One lag step is ~10 spm near 170 at 50 Hz — far too coarse to report as-is.
    var ym1 = acf(best - 1) / r0;
    var yp1 = acf(best + 1) / r0;
    var denom = ym1 - 2 * bestV + yp1;
    var shift = denom ? 0.5 * (ym1 - yp1) / denom : 0;
    if (!isFinite(shift)) shift = 0;
    var lag = best + Math.max(-1, Math.min(1, shift));
    var spm = 60 * hz / lag;

    // Found something periodic, but not at a running cadence — walking, or a hand
    // swinging the phone while stopped. Say nothing rather than round it into range.
    if (spm < MIN_SPM || spm > MAX_SPM) return { spm: 0, confidence: +bestV.toFixed(3), outOfBand: true };

    return { spm: spm, confidence: +bestV.toFixed(3) };
  }

  /* ------------------------------ sampling ------------------------------ */

  function push(magnitude, ts) {
    if (!isFinite(magnitude)) return;
    if (!firstSampleAt) firstSampleAt = ts;
    sampleCount++;
    buffer.push({ t: ts, m: magnitude });
    var cutoff = ts - WINDOW_SEC * 1000;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
  }

  /** Effective delivered rate, measured rather than assumed. */
  function bufferHz() {
    if (buffer.length < 2) return 0;
    var span = (buffer[buffer.length - 1].t - buffer[0].t) / 1000;
    return span > 0 ? (buffer.length - 1) / span : 0;
  }

  function recompute(now) {
    var hz = bufferHz();
    if (hz < 8) { last = { spm: 0, confidence: 0, at: now }; return; }
    var result = analyse(buffer.map(function (s) { return s.m; }), hz);
    last = result
      ? { spm: result.spm, confidence: result.confidence, at: now }
      : { spm: 0, confidence: 0, at: now };
  }

  function onSample(magnitude, ts) {
    push(magnitude, ts);
    if (ts - lastComputeAt >= RECOMPUTE_MS) {
      lastComputeAt = ts;
      recompute(ts);
    }
  }

  /* ------------------------------- sources ------------------------------ */

  function supported() {
    return (typeof window.Accelerometer === 'function') ||
           (typeof window.DeviceMotionEvent === 'function');
  }

  /** iOS gates motion behind a permission prompt that needs a user gesture. */
  function requestPermission() {
    var DM = window.DeviceMotionEvent;
    if (DM && typeof DM.requestPermission === 'function') {
      return DM.requestPermission()
        .then(function (state) { return state === 'granted'; })
        .catch(function () { return false; });
    }
    return Promise.resolve(true);
  }

  function startSensorApi() {
    if (typeof window.Accelerometer !== 'function') return false;
    try {
      sensor = new window.Accelerometer({ frequency: 50, referenceFrame: 'device' });
      sensor.addEventListener('reading', function () {
        onSample(Math.sqrt(sensor.x * sensor.x + sensor.y * sensor.y + sensor.z * sensor.z), Date.now());
      });
      sensor.addEventListener('error', function () {
        // Constructed but unreadable (no hardware, or blocked). Fall back, through
        // the permission gate that devicemotion — and only devicemotion — needs.
        stopSensorApi();
        requestPermission().then(function (granted) {
          running = granted ? startDeviceMotion() : false;
        });
      });
      sensor.start();
      api = 'sensor';
      return true;
    } catch (e) {
      sensor = null;
      return false;
    }
  }

  function stopSensorApi() {
    if (sensor) {
      try { sensor.stop(); } catch (e) { /* already gone */ }
      sensor = null;
    }
  }

  function startDeviceMotion() {
    if (typeof window.DeviceMotionEvent !== 'function') return false;
    motionHandler = function (ev) {
      var a = ev.accelerationIncludingGravity || ev.acceleration;
      if (!a || a.x === null) return;
      onSample(Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z), Date.now());
    };
    window.addEventListener('devicemotion', motionHandler);
    api = 'devicemotion';
    return true;
  }

  function stopDeviceMotion() {
    if (motionHandler) {
      window.removeEventListener('devicemotion', motionHandler);
      motionHandler = null;
    }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function start() {
    if (running) return Promise.resolve(true);
    if (!supported()) return Promise.resolve(false);
    reset();

    /* Generic Sensor first, and *not* behind requestPermission(). That gate belongs to
       devicemotion alone: some Chromium builds expose it and answer "denied", which
       would veto the Accelerometer API even though it has its own permission model
       and would have worked. It also lets us ask for a rate, where devicemotion gives
       whatever it feels like. */
    if (startSensorApi()) {
      running = true;
      return Promise.resolve(true);
    }
    return requestPermission().then(function (granted) {
      if (!granted) return false;
      running = startDeviceMotion();
      return running;
    });
  }

  function stop() {
    running = false;
    stopSensorApi();
    stopDeviceMotion();
  }

  function reset() {
    buffer = [];
    sampleCount = 0;
    firstSampleAt = 0;
    lastComputeAt = 0;
    last = { spm: 0, confidence: 0, at: 0 };
  }

  /** Latest reading. `spm` is 0 when nothing periodic is being detected. */
  function current() {
    // Go stale rather than lie: samples stop the moment the page is hidden.
    if (last.at && Date.now() - last.at > 5000) return { spm: 0, confidence: 0, stale: true };
    return { spm: last.spm, confidence: last.confidence, stale: false };
  }

  function isRunning() { return running; }
  function source() { return api; }
  function measuredHz() { return bufferHz(); }
  function samplesSeen() { return sampleCount; }

  /** Settings → "Check sensor": what is this phone actually delivering? */
  function diagnose(seconds) {
    var secs = seconds || 6;
    var wasRunning = running;
    var began = Date.now();
    return (running ? Promise.resolve(true) : start()).then(function (ok) {
      if (!ok) return { ok: false, reason: supported() ? 'permission refused' : 'no motion sensor' };
      var startCount = sampleCount;
      return new Promise(function (resolve) {
        setTimeout(function () {
          var elapsed = (Date.now() - began) / 1000;
          var reading = current();
          var result = {
            ok: true,
            api: api,
            hz: (sampleCount - startCount) / elapsed,
            samples: sampleCount - startCount,
            spm: reading.spm,
            confidence: reading.confidence
          };
          if (!wasRunning) stop();
          resolve(result);
        }, secs * 1000);
      });
    });
  }

  return {
    start: start, stop: stop, reset: reset,
    current: current, isRunning: isRunning, supported: supported,
    source: source, measuredHz: measuredHz, samplesSeen: samplesSeen,
    diagnose: diagnose,
    analyse: analyse,          // exported so the maths can be tested without a phone
    MIN_SPM: MIN_SPM, MAX_SPM: MAX_SPM, MIN_CONFIDENCE: MIN_CONFIDENCE
  };
})();
