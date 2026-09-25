/* SPDX-License-Identifier: GPL-3.0-or-later
 * Blender guest shell. Native bytes stay in this frame or the one-file
 * browser-owned resource port. No account cookies, broker grants or AI adapter. */
'use strict';
(function () {
  const H = window.bosonooGuestPrimitives;
  const R = window.bosonooGuestResource;
  let launch, launchError;
  try { launch = R.readLaunch(location.hash, location.origin); } catch (error) { launchError = error; }
  // Remove channel nonce before loading any vendor module or displaying history.
  history.replaceState(null, '', location.pathname);
  let uiPort, client, saves, discard, moduleValue, bargs = Object.freeze([]);
  let uiIn = 0, uiOut = 0, armed = false, launched = false, mounted = false;
  let phase = 'opening', nativeDirty = true, lastError = '', status = 'Opening your browser-owned file…';
  let saveTimer, nativeTimer, heartbeat, actionFlight = false, startupFailed = false;
  let closePreparing = false;
  const seenActions = new Set();
  function locked(name, descriptor) {
    try { Object.defineProperty(window,name,{configurable:false,enumerable:false,...descriptor}); return true; }
    catch (_) { return false; }
  }
  function fileHook() {
    if (discard?.active) return false;
    void saveCurrent().catch(report);
    return false;
  }
  const locks = [
    locked('__BARGS',{get:()=>bargs,set:()=>{}}),
    locked('__CAPENV',{get:()=>undefined,set:()=>{}}),
    ...['__blenderSaveHook','__blenderSaveDownload','__blenderFileOpenHook'].map(name =>
      locked(name,{get:()=>fileHook,set:()=>{}})),
    locked('Module',{get:()=>moduleValue,set:value=>{
      if (value === moduleValue) return;
      if (!armed || moduleValue || startupFailed) throw new Error('Guest Blender startup was not authorized.');
      moduleValue = value;
      const before = Array.isArray(value.preRun) ? value.preRun.slice() : value.preRun ? [value.preRun] : [];
      before.push(()=>{ value.geckoProviders = value.geckoProviders || {}; value.geckoProviders[7] = memory.provider; });
      value.preRun = before;
      const vendorInit = value.onRuntimeInitialized;
      value.onRuntimeInitialized = function () {
        if (typeof vendorInit === 'function') vendorInit.call(this);
        try {
          value.ccall('blender_web_set_has_fsaccess',null,['number'],[0]);
          value.geckoProviders = value.geckoProviders || {};
          value.geckoProviders[7] = memory.provider;
          if (value.ccall('blender_web_mount_provider','number',['number','string'],[7,'/bosonoo']) !== 0) throw new Error('mount');
          if (!['_blender_bosonoo_autosave_enable','_blender_bosonoo_autosave_status','_blender_bosonoo_save_current']
              .every(key=>typeof value[key] === 'function')) throw new Error('autosave');
          if (value.ccall('blender_bosonoo_autosave_enable','number',['string'],['/bosonoo/'+memory.openKey()]) !== 1) throw new Error('autosave');
          mounted = true; startNativeAutosave();
        } catch (_) { report(R.error('GUEST_NATIVE_START_FAILED','Blender could not initialize safe local saving. Keep the original file.')); }
      };
    }})
  ];
  const memory = H.createMemoryProvider({
    onSave:()=>{
      if (!launched || !saves) return;
      try { saves.record(memory.read(memory.openKey())); }
      catch (error) { report(error); return; }
      clearTimeout(saveTimer);
      if (!discard?.active) saveTimer = setTimeout(()=>{ saveTimer = null; void persist().catch(report); },1500);
      notify();
    },
    onOtherBlend:()=>report(R.error('GUEST_DOCUMENT_CHANGED','A different Blender filename was saved. Keep this editor open; only the opened file belongs to the local workspace.'))
  });
  function dirty() { return nativeDirty || Boolean(saves?.dirty); }
  function send(type, extra) {
    if (!uiPort) return;
    try { uiPort.postMessage({type:'bosonoo:guest-blender:'+type,version:1,
      instanceId:launch.instanceId,sequence:++uiOut,...extra}); } catch (_) { /* retain native recovery */ }
  }
  function notify() {
    const line = document.getElementById('bosonoo-status');
    if (line) line.textContent = status;
    const notice = document.getElementById('guest-notice');
    if (notice) { notice.textContent = lastError ? status : ''; notice.hidden = !lastError; }
    send('state',{state:{phase:discard?.active?'discarding':phase,dirty:dirty(),saving:Boolean(saves?.flight || actionFlight),
      recoverable:Boolean(launched && memory.read(memory.openKey())),status,errorCode:lastError}});
  }
  function report(error) {
    lastError = String(error?.code || 'GUEST_EDITOR_FAILED').slice(0,100);
    status = error?.code ? String(error.message).slice(0,400)
      : 'Blender could not complete the operation. Keep this editor open and download a recovery copy.';
    if (!launched) { phase = 'failed'; startupFailed = true; }
    notify();
  }
  function nativeStatus() {
    if (!mounted || !moduleValue) throw R.error('GUEST_NOT_READY','Wait for Blender to finish opening.');
    const value = moduleValue.ccall('blender_bosonoo_autosave_status','number',[],[]);
    if (!Number.isInteger(value) || value < 1 || value > 7) throw R.error('GUEST_NATIVE_STATE','Blender save state is unavailable.');
    nativeDirty = value !== 2;
    if (value === 7) throw R.error('GUEST_DOCUMENT_CHANGED','The active Blender document changed. Keep this editor open; automatic local saving stopped.');
    return value;
  }
  function startNativeAutosave() {
    clearInterval(nativeTimer);
    const poll = H.createAutosaveScheduler({now:()=>Date.now(),status:nativeStatus,
      request:()=>moduleValue.ccall('blender_bosonoo_save_current','number',[],[]),
      changed:value=>{
        if (value === 6) report(R.error('GUEST_NATIVE_SAVE_FAILED','Blender could not serialize your edits. Keep this editor open and retry Save.'));
        notify();
      }});
    nativeTimer = setInterval(()=>{
      if (phase !== 'running' || discard?.active) return;
      try { poll(); } catch (error) { clearInterval(nativeTimer); report(error); }
    },1000);
  }
  async function persist() {
    if (discard?.active) throw R.error('GUEST_DISCARD_PENDING','This editor is paused for deletion. Cancel deletion to continue.');
    if (!saves) throw R.error('GUEST_NOT_READY','Wait for Blender to finish opening.');
    await saves.flush();
    if (saves.dirty && !saveTimer && !discard?.active) {
      // A second native write may arrive during the first replacement. Drain it
      // after that exact attempt resolves even if Blender is now natively clean.
      saveTimer = setTimeout(()=>{ saveTimer = null; void persist().catch(report); },1500);
    }
    if (!saves.dirty && !nativeDirty && !discard?.active) { lastError = ''; status = 'Saved in this browser. Your imported original is retained.'; }
    notify();
  }
  function serializeNative({recoveryOnly=false} = {}) {
    return new Promise((resolve,reject)=>{
      try {
        if (discard?.active && !recoveryOnly) throw R.error('GUEST_DISCARD_PENDING','This editor is paused for deletion. Cancel deletion to continue.');
        if (phase !== 'running' || !mounted) throw R.error('GUEST_NOT_READY','Wait for Blender to finish opening.');
        const before = nativeStatus();
        if (before === 2) { resolve(); return; }
        if (moduleValue.ccall('blender_bosonoo_save_current','number',[],[]) !== 1) throw R.error('GUEST_NATIVE_SAVE_FAILED','Blender refused the save. Keep this editor open.');
      } catch (error) { reject(error); return; }
      const deadline = Date.now()+45000;
      function poll() {
        try {
          const value = nativeStatus();
          if (value === 2) { resolve(); return; }
          if (value === 6) throw R.error('GUEST_NATIVE_SAVE_FAILED','Blender could not serialize your edits. Keep this editor open.');
          if (Date.now()>deadline) throw R.error('GUEST_NATIVE_SAVE_BUSY','Finish the active Blender operation, then retry Save. Your work remains open.');
          setTimeout(poll,100);
        } catch (error) { reject(error); }
      }
      setTimeout(poll,100);
    });
  }
  async function saveCurrent() {
    await serializeNative();
    clearTimeout(saveTimer); saveTimer = null;
    // One retry reconciles an earlier immutable attempt; a newer native write
    // remains separate. Continuous editing returns canClose:false, never a lie.
    await persist();
    if (saves.dirty) await persist();
    let checkpoint = null;
    const checkpointGeneration = saves.generation;
    const checkpointRevision = saves.revision;
    if (!saves.dirty) {
      checkpoint = await client.request('checkpoint',[],{unknown:true});
      if (checkpoint?.resourceId !== client.state.resourceId || checkpoint.contentRevision !== saves.revision
          || !Number.isSafeInteger(checkpoint.metadataRevision)
          || checkpoint.exportSafety?.contentSha256 !== await R.digest(memory.read(memory.openKey()).slice())) {
        throw R.error('GUEST_SAVE_UNCONFIRMED','The current browser revision could not be confirmed.');
      }
    }
    nativeStatus(); notify();
    const stable = saves.generation === checkpointGeneration && saves.revision === checkpointRevision;
    return {saved:!dirty() && stable,canClose:!dirty() && stable,dirty:dirty() || !stable,
      ...(checkpoint ? {contentRevision:checkpoint.contentRevision,metadataRevision:checkpoint.metadataRevision} : {})};
  }
  async function prepareClose() {
    if (discard?.active) throw R.error('GUEST_DISCARD_PENDING','This editor is paused for deletion.');
    if (launched || saves?.dirty || saves?.pending || saves?.flight) return saveCurrent();
    // There is no native edit to discard before launch. Hold startup while the
    // broker checkpoints the unchanged browser-owned source; an unsupported GPU
    // must not trap the user in a window that never became editable.
    closePreparing = true;
    try {
      await client.ready;
      const checkpoint = await client.request('checkpoint',[],{unknown:true});
      if (launched || checkpoint?.resourceId !== client.state.resourceId
          || typeof checkpoint.contentRevision !== 'string' || !checkpoint.contentRevision
          || !Number.isSafeInteger(checkpoint.metadataRevision)) {
        throw R.error('GUEST_SAVE_UNCONFIRMED','The unchanged browser file could not be confirmed.');
      }
      return {saved:true,canClose:true,dirty:false,contentRevision:checkpoint.contentRevision,
        metadataRevision:checkpoint.metadataRevision};
    } catch (error) { closePreparing = false; throw error; }
  }
  async function recoveryDownload() {
    // Recovery serialization writes only the retained frame memory. onSave keeps
    // those bytes while the discard barrier blocks every broker replacement.
    await serializeNative({recoveryOnly:true});
    const bytes = memory.read(memory.openKey());
    if (!bytes?.length) throw R.error('GUEST_RECOVERY_UNAVAILABLE','Blender has not serialized a file to download.');
    const url = URL.createObjectURL(new Blob([bytes.slice()],{type:'application/x-blender'}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = H.safeName(memory.openKey()).replace(/\.blend$/i,' (browser Blender 5.3 recovery).blend');
    anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    // Starting a browser download is not a durable local-workspace receipt.
    return {saved:!dirty(),canClose:!dirty() && !discard?.active,dirty:dirty()};
  }
  async function originalDownload() {
    if (!client) throw R.error('GUEST_NOT_READY','Wait for the local file channel.');
    const descriptor = await client.request('stat');
    const original = descriptor?.blenderOriginal;
    if (!original?.preserved) throw R.error('GUEST_ORIGINAL_UNAVAILABLE','No separate imported original is available for this file.');
    const buffer = await client.request('read',[{original:true}]);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== original.byteLength
        || buffer.byteLength > R.MAX_BYTES || await R.digest(buffer) !== original.contentSha256) {
      throw R.error('GUEST_ORIGINAL_INVALID','The original file did not match its verified bytes.');
    }
    const url = URL.createObjectURL(new Blob([buffer],{type:'application/x-blender'}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = H.safeName(memory.openKey()).replace(/\.blend$/i,' (original).blend');
    anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function action(message) {
    if (!R.validAction(message,launch.instanceId,uiIn) || seenActions.has(message.requestId)) {
      report(R.error('GUEST_UI_PROTOCOL','The editor control channel was replayed or malformed. Keep this editor open.'));
      return;
    }
    uiIn = message.sequence; seenActions.add(message.requestId);
    if (seenActions.size > 512) seenActions.delete(seenActions.values().next().value);
    if (actionFlight) {
      send('response',{requestId:message.requestId,ok:false,error:{code:'GUEST_BUSY',message:'A save is already in progress.'}}); return;
    }
    actionFlight = true; notify();
    try {
      const result = await (message.action === 'prepareDiscard' ? discard.prepare()
        : message.action === 'resumeAfterDiscardFailure' ? discard.resumeAfterFailure()
        : message.action === 'export' ? recoveryDownload()
        : message.action === 'prepareClose' ? prepareClose() : saveCurrent());
      send('response',{requestId:message.requestId,ok:true,result});
    } catch (error) {
      report(error); send('response',{requestId:message.requestId,ok:false,error:{code:lastError,message:status}});
    } finally { actionFlight = false; notify(); }
  }
  async function hydrate() {
    const ready = await client.ready;
    const before = await client.request('open');
    const buffer = await client.request('read');
    const after = await client.request('stat');
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > Math.min(R.MAX_BYTES,ready.maxBytes)
        || !before || !after || before.resourceId !== ready.resourceId || after.resourceId !== ready.resourceId
        || before.contentRevision !== after.contentRevision
        || buffer.byteLength !== after.byteLength || typeof after.contentRevision !== 'string') {
      throw R.error('GUEST_FILE_CHANGED','The local file changed while opening. Reopen it from Bosonoo.');
    }
    const key = 'workspace/'+H.safeName(after.name || after.displayName || 'project.blend');
    memory.putFile(key,new Uint8Array(buffer)); memory.setOpenKey(key);
    saves = new R.SaveQueue(client,after.contentRevision,{changed:notify});
    const response = await fetch(new URL('bosonoo/session.py',location.href),{credentials:'omit',cache:'force-cache',redirect:'error'});
    if (!response.ok) throw R.error('GUEST_PACK_INVALID','The Blender session guard is missing.');
    const script = new Uint8Array(await response.arrayBuffer());
    if (script.length<100 || script.length>65536) throw R.error('GUEST_PACK_INVALID','The Blender session guard is invalid.');
    memory.putReadOnly('runtime/session.py',script);
    bargs = Object.freeze(['--disable-autoexec','/bosonoo/'+key,'--python','/bosonoo/runtime/session.py']);
    heartbeat = setInterval(()=>{ if (!client.closed) void client.request('stat').catch(report); },15000);
  }
  function boot() {
    return new Promise((resolve,reject)=>{
      const button = document.getElementById('start-btn');
      if (!button) { reject(R.error('GUEST_PACK_INVALID','The Blender start control is missing.')); return; }
      armed = true; const deadline = Date.now()+15*60*1000;
      function poll() {
        if (startupFailed) return;
        if (closePreparing || discard?.active) { setTimeout(poll,250); return; }
        const warning = document.getElementById('gpu-warning');
        if (warning && !warning.hidden) { reject(R.error('GUEST_WEBGPU_REQUIRED','Blender requires a hardware WebGPU adapter.')); return; }
        if (Date.now()>deadline) { reject(R.error('GUEST_LOAD_TIMEOUT','Blender did not finish loading. Your browser-owned original is retained.')); return; }
        if (button.disabled) { setTimeout(poll,250); return; }
        launched = true; phase = 'loading'; status = 'Blender is opening your local file…'; notify();
        const canvas = document.getElementById('canvas');
        const observer = new MutationObserver(()=>{
          if (!canvas.classList.contains('ready')) return;
          observer.disconnect(); phase = 'running'; status = 'Your file stays in this browser. Changes save automatically.';
          notify();
          setTimeout(()=>{
            ['keydown','keyup'].forEach(type=>canvas.dispatchEvent(new KeyboardEvent(type,
              {key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true})));
          },1500);
        });
        observer.observe(canvas,{attributes:true,attributeFilter:['class']});
        button.click(); resolve();
      }
      poll();
    });
  }
  function installLocalControls() {
    const controls = document.createElement('div'); controls.id = 'guest-controls';
    const note = document.createElement('span'); note.id = 'guest-notice'; note.hidden = true;
    const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download recovery copy';
    download.addEventListener('click',()=>void recoveryDownload().catch(report));
    const original = document.createElement('button'); original.type = 'button'; original.textContent = 'Download original';
    original.addEventListener('click',()=>void originalDownload().catch(report));
    controls.append(note,original,download); document.body.append(controls);
    const box = document.getElementById('console-output');
    new MutationObserver(records=>{
      for (const record of records) for (const node of record.addedNodes) {
        const text = String(node.textContent || '');
        if (text.length<400 && /Failed to read blend file|file could not be loaded|Blender quit|ABORT:|Failed to start:/i.test(text)) {
          report(R.error('GUEST_NATIVE_LOAD_FAILED','Blender could not open this file. Your browser-owned original is retained.'));
        }
      }
    }).observe(box,{childList:true});
    notify();
  }
  const dom = new Promise(resolve=>{
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',resolve,{once:true}); else resolve();
  });
  dom.then(()=>{ installLocalControls(); if (launchError) report(launchError); });
  const initTimeout = setTimeout(()=>{ if (!client) report(R.error('GUEST_INIT_TIMEOUT','The local file channel did not arrive. Reopen from Bosonoo.')); },45000);
  function init(event) {
    if (launchError || !launch || client || !R.validInit(event,launch,window.parent)) return;
    window.removeEventListener('message',init); clearTimeout(initTimeout);
    uiPort = event.ports[0]; uiPort.onmessage = event=>void action(event.data); uiPort.start();
    client = new R.ResourceClient(event.ports[1],launch.instanceId,{onFailure:report});
    discard = new R.DiscardCoordinator(client,{queue:()=>saves,dirty,
      quiesce:()=>{
        clearTimeout(saveTimer); saveTimer=null;
        clearInterval(nativeTimer); nativeTimer=null;
        status='Blender is paused while this temporary file is deleted. Your open work is retained until deletion succeeds.';
        notify();
      },
      resume:()=>{
        closePreparing=false;
        status='Deletion did not finish. Your Blender work remains open.';
        lastError='';
        if (mounted) startNativeAutosave();
        if (saves?.dirty) saveTimer=setTimeout(()=>{saveTimer=null;void persist().catch(report);},1500);
        notify();
      }});
    void dom.then(async()=>{
      if (locks.some(value=>!value) || moduleValue || window.crossOriginIsolated !== true || window.parent === window) {
        throw R.error('GUEST_ISOLATION_REQUIRED','This browser or deployment cannot safely embed Blender.');
      }
      if (!navigator.gpu) throw R.error('GUEST_WEBGPU_REQUIRED','Blender requires a hardware WebGPU adapter.');
      const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) throw R.error('GUEST_WEBGPU_REQUIRED','Blender requires a hardware WebGPU adapter.');
      await hydrate(); await boot();
    }).catch(report);
  }
  window.addEventListener('message',init);
  // Pause native input and every future save request while the broker's discard
  // barrier is held. A native write already underway may finish into memory;
  // onSave retains those bytes without sending a replacement to the broker.
  for (const type of ['keydown','keyup','pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','wheel','touchstart','touchmove','touchend','click']) {
    window.addEventListener(type,event=>{
      if (!discard?.active) return;
      event.preventDefault(); event.stopImmediatePropagation();
    },{capture:true,passive:false});
  }
  window.addEventListener('beforeunload',event=>{
    if (!dirty() && !saves?.flight) return;
    event.preventDefault(); event.returnValue = 'Local Blender changes are not yet confirmed saved.';
  });
  window.addEventListener('pagehide',()=>{ clearInterval(nativeTimer); clearInterval(heartbeat); });
})();
