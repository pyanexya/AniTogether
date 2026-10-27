import {createRemoteJWKSet,jwtVerify} from 'jose';
import {now,random,hash,cookie,setCookie,origin,fail,encrypt,decrypt,newSession} from './security.mjs';
const googleKeys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const providers={
 google:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'openid email profile'},
 discord:{authorize:'https://discord.com/oauth2/authorize',token:'https://discord.com/api/oauth2/token',scope:'identify'},
 shikimori:{authorize:'https://shikimori.io/oauth/authorize',token:'https://shikimori.io/oauth/token',scope:''}
};
export function available(env,p) {return !!providers[p]&&!!env[`${p.toUpperCase()}_CLIENT_ID`]&&!!env[`${p.toUpperCase()}_CLIENT_SECRET`]&&(p!=='shikimori'|| /^[A-Za-z0-9+/]{43}=$/.test(env.TOKEN_ENCRYPTION_KEY||''));}
function config(env,p){if(!available(env,p))fail(503,'provider_not_configured');return {...providers[p],id:env[`${p.toUpperCase()}_CLIENT_ID`],secret:env[`${p.toUpperCase()}_CLIENT_SECRET`],callback:`${origin(env)}/api/auth/${p}/callback`};}
export async function startOAuth(req,env,p,s) {
 const c=config(env,p); const state=random(),browser=random(),nonce=random(),verifier=random();
 await env.DB.prepare('INSERT INTO oauth_states(hash,provider,browser_hash,nonce,verifier,user_id,session_hash,expires) VALUES(?,?,?,?,?,?,?,?)').bind(await hash(state),p,await hash(browser),nonce,verifier,s?.user_id||null,s?.hash||null,now()+600).run();
 const u=new URL(c.authorize); for(const [k,v] of Object.entries({client_id:c.id,redirect_uri:c.callback,response_type:'code',scope:c.scope,state}))u.searchParams.set(k,v);
 if(p==='google'){u.searchParams.set('nonce',nonce);u.searchParams.set('code_challenge',await hash(verifier));u.searchParams.set('code_challenge_method','S256');}
 return {url:u.href,cookie:setCookie('__Host-anixartix-oauth',browser,600)};
}
async function remoteJson(url,options={}) {
 // Workers supports only follow/manual; reject non-2xx below without forwarding credentials.
 const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(!response.ok)fail(502,'provider_request_failed');
 const reader=response.body?.getReader();if(!reader)fail(502,'provider_response_invalid');let size=0;const parts=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();fail(502,'provider_response_invalid');}parts.push(value);}
 const text=new TextDecoder().decode(Uint8Array.from(parts.flatMap(x=>Array.from(x))));
 try{return JSON.parse(text);}catch{fail(502,'provider_response_invalid');}
}
async function exchange(c,fields){return remoteJson(c.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'AnixArtix'},body:new URLSearchParams({client_id:c.id,client_secret:c.secret,...fields})});}
export async function verifyGoogleIdentity(token,clientId,nonce,keys=googleKeys) {
 const {payload}=await jwtVerify(token,keys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,algorithms:['RS256'],maxTokenAge:'10m'});
 if(payload.nonce!==nonce||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||(payload.azp&&payload.azp!==clientId))fail(403,'identity_invalid');
 return {id:payload.sub,name:payload.name};
}
export async function completeOAuth(req,env,p,currentSession) {
 const c=config(env,p),url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!code||code.length>2048)fail(400,'invalid_oauth_callback');
 const row=await env.DB.prepare('DELETE FROM oauth_states WHERE hash=? AND provider=? AND browser_hash=? AND expires>? RETURNING *').bind(await hash(state),p,await hash(cookie(req,'__Host-anixartix-oauth')),now()).first();
 if(!row)fail(400,'oauth_state_invalid');
 if(p==='shikimori'&&(!currentSession||row.user_id!==currentSession.user_id||row.session_hash!==currentSession.hash))fail(403,'link_session_changed');
 const tokens=await exchange(c,{grant_type:'authorization_code',code,redirect_uri:c.callback,...(p==='google'?{code_verifier:row.verifier}:{})});
 if(typeof tokens.access_token!=='string'||tokens.access_token.length>8192)fail(502,'provider_response_invalid');
 let identity;
 if(p==='google') {
  identity=await verifyGoogleIdentity(tokens.id_token,c.id,row.nonce);
 } else {
  const u=await remoteJson(p==='discord'?'https://discord.com/api/v10/users/@me':'https://shikimori.io/api/users/whoami',{headers:{Authorization:`Bearer ${tokens.access_token}`,'User-Agent':'AnixArtix'}});
  if(!/^\d{1,30}$/.test(String(u.id)))fail(502,'identity_invalid');identity={id:String(u.id),name:u.global_name||u.username||u.nickname};
 }
 if(p==='shikimori') {
  if(!tokens.refresh_token||!Number.isFinite(Number(tokens.expires_in)))fail(502,'provider_response_invalid');
  const encrypted=await encrypt(env,row.user_id,{access:tokens.access_token,refresh:tokens.refresh_token});
  await env.DB.prepare('INSERT INTO shikimori_links(user_id,provider_id,nickname,encrypted_tokens,expires,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider_id=excluded.provider_id,nickname=excluded.nickname,encrypted_tokens=excluded.encrypted_tokens,expires=excluded.expires,updated_at=excluded.updated_at').bind(row.user_id,identity.id,String(identity.name||'').slice(0,64),encrypted,now()+Number(tokens.expires_in),now()).run();
  return null;
 }
 let account=await env.DB.prepare('SELECT user_id FROM identities WHERE provider=? AND provider_id=?').bind(p,identity.id).first();
 if(!account) {
  const id=random();
  // Batch is atomic. Concurrent callbacks cannot steal an identity; UNIQUE rejects one.
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind(id,`user_${id.slice(0,12).replaceAll('-','_')}`,String(identity.name||'Пользователь').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64)||'Пользователь',now()),
   env.DB.prepare('INSERT INTO identities(provider,provider_id,user_id) VALUES(?,?,?)').bind(p,identity.id,id)
  ]);account={user_id:id};
 }
 const s=await newSession(env,account.user_id);
 if(currentSession)await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(currentSession.hash).run();
 return s;
}
// For server-side identity use only. No endpoint returns these tokens to clients.
export async function shikimoriToken(env,userId) {
 const c=config(env,'shikimori'),row=await env.DB.prepare('SELECT * FROM shikimori_links WHERE user_id=?').bind(userId).first();if(!row)fail(404,'shikimori_not_linked');
 const value=await decrypt(env,userId,row.encrypted_tokens);if(row.expires>now()+60)return value.access;
 const lock=random();const acquired=await env.DB.prepare('UPDATE shikimori_links SET refresh_lock=?,refresh_lock_until=? WHERE user_id=? AND encrypted_tokens=? AND refresh_lock_until<=?').bind(lock,now()+30,userId,row.encrypted_tokens,now()).run();
 if(!acquired.meta.changes)fail(409,'refresh_in_progress_retry');
 try {
  const tokens=await exchange(c,{grant_type:'refresh_token',refresh_token:value.refresh});
  if(typeof tokens.access_token!=='string'||typeof tokens.refresh_token!=='string'||!Number.isFinite(Number(tokens.expires_in)))fail(502,'provider_response_invalid');
  const result=await env.DB.prepare('UPDATE shikimori_links SET encrypted_tokens=?,expires=?,updated_at=? WHERE user_id=? AND encrypted_tokens=? AND refresh_lock=?').bind(await encrypt(env,userId,{access:tokens.access_token,refresh:tokens.refresh_token}),now()+Number(tokens.expires_in),now(),userId,row.encrypted_tokens,lock).run();
  if(!result.meta.changes)fail(409,'link_changed_retry');return tokens.access_token;
 } finally {await env.DB.prepare('UPDATE shikimori_links SET refresh_lock=NULL,refresh_lock_until=0 WHERE user_id=? AND refresh_lock=?').bind(userId,lock).run();}
}
