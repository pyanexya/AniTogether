export const now = () => Math.floor(Date.now() / 1000);
export class HttpError extends Error { constructor(status, code) { super(code); this.status = status; } }
export const fail = (status, code) => { throw new HttpError(status, code); };
export const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const hash = async value => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
export const cookie = (request, name) => request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1) || '';
export const setCookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers} });
export function origin(env) { try { const u = new URL(env.APP_ORIGIN); if(u.protocol !== 'https:' || u.origin !== env.APP_ORIGIN) throw 0; return u.origin; } catch { fail(503,'origin_not_configured'); } }
export function sameOrigin(req, env) { if(req.headers.get('Origin') !== origin(env)) fail(403,'origin_required'); }
export async function body(req) {
 if(!req.headers.get('Content-Type')?.startsWith('application/json')) fail(415,'json_required');
 const reader=req.body?.getReader(); if(!reader) fail(400,'body_required'); let total=0; const chunks=[];
 while(true) { const {value,done}=await reader.read(); if(done)break; total+=value.length; if(total>8192){await reader.cancel();fail(413,'body_too_large');} chunks.push(value); }
 try { const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(x=>Array.from(x))))); if(!data || typeof data!=='object' || Array.isArray(data))throw 0; return data; }catch{fail(400,'invalid_json');}
}
export async function rate(req,env,scope,limit=30) {
 const key=await hash(`${scope}:${req.headers.get('CF-Connecting-IP') || 'local'}`); const t=now();
 const row=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count').bind(key,t+60,t,t).first();
 if(row.count>limit) fail(429,'rate_limited');
}
export async function session(req,env,required=true) {
 const bearer=req.headers.get('Authorization'); const raw=bearer ? (/^Bearer ([A-Za-z0-9_-]{43})$/.exec(bearer)?.[1] || '') : cookie(req,'__Host-anixartix');
 const row=raw && await env.DB.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').bind(await hash(raw),now()).first();
 if(!row && required)fail(401,'authentication_required'); return row ? {...row,bearer:!!bearer} : null;
}
export function csrf(req,env,s) { if(!s.bearer) {sameOrigin(req,env); if(req.headers.get('X-CSRF-Token')!==s.csrf)fail(403,'csrf_required');} }
export async function newSession(env,userId) {
 const token=random(), csrfToken=random(), t=now();
 await env.DB.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),userId,csrfToken,t+2592000,t).run();
 return {token,csrf:csrfToken,expires:t+2592000};
}
export function publicProfile(row) { return {id:row.id,username:row.username,displayName:row.display_name,bio:row.bio,avatar:row.avatar}; }
export function validateProfile(data) {
 if(Object.keys(data).some(k=>!['username','displayName','bio','avatar'].includes(k)))fail(400,'unknown_field');
 const out={}; for(const [k,v] of Object.entries(data)) { if(typeof v!=='string')fail(400,'invalid_profile'); const s=v.trim();
 if(k==='username'&&!/^[a-zA-Z0-9_]{3,24}$/.test(s))fail(400,'invalid_username');
 if(k==='displayName'&&(s.length<1||s.length>64))fail(400,'invalid_display_name');
 if(k==='bio'&&s.length>500)fail(400,'invalid_bio');
 // Avatars are built-in identifiers, not arbitrary tracking URLs or uploaded SVG.
 if(k==='avatar'&&!/^(|cat|moon|star|sakura|fox)$/.test(s))fail(400,'invalid_avatar');
 if(/[\u0000-\u001f\u007f]/.test(s))fail(400,'invalid_profile'); out[k]=s;
 } return out;
}
async function encryptionKey(env) { try { const bytes=Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY),c=>c.charCodeAt(0)); if(bytes.length!==32)throw 0; return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']); } catch {fail(503,'token_encryption_not_configured');} }
export async function encrypt(env,userId,value) { const iv=crypto.getRandomValues(new Uint8Array(12)); const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`shikimori:${userId}`)},await encryptionKey(env),new TextEncoder().encode(JSON.stringify(value))); return JSON.stringify({v:1,iv:Array.from(iv),data:Array.from(new Uint8Array(data))}); }
export async function decrypt(env,userId,value) { const v=JSON.parse(value); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(v.iv),additionalData:new TextEncoder().encode(`shikimori:${userId}`)},await encryptionKey(env),Uint8Array.from(v.data)))); }
