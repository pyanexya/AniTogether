import {downloads} from './downloads.mjs';
import {boundedBytes,validatePng,encodeAvatar,avatarResponse} from './avatars.mjs';
import {now,random,hash,setCookie,json,origin,sameOrigin,body,rate,session,csrf,publicProfile,validateProfile,fail,HttpError} from './security.mjs';
import {available,startOAuth,completeOAuth} from './oauth.mjs';
export {WatchRooms} from './rooms.mjs';
export async function route(req,env) {
 const u=new URL(req.url),p=u.pathname,m=req.method;
 if(p==='/health'&&m==='GET')return json({ok:true,service:'AnixArtix',storage:env.DB?'configured':'unavailable'});
 if(p==='/api/capabilities'&&m==='GET')return json({providers:{google:available(env,'google'),discord:available(env,'discord'),shikimori:available(env,'shikimori')},profile:!!env.DB,desktop:!!env.DB,watchTogether:!!env.ROOMS,shikimoriListSync:false});
 if(p==='/watch') {
  if(!env.ROOMS)fail(503,'rooms_unavailable');
  // Cloudflare overwrites this header at ingress. Never trust a client-supplied quota key.
  const ip=req.headers.get('CF-Connecting-IP');if(!ip||ip.length>45||!/^[0-9a-fA-F:.]+$/.test(ip))fail(503,'client_address_unavailable');
  const forwarded=new Request(req);forwarded.headers.set('X-AnixArtix-Client-Key',await hash(`watch:${Math.floor(now()/86400)}:${ip}`));
  return env.ROOMS.get(env.ROOMS.idFromName('anixartix-rooms-v1')).fetch(forwarded);
 }
 if(p.startsWith('/downloads/'))return downloads(req,env);
 if(!p.startsWith('/api/')) {
  if(!env.ASSETS||!['GET','HEAD'].includes(m))fail(404,'not_found');
  const path=['/','/profile','/desktop'].includes(p)?'/index.html':p==='/downloads'?'/downloads.html':p;
  if(!['/downloads.html','/downloads.css','/downloads.js','/release.mjs','/index.html','/styles.css','/app.js','/api.mjs','/avatar.mjs','/assets/icons/anixartix.png'].includes(path))fail(404,'not_found');
  const asset=await env.ASSETS.fetch(new Request(new URL(path,req.url),req));const response=new Response(asset.body,asset);
  response.headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');response.headers.set('Cache-Control','no-store');return response;
 }
 if(!env.DB)fail(503,'database_not_configured');
 // Canonical host only: callback and browser origins never come from untrusted Host.
 if(u.origin!==origin(env))fail(400,'noncanonical_origin');
 await rate(req,env,'api',120);
 if(p==='/api/desktop/start'&&m==='POST') {
  await rate(req,env,'desktop',10); const d=await body(req);
  if(!/^[A-Za-z0-9_-]{43}$/.test(d.challenge||''))fail(400,'invalid_pkce_challenge');
  const grant=random();await env.DB.prepare('INSERT INTO desktop_grants(hash,challenge,expires) VALUES(?,?,?)').bind(await hash(grant),d.challenge,now()+300).run();
  return json({grant,verificationUrl:`${origin(env)}/desktop#grant=${grant}`,pairingCode:(await hash(grant)).slice(0,8).toUpperCase(),expiresIn:300,interval:5},201);
 }
 if(p==='/api/desktop/exchange'&&m==='POST') {
  await rate(req,env,'desktop-exchange',20);const d=await body(req);
  if(!/^[A-Za-z0-9_-]{43}$/.test(d.grant||'')||!/^[A-Za-z0-9._~-]{43,128}$/.test(d.verifier||''))fail(400,'invalid_grant');
  const h=await hash(d.grant),challenge=await hash(d.verifier);
  // Atomic issuance+consumption: revoke-all cannot run between these statements.
  const token=random(),sessionHash=await hash(token),csrfToken=random(),t=now(),expires=t+2592000;
  const issued=await env.DB.batch([
   env.DB.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) SELECT ?,user_id,?,?,? FROM desktop_grants WHERE hash=? AND challenge=? AND user_id IS NOT NULL AND expires>?').bind(sessionHash,csrfToken,expires,t,h,challenge,t),
   env.DB.prepare('DELETE FROM desktop_grants WHERE hash=? AND challenge=? AND EXISTS(SELECT 1 FROM sessions WHERE hash=?)').bind(h,challenge,sessionHash)
  ]);
  if(!issued[0].meta.changes) {const pending=await env.DB.prepare('SELECT 1 AS ok FROM desktop_grants WHERE hash=? AND challenge=? AND expires>? AND user_id IS NULL').bind(h,challenge,now()).first();fail(pending?428:400,pending?'authorization_pending':'invalid_grant');}
  return json({accessToken:token,tokenType:'Bearer',expiresAt:expires});
 }
 const match=/^\/api\/auth\/(google|discord|shikimori)\/(start|callback)$/.exec(p);
 if(match) {
  const [,provider,action]=match;
  await rate(req,env,'oauth',15);
  if(action==='start'&&m==='POST') {
   sameOrigin(req,env);let s=null;
   if(provider==='shikimori') {s=await session(req,env);csrf(req,env,s);const d=await body(req);if(d.consent!==true)fail(400,'explicit_consent_required');}
   const result=await startOAuth(req,env,provider,s);return json({authorizationUrl:result.url},200,{'Set-Cookie':result.cookie});
  }
  if(action==='callback'&&m==='GET') {
   const result=await completeOAuth(req,env,provider,await session(req,env,false));
   const headers=new Headers({'Location':`${origin(env)}/profile`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
   headers.append('Set-Cookie',setCookie('__Host-anixartix-oauth','',0));if(result)headers.append('Set-Cookie',setCookie('__Host-anixartix',result.token,2592000));
   return new Response(null,{status:303,headers});
  }
  fail(405,'method_not_allowed');
 }
 if(p.startsWith('/api/avatars/')&&m==='GET') {
  const row=await env.DB.prepare('SELECT avatar FROM users WHERE id=?').bind(p.slice('/api/avatars/'.length)).first();return avatarResponse(row?.avatar);
 }
 if(p.startsWith('/api/profiles/')&&m==='GET') {
  const row=await env.DB.prepare('SELECT id,username,display_name,bio,avatar FROM users WHERE id=?').bind(p.slice('/api/profiles/'.length)).first();if(!row)fail(404,'profile_not_found');return json(publicProfile(row));
 }
 const s=await session(req,env);if(!['GET','HEAD'].includes(m))csrf(req,env,s);
 if(p==='/api/me'&&m==='GET') {
  const row=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(s.user_id).first();
  const link=await env.DB.prepare('SELECT provider_id,nickname FROM shikimori_links WHERE user_id=?').bind(s.user_id).first();
  const identities=await env.DB.prepare('SELECT group_concat(provider) AS providers FROM identities WHERE user_id=?').bind(s.user_id).first();
  return json({profile:publicProfile(row),csrfToken:s.csrf,identities:(identities.providers||'').split(',').filter(Boolean),shikimori:link?{id:link.provider_id,nickname:link.nickname}:null});
 }
 if(p==='/api/me/avatar'&&m==='PUT') {
  await rate(req,env,'avatar-write',6);await rate(req,env,'avatar-user',6,s.user_id);
  if(req.headers.get('Content-Type')?.split(';')[0]!=='image/png')fail(415,'png_required');
  const avatar=await encodeAvatar(await validatePng(await boundedBytes(req.body)));
  const saved=await env.DB.prepare('UPDATE users SET avatar=? WHERE id=? AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)').bind(avatar,s.user_id,s.hash,now()).run();if(!saved.meta.changes)fail(401,'authentication_required');
  const row=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(s.user_id).first();return json({profile:publicProfile(row)});
 }
 if(p==='/api/me'&&m==='PATCH') {
  await rate(req,env,'profile-write',15);const d=validateProfile(await body(req));const fields={username:'username',displayName:'display_name',bio:'bio',avatar:'avatar'};
  const keys=Object.keys(d);if(!keys.length)fail(400,'empty_update');
  await env.DB.prepare(`UPDATE users SET ${keys.map(k=>`${fields[k]}=?`).join(',')} WHERE id=?`).bind(...keys.map(k=>d[k]),s.user_id).run();
  return json({ok:true});
 }
 if(p==='/api/desktop/inspect'&&m==='POST') {
  const d=await body(req);if(!/^[A-Za-z0-9_-]{43}$/.test(d.grant||''))fail(400,'invalid_grant');
  const h=await hash(d.grant);const row=await env.DB.prepare('SELECT expires FROM desktop_grants WHERE hash=? AND user_id IS NULL AND expires>?').bind(h,now()).first();if(!row)fail(400,'invalid_grant');
  return json({pairingCode:h.slice(0,8).toUpperCase(),expiresAt:row.expires});
 }
 if(p==='/api/desktop/approve'&&m==='POST') {
  if(s.bearer)fail(403,'browser_approval_required');const d=await body(req);
  if(d.consent!==true||!/^[A-Za-z0-9_-]{43}$/.test(d.grant||''))fail(400,'explicit_consent_required');
  const r=await env.DB.prepare('UPDATE desktop_grants SET user_id=? WHERE hash=? AND user_id IS NULL AND expires>? AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires>?)').bind(s.user_id,await hash(d.grant),now(),s.hash,s.user_id,now()).run();if(!r.meta.changes)fail(400,'invalid_grant');return json({ok:true});
 }
 if(p==='/api/auth/logout'&&m==='POST') {
  await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(s.hash).run();return json({ok:true},200,{'Set-Cookie':setCookie('__Host-anixartix','',0)});
 }
 if(p==='/api/auth/sessions'&&m==='DELETE') {
  await env.DB.batch([env.DB.prepare('DELETE FROM desktop_grants WHERE user_id=?').bind(s.user_id),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(s.user_id)]);return json({ok:true},200,{'Set-Cookie':setCookie('__Host-anixartix','',0)});
 }
 if(p==='/api/shikimori'&&m==='DELETE') {
  await env.DB.prepare('DELETE FROM shikimori_links WHERE user_id=?').bind(s.user_id).run();return json({ok:true,providerRevocationRequired:true});
 }
 fail(404,'not_found');
}
export default {
 async fetch(req,env) {try{return await route(req,env);}catch(e){if(e instanceof HttpError)return json({error:e.message},e.status);if(String(e?.message).includes('UNIQUE constraint'))return json({error:'identity_or_username_already_in_use'},409);return json({error:'internal_error'},500);}},
 async scheduled(_event,env) {if(!env.DB)return;const t=now();await env.DB.batch(['sessions','oauth_states','desktop_grants','rate_limits'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE expires<=?`).bind(t)));}
};
