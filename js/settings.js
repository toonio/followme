/* Settings — small key/value config kept in localStorage (runs live in IndexedDB). */
var Settings = (function () {
  'use strict';

  var KEY = 'runningTracker.settings';

  var DEFAULTS = {
    deezerPlaylistId: '',
    rounds: 5,
    workSec: 180,
    restSec: 60,
    sound: true,
    accuracyThresholdM: 20,
    decimateSec: 4,
    placeLookup: true,
    sessionScale: 115,       // percent; see the Session display hint for why not more
    // Which readouts the Tracker shows, in canonical order. Stored as a string so a
    // default array can never be shared by reference between callers.
    tiles: 'elapsed,distance,avgPace,lastPace,speed,cadence,ascent',
    cadence: true
  };

  var current = load();

  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var key in DEFAULTS) {
          if (parsed[key] !== undefined && parsed[key] !== null) out[key] = parsed[key];
        }
      }
    } catch (e) { /* corrupted or unavailable storage — fall back to defaults */ }
    return out;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(current)); }
    catch (e) { /* private mode / quota — settings just won't survive a reload */ }
  }

  function get(key) { return current[key]; }
  function all() {
    var copy = {};
    for (var k in current) copy[k] = current[k];
    return copy;
  }

  function set(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) current[k] = patch[k];
    }
    persist();
    document.dispatchEvent(new CustomEvent('settings-changed', { detail: all() }));
  }

  /** Accepts a bare id, a deezer.com/playlist/ID url, or a widget url. */
  function normalizePlaylistId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = s.match(/playlist\/(\d+)/);
    if (m) return m[1];
    m = s.match(/(\d{4,})/);
    return m ? m[1] : '';
  }

  /** The `tiles` setting as a clean list. */
  function tileList() {
    return String(get('tiles') || '').split(',')
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  return {
    DEFAULTS: DEFAULTS,
    tileList: tileList,
    get: get,
    all: all,
    set: set,
    normalizePlaylistId: normalizePlaylistId
  };
})();
