/* UI — tiny DOM helpers shared by the views. */
var UI = (function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function setText(sel, text) {
    var node = typeof sel === 'string' ? $(sel) : sel;
    if (node) node.textContent = text;
  }

  /** Value + smaller unit suffix, matching the .stat-value markup. */
  function setStat(node, value, unit) {
    if (!node) return;
    clear(node);
    node.appendChild(document.createTextNode(value));
    if (unit) {
      node.appendChild(document.createTextNode(' '));
      node.appendChild(el('small', { text: unit }));
    }
  }

  var msgTimer = null;
  function message(node, text, kind, autoHideMs) {
    if (typeof node === 'string') node = $(node);
    if (!node) return;
    node.textContent = text;
    node.className = 'msg' + (kind ? ' ' + kind : '');
    node.hidden = !text;
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
    if (text && autoHideMs) {
      msgTimer = setTimeout(function () { node.hidden = true; }, autoHideMs);
    }
  }

  /**
   * Promise-based dialog. `buttons` is [{label, value, class}];
   * resolves with the chosen value (or null when dismissed by backdrop).
   */
  function ask(title, text, buttons) {
    var modal = $('#modal');
    var actions = $('#modalActions');
    setText('#modalTitle', title);
    setText('#modalText', text);
    clear(actions);

    return new Promise(function (resolve) {
      function close(value) {
        modal.hidden = true;
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onBackdrop(ev) { if (ev.target === modal) close(null); }
      function onKey(ev) { if (ev.key === 'Escape') close(null); }

      buttons.forEach(function (b) {
        actions.appendChild(el('button', {
          class: 'btn ' + (b.class || ''),
          text: b.label,
          onclick: function () { close(b.value); }
        }));
      });

      modal.hidden = false;
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  function confirm(title, text, confirmLabel) {
    return ask(title, text, [
      { label: 'Cancel', value: false, class: 'btn-ghost' },
      { label: confirmLabel || 'Confirm', value: true, class: 'btn-danger' }
    ]).then(function (v) { return v === true; });
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  /* ------------------------------- routes ------------------------------ */

  /* Speed is a magnitude, so it takes a sequential ramp: ONE hue, monotone
     lightness, light → dark as speed rises. Steps 100/200/350/450/550 of the blue
     ramp, chosen against this app's own surface (#1c232c) rather than by eye and
     re-validated in this direction — the darkest step still clears 2.39:1 and every
     adjacent pair clears ΔL 0.06, so all five read apart. Note the consequence of
     running dark-is-fast on a dark surface: the fastest stretches sit at 2.39:1
     while the slowest glow at 11.96:1, the reverse of the usual dark-mode anchoring.
     Five bins is also as much as a legend can label honestly. */
  var SPEED_RAMP = ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#1c5cab'];
  var MIN_SPEED_SPAN_MPS = 0.5;   // don't stretch a steady run across the whole ramp

  /** Per-segment speed in m/s, one entry per gap between stored points. */
  function segmentSpeeds(points) {
    var out = [];
    for (var i = 1; i < points.length; i++) {
      var dt = points[i].t - points[i - 1].t;
      var d = Utils.haversine(points[i - 1], points[i]);
      out.push((isFinite(dt) && dt > 0 && isFinite(d)) ? d / dt : null);
    }
    return out;
  }

  function quantile(sorted, q) {
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * Colour domain for one run, clipped to the 5th–95th percentile so a single
   * GPS glitch does not own both ends of the scale.
   */
  function speedDomain(speeds) {
    var valid = speeds.filter(function (s) { return s !== null && isFinite(s) && s > 0; });
    if (valid.length < 2) return null;
    valid.sort(function (a, b) { return a - b; });
    var lo = quantile(valid, 0.05), hi = quantile(valid, 0.95);
    if (hi - lo < MIN_SPEED_SPAN_MPS) {
      var mid = (hi + lo) / 2;
      lo = Math.max(0.1, mid - MIN_SPEED_SPAN_MPS / 2);
      hi = mid + MIN_SPEED_SPAN_MPS / 2;
    }
    return { lo: lo, hi: hi };
  }

  function speedColor(mps, domain) {
    if (mps === null || !isFinite(mps) || !domain) return SPEED_RAMP[2];
    var f = (mps - domain.lo) / (domain.hi - domain.lo);
    return SPEED_RAMP[Utils.clamp(Math.floor(f * SPEED_RAMP.length), 0, SPEED_RAMP.length - 1)];
  }

  function paceLabel(mps) {
    return (mps > 0) ? formatPaceOf(mps) : '--:--';
  }
  function formatPaceOf(mps) { return Utils.formatPace(1000 / mps); }

  /**
   * Route trace, coloured per segment by the speed implied by the stored points.
   * The decimated trace is enough: points sit a few seconds apart, which is a
   * longer baseline than a single fix and therefore a steadier speed estimate.
   * Returns null if the trace is too short to draw.
   */
  function routeSvg(points, opts) {
    if (!points || points.length < 2) return null;
    var o = opts || {};
    var w = o.width || 320, h = o.height || 160, pad = 12;
    var stroke = o.strokeWidth || 3;

    var lats = points.map(function (p) { return p.lat; });
    var lngs = points.map(function (p) { return p.lng; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);

    // Keep the aspect ratio honest: 1 deg of longitude is shorter than 1 deg of latitude.
    var midLat = (minLat + maxLat) / 2;
    var cosLat = Math.cos(midLat * Math.PI / 180);
    var spanX = Math.max((maxLng - minLng) * cosLat, 1e-7);
    var spanY = Math.max(maxLat - minLat, 1e-7);
    var scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    var offX = (w - spanX * scale) / 2;
    var offY = (h - spanY * scale) / 2;

    function px(p) { return offX + (p.lng - minLng) * cosLat * scale; }
    function py(p) { return h - (offY + (p.lat - minLat) * scale); }

    var speeds = segmentSpeeds(points);
    var domain = speedDomain(speeds);

    var root = svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h,
      role: 'img',
      'aria-label': 'Route trace, coloured by speed from slowest to fastest'
    });

    // One casing under the whole trace: separates the route from the surface and
    // from itself where it doubles back.
    var full = points.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + px(p).toFixed(1) + ' ' + py(p).toFixed(1);
    }).join(' ');
    root.appendChild(svg('path', {
      d: full, fill: 'none', stroke: '#0d1117', 'stroke-width': stroke + 2.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));

    for (var i = 1; i < points.length; i++) {
      var a = points[i - 1], b = points[i];
      var seg = svg('path', {
        d: 'M' + px(a).toFixed(1) + ' ' + py(a).toFixed(1) + 'L' + px(b).toFixed(1) + ' ' + py(b).toFixed(1),
        fill: 'none',
        stroke: speedColor(speeds[i - 1], domain),
        'stroke-width': stroke,
        'stroke-linecap': 'round'
      });
      if (speeds[i - 1]) {
        var t = svg('title');
        t.textContent = paceLabel(speeds[i - 1]) + ' /km at ' + Utils.formatDuration(a.t);
        seg.appendChild(t);
      }
      root.appendChild(seg);
    }

    // Start and finish are marked by shape, never by colour alone — the colour
    // channel is spoken for by speed.
    var first = points[0], last = points[points.length - 1];
    var r = o.markerRadius || 5;
    root.appendChild(svg('circle', {
      cx: px(first).toFixed(1), cy: py(first).toFixed(1), r: r,
      fill: '#1c232c', stroke: '#e6edf3', 'stroke-width': 2
    }));
    root.appendChild(svg('circle', {
      cx: px(last).toFixed(1), cy: py(last).toFixed(1), r: r,
      fill: '#e6edf3', stroke: '#1c232c', 'stroke-width': 2
    }));

    if (o.labelEnds) {
      [[first, 'Start'], [last, 'Finish']].forEach(function (pair) {
        var label = svg('text', {
          x: (px(pair[0]) + r + 5).toFixed(1), y: (py(pair[0]) + 4).toFixed(1),
          fill: '#e6edf3', 'font-size': 11, 'font-weight': 600,
          stroke: '#0d1117', 'stroke-width': 3, 'paint-order': 'stroke'
        });
        label.textContent = pair[1];
        root.appendChild(label);
      });
    }

    root.__speedDomain = domain;
    root.__project = function (p) { return { x: px(p), y: py(p) }; };
    return root;
  }

  /** Legend for the speed ramp: swatches plus the pace at each end. */
  function routeLegend(domain) {
    var scale = el('div', { class: 'legend-scale' });
    SPEED_RAMP.forEach(function (hex) {
      scale.appendChild(el('i', { style: 'background:' + hex }));
    });
    var labels = el('div', { class: 'legend-labels' }, [
      el('span', { text: domain ? paceLabel(domain.lo) + ' /km' : 'slower' }),
      el('span', { class: 'legend-mid', text: 'slower → faster' }),
      el('span', { text: domain ? paceLabel(domain.hi) + ' /km' : 'faster' })
    ]);
    return el('div', { class: 'legend' }, [scale, labels]);
  }

  return {
    $: $, $$: $$, el: el, svg: svg, clear: clear,
    setText: setText, setStat: setStat,
    message: message, ask: ask, confirm: confirm,
    routeSvg: routeSvg, routeLegend: routeLegend,
    segmentSpeeds: segmentSpeeds, speedDomain: speedDomain, speedColor: speedColor,
    paceLabel: paceLabel, SPEED_RAMP: SPEED_RAMP
  };
})();
