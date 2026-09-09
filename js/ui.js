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

  /** Route preview: normalised polyline of a stored trace. Returns null if too short. */
  function routeSvg(points, opts) {
    if (!points || points.length < 2) return null;
    var o = opts || {};
    var w = o.width || 320, h = o.height || 160, pad = 10;

    var lats = points.map(function (p) { return p.lat; });
    var lngs = points.map(function (p) { return p.lng; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);

    // Keep the aspect ratio honest: 1 deg of longitude is shorter than 1 deg of latitude.
    var midLat = (minLat + maxLat) / 2;
    var spanX = Math.max((maxLng - minLng) * Math.cos(midLat * Math.PI / 180), 1e-7);
    var spanY = Math.max(maxLat - minLat, 1e-7);
    var scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    var offX = (w - spanX * scale) / 2;
    var offY = (h - spanY * scale) / 2;

    var d = points.map(function (p, i) {
      var x = offX + (p.lng - minLng) * Math.cos(midLat * Math.PI / 180) * scale;
      var y = h - (offY + (p.lat - minLat) * scale);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');

    var root = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': 'Route preview' });
    root.appendChild(svg('path', {
      d: d, fill: 'none', stroke: '#4cc9a0', 'stroke-width': 2.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));
    var first = points[0], last = points[points.length - 1];
    function marker(p, color) {
      return svg('circle', {
        cx: (offX + (p.lng - minLng) * Math.cos(midLat * Math.PI / 180) * scale).toFixed(1),
        cy: (h - (offY + (p.lat - minLat) * scale)).toFixed(1),
        r: 4, fill: color
      });
    }
    root.appendChild(marker(first, '#58a6ff'));
    root.appendChild(marker(last, '#e5534b'));
    return root;
  }

  return {
    $: $, $$: $$, el: el, svg: svg, clear: clear,
    setText: setText, setStat: setStat,
    message: message, ask: ask, confirm: confirm,
    routeSvg: routeSvg
  };
})();
