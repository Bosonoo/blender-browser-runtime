/* Shared engine-origin lifecycle. Project bytes live in each editor's MEMFS.
 * Startup cleanup is serialized; live documents from one account may coexist,
 * but never a second writer for the same project or a different account.
 * Lock identities come from the authorized broker, never display names.
 */
'use strict';
(function () {
  var PREFIX = 'bosonoo.pendingSnapshot.v2.';
  var SCOPE = /^[0-9a-f]{64}$/;
  var SNAPSHOT = /^[A-Za-z0-9_-]{1,128}$/;
  var WORKSPACE_LOCK = 'bosonoo.engine.workspace.v1';
  var STARTUP_LOCK = 'bosonoo.engine.startup.v2';
  var ACCOUNT_LOCK = 'bosonoo.engine.account.v2.';
  var PROJECT_LOCK = 'bosonoo.engine.project.v2.';

  function holdLock(locks, name, mode, message) {
    return new Promise(function (resolve, reject) {
      locks.request(name, { mode: mode, ifAvailable: true }, function (lock) {
        if (!lock) { reject(new Error(message)); return; }
        return new Promise(function (release) { resolve(release); });
      }).catch(reject);
    });
  }

  function prepareOrigin(env, identity) {
    var locks = env.navigator && env.navigator.locks;
    if (!locks || typeof locks.request !== 'function' || typeof locks.query !== 'function') {
      return Promise.reject(new Error('This browser cannot isolate engine workspaces. Use a browser with Web Locks.'));
    }
    if (!identity || !SCOPE.test(identity.accountScope) || !SCOPE.test(identity.projectScope)) {
      return Promise.reject(new Error('Bosonoo did not provide a valid workspace identity. Reopen this file.'));
    }
    // A shared lifetime lock remains incompatible with old packs' exclusive
    // lifetime lock, so a stale pack can never erase a new editor's workspace.
    // The startup mutex covers inspection, cleanup and ALL lifetime acquisitions.
    return locks.request(STARTUP_LOCK, { mode: 'exclusive' }, function () {
      var releases = [];
      function keep(release) { releases.push(release); }
      return holdLock(locks, WORKSPACE_LOCK, 'shared',
        'An older engine editor is open. Save and close it before opening this file.').then(keep).then(function () {
        return locks.query();
      }).then(function (snapshot) {
        var accounts = snapshot.held.filter(function (lock) { return lock.name.indexOf(ACCOUNT_LOCK) === 0; });
        if (accounts.some(function (lock) { return lock.name !== ACCOUNT_LOCK + identity.accountScope; })) {
          throw new Error('An engine editor from another account is still open. Close it before opening this file.');
        }
        // No web-storage marker is trusted here: browser-owned, live locks tell
        // us whether cleanup would touch another editor. Never clean on join.
        return accounts.length ? Promise.resolve() : clearOrigin(env);
      }).then(function () {
        return holdLock(locks, PROJECT_LOCK + identity.projectScope, 'exclusive',
          'This project is already open in another engine editor. Save and close that editor first.');
      }).then(keep).then(function () {
        return holdLock(locks, ACCOUNT_LOCK + identity.accountScope, 'shared',
          'This engine workspace could not be isolated. Reopen the file.');
      }).then(keep).then(function () {
        // Intentionally keep all three leases until document destruction, even
        // after broker disconnection: that document may hold unsaved MEMFS work.
      }, function (err) {
        releases.forEach(function (release) { release(); });
        throw err;
      });
    });
  }

  function clearOrigin(env) {
    if (!env.indexedDB || typeof env.indexedDB.databases !== 'function') {
      return Promise.reject(new Error('This browser cannot check previous engine storage.'));
    }
    // Remove old project bytes, cached responses and local folder permissions.
    // A hostile prior project can hide bytes even in well-formed receipt keys.
    // Erase every value. The authorized broker discovers durable receipts on
    // reconnect; bytes never submitted to the server cannot have committed.
    try {
      env.localStorage.clear();
      env.sessionStorage.clear();
    } catch (_err) {
      return Promise.reject(new Error('Previous engine browser storage could not be cleared.'));
    }
    var workers = env.navigator.serviceWorker;
    var workerCleanup = workers && typeof workers.getRegistrations === 'function'
      ? workers.getRegistrations().then(function (registrations) {
        return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
      }).then(function () {
        if (workers.controller) throw new Error('An older engine worker controls this page. Close it and reopen from Bosonoo.');
      }) : Promise.resolve();
    return workerCleanup.then(function () { return env.indexedDB.databases(); }).then(function (databases) {
      return Promise.all(databases.map(function (database) {
        if (typeof database.name !== 'string') throw new Error('An engine database could not be identified.');
        return new Promise(function (resolve, reject) {
          var timer = env.setTimeout(function () { reject(new Error('Previous engine storage is still open. Close other engine tabs.')); }, 8000);
          var request;
          function finish(err) { env.clearTimeout(timer); if (err) reject(err); else resolve(); }
          try { request = env.indexedDB.deleteDatabase(database.name); }
          catch (err) { finish(err); return; }
          request.onsuccess = function () { finish(); };
          request.onerror = function () { finish(new Error('Previous engine storage could not be cleared.')); };
          request.onblocked = function () { finish(new Error('Previous engine storage is open in another page. Close that page first.')); };
        });
      }));
    }).then(function () {
      var storage = env.navigator.storage;
      if (!storage || typeof storage.getDirectory !== 'function') return;
      return storage.getDirectory().then(function (root) {
        var iterator = root.keys();
        function next() {
          return iterator.next().then(function (entry) {
            if (entry.done) return;
            return root.removeEntry(entry.value, { recursive: true }).then(next);
          });
        }
        return next();
      });
    }).then(function () {
      if (!env.caches) return;
      return env.caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return env.caches.delete(key).then(function (deleted) {
            if (!deleted) throw new Error('A previous engine cache could not be cleared.');
          });
        }));
      });
    });
  }

  function recovery(storage, scope) {
    if (!SCOPE.test(scope)) throw new Error('Bosonoo did not provide a valid recovery identity. Reopen this file.');
    // New editors use a private journal. Sibling projects neither share these
    // values nor depend on browser storage surviving another document's launch.
    // A fresh launch discovers durable receipts from the broker instead.
    if (!storage) {
      var values = Object.create(null);
      storage = {
        get length() { return Object.keys(values).length; },
        key: function (index) { return Object.keys(values)[index] || null; },
        setItem: function (key, value) { values[key] = String(value); },
        removeItem: function (key) { delete values[key]; }
      };
    }
    var prefix = PREFIX + scope + '.';
    function key(id) {
      if (!SNAPSHOT.test(id)) throw new Error('Invalid snapshot identity.');
      return prefix + id;
    }
    return Object.freeze({
      remember: function (id) {
        // Write before sending snapshot.begin, so a process/tab crash cannot
        // lose the only record of a potentially committed operation.
        storage.setItem(key(id), JSON.stringify({ snapshotId: id, ts: Date.now() }));
      },
      pending: function () {
        var ids = [];
        for (var i = 0; i < storage.length; i += 1) {
          var item = storage.key(i);
          if (item && item.indexOf(prefix) === 0) {
            var id = item.slice(prefix.length);
            if (SNAPSHOT.test(id)) ids.push(id);
          }
        }
        if (ids.length > 32) throw new Error('Too many unconfirmed saves. Resolve earlier saves before saving again.');
        return ids.sort();
      },
      settle: function (id, outcome) {
        if (outcome === 'snapshot.saved' || outcome === 'snapshot.failed') {
          try { storage.removeItem(key(id)); } catch (_err) { /* retry the harmless receipt lookup next launch */ }
        }
      }
    });
  }
  var api = Object.freeze({ prepareOrigin: prepareOrigin, recovery: recovery });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'bosonooEngineStorage', { value: api, configurable: false, writable: false });
})();
