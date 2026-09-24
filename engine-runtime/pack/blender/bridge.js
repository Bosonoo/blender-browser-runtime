/* Bosonoo engine bootstrap for the development Blender pack (browser Blender 5.3 alpha).
 *
 * Served from the cookieless engine origin next to the vendor build. It is the only
 * Bosonoo code that runs in the engine window. Sequence (contract §11.3):
 *
 *   0. read #launch=<grant>, strip the fragment synchronously, install the
 *      window.Module interception and the vendor file-hook overrides before any
 *      vendor code runs; refuse unless crossOriginIsolated;
 *   1. refuse with a clear message if WebGPU or an adapter is missing;
 *   2. clear the vendor's per-origin state that could leak between people sharing a
 *      browser profile (IndexedDB blender-localmount, OPFS recent-files);
 *   3. open the WebSocket to window.BOSONOO_BROKER_WS and send engine.connect;
 *   4. hydrate the single .blend into the in-memory provider that Blender mounts at
 *      /bosonoo, verifying its byte count and SHA-256;
 *   5. window.__BARGS = ['--disable-autoexec', '/bosonoo/workspace/<safeName>',
 *      '--python', '/bosonoo/runtime/session.py'] (the pack's session guard), plus
 *      the pack's command adapter when the broker granted the command protocol;
 *   6. launch through the vendor Launch button once the file is loaded and the
 *      vendor download is done;
 *   7. a provider write or rename that lands on the open file is the user's save
 *      (.blendN backups and "@" temporary names are ignored); debounce 1.5 s, copy
 *      the bytes and run the one-file snapshot exchange; show where it was saved.
 *
 * Dependency-free, no bundler, ES5 syntax (var/function; Promises, Map, Web Crypto,
 * MutationObserver and WebSocket are the runtime features assumed). Every network
 * failure ends in a visible terminal state; nothing retries silently. This page
 * never posts messages to another window.
 *
 * Loaded in Node (tests), the file exports its pure helpers and never touches the DOM.
 */

'use strict';

(function () {
  // --- constants -----------------------------------------------------------
  var PROTOCOL = 1;
  var ENGINE = 'blender';
  var HYDRATE_PAGE = 64;              // runtime_hydration.MAX_PLAN_PAGE_ITEMS
  var HYDRATE_CHUNK = 256 * 1024;     // runtime_hydration.MAX_CHUNK_BYTES
  var MAX_HYDRATE_CHUNK = 1024 * 1024; // negotiated by the authenticated broker
  var SNAPSHOT_CHUNK = 256 * 1024;    // snapshot_receiver.MAX_CHUNK_BYTES
  var MAX_HYDRATE_BYTES = 90 * 1024 * 1024;
  var MAX_SAVE_BYTES = 90 * 1024 * 1024;   // the Library single-item replace limit (§11.2)
  var CONNECT_TIMEOUT_MS = 4000;      // the broker allows 5 s for engine.connect
  var OP_TIMEOUT_MS = 30000;
  var PING_INTERVAL_MS = 20000;
  var SAVE_DEBOUNCE_MS = 1500;
  var AUTOSAVE_SETTLE_MS = 5000;
  var AUTOSAVE_INTERVAL_MS = 15000;
  var LAUNCH_TIMEOUT_MS = 15 * 60 * 1000;
  var MOUNT_ID = 7;                   // 0 = vendor assets tar, 1 = vendor drag-drop folder
  var MOUNT_PATH = '/bosonoo';
  var WORKSPACE_DIR = 'workspace';
  var ENCODING = 'bosonoo-blender-manifest-v1';
  var MANIFEST_DOMAIN = 'BOSONOO:BLENDER:SNAPSHOT:MANIFEST:1\x00';
  var SEAL_DOMAIN = 'BOSONOO:BLENDER:SNAPSHOT:SEAL:1\x00';
  var SAVE_HINT = 'Use File > Save inside Blender. This shortcut does not save your edits.';
  var FATAL_LOG = /Failed to read blend file|file could not be loaded|Blender quit|^\[\w+\]\s*ABORT:|Failed to start:/i;

  // --- pure helpers (shared with the Node tests) ---------------------------
  function utf8(value) {
    return new TextEncoder().encode(String(value));
  }

  function u32be(value) {
    var out = new Uint8Array(4);
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return out;
  }

  function u64be(value) {
    // Sizes are < 2^53; split without bit operators on the high word.
    var high = Math.floor(value / 4294967296);
    var low = value - high * 4294967296;
    var out = new Uint8Array(8);
    out.set(u32be(high), 0);
    out.set(u32be(low), 4);
    return out;
  }

  function hexToBytes(hex) {
    var value = String(hex);
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('digest is not 64 hex characters');
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i += 1) out[i] = parseInt(value.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '';
    for (var i = 0; i < view.length; i += 1) out += (view[i] < 16 ? '0' : '') + view[i].toString(16);
    return out;
  }

  function concat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i += 1) total += parts[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j += 1) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }
    return out;
  }

  function sha256Hex(bytes) {
    var subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
    if (!subtle) return Promise.reject(new Error('Web Crypto is unavailable'));
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Copy so the digest never sees a view over a buffer that keeps changing.
    var copy = new Uint8Array(view.length);
    copy.set(view);
    return subtle.digest('SHA-256', copy).then(bytesToHex);
  }

  // canonical_parts port with the Blender domain: length-prefixed UTF-8 text,
  // big-endian integers. The layout is the receiver's; only the domain differs.
  function lengthPrefixed(value) {
    var raw = utf8(value);
    return concat([u32be(raw.length), raw]);
  }

  function canonicalParts(folders, files, totalBytes) {
    var parts = [utf8(MANIFEST_DOMAIN)];
    parts.push(concat([u32be(1), lengthPrefixed(''), new Uint8Array([1])]));
    parts.push(concat([u32be(folders.length), u32be(files.length), u64be(totalBytes)]));
    var i;
    for (i = 0; i < folders.length; i += 1) {
      parts.push(concat([utf8('D'), u32be(folders[i].index), lengthPrefixed(folders[i].relativePath)]));
    }
    for (i = 0; i < files.length; i += 1) {
      parts.push(concat([utf8('F'), u32be(files[i].index), lengthPrefixed(files[i].relativePath)]));
      parts.push(concat([u64be(files[i].bytes), hexToBytes(files[i].sha256)]));
    }
    parts.push(new Uint8Array([0xff]));
    return parts;
  }

  function manifestDigest(folders, files, totalBytes) {
    var encoded = concat(canonicalParts(folders, files, totalBytes));
    return sha256Hex(encoded).then(function (hex) {
      return { encodedBytes: encoded.length, manifestSha256: hex };
    });
  }

  function sealDigest(manifestSha256) {
    return sha256Hex(concat([utf8(SEAL_DOMAIN), hexToBytes(manifestSha256)]));
  }

  // The Blender snapshot is exactly one file at the project root: folders [""] and
  // the anchor's manifest relative_path (§11.2). Resolves to {manifest, files}.
  function buildSnapshot(relativePath, bytes) {
    var path = String(relativePath || '');
    if (!path || path.indexOf('/') !== -1) return Promise.reject(new Error('The file name Bosonoo sent is not a single name.'));
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return Promise.reject(new Error('The saved file is empty.'));
    if (bytes.length > MAX_SAVE_BYTES) {
      return Promise.reject(new Error('The saved file is ' + Math.round(bytes.length / 1048576) + ' MiB; Bosonoo accepts at most 90 MiB.'));
    }
    return sha256Hex(bytes).then(function (hash) {
      var folders = [{ index: 0, relativePath: '' }];
      var files = [{ index: 0, relativePath: path, bytes: bytes.length, sha256: hash }];
      return manifestDigest(folders, files, bytes.length).then(function (digest) {
        return {
          manifest: {
            schemaVersion: 1,
            encoding: ENCODING,
            root: '',
            inventoryComplete: true,
            folderCount: 1,
            fileCount: 1,
            totalBytes: bytes.length,
            encodedBytes: digest.encodedBytes,
            manifestSha256: digest.manifestSha256,
            folders: folders,
            files: files
          },
          files: [{ index: 0, relativePath: path, bytes: bytes, sha256: hash }]
        };
      });
    });
  }

  // One path segment, no separators, no leading dots, always ending in ".blend". The
  // name is used both as the provider key and as Blender argv, so both derive from this
  // one function; Blender appends ".blend" to a name that lacks it, and that write would
  // land beside the open key instead of on it, so a real save would never reach Bosonoo.
  // An anchor whose sanitised name cannot carry the extension (".blend" itself becomes
  // "blend" once the leading dot is stripped) mounts under the safe default instead.
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
      releaseCommandBuffers: function (id) {
        if (!/^[A-Za-z0-9_-]{1,96}$/.test(id || '')) throw new Error('Invalid command buffer identity.');
        ['automation/assets/' + id + '.png', 'automation/assets/' + id + '.jpg', 'automation/outputs/' + id + '.glb'].forEach(function (key) {
          files.delete(key); readOnly.delete(key);
        });
      },
      setOpenKey: function (key) { openKey = normaliseKey(key); },
      openKey: function () { return openKey; },
      read: function (key) { return files.get(normaliseKey(key)) || null; }
    };
  }

  function randomId(prefix) {
    var raw = new Uint8Array(16);
    crypto.getRandomValues(raw);
    return prefix + bytesToHex(raw);
  }

  function hydrationChunkSize(advertised) {
    return typeof advertised === 'number' && Number.isSafeInteger(advertised) && advertised > 0
      ? Math.min(advertised, MAX_HYDRATE_CHUNK) : HYDRATE_CHUNK;
  }

  // Requests native serialization, never re-labels the last saved file as edits.
  // Native state 4 (modal editing) is explicitly deferred. A failed native write
  // retains dirty work and is retried after a bounded 30 second backoff.
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

  var helpers = Object.freeze({
    canonicalParts: canonicalParts, manifestDigest: manifestDigest, sealDigest: sealDigest,
    buildSnapshot: buildSnapshot, safeName: safeName, normaliseKey: normaliseKey,
    isIgnoredSaveName: isIgnoredSaveName, createMemoryProvider: createMemoryProvider,
    concat: concat, sha256Hex: sha256Hex, bytesToHex: bytesToHex,
    MANIFEST_DOMAIN: MANIFEST_DOMAIN, SEAL_DOMAIN: SEAL_DOMAIN, ENCODING: ENCODING, MOUNT_PATH: MOUNT_PATH,
    SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS, MAX_SAVE_BYTES: MAX_SAVE_BYTES,
    hydrationChunkSize: hydrationChunkSize, createAutosaveScheduler: createAutosaveScheduler
  });

  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
    return;
  }

  // --- 0. grant, then the vendor extension points --------------------------
  // Runs synchronously while this script tag is parsed, before any vendor code.
  var grant = '';
  (function readAndClearGrant() {
    var hash = String(window.location.hash || '');
    var match = /^#launch=([A-Za-z0-9_.~-]+)$/.exec(hash);
    if (match) grant = match[1];
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      grant = '';
    }
  })();

  var state = {
    recovery: null,
    phase: 'init',          // init | checking | connecting | connected | hydrating | waiting | launching | running | failed | disconnected
    terminal: false,
    ws: null,
    session: null,          // {session_id, epoch, expires_ts, project_name}
    saveTarget: null,       // {kind, name} from engine.connected
    relativePath: '',       // the anchor's manifest relative_path, echoed in every snapshot
    openName: '',
    bargs: null,            // frozen argv once hydrated
    launchArmed: false,
    launched: false,
    mounted: false,
    expectBinaryFor: null,
    waiter: null,
    snapshot: null,
    saving: false,
    hasUncommittedSave: false,
    hasLocalSave: false,
    dirtyWhileSaving: false,
    lastResult: '',
    pingTimer: null,
    saveTimer: null,
    launchTimer: null,
    noticeTimer: null
  };
  state.hydrateChunk = HYDRATE_CHUNK;
  state.autosave = false;
  state.autosaveStopped = false;
  state.nativeDirty = false;
  state.autosaveTimer = null;
  state.editorReadyReporting = false;
  state.cloudSaveError = false;
  state.uncertainSnapshot = null;
  state.commandProtocol = false;
  state.commandBusy = false;
  state.commandTimer = null;
  state.lastSnapshotOutcome = null;

  function log() {
    var parts = Array.prototype.slice.call(arguments).map(String);
    try { console.log('[bosonoo-engine]', parts.join(' ')); } catch (err) { /* no console */ }
  }

  var memfs = createMemoryProvider({
    onSave: function () { scheduleSnapshot(); },
    onOtherBlend: function (key) {
      notice('Only saves of ' + state.openName + ' go to Bosonoo; ' + key.split('/').pop() + ' stays in this tab.');
    }
  });

  // argv: the hydrated file's absolute path and the manifest-pinned pack scripts
  // (prepareSessionScripts); nothing else, ever. An accessor so no other script can
  // append --python, an add-on or a config.
  var EMPTY_ARGS = Object.freeze([]);
  function defineLocked(name, descriptor) {
    try {
      Object.defineProperty(window, name, descriptor);
      return true;
    } catch (err) {
      return false;
    }
  }
  var lockedArgs = defineLocked('__BARGS', {
    configurable: false,
    enumerable: true,
    get: function () { return state.bargs || EMPTY_ARGS; },
    set: function () { log('ignored an attempt to change Blender argv'); }
  });
  var lockedEnv = defineLocked('__CAPENV', {
    configurable: false,
    enumerable: true,
    get: function () { return undefined; },
    set: function () { log('ignored an attempt to set Blender environment'); }
  });

  // The vendor assigns these after its download finishes; accessors keep ours.
  function vendorFileHook() {
    if (!state.terminal && state.hasUncommittedSave && !state.nativeDirty) {
      requestSnapshot();
      notice('Checking and retrying the pending Bosonoo save…');
      return;
    }
    if (state.autosave && moduleValue) {
      try {
        if (moduleValue.ccall('blender_bosonoo_save_current', 'number', [], []) === 1) {
          notice(state.terminal ? 'Saving a local recovery copy. Cloud saving is disconnected.' : 'Saving your current Blender changes…');
          return;
        }
      } catch (err) { /* fall back to the native File menu */ }
    }
    notice(state.terminal
      ? 'Disconnected — cloud saving is unavailable. ' + SAVE_HINT + ' Then use Download saved .blend to keep a local browser copy.'
      : SAVE_HINT);
  }
  var lockedHooks = true;
  ['__blenderSaveHook', '__blenderSaveDownload', '__blenderFileOpenHook'].forEach(function (name) {
    lockedHooks = defineLocked(name, {
      configurable: false,
      enumerable: true,
      get: function () { return vendorFileHook; },
      set: function () { /* the vendor's folder picker and download stay out of this window */ }
    }) && lockedHooks;
  });

  // The vendor builds window.Module in its Launch handler. Intercept the assignment
  // to register provider 7 after the vendor's own preRun (which REPLACES
  // geckoProviders) and to mount it in onRuntimeInitialized, before callMain.
  var moduleValue;
  var moduleWrapped = false;
  var lockedModule = defineLocked('Module', {
    configurable: true,
    enumerable: true,
    get: function () { return moduleValue; },
    set: function (value) {
      if (value === moduleValue) return;
      if (!state.launchArmed || state.terminal) {
        // A launch that did not come from this bridge would boot without the file.
        throw new Error('Blender can only be started by Bosonoo once the file is loaded.');
      }
      moduleValue = value;
      if (!value || moduleWrapped) return;
      moduleWrapped = true;
      var preRun = Array.isArray(value.preRun) ? value.preRun.slice() : (value.preRun ? [value.preRun] : []);
      preRun.push(function bosonooPreRun() {
        value.geckoProviders = value.geckoProviders || {};
        value.geckoProviders[MOUNT_ID] = memfs.provider;
      });
      value.preRun = preRun;
      var vendorInit = value.onRuntimeInitialized;
      value.onRuntimeInitialized = function bosonooRuntimeInitialized() {
        if (typeof vendorInit === 'function') {
          try { vendorInit.call(this); } catch (err) { log('vendor onRuntimeInitialized threw', err && err.message); }
        }
        mountProvider(value);
      };
    }
  });

  function mountProvider(module) {
    try {
      // No folder picker and no File System Access mounts from this window.
      module.ccall('blender_web_set_has_fsaccess', null, ['number'], [0]);
    } catch (err) {
      fail('failed', 'Blender could not be configured', 'blender_web_set_has_fsaccess failed; reopen from Bosonoo.');
      return;
    }
    var rc;
    try {
      module.geckoProviders = module.geckoProviders || {};
      if (module.geckoProviders[MOUNT_ID] && module.geckoProviders[MOUNT_ID] !== memfs.provider) {
        throw new Error('provider slot taken');
      }
      module.geckoProviders[MOUNT_ID] = memfs.provider;
      rc = module.ccall('blender_web_mount_provider', 'number', ['number', 'string'], [MOUNT_ID, MOUNT_PATH]);
    } catch (err) {
      rc = -1;
    }
    if (rc !== 0) {
      fail('failed', 'Blender could not open the Bosonoo file', 'The in-memory file mount failed (code ' + String(rc) + '). Reopen from Bosonoo.');
      return;
    }
    state.mounted = true;
    installNativeAutosave(module);
    log('mounted the Bosonoo file provider at ' + MOUNT_PATH);
  }

  function installNativeAutosave(module) {
    var exports = ['_blender_bosonoo_autosave_enable', '_blender_bosonoo_autosave_status', '_blender_bosonoo_save_current'];
    if (!exports.every(function (name) { return typeof module[name] === 'function'; })) return;
    try {
      if (module.ccall('blender_bosonoo_autosave_enable', 'number', ['string'], [MOUNT_PATH + '/' + memfs.openKey()]) !== 1) {
        throw new Error('The fixed project path was refused.');
      }
      state.autosave = true;
      var poll = createAutosaveScheduler({
        now: function () { return Date.now(); },
        status: function () { return module.ccall('blender_bosonoo_autosave_status', 'number', [], []); },
        request: function () { return module.ccall('blender_bosonoo_save_current', 'number', [], []); },
        changed: function (status) {
          state.nativeDirty = status === 3 || status === 4 || status === 5 || status === 6 || status === 7;
          if (status === 7) {
            stopNativeAutosave();
            setResult('The active Blender document changed. Automatic saving to Bosonoo stopped; keep this window open to preserve unsaved work.');
            return;
          }
          if (status === 6) setResult('Automatic save failed inside Blender. Your edits are still open; retry with File > Save.');
          render();
        }
      });
      state.autosaveTimer = setInterval(function () {
        // Publish first-frame readiness before starting a cloud snapshot. The
        // broker cannot accept the first ready hint during snapshot transfer.
        // Disconnected editors keep native recovery serialization available.
        if (!state.terminal && state.phase !== 'running') return;
        try { poll(); } catch (err) {
          stopNativeAutosave();
          setResult('Automatic saving stopped. Use File > Save inside Blender.');
        }
      }, 1000);
    } catch (err) {
      state.autosave = false;
      log('native autosave unavailable:', err && err.message);
    }
  }

  function stopNativeAutosave() {
    clearInterval(state.autosaveTimer); state.autosaveTimer = null;
    state.autosave = false;
    state.autosaveStopped = true;
    // Once tracking is lost, absence of a dirty signal cannot prove the current
    // document is saved. Keep its close guard even after an older cloud receipt.
    state.nativeDirty = true;
    if (state.editorReadyReporting && state.phase === 'running' && !state.terminal) {
      try { send({ type: 'engine.ready', autosave: false }); } catch (sendError) { /* close handler preserves recovery */ }
    }
  }

  // --- UI ------------------------------------------------------------------
  var ui = { screen: null, pill: null, text: null, result: null, banner: null, bannerText: null, notice: null, status: null, target: null, download: null };

  function onDom(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
  }

  function installUi() {
    if (ui.pill) return;
    var style = document.createElement('style');
    style.textContent = [
      '#bosonoo-screen { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center;',
      '  background: #0b0d11; color: #e6e9ef; font: 14px/1.5 system-ui, sans-serif; text-align: center; padding: 24px; }',
      '#bosonoo-screen[hidden] { display: none; }',
      '#bosonoo-screen .box { max-width: 36rem; }',
      '#bosonoo-screen h1 { font-size: 18px; margin: 0 0 8px; }',
      '#bosonoo-screen .detail { color: #b8b8b8; white-space: pre-wrap; }',
      '#bosonoo-pill { position: fixed; right: 12px; bottom: 30px; z-index: 95; display: inline-flex; align-items: center; gap: 8px;',
      '  padding: 5px 10px; border-radius: 999px; background: rgba(20,20,20,0.92); border: 1px solid rgba(255,255,255,0.14);',
      '  font: 12px/1.2 system-ui, sans-serif; color: #e6e6e6; box-shadow: 0 2px 10px rgba(0,0,0,0.4); max-width: 70vw; pointer-events: none; }',
      '#bosonoo-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: none; }',
      '#bosonoo-pill.ok .dot { background: #4caf50; }',
      '#bosonoo-pill.busy .dot { background: #ffb300; }',
      '#bosonoo-pill.bad .dot { background: #e53935; }',
      '#bosonoo-pill .text, #bosonoo-pill .result { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#bosonoo-pill .result { color: #b8b8b8; }',
      '#bosonoo-download { pointer-events: auto; flex: none; border: 1px solid #666; border-radius: 5px;',
      '  padding: 4px 7px; background: #242424; color: #fff; font: inherit; cursor: pointer; }',
      '#bosonoo-download:disabled { opacity: .5; cursor: default; }',
      '#bosonoo-download[hidden] { display: none; }',
      '#bosonoo-banner { position: fixed; left: 0; right: 0; top: 0; z-index: 96; padding: 10px 16px; background: #7f1d1d; color: #fff;',
      '  font: 13px/1.4 system-ui, sans-serif; display: flex; align-items: center; justify-content: center; gap: 12px; }',
      '#bosonoo-banner-dismiss { flex: none; padding: 5px 10px; border: 1px solid #fff; border-radius: 5px;',
      '  background: transparent; color: inherit; font: inherit; cursor: pointer; }',
      '#bosonoo-banner-dismiss:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }',
      '#bosonoo-banner[hidden], #bosonoo-notice[hidden] { display: none; }',
      '#bosonoo-notice { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); z-index: 97; padding: 8px 14px;',
      '  border-radius: 8px; background: rgba(20,20,20,0.95); border: 1px solid rgba(255,255,255,0.2); color: #fff;',
      '  font: 13px/1.4 system-ui, sans-serif; max-width: 80vw; text-align: center; pointer-events: none; }'
    ].join('\n');
    document.head.appendChild(style);

    var screen = document.createElement('div');
    screen.id = 'bosonoo-screen';
    screen.hidden = true;
    screen.innerHTML = '<div class="box"><h1></h1><div class="detail"></div></div>';
    document.body.appendChild(screen);
    ui.screen = screen;

    var pill = document.createElement('div');
    pill.id = 'bosonoo-pill';
    pill.setAttribute('role', 'status');
    pill.innerHTML = '<span class="dot"></span><span class="text"></span><span class="result"></span>';
    document.body.appendChild(pill);
    ui.pill = pill;
    ui.text = pill.querySelector('.text');
    ui.result = pill.querySelector('.result');

    var download = document.createElement('button');
    download.id = 'bosonoo-download';
    download.type = 'button';
    download.textContent = 'Download saved .blend';
    download.title = 'First use File > Save inside Blender. Downloads the last saved browser file; desktop Blender cannot open it.';
    download.onclick = downloadSavedBlend;
    pill.appendChild(download);
    ui.download = download;

    var banner = document.createElement('div');
    banner.id = 'bosonoo-banner';
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    var bannerText = document.createElement('span');
    banner.appendChild(bannerText);
    ui.bannerText = bannerText;
    var dismiss = document.createElement('button');
    dismiss.id = 'bosonoo-banner-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss disconnect notice');
    dismiss.onclick = function () {
      banner.hidden = true;
      var canvas = document.getElementById('canvas');
      if (canvas && typeof canvas.focus === 'function') canvas.focus();
    };
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
    ui.banner = banner;

    var toast = document.createElement('div');
    toast.id = 'bosonoo-notice';
    toast.hidden = true;
    document.body.appendChild(toast);
    ui.notice = toast;

    ui.status = document.getElementById('bosonoo-status');
    ui.target = document.getElementById('bosonoo-target');
    render();
  }

  function phaseLabel() {
    switch (state.phase) {
      case 'init': return ['busy', 'Starting'];
      case 'checking': return ['busy', 'Checking WebGPU'];
      case 'connecting': return ['busy', 'Connecting to Bosonoo'];
      case 'connected': return ['ok', 'Connected to Bosonoo'];
      case 'hydrating': return ['busy', 'Loading ' + (state.session ? state.session.project_name : 'the file')];
      case 'waiting': return ['busy', 'Waiting for the Blender download'];
      case 'launching': return state.saving ? ['busy', 'Saving to Bosonoo'] : ['busy', 'Starting Blender'];
      case 'running': return state.autosaveStopped ? ['bad', 'Automatic saving stopped']
        : state.cloudSaveError ? ['bad', 'Save needs attention']
        : state.saving || state.nativeDirty || state.hasUncommittedSave ? ['busy', 'Saving changes…']
        : ['ok', state.autosave ? 'Automatic saving on' : 'Connected to Bosonoo'];
      case 'disconnected': return ['bad', 'Disconnected — reopen from Bosonoo'];
      case 'failed': return ['bad', 'Failed'];
      default: return ['bad', ''];
    }
  }

  function render() {
    if (!ui.pill) return;
    var label = phaseLabel();
    ui.pill.className = label[0];
    ui.text.textContent = label[1];
    ui.result.textContent = state.lastResult ? '· ' + state.lastResult : '';
    if (ui.status) ui.status.textContent = label[1] + (state.lastResult ? ' · ' + state.lastResult : '');
    if (ui.target) ui.target.textContent = targetLine();
    if (ui.download) {
      ui.download.hidden = !state.launched;
      ui.download.disabled = !state.hasLocalSave;
      ui.download.title = state.hasLocalSave
        ? 'Download the last file saved inside Blender. New edits need File > Save first. Desktop Blender cannot open this browser file.'
        : 'First use File > Save inside Blender. Downloads the last saved browser file; desktop Blender cannot open it.';
    }
  }

  function downloadSavedBlend() {
    if (!state.hasLocalSave || !state.launched) return;
    var current = memfs.read(memfs.openKey());
    if (!current || !current.length) { notice('Use File > Save inside Blender before downloading.'); return; }
    if (typeof Blob !== 'function' || !window.URL || typeof window.URL.createObjectURL !== 'function') {
      notice('This browser cannot download a recovery file. Keep this window open.');
      return;
    }
    var url = null;
    var link = null;
    try {
      // A local download never clears the pending Library save or its close guard.
      // Blob copies the last provider-written bytes, not the currently unflushed scene.
      url = window.URL.createObjectURL(new Blob([current], { type: 'application/x-blender' }));
      link = document.createElement('a');
      link.href = url;
      link.download = (state.openName || 'Blender').replace(/\.blend$/i, '') + ' (browser recovery).blend';
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      notice('Downloaded the last file saved inside Blender. This browser file is not compatible with desktop Blender.');
    } catch (err) {
      notice('The recovery download failed. Keep this window open and try again.');
    } finally {
      if (link) link.remove();
      if (url) setTimeout(function () { window.URL.revokeObjectURL(url); }, 1000);
    }
  }

  // The only statement on this page about where a save lands: the anchor may itself be
  // a browser copy, and then the save replaces it. Nothing is claimed until Bosonoo says.
  function targetLine() {
    var target = state.saveTarget;
    if (!target || !target.name) return 'Bosonoo will say where a save from this window goes.';
    if (target.kind === 'in_place' && target.starter) {
      return 'Saves go straight into ' + target.name + '. Desktop Blender 5.2 cannot open browser saves.';
    }
    if (target.kind === 'in_place') {
      return 'This is a browser Blender copy. Saves replace ' + target.name + '. Desktop Blender 5.2 cannot open it.';
    }
    return 'Saves go to ' + target.name + '. Desktop Blender 5.2 cannot open browser saves. Your original is never changed.';
  }

  function setPhase(phase) {
    state.phase = phase;
    render();
  }

  function setResult(value) {
    state.lastResult = String(value || '');
    render();
  }

  function notice(value) {
    if (!ui.notice) return;
    ui.notice.textContent = String(value || '');
    ui.notice.hidden = !value;
    if (state.noticeTimer) clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(function () { ui.notice.hidden = true; }, 6000);
  }

  function showScreen(title, detail) {
    if (!ui.screen) return;
    ui.screen.querySelector('h1').textContent = title;
    ui.screen.querySelector('.detail').textContent = detail || '';
    ui.screen.hidden = false;
  }

  // Terminal state. Before Blender runs it is a full screen; afterwards Blender
  // stays visible (the user's unsaved work is on screen) with a banner.
  function fail(phase, title, detail) {
    if (state.terminal) return;
    state.terminal = true;
    state.phase = phase;
    stopPing();
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (state.launchTimer) { clearInterval(state.launchTimer); state.launchTimer = null; }
    if (state.waiter) {
      var waiter = state.waiter;
      state.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(title));
    }
    if (state.snapshot) {
      var snap = state.snapshot;
      state.snapshot = null;
      snap.reject(new Error(title));
    }
    state.saving = false;
    log('terminal:', title, detail || '');
    if (state.launched) {
      if (ui.banner) {
        ui.bannerText.textContent = title + (detail ? ' — ' + detail : '')
          + ' Keep this window open. Use File > Save inside Blender, then Download saved .blend to keep a local browser copy.';
        ui.banner.hidden = false;
      }
    } else {
      showScreen(title, detail);
    }
    render();
    closeSocket();
  }

  function closeSocket() {
    var ws = state.ws;
    state.ws = null;
    if (ws) {
      try { ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch (err) { /* already closed */ }
    }
  }

  // --- 1. WebGPU gate --------------------------------------------------------
  function checkWebGpu() {
    setPhase('checking');
    var gpu = navigator.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      return Promise.reject(new Error('This browser has no WebGPU, so browser Blender cannot start. Use a recent Chrome or Edge with hardware acceleration on.'));
    }
    return Promise.resolve().then(function () { return gpu.requestAdapter(); }).then(function (adapter) {
      if (!adapter) throw new Error('No WebGPU adapter is available, so browser Blender cannot start. Turn on hardware acceleration and reopen from Bosonoo.');
      return adapter;
    }, function (err) {
      throw new Error('The WebGPU probe failed (' + String(err && err.message || err) + '). Browser Blender cannot start.');
    });
  }

  // --- 3. transport --------------------------------------------------------
  function send(message) {
    if (!state.ws || state.ws.readyState !== 1) throw new Error('The broker connection is not open.');
    state.ws.send(JSON.stringify(message));
  }

  function sendBinary(bytes) {
    if (!state.ws || state.ws.readyState !== 1) throw new Error('The broker connection is not open.');
    state.ws.send(bytes);
  }

  function expect(types, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (state.terminal) { reject(new Error('The connection is closed.')); return; }
      if (state.waiter) { reject(new Error('Protocol error: overlapping waits.')); return; }
      var timer = setTimeout(function () {
        if (state.waiter && state.waiter.resolve === resolve) {
          state.waiter = null;
          reject(new Error('The broker did not answer within ' + Math.round((timeoutMs || OP_TIMEOUT_MS) / 1000) + ' s.'));
        }
      }, timeoutMs || OP_TIMEOUT_MS);
      state.waiter = { types: types, resolve: resolve, reject: reject, timer: timer };
    });
  }

  function exchange(message, types, timeoutMs) {
    var promise = expect(types, timeoutMs);
    try {
      send(message);
    } catch (err) {
      var waiter = state.waiter;
      state.waiter = null;
      if (waiter) clearTimeout(waiter.timer);
      return Promise.reject(err);
    }
    return promise;
  }

  function deliver(message, bytes) {
    var waiter = state.waiter;
    if (waiter && waiter.types.indexOf(message.type) !== -1) {
      state.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve({ message: message, bytes: bytes });
      return;
    }
    switch (message.type) {
      case 'error':
        fail(state.launched ? 'disconnected' : 'failed', 'Bosonoo refused the connection',
          'Code: ' + String(message.code || 'unknown') + '. Reopen the file from Bosonoo.');
        return;
      case 'session.closed':
        fail('disconnected', 'Session closed by Bosonoo',
          'Reason: ' + String(message.reason || 'unknown') + '. Reopen the file from Bosonoo.');
        return;
      case 'snapshot.read':
        onSnapshotRead(message);
        return;
      case 'snapshot.finalize':
        onSnapshotFinalize(message);
        return;
      case 'snapshot.saved':
      case 'snapshot.failed':
      case 'snapshot.unknown':
        onSnapshotOutcome(message);
        return;
      case 'pong':
        if (state.session && typeof message.expires_ts === 'number') state.session.expires_ts = message.expires_ts;
        return;
      default:
        log('unexpected frame ignored:', String(message.type));
        return;
    }
  }

  function onSocketMessage(event) {
    if (state.terminal) return;
    var data = event.data;
    if (typeof data === 'string') {
      if (state.expectBinaryFor) {
        fail('failed', 'Protocol error', 'A text frame arrived where bytes were announced.');
        return;
      }
      var message;
      try {
        message = JSON.parse(data);
      } catch (err) {
        fail('failed', 'Protocol error', 'The broker sent a frame that is not JSON.');
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        fail('failed', 'Protocol error', 'The broker sent a frame without a type.');
        return;
      }
      if (message.type === 'hydrate.chunk' || message.type === 'command.asset.chunk') {
        state.expectBinaryFor = message;
        return;
      }
      deliver(message, null);
      return;
    }
    var header = state.expectBinaryFor;
    state.expectBinaryFor = null;
    if (!header) {
      fail('failed', 'Protocol error', 'Bytes arrived without a header frame.');
      return;
    }
    deliver(header, new Uint8Array(data));
  }

  function readSaveTarget(value) {
    if (!value || typeof value !== 'object') return null;
    var kind = value.kind === 'in_place' ? 'in_place' : (value.kind === 'browser_copy' ? 'browser_copy' : '');
    var name = typeof value.name === 'string' ? value.name : '';
    if (!kind || !name) return null;
    // A Bosonoo blank starter is saved into directly; it is nobody's copy.
    return kind === 'in_place' && value.starter === true ? { kind: kind, name: name, starter: true } : { kind: kind, name: name };
  }

  function connect() {
    var url = window.BOSONOO_BROKER_WS;
    if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
      return Promise.reject(new Error('This pack has no broker address; rebuild the dev pack.'));
    }
    setPhase('connecting');
    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        fail('failed', 'Cannot reach the Bosonoo broker', String(err && err.message || err));
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      state.ws = ws;
      var opened = false;
      ws.onopen = function () {
        opened = true;
        exchange({ type: 'engine.connect', grant: grant, protocol: PROTOCOL, editor_ready_reporting: true, command_protocol: 1 }, ['engine.connected'], CONNECT_TIMEOUT_MS)
          .then(function (reply) {
            grant = '';
            var m = reply.message;
            if (m.protocol !== PROTOCOL) {
              fail('failed', 'Protocol mismatch', 'The broker speaks protocol ' + String(m.protocol) + '; this pack speaks ' + PROTOCOL + '.');
              reject(new Error('protocol'));
              return;
            }
            if (m.engine !== ENGINE) {
              // Both packs share this origin; a launch for another engine must not load here.
              fail('failed', 'This launch is not for browser Blender', 'Reopen the file from Bosonoo.');
              reject(new Error('engine'));
              return;
            }
            return window.bosonooEngineStorage.prepareOrigin(window, {
              accountScope: m.account_scope, projectScope: m.recovery_scope
            }).then(function () {
              if (state.terminal) throw new Error('The engine disconnected while preparing its workspace.');
              state.session = { session_id: String(m.session_id || ''), epoch: m.epoch, expires_ts: m.expires_ts,
                project_name: String(m.project_name || 'file') };
              state.recovery = window.bosonooEngineStorage.recovery(null, m.recovery_scope);
              state.recoveryPage = m;
              state.saveTarget = readSaveTarget(m.save_target);
              state.editorReadyReporting = m.editor_ready_reporting === true;
              state.commandProtocol = m.command_protocol === 1;
              state.commandWindow = state.commandProtocol ? String(m.window_id || '') : '';
              try { document.title = state.session.project_name + ' — Bosonoo Blender (alpha)'; } catch (err) { /* ignore */ }
              setPhase('connected');
              startPing();
              resolve();
            });
          }).then(null, function (err) {
            fail('failed', 'Bosonoo did not accept this launch', String(err && err.message || err));
            reject(err);
          });
      };
      ws.onerror = function () {
        if (!opened) {
          fail('failed', 'Cannot reach the Bosonoo broker', 'The WebSocket to the API could not be opened. Is the API running?');
          reject(new Error('socket error'));
        }
      };
      ws.onclose = function (event) {
        if (state.ws !== ws) return;
        state.ws = null;
        if (!opened) {
          fail('failed', 'Cannot reach the Bosonoo broker', 'The WebSocket closed before it opened (code ' + String(event.code) + ').');
          reject(new Error('closed'));
          return;
        }
        fail(state.launched ? 'disconnected' : 'failed', 'Disconnected — reopen from Bosonoo',
          'The broker connection closed (code ' + String(event.code) + '). Launch grants are one-use; open the file from Bosonoo again.'
          + (state.snapshot ? ' A save was in flight; its result is checked after the next launch.' : '')
          + (state.launched ? ' Saves from this tab no longer reach Bosonoo.' : ''));
      };
      ws.onmessage = onSocketMessage;
    });
  }

  function startPing() {
    stopPing();
    state.pingTimer = setInterval(function () {
      if (state.terminal || !state.ws || state.ws.readyState !== 1) return;
      try { send({ type: 'ping' }); } catch (err) { /* onclose follows */ }
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
  }

  // Recovery remains scoped to the broker's current owner and project. Unknown
  // or failed transport responses never consume a receipt; the server discovers
  // durable receipts again on a fresh launch after browser storage is cleared.
  function rememberPendingSnapshot(snapshotId) {
    if (!state.recovery) throw new Error('Save recovery is unavailable. Reopen this file.');
    state.recovery.remember(snapshotId);
  }

  function recoverPending() {
    var checked = Object.create(null);
    function page(message, local) {
      var remote = message.recovery_snapshots || [];
      if (!Array.isArray(remote) || remote.length > 32) throw new Error('Invalid recovery inventory.');
      var ids = local.concat(remote);
      var chain = Promise.resolve();
      ids.forEach(function (snapshotId) {
        if (checked[snapshotId]) return;
        checked[snapshotId] = true;
        chain = chain.then(function () {
          return exchange({ type: 'snapshot.recover', snapshotId: snapshotId },
            ['snapshot.saved', 'snapshot.failed', 'snapshot.unknown']).then(function (reply) {
            state.recovery.settle(snapshotId, reply.message.type);
            setResult('Previous save: ' + describeOutcome(reply.message));
          }, function (err) {
            setResult('Previous save: could not be checked (' + String(err && err.message || err) + ')');
          });
        });
      });
      return chain.then(function () {
        if (typeof message.recovery_next_cursor !== 'string') return;
        return exchange({ type: 'snapshot.discover', cursor: message.recovery_next_cursor }, ['snapshot.discovered'])
          .then(function (reply) { return page(reply.message, []); });
      });
    }
    return page(state.recoveryPage || {}, state.recovery.pending());
  }

  function describeOutcome(m) {
    if (m.type === 'snapshot.saved') {
      var target = m.target && typeof m.target === 'object' ? m.target : null;
      var name = target && typeof target.name === 'string' && target.name ? target.name : '';
      if (target && target.kind && name) {
        var kind = target.kind === 'in_place' ? 'in_place' : 'browser_copy';
        // Receipts name the kind only; a starter stays a starter.
        var starter = kind === 'in_place' && Boolean(state.saveTarget && state.saveTarget.starter);
        state.saveTarget = starter ? { kind: kind, name: name, starter: true } : { kind: kind, name: name };
      }
      return name ? 'Saved to ' + name : 'Saved to Bosonoo';
    }
    if (m.type === 'snapshot.failed') return 'Save failed — ' + String(m.message || m.code || 'unknown') + '. Press Ctrl+S to retry; your saved browser copy is retained.';
    return 'unknown to Bosonoo';
  }

  // --- 4. hydration --------------------------------------------------------
  function describeAll() {
    var entries = [];
    function page(offset) {
      return exchange({ type: 'hydrate.describe', offset: offset, limit: HYDRATE_PAGE }, ['hydrate.page']).then(function (reply) {
        var m = reply.message;
        state.hydrateChunk = hydrationChunkSize(m.max_chunk_bytes);
        var rows = m.entries || [];
        for (var i = 0; i < rows.length; i += 1) entries.push(rows[i]);
        if (entries.length > 4) throw new Error('Bosonoo described more than one file for a .blend launch.');
        if (typeof m.next_offset === 'number') return page(m.next_offset);
        return entries;
      });
    }
    return page(0);
  }

  function readFile(entry, onProgress) {
    var handle = entry.handle;
    var chunks = [];
    var received = 0;
    return exchange({ type: 'hydrate.open', handle: handle }, ['hydrate.opened']).then(function () {
      function next() {
        return exchange({ type: 'hydrate.read', handle: handle, max_bytes: state.hydrateChunk }, ['hydrate.chunk']).then(function (reply) {
          var m = reply.message;
          var bytes = reply.bytes || new Uint8Array(0);
          if (m.offset !== received) throw new Error('Out-of-order bytes for the file.');
          chunks.push(bytes);
          received += bytes.length;
          if (received > entry.bytes) throw new Error('Too many bytes for the file.');
          onProgress(received);
          if (m.eof) return null;
          return next();
        });
      }
      return next();
    }).then(function () {
      return exchange({ type: 'hydrate.close', handle: handle }, ['hydrate.closed']);
    }).then(function () {
      var body = concat(chunks);
      if (body.length !== entry.bytes) throw new Error('Byte count mismatch for the file.');
      return sha256Hex(body).then(function (hex) {
        if (hex !== entry.sha256) throw new Error('Digest mismatch for the file.');
        return body;
      });
    });
  }

  function hydrate() {
    setPhase('hydrating');
    var previous = state.lastResult;   // a recovered save result stays visible afterwards
    return describeAll().then(function (entries) {
      var files = [];
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        if (entry.kind === 'file') files.push(entry);
        else if (!(entry.kind === 'folder' && entry.relative_path === '')) {
          throw new Error('Bosonoo described a folder tree; browser Blender opens exactly one .blend.');
        }
      }
      if (files.length !== 1) throw new Error('Bosonoo described ' + files.length + ' files; browser Blender opens exactly one .blend.');
      var file = files[0];
      var path = String(file.relative_path || '');
      if (!path || path.indexOf('/') !== -1 || !/\.blend$/i.test(path)) {
        throw new Error('The file Bosonoo sent is not a .blend at the project root.');
      }
      var size = Number(file.bytes);
      if (!(size > 0)) throw new Error('The .blend file is empty.');
      if (size > MAX_HYDRATE_BYTES) {
        throw new Error('This file is ' + Math.round(size / 1048576) + ' MiB; browser Blender can safely save files up to 90 MiB. Open this file in desktop Blender.');
      }
      return readFile(file, function (received) {
        setResult(Math.round(received / 1024) + ' / ' + Math.round(size / 1024) + ' KiB');
      }).then(function (body) {
        var name = safeName(path);
        var key = WORKSPACE_DIR + '/' + name;
        memfs.dirs.set(WORKSPACE_DIR, true);
        memfs.putFile(key, body);
        memfs.setOpenKey(key);
        state.relativePath = path;
        state.openName = name;
        state.bargs = Object.freeze([MOUNT_PATH + '/' + key]);
        setResult(previous);
        log('loaded ' + name + ' (' + body.length + ' bytes)');
      });
    });
  }

  // --- 6. launch -----------------------------------------------------------
  // A manifest-pinned pack script, read-only in the provider. Only these run;
  // scripts inside the .blend stay off (--disable-autoexec).
  function loadPackScript(url, key, missing, invalid) {
    return fetch(new URL(url, window.location.href).href,
      { credentials: 'omit', cache: 'force-cache', redirect: 'error' }).then(function (response) {
      if (!response.ok) throw new Error(missing);
      return response.arrayBuffer();
    }).then(function (buffer) {
      if (state.terminal || buffer.byteLength < 100 || buffer.byteLength > 64 * 1024) throw new Error(invalid);
      memfs.putReadOnly(key, new Uint8Array(buffer));
      return MOUNT_PATH + '/' + key;
    });
  }

  // Every session, a person's or an AI command session, runs the session guard
  // (session.py: interface previews that would hang this build are never started).
  // The command adapter joins it only when the broker granted the command protocol.
  function prepareSessionScripts() {
    if (state.commandProtocol && !state.commandWindow) return Promise.reject(new Error('The engine command handshake is incomplete.'));
    if (typeof fetch !== 'function') return Promise.reject(new Error('The Blender session guard could not be loaded.'));
    return loadPackScript('bosonoo/session.py', 'runtime/session.py', 'The Blender session guard is missing from this pack.',
      'The Blender session guard could not be loaded.').then(function (guard) {
      var args = ['--disable-autoexec', MOUNT_PATH + '/' + memfs.openKey(), '--python', guard];
      if (!state.commandProtocol) {
        state.bargs = Object.freeze(args);
        return undefined;
      }
      return loadPackScript('bosonoo/automation.py', 'automation/bootstrap.py', 'The qualified Blender command adapter is missing.',
        'The Blender command adapter could not be loaded.').then(function (adapter) {
        state.bargs = Object.freeze(args.concat(['--python', adapter]));
        state.commandTimer = setInterval(pollCommand, 1000);
      });
    });
  }

  // The runtime's file layer keeps bytes it already read from a path, so a rewritten
  // request file reads back as old-prefix + new-suffix. Each command therefore goes to a
  // new in-N.json in the in-memory filesystem and its answer to a new out-N.json
  // (automation.py LIVE_ROOT); the mount inbox remains for desktop Blender.
  var LIVE_MAILBOX = '/tmp/bosonoo-automation';
  function writeLiveInbox(bytes) {
    var fs = moduleValue && moduleValue.FS;
    if (!state.liveMailboxLogged) {
      state.liveMailboxLogged = true;
      console.log('[bosonoo-engine] live command mailbox ' + (fs && typeof fs.writeFile === 'function' ? 'available' : 'unavailable'));
    }
    if (!fs || typeof fs.writeFile !== 'function' || typeof fs.rename !== 'function') return 0;
    var seq = (state.liveSeq || 0) + 1;
    try {
      try { fs.mkdirTree(LIVE_MAILBOX); } catch (err) { /* exists */ }
      fs.writeFile(LIVE_MAILBOX + '/in-' + seq + '.tmp', bytes);
      fs.rename(LIVE_MAILBOX + '/in-' + seq + '.tmp', LIVE_MAILBOX + '/in-' + seq + '.json');
    } catch (err) { return 0; }
    state.liveSeq = seq;
    return seq;
  }

  function readLiveResult(seq) {
    var fs = moduleValue && moduleValue.FS;
    if (!seq || !fs || typeof fs.readFile !== 'function') return null;
    try { return fs.readFile(LIVE_MAILBOX + '/out-' + seq + '.json'); } catch (err) { return null; }
  }

  function mailboxResult(commandId, deadline, seq) {
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (state.terminal) { reject(new Error('ENGINE_DISCONNECTED')); return; }
        var sources = [readLiveResult(seq), memfs.read('automation/outbox.json')];
        for (var i = 0; i < sources.length; i += 1) {
          var raw = sources[i];
          if (!raw || raw.length > 64 * 1024) continue;
          try {
            var value = JSON.parse(new TextDecoder().decode(raw));
            if (value.command_id === commandId) { resolve(value); return; }
          } catch (err) { /* A partial native write is not a result. */ }
        }
        if (Date.now() > deadline) { reject(new Error('ENGINE_COMMAND_OUTCOME_UNKNOWN')); return; }
        setTimeout(poll, 100);
      })();
    });
  }

  // Staged image formats: the server's MIME, the mailbox format name and suffix, and
  // the container signature (automation.py IMAGE_FORMATS repeats the last two).
  var COMMAND_IMAGES = {
    'image/png': { format: 'png', suffix: 'png', signature: [137, 80, 78, 71, 13, 10, 26, 10] },
    'image/jpeg': { format: 'jpeg', suffix: 'jpg', signature: [255, 216, 255] }
  };

  function prepareCommandAsset(command) {
    if (command.action !== 'blender.image.import') return Promise.resolve();
    var asset = command.asset;
    var image = asset && Object.prototype.hasOwnProperty.call(COMMAND_IMAGES, asset.mime) ? COMMAND_IMAGES[asset.mime] : null;
    // Only a person's command may carry a JPEG; a BChat image stays PNG.
    if (!image || (image.format !== 'png' && command.actor !== 'person')
        || (command.params.format || 'png') !== image.format || !/^[A-Za-z0-9_-]{1,96}$/.test(asset.key || '')
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 8 || asset.bytes > 8 * 1024 * 1024
        || !/^[0-9a-f]{64}$/.test(asset.sha256 || '') || asset.key !== command.command_id || command.params.asset_key !== asset.key
        || command.params.sha256 !== asset.sha256) return Promise.reject(new Error('ENGINE_ASSET_INVALID'));
    var bytes = new Uint8Array(asset.bytes);
    var offset = 0;
    function read() {
      return exchange({ type: 'command.asset.read', command_id: command.command_id, claim_token: command.claim_token,
        offset: offset, max_bytes: Math.min(256 * 1024, bytes.length - offset) }, ['command.asset.chunk']).then(function (reply) {
        var m = reply.message;
        if (m.offset !== offset || m.sha256 !== asset.sha256 || !reply.bytes || m.size !== reply.bytes.length
            || m.size < 1 || m.size > 256 * 1024 || offset + m.size > bytes.length
            || m.eof !== (offset + m.size === bytes.length)) throw new Error('ENGINE_ASSET_CHANGED');
        bytes.set(reply.bytes, offset); offset += m.size;
        if (offset < bytes.length) return read();
        return sha256Hex(bytes).then(function (digest) {
          if (digest !== asset.sha256 || Array.from(bytes.slice(0, image.signature.length)).join(',') !== image.signature.join(',')) throw new Error('ENGINE_ASSET_DIGEST_MISMATCH');
          memfs.putReadOnly('automation/assets/' + asset.key + '.' + image.suffix, bytes);
        });
      });
    }
    return read();
  }

  function saveCommandChanges(deadline, command) {
    return new Promise(function (resolve, reject) {
      if (!state.autosave || !moduleValue) { reject(new Error('NATIVE_SAVE_UNAVAILABLE')); return; }
      try {
        if (moduleValue.ccall('blender_bosonoo_save_current', 'number', [], []) !== 1) throw new Error('Native save refused');
      } catch (error) { reject(error); return; }
      (function poll() {
        if (state.terminal || Date.now() > deadline) { reject(new Error('SAVE_OUTCOME_UNKNOWN')); return; }
        var status;
        try { status = moduleValue.ccall('blender_bosonoo_autosave_status', 'number', [], []); }
        catch (error) { reject(error); return; }
        if (status === 6 || status === 7) { reject(new Error('NATIVE_SAVE_FAILED')); return; }
        if (status !== 2 || state.saving || state.waiter) { setTimeout(poll, 100); return; }
        if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
        Promise.resolve(requestSnapshot(command)).then(function (outcome) {
          if (!outcome || outcome.type !== 'snapshot.saved') throw new Error('SAVE_UNCONFIRMED');
          resolve(outcome);
        }).catch(reject);
      })();
    });
  }

  function stageCommandOutput(command, value) {
    if (command.action !== 'blender.scene.export_glb' || value.ok !== true) return Promise.resolve(value);
    var output = value.data && value.data.output;
    if (!output || output.key !== command.command_id || output.mime !== 'model/gltf-binary'
        || !Number.isSafeInteger(output.bytes) || output.bytes < 20 || output.bytes > 8 * 1024 * 1024
        || !/^[0-9a-f]{64}$/.test(output.sha256 || '')) return Promise.reject(new Error('ENGINE_OUTPUT_INVALID'));
    var bytes = memfs.read('automation/outputs/' + command.command_id + '.glb');
    if (!bytes || bytes.length !== output.bytes) return Promise.reject(new Error('ENGINE_OUTPUT_MISSING'));
    var offset = 0;
    function chunk() {
      var end = Math.min(offset + 256 * 1024, bytes.length);
      var promise = expect(['command.output.progress']);
      send({ type: 'command.output.chunk', command_id: command.command_id, claim_token: command.claim_token,
        offset: offset, bytes: end - offset });
      state.ws.send(bytes.slice(offset, end));
      return promise.then(function (reply) {
        if (reply.message.command_id !== command.command_id || reply.message.offset !== end) throw new Error('ENGINE_OUTPUT_OFFSET');
        offset = end;
        if (offset < bytes.length) return chunk();
        return exchange({ type: 'command.output.final', command_id: command.command_id,
          claim_token: command.claim_token }, ['command.output.staged']).then(function (reply) {
          var m = reply.message;
          if (m.command_id !== command.command_id || m.bytes !== bytes.length || m.sha256 !== output.sha256
              || m.mime !== 'model/gltf-binary' || m.state !== 'staged' || typeof m.name !== 'string') throw new Error('ENGINE_OUTPUT_RECEIPT');
          // This is a private staging receipt. Only the BChat's current server
          // authority can commit it to the Library and report a saved artifact.
          value.output_stage = { command_id: m.command_id, bytes: m.bytes, sha256: m.sha256,
            name: m.name, mime: m.mime, state: m.state };
          value.data.persistence = 'private_staging_pending_library_commit';
          return value;
        });
      });
    }
    return sha256Hex(bytes).then(function (digest) {
      if (digest !== output.sha256) throw new Error('ENGINE_OUTPUT_CHANGED');
      return exchange({ type: 'command.output.begin', command_id: command.command_id,
        claim_token: command.claim_token, bytes: bytes.length, sha256: output.sha256 }, ['command.output.accepted']);
    }).then(function (reply) {
      if (reply.message.command_id !== command.command_id || reply.message.max_chunk_bytes !== 262144) throw new Error('ENGINE_OUTPUT_PROTOCOL');
      return chunk();
    });
  }

  function pollCommand() {
    if (!state.commandProtocol || state.terminal || state.phase !== 'running' || state.commandBusy || state.waiter || state.saving || state.saveTimer) return;
    var ready = memfs.read('automation/outbox.json');
    if (!ready) return;
    state.commandBusy = true;
    var command = null;
    exchange({ type: 'command.poll', request_id: randomId('poll_') }, ['command.next']).then(function (reply) {
      command = reply.message.command;
      if (!command) return;
      if (command.window_id !== state.commandWindow || !/^[A-Za-z0-9_-]{1,96}$/.test(command.command_id || '')
          || typeof command.claim_token !== 'string' || typeof command.action !== 'string'
          || (command.actor !== undefined && command.actor !== 'person')) throw new Error('ENGINE_COMMAND_INVALID');
      var deadline = Math.min(Date.now() + 180000, Number(command.expires_ts) * 1000);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('ENGINE_COMMAND_EXPIRED');
      var request = { command_id: command.command_id, operation: command.action, args: command.params };
      // The session holder's own Bosonoo bar action: the adapter applies it to the
      // scene as it is now and admits only its two person operations.
      if (command.actor === 'person') request.actor = 'person';
      var bytes = utf8(JSON.stringify(request));
      if (bytes.length > 48 * 1024) throw new Error('ENGINE_COMMAND_LIMIT');
      return prepareCommandAsset(command).then(function () {
        memfs.putFile('automation/inbox.json', bytes);
        return mailboxResult(command.command_id, deadline, writeLiveInbox(bytes));
      }).then(function (value) {
        if (!value.ok) return value;
        if (value.data && (value.data.changed || value.data.execution === 'native_save_required')) {
          return saveCommandChanges(deadline, command).then(function (receipt) {
            value.save_receipt = receipt;
            value.data.save_receipt = receipt;
            value.data.persistence = 'library_receipt';
            return value;
          }).catch(function (error) {
            return { ok: false, data: value.data, error: String(error.message || 'SAVE_UNCONFIRMED'), memory_changed: !!value.data.changed };
          });
        }
        return value;
      }).then(function (value) { return stageCommandOutput(command, value); }).then(function (value) {
        return exchange({ type: 'command.result', command_id: command.command_id, claim_token: command.claim_token,
          status: value.ok === true ? 'succeeded' : 'failed', result: value }, ['command.receipt']).then(function (reply) {
          if (reply.message.command_id !== command.command_id) throw new Error('ENGINE_COMMAND_RECEIPT');
          // Retain uncertain native output. Once Bosonoo records this exact
          // result, its private stage owns exported bytes; packed images live
          // in the editable scene. Only fixed per-command scratch is released.
          if (value.ok === true) memfs.releaseCommandBuffers(command.command_id);
          return reply;
        });
      });
    }).catch(function (error) {
      // The server fences claimed commands. Never repeat native edits after an
      // uncertain dispatch or response, even if the socket later recovers.
      if (command) setResult(command.actor === 'person'
        ? 'A Library action did not finish cleanly. Keep this editor open; its change may still be present.'
        : 'An AI operation needs reconciliation. Keep this editor open; completed edits may still be present.');
    }).then(function () { state.commandBusy = false; });
  }

  function gpuWarningText() {
    var warning = document.getElementById('gpu-warning');
    if (!warning || warning.hidden) return '';
    var textNode = document.getElementById('gpu-warning-text');
    return String((textNode && textNode.textContent) || 'WebGPU is unavailable.').trim();
  }

  function watchVendorConsole() {
    var box = document.getElementById('console-output');
    if (!box || typeof MutationObserver !== 'function') return;
    // The vendor appends one element per log line; these strings are Blender's own
    // report text for a file it could not read or a runtime that aborted.
    var observer = new MutationObserver(function (records) {
      if (state.terminal) { observer.disconnect(); return; }
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes || [];
        for (var j = 0; j < added.length; j += 1) {
          var line = String(added[j].textContent || '');
          if (line.length < 400 && FATAL_LOG.test(line)) {
            observer.disconnect();
            fail('failed', 'Blender could not open the file',
              line.replace(/^\[(?:log|err|error|warn)\]\s*/, '').slice(0, 240) + ' Reopen the file from Bosonoo.');
            return;
          }
        }
      }
    });
    observer.observe(box, { childList: true });
  }

  function watchCanvasReady() {
    var canvas = document.getElementById('canvas');
    if (!canvas) return;
    function ready() {
      if (state.terminal || state.phase === 'running') return;
      setPhase('running');
      if (state.editorReadyReporting) {
        try { send({ type: 'engine.ready', autosave: state.autosave }); }
        catch (err) { fail('disconnected', 'Blender is disconnected', 'Keep this window open to recover any edits.'); }
      }
      // A splash Blender may still draw over the file is dismissed the way a person would.
      setTimeout(function () {
        ['keydown', 'keyup'].forEach(function (type) {
          try {
            canvas.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          } catch (err) { /* old browser */ }
        });
      }, 1500);
    }
    if (canvas.classList.contains('ready')) { ready(); return; }
    var observer = new MutationObserver(function () {
      if (canvas.classList.contains('ready')) { observer.disconnect(); ready(); }
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ['class'] });
  }

  function launchWhenReady() {
    return new Promise(function (resolve, reject) {
      var button = document.getElementById('start-btn');
      if (!button) { reject(new Error('The vendor Launch button is missing; the pack page is broken.')); return; }
      state.launchArmed = true;
      setPhase('waiting');
      var started = Date.now();
      function tryLaunch() {
        if (state.terminal) { clearInterval(state.launchTimer); state.launchTimer = null; return; }
        var warning = gpuWarningText();
        if (warning) {
          clearInterval(state.launchTimer);
          state.launchTimer = null;
          reject(new Error(warning + ' Bosonoo does not start browser Blender on a software renderer.'));
          return;
        }
        if (button.disabled) {
          if (Date.now() - started > LAUNCH_TIMEOUT_MS) {
            clearInterval(state.launchTimer);
            state.launchTimer = null;
            reject(new Error('The Blender download did not finish within 15 minutes.'));
          }
          return;
        }
        clearInterval(state.launchTimer);
        state.launchTimer = null;
        state.launched = true;
        setPhase('launching');
        watchCanvasReady();
        button.click();
        resolve();
      }
      state.launchTimer = setInterval(tryLaunch, 250);
      tryLaunch();
    });
  }

  // --- 7. save detection and the one-file snapshot -----------------------------
  function scheduleSnapshot() {
    if (!state.launched) return;
    state.hasLocalSave = true;
    state.hasUncommittedSave = true;
    render();
    // The engine remains editable after a lost session. Its File > Save still
    // updates the provider and the recovery download, without contacting Bosonoo.
    if (state.terminal) return;
    if (state.saving) { state.dirtyWhileSaving = true; return; }
    if (state.saveTimer) clearTimeout(state.saveTimer);
    setResult('save noticed');
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      requestSnapshot();
    }, SAVE_DEBOUNCE_MS);
  }

  function requestSnapshot(command) {
    if (state.terminal || !state.launched) return;
    state.hasUncommittedSave = true;
    if (state.saving) { state.dirtyWhileSaving = true; return; }
    if (state.uncertainSnapshot) { reconcileUncertainSnapshot(); return; }
    var current = memfs.read(memfs.openKey());
    if (!current || !current.length) {
      setResult('Save not sent — the saved file is missing or empty');
      return;
    }
    // Copy now: Blender may save again while the exchange runs.
    var bytes = new Uint8Array(current.length);
    bytes.set(current);
    state.saving = true;
    state.cloudSaveError = false;
    state.dirtyWhileSaving = false;
    setResult('');
    return buildSnapshot(state.relativePath, bytes).then(function (built) { return runSnapshotExchange(built, command); }).then(function (outcome) {
      state.saving = false;
      state.hasUncommittedSave = outcome.type !== 'snapshot.saved' || state.dirtyWhileSaving;
      state.cloudSaveError = outcome.type !== 'snapshot.saved';
      setResult(describeOutcome(outcome));
      if (state.dirtyWhileSaving) scheduleSnapshot();
      state.lastSnapshotOutcome = outcome;
      return outcome;
    }, function (err) {
      state.saving = false;
      state.cloudSaveError = true;
      if (!state.terminal) setResult('Save failed — ' + String(err && err.message || err));
      // A newer native save may have completed during a rejected exchange. Keep
      // it pending and expose the retry; never report the previous bytes saved.
      render();
    });
  }

  function reconcileUncertainSnapshot() {
    var pending = state.uncertainSnapshot;
    state.saving = true;
    state.dirtyWhileSaving = false;
    setResult('Checking the previous save before retrying…');
    exchange({ type: 'snapshot.recover', snapshotId: pending.snapshotId },
      ['snapshot.saved', 'snapshot.failed', 'snapshot.unknown']).then(function (reply) {
      var message = reply.message;
      state.recovery.settle(pending.snapshotId, message.type);
      if (message.type === 'snapshot.unknown') {
        state.saving = false;
        state.cloudSaveError = true;
        setResult('The previous save is still unconfirmed. Keep this window open; retry with Ctrl+S or download a recovery copy.');
        return;
      }
      state.uncertainSnapshot = null;
      if (message.type === 'snapshot.failed') {
        state.saving = false;
        requestSnapshot();
        return;
      }
      return sha256Hex(memfs.read(memfs.openKey()) || new Uint8Array(0)).then(function (hash) {
        state.saving = false;
        if (hash === pending.sha256 && !state.dirtyWhileSaving) {
          state.hasUncommittedSave = false;
          state.cloudSaveError = false;
          state.dirtyWhileSaving = false;
          setResult(describeOutcome(message));
        } else {
          requestSnapshot();
        }
      });
    }).catch(function (err) {
      state.saving = false;
      state.cloudSaveError = true;
      if (!state.terminal) setResult('The previous save could not be confirmed. Retry with Ctrl+S or download a recovery copy.');
    });
  }

  function runSnapshotExchange(built, command) {
    var proposal = { type: 'snapshot.propose' };
    if (command && typeof command.command_id === 'string' && typeof command.claim_token === 'string') {
      proposal.command_id = command.command_id;
      proposal.claim_token = command.claim_token;
    }
    return exchange(proposal, ['snapshot.request']).then(function (reply) {
      var requestId = String(reply.message.requestId || '');
      if (!requestId) throw new Error('Bosonoo did not mint a snapshot request.');
      return new Promise(function (resolve, reject) {
        var snapshotId = randomId('snap_');
        state.snapshot = { requestId: requestId, snapshotId: snapshotId, files: built.files, manifest: built.manifest,
          resolve: resolve, reject: reject };
        var begin = { type: 'snapshot.begin', ok: true, requestId: requestId, snapshotId: snapshotId, manifest: built.manifest };
        try {
          rememberPendingSnapshot(snapshotId);
          send(begin);
        } catch (err) {
          state.snapshot = null;
          reject(err);
        }
      });
    });
  }

  function onSnapshotRead(message) {
    var snap = state.snapshot;
    if (!snap || message.requestId !== snap.requestId || message.snapshotId !== snap.snapshotId) {
      fail('failed', 'Protocol error', 'A read arrived for an unknown snapshot.');
      return;
    }
    var index = message.fileIndex;
    var file = snap.files[index];
    var offset = message.offset;
    var length = message.length;
    if (!file || typeof offset !== 'number' || typeof length !== 'number' || length <= 0 || length > SNAPSHOT_CHUNK
        || offset < 0 || offset + length > file.bytes.length) {
      fail('failed', 'Protocol error', 'A read arrived outside the announced file range.');
      return;
    }
    var slice = file.bytes.subarray(offset, offset + length);
    var header = { ok: true, requestId: snap.requestId, snapshotId: snap.snapshotId, callId: message.callId,
      fileIndex: index, offset: offset, bytes: length, eof: offset + length === file.bytes.length };
    try {
      send({ type: 'snapshot.chunk', header: header });
      sendBinary(slice);
    } catch (err) {
      fail('disconnected', 'Disconnected — reopen from Bosonoo', String(err && err.message || err));
    }
  }

  function onSnapshotFinalize(message) {
    var snap = state.snapshot;
    if (!snap || message.requestId !== snap.requestId || message.snapshotId !== snap.snapshotId
        || message.manifestSha256 !== snap.manifest.manifestSha256) {
      fail('failed', 'Protocol error', 'The finalize request does not match the snapshot in flight.');
      return;
    }
    sealDigest(snap.manifest.manifestSha256).then(function (seal) {
      send({ type: 'snapshot.final', ok: true, requestId: snap.requestId, snapshotId: snap.snapshotId,
        manifestSha256: snap.manifest.manifestSha256, sealSha256: seal });
    }).then(null, function (err) {
      fail('disconnected', 'Disconnected — reopen from Bosonoo', String(err && err.message || err));
    });
  }

  function onSnapshotOutcome(message) {
    var snap = state.snapshot;
    if (!snap) { log('snapshot outcome without a snapshot in flight'); return; }
    state.snapshot = null;
    if (message.type === 'snapshot.unknown') {
      state.uncertainSnapshot = { snapshotId: snap.snapshotId, sha256: snap.files[0].sha256 };
    }
    if (state.recovery) state.recovery.settle(snap.snapshotId, message.type);
    snap.resolve(message);
  }

  window.addEventListener('beforeunload', function (event) {
    if (!state.saving && !state.saveTimer && !state.hasUncommittedSave && !state.nativeDirty) return;
    event.preventDefault();
    event.returnValue = 'A save to Bosonoo is still in progress.';
  });

  // --- main ----------------------------------------------------------------
  function main() {
    installUi();
    if (!lockedArgs || !lockedEnv || !lockedHooks || !lockedModule || moduleValue !== undefined) {
      fail('failed', 'This page could not secure Blender\'s start-up hooks', 'Another script defined them first. Reopen the file from Bosonoo.');
      return;
    }
    if (window.crossOriginIsolated !== true) {
      fail('failed', 'This window is not cross-origin isolated',
        'Browser Blender needs Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy on this page. Open the file from Bosonoo again; if this persists the engine origin is misconfigured.');
      return;
    }
    if (typeof WebSocket !== 'function' || typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder !== 'function'
        || typeof Map !== 'function' || typeof MutationObserver !== 'function') {
      fail('failed', 'This browser lacks a required feature', 'WebSocket, Web Crypto, TextEncoder, Map and MutationObserver are required.');
      return;
    }
    if (!grant) {
      fail('failed', 'No launch grant', 'This page must be opened from Bosonoo; launch grants are one-use and never survive a reload.');
      return;
    }
    watchVendorConsole();
    // GPU capability is checked before spending the grant; workspace admission
    // uses the broker's account/project identities and precedes all hydration.
    checkWebGpu().then(connect).then(recoverPending).then(hydrate).then(prepareSessionScripts).then(launchWhenReady).then(null, function (err) {
      if (!state.terminal) fail('failed', 'Could not open the file in browser Blender', String(err && err.message || err));
    });
  }

  // The vendor bundle is unreviewed same-origin script, admitted by script-src 'self':
  // anything published on window is published to it. The live broker socket, the
  // session id and epoch, and the snapshot bytes in flight stay private, the same way
  // __BARGS, __CAPENV, the file hooks and the Module setter are kept out of its reach.
  // What is left is a frozen description of the phase, for the tests and for a person
  // reading the console; it carries no handle anything can act through.
  function describe() {
    return Object.freeze({
      engine: ENGINE,
      phase: state.phase,
      terminal: state.terminal,
      launched: state.launched,
      mounted: state.mounted,
      saving: state.saving,
      openName: state.openName,
      lastResult: state.lastResult,
      saveTargetKind: state.saveTarget ? state.saveTarget.kind : ''
    });
  }

  defineLocked('bosonooEngineBridge', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ engine: ENGINE, helpers: helpers, describe: describe })
  });

  onDom(main);
})();
