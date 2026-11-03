import init,* as wasm from './wasm/copper_web.js';
import {sha256} from './hash.js';

try{
  const response=await fetch(new URL('./wasm/manifest.json',import.meta.url));
  if(!response.ok)throw Error('Compiler manifest is unavailable. Build the WASM assets first.');
  const manifest=await response.json();
  const binary=await fetch(new URL('./wasm/copper_web_bg.wasm',import.meta.url));
  if(!binary.ok)throw Error('Compiler binary is unavailable.');
  const bytes=await binary.arrayBuffer();
  if(await sha256(bytes)!==manifest.wasm_sha256)throw Error('Compiler assets do not match their build manifest.');
  await init({module_or_path:bytes});
  if(typeof wasm.generate_body!=='function')throw Error('This CopperScript build cannot generate 3D bodies.');
  self.postMessage({type:'ready'});
  self.onmessage=event=>{
    // One footprint CopperScript cannot handle leaves only that component without a body.
    self.postMessage({type:'bodies',results:event.data.requests.map(request=>{try{return JSON.parse(wasm.generate_body(request));}catch(error){return {error:`CopperScript stopped: ${error.message}`};}})});
  };
}catch(error){self.postMessage({type:'fatal',error:error.message});}
