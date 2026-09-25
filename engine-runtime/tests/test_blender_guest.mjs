import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {MessageChannel} from 'node:worker_threads';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const R = require('../pack/blender/guest-resource.js');
const H = require('../pack/blender/guest-primitives.js');
const instance = 'a'.repeat(64), nonce = 'b'.repeat(64);
const origin = 'https://guest-engine.example.com', parent = 'https://app.example.com';
const fragment = '#parent='+encodeURIComponent(parent)+'&instance='+instance+'&nonce='+nonce;
const bytes = new TextEncoder().encode('BLENDER-v503data');
const next = () => new Promise(resolve=>setTimeout(resolve,10));

test('launch requires exact nonopaque different origin and two single opaque identities',()=>{
  assert.deepEqual(R.readLaunch(fragment,origin),{parent,instanceId:instance,nonce});
  for (const bad of [fragment+'&other=x',fragment+'&nonce='+nonce,
    fragment.replace(encodeURIComponent(parent),'null'),fragment.replace(instance,'short'),
    fragment.replace(encodeURIComponent(parent),encodeURIComponent(origin)),
    fragment.replace(encodeURIComponent(parent),encodeURIComponent('http://untrusted.example.com'))]) {
    assert.throws(()=>R.readLaunch(bad,origin));
  }
});
test('init binds exact parent WindowProxy/origin/nonce and exactly two ports',()=>{
  const source = {}, launch = R.readLaunch(fragment,origin);
  const event = {source,origin:parent,data:{type:'bosonoo:guest-blender:init',version:1,instanceId:instance,nonce},ports:[{},{}]};
  assert.equal(R.validInit(event,launch,source),true);
  for (const bad of [{...event,source:{}},{...event,origin:'https://foreign.example'},
    {...event,ports:[{}]},{...event,data:{...event.data,nonce:'c'.repeat(64)}},
    {...event,data:{...event.data,url:'https://evil.example'}}]) assert.equal(Boolean(R.validInit(bad,launch,source)),false);
});
test('UI actions are content-free, ordered and deny arbitrary fields/operations',()=>{
  const m={type:'bosonoo:guest-blender:action',version:1,instanceId:instance,sequence:1,requestId:'gbr_'+'d'.repeat(32),action:'save'};
  assert.equal(R.validAction(m,instance,0),true);
  for (const change of [{sequence:2},{action:'runPython'},{args:[]},{bytes:bytes},{instanceId:nonce},{version:'1'}]) {
    assert.equal(Boolean(R.validAction({...m,...change},instance,0)),false);
  }
});
function queueFixture() {
  let revision='rev_1', body=bytes.slice(), failReplace=false, failCheckpoint=false;
  const calls=[];
  const client={state:{maxBytes:R.MAX_BYTES,resourceId:'res_1'},async request(method,args){
    calls.push({method,args:structuredClone(args)});
    if (method==='replace') {
      body=new Uint8Array(args[0].bytes); revision='rev_2';
      if (failReplace) { failReplace=false; throw R.error('LOCAL_RESOURCE_SESSION_RESULT_UNKNOWN','unknown'); }
      return {resourceId:'res_1',contentRevision:revision,byteLength:body.length};
    }
    if (failCheckpoint) { failCheckpoint=false; throw R.error('STORAGE_UNAVAILABLE','quota'); }
    return {resourceId:'res_1',contentRevision:revision,byteLength:body.length,exportSafety:{contentSha256:await R.digest(body)}};
  }};
  const queue=new R.SaveQueue(client,revision);
  return {client,queue,calls,failReplace:()=>{failReplace=true;},failCheckpoint:()=>{failCheckpoint=true;}};
}
test('a save needs matching durable checkpoint hash and resource identity',async()=>{
  const f=queueFixture(); f.queue.record(bytes); await f.queue.flush();
  assert.equal(f.queue.dirty,false); assert.equal(f.queue.revision,'rev_2');
  assert.deepEqual(f.calls.map(c=>c.method),['replace','checkpoint']);
  for (const mutation of [{resourceId:'foreign'},{contentRevision:'wrong'},{exportSafety:{contentSha256:'0'.repeat(64)}}]) {
    const g=queueFixture(), request=g.client.request.bind(g.client);
    g.client.request=async(m,a)=>({...await request(m,a),...(m==='checkpoint'?mutation:{})});
    g.queue.record(bytes); await assert.rejects(g.queue.flush(),e=>e.code==='GUEST_SAVE_UNCONFIRMED');
    assert.equal(g.queue.dirty,true); assert.ok(g.queue.pending);
  }
});
test('lost replacement response replays immutable bytes/base/key before newer edits',async()=>{
  const f=queueFixture(); f.queue.record(bytes); f.failReplace();
  await assert.rejects(f.queue.flush()); const old=f.calls[0].args[0];
  const newer=new TextEncoder().encode('BLENDER-v503newer'); f.queue.record(newer);
  await f.queue.flush();
  assert.deepEqual(f.calls[1].args[0],old); assert.equal(f.queue.dirty,true);
  await f.queue.flush(); assert.equal(f.queue.dirty,false);
  const writes=f.calls.filter(c=>c.method==='replace');
  assert.equal(writes.length,3); assert.notEqual(writes[2].args[0].idempotencyKey,old.idempotencyKey);
  assert.equal(writes[2].args[0].baseRevision,'rev_2');
  assert.deepEqual(new Uint8Array(writes[2].args[0].bytes),newer);
});
test('checkpoint failure keeps replacement receipt and never dispatches replacement again',async()=>{
  const f=queueFixture(); f.queue.record(bytes); f.failCheckpoint();
  await assert.rejects(f.queue.flush()); assert.equal(f.queue.dirty,true);
  await f.queue.flush(); assert.deepEqual(f.calls.map(c=>c.method),['replace','checkpoint','checkpoint']);
  assert.equal(f.queue.dirty,false);
});
test('byte limit refuses dispatch but retains local recovery bytes',async()=>{
  const f=queueFixture(); f.client.state.maxBytes=4; f.queue.record(bytes);
  await assert.rejects(f.queue.flush(),e=>e.code==='GUEST_SAVE_TOO_LARGE');
  assert.equal(f.calls.length,0); assert.deepEqual(f.queue.latest,bytes); assert.equal(f.queue.dirty,true);
});
test('edits made while the first replacement is pending remain dirty after its acknowledgement',async()=>{
  const f=queueFixture(); let release; const hold=new Promise(r=>{release=r;});
  const request=f.client.request.bind(f.client);
  f.client.request=async(m,a)=>{if(m==='replace') await hold; return request(m,a);};
  f.queue.record(bytes); const flight=f.queue.flush(); await next();
  f.queue.record(new Uint8Array([1,2,3])); release(); await flight;
  assert.equal(f.queue.committed,1); assert.equal(f.queue.generation,2); assert.equal(f.queue.dirty,true);
});
function wire(timeoutMs=100) {
  const channel=new MessageChannel(), sent=[];
  const client=new R.ResourceClient(channel.port1,instance,{timeoutMs});
  channel.port2.on('message',m=>sent.push(m));
  let sequence=0;
  function send(payload){channel.port2.postMessage({protocol:'bosonoo.local-resource-session',version:2,
    instanceId:instance,sequence:++sequence,...payload});}
  function ready(){send({kind:'ready',state:{editorKind:'engine',mode:'read-write',resourceId:'res_1',readOnly:false,maxBytes:R.MAX_BYTES}});}
  function close(){client.fail(R.error('TEST_CLOSED','closed'));channel.port2.close();}
  return {client,sent,send,ready,close};
}
test('resource client uses v2 method allowlist and validates scoped monotonic responses',async()=>{
  const w=wire();try {
    w.ready(); await w.client.ready;
    const result=w.client.request('read'); await next();
    assert.equal(w.sent[0].method,'read');assert.equal(w.sent[0].instanceId,instance);
    w.send({kind:'response',requestId:w.sent[0].requestId,ok:true,result:bytes.buffer});
    assert.deepEqual(new Uint8Array(await result),bytes);
    await assert.rejects(w.client.request('eval')); assert.equal(w.sent.length,1);
    w.send({kind:'response',requestId:'lrs_'+'0'.repeat(32),ok:true,result:null,instanceId:nonce});
    await next(); assert.equal(w.client.closed,true);
  } finally {w.close();}
});
test('unknown write timeout keeps channel and ignores its eventual late acknowledgement',async()=>{
  const w=wire(30);try {
    w.ready();await w.client.ready;
    await assert.rejects(w.client.request('replace',[{}],{unknown:true}),e=>e.code==='LOCAL_RESOURCE_SESSION_RESULT_UNKNOWN');
    assert.equal(w.client.closed,false);
    w.send({kind:'response',requestId:w.sent[0].requestId,ok:true,result:{}});await next();
    assert.equal(w.client.closed,false);assert.equal(w.client.ignored.size,0);
  } finally {w.close();}
});
test('guest memory provider observes only real opened-file saves and protects session guard',async()=>{
  const written=[];const mem=H.createMemoryProvider({onSave:k=>written.push(k)});
  mem.putFile('workspace/project.blend',bytes);mem.setOpenKey('workspace/project.blend');
  mem.putReadOnly('runtime/session.py',bytes);
  await mem.provider.writeFile('/bosonoo/workspace/project.blend@',bytes);
  await mem.provider.writeFile('/bosonoo/workspace/project.blend1',bytes);
  assert.deepEqual(written,[]);
  await mem.provider.rename('/bosonoo/workspace/project.blend@','/bosonoo/workspace/project.blend');
  assert.deepEqual(written,['workspace/project.blend']);
  await assert.rejects(mem.provider.writeFile('/bosonoo/runtime/session.py',new Uint8Array([1])));
  await assert.rejects(mem.provider.rename('workspace/project.blend','runtime/session.py'));
});
test('startup hooks are locked before vendor entry and reject an unarmed native launch',()=>{
  const events=new Map(), timers=[];
  const context={URL,URLSearchParams,Map,Set,Object,Array,Uint8Array,ArrayBuffer,Promise,Number,
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval(){},clearInterval(){},
    location:{hash:fragment,origin,pathname:'/engine-packs/blender-guest/a/guest.html'},history:{replaceState(){}},
    document:{readyState:'loading',addEventListener(){}},};
  context.window={bosonooGuestPrimitives:H,bosonooGuestResource:R,parent:{},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:()=>{}};
  vm.runInNewContext(fs.readFileSync(new URL('../pack/blender/guest.js',import.meta.url),'utf8'),context);
  assert.throws(()=>{context.window.Module={};},/startup was not authorized/);
  context.window.__BARGS=['--python-expr','bad'];assert.deepEqual([...context.window.__BARGS],[]);
  context.window.__CAPENV={secret:'value'};assert.equal(context.window.__CAPENV,undefined);
  assert.equal(Object.getOwnPropertyDescriptor(context.window,'__blenderFileOpenHook').configurable,false);
});

test('a never-launched editor can close only after its unchanged file checkpoint is confirmed',async()=>{
  for (const ok of [true,false]) {
    const events=new Map(), source={}, ui=new MessageChannel(), resource=new MessageChannel();
    const replies=[], operations=[];
    ui.port2.on('message',m=>replies.push(m));
    resource.port2.on('message',m=>{
      operations.push(m.method);
      resource.port2.postMessage({kind:'response',protocol:'bosonoo.local-resource-session',version:2,
        instanceId:instance,sequence:2,requestId:m.requestId,ok,
        ...(ok?{result:{resourceId:'res_1',contentRevision:'rev_1',metadataRevision:3}}:{error:{code:'QUOTA'}})});
    });
    const context={URL,URLSearchParams,Map,Set,Object,Array,Uint8Array,ArrayBuffer,Promise,Number,
      setTimeout:()=>1,clearTimeout(){},setInterval(){},clearInterval(){},
      location:{hash:fragment,origin,pathname:'/engine-packs/blender-guest/a/guest.html'},history:{replaceState(){}},
      document:{readyState:'loading',addEventListener(){},getElementById(){return null;}}};
    context.window={bosonooGuestPrimitives:H,bosonooGuestResource:R,parent:source,
      addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:()=>{}};
    vm.runInNewContext(fs.readFileSync(new URL('../pack/blender/guest.js',import.meta.url),'utf8'),context);
    try {
      events.get('message')({source,origin:parent,ports:[ui.port1,resource.port1],
        data:{type:'bosonoo:guest-blender:init',version:1,instanceId:instance,nonce}});
      resource.port2.postMessage({kind:'ready',protocol:'bosonoo.local-resource-session',version:2,
        instanceId:instance,sequence:1,state:{editorKind:'engine',mode:'read-write',resourceId:'res_1',readOnly:false,maxBytes:R.MAX_BYTES}});
      ui.port2.postMessage({type:'bosonoo:guest-blender:action',version:1,instanceId:instance,sequence:1,
        requestId:'gbr_'+'a'.repeat(32),action:'prepareClose'});
      for(let i=0;i<20&&!replies.some(m=>m.type.endsWith(':response'));i++) await next();
      const response=replies.find(m=>m.type.endsWith(':response'));
      assert.ok(response);assert.equal(response.ok,ok);assert.deepEqual(operations,['checkpoint']);
      if(ok){assert.equal(response.result.canClose,true);assert.equal(response.result.contentRevision,'rev_1');assert.equal(response.result.metadataRevision,3);}
      else assert.equal(response.result,undefined);
      assert.equal(context.window.Module,undefined);
    } finally {ui.port1.close();ui.port2.close();resource.port1.close();resource.port2.close();}
  }
});

test('discard freezes fresh edits without saving them and resumes only after broker acknowledgement',async()=>{
  const calls=[], transitions=[];
  let resumeAck;
  const client={state:{resourceId:'res_1',maxBytes:R.MAX_BYTES},async request(method){
    calls.push(method);
    if(method==='prepareDiscard') return {quiesced:true,contentRevision:'rev_1',metadataRevision:4};
    if(method==='resumeAfterDiscardFailure') return new Promise(resolve=>resumeAck=resolve);
    throw new Error('Unexpected implicit save');
  }};
  const queue=new R.SaveQueue(client,'rev_1');queue.record(new Uint8Array([1,2,3]));
  const discard=new R.DiscardCoordinator(client,{queue:()=>queue,quiesce:()=>transitions.push('pause'),
    resume:()=>transitions.push('resume'),dirty:()=>queue.dirty});
  const receipt=await discard.prepare();
  assert.equal(receipt.canDiscard,true);assert.equal(receipt.quiesced,true);assert.equal(receipt.dirty,true);
  assert.equal(receipt.resourceId,'res_1');assert.match(receipt.discardId,/^gdi_[a-f0-9]{32}$/);
  assert.deepEqual(calls,['prepareDiscard']);assert.equal(queue.dirty,true);
  const waiting=discard.resumeAfterFailure();await next();
  assert.equal(discard.active,true);assert.deepEqual(transitions,['pause']);
  resumeAck({resumed:true});const resumed=await waiting;
  assert.equal(resumed.discardId,receipt.discardId);assert.equal(resumed.resourceId,'res_1');
  assert.equal(resumed.dirty,true);assert.equal(discard.active,false);assert.deepEqual(transitions,['pause','resume']);
  assert.deepEqual([...queue.latest],[1,2,3]);
  // The parent may lose the successful UI acknowledgement after broker resume.
  // Explicit retry returns that same barrier receipt without another mutation.
  const replay=await discard.resumeAfterFailure();
  assert.deepEqual(replay,resumed);assert.deepEqual(calls,['prepareDiscard','resumeAfterDiscardFailure']);
  const nextReceipt=await discard.prepare();assert.notEqual(nextReceipt.discardId,receipt.discardId);
  assert.equal(discard.lastResume,null);
});

test('discard reconciles an immutable in-flight save but does not publish newer native bytes',async()=>{
  const calls=[];let releaseFirst;
  const hash=await R.digest(new Uint8Array([1]));
  const client={state:{resourceId:'res_1',maxBytes:R.MAX_BYTES},async request(method,args){
    calls.push({method,args});
    if(method==='replace') return new Promise(resolve=>releaseFirst=()=>resolve({resourceId:'res_1',contentRevision:'rev_2',byteLength:1}));
    if(method==='checkpoint') return {resourceId:'res_1',contentRevision:'rev_2',byteLength:1,exportSafety:{contentSha256:hash}};
    if(method==='prepareDiscard') return {quiesced:true,contentRevision:'rev_2',metadataRevision:5};
    throw new Error('Unexpected method');
  }};
  const queue=new R.SaveQueue(client,'rev_1');queue.record(new Uint8Array([1]));
  const saving=queue.flush();while(!releaseFirst) await next();
  queue.record(new Uint8Array([2]));
  const discard=new R.DiscardCoordinator(client,{queue:()=>queue,quiesce(){},resume(){},dirty:()=>queue.dirty});
  const preparing=discard.prepare();await next();
  assert.equal(discard.active,true);assert.deepEqual(calls.map(c=>c.method),['replace']);
  releaseFirst();await saving;const result=await preparing;
  assert.equal(result.contentRevision,'rev_2');assert.equal(result.dirty,true);
  assert.deepEqual(calls.map(c=>c.method),['replace','checkpoint','prepareDiscard']);
  assert.deepEqual([...queue.latest],[2]);assert.equal(queue.pending,null);
});

test('unknown replacement or discard acknowledgement refuses purge and retains the barrier and bytes',async()=>{
  for(const failure of ['replace','prepareDiscard']){
    const calls=[];
    const client={state:{resourceId:'res_1',maxBytes:R.MAX_BYTES},async request(method){
      calls.push(method);
      throw R.error('LOCAL_RESOURCE_SESSION_RESULT_UNKNOWN','unknown');
    }};
    const queue=new R.SaveQueue(client,'rev_1');
    if(failure==='replace'){
      queue.record(new Uint8Array([4,5]));await assert.rejects(queue.flush(),/unknown/);
    }
    const pending=queue.pending;
    const discard=new R.DiscardCoordinator(client,{queue:()=>queue,quiesce(){},resume(){throw new Error('must not resume');},dirty:()=>queue.dirty});
    await assert.rejects(discard.prepare(),/unknown/);
    assert.equal(discard.active,true);assert.equal(discard.barrier.receipt,null);
    if(pending){assert.equal(queue.pending,pending);assert.deepEqual([...pending.bytes],[4,5]);assert.ok(!calls.includes('prepareDiscard'));}
    await assert.rejects(discard.resumeAfterFailure(),/unknown/);
    assert.equal(discard.active,true);
  }
});

test('discard rejects changed revision, malformed acknowledgement and unrequested resume',async()=>{
  for(const result of [{quiesced:false,contentRevision:'rev_1',metadataRevision:1},
    {quiesced:true,contentRevision:'other',metadataRevision:1},{quiesced:true,contentRevision:'rev_1',metadataRevision:0},
    {quiesced:true,contentRevision:'rev_1',metadataRevision:-1}]){
    const client={state:{resourceId:'res_1'},async request(){return result;}};
    const discard=new R.DiscardCoordinator(client,{queue:()=>({revision:'rev_1'}),quiesce(){},resume(){},dirty:()=>true});
    await assert.rejects(discard.resumeAfterFailure(),/No paused/);
    await assert.rejects(discard.prepare(),/paused safely/);assert.equal(discard.active,true);
  }
});

test('actual guest control wire holds input and host save hooks until explicit scoped resume',async()=>{
  const events=new Map(),source={},ui=new MessageChannel(),resource=new MessageChannel();
  const replies=[],operations=[];let sequence=1,resumeResponse;
  ui.port2.on('message',m=>replies.push(m));
  resource.port2.on('message',m=>{
    operations.push(m.method);
    const respond=result=>resource.port2.postMessage({kind:'response',protocol:'bosonoo.local-resource-session',version:2,
      instanceId:instance,sequence:++sequence,requestId:m.requestId,ok:true,result});
    if(m.method==='prepareDiscard') respond({quiesced:true,contentRevision:'rev_1',metadataRevision:9});
    else if(m.method==='resumeAfterDiscardFailure') resumeResponse=()=>respond({resumed:true});
    else throw new Error('Discard must not dispatch a save');
  });
  const context={URL,URLSearchParams,Map,Set,Object,Array,Uint8Array,ArrayBuffer,Promise,Number,
    setTimeout:()=>1,clearTimeout(){},setInterval(){},clearInterval(){},
    location:{hash:fragment,origin,pathname:'/engine-packs/blender-guest/a/guest.html'},history:{replaceState(){}},
    document:{readyState:'loading',addEventListener(){},getElementById(){return null;}}};
  context.window={bosonooGuestPrimitives:H,bosonooGuestResource:R,parent:source,
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:()=>{}};
  vm.runInNewContext(fs.readFileSync(new URL('../pack/blender/guest.js',import.meta.url),'utf8'),context);
  try{
    events.get('message')({source,origin:parent,ports:[ui.port1,resource.port1],
      data:{type:'bosonoo:guest-blender:init',version:1,instanceId:instance,nonce}});
    resource.port2.postMessage({kind:'ready',protocol:'bosonoo.local-resource-session',version:2,
      instanceId:instance,sequence:1,state:{editorKind:'engine',mode:'read-write',resourceId:'res_1',readOnly:false,maxBytes:R.MAX_BYTES}});
    const request=(action,n)=>ui.port2.postMessage({type:'bosonoo:guest-blender:action',version:1,
      instanceId:instance,sequence:n,requestId:'gbr_'+String(n).repeat(32),action});
    request('prepareDiscard',1);
    for(let i=0;i<20&&!replies.some(m=>m.type.endsWith(':response'));i++)await next();
    const prepared=replies.find(m=>m.type.endsWith(':response'));
    assert.equal(prepared.ok,true);assert.equal(prepared.result.canDiscard,true);
    assert.equal(prepared.result.contentRevision,'rev_1');assert.equal(prepared.result.metadataRevision,9);
    assert.equal(replies.filter(m=>m.type.endsWith(':state')).at(-1).state.phase,'discarding');
    let blocked=0;const key={preventDefault(){blocked++;},stopImmediatePropagation(){blocked++;}};
    events.get('keydown')(key);assert.equal(blocked,2);
    assert.equal(context.window.__blenderSaveHook(),false);await next();assert.deepEqual(operations,['prepareDiscard']);
    request('resumeAfterDiscardFailure',2);while(!resumeResponse)await next();
    events.get('keydown')(key);assert.equal(blocked,4);
    resumeResponse();for(let i=0;i<20&&replies.filter(m=>m.type.endsWith(':response')).length<2;i++)await next();
    const resumed=replies.filter(m=>m.type.endsWith(':response')).at(-1);
    assert.equal(resumed.result.resumed,true);assert.equal(resumed.result.discardId,prepared.result.discardId);
    assert.equal(resumed.result.resourceId,'res_1');
    events.get('keydown')(key);assert.equal(blocked,4,'input must resume only after the broker acknowledgement');
    assert.deepEqual(operations,['prepareDiscard','resumeAfterDiscardFailure']);
  }finally{ui.port1.close();ui.port2.close();resource.port1.close();resource.port2.close();}
});
