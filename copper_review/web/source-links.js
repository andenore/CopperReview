/* Where a part or net is declared in CopperScript source. The IR records no source lines for
 * components and nets yet, so this searches the files the compiler read: the module that owns
 * the scope (PWR/U_CHARGE lives in the module instantiated as PWR), then `component U_CHARGE`
 * or `net NAME` inside it. Results are marked as text matches, not compiler locations. */
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const lineOf=(text,index)=>text.slice(0,index).split('\n').length;

/** The module definition (IR name) that owns a scope such as ['PWR'] or ['A','B']. */
function scopeModule(ir,scope){
  let instances=ir.module_instances||[],definition=null;
  const definitions=new Map((ir.module_definitions||[]).map(d=>[d.name,d]));
  for(const segment of scope){
    const instance=instances.find(i=>i.ref===segment);if(!instance)return null;
    definition=definitions.get(instance.module);if(!definition)return null;
    instances=definition.module_instances||[];
  }
  return definition?.name||null;
}

/** {id, path, line, text} for a component or net path, or null when the source does not name it. */
export function findDeclaration(sources,ir,kind,path){
  if(!sources?.files||!['component','net'].includes(kind)||typeof path!=='string')return null;
  const parts=path.split('/'),name=parts.pop(),files=Object.entries(sources.files);
  let candidates,moduleName=null;
  if(parts.length){
    const owner=scopeModule(ir,parts);if(!owner)return null;
    moduleName=owner.split(/[./]/).pop();
    const declaration=new RegExp(`^[ \\t]*module[ \\t]+${escape(moduleName)}\\b`,'m');
    // Several packages may define a module of that name: prefer files whose path names the
    // definition's qualifier (lib.Regulator → …/lib/…), then the project over dependencies.
    const qualifier=owner.split(/[./]/).slice(0,-1),stems=id=>id.replace(/\.copper$/,'').split('/');
    const rank=id=>(qualifier.some(q=>stems(id).includes(q))?2:0)+(id.startsWith('workspace/')?1:0);
    candidates=files.filter(([,text])=>declaration.test(text)).sort(([a],[b])=>rank(b)-rank(a));
  }else candidates=files.filter(([id])=>id===`workspace/${sources.entry}`);
  const pattern=new RegExp(`\\b${kind}[ \\t]+${escape(name)}\\b`);
  for(const [id,text]of candidates){
    const start=moduleName?text.search(new RegExp(`^[ \\t]*module[ \\t]+${escape(moduleName)}\\b`,'m')):0;
    const found=text.slice(start).search(pattern);
    if(found>=0)return {id,path:displayPath(sources,id),line:lineOf(text,start+found),text};
  }
  return null;
}

/** A source file id as people know it: project-relative, or the dependency's module path. */
export function displayPath(sources,id){
  if(id.startsWith('workspace/'))return (sources.root||'')+id.slice('workspace/'.length);
  if(id.startsWith('dependency/'))return id.slice('dependency/'.length);
  return id;
}

/** A browsable link for a file id and line, when the project came from GitHub. */
export function githubLink(sources,id,line,origin,modules=[]){
  if(id.startsWith('workspace/')&&origin?.provider==='github'&&/^[a-f0-9]{40}$/.test(origin.commit||''))
    return `${origin.repository}/blob/${origin.commit}/${(sources.root||'')+id.slice('workspace/'.length)}#L${line}`;
  if(id.startsWith('dependency/')){
    const rest=id.slice('dependency/'.length),module=modules.find(m=>rest.startsWith(m.module+'/'));
    if(module?.repository&&/^[a-f0-9]{40}$/.test(module.commit||''))return `${module.repository}/blob/${module.commit}/${rest.slice(module.module.length+1)}#L${line}`;
  }
  return null;
}
