import {now,random,json,body,rate,publicProfile,fail} from './security.mjs';
import {isRoomId,isToken} from '../../src/shared/watch-together/protocol.mjs';
export const FRIEND_LIMIT = 100, INVITE_LIMIT = 20, INVITE_TTL = 300;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const pair = (a,b) => a < b ? [a,b] : [b,a];
const fields = (d, names) => {if(Object.keys(d).some(k=>!names.includes(k)))fail(400,'unknown_field');};
const edge = 'SELECT 1 FROM friends WHERE low_id=? AND high_id=? AND status=\'accepted\'';
export async function friendsRoute(req,env,s) {
 const url=new URL(req.url), p=url.pathname, m=req.method, user=s.user_id, t=now();
 if(!p.startsWith('/api/friends')&&!p.startsWith('/api/watch-invites'))return null;
 await rate(req,env,'friends-user',120,user);
 if(!['GET','HEAD'].includes(m))await rate(req,env,'friends-write',20,user);
 if(p==='/api/friends/lookup'&&m==='GET') {
  await rate(req,env,'friends-lookup',10,user);
  const username=url.searchParams.get('username');if(!/^[A-Za-z0-9_]{3,24}$/.test(username||'')||[...url.searchParams.keys()].some(k=>k!=='username'))fail(400,'invalid_username');
  const row=await env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').bind(username).first();if(!row)fail(404,'profile_not_found');return json({profile:publicProfile(row)});
 }
 if(p==='/api/friends'&&m==='GET') {
  const rows=await env.DB.prepare('SELECT f.id AS relation_id,f.sender_id,f.status,f.created_at,u.* FROM friends f JOIN users u ON u.id=CASE WHEN f.low_id=? THEN f.high_id ELSE f.low_id END WHERE f.low_id=? OR f.high_id=? ORDER BY f.created_at DESC LIMIT 100').bind(user,user,user).all();
  const result={friends:[],incoming:[],outgoing:[]};for(const r of rows.results){const profile=publicProfile(r);if(r.status==='accepted')result.friends.push(profile);else result[r.sender_id===user?'outgoing':'incoming'].push({id:r.relation_id,profile,createdAt:r.created_at});}return json(result);
 }
 if(p==='/api/friends/requests'&&m==='POST') {
  const d=await body(req);fields(d,['userId']);if(!id(d.userId)||d.userId===user)fail(400,'invalid_recipient');const [low,high]=pair(user,d.userId),rid=random();
  const target=await env.DB.prepare('SELECT 1 AS ok FROM users WHERE id=?').bind(d.userId).first();if(!target)fail(404,'profile_not_found');
  const row=await env.DB.prepare(`INSERT INTO friends(id,low_id,high_id,sender_id,status,created_at) SELECT ?,?,?,?,'pending',? WHERE (SELECT count(*) FROM friends WHERE low_id=? OR high_id=?)<? AND (SELECT count(*) FROM friends WHERE low_id=? OR high_id=?)<? ON CONFLICT(low_id,high_id) DO NOTHING RETURNING id`).bind(rid,low,high,user,t,user,user,FRIEND_LIMIT,d.userId,d.userId,FRIEND_LIMIT).first();
  if(!row)fail(409,'friend_request_exists_or_limit');return json({id:row.id},201);
 }
 const request=/^\/api\/friends\/requests\/([A-Za-z0-9_-]{43})\/(accept|reject)$/.exec(p);
 if(request&&m==='POST') {
  const [,rid,action]=request;
  const query=action==='accept'?"UPDATE friends SET status='accepted' WHERE id=? AND sender_id<>? AND (low_id=? OR high_id=?) AND status='pending' RETURNING id":"DELETE FROM friends WHERE id=? AND sender_id<>? AND (low_id=? OR high_id=?) AND status='pending' RETURNING id";
  const row=await env.DB.prepare(query).bind(rid,user,user,user).first();if(!row)fail(404,'friend_request_not_found');return json({ok:true});
 }
 const remove=/^\/api\/friends\/([A-Za-z0-9_-]{1,128})$/.exec(p);
 if(remove&&m==='DELETE') {
  const [low,high]=pair(user,remove[1]);
  const results=await env.DB.batch([
   env.DB.prepare('DELETE FROM friends WHERE low_id=? AND high_id=?').bind(low,high),
   env.DB.prepare('DELETE FROM watch_invites WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)').bind(user,remove[1],remove[1],user)
  ]);if(!results[0].meta.changes)fail(404,'friend_not_found');return json({ok:true});
 }
 if(p==='/api/watch-invites'&&m==='GET') {
  const rows=await env.DB.prepare(`SELECT w.id AS invitation_id,w.created_at,w.expires,u.* FROM watch_invites w JOIN users u ON u.id=w.sender_id WHERE w.recipient_id=? AND w.expires>? AND EXISTS(SELECT 1 FROM friends f WHERE f.low_id=min(w.sender_id,w.recipient_id) AND f.high_id=max(w.sender_id,w.recipient_id) AND f.status='accepted') ORDER BY w.created_at DESC LIMIT 20`).bind(user,t).all();
  return json({invites:rows.results.map(r=>({id:r.invitation_id,sender:publicProfile(r),createdAt:r.created_at,expiresAt:r.expires}))});
 }
 if(p==='/api/watch-invites'&&m==='POST') {
  await rate(req,env,'watch-invite-send',6,user);const d=await body(req);fields(d,['recipientId','roomId','hostToken']);
  if(!id(d.recipientId)||d.recipientId===user||!isRoomId(d.roomId)||!isToken(d.hostToken))fail(400,'invalid_invite');
  const [low,high]=pair(user,d.recipientId);if(!await env.DB.prepare(edge).bind(low,high).first())fail(403,'accepted_friend_required');
  if(!env.ROOMS)fail(503,'rooms_unavailable');
  // This endpoint is only reachable through the DO binding, never public routing.
  // Host resume proof is validated by the room owner and never persisted in D1.
  const proof=await env.ROOMS.get(env.ROOMS.idFromName('anixartix-rooms-v1')).fetch(new Request('https://rooms.internal/internal/friend-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:d.roomId,hostToken:d.hostToken})}));
  if(!proof.ok)fail(409,'room_unavailable');const capability=await proof.json();
  const rid=random(),expires=t+INVITE_TTL;
  const result=await env.DB.batch([
   env.DB.prepare('DELETE FROM watch_invites WHERE expires<=? AND (sender_id=? OR recipient_id=?)').bind(t,user,d.recipientId),
   env.DB.prepare(`INSERT INTO watch_invites(id,sender_id,recipient_id,room_id,invite_token,created_at,expires) SELECT ?,?,?,?,?,?,? WHERE EXISTS(${edge}) AND (SELECT count(*) FROM watch_invites WHERE sender_id=? AND expires>?)<? AND (SELECT count(*) FROM watch_invites WHERE recipient_id=? AND expires>?)<? AND NOT EXISTS(SELECT 1 FROM watch_invites WHERE sender_id=? AND recipient_id=? AND room_id=? AND expires>?)`).bind(rid,user,d.recipientId,d.roomId,capability.inviteToken,t,expires,low,high,user,t,INVITE_LIMIT,d.recipientId,t,INVITE_LIMIT,user,d.recipientId,d.roomId,t)
  ]);if(!result[1].meta.changes)fail(409,'invite_exists_or_limit');return json({id:rid,expiresAt:expires},201);
 }
 const invitation=/^\/api\/watch-invites\/([A-Za-z0-9_-]{43})\/(accept|decline)$/.exec(p);
 if(invitation&&m==='POST') {
  const [,rid,action]=invitation;
  // DELETE RETURNING is atomic: simultaneous accepts cannot disclose twice.
  const row=await env.DB.prepare(`DELETE FROM watch_invites WHERE id=? AND recipient_id=? AND expires>? AND EXISTS(SELECT 1 FROM friends f WHERE f.low_id=min(watch_invites.sender_id,watch_invites.recipient_id) AND f.high_id=max(watch_invites.sender_id,watch_invites.recipient_id) AND f.status='accepted') RETURNING room_id,invite_token`).bind(rid,user,t).first();
  if(!row)fail(404,'invite_not_found');return json(action==='accept'?{serverUrl:'wss://aniartix.pyanexy.cc/watch',roomId:row.room_id,inviteToken:row.invite_token}:{ok:true});
 }
 fail(404,'not_found');
}
