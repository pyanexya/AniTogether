import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchRooms, ROOM_LIMITS } from '../src/rooms.mjs';
const media = { releaseId: 10, episodePosition: 2, sourceId: 3, dubberId: 4 };
class Socket {
  constructor(id) { this.a = { id, clientKey: 'A'.repeat(43), count: 0, start: Date.now(), last: Date.now(), connected: Date.now(), joined: false }; this.messages = []; }
  serializeAttachment(a) { this.a = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.a); }
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close(code) { this.closed = code; }
  last(type) { return this.messages.filter(m => m.type === type).at(-1); }
}
function context() {
  const data = new Map(); let alarm = null;
  const storage = { async list({prefix}) { return structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)))); }, async put(k,v) { data.set(k, structuredClone(v)); }, async delete(k) { data.delete(k); }, async transaction(fn) { return fn(storage); }, async setAlarm(t) { alarm=t; }, async getAlarm() { return alarm; }, async deleteAlarm() { alarm=null; } };
  return { data, storage, sockets: [], getWebSockets() { return this.sockets.filter(s => !s.closed); }, blockConcurrencyWhile(fn) { this.pending = fn(); return this.pending; } };
}
async function setup() { const ctx=context(); const relay=new WatchRooms(ctx, {}); await ctx.pending; return { ctx, relay }; }
function socket(ctx, relay, id) { const s=new Socket(id); ctx.sockets.push(s); relay.sockets.set(id,s); return s; }
async function send(relay, socket, msg) { await relay.webSocketMessage(socket, JSON.stringify({ v:1, ...msg })); }
async function create(relay, host) { await send(relay, host, { type:'create', name:'Host', media }); return host.last('welcome'); }
async function restore(ctx) { const relay=new WatchRooms(ctx, {}); await ctx.pending; return relay; }
test('native create/join/control, host authority and durable sequence before acknowledgement', async () => {
  const {ctx,relay}=await setup(); const host=socket(ctx,relay,'h'), guest=socket(ctx,relay,'g'); const w=await create(relay,host);
  await send(relay,guest,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken,name:'Guest'});
  assert.equal(guest.last('welcome').role,'guest'); assert.equal(guest.last('welcome').inviteToken,undefined);
  const command={type:'control',epoch:w.state.epoch,commandSequence:1,state:{media,position:42,paused:false,buffering:false,rate:1}};
  await send(relay,guest,command); assert.equal(guest.last('error').code,'HOST_ONLY');
  host.send = raw => { const message=JSON.parse(raw); if(message.type==='state') assert.equal(ctx.data.get(`room:${w.roomId}`).state.sequence,message.state.sequence); host.messages.push(message); };
  await send(relay,host,command); assert.equal(guest.last('state').state.position,42);
  await send(relay,host,command); assert.equal(host.last('error').code,'STALE_COMMAND');
  await send(relay,guest,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken}); assert.equal(guest.last('error').code,'ALREADY_JOINED');
});
test('hibernation reconstruction keeps sockets, tokens, command sequence and rate counters', async () => {
  let {ctx,relay}=await setup(); const host=socket(ctx,relay,'h'); const w=await create(relay,host);
  for(let i=0;i<79;i++) await send(relay,host,{type:'ping',sentAt:i});
  relay=await restore(ctx); assert.equal(relay.rooms.get(w.roomId).state.hostOnline,true);
  await send(relay,host,{type:'snapshot'}); assert.equal(host.last('error').code,'RATE_LIMITED');
  for(let i=0;i<3;i++) await send(relay,host,{type:'snapshot'});
  assert.equal(host.closed,1008); assert.equal(ctx.data.get(`room:${w.roomId}`).state.hostOnline,false);
});
test('full restart pauses absent host and resume preserves membership and stale-command defense', async () => {
  let {ctx,relay}=await setup(); const host=socket(ctx,relay,'h'); const w=await create(relay,host);
  await send(relay,host,{type:'control',epoch:w.state.epoch,commandSequence:7,state:{media,position:30,paused:false,buffering:false,rate:1}});
  ctx.sockets=[]; relay=await restore(ctx);
  assert.equal(relay.rooms.get(w.roomId).state.paused,true);
  const resumed=socket(ctx,relay,'new'); await send(relay,resumed,{type:'resume',roomId:w.roomId,memberToken:w.memberToken});
  assert.equal(resumed.last('welcome').commandSequence,7); assert.equal(resumed.last('welcome').memberToken,w.memberToken);
  assert.equal(resumed.last('welcome').state.hostOnline,true); assert.equal(resumed.last('welcome').state.paused,true);
});
test('replaced socket cannot control or disconnect replacement; explicit host leave closes room', async () => {
  const {ctx,relay}=await setup(); const host=socket(ctx,relay,'h'); const w=await create(relay,host); const replacement=socket(ctx,relay,'r');
  await send(relay,replacement,{type:'resume',roomId:w.roomId,memberToken:w.memberToken}); assert.equal(host.last('replaced').type,'replaced');
  await send(relay,host,{type:'snapshot'}); assert.equal(host.last('error').code,'NOT_JOINED');
  await relay.webSocketClose(host,1000); assert.equal(relay.rooms.get(w.roomId).state.hostOnline,true);
  await send(relay,replacement,{type:'leave'}); assert.equal([...ctx.data.keys()].filter(k=>k.startsWith('room:')).length,0);
});
test('expiry happens before join; disconnected guest capacity reclaimed; room capacity enforced', async () => {
  const {ctx,relay}=await setup(); const host=socket(ctx,relay,'h'); const w=await create(relay,host);
  for(let i=0;i<7;i++) {const g=socket(ctx,relay,`g${i}`); await send(relay,g,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken});}
  const extra=socket(ctx,relay,'extra'); await send(relay,extra,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken}); assert.equal(extra.last('error').code,'ROOM_FULL');
  await relay.webSocketClose(ctx.sockets[1],1000); relay.rooms.get(w.roomId).members[1].disconnectedAt=Date.now()-ROOM_LIMITS.reconnect-1;
  await send(relay,extra,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken}); assert.equal(extra.last('welcome').role,'guest');
  relay.rooms.get(w.roomId).created=Date.now()-ROOM_LIMITS.age-1;
  const late=socket(ctx,relay,'late'); await send(relay,late,{type:'join',roomId:w.roomId,inviteToken:w.inviteToken}); assert.equal(late.last('error').code,'ROOM_UNAVAILABLE'); assert.equal([...ctx.data.keys()].filter(k=>k.startsWith('room:')).length,0);
});
test('invalid frames are bounded and unknown fields do not forward media URLs', async () => {
  const {ctx,relay}=await setup(); const s=socket(ctx,relay,'s'); await relay.webSocketMessage(s,new ArrayBuffer(1)); assert.equal(s.closed,1003);
  const big=socket(ctx,relay,'big'); await relay.webSocketMessage(big,'я'.repeat(2100)); assert.equal(big.closed,1009);
  const host=socket(ctx,relay,'h'); await send(relay,host,{type:'create',media:{...media,url:'https://secret.invalid'},token:'secret'});
  assert.equal(JSON.stringify([...ctx.data.values()]).includes('secret'),false);
  const malformed=socket(ctx,relay,'bad'); await send(relay,malformed,{type:'create',media:{...media,sourceId:0}}); assert.equal(malformed.last('error').code,'INVALID_MESSAGE');
});
test('rate limiting cannot be reset with leave/create or reconstruction; idle handshake closes', async () => {
  let {ctx,relay}=await setup(); const s=socket(ctx,relay,'s'); await create(relay,s); await send(relay,s,{type:'leave'}); relay=await restore(ctx);
  assert.equal(s.deserializeAttachment().count,2);
  const idle=socket(ctx,relay,'idle'); idle.a.connected=Date.now()-ROOM_LIMITS.handshake-1; await relay.alarm(); assert.equal(idle.closed,1008);
});
test('client create quota survives disconnect/reconnect, actor restoration and leave; expires and bounds records', async () => {
  let {ctx,relay}=await setup();
  for(let i=0;i<8;i++) {const s=socket(ctx,relay,`host${i}`);await create(relay,s);assert.ok(s.last('welcome'));await send(relay,s,{type:'leave'});await relay.webSocketClose(s,1000);}
  relay=await restore(ctx);const extra=socket(ctx,relay,'extra');await create(relay,extra);assert.equal(extra.last('error').code,'RATE_LIMITED');
  const q=relay.quotas.get('A'.repeat(43));assert.equal(q.creates,8);q.expires=Date.now()-1;
  await relay.alarm();assert.equal(relay.quotas.size,0);assert.equal([...ctx.data.keys()].filter(k=>k.startsWith('quota:')).length,0);
  await create(relay,extra);assert.ok(extra.last('welcome'));
  for(let i=0;i<2048;i++){const key=String(i).padStart(43,'0');relay.quotas.set(key,{key,opens:1,creates:0,expires:Date.now()+3600000});}
  assert.equal(relay.quota('Z'.repeat(43),'opens',128),false);
});
test('client open quota is durable and independently bounds reconnection churn',async()=>{
  let {ctx,relay}=await setup();const key='Q'.repeat(43);
  await relay.event(()=>{for(let i=0;i<128;i++)assert.equal(relay.quota(key,'opens',128),true);});
  relay=await restore(ctx);await relay.event(()=>assert.equal(relay.quota(key,'opens',128),false));
  assert.equal(ctx.data.get(`quota:${key}`).opens,128);
});
