/* Read-only URL loading. GitHub refs resolve once, then every file uses that commit. */
const API='https://api.github.com/repos/',RAW='https://raw.githubusercontent.com/';
export const MAX_REMOTE_BYTES=49*1024*1024;
const segment=value=>encodeURIComponent(value);
const pathUrl=path=>path.split('/').map(segment).join('/');
function cleanPath(path){if(path.some(p=>!p||p==='.'||p==='..'||/[\\\u0000-\u001f]/.test(p)))throw Error('Invalid repository path.');return path.join('/');}
export function projectUrl(value,ref=''){
  ref=ref.trim();let url;try{url=new URL(value.trim());}catch{throw Error('Enter a complete HTTPS URL.');}
  if(url.protocol!=='https:'||url.username||url.password)throw Error('Use a public HTTPS URL without embedded credentials.');
  if(url.hostname==='github.com'||url.hostname==='raw.githubusercontent.com'){
    const parts=url.pathname.split('/').filter(Boolean).map(p=>decodeURIComponent(p));if(parts.length<2)throw Error('Enter a GitHub repository or file URL.');
    const [owner,rawRepo,...tail]=parts,repo=rawRepo.replace(/\.git$/,'');
    if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo))throw Error('Invalid GitHub repository name.');
    let kind='repository',path='';
    if(tail.length){
      const raw=url.hostname==='raw.githubusercontent.com',mode=raw?'blob':tail.shift();
      if(!['blob','tree'].includes(mode))throw Error('Use a GitHub repository, tree or blob URL.');
      kind=mode==='blob'?'file':'repository';
      const refParts=ref?ref.split('/'):[tail[0]];
      if(!refParts[0]||refParts.some((p,i)=>tail[i]!==p))throw Error('The ref must match the branch, tag or commit in the URL. For branch names containing /, enter the full ref.');
      ref=refParts.join('/');path=cleanPath(tail.slice(refParts.length));
      if(kind==='file'&&!path)throw Error('The GitHub file URL has no file path.');
    }else if(url.hostname==='raw.githubusercontent.com')throw Error('The raw GitHub URL has no file path.');
    return {provider:'github',owner,repo,ref:ref.trim()||'HEAD',path,kind,url:`https://github.com/${owner}/${repo}`};
  }
  url.hash='';return {provider:'https',kind:'file',url:url.href,path:decodeURIComponent(url.pathname.split('/').at(-1)||'design.json')};
}
export async function remoteBytes(url,{signal,fetcher=fetch,limit=MAX_REMOTE_BYTES}={}){
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(Error('Download timed out. Try again or use a direct file URL.')),20000);
  try{
    let response;try{response=await fetcher(url,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});}catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw Error('Could not download this URL. Check access, connectivity and whether the host allows browser downloads (CORS).');}
    if(!response.ok){if(response.status===403||response.status===429)throw Error('Access or API rate limit prevented loading. Try again later or open a downloaded file.');if(response.status===404)throw Error('Project, ref or file was not found. Private repositories need a separate authentication flow.');throw Error(`Download failed (HTTP ${response.status}).`);}
    if(Number(response.headers.get('Content-Length'))>limit)throw Error(`Download exceeds ${Math.floor(limit/1024/1024)} MiB.`);
    const reader=response.body?.getReader();if(!reader){const bytes=await response.arrayBuffer();if(bytes.byteLength>limit)throw Error('Download exceeds the size limit.');return bytes;}
    const chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Download exceeds the size limit.');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes.buffer;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export const apiJson=async(url,options)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await remoteBytes(url,{...options,limit:8*1024*1024})));
export function githubFile(project,path){
  cleanPath(path.split('/'));
  return {path,url:`${RAW}${segment(project.owner)}/${segment(project.repo)}/${project.commit}/${pathUrl(path)}`,origin:{provider:'github',repository:project.url,commit:project.commit,path,url:`${project.url}/blob/${project.commit}/${pathUrl(path)}`}};
}
const treeCaches=new WeakMap();
export async function githubTree(project,options={}){
  const fetcher=options.fetcher||fetch;if(!treeCaches.has(fetcher))treeCaches.set(fetcher,new Map());const treeCache=treeCaches.get(fetcher);
  const key=`${project.owner}/${project.repo}/${project.commit}`;if(treeCache.has(key))return treeCache.get(key);
  const tree=await apiJson(`${API}${segment(project.owner)}/${segment(project.repo)}/git/trees/${project.commit}?recursive=1`,options);
  if(tree.truncated||!Array.isArray(tree.tree))throw Error('Repository listing is incomplete. Use a smaller repository or an exported IR file.');
  treeCache.set(key,tree.tree);if(treeCache.size>8)treeCache.delete(treeCache.keys().next().value);return tree.tree;
}
export async function githubCommit(repository,revision,options={}){
  const parsed=projectUrl(`https://${repository}`);if(parsed.provider!=='github'||parsed.kind!=='repository')throw Error('Browser dependencies require public GitHub module repositories.');
  if(/^[a-f0-9]{40}$/.test(revision))return {...parsed,commit:revision};
  const commit=await apiJson(`${API}${segment(parsed.owner)}/${segment(parsed.repo)}/commits/${segment(revision)}`,options);
  if(!/^[a-f0-9]{40}$/.test(commit.sha))throw Error('GitHub did not return an immutable dependency commit.');return {...parsed,commit:commit.sha};
}
export async function discoverProject(value,{ref='',signal,fetcher=fetch}={}){
  const project=projectUrl(value,ref);if(project.provider==='https')return {...project,files:[{path:project.path,url:project.url,origin:{provider:'https',url:project.url}}]};
  const options={signal,fetcher},base=`${API}${segment(project.owner)}/${segment(project.repo)}`;
  const commit=await apiJson(`${base}/commits/${segment(project.ref)}`,options);
  if(!/^[a-f0-9]{40}$/.test(commit.sha))throw Error('GitHub did not return an immutable commit identity.');project.commit=commit.sha;
  if(project.kind==='file')return {...project,files:[githubFile(project,project.path)]};
  const tree=await githubTree(project,options);
  const files=tree.filter(f=>f.type==='blob'&&['100644','100755'].includes(f.mode)&&(!project.path||f.path.startsWith(project.path+'/'))&&/\.(?:copper|kicad_pcb|(?:ir|scene)\.json)$|(?:^|\/)electrical[^/]*\.json$/i.test(f.path)&&!/(?:^|\/)(?:\.copper-cache|node_modules|target)\//.test(f.path)).map(f=>({...githubFile(project,f.path),size:f.size}));
  files.sort((a,b)=>Number(!/(?:^|\/)board\.copper$/.test(a.path))-Number(!/(?:^|\/)board\.copper$/.test(b.path))||a.path.localeCompare(b.path));
  return {...project,files};
}
export async function downloadDesign(file,options={}){
  const bytes=await remoteBytes(file.url,options);return {bytes,name:file.path.split('/').at(-1),origin:file.origin};
}
