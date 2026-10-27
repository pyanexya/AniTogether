#!/usr/bin/env node
// Run only with verified artifacts from the same successful commit/build.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validRelease,RELEASE_BASE} from '../public/release.mjs';
export async function prepare({installer,source,version,commit,date,destination,host='assets'}) {
 const release={version,commit,date,platform:'windows-x64',signed:false};
 if(!['assets','github'].includes(host))throw Error('host must be assets or github');
 const inputs={installer,source},buffers={};
 for(const key of ['installer','source']){
  const bytes=await readFile(inputs[key]);buffers[key]=bytes;
  if(key==='installer'&&(bytes[0]!==0x4d||bytes[1]!==0x5a))throw Error('Installer is not a Windows executable');
  if(key==='source'&&(bytes[0]!==0x50||bytes[1]!==0x4b))throw Error('Source must be the matching source ZIP, including license/build instructions');
  const name=`AnixArtix_${version}_${key==='installer'?'x64-setup.exe':'source.zip'}`;
  release[key]={url:host==='assets'?`/downloads/${name}`:`${RELEASE_BASE}v${version}/${name}`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 if(!validRelease(release))throw Error('Invalid release metadata or static asset exceeds 25 MiB');
 await mkdir(destination,{recursive:true});
 if(host==='assets')for(const key of ['installer','source'])await copyFile(inputs[key],resolve(destination,release[key].url.split('/').pop()));
 // For GitHub mode, caller must publish and verify public assets BEFORE committing this manifest.
 await writeFile(resolve(destination,'release.json'),JSON.stringify({schemaVersion:1,release},null,2)+'\n');
 return release;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [installer,source,version,commit,date,host='assets']=process.argv.slice(2);
 if(!date)throw Error('Usage: node scripts/prepare-download.mjs INSTALLER SOURCE_ZIP VERSION COMMIT RELEASE_DATE_UTC [assets|github]');
 const destination=fileURLToPath(new URL('../public/downloads/',import.meta.url));
 const r=await prepare({installer,source,version,commit,date,host,destination});
 console.log(`Prepared ${r.version}: installer ${r.installer.size} bytes; source ${r.source.size} bytes. ${host==='github'?'Verify published public release assets before committing release.json.':'Review files before staging or deploying.'}`);
}
