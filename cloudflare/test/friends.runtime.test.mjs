// Real workerd, D1 and SQLite DO integration: no database/relay mocks.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {hash,random} from '../src/security.mjs';
import worker from '../src/index.mjs';
const origin='https://aniartix.pyanexy.cc';
const media={releaseId:10,episodePosition:2,sourceId:3,dubberId:4};
async function setup({social=true}={}){
 const bundle=await build({entryPoints:[new URL('../src/index.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',bindings:{APP_ORIGIN:origin},d1Databases:['DB'],durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
 const db=await mf.getD1Database('DB'),sockets=[],users={},t=Math.floor(Date.now()/1000);
 for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')&&(social||x==='0001_auth.sql')).sort())for(const sql of (await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 for(const id of ['alice','bob','carol']){
  const token=random(),csrf=random();users[id]={token,csrf};
  await db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind(id,id+'_nick',id,t).run();
  await db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),id,csrf,t+3600,t).run();
 }
 const call=(user,path,method='GET',data,extra={})=>mf.dispatchFetch(origin+path,{method,headers:{...(user?{Authorization:'Bearer '+users[user].token}:{}),...(data?{'Content-Type':'application/json'}:{}),...extra},...(data?{body:JSON.stringify(data)}:{})});
 const clearRates=()=>db.prepare('DELETE FROM rate_limits').run();
 async function connect(){
  const r=await mf.dispatchFetch(origin+'/watch',{headers:{Upgrade:'websocket',Origin:'http://tauri.localhost','CF-Connecting-IP':'192.0.2.1'}});assert.equal(r.status,101);
  const ws=r.webSocket,messages=[],pending=[];sockets.push(ws);
  ws.addEventListener('message',e=>{const msg=JSON.parse(e.data);messages.push(msg);for(const p of [...pending])if(p.pred(msg)){clearTimeout(p.timer);pending.splice(pending.indexOf(p),1);p.resolve(msg);}});ws.accept();
  return {send(msg){ws.send(JSON.stringify({v:1,...msg}));},wait(pred){const found=messages.find(pred);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const p={pred,resolve,timer:setTimeout(()=>reject(new Error('WebSocket timeout')),10000)};pending.push(p);});}};
 }
 async function befriend(){const r=await call('alice','/api/friends/requests','POST',{userId:'bob'});assert.equal(r.status,201);const {id}=await r.json();assert.equal((await call('bob',`/api/friends/requests/${id}/accept`,'POST',{})).status,200);}
 return {mf,db,users,t,call,clearRates,connect,befriend,async close(){for(const ws of sockets)try{ws.close();}catch{}await mf.dispose();}};
}
const denied=r=>assert.ok([400,403,404,409,410,429].includes(r.status),`unexpected status ${r.status}`);
test('workerd D1 friends: exact lookup, recipient-only acceptance, CSRF, duplicate races and removal',async()=>{
 const h=await setup();const {call,users}=h;
 try{
  assert.equal((await call(null,'/api/friends')).status,401);
  const found=await call('alice','/api/friends/lookup?username=BOB_nick');assert.equal(found.status,200);assert.equal((await found.json()).profile.id,'bob');
  denied(await call('alice','/api/friends/lookup?username=bob'));denied(await call('alice','/api/friends/lookup?username=%25'));denied(await call('alice','/api/friends/lookup'));
  denied(await call('alice','/api/friends/requests','POST',{userId:'alice'}));
  const cookie={Cookie:'__Host-anixartix='+users.alice.token,Origin:origin};assert.equal((await call(null,'/api/friends/requests','POST',{userId:'bob'},cookie)).status,403);
  const races=await Promise.all([call('alice','/api/friends/requests','POST',{userId:'bob'}),call('alice','/api/friends/requests','POST',{userId:'bob'})]);assert.equal(races.filter(r=>r.status===201).length,1);denied(races.find(r=>r.status!==201));
  const {id}=await races.find(r=>r.status===201).json();
  const incoming=await (await call('bob','/api/friends')).json();assert.equal(incoming.incoming.length,1);assert.equal(incoming.incoming[0].profile.id,'alice');
  assert.equal((await (await call('alice','/api/friends')).json()).outgoing[0].id,id);assert.deepEqual((await (await call('carol','/api/friends')).json()).incoming,[]);
  denied(await call('alice',`/api/friends/requests/${id}/accept`,'POST',{}));denied(await call('carol',`/api/friends/requests/${id}/accept`,'POST',{}));
  const accepts=await Promise.all([call('bob',`/api/friends/requests/${id}/accept`,'POST',{}),call('bob',`/api/friends/requests/${id}/accept`,'POST',{})]);assert.equal(accepts.filter(r=>r.status===200).length,1);
  const friends=await (await call('alice','/api/friends')).json();assert.equal(friends.friends[0].id,'bob');assert.equal(friends.incoming.length,0);assert.equal(friends.outgoing.length,0);
  denied(await call('carol','/api/friends/bob','DELETE'));
  assert.equal((await call('alice','/api/friends/bob','DELETE')).status,200);assert.deepEqual((await (await call('bob','/api/friends')).json()).friends,[]);
  const request=await (await call('bob','/api/friends/requests','POST',{userId:'alice'})).json();
  denied(await call('carol',`/api/friends/requests/${request.id}/reject`,'POST',{}));assert.equal((await call('alice',`/api/friends/requests/${request.id}/reject`,'POST',{})).status,200);
  assert.deepEqual((await (await call('bob','/api/friends')).json()).outgoing,[]);
 }finally{await h.close();}
});
test('workerd D1/DO invites: host proof, private recipient inbox, single-use races, expiry and unfriending',async()=>{
 const h=await setup();const {call,db}=h;
 try{
  await h.befriend();const host=await h.connect();host.send({type:'create',name:'Alice',media});const room=await host.wait(m=>m.type==='welcome');
  const payload={recipientId:'bob',roomId:room.roomId,hostToken:room.memberToken};
  assert.equal((await call('alice','/internal/friend-invite','POST',{roomId:room.roomId,hostToken:room.memberToken})).status,404);
  denied(await call('alice','/api/watch-invites','POST',{...payload,serverUrl:'wss://evil.invalid/watch'}));
  denied(await call('alice','/api/watch-invites','POST',{...payload,recipientId:'carol'}));
  denied(await call('alice','/api/watch-invites','POST',{...payload,hostToken:room.inviteToken}));
  denied(await call('alice','/api/watch-invites','POST',{...payload,hostToken:'0'.repeat(48)}));
  const create=async()=>{await h.clearRates();const r=await call('alice','/api/watch-invites','POST',payload);assert.equal(r.status,201);return r.json();};
  const before=Math.floor(Date.now()/1000),invite=await create();assert.ok(invite.id);assert.ok(invite.expiresAt>=before+300&&invite.expiresAt<=Math.floor(Date.now()/1000)+300);
  assert.deepEqual((await (await call('alice','/api/watch-invites')).json()).invites,[]);assert.deepEqual((await (await call('carol','/api/watch-invites')).json()).invites,[]);
  const stored=await db.prepare('SELECT * FROM watch_invites WHERE id=?').bind(invite.id).first();assert.ok(!JSON.stringify(stored).includes(room.memberToken));
  const inbox=await (await call('bob','/api/watch-invites')).json();assert.equal(inbox.invites[0].sender.id,'alice');const raw=JSON.stringify(inbox);assert.ok(!raw.includes(room.memberToken));assert.ok(!raw.includes(room.inviteToken));assert.ok(!raw.includes(room.roomId));
  denied(await call('alice',`/api/watch-invites/${invite.id}/accept`,'POST',{}));denied(await call('carol',`/api/watch-invites/${invite.id}/decline`,'POST',{}));
  const accepts=await Promise.all([call('bob',`/api/watch-invites/${invite.id}/accept`,'POST',{}),call('bob',`/api/watch-invites/${invite.id}/accept`,'POST',{})]);assert.equal(accepts.filter(r=>r.status===200).length,1);denied(accepts.find(r=>r.status!==200));
  const granted=await accepts.find(r=>r.status===200).json();assert.deepEqual(granted,{serverUrl:'wss://aniartix.pyanexy.cc/watch',roomId:room.roomId,inviteToken:room.inviteToken});assert.ok(!JSON.stringify(granted).includes(room.memberToken));
  const guest=await h.connect();guest.send({type:'join',name:'Bob',roomId:granted.roomId,inviteToken:granted.inviteToken});const guestWelcome=await guest.wait(m=>m.type==='welcome');assert.equal(guestWelcome.role,'guest');
  denied(await call('bob','/api/watch-invites','POST',{recipientId:'alice',roomId:room.roomId,hostToken:guestWelcome.memberToken}));
  assert.equal(guestWelcome.inviteToken,undefined);
  const expired=await create();await db.prepare('UPDATE watch_invites SET expires=? WHERE id=?').bind(h.t-1,expired.id).run();denied(await call('bob',`/api/watch-invites/${expired.id}/accept`,'POST',{}));assert.deepEqual((await (await call('bob','/api/watch-invites')).json()).invites,[]);
  const declined=await create();assert.equal((await call('bob',`/api/watch-invites/${declined.id}/decline`,'POST',{})).status,200);denied(await call('bob',`/api/watch-invites/${declined.id}/accept`,'POST',{}));
  const revoked=await create();assert.equal((await call('bob','/api/friends/alice','DELETE')).status,200);denied(await call('bob',`/api/watch-invites/${revoked.id}/accept`,'POST',{}));
 }finally{await h.close();}
});
test('workerd D1 quotas: atomic relationship cap, sender/recipient inbox caps and per-account lookup rate',async()=>{
 const h=await setup();const {call,db,t}=h;
 try{
  // At 99 edges, concurrent requests compete for exactly one remaining slot.
  const inserts=[];
  for(let i=0;i<99;i++){
   const peer=`peer${String(i).padStart(3,'0')}`;
   inserts.push(db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind(peer,peer,peer,t));
   inserts.push(db.prepare("INSERT INTO friends(id,low_id,high_id,sender_id,status,created_at) VALUES(?,?,?,?,'pending',?)").bind(random(),'alice',peer,'alice',t));
  }
  await db.batch(inserts);
  const requests=await Promise.all([call('alice','/api/friends/requests','POST',{userId:'bob'}),call('alice','/api/friends/requests','POST',{userId:'carol'})]);assert.equal(requests.filter(r=>r.status===201).length,1);assert.equal(requests.filter(r=>r.status===409).length,1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM friends WHERE low_id='alice' OR high_id='alice'").first()).n,100);
  await db.prepare('DELETE FROM friends').run();await h.clearRates();await h.befriend();
  const host=await h.connect();host.send({type:'create',name:'Alice',media});const room=await host.wait(m=>m.type==='welcome');
  const payload={recipientId:'bob',roomId:room.roomId,hostToken:room.memberToken};
  const fill=async(sender)=>{await db.batch(Array.from({length:20},(_,i)=>db.prepare('INSERT INTO watch_invites(id,sender_id,recipient_id,room_id,invite_token,created_at,expires) VALUES(?,?,?,?,?,?,?)').bind(random(),sender,'bob',`seed${i}`,'a'.repeat(48),t,t+300)));};
  await fill('alice');assert.equal((await call('alice','/api/watch-invites','POST',payload)).status,409);assert.equal((await db.prepare('SELECT count(*) AS n FROM watch_invites').first()).n,20);
  await db.prepare('DELETE FROM watch_invites').run();await fill('carol');assert.equal((await call('alice','/api/watch-invites','POST',payload)).status,409);
  // Expired records do not permanently occupy quota.
  await db.prepare('UPDATE watch_invites SET expires=?').bind(t-1).run();assert.equal((await call('alice','/api/watch-invites','POST',payload)).status,201);
  await h.clearRates();
  for(let i=0;i<10;i++)assert.equal((await call('alice','/api/friends/lookup?username=bob_nick','GET',null,{'CF-Connecting-IP':`192.0.2.${i+1}`})).status,200);
  assert.equal((await call('alice','/api/friends/lookup?username=bob_nick','GET',null,{'CF-Connecting-IP':'198.51.100.1'})).status,429);
  assert.equal((await call('bob','/api/friends/lookup?username=alice_nick')).status,200);
 }finally{await h.close();}
});

test('unapplied social migration returns explicit unavailable without breaking login/session cleanup',async()=>{
 const h=await setup({social:false});
 try{
  const me=await h.call('alice','/api/me');assert.equal(me.status,200);assert.equal((await me.json()).profile.id,'alice');
  for(const path of ['/api/friends','/api/watch-invites']){const r=await h.call('alice',path);assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'friends_unavailable'});}
  await h.db.prepare('UPDATE sessions SET expires=? WHERE user_id=?').bind(h.t-1,'carol').run();
  await worker.scheduled({}, {DB:h.db});
  assert.equal((await h.db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id='carol'").first()).n,0);
  assert.equal((await h.call('bob','/api/me')).status,200);
 }finally{await h.close();}
});
test('invite creation duplicate races, write/send rate ceilings and user deletion cascade',async()=>{
 const h=await setup();const {call,db}=h;
 try{
  await h.befriend();const host=await h.connect();host.send({type:'create',name:'Alice',media});const room=await host.wait(m=>m.type==='welcome');
  const payload={recipientId:'bob',roomId:room.roomId,hostToken:room.memberToken};
  const sends=await Promise.all([call('alice','/api/watch-invites','POST',payload),call('alice','/api/watch-invites','POST',payload)]);
  assert.deepEqual(sends.map(r=>r.status).sort(),[201,409]);
  for(let i=0;i<4;i++)assert.equal((await call('alice','/api/watch-invites','POST',payload)).status,409);
  assert.equal((await call('alice','/api/watch-invites','POST',payload)).status,429);
  await h.clearRates();
  for(let i=0;i<20;i++)assert.equal((await call('carol','/api/friends/requests','POST',{userId:'carol'})).status,400);
  assert.equal((await call('carol','/api/friends/requests','POST',{userId:'alice'})).status,429);
  await db.prepare("DELETE FROM users WHERE id='bob'").run();
  assert.equal((await db.prepare('SELECT count(*) AS n FROM friends').first()).n,0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM watch_invites').first()).n,0);
 }finally{await h.close();}
});
