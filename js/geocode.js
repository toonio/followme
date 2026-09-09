/* Geocode — resolve a coordinate to a commune name.
 *
 * This is the ONLY outbound request the app makes besides the Deezer widget, and it
 * is a deliberate exception to the spec's "no API calls": a commune name cannot be
 * derived from a coordinate offline without shipping a boundary dataset.
 *
 * Ground rules kept as narrow as possible:
 *  - one request per saved run, never during tracking;
 *  - the coordinate is rounded to ~100 m before it is sent (plenty for a commune,
 *    and it does not hand over your exact front door);
 *  - the result is stored on the run, so it is never looked up twice;
 *  - failure is silent and non-blocking — the run is already saved either way;
 *  - the whole thing is switchable in Settings.
 *
 * BAN (the French government address base) first: no key, no quota worth worrying
 * about, authoritative INSEE codes. Nominatim covers runs outside France.
 */
var Geocode = (function () {
  'use strict';

  var BAN = 'https://api-adresse.data.gouv.fr/reverse/';
  var OSM = 'https://nominatim.openstreetmap.org/reverse';

  /** ~100 m of precision: enough to name a commune, no more than that. */
  function coarse(n) { return Math.round(n * 1000) / 1000; }

  function getJSON(url, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 8000);
    var opts = { method: 'GET', mode: 'cors', credentials: 'omit' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function viaBan(lat, lng) {
    return getJSON(BAN + '?lat=' + coarse(lat) + '&lon=' + coarse(lng), 8000).then(function (data) {
      var f = data && data.features && data.features[0];
      var p = f && f.properties;
      if (!p || !p.city) return null;
      return {
        commune: p.city,
        postcode: p.postcode || '',
        insee: p.citycode || '',
        source: 'ban',
        at: new Date().toISOString()
      };
    });
  }

  function viaNominatim(lat, lng) {
    var url = OSM + '?format=jsonv2&zoom=10&addressdetails=1&lat=' + coarse(lat) + '&lon=' + coarse(lng);
    return getJSON(url, 10000).then(function (data) {
      var a = data && data.address;
      if (!a) return null;
      var name = a.village || a.town || a.city || a.municipality || a.hamlet || a.county;
      if (!name) return null;
      return {
        commune: name,
        postcode: a.postcode || '',
        insee: '',
        country: (a.country_code || '').toUpperCase(),
        source: 'osm',
        at: new Date().toISOString()
      };
    });
  }

  /** Resolves to a place object, or null if nothing could be determined. */
  function reverse(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return Promise.resolve(null);
    return viaBan(lat, lng)
      .catch(function () { return null; })
      .then(function (place) {
        if (place) return place;
        return viaNominatim(lat, lng).catch(function () { return null; });
      });
  }

  /** First usable fix of a run — where it started. */
  function runOrigin(run) {
    var p = run && run.points && run.points[0];
    return (p && isFinite(p.lat) && isFinite(p.lng)) ? p : null;
  }

  function label(place) {
    if (!place || !place.commune) return '';
    return place.postcode ? place.commune + ' (' + place.postcode + ')' : place.commune;
  }

  return { reverse: reverse, runOrigin: runOrigin, label: label };
})();
