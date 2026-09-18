/* DB — run storage. IndexedDB when available, localStorage as a last resort.
   Everything is client-side; nothing is ever sent anywhere. */
var DB = (function () {
  'use strict';

  var DB_NAME = 'running-tracker';
  var DB_VERSION = 2;              // v2 adds the `live` store for crash recovery
  var STORE = 'runs';
  var LIVE_STORE = 'live';
  var LIVE_KEY = 'current';
  var LS_KEY = 'runningTracker.runs';
  var LS_LIVE_KEY = 'runningTracker.live';

  var backend = null;   // 'indexeddb' | 'localstorage'
  var dbPromise = null;

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        // Guarded rather than versioned branches, so upgrading from v1 keeps the
        // existing runs and only adds what is missing.
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains(LIVE_STORE)) {
          db.createObjectStore(LIVE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    });
  }

  function ready() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        backend = 'localstorage';
        return resolve(null);
      }
      openIDB().then(function (db) {
        backend = 'indexeddb';
        resolve(db);
      }).catch(function () {
        // file:// in some browsers, private mode, or a blocked upgrade.
        backend = 'localstorage';
        resolve(null);
      });
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function tx2(db, store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* ---------------------------- localStorage --------------------------- */

  function lsRead() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function lsWrite(runs) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(runs));
      return true;
    } catch (e) {
      throw new Error('Local storage is full — export your runs and delete some.');
    }
  }

  /* ------------------------------- public ------------------------------ */

  function all() {
    return ready().then(function (db) {
      if (!db) return lsRead().slice();
      return reqToPromise(tx(db, 'readonly').getAll());
    }).then(function (runs) {
      runs.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      return runs;
    });
  }

  function get(id) {
    return ready().then(function (db) {
      if (!db) {
        var found = lsRead().filter(function (r) { return r.id === id; });
        return found[0] || null;
      }
      return reqToPromise(tx(db, 'readonly').get(id));
    });
  }

  function put(run) {
    return putMany([run]);
  }

  function putMany(runs) {
    if (!runs || !runs.length) return Promise.resolve(0);
    return ready().then(function (db) {
      if (!db) {
        var existing = lsRead();
        var byId = {};
        existing.forEach(function (r) { byId[r.id] = r; });
        runs.forEach(function (r) { byId[r.id] = r; });
        lsWrite(Object.keys(byId).map(function (k) { return byId[k]; }));
        return runs.length;
      }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        var store = t.objectStore(STORE);
        runs.forEach(function (r) { store.put(r); });
        t.oncomplete = function () { resolve(runs.length); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Write aborted')); };
      });
    }).then(function (n) {
      document.dispatchEvent(new CustomEvent('runs-changed'));
      return n;
    });
  }

  function remove(id) {
    return ready().then(function (db) {
      if (!db) {
        lsWrite(lsRead().filter(function (r) { return r.id !== id; }));
        return;
      }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(id);
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
      });
    }).then(function () {
      document.dispatchEvent(new CustomEvent('runs-changed'));
    });
  }

  function clear() {
    return ready().then(function (db) {
      if (!db) { lsWrite([]); return; }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
      });
    }).then(function () {
      document.dispatchEvent(new CustomEvent('runs-changed'));
    });
  }

  /* --------------------------- live session ---------------------------- */
  /* A run in progress is checkpointed here so a killed tab cannot take it with it.
     Separate store: it is transient, must never appear in stats or exports, and is
     written far more often than a finished run. */

  function saveLive(record) {
    record.id = LIVE_KEY;
    return ready().then(function (db) {
      if (!db) {
        try { localStorage.setItem(LS_LIVE_KEY, JSON.stringify(record)); } catch (e) { /* quota */ }
        return;
      }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(LIVE_STORE, 'readwrite');
        t.objectStore(LIVE_STORE).put(record);
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Checkpoint aborted')); };
      });
    });
  }

  function loadLive() {
    return ready().then(function (db) {
      if (!db) {
        try {
          var raw = localStorage.getItem(LS_LIVE_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      }
      return reqToPromise(tx2(db, LIVE_STORE, 'readonly').get(LIVE_KEY));
    }).catch(function () { return null; });
  }

  function clearLive() {
    return ready().then(function (db) {
      if (!db) {
        try { localStorage.removeItem(LS_LIVE_KEY); } catch (e) { /* ignore */ }
        return;
      }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(LIVE_STORE, 'readwrite');
        t.objectStore(LIVE_STORE).delete(LIVE_KEY);
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
      });
    }).catch(function () { /* nothing to clear */ });
  }

  /** Replace the whole store with the given runs (used by "replace all" import). */
  function replaceAll(runs) {
    return clear().then(function () { return putMany(runs); });
  }

  function backendName() { return backend || 'unknown'; }

  return {
    ready: ready,
    all: all,
    get: get,
    put: put,
    putMany: putMany,
    remove: remove,
    clear: clear,
    replaceAll: replaceAll,
    saveLive: saveLive,
    loadLive: loadLive,
    clearLive: clearLive,
    backendName: backendName
  };
})();
