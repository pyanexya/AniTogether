import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,createFetchMock} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {hash,random} from '../src/security.mjs';

const origin='https://aniartix.pyanexy.cc';
const providers={
 discord:{host:'https://discord.com',token:'/api/oauth2/token',profile:'/api/v10/users/@me'},
 google:{host:'https://oauth2.googleapis.com',token:'/token'},
 shikimori:{host:'https://shikimori.io',token:'/oauth/token',profile:'/api/users/whoami'}
};
const bundle=await build({entryPoints:[new URL('../src/index.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
async function fixture(provider){
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',fetchMock,
  bindings:{APP_ORIGIN:origin,[`${provider.toUpperCase()}_CLIENT_ID`]:'test-client',[`${provider.toUpperCase()}_CLIENT_SECRET`]:'test-secret',TOKEN_ENCRYPTION_KEY:btoa('k'.repeat(32))},
  d1Databases:['DB'],durableObjects:{ROOMS:{className:'WatchRooms',useSQLite:true}}});
 const db=await mf.getD1Database('DB');
 const migration=await readFile(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8');
 for(const sql of migration.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 const call=(path,options={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...options});
 let sessionCookie='',csrf='';
 if(provider==='shikimori'){
  const token=random();csrf=random();const t=Math.floor(Date.now()/1000);
  await db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').bind('existing-user','existing_user','Existing',t).run();
  await db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,created_at) VALUES(?,?,?,?,?)').bind(await hash(token),'existing-user',csrf,t+600,t).run();
  sessionCookie='__Host-anixartix='+token;
 }
 const start=async()=>{
  const response=await call(`/api/auth/${provider}/start`,{method:'POST',headers:{Origin:origin,Cookie:sessionCookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({consent:true})});
  assert.equal(response.status,200);const url=new URL((await response.json()).authorizationUrl);
  const cookie=[sessionCookie,response.headers.get('Set-Cookie').split(';')[0]].filter(Boolean).join('; ');
  return {url,callback:()=>call(`/api/auth/${provider}/callback?state=${url.searchParams.get('state')}&code=test-code`,{headers:{Cookie:cookie}})};
 };
 return {mf,db,fetchMock,call,start,sessionCookie};
}

for(const [provider,config] of Object.entries(providers)){
 test(`workerd OAuth ${provider}: real callback, cookies, D1 identity and replay protection`,async()=>{
  const f=await fixture(provider);
  try{
   const flow=await f.start();
   let id_token;
   if(provider==='google'){
    const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test-key';
    id_token=await new SignJWT({nonce:flow.url.searchParams.get('nonce'),name:'Runtime Google'}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject('google-runtime-id').setAudience('test-client').setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    f.fetchMock.get('https://www.googleapis.com').intercept({path:'/oauth2/v3/certs'}).reply(200,{keys:[jwk]});
   }
   f.fetchMock.get(config.host).intercept({path:config.token,method:'POST'}).reply(200,{access_token:'test-provider-token',refresh_token:'test-refresh-token',expires_in:3600,...(id_token?{id_token}:{})});
   if(config.profile)f.fetchMock.get(config.host).intercept({path:config.profile,headers:{authorization:'Bearer test-provider-token'}}).reply(200,{id:'123',username:'Runtime User'});
   const response=await flow.callback();
   assert.equal(response.status,303,await response.clone().text());
   assert.equal(response.headers.get('Location'),origin+'/profile');
   assert.equal(response.headers.get('Cache-Control'),'no-store');
   assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
   const cookies=response.headers.getSetCookie();
   assert.ok(cookies.some(c=>c.startsWith('__Host-anixartix-oauth=;')&&c.includes('Max-Age=0')));
   const login=cookies.find(c=>c.startsWith('__Host-anixartix='));
   assert.equal(!!login,provider!=='shikimori');
   if(login)assert.match(login,/; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/);
   const me=await f.call('/api/me',{headers:{Cookie:login?.split(';')[0]||f.sessionCookie}});
   assert.equal(me.status,200);const data=await me.json();
   if(provider==='shikimori')assert.equal(data.shikimori.id,'123');else assert.deepEqual(data.identities,[provider]);
   assert.equal((await flow.callback()).status,400);
   assert.equal((await f.db.prepare('SELECT count(*) AS count FROM sessions').first()).count,1);
   f.fetchMock.assertNoPendingInterceptors();
  }finally{await f.mf.dispose();}
 });
 test(`workerd OAuth ${provider}: upstream redirects are rejected, never followed`,async()=>{
  const f=await fixture(provider);
  try{
   // No interceptor permits the redirect destination: credentials must never reach it.
   for(const status of [302,307]){
    const flow=await f.start();
    f.fetchMock.get(config.host).intercept({path:config.token,method:'POST'}).reply(status,'',{headers:{Location:'https://untrusted.invalid/steal'}});
    const response=await flow.callback();
    assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'provider_request_failed'});
    assert.equal(response.headers.get('Set-Cookie'),null);
   }
   if(config.profile){
    const flow=await f.start();
    f.fetchMock.get(config.host).intercept({path:config.token,method:'POST'}).reply(200,{access_token:'test-provider-token'});
    f.fetchMock.get(config.host).intercept({path:config.profile}).reply(302,'',{headers:{Location:'https://untrusted.invalid/steal'}});
    const response=await flow.callback();assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'provider_request_failed'});
   }
   assert.equal((await f.db.prepare('SELECT count(*) AS count FROM identities').first()).count,0);
   f.fetchMock.assertNoPendingInterceptors();
  }finally{await f.mf.dispose();}
 });
}
