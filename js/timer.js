/* IntervalTimer — configurable work/rest series.
   Countdown is derived from Date.now() diffing (never from accumulated setInterval
   ticks) so throttled/background tabs cannot make it drift.
   Independent from the GPS tracker: either can run alone or both together. */
var IntervalTimer = (function () {
  'use strict';

  var TICK_MS = 200;

  var state = {
    status: 'idle',      // idle | running | paused | done
    phase: 'work',       // work | rest
    round: 0,
    phaseEndTs: 0,
    phaseTotalSec: 0,
    remainingSec: 0,
    pausedRemainingMs: 0
  };

  var cfg = { rounds: 5, workSec: 180, restSec: 60 };
  var tickId = null;
  var listeners = [];
  var audioCtx = null;
  var master = null;

  /* -------------------------------- audio ------------------------------- */

  function ensureAudio() {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        // Limiter: the stacked oscillators run hot on purpose, this stops them
        // clipping into distortion instead of just being loud.
        var limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.setValueAtTime(-6, audioCtx.currentTime);
        limiter.ratio.setValueAtTime(20, audioCtx.currentTime);
        limiter.attack.setValueAtTime(0.003, audioCtx.currentTime);
        limiter.release.setValueAtTime(0.1, audioCtx.currentTime);
        master = audioCtx.createGain();
        master.gain.setValueAtTime(1, audioCtx.currentTime);
        master.connect(limiter);
        limiter.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; master = null; }
  }

  function voice(type, freq, t0, durationSec, peak) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // Fast attack, flat body, quick release — a hard-edged blip carries much further
    // than a soft swell when there is wind and traffic around.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    gain.gain.setValueAtTime(peak, t0 + durationSec * 0.75);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }

  /** One beep = square fundamental + a sine an octave up, for bite without mush. */
  function tone(freq, startOffset, durationSec, level) {
    if (!audioCtx || !master) return;
    var t0 = audioCtx.currentTime + startOffset;
    var lvl = level === undefined ? 1 : level;
    voice('square', freq, t0, durationSec, 0.7 * lvl);
    voice('sine', freq * 2, t0, durationSec, 0.25 * lvl);
  }

  /* Transition signatures — distinguishable by count, rhythm and pitch alike:
     end of work  -> 5 short, quick, lower  (ease off)
     end of rest  -> 3 longer, spaced, higher (get going)
     series over  -> rising three-tone, last one held. */
  var PATTERNS = {
    rest: { count: 5, freq: 1046, duration: 0.09, gap: 0.14 },
    work: { count: 3, freq: 1568, duration: 0.18, gap: 0.30 }
  };

  function playPattern(kind, offset) {
    if (!audioCtx || !master) return;
    var at = offset || 0;
    if (kind === 'end') {
      tone(1046, at, 0.16);
      tone(1319, at + 0.22, 0.16);
      tone(1760, at + 0.44, 0.65);
      return;
    }
    var p = PATTERNS[kind];
    if (!p) return;
    for (var i = 0; i < p.count; i++) {
      tone(p.freq, at + i * p.gap, p.duration);
    }
  }

  function beep(kind) {
    if (!Settings.get('sound')) return;
    ensureAudio();
    playPattern(kind, 0);
  }

  /** Settings "Test": plays both transition signatures back to back. */
  function preview() {
    ensureAudio();
    if (!audioCtx || !master) return false;
    playPattern('rest', 0);      // end of work
    playPattern('work', 1.5);    // end of rest
    return true;
  }

  /* ------------------------------- helpers ------------------------------ */

  function loadConfig() {
    cfg = {
      rounds: Utils.clamp(parseInt(Settings.get('rounds'), 10) || 1, 1, 99),
      workSec: Utils.clamp(parseInt(Settings.get('workSec'), 10) || 60, 1, 5999),
      restSec: Utils.clamp(parseInt(Settings.get('restSec'), 10) || 0, 0, 5999)
    };
    return cfg;
  }

  /* While idle, always report what Settings currently says — readers must not depend
     on having been notified after the timer's own settings-changed handler ran.
     Mid-series the config stays frozen so an edit cannot reshape a running set. */
  function config() {
    if (state.status === 'idle') loadConfig();
    return { rounds: cfg.rounds, workSec: cfg.workSec, restSec: cfg.restSec };
  }

  /** Total planned duration: no rest after the final round. */
  function totalSec() {
    var c = config();
    return c.rounds * c.workSec + Math.max(0, c.rounds - 1) * c.restSec;
  }

  function phaseDuration(phase) {
    return phase === 'work' ? cfg.workSec : cfg.restSec;
  }

  function emit() {
    var snap = snapshot();
    listeners.forEach(function (fn) { fn(snap); });
  }

  function snapshot() {
    return {
      status: state.status,
      phase: state.phase,
      round: state.round,
      rounds: cfg.rounds,
      remainingSec: state.remainingSec,
      phaseTotalSec: state.phaseTotalSec,
      progress: state.phaseTotalSec > 0
        ? Utils.clamp(1 - state.remainingSec / state.phaseTotalSec, 0, 1)
        : 0
    };
  }

  function onChange(fn) { listeners.push(fn); }

  /* ------------------------------ lifecycle ----------------------------- */

  function enterPhase(phase, round, startTs) {
    state.phase = phase;
    state.round = round;
    state.phaseTotalSec = phaseDuration(phase);
    state.phaseEndTs = startTs + state.phaseTotalSec * 1000;
    state.remainingSec = state.phaseTotalSec;
  }

  /** Returns false when the series is over. */
  function advance(atTs) {
    if (state.phase === 'work') {
      if (state.round >= cfg.rounds) return false;      // last work done -> finished
      if (cfg.restSec <= 0) { enterPhase('work', state.round + 1, atTs); return true; }
      enterPhase('rest', state.round, atTs);
      return true;
    }
    enterPhase('work', state.round + 1, atTs);
    return true;
  }

  function tick() {
    if (state.status !== 'running') return;
    var now = Date.now();
    var transitioned = null;

    // Catch up in one pass — a throttled tab may have skipped whole phases.
    while (now >= state.phaseEndTs) {
      var boundary = state.phaseEndTs;
      if (!advance(boundary)) {
        finish();
        return;
      }
      transitioned = state.phase;
    }

    state.remainingSec = Math.max(0, (state.phaseEndTs - now) / 1000);
    if (transitioned) beep(transitioned);
    emit();
  }

  function start() {
    if (state.status === 'running') return;
    // Created from a real tap, so the context starts unlocked on mobile.
    if (Settings.get('sound')) ensureAudio();

    if (state.status === 'paused') {
      state.phaseEndTs = Date.now() + state.pausedRemainingMs;
      state.status = 'running';
    } else {
      loadConfig();
      state.status = 'running';
      enterPhase('work', 1, Date.now());
      beep('work');
    }

    WakeLock.acquire('timer');
    if (tickId) clearInterval(tickId);
    tickId = setInterval(tick, TICK_MS);
    emit();
  }

  function pause() {
    if (state.status !== 'running') return;
    state.pausedRemainingMs = Math.max(0, state.phaseEndTs - Date.now());
    state.remainingSec = state.pausedRemainingMs / 1000;
    state.status = 'paused';
    clearInterval(tickId);
    tickId = null;
    WakeLock.release('timer');
    emit();
  }

  function finish() {
    clearInterval(tickId);
    tickId = null;
    state.status = 'done';
    state.remainingSec = 0;
    WakeLock.release('timer');
    beep('end');
    emit();
  }

  function reset() {
    clearInterval(tickId);
    tickId = null;
    loadConfig();
    state.status = 'idle';
    state.phase = 'work';
    state.round = 0;
    state.remainingSec = cfg.workSec;
    state.phaseTotalSec = cfg.workSec;
    state.pausedRemainingMs = 0;
    WakeLock.release('timer');
    emit();
  }

  function init() {
    loadConfig();
    state.remainingSec = cfg.workSec;
    state.phaseTotalSec = cfg.workSec;
    document.addEventListener('settings-changed', function () {
      // Only adopt new numbers between series. Reloading them mid-run would change
      // the round count and the duration of phases you have not reached yet, under
      // someone who is already three rounds into the workout; start() and reset()
      // both reload, so the edit lands on the next series.
      if (state.status === 'idle') reset();
    });
  }

  return {
    init: init,
    start: start,
    pause: pause,
    reset: reset,
    onChange: onChange,
    preview: preview,
    snapshot: snapshot,
    config: config,
    totalSec: totalSec,
    isActive: function () { return state.status === 'running'; }
  };
})();
