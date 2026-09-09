/* Stats — global totals plus weekly/monthly buckets, all derived on render
   from the stored run list (no aggregation kept at write time). */
var Stats = (function () {
  'use strict';

  var bucket = 'week';      // week | month
  var metric = 'distance';  // distance | duration | pace | runs
  var runs = [];

  /* ------------------------------ aggregation --------------------------- */

  function summarize(list) {
    var totalDistance = 0, totalDuration = 0, totalAscent = 0, longest = null, fastest = null;
    list.forEach(function (r) {
      totalDistance += r.distanceMeters || 0;
      totalDuration += r.durationSec || 0;
      totalAscent += r.elevationGainM || 0;
      if (!longest || (r.distanceMeters || 0) > (longest.distanceMeters || 0)) longest = r;
      if ((r.distanceMeters || 0) >= 500) {
        var p = r.avgPaceSecPerKm || Utils.paceFrom(r.distanceMeters, r.durationSec);
        if (p > 0 && (!fastest || p < fastest.pace)) fastest = { pace: p, run: r };
      }
    });
    return {
      runs: list.length,
      distance: totalDistance,
      duration: totalDuration,
      ascent: totalAscent,
      pace: Utils.paceFrom(totalDistance, totalDuration),
      longest: longest,
      fastest: fastest
    };
  }

  /** Group runs into ordered buckets, keeping empty weeks/months in between. */
  function group(list, mode) {
    if (!list.length) return [];
    var map = {};
    list.forEach(function (r) {
      var d = new Date(r.date);
      var key = mode === 'week' ? Utils.isoWeekKey(d) : Utils.monthKey(d);
      (map[key] = map[key] || []).push(r);
    });

    var dates = list.map(function (r) { return new Date(r.date); });
    var min = new Date(Math.min.apply(null, dates));
    var max = new Date(Math.max.apply(null, dates));

    var keys = [];
    if (mode === 'week') {
      var cur = Utils.isoWeekStart(min);
      var end = Utils.isoWeekStart(max);
      var guard = 0;
      while (cur <= end && guard++ < 520) {
        keys.push(Utils.isoWeekKey(cur));
        cur = new Date(cur.getTime());
        cur.setDate(cur.getDate() + 7);
      }
    } else {
      var c = new Date(min.getFullYear(), min.getMonth(), 1);
      var e = new Date(max.getFullYear(), max.getMonth(), 1);
      var g = 0;
      while (c <= e && g++ < 240) {
        keys.push(Utils.monthKey(c));
        c = new Date(c.getFullYear(), c.getMonth() + 1, 1);
      }
    }

    return keys.map(function (k) {
      var items = map[k] || [];
      var s = summarize(items);
      s.key = k;
      s.label = mode === 'week' ? Utils.weekLabel(k) : Utils.monthLabel(k).split(' ')[0];
      s.fullLabel = mode === 'week' ? k : Utils.monthLabel(k);
      return s;
    });
  }

  /* -------------------------------- render ------------------------------ */

  function renderGlobal() {
    var host = UI.$('#globalStats');
    UI.clear(host);
    var s = summarize(runs);

    var cards = [
      ['Runs', String(s.runs), ''],
      ['Distance', Utils.formatKm(s.distance, s.distance >= 100000 ? 0 : 1), 'km'],
      ['Time', Utils.formatDuration(s.duration), ''],
      ['Avg pace', Utils.formatPace(s.pace), '/km'],
      ['Longest', s.longest ? Utils.formatKm(s.longest.distanceMeters) : '0.00', 'km'],
      ['Best pace', s.fastest ? Utils.formatPace(s.fastest.pace) : '--:--', '/km'],
      ['Ascent', '+' + s.ascent, 'm']
    ];

    cards.forEach(function (c) {
      var value = UI.el('span', { class: 'stat-value' });
      UI.setStat(value, c[1], c[2]);
      host.appendChild(UI.el('div', { class: 'stat' }, [
        UI.el('span', { class: 'stat-label', text: c[0] }),
        value
      ]));
    });
  }

  function metricConfig(buckets) {
    if (metric === 'distance') {
      return {
        value: function (b) { return b.distance / 1000; },
        format: function (v) { return v.toFixed(v >= 100 ? 0 : 1); },
        zeroBased: true,
        color: '#4cc9a0'
      };
    }
    if (metric === 'duration') {
      return {
        value: function (b) { return b.duration / 60; },
        format: function (v) { return Math.round(v) + 'm'; },
        zeroBased: true,
        color: '#58a6ff'
      };
    }
    if (metric === 'ascent') {
      return {
        value: function (b) { return b.ascent; },
        format: function (v) { return '+' + Math.round(v); },
        zeroBased: true,
        color: '#7ec8e3'
      };
    }
    if (metric === 'runs') {
      return {
        value: function (b) { return b.runs; },
        format: function (v) { return String(Math.round(v)); },
        zeroBased: true,
        color: '#c69cf5'
      };
    }
    return {
      value: function (b) { return b.pace; },
      format: function (v) { return Utils.formatPace(v); },
      zeroBased: false,
      color: '#f0a44a',
      skipEmpty: true    // a bucket with no run has no pace to plot
    };
  }

  function renderChart() {
    var host = UI.$('#statsChart');
    var buckets = group(runs, bucket);
    var cfg = metricConfig(buckets);

    // Only the most recent slice fits comfortably on a phone.
    var limit = bucket === 'week' ? 12 : 12;
    var slice = buckets.slice(-limit);

    var items = slice
      .filter(function (b) { return !cfg.skipEmpty || b.runs > 0; })
      .map(function (b) {
        return { label: b.label, title: b.fullLabel, value: cfg.value(b) };
      });

    Charts.bar(host, items, { format: cfg.format, zeroBased: cfg.zeroBased, color: cfg.color });
    renderTable(slice.slice().reverse());
  }

  function renderTable(buckets) {
    var table = UI.$('#bucketTable');
    UI.clear(table);
    if (!buckets.length) return;

    var head = UI.el('tr', {}, [
      UI.el('th', { text: bucket === 'week' ? 'Week' : 'Month' }),
      UI.el('th', { text: 'Runs' }),
      UI.el('th', { text: 'Distance' }),
      UI.el('th', { text: 'Time' }),
      UI.el('th', { text: 'Pace' }),
      UI.el('th', { text: 'D+' })
    ]);
    table.appendChild(UI.el('thead', {}, [head]));

    var body = UI.el('tbody');
    buckets.forEach(function (b) {
      body.appendChild(UI.el('tr', {}, [
        UI.el('td', { text: b.fullLabel }),
        UI.el('td', { text: String(b.runs) }),
        UI.el('td', { text: Utils.formatKm(b.distance, 1) + ' km' }),
        UI.el('td', { text: Utils.formatDuration(b.duration) }),
        UI.el('td', { text: b.runs ? Utils.formatPace(b.pace) : '—' }),
        UI.el('td', { text: b.runs ? '+' + b.ascent + ' m' : '—' })
      ]));
    });
    table.appendChild(body);
  }

  function renderRunList() {
    var host = UI.$('#runList');
    UI.clear(host);
    if (!runs.length) {
      host.appendChild(UI.el('p', { class: 'empty', text: 'No runs recorded yet.' }));
      return;
    }
    runs.slice(0, 50).forEach(function (r) {
      var meta = Utils.formatKm(r.distanceMeters) + ' km · ' + Utils.formatDuration(r.durationSec) +
                 ' · ' + Utils.formatPace(r.avgPaceSecPerKm) + ' /km';
      if (r.elevationGainM) meta += ' · +' + r.elevationGainM + ' m';
      var head = Utils.formatDateTime(r.date);
      if (r.place && r.place.commune) head += ' · ' + r.place.commune;
      host.appendChild(UI.el('div', { class: 'run-item' }, [
        UI.el('div', { class: 'run-main' }, [
          UI.el('div', { class: 'run-date', text: head }),
          UI.el('div', { class: 'run-meta', text: meta })
        ]),
        UI.el('button', {
          class: 'icon-btn', text: 'Delete', 'aria-label': 'Delete run',
          onclick: function () { confirmDelete(r); }
        })
      ]));
    });
    if (runs.length > 50) {
      host.appendChild(UI.el('p', { class: 'empty', text: 'Showing the 50 most recent of ' + runs.length + ' runs.' }));
    }
  }

  function confirmDelete(run) {
    UI.confirm('Delete run?', Utils.formatDateTime(run.date) + ' — ' +
      Utils.formatKm(run.distanceMeters) + ' km. This cannot be undone.', 'Delete')
      .then(function (ok) { if (ok) DB.remove(run.id); });
  }

  function refresh() {
    return DB.all().then(function (list) {
      runs = list;
      renderGlobal();
      renderChart();
      renderRunList();
    });
  }

  function init() {
    UI.$$('[data-bucket]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        bucket = btn.getAttribute('data-bucket');
        UI.$$('[data-bucket]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        renderChart();
      });
    });
    UI.$$('[data-metric]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        metric = btn.getAttribute('data-metric');
        UI.$$('[data-metric]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        renderChart();
      });
    });
  }

  return { init: init, refresh: refresh, summarize: summarize, group: group };
})();
