// Real workerd WebSocket/SQLite smoke tests (not a live Cloudflare deployment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
const media = { releaseId: 10, episodePosition: 2, sourceId: 3, dubberId: 4 };
const protocol=await readFile(new URL('../../src/shared/watch-together/protocol.mjs',import.meta.url),'utf8');
const rooms=await readFile(new URL('../src/rooms.mjs',import.meta.url),'utf8');
// Inline exactly the existing shared module to avoid requiring a second bundler in tests.
const script=rooms.replace(/^import .* from '..\/..\/src\/shared\/watch-together\/protocol.mjs';$/m,protocol.replaceAll('export ','')).replace('export const ROOM_LIMITS','const ROOM_LIMITS')+`\nexport default {fetch(request,env){return env.ROOMS.get(env.ROOMS.idFromName('anixartix-rooms-v1')).fetch(request)}};`;
assert.notEqual(script,rooms);
function inbox(ws) {
  const messages=[]; const pending=[];
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data); messages.push(m); for(const p of [...pending]) if(p.predicate(m)){pending.splice(pending.indexOf(p),1);clearTimeout(p.timer);p.resolve(m);} });
  return {send(msg){ws.send(JSON.stringify({v:1,...msg}));}, wait(predicate){const existing=messages.find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const p={predicate,resolve,timer:setTimeout(()=>reject(new Error('WebSocket response timeout')),10000)};pending.push(p);});}};
}
async function connect(mf) {const response=await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost','X-AnixArtix-Client-Key':'A'.repeat(43)}});assert.equal(response.status,101); const ws=response.webSocket;const box=inbox(ws);ws.accept();return {ws,...box};}
test('workerd: SQLite DO upgrade, native v1 metadata, resume and host authority',async()=>{
  const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-01',durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
  const sockets=[];
  try {
    const host=await connect(mf);sockets.push(host.ws);host.send({type:'create',name:'Host',media});const w=await host.wait(m=>m.type==='welcome');
    const guest=await connect(mf);sockets.push(guest.ws);guest.send({type:'join',roomId:w.roomId,inviteToken:w.inviteToken,name:'Guest'});const g=await guest.wait(m=>m.type==='welcome');assert.equal(g.role,'guest');
    const state={media,position:17,paused:false,buffering:false,rate:1};guest.send({type:'control',epoch:w.state.epoch,commandSequence:1,state});assert.equal((await guest.wait(m=>m.type==='error')).code,'HOST_ONLY');
    host.send({type:'control',epoch:w.state.epoch,commandSequence:1,state});await guest.wait(m=>m.type==='state'&&m.state.position===17);
    host.ws.close(1000,'Test disconnect');await guest.wait(m=>m.type==='state'&&!m.state.hostOnline);
    const resumed=await connect(mf);sockets.push(resumed.ws);resumed.send({type:'resume',roomId:w.roomId,memberToken:w.memberToken});const rw=await resumed.wait(m=>m.type==='welcome');assert.equal(rw.commandSequence,1);assert.equal(rw.state.paused,true);
    resumed.send({type:'leave'});assert.equal((await guest.wait(m=>m.type==='closed')).reason,'HOST_LEFT');
  } finally {for(const ws of sockets)try{ws.close();}catch{} await mf.dispose();}
});
test('workerd: path/origin guards and text/byte bounds',async()=>{
  const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-01',durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
  try {
    assert.equal((await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch',{headers:{Upgrade:'websocket',Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch?token=x',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost'}})).status,403);
    const {ws}=await connect(mf);const closed=new Promise(resolve=>ws.addEventListener('close',e=>resolve(e.code)));ws.send('x'.repeat(4097));assert.equal(await closed,1009);
  } finally {await mf.dispose();}
});
test('workerd: SQLite room and sequence survive runtime replacement',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'anixartix-room-test-')); const config={modules:true,script,compatibilityDate:'2026-07-01',durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}},durableObjectsPersist:directory};
  let mf=new Miniflare(config);
  try {
    const host=await connect(mf);host.send({type:'create',name:'Host',media});const w=await host.wait(m=>m.type==='welcome');
    host.send({type:'control',epoch:w.state.epoch,commandSequence:12,state:{media,position:81,paused:false,buffering:false,rate:1}});await host.wait(m=>m.type==='state'&&m.state.position===81);
    host.ws.close();await mf.dispose();mf=new Miniflare(config);
    const resumed=await connect(mf);resumed.send({type:'resume',roomId:w.roomId,memberToken:w.memberToken});const rw=await resumed.wait(m=>m.type==='welcome');
    assert.equal(rw.commandSequence,12);assert.equal(rw.memberToken,w.memberToken);assert.equal(rw.state.epoch,w.state.epoch);assert.equal(rw.state.paused,true);resumed.ws.close();
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
test('workerd: per-client socket cap and create quota survive new WebSocket connections',async()=>{
  const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-01',bindings:{ROOM_CLIENT_SOCKETS:'2'},durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
  const sockets=[];
  try {
    const a=await connect(mf),b=await connect(mf);sockets.push(a.ws,b.ws);
    const capped=await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost','X-AnixArtix-Client-Key':'A'.repeat(43)}});assert.equal(capped.status,429);
    const seen=new Set();
    for(let i=0;i<8;i++) {a.send({type:'create',media});await a.wait(m=>m.type==='welcome'&&!seen.has(m.roomId)).then(w=>seen.add(w.roomId));a.send({type:'leave'});}
    b.send({type:'create',media});assert.equal((await b.wait(m=>m.type==='error')).code,'RATE_LIMITED');
    // A different validated ingress client can still create while the first is capped.
    const response=await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost','X-AnixArtix-Client-Key':'B'.repeat(43)}});assert.equal(response.status,101);
    const c=response.webSocket,box=inbox(c);sockets.push(c);c.accept();box.send({type:'create',media});assert.equal((await box.wait(m=>m.type==='welcome')).role,'host');
  } finally {for(const ws of sockets)try{ws.close();}catch{}await mf.dispose();}
});
test('workerd: reconnect upgrade quota survives runtime replacement',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'anixartix-quota-test-')); const config={modules:true,script,compatibilityDate:'2026-07-01',bindings:{ROOM_CLIENT_OPENS_PER_HOUR:'2'},durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}},durableObjectsPersist:directory};
  let mf=new Miniflare(config);
  try {
    const first=await connect(mf);first.ws.close();const second=await connect(mf);second.ws.close();await mf.dispose();mf=new Miniflare(config);
    const denied=await mf.dispatchFetch('https://aniartix.pyanexy.cc/watch',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost','X-AnixArtix-Client-Key':'A'.repeat(43)}});assert.equal(denied.status,429);
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
