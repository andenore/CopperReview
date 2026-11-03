import init,{review,review_project} from './wasm/copper_web.js';
import {sha256} from './hash.js';

// Each stage is reported so a stalled load says where it stopped.
const stage=text=>self.postMessage({type:'stage',stage:text});
try{
  stage('downloading the compiler manifest');
  const response=await fetch(new URL('./wasm/manifest.json',import.meta.url));
  if(!response.ok)throw Error('Compiler manifest is unavailable. Run npm run fetch:wasm in the CopperReview checkout on the server.');
  const manifest=await response.json();
  stage('downloading the compiler (copper_web_bg.wasm)');
  const binary=await fetch(new URL('./wasm/copper_web_bg.wasm',import.meta.url));
  if(!binary.ok)throw Error('Compiler binary is unavailable.');
  const bytes=await binary.arrayBuffer();stage('verifying the compiler checksum');const hash=await sha256(bytes);
  if(hash!==manifest.wasm_sha256)throw Error('Compiler assets do not match their build manifest.');
  stage('starting WebAssembly');
  await init({module_or_path:bytes});
  self.postMessage({type:'ready',manifest});
  self.onmessage=event=>{
    try{self.postMessage({type:'result',result:JSON.parse(event.data.project?review_project(event.data.project):review(event.data.source)),manifest});}
    catch(error){self.postMessage({type:'fatal',error:`CopperScript stopped: ${error.message}`});}
  };
}catch(error){self.postMessage({type:'fatal',error:`Could not load CopperScript WASM: ${error.message}`});}
