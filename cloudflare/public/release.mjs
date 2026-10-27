// Shared by the Worker, browser, and release importer. Public release destinations
// are confined to this repository; private Actions artifacts are never downloads.
export const RELEASE_BASE='https://github.com/MjKey/AniXFlow/releases/download/';
export function validRelease(r) {
 if(!r||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(r.version)||! /^[a-f0-9]{40}$/.test(r.commit)||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.date)||!Number.isFinite(Date.parse(r.date))||r.platform!=='windows-x64'||r.signed!==false)return false;
 return ['installer','source'].every(key=>{
  const a=r[key],suffix=key==='installer'?'x64-setup.exe':'source.zip';
  const file=`AnixArtix_${r.version}_${suffix}`;
  return !!a && (a.url===`/downloads/${file}`||a.url===`${RELEASE_BASE}v${r.version}/${file}`) &&
   Number.isSafeInteger(a.size)&&a.size>0&&(a.url.startsWith('https:')||a.size<=25*1024*1024)&&/^[a-f0-9]{64}$/.test(a.sha256);
 });
}
