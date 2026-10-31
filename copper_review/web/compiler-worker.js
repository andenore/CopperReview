import init,{review,review_project} from './wasm/copper_web.js';

try{
  const response=await fetch(new URL('./wasm/manifest.json',import.meta.url));
  if(!response.ok)throw Error('Compiler manifest is unavailable. Build the WASM assets first.');
  const manifest=await response.json();
  const binary=await fetch(new URL('./wasm/copper_web_bg.wasm',import.meta.url));
  if(!binary.ok)throw Error('Compiler binary is unavailable.');
  const bytes=await binary.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==manifest.wasm_sha256)throw Error('Compiler assets do not match their build manifest.');
  await init({module_or_path:bytes});
  self.postMessage({type:'ready',manifest});
  self.onmessage=event=>{
    try{self.postMessage({type:'result',result:JSON.parse(event.data.project?review_project(event.data.project):review(event.data.source)),manifest});}
    catch(error){self.postMessage({type:'fatal',error:`CopperScript stopped: ${error.message}`});}
  };
}catch(error){self.postMessage({type:'fatal',error:`Could not load CopperScript WASM: ${error.message}`});}
