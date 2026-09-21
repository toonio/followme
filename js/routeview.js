/* RouteView — the route trace as a thumbnail, and the enlarged view where the map
   and a speed chart are two projections of the same samples: pick a point in one
   and it is marked in the other. */
var RouteView = (function () {
  'use strict';

  /* Both svgs scale to the box width, so the viewBox has to be chosen for the
     screen: a 640-wide viewBox squeezed into a 300px phone renders 10px type at
     under 5px. Narrow screens get a smaller viewBox, which keeps the type legible
     at the size it is actually drawn. */
  var WIDE = {
    map: { width: 640, height: 360, strokeWidth: 4.5, markerRadius: 7 },
    chart: { width: 640, height: 190, padL: 62, padR: 12, padT: 14, padB: 26 }
  };
  var NARROW = {
    map: { width: 360, height: 280, strokeWidth: 3.5, markerRadius: 6 },
    chart: { width: 360, height: 165, padL: 48, padR: 10, padT: 14, padB: 24 }
  };
  function geometry() { return window.innerWidth < 520 ? NARROW : WIDE; }

  /* The line gets the app's accent, not a step of the speed ramp: on the chart the
     y position already says how fast, so spending the ramp there would re-encode it
     — and under a dark-is-fast ramp the peaks would be the dimmest part of the line.
     The ramp stays where it is the only key to magnitude: the map. */
  var LINE = '#4cc9a0';        // speed, 7.67:1 on the chart surface
  var CADENCE_LINE = '#c69cf5'; // a second series, kept clear of the blue speed ramp
  var INK = '#e6edf3';
  var INK_DIM = '#8b98a5';
  var GRID = '#2a323d';
  var SURFACE_DARK = '#0d1117';

  /**
   * One sample per gap between stored points: where it ended, when, how far in,
   * and how fast that stretch was.
   */
  function samplesOf(points) {
    var out = [], cum = 0;
    for (var i = 1; i < points.length; i++) {
      var d = Utils.haversine(points[i - 1], points[i]);
      var dt = points[i].t - points[i - 1].t;
      cum += d;
      if (!isFinite(dt) || dt <= 0 || !isFinite(d)) continue;
      out.push({ point: points[i], t: points[i].t, cum: cum, mps: d / dt });
    }
    return out;
  }

  /* ------------------------------ speed chart ---------------------------- */

  /**
   * A series against elapsed time. Returns the svg with `__select(i)` attached;
   * `__samples` is the series it was built from.
   *
   * `opts`: { value(sample) -> number, unit, colour, zeroBased, maxT }
   * Cadence gets its OWN chart rather than a second axis on the speed one: two
   * measures at different scales sharing a y-axis is the classic way to make a chart
   * say whatever you want it to. Stacked charts on a common time axis compare
   * honestly, and the shared selection ties them together.
   */
  function seriesChart(samples, geom, opts) {
    var CHART = geom || WIDE.chart;
    var o = opts || {};
    var valueOf = o.value || function (s) { return s.mps * 3.6; };
    var unit = o.unit || 'km/h';
    var colour = o.colour || LINE;
    var w = CHART.width, h = CHART.height;
    var plotW = w - CHART.padL - CHART.padR;
    var plotH = h - CHART.padT - CHART.padB;

    var maxT = o.maxT || samples[samples.length - 1].t || 1;
    var maxV = 0, minV = Infinity;
    samples.forEach(function (sm) {
      var v = valueOf(sm);
      if (v > maxV) maxV = v;
      if (v < minV) minV = v;
    });
    // Speed is zero-based: standing still is a real, meaningful zero. Cadence is not
    // — every running cadence sits in a narrow band, and anchoring it at zero would
    // squash the whole run into a flat line near the top of the plot.
    var yMin = o.zeroBased === false ? Math.max(0, minV - (maxV - minV) * 0.35 - 2) : 0;
    var yMax = maxV + (maxV - yMin) * 0.15 || 1;
    var span = (yMax - yMin) || 1;

    function x(t) { return CHART.padL + plotW * (t / maxT); }
    function y(v) { return CHART.padT + plotH * (1 - (v - yMin) / span); }

    var root = UI.svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h,
      role: 'img',
      'aria-label': (o.label || 'Speed') + ' over time. Select a point to mark it on the map.'
    });

    // Recessive grid, labelled in the series' own unit.
    [0, 0.5, 1].forEach(function (frac) {
      var v = yMin + span * frac, yy = y(v);
      root.appendChild(UI.svg('line', {
        x1: CHART.padL - 4, x2: w - CHART.padR, y1: yy.toFixed(1), y2: yy.toFixed(1),
        stroke: GRID, 'stroke-width': 1
      }));
      var lab = UI.svg('text', {
        x: CHART.padL - 8, y: (yy + 3.5).toFixed(1), 'text-anchor': 'end',
        fill: INK_DIM, 'font-size': 10
      });
      // The unit rides on the top label — a separate caption collided with it.
      lab.textContent = v.toFixed(v >= 10 ? 0 : 1) + (frac === 1 ? ' ' + unit : '');
      root.appendChild(lab);
    });

    [0, 0.5, 1].forEach(function (frac) {
      var t = maxT * frac;
      var lab = UI.svg('text', {
        x: x(t).toFixed(1), y: h - 8,
        'text-anchor': frac === 0 ? 'start' : (frac === 1 ? 'end' : 'middle'),
        fill: INK_DIM, 'font-size': 10
      });
      lab.textContent = Utils.formatDuration(t);
      root.appendChild(lab);
    });

    var d = samples.map(function (sm, i) {
      return (i === 0 ? 'M' : 'L') + x(sm.t).toFixed(1) + ' ' + y(valueOf(sm)).toFixed(1);
    }).join(' ');
    root.appendChild(UI.svg('path', {
      d: d, fill: 'none', stroke: colour, 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));

    // Selection layer, hidden until something is picked.
    var rule = UI.svg('line', {
      y1: CHART.padT, y2: CHART.padT + plotH, stroke: INK, 'stroke-width': 1,
      'stroke-dasharray': '3 3', opacity: 0
    });
    var dotHalo = UI.svg('circle', { r: 7, fill: SURFACE_DARK, opacity: 0 });
    var dot = UI.svg('circle', { r: 4.5, fill: INK, opacity: 0 });
    root.appendChild(rule);
    root.appendChild(dotHalo);
    root.appendChild(dot);

    root.__samples = samples;
    root.__select = function (i) {
      var sm = samples[i];
      if (!sm) return;
      var sx = x(sm.t), sy = y(valueOf(sm));
      rule.setAttribute('x1', sx.toFixed(1));
      rule.setAttribute('x2', sx.toFixed(1));
      rule.setAttribute('opacity', 1);
      [dot, dotHalo].forEach(function (c) {
        c.setAttribute('cx', sx.toFixed(1));
        c.setAttribute('cy', sy.toFixed(1));
        c.setAttribute('opacity', 1);
      });
    };
    /** Hide the selection marks — used when a chart has no sample at that moment. */
    root.__clear = function () {
      rule.setAttribute('opacity', 0);
      dot.setAttribute('opacity', 0);
      dotHalo.setAttribute('opacity', 0);
    };
    /** Index of the sample nearest a given elapsed time. */
    root.__nearestTime = function (t) {
      var best = -1, bestD = Infinity;
      for (var i = 0; i < samples.length; i++) {
        var gap = Math.abs(samples[i].t - t);
        if (gap < bestD) { bestD = gap; best = i; }
      }
      return { index: best, gap: bestD };
    };
    /** Elapsed time under a viewBox x — clicking anywhere in the plot is enough. */
    root.__timeAt = function (vbX) {
      return Utils.clamp((vbX - CHART.padL) / plotW, 0, 1) * maxT;
    };
    return root;
  }

  function speedChart(samples, geom, opts) {
    return seriesChart(samples, geom, opts);
  }

  /* -------------------------------- figures ------------------------------ */

  /** Thumbnail: the trace, its legend, and a tap target for the enlarged view. */
  function figure(run, opts) {
    var points = run && run.points;
    if (!points || points.length < 2) return null;
    var o = opts || {};
    var chart = UI.routeSvg(points, { width: 320, height: 150, strokeWidth: 3, markerRadius: 4 });
    if (!chart) return null;

    var button = UI.el('button', {
      class: 'route-figure',
      type: 'button',
      'aria-label': 'Enlarge route trace',
      onclick: function () { open(run); }
    }, [chart, UI.routeLegend(chart.__speedDomain)]);

    var wrap = UI.el('div', { class: 'route-preview' }, [button]);
    if (o.hint !== false) {
      wrap.appendChild(UI.el('p', { class: 'route-hint', text: 'Tap the trace to enlarge' }));
    }
    return wrap;
  }

  /** Full-size route with a linked speed chart underneath. */
  function open(run) {
    var modal = UI.$('#mapModal');
    var body = UI.$('#mapModalBody');
    UI.clear(body);

    var geom = geometry();
    var map = UI.routeSvg(run.points, {
      width: geom.map.width, height: geom.map.height,
      strokeWidth: geom.map.strokeWidth, markerRadius: geom.map.markerRadius, labelEnds: true
    });
    if (!map) return;

    var title = Utils.formatDateTime(run.date);
    if (run.place && run.place.commune) title += ' · ' + run.place.commune;
    UI.setText('#mapModalTitle', title);

    // Marker for the selected sample: a ring, with a dark halo so it reads over any
    // step of the ramp. Appended last, so it sits above the trace.
    var markHalo = UI.svg('circle', { r: 10, fill: 'none', stroke: SURFACE_DARK, 'stroke-width': 6, opacity: 0 });
    var mark = UI.svg('circle', { r: 10, fill: 'none', stroke: INK, 'stroke-width': 2.5, opacity: 0 });
    map.appendChild(markHalo);
    map.appendChild(mark);

    body.appendChild(UI.el('div', { class: 'route-big' }, [map]));
    body.appendChild(UI.routeLegend(map.__speedDomain));

    var samples = samplesOf(run.points);
    var readout = UI.el('p', { class: 'route-readout' });
    var facts = [
      Utils.formatKm(run.distanceMeters) + ' km',
      Utils.formatDuration(run.durationSec),
      Utils.formatPace(run.avgPaceSecPerKm) + ' /km'
    ];
    if (run.elevationGainM) facts.push('+' + run.elevationGainM + ' m');

    var cadenceSeries = (run.cadenceSamples || []).filter(function (c) {
      return c && isFinite(c.t) && isFinite(c.spm) && c.spm > 0;
    });

    if (samples.length >= 2) {
      // One time axis shared by every chart, so the stacked plots line up and a
      // selection in one lands at the same moment in the others.
      var maxT = Math.max(
        samples[samples.length - 1].t,
        cadenceSeries.length ? cadenceSeries[cadenceSeries.length - 1].t : 0
      );

      /* How far from a sample a click may land and still count as "that moment".
         Fixed seconds will not do: the GPS trace is decimated, so on a straight road
         its samples can sit half a minute apart while cadence lands every five. Each
         series gets a tolerance from its own spacing. */
      function tolerance(series) {
        if (series.length < 2) return 30;
        var gaps = [];
        for (var i = 1; i < series.length; i++) gaps.push(series[i].t - series[i - 1].t);
        gaps.sort(function (a, b) { return a - b; });
        return Math.max(10, gaps[Math.floor(gaps.length / 2)] * 2);
      }

      var charts = [];
      var speed = seriesChart(samples, geom.chart, { maxT: maxT, label: 'Speed' });
      charts.push({ svg: speed, series: samples, tol: tolerance(samples), hit: -1 });
      body.appendChild(chartHolder(speed, 'Speed chart'));

      if (cadenceSeries.length >= 2) {
        var cad = seriesChart(cadenceSeries, geom.chart, {
          value: function (c) { return c.spm; },
          unit: 'spm',
          colour: CADENCE_LINE,
          zeroBased: false,
          maxT: maxT,
          label: 'Cadence'
        });
        charts.push({ svg: cad, series: cadenceSeries, tol: tolerance(cadenceSeries), hit: -1 });
        body.appendChild(chartHolder(cad, 'Cadence chart'));
      }

      var selectedT = -1;
      function selectAt(t) {
        selectedT = t;
        var parts = [Utils.formatDuration(t)];

        // One hit decision per chart, used for both the marker and the readout, so
        // the two can never disagree about whether there is a reading there.
        charts.forEach(function (c) {
          var hit = c.svg.__nearestTime(t);
          c.hit = (hit.index >= 0 && hit.gap <= c.tol) ? hit.index : -1;
          if (c.hit < 0) c.svg.__clear(); else c.svg.__select(c.hit);
        });

        var s = charts[0].hit >= 0 ? samples[charts[0].hit] : null;
        if (s) {
          parts.push(Utils.formatKm(s.cum) + ' km');
          parts.push(Utils.formatSpeed(s.mps) + ' km/h');
          parts.push(UI.paceLabel(s.mps) + ' /km');
          var xy = map.__project(s.point);
          [mark, markHalo].forEach(function (c) {
            c.setAttribute('cx', xy.x.toFixed(1));
            c.setAttribute('cy', xy.y.toFixed(1));
            c.setAttribute('opacity', 1);
          });
        } else {
          mark.setAttribute('opacity', 0);
          markHalo.setAttribute('opacity', 0);
        }

        if (charts.length > 1) {
          parts.push(charts[1].hit >= 0 ? cadenceSeries[charts[1].hit].spm + ' spm' : '-- spm');
        }
        readout.textContent = parts.join(' · ');
        readout.classList.add('is-selected');
      }

      function chartHolder(svg, label) {
        var holder = UI.el('div', {
          class: 'speed-chart',
          tabindex: '0',
          role: 'group',
          'aria-label': label + '. Click a point, or use the arrow keys, to mark it on the map.'
        }, [svg]);
        holder.addEventListener('click', function (ev) {
          var box = svg.getBoundingClientRect();
          if (!box.width) return;
          selectAt(svg.__timeAt((ev.clientX - box.left) / box.width * geom.chart.width));
        });
        holder.addEventListener('keydown', function (ev) {
          if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
          ev.preventDefault();
          var step = maxT / 60;
          var base = selectedT < 0 ? 0 : selectedT;
          selectAt(Utils.clamp(base + (ev.key === 'ArrowRight' ? step : -step), 0, maxT));
        });
        return holder;
      }

      readout.textContent = cadenceSeries.length >= 2
        ? 'Tap either chart to mark that moment on the map'
        : 'Tap the chart to mark a point on the map';
      body.appendChild(readout);
    }

    body.appendChild(UI.el('p', { class: 'route-facts', text: facts.join(' · ') }));

    function close() {
      modal.hidden = true;
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    }
    function onBackdrop(ev) { if (ev.target === modal) close(); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }

    UI.$('#mapModalClose').onclick = close;
    modal.hidden = false;
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    UI.$('#mapModalClose').focus();
  }

  return { figure: figure, open: open, samplesOf: samplesOf, speedChart: speedChart };
})();
