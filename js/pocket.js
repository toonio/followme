/* Pocket — a lock screen for a run in progress.
 *
 * The screen has to stay on for tracking to continue (a hidden page is frozen, and
 * there is no web API that changes that), which leaves two problems: a live touch
 * surface in a pocket produces misclicks, and a lit UI costs battery. This covers the
 * screen with an opaque black sheet that swallows every touch, draws the bare minimum
 * on top of it, and only lets go for a deliberate slide.
 *
 * Black rather than dimmed: on an OLED panel black pixels are effectively off, so the
 * darker the sheet the less it costs. How visible the readout is on top is the user's
 * call — Settings carries the dim level and the idle delay.
 */
var Pocket = (function () {
  'use strict';

  var PEEK_MS = 5000;        // how long a tap reveals the readout before fading back
  var UNLOCK_FRACTION = 0.92; // how far the handle must travel to count

  var locked = false;
  var previewing = false;
  var lastActivity = Date.now();
  var idleTimer = null;
  var peekTimer = null;
  var tickTimer = null;
  var dom = {};
  var drag = null;

  /* -------------------------------- state ------------------------------- */

  function delaySec() {
    return Utils.clamp(parseInt(Settings.get('pocketDelaySec'), 10) || 0, 0, 600);
  }

  function dimOpacity() {
    return Utils.clamp(parseInt(Settings.get('pocketOpacity'), 10), 0, 100) / 100;
  }

  function isLocked() { return locked; }

  /** Any interaction postpones the automatic lock. */
  function noteActivity() {
    lastActivity = Date.now();
  }

  /* ------------------------------- display ------------------------------ */

  function applyDim(value) {
    if (dom.dim) dom.dim.style.opacity = value;
  }

  /**
   * Show the sheet from Settings so the brightness can be judged against the real
   * thing. No run is needed, and it unlocks the same way — which doubles as practice
   * at the gesture before relying on it mid-run.
   */
  function preview() {
    if (locked) return;
    locked = true;
    previewing = true;
    setHandle(0);
    dom.root.hidden = false;
    document.body.classList.add('is-pocketed');
    UI.setText(dom.elapsed, Tracker.isActive() ? Tracker.liveFigures().elapsed : '0:00');
    UI.setText(dom.distance, Tracker.isActive() ? Tracker.liveFigures().distance : '0.00 km');
    applyDim(dimOpacity());
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(renderFace, 1000);
  }

  /** Reveal the readout briefly, then sink back to the configured dim level. */
  function peek() {
    applyDim(1);
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(function () {
      peekTimer = null;
      if (locked) applyDim(dimOpacity());
    }, PEEK_MS);
  }

  function renderFace() {
    if (!locked || (previewing && !Tracker.isActive())) return;
    var live = Tracker.liveFigures();
    UI.setText(dom.elapsed, live.elapsed);
    UI.setText(dom.distance, live.distance);
  }

  /* ------------------------------ unlocking ----------------------------- */

  function handleWidth() {
    return dom.handle ? dom.handle.getBoundingClientRect().width : 56;
  }

  function trackSpan() {
    if (!dom.track) return 1;
    return Math.max(1, dom.track.getBoundingClientRect().width - handleWidth() - 8);
  }

  function setHandle(px) {
    dom.handle.style.transform = 'translateX(' + Math.round(px) + 'px)';
  }

  function onDragStart(ev) {
    if (!locked) return;
    ev.preventDefault();
    ev.stopPropagation();
    peek();
    drag = { startX: pointerX(ev), offset: 0 };
    dom.track.classList.add('is-dragging');
  }

  function onDragMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    var span = trackSpan();
    drag.offset = Utils.clamp(pointerX(ev) - drag.startX, 0, span);
    setHandle(drag.offset);
    if (drag.offset >= span * UNLOCK_FRACTION) {
      endDrag();
      unlock();
    }
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    dom.track.classList.remove('is-dragging');
    setHandle(0);
  }

  function pointerX(ev) {
    if (ev.touches && ev.touches.length) return ev.touches[0].clientX;
    if (ev.changedTouches && ev.changedTouches.length) return ev.changedTouches[0].clientX;
    return ev.clientX;
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function lock() {
    if (locked || !Tracker.isActive()) return;
    locked = true;
    setHandle(0);
    dom.root.hidden = false;
    document.body.classList.add('is-pocketed');
    renderFace();
    peek();                                    // show what it is before it goes dark
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(renderFace, 1000);  // a readout, not an animation
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    previewing = false;
    dom.root.hidden = true;
    document.body.classList.remove('is-pocketed');
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    noteActivity();
  }

  /**
   * Auto-lock only while a run is actually being tracked and the Tracker is in front.
   * Locking the screen under someone reading their stats would be a bug, not a feature.
   */
  function shouldAutoLock() {
    if (locked || !Tracker.isActive()) return false;
    var delay = delaySec();
    if (!delay) return false;                  // 0 = never
    if (document.querySelector('#view-tracker').hidden) return false;
    return (Date.now() - lastActivity) >= delay * 1000;
  }

  function checkIdle() {
    if (shouldAutoLock()) lock();
  }

  function applySettings() {
    if (locked && !peekTimer) applyDim(dimOpacity());
  }

  function init() {
    dom.root = UI.$('#pocket');
    dom.dim = UI.$('#pocketDim');
    dom.elapsed = UI.$('#pocketElapsed');
    dom.distance = UI.$('#pocketDistance');
    dom.track = UI.$('#pocketTrack');
    dom.handle = UI.$('#pocketHandle');
    if (!dom.root) return;

    // Swallow everything that is not the unlock control. `passive: false` matters:
    // without it preventDefault is ignored and the page scrolls behind the sheet.
    ['touchstart', 'touchmove', 'touchend', 'click'].forEach(function (type) {
      dom.root.addEventListener(type, function (ev) {
        if (drag) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (type === 'touchstart' || type === 'click') peek();
      }, { passive: false });
    });

    dom.handle.addEventListener('touchstart', onDragStart, { passive: false });
    dom.handle.addEventListener('mousedown', onDragStart);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('touchend', endDrag);
    document.addEventListener('mouseup', endDrag);

    // Anything the user does postpones the lock.
    ['pointerdown', 'keydown', 'wheel'].forEach(function (type) {
      document.addEventListener(type, function () {
        if (!locked) noteActivity();
      }, { passive: true });
    });

    document.addEventListener('settings-changed', applySettings);
    idleTimer = setInterval(checkIdle, 1000);
    noteActivity();
  }

  return {
    init: init, lock: lock, unlock: unlock, preview: preview, isLocked: isLocked,
    noteActivity: noteActivity, applySettings: applySettings,
    delaySec: delaySec, dimOpacity: dimOpacity
  };
})();
