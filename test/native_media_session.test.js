import { describe, it, expect } from 'vitest';
import { createNativeMediaSession, originalIsHls } from '../src/app/components/watch-together/native-media.js';
const fixture = () => { const pending=[],closed=[]; const session=createNativeMediaSession({open:()=>new Promise(r=>pending.push(r)),close:async u=>closed.push(u)});return {session,pending,closed}; };
describe('native media ownership',()=>{
 it('closes late older opens and keeps newest registration',async()=>{const f=fixture();const a=f.session.open('a'),b=f.session.open('b');f.pending[1]('http://127.0.0.1:9000/b');expect(await b).toContain('/b');f.pending[0]('http://127.0.0.1:9000/a');expect(await a).toBeNull();expect(f.closed).toEqual(['http://127.0.0.1:9000/a']);await f.session.destroy();expect(f.closed).toContain('http://127.0.0.1:9000/b');});
 it.each(['cancel','destroy'])('cleans pending open after %s',async(method)=>{const f=fixture();const a=f.session.open('a');await f.session[method]();f.pending[0]('http://127.0.0.1:9000/a');expect(await a).toBeNull();expect(f.closed).toHaveLength(1);});
 it('cleans registration when caller episode generation changed',async()=>{const f=fixture();const a=f.session.open('a',null,()=>false);f.pending[0]('http://127.0.0.1:9000/a');expect(await a).toBeNull();expect(f.closed).toHaveLength(1);});
 it('rejects remote URL returned as native result',async()=>{const f=fixture();const a=f.session.open('a');f.pending[0]('https://unsafe.example/video');await expect(a).rejects.toThrow('INVALID_NATIVE_MEDIA');expect(f.closed).toHaveLength(1);});
 it('infers HLS from original not opaque proxy',()=>{expect(originalIsHls('https://x/master.m3u8?secret=x')).toBe(true);expect(originalIsHls('http://127.0.0.1:9000/opaque')).toBe(false);});
});

import { classifiedIsHls } from '../src/app/components/watch-together/native-media.js';
it('uses native HLS classification for extensionless providers',()=>{
 expect(classifiedIsHls('https://provider.example/stream/123','http://127.0.0.1:9000/token/stream.m3u8')).toBe(true);
 expect(classifiedIsHls('https://provider.example/movie.mp4','http://127.0.0.1:9000/token')).toBe(false);
});
it.each(['cancel','destroy'])('closes late async offline stream after %s',async(method)=>{
 let finish;const paths=[],closed=[];
 const session=createNativeMediaSession({open:()=>{throw new Error('Must not use online transport');},close:async u=>closed.push(u)}, {open:p=>{paths.push(p);return new Promise(r=>finish=r);}});
 const pending=session.open('offline-file:folder%2Fepisode.mp4');await session[method]();finish('http://127.0.0.1:9000/offline');expect(await pending).toBeNull();expect(paths).toEqual(['folder/episode.mp4']);expect(closed).toHaveLength(1);
});
