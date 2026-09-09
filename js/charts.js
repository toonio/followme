/* Charts — hand-rolled SVG bar chart. No library, no network. */
var Charts = (function () {
  'use strict';

  var H = 220;
  var PAD_TOP = 22;
  var PAD_BOTTOM = 34;
  var PAD_LEFT = 44;
  var PAD_RIGHT = 8;

  /**
   * items: [{ label, value, title }]
   * opts:  { format(value) -> string, zeroBased (default true), color }
   */
  function bar(container, items, opts) {
    var o = opts || {};
    var fmt = o.format || function (v) { return String(Math.round(v)); };
    UI.clear(container);

    if (!items || !items.length) {
      container.appendChild(UI.el('p', { class: 'chart-empty', text: 'No data yet — record a run first.' }));
      return;
    }

    var values = items.map(function (i) { return i.value; });
    var maxV = Math.max.apply(null, values);
    var minV = Math.min.apply(null, values);
    var zeroBased = o.zeroBased !== false;

    var yMax, yMin;
    if (zeroBased) {
      yMin = 0;
      yMax = maxV > 0 ? maxV * 1.12 : 1;
    } else {
      var span = (maxV - minV) || maxV * 0.1 || 1;
      yMin = Math.max(0, minV - span * 0.35);
      yMax = maxV + span * 0.15;
    }
    var range = (yMax - yMin) || 1;

    var barW = 34;
    var gap = 12;
    var innerW = items.length * barW + (items.length - 1) * gap;
    var W = Math.max(320, PAD_LEFT + innerW + PAD_RIGHT);
    var plotW = W - PAD_LEFT - PAD_RIGHT;
    var plotH = H - PAD_TOP - PAD_BOTTOM;
    if (innerW < plotW) {
      // Few bars: spread them out instead of clumping on the left.
      gap = items.length > 1 ? (plotW - items.length * barW) / (items.length - 1) : 0;
      gap = Math.min(gap, 60);
    }
    var usedW = items.length * barW + (items.length - 1) * gap;
    var startX = PAD_LEFT + Math.max(0, (plotW - usedW) / 2);

    var svg = UI.svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });

    function y(v) { return PAD_TOP + plotH * (1 - (v - yMin) / range); }

    // Gridlines + y labels
    [0, 0.5, 1].forEach(function (frac) {
      var v = yMin + range * frac;
      var yy = y(v);
      svg.appendChild(UI.svg('line', {
        x1: PAD_LEFT - 4, x2: W - PAD_RIGHT, y1: yy.toFixed(1), y2: yy.toFixed(1),
        stroke: '#2a323d', 'stroke-width': 1
      }));
      var label = UI.svg('text', {
        x: PAD_LEFT - 8, y: (yy + 3.5).toFixed(1), 'text-anchor': 'end',
        fill: '#8b98a5', 'font-size': 10
      });
      label.textContent = fmt(v);
      svg.appendChild(label);
    });

    items.forEach(function (item, i) {
      var x = startX + i * (barW + gap);
      var top = y(item.value);
      var height = Math.max(2, PAD_TOP + plotH - top);

      var rect = UI.svg('rect', {
        x: x.toFixed(1), y: top.toFixed(1), width: barW, height: height.toFixed(1),
        rx: 5, fill: o.color || '#4cc9a0', opacity: 0.9
      });
      var t = UI.svg('title');
      t.textContent = (item.title || item.label) + ' — ' + fmt(item.value);
      rect.appendChild(t);
      svg.appendChild(rect);

      var valueText = UI.svg('text', {
        x: (x + barW / 2).toFixed(1), y: (top - 6).toFixed(1), 'text-anchor': 'middle',
        fill: '#e6edf3', 'font-size': 10, 'font-weight': 600
      });
      valueText.textContent = fmt(item.value);
      svg.appendChild(valueText);

      var labelText = UI.svg('text', {
        x: (x + barW / 2).toFixed(1), y: (H - PAD_BOTTOM + 15).toFixed(1), 'text-anchor': 'middle',
        fill: '#8b98a5', 'font-size': 10
      });
      labelText.textContent = item.label;
      svg.appendChild(labelText);
    });

    // Baseline
    svg.appendChild(UI.svg('line', {
      x1: PAD_LEFT - 4, x2: W - PAD_RIGHT,
      y1: PAD_TOP + plotH, y2: PAD_TOP + plotH,
      stroke: '#3a4453', 'stroke-width': 1
    }));

    var wrap = UI.el('div', { style: 'overflow-x:auto' });
    wrap.appendChild(svg);
    container.appendChild(wrap);
  }

  return { bar: bar };
})();
