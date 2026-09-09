/* DB — run storage. IndexedDB when available, localStorage as a last resort.
   Everything is client-side; nothing is ever sent anywhere. */
var DB = (function () {
  'use strict';

  var DB_NAME = 'running-tracker';
  var DB_VERSION = 1;
  var STORE = 'runs';
  var LS_KEY = 'runningTracker.runs';

  var backend = null;   // 'indexeddb' | 'localstorage'
  var dbPromise = null;

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
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
    backendName: backendName
  };
})();
