import {validRelease} from '../public/release.mjs';
const unavailable=()=>Response.json({schemaVersion:1,release:null},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function downloads(req,env) {
 const p=new URL(req.url).pathname;
 if(!['GET','HEAD'].includes(req.method)||!env.ASSETS)return new Response(null,{status:404});
 let release;
 try {
  const manifest=await env.ASSETS.fetch(new Request(new URL('/downloads/release.json',req.url)));
  if(!manifest.ok)throw Error('missing');
  const data=await manifest.json();release=data.schemaVersion===1&&validRelease(data.release)?data.release:null;
  if(release)for(const key of ['installer','source']){
   if(release[key].url.startsWith('https:'))continue; // Published release metadata is verified before import.
   const asset=await env.ASSETS.fetch(new Request(new URL(release[key].url,req.url),{method:'HEAD'}));
   if(!asset.ok||Number(asset.headers.get('Content-Length'))!==release[key].size){release=null;break;}
  }
 }catch{release=null;}
 if(p==='/downloads/release.json')return release?Response.json({schemaVersion:1,release},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}):unavailable();
 const key=release&&['installer','source'].find(k=>release[k].url===p);
 if(!key)return new Response(null,{status:404});
 const asset=await env.ASSETS.fetch(req);if(!asset.ok)return new Response(null,{status:404});
 const response=new Response(asset.body,asset);
 response.headers.set('Content-Type',key==='installer'?'application/octet-stream':'application/zip');
 response.headers.set('Content-Disposition',`attachment; filename="${p.split('/').pop()}"`);
 response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Cache-Control','public, max-age=3600');
 return response;
}
