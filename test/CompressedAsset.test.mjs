import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source=await readFile(new URL('../src/render/loadPassAsset.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {loadPassAsset}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const raw=await readFile(new URL('../public/assets/touge/mountain_pass.glb',import.meta.url));
const packed=await readFile(new URL('../public/assets/touge/mountain_pass.glb.gz',import.meta.url));
const url='/assets/touge/mountain_pass.glb';

test('compressed loading passes the exact original GLB and base path to the parser',async t=>{
  const oldFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  const parsed={scene:'actual parser result'};
  globalThis.fetch=async requested=>{assert.equal(requested,url+'.gz');return new Response(packed);};
  const result=await loadPassAsset({
    parseAsync:async(bytes,base)=>{assert.deepEqual(Buffer.from(bytes),raw);assert.equal(base,'/assets/touge/');return parsed;},
    loadAsync:()=>{throw Error('raw download should not run after successful decompression');},
  });
  assert.equal(result,parsed);
});

test('missing or corrupt compressed data falls back to the ordinary loader',async t=>{
  const oldFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  for(const response of [new Response('',{status:404}),new Response('corrupt gzip')]){
    globalThis.fetch=async()=>response;
    const fallback={scene:'fallback result'};
    assert.equal(await loadPassAsset({parseAsync:()=>{throw Error('bad gzip reached parser');},loadAsync:async requested=>{assert.equal(requested,url);return fallback;}}),fallback);
  }
});

test('browsers without native decompression use the raw loader directly',async t=>{
  const oldFetch=globalThis.fetch, old=globalThis.DecompressionStream;
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.DecompressionStream=old;});
  globalThis.DecompressionStream=undefined;
  globalThis.fetch=()=>{throw Error('unsupported browser should not fetch compressed data');};
  const fallback={scene:'compatible result'};
  assert.equal(await loadPassAsset({loadAsync:async requested=>{assert.equal(requested,url);return fallback;}}),fallback);
});

 test('HTTP gzip already decoded by fetch is parsed without a second decompression',async t=>{
  const oldFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  globalThis.fetch=async()=>new Response(raw,{headers:{'Content-Encoding':'gzip'}});
  const parsed={scene:'http-decoded'};
  assert.equal(await loadPassAsset({parseAsync:async bytes=>{assert.deepEqual(Buffer.from(bytes),raw);return parsed;},loadAsync:()=>{throw Error('double decompression triggered raw fallback');}}),parsed);
});

test('a proxy-decoded GLB without Content-Encoding is parsed directly',async t=>{
 const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
 globalThis.fetch=async()=>new Response(raw);
 const parsed={scene:'proxy-decoded'};
 assert.equal(await loadPassAsset({parseAsync:async bytes=>{assert.deepEqual(Buffer.from(bytes),raw);return parsed;},loadAsync:()=>{throw Error('proxy-decoded file triggered duplicate raw download');}}),parsed);
});
