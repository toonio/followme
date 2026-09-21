/* IO — JSON export / import. This file is the only backup and the only way to
   move runs between devices, since there is no server. */
var IO = (function () {
  'use strict';

  var FORMAT = 'running-tracker-export';
  var VERSION = 1;

  function exportAll() {
    return DB.all().then(function (runs) {
      var payload = {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        count: runs.length,
        runs: runs
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var name = 'running-tracker-' + Utils.localDayKey(new Date()) + '.json';
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return runs.length;
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read the file')); };
      reader.readAsText(file);
    });
  }

  /** Accepts our export envelope or a bare array of runs. */
  function parse(text) {
    var data = JSON.parse(text);
    var runs = Array.isArray(data) ? data : data.runs;
    if (!Array.isArray(runs)) throw new Error('No run list found in this file.');
    return runs.map(normalize).filter(Boolean);
  }

  function normalize(r) {
    if (!r || typeof r !== 'object') return null;
    var date = r.date ? new Date(r.date) : null;
    if (!date || isNaN(date.getTime())) return null;
    var distance = Number(r.distanceMeters) || 0;
    var duration = Number(r.durationSec) || 0;
    return {
      id: r.id || Utils.uuid(),
      date: date.toISOString(),
      durationSec: Math.round(duration),
      distanceMeters: Math.round(distance),
      avgPaceSecPerKm: Math.round(Number(r.avgPaceSecPerKm) || Utils.paceFrom(distance, duration)),
      elevationGainM: Math.round(Number(r.elevationGainM) || 0),
      elevationLossM: Math.round(Number(r.elevationLossM) || 0),
      cadenceAvgSpm: Math.round(Number(r.cadenceAvgSpm) || 0),
      cadenceSamples: Array.isArray(r.cadenceSamples) ? r.cadenceSamples.filter(function (c) {
        return c && isFinite(c.t) && isFinite(c.spm);
      }) : [],
      place: (r.place && r.place.commune) ? r.place : null,
      points: Array.isArray(r.points) ? r.points.filter(function (p) {
        return p && isFinite(p.lat) && isFinite(p.lng);
      }) : [],
      splits: Array.isArray(r.splits) ? r.splits : []
    };
  }

  /**
   * mode: 'merge' keeps existing runs and adds/overwrites by id,
   *       'replace' wipes the store first.
   */
  function importRuns(incoming, mode) {
    if (mode === 'replace') {
      return DB.replaceAll(incoming).then(function () {
        return { added: incoming.length, updated: 0, mode: mode };
      });
    }
    return DB.all().then(function (existing) {
      var known = {};
      existing.forEach(function (r) { known[r.id] = true; });
      var added = 0, updated = 0;
      incoming.forEach(function (r) { if (known[r.id]) updated++; else added++; });
      return DB.putMany(incoming).then(function () {
        return { added: added, updated: updated, mode: mode };
      });
    });
  }

  function handleFile(file, msgNode) {
    return readFile(file)
      .then(function (text) {
        var runs = parse(text);
        if (!runs.length) throw new Error('The file contains no valid runs.');
        return UI.ask('Import ' + runs.length + ' runs',
          'Merge keeps your existing runs and adds the new ones (same id = overwritten). ' +
          'Replace deletes everything currently stored first.',
          [
            { label: 'Cancel', value: null, class: 'btn-ghost' },
            { label: 'Replace all', value: 'replace', class: 'btn-danger' },
            { label: 'Merge', value: 'merge', class: 'btn-primary' }
          ]).then(function (mode) {
            if (!mode) return null;
            return importRuns(runs, mode);
          });
      })
      .then(function (result) {
        if (!result) { UI.message(msgNode, 'Import cancelled.', '', 4000); return; }
        var text = result.mode === 'replace'
          ? 'Replaced storage with ' + result.added + ' runs.'
          : 'Imported: ' + result.added + ' new, ' + result.updated + ' overwritten.';
        UI.message(msgNode, text, 'ok', 8000);
      })
      .catch(function (err) {
        UI.message(msgNode, 'Import failed: ' + (err.message || err), 'err');
      });
  }

  return { exportAll: exportAll, handleFile: handleFile, parse: parse, importRuns: importRuns };
})();
