/* App — bootstraps the views, tab routing, timer UI, Deezer embed and settings form. */
(function () {
  'use strict';

  var currentTab = 'tracker';

  /* -------------------------------- tabs -------------------------------- */

  function showTab(name) {
    currentTab = name;
    UI.$$('.view').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== name;
    });
    UI.$$('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === name);
    });
    window.scrollTo(0, 0);
    if (name === 'stats') Stats.refresh();
    if (name === 'calendar') Calendar.refresh();
  }

  function initTabs() {
    UI.$$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); });
    });
  }

  /* ----------------------------- timer view ----------------------------- */

  function initTimerView() {
    var remaining = UI.$('#timerRemaining');
    var roundLabel = UI.$('#timerRound');
    var phasePill = UI.$('#timerPhase');
    var progress = UI.$('#timerProgress');
    var btnStart = UI.$('#btnTimerStart');
    var btnPause = UI.$('#btnTimerPause');
    var btnReset = UI.$('#btnTimerReset');

    var lastHint = null;
    function renderHint() {
      var c = IntervalTimer.config();
      var text = c.rounds + ' × ' + Utils.formatClock(c.workSec) + ' work / ' + Utils.formatClock(c.restSec) +
        ' rest (no rest after the last round) — total ' + Utils.formatDuration(IntervalTimer.totalSec()) +
        '. Change it in Settings.';
      if (text === lastHint) return;      // called on every tick; only touch the DOM on a real change
      lastHint = text;
      UI.setText('#timerConfigHint', text);
    }

    IntervalTimer.onChange(function (s) {
      // Settings edited mid-series are adopted at the next reset, so the hint has to
      // re-render on state changes too, not only when a setting is saved.
      renderHint();
      remaining.textContent = Utils.formatClock(s.remainingSec);
      roundLabel.textContent = s.status === 'done'
        ? 'series complete'
        : 'round ' + Math.max(s.round, s.status === 'idle' ? 0 : 1) + ' / ' + s.rounds;

      var kind = 'pill-idle', label = s.status;
      if (s.status === 'running') {
        kind = s.phase === 'work' ? 'pill-work' : 'pill-rest';
        label = s.phase;
      } else if (s.status === 'paused') {
        kind = 'pill-warn';
      }
      phasePill.className = 'pill ' + kind;
      phasePill.textContent = label;

      progress.style.width = (s.progress * 100).toFixed(1) + '%';
      progress.classList.toggle('rest', s.status === 'running' && s.phase === 'rest');

      btnStart.disabled = s.status === 'running';
      btnStart.textContent = s.status === 'paused' ? 'Resume' : 'Start';
      btnPause.disabled = s.status !== 'running';
      btnReset.disabled = s.status === 'idle';
    });

    btnStart.addEventListener('click', IntervalTimer.start);
    btnPause.addEventListener('click', IntervalTimer.pause);
    btnReset.addEventListener('click', IntervalTimer.reset);

    document.addEventListener('settings-changed', renderHint);
    IntervalTimer.init();
    IntervalTimer.reset();
    renderHint();
  }

  /* ------------------------------- deezer ------------------------------- */

  function renderDeezer() {
    var host = UI.$('#deezerHost');
    UI.clear(host);
    var id = Settings.get('deezerPlaylistId');
    if (!id) {
      host.appendChild(UI.el('p', {
        class: 'deezer-empty',
        text: 'No playlist set. Add a Deezer playlist ID in Settings to embed it here.'
      }));
      return;
    }
    host.appendChild(UI.el('iframe', {
      src: 'https://widget.deezer.com/widget/dark/playlist/' + encodeURIComponent(id),
      width: '100%',
      height: '300',
      frameborder: '0',
      allowtransparency: 'true',
      allow: 'encrypted-media; clipboard-write',
      title: 'Deezer playlist'
    }));

    // The widget is an anonymous listener unless its own iframe carries a Premium
    // session, and browsers partition third-party cookies — so it usually falls back
    // to 30-second previews. The app plays the full tracks; open the playlist there
    // before starting, then come back to this tab to track.
    host.appendChild(UI.el('div', { class: 'btn-row' }, [
      UI.el('a', {
        class: 'btn', href: 'https://www.deezer.com/playlist/' + encodeURIComponent(id),
        target: '_blank', rel: 'noopener', text: 'Open in the Deezer app'
      })
    ]));
    host.appendChild(UI.el('p', {
      class: 'hint',
      text: 'Previews only? The embedded widget cannot see your Premium session — play from the app instead, then return here. Audio keeps going while this tab is in front.'
    }));
  }

  /* ------------------------------ settings ------------------------------ */

  /** One CSS variable drives every session figure; see the #view-tracker rules. */
  function applySessionScale(percent) {
    var pct = Utils.clamp(parseInt(percent, 10) || 100, 100, 200);
    document.documentElement.style.setProperty('--session-scale', (pct / 100).toFixed(2));
    UI.setText('#scaleValue', pct + '%');
  }

  /**
   * Resolve communes for runs that never got one — saved with mobile data off, or
   * imported from a backup made before this existed. Sequential with a pause between
   * calls: one request per run, and Nominatim asks for no more than one per second.
   */
  function fillMissingPlaces() {
    var msg = UI.$('#placeMsg');
    var btn = UI.$('#btnFillPlaces');

    DB.all().then(function (runs) {
      var pending = runs.filter(function (r) {
        return (!r.place || !r.place.commune) && Geocode.runOrigin(r);
      });
      if (!pending.length) {
        UI.message(msg, 'Every run with a GPS trace already has a commune.', 'ok', 6000);
        return;
      }

      btn.disabled = true;
      var resolved = 0, failed = 0;

      function step(i) {
        if (i >= pending.length) {
          btn.disabled = false;
          UI.message(msg, 'Resolved ' + resolved + ' of ' + pending.length + ' runs' +
            (failed ? ' — ' + failed + ' could not be looked up (offline?).' : '.'),
            resolved ? 'ok' : 'err', 10000);
          return;
        }
        var run = pending[i];
        UI.message(msg, 'Looking up ' + (i + 1) + ' of ' + pending.length + '…');
        var origin = Geocode.runOrigin(run);
        Geocode.reverse(origin.lat, origin.lng).then(function (place) {
          if (!place) { failed++; return null; }
          run.place = place;
          resolved++;
          return DB.put(run);
        }).catch(function () { failed++; })
          .then(function () { setTimeout(function () { step(i + 1); }, 1100); });
      }
      step(0);
    });
  }

  function initSettingsView() {
    var deezer = UI.$('#setDeezer');
    var rounds = UI.$('#setRounds');
    var work = UI.$('#setWork');
    var rest = UI.$('#setRest');
    var sound = UI.$('#setSound');
    var accuracy = UI.$('#setAccuracy');
    var decimate = UI.$('#setDecimate');
    var placeLookup = UI.$('#setPlaceLookup');
    var scale = UI.$('#setScale');

    // A focused number input eats wheel events and silently changes value while the
    // page is scrolled — which then gets persisted on `change`. Drop focus instead.
    [rounds, accuracy, decimate].forEach(function (input) {
      input.addEventListener('wheel', function () { input.blur(); }, { passive: true });
    });

    function load() {
      var s = Settings.all();
      deezer.value = s.deezerPlaylistId;
      rounds.value = s.rounds;
      work.value = Utils.formatClock(s.workSec);
      rest.value = Utils.formatClock(s.restSec);
      sound.checked = !!s.sound;
      accuracy.value = s.accuracyThresholdM;
      decimate.value = s.decimateSec;
      placeLookup.checked = !!s.placeLookup;
      scale.value = s.sessionScale;
      applySessionScale(s.sessionScale);
    }

    deezer.addEventListener('change', function () {
      var id = Settings.normalizePlaylistId(deezer.value);
      deezer.value = id;
      Settings.set({ deezerPlaylistId: id });
      renderDeezer();
    });

    rounds.addEventListener('change', function () {
      Settings.set({ rounds: Utils.clamp(parseInt(rounds.value, 10) || 1, 1, 99) });
      load();
    });
    work.addEventListener('change', function () {
      Settings.set({ workSec: Utils.clamp(Utils.parseClock(work.value, 180), 1, 5999) });
      load();
    });
    rest.addEventListener('change', function () {
      Settings.set({ restSec: Utils.clamp(Utils.parseClock(rest.value, 60), 0, 5999) });
      load();
    });
    sound.addEventListener('change', function () { Settings.set({ sound: sound.checked }); });

    UI.$('#btnTestSound').addEventListener('click', function () {
      var btn = UI.$('#btnTestSound');
      if (!IntervalTimer.preview()) {
        btn.textContent = 'No audio';
        return;
      }
      btn.textContent = 'Playing…';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = 'Test'; btn.disabled = false; }, 2600);
    });
    accuracy.addEventListener('change', function () {
      Settings.set({ accuracyThresholdM: Utils.clamp(parseInt(accuracy.value, 10) || 20, 5, 200) });
      load();
    });
    decimate.addEventListener('change', function () {
      Settings.set({ decimateSec: Utils.clamp(parseInt(decimate.value, 10) || 4, 1, 30) });
      load();
    });

    // `input` as well as `change`: the size should follow the thumb as it is dragged,
    // otherwise you cannot judge it without letting go.
    scale.addEventListener('input', function () { applySessionScale(scale.value); });
    scale.addEventListener('change', function () {
      Settings.set({ sessionScale: Utils.clamp(parseInt(scale.value, 10) || 115, 100, 200) });
    });
    scale.addEventListener('wheel', function () { scale.blur(); }, { passive: true });

    placeLookup.addEventListener('change', function () {
      Settings.set({ placeLookup: placeLookup.checked });
    });
    UI.$('#btnFillPlaces').addEventListener('click', fillMissingPlaces);

    load();
  }

  /* -------------------------------- backup ------------------------------ */

  function initBackup() {
    var msg = UI.$('#ioMsg');
    var fileInput = UI.$('#importFile');

    UI.$('#btnExport').addEventListener('click', function () {
      IO.exportAll().then(function (n) {
        UI.message(msg, n ? 'Exported ' + n + ' runs.' : 'Nothing to export yet.', n ? 'ok' : '', 6000);
      }).catch(function (err) {
        UI.message(msg, 'Export failed: ' + (err.message || err), 'err');
      });
    });

    UI.$('#btnImport').addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      IO.handleFile(file, msg).then(function () { fileInput.value = ''; });
    });

    UI.$('#btnWipe').addEventListener('click', function () {
      UI.confirm('Delete all runs?',
        'Every stored run is removed from this browser. Export a backup first if you might want them back.',
        'Delete everything').then(function (ok) {
          if (!ok) return;
          DB.clear().then(function () { UI.message(msg, 'All runs deleted.', 'ok', 6000); });
        });
    });
  }

  /* ------------------------------- viewport ------------------------------ */

  /**
   * Chrome on Android anchors `position: fixed` to the LAYOUT viewport, which keeps
   * the height it has with the URL bar hidden. Scroll up, the URL bar slides back in,
   * the visible area shrinks from the bottom, and the tab bar is left sitting below
   * it — showing only its top half. The visual viewport reports that gap, so lift the
   * bar by it and it stays put whichever way you scroll.
   */
  function initViewportPinning() {
    var vv = window.visualViewport;
    if (!vv) return;                  // no API: nothing to correct with

    var queued = false;
    var last = null;
    function sync() {
      queued = false;
      var gap = UI.viewportGap(document.documentElement.clientHeight, vv);
      if (gap === last) return;
      last = gap;
      // Published as a variable rather than set inline: the tab bar lifts by it and
      // the full-screen dialogs, clipped by the same chrome, inset by it.
      document.documentElement.style.setProperty('--chrome-gap', gap + 'px');
    }
    function schedule() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(sync);
    }

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    sync();
  }

  /* ------------------------------ recovery ------------------------------ */

  /**
   * A session that was never stopped is offered back on the next launch. Asked rather
   * than resumed silently: only the user knows whether they are still out running or
   * looking at this the next morning, and the gap since the last checkpoint is the
   * fact that decides it — so it is put in front of them.
   */
  function offerRecovery() {
    return Tracker.pendingRecovery().then(function (record) {
      if (!record) return;

      var gapSec = Math.max(0, (Date.now() - record.savedAt) / 1000);
      var gapText = gapSec < 90
        ? 'a moment ago'
        : Utils.formatDuration(gapSec) + ' ago';

      return UI.ask('Unfinished run',
        Utils.formatKm(record.distance) + ' km in ' + Utils.formatDuration(record.elapsedSec) +
        ', last saved ' + gapText + '. Resuming carries on from there and counts the gap ' +
        'as a pause, since there is no GPS behind it.',
        [
          { label: 'Discard', value: 'discard', class: 'btn-ghost' },
          { label: 'Save it', value: 'finish', class: '' },
          { label: 'Resume', value: 'resume', class: 'btn-primary' }
        ]).then(function (choice) {
          if (choice === 'resume') return Tracker.resume(record);
          if (choice === 'finish') return Tracker.finishRecovered(record);
          if (choice === 'discard') {
            return UI.confirm('Discard the run?',
              Utils.formatKm(record.distance) + ' km will be deleted and cannot be recovered.',
              'Discard').then(function (ok) {
                // Dismissing the confirm leaves the checkpoint alone, so the offer
                // comes back next launch rather than the run disappearing on a stray tap.
                if (ok) return Tracker.discardRecovery();
              });
          }
          // Dismissed without choosing: keep the checkpoint and ask again next time.
        });
    }).catch(function () { /* never let recovery block the app from starting */ });
  }

  /* -------------------------------- boot -------------------------------- */

  function updateStorageBadge() {
    var parts = [DB.backendName() === 'indexeddb' ? 'IndexedDB' : 'localStorage'];
    if (!WakeLock.supported()) parts.push('no wake lock');
    UI.setText('#storageBadge', parts.join(' · '));
  }

  function boot() {
    applySessionScale(Settings.get('sessionScale'));
    initViewportPinning();
    initTabs();
    Tracker.init();
    initTimerView();
    Stats.init();
    Calendar.init();
    initSettingsView();
    initBackup();
    renderDeezer();

    document.addEventListener('runs-changed', function () {
      if (currentTab === 'stats') Stats.refresh();
      if (currentTab === 'calendar') Calendar.refresh();
    });

    DB.ready().then(function () {
      updateStorageBadge();
      // Warm the caches so the first visit to Stats/Calendar is instant.
      return Stats.refresh();
    }).then(offerRecovery);

    showTab('tracker');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
