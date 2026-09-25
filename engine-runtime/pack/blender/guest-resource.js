/* SPDX-License-Identifier: GPL-3.0-or-later
 * Blender guest adapter. Independent implementation of the public one-file
 * bosonoo.local-resource-session v2 wire contract; no application imports. */
'use strict';
(function () {
  const MAX_BYTES = 64 * 1024 * 1024;
  const PROTOCOL = 'bosonoo.local-resource-session';
  const HEX64 = /^[a-f0-9]{64}$/;
  function error(code, message) { return Object.assign(new Error(message), {code}); }
  function id(prefix) {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function digest(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function exact(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => keys.includes(key));
  }
  function readLaunch(hash, engineOrigin) {
    const args = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    if ([...args.keys()].length !== 3 || !['parent','instance','nonce'].every(key => args.getAll(key).length === 1)) {
      throw error('GUEST_INIT_INVALID', 'Open this file from Bosonoo.');
    }
    const parent = args.get('parent');
    let url; try { url = new URL(parent); } catch (_) { throw error('GUEST_INIT_INVALID', 'The parent origin is invalid.'); }
    if (url.origin !== parent || url.origin === engineOrigin || url.username || url.password
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))
        || !HEX64.test(args.get('instance')) || !HEX64.test(args.get('nonce'))) {
      throw error('GUEST_INIT_INVALID', 'The guest editor origin or instance is invalid.');
    }
    return Object.freeze({parent, instanceId: args.get('instance'), nonce: args.get('nonce')});
  }
  function validInit(event, launch, parentWindow) {
    const m = event.data;
    return event.source === parentWindow && event.origin === launch.parent
      && exact(m, ['type','version','instanceId','nonce']) && Object.keys(m).length === 4
      && m.type === 'bosonoo:guest-blender:init' && m.version === 1
      && m.instanceId === launch.instanceId && m.nonce === launch.nonce
      && event.ports && event.ports.length === 2;
  }
  function validAction(message, instanceId, sequence) {
    return exact(message, ['type','version','instanceId','sequence','requestId','action'])
      && Object.keys(message).length === 6 && message.type === 'bosonoo:guest-blender:action'
      && message.version === 1 && message.instanceId === instanceId
      && Number.isSafeInteger(message.sequence) && message.sequence === sequence + 1
      && /^gbr_[a-f0-9]{32}$/.test(message.requestId)
      && ['save','prepareClose','prepareExport','export','prepareDiscard','resumeAfterDiscardFailure'].includes(message.action);
  }
  class ResourceClient {
    constructor(port, instanceId, {timeoutMs = 45000, onFailure = () => {}} = {}) {
      if (!port || !HEX64.test(instanceId)) throw error('GUEST_CHANNEL_INVALID', 'Invalid file channel.');
      this.port = port; this.instanceId = instanceId; this.timeoutMs = timeoutMs;
      this.onFailure = onFailure; this.inSequence = 0; this.outSequence = 0;
      this.pending = new Map(); this.ignored = new Set(); this.closed = false; this.state = null;
      this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      this.ready.catch(() => {});
      this.handshake = setTimeout(() => this.fail(error('GUEST_CHANNEL_TIMEOUT', 'The file channel did not open.')), timeoutMs);
      port.onmessage = event => this.receive(event.data);
      port.onmessageerror = () => this.fail(error('GUEST_CHANNEL_INVALID', 'The file channel could not read a message.'));
      port.start();
    }
    fail(reason) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.handshake); this.rejectReady(reason);
      this.pending.forEach(p => { clearTimeout(p.timer); p.reject(reason); }); this.pending.clear();
      this.port.close(); this.onFailure(reason);
    }
    receive(m) {
      if (this.closed) return;
      try {
        if (!m || m.protocol !== PROTOCOL || m.version !== 2 || m.instanceId !== this.instanceId
            || !Number.isSafeInteger(m.sequence) || m.sequence !== this.inSequence + 1) {
          throw error('GUEST_CHANNEL_PROTOCOL', 'The file channel was replayed or arrived out of order.');
        }
        this.inSequence = m.sequence;
        if (!this.state) {
          if (m.kind !== 'ready' || !m.state || m.state.editorKind !== 'engine' || m.state.mode !== 'read-write'
              || m.state.readOnly !== false || typeof m.state.resourceId !== 'string'
              || !Number.isSafeInteger(m.state.maxBytes) || m.state.maxBytes < 1 || m.state.maxBytes > MAX_BYTES) {
            throw error('GUEST_CHANNEL_PROTOCOL', 'The file channel did not authorize this Blender file.');
          }
          this.state = Object.freeze({...m.state}); clearTimeout(this.handshake); this.resolveReady(this.state); return;
        }
        if (m.kind !== 'response' || !/^lrs_[a-f0-9]{32}$/.test(m.requestId) || typeof m.ok !== 'boolean') {
          throw error('GUEST_CHANNEL_PROTOCOL', 'Unexpected file response.');
        }
        const pending = this.pending.get(m.requestId);
        if (!pending && this.ignored.delete(m.requestId)) return;
        if (!pending) throw error('GUEST_CHANNEL_PROTOCOL', 'Unrequested file response.');
        this.pending.delete(m.requestId); clearTimeout(pending.timer);
        if (m.ok) pending.resolve(m.result);
        else pending.reject(error(String(m.error?.code || 'GUEST_STORAGE_FAILED').slice(0,100),
          'Browser storage could not confirm this operation. Keep this editor open or download a recovery copy.'));
      } catch (reason) { this.fail(reason); }
    }
    async request(method, args = [], {unknown = false} = {}) {
      await this.ready;
      if (this.closed) throw error('GUEST_CHANNEL_CLOSED', 'The file channel is disconnected. Keep this editor open.');
      if (!['open','read','stat','replace','checkpoint','prepareDiscard','resumeAfterDiscardFailure','close'].includes(method)) throw error('GUEST_METHOD_INVALID','Unsupported operation.');
      if (this.pending.size + this.ignored.size >= 8) throw error('GUEST_CHANNEL_BUSY', 'Unresolved file responses need recovery.');
      const requestId = id('lrs_');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!unknown) { this.fail(error('GUEST_CHANNEL_TIMEOUT','The file channel timed out.')); return; }
          this.pending.delete(requestId); this.ignored.add(requestId);
          reject(error('LOCAL_RESOURCE_SESSION_RESULT_UNKNOWN', 'The save result is unknown. Retry the same save or download a recovery copy.'));
        }, this.timeoutMs);
        this.pending.set(requestId, {resolve,reject,timer});
        try { this.port.postMessage({kind:'request',protocol:PROTOCOL,version:2,instanceId:this.instanceId,
          sequence:++this.outSequence,requestId,method,args}); }
        catch (_) { this.fail(error('GUEST_CHANNEL_CLOSED','The file channel is disconnected.')); }
      });
    }
  }
  // At most one immutable replacement attempt can be unresolved. New native saves
  // update latest, but never overwrite the bytes/key/base of that attempt.
  class SaveQueue {
    constructor(client, revision, {changed = () => {}} = {}) {
      this.client = client; this.revision = revision; this.changed = changed;
      this.latest = null; this.generation = 0; this.committed = 0;
      this.pending = null; this.flight = null;
    }
    record(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw error('GUEST_SAVE_EMPTY','Blender wrote an empty file.');
      this.latest = bytes.slice(); this.generation += 1; this.changed();
    }
    get dirty() { return this.committed !== this.generation || !!this.pending; }
    flush() {
      if (this.flight) return this.flight;
      this.flight = this.perform().finally(() => { this.flight = null; this.changed(); });
      this.changed(); return this.flight;
    }
    async perform() {
      if (!this.pending && this.committed === this.generation) return;
      if (!this.pending) {
        const bytes = this.latest.slice(); const generation = this.generation;
        if (bytes.length > Math.min(MAX_BYTES, this.client.state.maxBytes)) {
          throw error('GUEST_SAVE_TOO_LARGE','This file exceeds the 64 MiB browser-local limit. Download a recovery copy.');
        }
        this.pending = {bytes,generation,baseRevision:this.revision,idempotencyKey:id('blend_'),sha256:await digest(bytes),receipt:null};
      }
      const attempt = this.pending;
      if (!attempt.receipt) {
        const receipt = await this.client.request('replace', [{bytes:attempt.bytes.buffer.slice(0),
          baseRevision:attempt.baseRevision,idempotencyKey:attempt.idempotencyKey}], {unknown:true});
        if (!receipt || receipt.resourceId !== this.client.state.resourceId
            || typeof receipt.contentRevision !== 'string' || !receipt.contentRevision
            || receipt.byteLength !== attempt.bytes.length) {
          throw error('GUEST_SAVE_UNCONFIRMED','The browser returned an invalid save receipt. Keep this editor open.');
        }
        attempt.receipt = receipt;
      }
      const checkpoint = await this.client.request('checkpoint', [], {unknown:true});
      if (!checkpoint || checkpoint.resourceId !== this.client.state.resourceId
          || checkpoint.contentRevision !== attempt.receipt.contentRevision
          || checkpoint.byteLength !== attempt.bytes.length || checkpoint.exportSafety?.contentSha256 !== attempt.sha256) {
        throw error('GUEST_SAVE_UNCONFIRMED','The saved file did not match its verified checkpoint. Keep this editor open.');
      }
      this.revision = attempt.receipt.contentRevision; this.committed = attempt.generation; this.pending = null;
      this.changed();
    }
  }
  // Explicit discard fences every future write before asking the broker to
  // quiesce. Unknown acknowledgements retain the fence and all native memory.
  // Only an existing immutable save attempt is reconciled; fresh edits are not
  // implicitly saved when the person has chosen to discard them.
  class DiscardCoordinator {
    constructor(client, {queue, quiesce, resume, dirty}) {
      this.client = client; this.queue = queue; this.quiesce = quiesce;
      this.resume = resume; this.dirty = dirty; this.barrier = null; this.lastResume = null;
    }
    get active() { return this.barrier !== null; }
    async prepare() {
      if (!this.barrier) { this.barrier = {id:id('gdi_'),receipt:null}; this.lastResume = null; }
      this.quiesce();
      if (this.barrier.receipt) return {...this.barrier.receipt,dirty:this.dirty()};
      const queue = this.queue();
      if (queue?.flight) {
        try { await queue.flight; }
        catch (reason) { if (!queue.pending) throw reason; }
      }
      if (queue?.pending) await queue.flush();
      if (queue?.flight || queue?.pending) throw error('GUEST_DISCARD_UNCONFIRMED','A save is unresolved. Keep this editor open.');
      const result = await this.client.request('prepareDiscard',[],{unknown:true});
      if (result?.quiesced !== true || typeof result.contentRevision !== 'string' || !result.contentRevision
          || !Number.isSafeInteger(result.metadataRevision) || result.metadataRevision < 1
          || (queue && result.contentRevision !== queue.revision)) {
        throw error('GUEST_DISCARD_UNCONFIRMED','The browser file could not be paused safely. Keep this editor open.');
      }
      const receipt = {canDiscard:true,quiesced:true,discardId:this.barrier.id,
        resourceId:this.client.state.resourceId,contentRevision:result.contentRevision,
        metadataRevision:result.metadataRevision,dirty:this.dirty()};
      this.barrier.receipt = receipt;
      return receipt;
    }
    async resumeAfterFailure() {
      if (!this.barrier && this.lastResume) return {...this.lastResume,dirty:this.dirty()};
      if (!this.barrier) throw error('GUEST_DISCARD_UNCONFIRMED','No paused discard operation exists.');
      const result = await this.client.request('resumeAfterDiscardFailure',[],{unknown:true});
      if (result?.resumed !== true) throw error('GUEST_DISCARD_UNCONFIRMED','Browser storage did not resume. Keep this editor open.');
      const discardId = this.barrier.id;
      this.barrier = null;
      this.lastResume = {resumed:true,discardId,resourceId:this.client.state.resourceId};
      this.resume();
      return {...this.lastResume,dirty:this.dirty()};
    }
  }
  const api = Object.freeze({MAX_BYTES,ResourceClient,SaveQueue,DiscardCoordinator,readLaunch,validInit,validAction,digest,error});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(window,'bosonooGuestResource',{value:api});
})();
