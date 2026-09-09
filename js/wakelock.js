/* WakeLock — keeps the screen on while the GPS tracker or the interval timer runs.
   Reference-counted so either tool can hold it independently.
   The lock is auto-released when the tab is backgrounded, so it is re-acquired
   on visibilitychange. Chrome/Chromium on Android is the reliable target;
   iOS Safari support is inconsistent. */
var WakeLock = (function () {
  'use strict';

  var holders = {};       // tag -> true
  var sentinel = null;
  var listening = false;
  var lastError = null;

  function supported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  function request() {
    if (!supported() || sentinel) return Promise.resolve(sentinel);
    return navigator.wakeLock.request('screen').then(function (s) {
      sentinel = s;
      lastError = null;
      s.addEventListener('release', function () {
        if (sentinel === s) sentinel = null;
      });
      return s;
    }).catch(function (err) {
      // NotAllowedError when the document is hidden or the page is not secure.
      sentinel = null;
      lastError = err;
      return null;
    });
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && Object.keys(holders).length) request();
  }

  function acquire(tag) {
    holders[tag] = true;
    if (!listening) {
      document.addEventListener('visibilitychange', onVisibility);
      listening = true;
    }
    return request();
  }

  function release(tag) {
    delete holders[tag];
    if (Object.keys(holders).length) return Promise.resolve();
    var s = sentinel;
    sentinel = null;
    if (listening) {
      document.removeEventListener('visibilitychange', onVisibility);
      listening = false;
    }
    return s ? s.release().catch(function () {}) : Promise.resolve();
  }

  function active() { return !!sentinel; }
  function error() { return lastError; }

  return { supported: supported, acquire: acquire, release: release, active: active, error: error };
})();
