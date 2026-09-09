/* Utils — pure helpers: geo maths, formatting, date bucketing, trace decimation. */
var Utils = (function () {
  'use strict';

  var EARTH_R = 6371008.8; // mean earth radius, metres

  function toRad(deg) { return deg * Math.PI / 180; }

  /** Great-circle distance in metres between two {lat,lng} points. */
  function haversine(a, b) {
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var la1 = toRad(a.lat);
    var la2 = toRad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var buf = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (var i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 16; j++) hex.push((buf[j] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
           hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** "7:32" under an hour, "1:07:32" beyond. */
  function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  /** Always mm:ss (used by the interval timer). */
  function formatClock(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }

  /** Seconds per km -> "5:57". */
  function formatPace(secPerKm) {
    if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 5999) return '--:--';
    var m = Math.floor(secPerKm / 60);
    return m + ':' + pad2(Math.round(secPerKm % 60));
  }

  function formatKm(metres, digits) {
    var d = digits === undefined ? 2 : digits;
    return ((metres || 0) / 1000).toFixed(d);
  }

  function formatSpeed(mps) {
    if (!isFinite(mps) || mps < 0) return '0.0';
    return (mps * 3.6).toFixed(1);
  }

  function paceFrom(metres, sec) {
    if (!metres || metres < 1 || !sec) return 0;
    return sec / (metres / 1000);
  }

  /* ------------------------------- dates ------------------------------- */

  function localDayKey(d) {
    var dt = (d instanceof Date) ? d : new Date(d);
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }

  function monthKey(d) {
    var dt = (d instanceof Date) ? d : new Date(d);
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1);
  }

  /** ISO-8601 week key, e.g. "2026-W37". */
  function isoWeekKey(d) {
    var dt = (d instanceof Date) ? new Date(d.getTime()) : new Date(d);
    dt.setHours(0, 0, 0, 0);
    // Thursday of the current ISO week decides the year.
    dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
    var year = dt.getFullYear();
    var jan4 = new Date(year, 0, 4);
    jan4.setHours(0, 0, 0, 0);
    var week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return year + '-W' + pad2(week);
  }

  /** Monday 00:00 of the ISO week containing d. */
  function isoWeekStart(d) {
    var dt = (d instanceof Date) ? new Date(d.getTime()) : new Date(d);
    dt.setHours(0, 0, 0, 0);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return dt;
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function monthLabel(key) {
    var p = key.split('-');
    return MONTHS[parseInt(p[1], 10) - 1].slice(0, 3) + ' ' + p[0];
  }

  function weekLabel(key) {
    return 'W' + key.split('-W')[1];
  }

  function formatDateTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ------------------------------ geometry ----------------------------- */

  /** Local flat projection (metres) around an origin — fine over a run-sized area. */
  function projector(origin) {
    var mPerDegLat = 110574;
    var mPerDegLng = 111320 * Math.cos(toRad(origin.lat));
    return function (p) {
      return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
    };
  }

  function perpDistance(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Douglas-Peucker over projected metres; keeps endpoints. */
  function simplify(points, epsilonMetres) {
    if (points.length < 3) return points.slice();
    var proj = projector(points[0]);
    var xy = points.map(proj);
    var keep = new Array(points.length);
    keep[0] = keep[points.length - 1] = true;

    var stack = [[0, points.length - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var first = seg[0], last = seg[1];
      var maxD = -1, idx = -1;
      for (var i = first + 1; i < last; i++) {
        var d = perpDistance(xy[i], xy[first], xy[last]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > epsilonMetres && idx > -1) {
        keep[idx] = true;
        stack.push([first, idx], [idx, last]);
      }
    }
    return points.filter(function (_, i) { return keep[i]; });
  }

  /** Thin a trace to ~one point per intervalSec, then simplify geometrically. */
  function decimate(points, intervalSec, epsilonMetres) {
    if (!points || points.length === 0) return [];
    var eps = epsilonMetres === undefined ? 4 : epsilonMetres;
    var out = [points[0]];
    var lastT = points[0].t;
    for (var i = 1; i < points.length - 1; i++) {
      if (points[i].t - lastT >= intervalSec) {
        out.push(points[i]);
        lastT = points[i].t;
      }
    }
    if (points.length > 1) out.push(points[points.length - 1]);
    return simplify(out, eps).map(function (p) {
      var q = { lat: round6(p.lat), lng: round6(p.lng), t: Math.round(p.t) };
      if (p.alt !== null && p.alt !== undefined && isFinite(p.alt)) q.alt = Math.round(p.alt * 10) / 10;
      return q;
    });
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /**
   * Per-kilometre splits from a trace carrying cumulative distance.
   * Accepts points with a `cum` field, or computes it on the fly.
   */
  function computeSplits(points) {
    if (!points || points.length < 2) return [];
    var splits = [];
    var cum = 0;
    var nextMark = 1000;
    var prevMarkTime = points[0].t || 0;
    for (var i = 1; i < points.length; i++) {
      var prev = points[i - 1], cur = points[i];
      var segDist = (cur.cum !== undefined && prev.cum !== undefined)
        ? (cur.cum - prev.cum)
        : haversine(prev, cur);
      var segTime = cur.t - prev.t;
      var start = cum;
      cum += segDist;
      while (cum >= nextMark && segDist > 0) {
        var ratio = (nextMark - start) / segDist;
        var tAtMark = prev.t + segTime * ratio;
        splits.push({ km: nextMark / 1000, sec: Math.round(tAtMark - prevMarkTime) });
        prevMarkTime = tAtMark;
        nextMark += 1000;
      }
    }
    return splits;
  }

  /** Parse "3:00", "180", "3" (minutes not assumed — bare numbers are seconds). */
  function parseClock(value, fallback) {
    if (value === null || value === undefined) return fallback;
    var s = String(value).trim();
    if (!s) return fallback;
    if (s.indexOf(':') > -1) {
      var parts = s.split(':');
      var m = parseInt(parts[0], 10);
      var sec = parseInt(parts[1], 10);
      if (isNaN(m) || isNaN(sec)) return fallback;
      return m * 60 + sec;
    }
    var n = parseInt(s, 10);
    return isNaN(n) ? fallback : n;
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  return {
    haversine: haversine,
    uuid: uuid,
    pad2: pad2,
    formatDuration: formatDuration,
    formatClock: formatClock,
    formatPace: formatPace,
    formatKm: formatKm,
    formatSpeed: formatSpeed,
    formatDateTime: formatDateTime,
    paceFrom: paceFrom,
    localDayKey: localDayKey,
    monthKey: monthKey,
    isoWeekKey: isoWeekKey,
    isoWeekStart: isoWeekStart,
    monthLabel: monthLabel,
    weekLabel: weekLabel,
    MONTHS: MONTHS,
    simplify: simplify,
    decimate: decimate,
    computeSplits: computeSplits,
    parseClock: parseClock,
    clamp: clamp
  };
})();
