/* Transport only. CopperScript parses manifests, resolves imports and verifies
 * source locks; this host answers its bounded requests from a workspace (a pinned
 * GitHub tree or a local folder) and downloads dependencies from pinned GitHub refs. */
import {githubTree,githubFile,githubCommit,projectUrl,remoteBytes} from './projects.js';
import {compileProject,compiledInput,sha256} from './compiler.js';
const MAX_SOURCE=512*1024,MAX_LOADED=8*1024*1024;
const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const safePath=path=>typeof path==='string'&&path.length&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!/[\\:\u0000-\u001f]/.test(path);

export async function prepareGithubProject(file,entryBytes,{signal,fetcher=fetch,onProgress=()=>{}}={}){
  const origin=file.origin;if(origin?.provider!=='github'||!/^[a-f0-9]{40}$/.test(origin.commit)||!safePath(origin.path))throw Error('Project compilation requires a pinned GitHub source URL.');
  if(entryBytes.byteLength>MAX_SOURCE)throw Error('Project source file exceeds 512 KiB.');
  const project={...projectUrl(origin.repository),commit:origin.commit};
  onProgress('Reading project manifest and source inventory…');
  const tree=await githubTree(project,{signal,fetcher}),regular=new Set(tree.filter(f=>f.type==='blob'&&['100644','100755'].includes(f.mode)).map(f=>f.path));
  const workspace={paths:regular,symlinks:tree.filter(f=>f.mode==='120000').map(f=>f.path),absent:'Project entry is absent from its pinned repository tree.',
    read:(path,limit,requestSignal=signal)=>remoteBytes(githubFile(project,path).url,{signal:requestSignal,fetcher,limit})};
  return prepareProject(workspace,origin.path,entryBytes,{signal,fetcher,onProgress});
}
/** A local folder: `files` maps folder-relative paths to File/Blob objects. Nothing is uploaded;
 * only pinned dependencies outside the folder are downloaded from GitHub. */
export async function prepareLocalProject(files,entryPath,entryBytes,{signal,fetcher=fetch,onProgress=()=>{}}={}){
  if(!safePath(entryPath))throw Error('Choose a .copper file inside the folder.');
  if(entryBytes.byteLength>MAX_SOURCE)throw Error('Project source file exceeds 512 KiB.');
  const workspace={paths:new Set(files.keys()),symlinks:[],absent:'Project entry is absent from the chosen folder.',
    read:async(path,limit)=>{const file=files.get(path);if(file.size>limit)throw Error(`${path} exceeds ${Math.round(limit/1024)} KiB.`);return new Uint8Array(await file.arrayBuffer());}};
  return prepareProject(workspace,entryPath,entryBytes,{signal,fetcher,onProgress});
}
/** Board sources in a folder: .copper files that declare a board, shallowest first. */
export async function localBoardSources(files){
  const boards=[];
  for(const [path,file]of files)if(path.endsWith('.copper')&&file.size<=MAX_SOURCE&&/^\s*board\s+[A-Za-z_]/m.test(await file.text()))boards.push(path);
  return boards.sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
}
async function prepareProject(workspace,entryPath,entryBytes,{signal,fetcher=fetch,onProgress=()=>{}}={}){
  const regular=workspace.paths,parents=entryPath.split('/').slice(0,-1);let root='';
  for(let length=parents.length;length>=0;length--){const prefix=parents.slice(0,length).join('/');if(regular.has((prefix?prefix+'/':'')+'copper.mod')){root=prefix?prefix+'/':'';break;}}
  for(const path of workspace.symlinks)if(path.startsWith(root)&&(/\.copper$/.test(path)||['copper.mod','copper.lock'].includes(path.slice(root.length))))throw Error('Source/manifest symlinks are unsupported in browser projects.');
  if(!regular.has(entryPath))throw Error(workspace.absent);
  async function metadata(name){const path=root+name;if(!regular.has(path))return {text:'',identity:null};const bytes=await workspace.read(path,8*1024*1024);return {text:decode(bytes),identity:{path,sha256:await sha256(bytes)}};}
  const [manifest,lock]=await Promise.all([metadata('copper.mod'),metadata('copper.lock')]);
  const origin={path:entryPath};
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
        if(!regular.has(root+request.path))throw Error(`Workspace source is missing: ${request.path}`);
      }
      const bytes=remote?await remoteBytes(remote.url,{signal:requestSignal,fetcher,limit:MAX_SOURCE}):await workspace.read(root+request.path,MAX_SOURCE,requestSignal);requestSignal?.throwIfAborted();
      if(request.sha256&&(await sha256(bytes)!==request.sha256||request.size!==bytes.byteLength))throw Error(`Dependency checksum mismatch: ${request.id}`);
      total+=bytes.byteLength;if(total>MAX_LOADED)throw Error('Project source exceeds 8 MiB.');
      snapshot.files[request.id]=decode(bytes);
    }}
    await Promise.all(Array.from({length:Math.min(6,pending.length)},next));
  }
  return {snapshot,identity,resolveSources};
}
export async function compileGithubProject(file,entryBytes,options={}){
  return compilePrepared(await prepareGithubProject(file,entryBytes,options),entryBytes,file.origin.path,options);
}
export async function compileLocalProject(files,entryPath,entryBytes,options={}){
  return compilePrepared(await prepareLocalProject(files,entryPath,entryBytes,options),entryBytes,entryPath,options);
}
async function compilePrepared({snapshot,identity,resolveSources},entryBytes,entryPath,options){
  const analysis=await compileProject(snapshot,resolveSources,options),result=await compiledInput(analysis,entryBytes,entryPath);
  identity.modules.sort((a,b)=>a.module.localeCompare(b.module));
  result.input.project={...identity,...analysis.source_snapshot};
  // The sources the compiler read, for "Source" links: workspace/<path> and dependency/<module>/<path>.
  result.sources={files:{...snapshot.files},root:entryPath.slice(0,entryPath.length-snapshot.entry.length),entry:snapshot.entry};
  return result;
}
