/* Transport only. CopperScript parses manifests, resolves imports and verifies
 * source locks; this host downloads its bounded requests from pinned GitHub refs. */
import {githubTree,githubFile,githubCommit,projectUrl,remoteBytes} from './projects.js';
import {compileProject,compiledInput,sha256} from './compiler.js';
const MAX_SOURCE=512*1024,MAX_LOADED=8*1024*1024;
const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const safePath=path=>typeof path==='string'&&path.length&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!/[\\:\u0000-\u001f]/.test(path);

export async function prepareGithubProject(file,entryBytes,{signal,fetcher=fetch,onProgress=()=>{}}={}){
  const origin=file.origin;if(origin?.provider!=='github'||!/^[a-f0-9]{40}$/.test(origin.commit)||!safePath(origin.path))throw Error('Project compilation requires a pinned GitHub source URL.');
  if(entryBytes.byteLength>MAX_SOURCE)throw Error('Project source file exceeds 512 KiB.');
  const project={...projectUrl(origin.repository),commit:origin.commit},options={signal,fetcher};
  onProgress('Reading project manifest and source inventory…');
  const tree=await githubTree(project,options),regular=new Set(tree.filter(f=>f.type==='blob'&&['100644','100755'].includes(f.mode)).map(f=>f.path));
  const parents=origin.path.split('/').slice(0,-1);let root='';
  for(let length=parents.length;length>=0;length--){const prefix=parents.slice(0,length).join('/');if(regular.has((prefix?prefix+'/':'')+'copper.mod')){root=prefix?prefix+'/':'';break;}}
  for(const f of tree)if(f.path.startsWith(root)&&f.mode==='120000'&&(/\.copper$/.test(f.path)||['copper.mod','copper.lock'].includes(f.path.slice(root.length))))throw Error('Source/manifest symlinks are unsupported in browser projects.');
  if(!regular.has(origin.path))throw Error('Project entry is absent from its pinned repository tree.');
  async function metadata(name){const path=root+name;if(!regular.has(path))return {text:'',identity:null};const bytes=await remoteBytes(githubFile(project,path).url,{...options,limit:8*1024*1024});return {text:decode(bytes),identity:{path,sha256:await sha256(bytes)}};}
  const [manifest,lock]=await Promise.all([metadata('copper.mod'),metadata('copper.lock')]);
  const entry=origin.path.slice(root.length),snapshot={schema:'copperscript.project-snapshot/v1',entry,manifest:manifest.text,lock:lock.text,workspace_files:[...regular].filter(p=>p.startsWith(root)&&p.endsWith('.copper')&&!/(?:^|\/)(?:\.copper-cache|node_modules|target)\//.test(p)).map(p=>p.slice(root.length)),files:{['workspace/'+entry]:decode(entryBytes)}};
  const identity={entry:origin.path,manifest:manifest.identity,lock:lock.identity,modules:[]},modules=new Map(),downloaded=new Set(Object.keys(snapshot.files));let total=entryBytes.byteLength;
  async function resolveSources(requests,{signal:workerSignal}={}){
    if(!Array.isArray(requests)||!requests.length||requests.length+downloaded.size>512)throw Error('Project exceeds the 512-file dependency limit.');
    const requestSignal=workerSignal?AbortSignal.any([...(signal?[signal]:[]),workerSignal]):signal;
    const pending=[...requests];onProgress(`Downloading ${pending.length} imported source file(s)…`);
    async function next(){while(pending.length){
      requestSignal?.throwIfAborted();const request=pending.shift();
      if(!request||typeof request.id!=='string'||!safePath(request.path)||downloaded.has(request.id)||request.path.endsWith('.copper')===false)throw Error('Compiler requested an invalid or repeated source path.');
      downloaded.add(request.id);if(request.size>MAX_SOURCE)throw Error(`Dependency source exceeds 512 KiB: ${request.path}`);
      let remote;
      if(request.repository){
        if(!/^github\.com\/[\w.-]+\/[\w.-]+$/.test(request.repository)||typeof request.revision!=='string'||!request.revision)throw Error('Unsupported dependency repository or revision.');
        const key=`${request.repository}@${request.revision}`;
        if(!modules.has(key))modules.set(key,githubCommit(request.repository,request.revision,{signal:requestSignal,fetcher}));
        const resolved=await modules.get(key);remote=githubFile(resolved,request.path);
        if(!identity.modules.some(m=>m.module===request.module))identity.modules.push({module:request.module,repository:resolved.url,version:request.version||request.revision,revision:request.revision,commit:resolved.commit});
      }else{
        if(!regular.has(root+request.path))throw Error(`Workspace source is missing: ${request.path}`);remote=githubFile(project,root+request.path);
      }
      const bytes=await remoteBytes(remote.url,{signal:requestSignal,fetcher,limit:MAX_SOURCE});requestSignal?.throwIfAborted();
      if(request.sha256&&(await sha256(bytes)!==request.sha256||request.size!==bytes.byteLength))throw Error(`Dependency checksum mismatch: ${request.id}`);
      total+=bytes.byteLength;if(total>MAX_LOADED)throw Error('Project source exceeds 8 MiB.');
      snapshot.files[request.id]=decode(bytes);
    }}
    await Promise.all(Array.from({length:Math.min(6,pending.length)},next));
  }
  return {snapshot,identity,resolveSources};
}
export async function compileGithubProject(file,entryBytes,options={}){
  const {snapshot,identity,resolveSources}=await prepareGithubProject(file,entryBytes,options);
  const analysis=await compileProject(snapshot,resolveSources,options),result=await compiledInput(analysis,entryBytes,file.origin.path);
  identity.modules.sort((a,b)=>a.module.localeCompare(b.module));
  result.input.project={...identity,...analysis.source_snapshot};return result;
}
