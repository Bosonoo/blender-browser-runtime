/* SPDX-License-Identifier: GPL-3.0-or-later
 * Blender guest runtime primitives. No account or network authority. */
'use strict';
(function () {
  var MOUNT_PATH = '/bosonoo';
  var AUTOSAVE_INTERVAL_MS = 15000;
  var AUTOSAVE_SETTLE_MS = 5000;
  function safeName(raw) {
    var base = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
    var cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.]+/, '');
    return /\.blend$/i.test(cleaned) ? cleaned : 'project.blend';
  }

  function normaliseKey(path) {
    var p = String(path == null ? '' : path);
    if (p === MOUNT_PATH || p.indexOf(MOUNT_PATH + '/') === 0) p = p.slice(MOUNT_PATH.length);
    p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
    while (p.charAt(0) === '/') p = p.slice(1);
    while (p.length && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
    return p;
  }

  // Blender writes "<file>@" and renames it onto <file>; with save versions it first
  // moves the previous file to "<file>.blend1" (".blend2", ...). Neither is a save.
  function isIgnoredSaveName(key) {
    var base = String(key || '').split('/').pop();
    return base.indexOf('@') !== -1 || /\.blend\d+$/i.test(base);
  }

  // The in-memory filesystem behind the vendor provider contract (mirrors the vendor
  // drop-fs: stat -> {size, isDir} | null, readdir -> names, readFile -> bytes, plus
  // the write side blender.js calls: writeFile, mkdir, unlink, rename).
  // options.onSave(key) fires for a write or rename that lands on the open key;
  // options.onOtherBlend(key) for a .blend landing anywhere else.
  function createMemoryProvider(options) {
    var opts = options || {};
    var files = new Map();
    var dirs = new Map();
    var readOnly = new Set();
    dirs.set('', true);
    var openKey = '';

    function ensureParents(key) {
      var parts = key.split('/');
      parts.pop();
      var acc = '';
      for (var i = 0; i < parts.length; i += 1) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        dirs.set(acc, true);
      }
    }

    function putFile(path, data) {
      var key = normaliseKey(path);
      if (!key) throw new Error('bosonoo-fs: refusing to write the mount root');
      var bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
      ensureParents(key);
      files.set(key, bytes);
      return key;
    }

    function noteWrite(key) {
      if (!openKey || isIgnoredSaveName(key)) return;
      if (key === openKey) {
        if (typeof opts.onSave === 'function') opts.onSave(key);
        return;
      }
      if (/\.blend$/i.test(key) && typeof opts.onOtherBlend === 'function') opts.onOtherBlend(key);
    }

    function childrenOf(dir) {
      var prefix = dir ? dir + '/' : '';
      var seen = {};
      var out = [];
      function add(key) {
        if (key === dir || key.indexOf(prefix) !== 0) return;
        var rest = key.slice(prefix.length);
        if (!rest) return;
        var name = rest.split('/')[0];
        if (!Object.prototype.hasOwnProperty.call(seen, name)) { seen[name] = true; out.push(name); }
      }
      files.forEach(function (_value, key) { add(key); });
      dirs.forEach(function (_value, key) { if (key) add(key); });
      return out;
    }

    var provider = {
      stat: function (path) {
        var key = normaliseKey(path);
        if (files.has(key)) return Promise.resolve({ size: files.get(key).length, isDir: false });
        if (dirs.has(key)) return Promise.resolve({ size: 0, isDir: true });
        return Promise.resolve(null);
      },
      readdir: function (path) {
        var key = normaliseKey(path);
        if (!dirs.has(key)) throw new Error('bosonoo-fs: no such directory');
        return childrenOf(key);
      },
      readFile: function (path) {
        var found = files.get(normaliseKey(path));
        if (!found) return Promise.reject(new Error('bosonoo-fs: no such file'));
        return Promise.resolve(found);
      },
      writeFile: function (path, data) {
        try {
          if (readOnly.has(normaliseKey(path))) throw new Error('This pack file is read-only.');
          noteWrite(putFile(path, data));
          return Promise.resolve(undefined);
        } catch (err) {
          return Promise.reject(err);
        }
      },
      mkdir: function (path) {
        var key = normaliseKey(path);
        if (key) { ensureParents(key); dirs.set(key, true); }
        return Promise.resolve(undefined);
      },
      unlink: function (path) {
        if (readOnly.has(normaliseKey(path))) return Promise.reject(new Error('This pack file is read-only.'));
        files.delete(normaliseKey(path));
        return Promise.resolve(undefined);
      },
      rename: function (from, to) {
        var a = normaliseKey(from);
        var b = normaliseKey(to);
        if (readOnly.has(a) || readOnly.has(b)) return Promise.reject(new Error('This pack file is read-only.'));
        if (!files.has(a)) return Promise.reject(new Error('bosonoo-fs: no such file'));
        if (a === b) return Promise.resolve(undefined);
        var bytes = files.get(a);
        files.delete(a);
        try {
          noteWrite(putFile(b, bytes));
        } catch (err) {
          return Promise.reject(err);
        }
        return Promise.resolve(undefined);
      }
    };

    return {
      provider: provider,
      files: files,
      dirs: dirs,
      putFile: putFile,
      putReadOnly: function (path, data) { var key = putFile(path, data); readOnly.add(key); },
      setOpenKey: function (key) { openKey = normaliseKey(key); },
      openKey: function () { return openKey; },
      read: function (key) { return files.get(normaliseKey(key)) || null; }
    };
  }

  function createAutosaveScheduler(options) {
    var dirtySince = null;
    var lastRequest = null;
    var previous = null;
    return function poll() {
      var now = options.now();
      var status = options.status();
      if (status !== previous) { options.changed(status); previous = status; }
      if (status === 2) { dirtySince = null; return; }
      if (status !== 3 && status !== 4 && status !== 6) return;
      if (dirtySince === null) dirtySince = now;
      if (status === 4) return;
      var retryAfter = status === 6 ? 30000 : AUTOSAVE_INTERVAL_MS;
      if (now - dirtySince < AUTOSAVE_SETTLE_MS || (lastRequest !== null && now - lastRequest < retryAfter)) return;
      if (options.request() !== 1) throw new Error('Blender refused automatic saving.');
      lastRequest = now;
    };
  }


  var api = Object.freeze({safeName: safeName, createMemoryProvider: createMemoryProvider,
    createAutosaveScheduler: createAutosaveScheduler});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'bosonooGuestPrimitives', {value: api});
})();
