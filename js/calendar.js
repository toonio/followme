/* Calendar — month grid with a marker on every day that has a run.
   Clicking a day opens its runs (distance, duration, pace, splits, route). */
var Calendar = (function () {
  'use strict';

  var view = new Date();      // any date inside the displayed month
  var selectedKey = null;
  var byDay = {};             // 'YYYY-MM-DD' -> [run]

  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function indexRuns(runs) {
    byDay = {};
    runs.forEach(function (r) {
      var key = Utils.localDayKey(new Date(r.date));
      (byDay[key] = byDay[key] || []).push(r);
    });
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
    });
  }

  function renderDow() {
    var host = UI.$('#calDow');
    if (host.childElementCount) return;
    DOW.forEach(function (d) { host.appendChild(UI.el('span', { text: d })); });
  }

  function renderGrid() {
    var host = UI.$('#calGrid');
    UI.clear(host);

    var year = view.getFullYear(), month = view.getMonth();
    UI.setText('#calTitle', Utils.MONTHS[month] + ' ' + year);

    var first = new Date(year, month, 1);
    var lead = (first.getDay() + 6) % 7;             // Monday-first grid
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = Utils.localDayKey(new Date());

    for (var i = 0; i < lead; i++) {
      host.appendChild(UI.el('div', { class: 'cal-cell blank' }));
    }

    var monthRuns = [];
    for (var day = 1; day <= daysInMonth; day++) {
      var key = year + '-' + Utils.pad2(month + 1) + '-' + Utils.pad2(day);
      var dayRuns = byDay[key] || [];
      monthRuns = monthRuns.concat(dayRuns);

      var cls = 'cal-cell';
      if (dayRuns.length) cls += ' has-run';
      if (key === todayKey) cls += ' today';
      if (key === selectedKey) cls += ' selected';

      var children = [UI.el('span', { class: 'cal-day-num', text: String(day) })];
      if (dayRuns.length) {
        var dist = dayRuns.reduce(function (sum, r) { return sum + (r.distanceMeters || 0); }, 0);
        children.push(UI.el('span', { class: 'cal-badge', text: Utils.formatKm(dist, 1) }));
      }

      var cell = UI.el('div', { class: cls, 'data-key': key }, children);
      if (dayRuns.length) {
        cell.setAttribute('role', 'button');
        cell.setAttribute('tabindex', '0');
        (function (k) {
          cell.addEventListener('click', function () { select(k); });
          cell.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(k); }
          });
        })(key);
      }
      host.appendChild(cell);
    }

    var s = Stats.summarize(monthRuns);
    UI.setText('#calSummary', monthRuns.length
      ? s.runs + ' runs · ' + Utils.formatKm(s.distance, 1) + ' km · ' +
        Utils.formatDuration(s.duration) + ' · ' + Utils.formatPace(s.pace) + ' /km · +' + s.ascent + ' m'
      : 'No runs this month.');
  }

  function select(key) {
    selectedKey = (selectedKey === key) ? null : key;
    renderGrid();
    renderDetail();
  }

  function renderDetail() {
    var card = UI.$('#calDetailCard');
    var host = UI.$('#calDetail');
    UI.clear(host);

    var dayRuns = selectedKey ? (byDay[selectedKey] || []) : [];
    if (!dayRuns.length) { card.hidden = true; return; }

    var d = new Date(selectedKey + 'T00:00:00');
    UI.setText('#calDetailTitle', d.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }));

    dayRuns.forEach(function (r) {
      var block = UI.el('div', { class: 'day-run' });

      var grid = UI.el('div', { class: 'summary-grid' });
      var rows = [
        ['Start', new Date(r.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })],
        ['Distance', Utils.formatKm(r.distanceMeters) + ' km'],
        ['Duration', Utils.formatDuration(r.durationSec)],
        ['Avg pace', Utils.formatPace(r.avgPaceSecPerKm) + ' /km'],
        ['Ascent / descent', '+' + (r.elevationGainM || 0) + ' / -' + (r.elevationLossM || 0) + ' m']
      ];
      if (r.place && r.place.commune) rows.push(['Commune', Geocode.label(r.place)]);
      rows.forEach(function (row) {
        grid.appendChild(UI.el('div', {}, [
          UI.el('span', { text: row[0] }),
          UI.el('span', { text: row[1] })
        ]));
      });
      block.appendChild(grid);

      var route = UI.routeFigure(r);
      if (route) block.appendChild(route);

      if (r.splits && r.splits.length) {
        var splits = UI.el('div', { class: 'splits' });
        r.splits.forEach(function (sp) {
          var chip = UI.el('span', { class: 'split' }, [
            UI.el('b', { text: 'km ' + sp.km }),
            document.createTextNode(' ' + Utils.formatDuration(sp.sec))
          ]);
          splits.appendChild(chip);
        });
        block.appendChild(splits);
      }

      block.appendChild(UI.el('div', { class: 'btn-row' }, [
        UI.el('button', {
          class: 'btn btn-ghost', text: 'Delete run',
          onclick: function () {
            UI.confirm('Delete run?', Utils.formatDateTime(r.date) + ' — ' +
              Utils.formatKm(r.distanceMeters) + ' km. This cannot be undone.', 'Delete')
              .then(function (ok) { if (ok) DB.remove(r.id); });
          }
        })
      ]));

      host.appendChild(block);
    });

    card.hidden = false;
  }

  function shift(months) {
    view = new Date(view.getFullYear(), view.getMonth() + months, 1);
    renderGrid();
  }

  function refresh() {
    return DB.all().then(function (runs) {
      indexRuns(runs);
      if (selectedKey && !byDay[selectedKey]) selectedKey = null;
      renderDow();
      renderGrid();
      renderDetail();
    });
  }

  function init() {
    UI.$('#calPrev').addEventListener('click', function () { shift(-1); });
    UI.$('#calNext').addEventListener('click', function () { shift(1); });
  }

  return { init: init, refresh: refresh };
})();
