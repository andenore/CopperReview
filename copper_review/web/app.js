import {compileGithubProject,compileLocalProject,localBoardSources} from './project-compiler.js';
import {randomId,sha256} from './hash.js';
import {discoverProject,downloadDesign,setGithubToken,hasGithubToken,checkGithubToken} from './projects.js';
import {compileInput,electricalInput,cancelCompiler} from './compiler.js';
import {rememberDocument,rememberedDocument} from './documents.js';
import {findDeclaration,displayPath,githubLink} from './source-links.js';
import {createElectricalReview} from './electrical.js';
import {chipify} from './chips.js';
import {createView3d} from './view3d.js';
import {parseVrml,buildSoup,loadBodies,modelKind} from './model3d.js';
import {drawText,textRects} from './silk-text.js';
import {readStep} from './steps.js';
import {generateBodies} from './bodies.js';
import {buildAssembly,validateSheet,sheetFromLock,isAssemblyLock,reconcileProgress,emptyProgress,updateEntry,entryOf,statusOf,lineDone,summarize,validateProgress,makeProgress,pinOne,phaseLabel,phaseHint,ASSEMBLY_SHEET_SCHEMA,ASSEMBLY_PROGRESS_SCHEMA} from './assembly.js';
for(const id of ['category','priority','note-status','assembly-part-status','assembly-filter'])chipify(document.getElementById(id));
import {clone,round,padLabel,engineeringText,distanceToSegment,pointInBox,pointInPolygon,padCorners,boxesOverlap,makeAnnotation,makeReview,validateScene,validateReview,validateIssues,refreshContexts,REVIEW_SCHEMA,READABLE_REVIEW_SCHEMAS,ISSUES_SCHEMA} from './core.js';
const $ = id => document.getElementById(id);
const canvas=$('board-canvas'),ctx=canvas.getContext('2d');
const view3dCanvas=$('view3d-canvas');let view3d=null;
const token=new URLSearchParams(location.hash.slice(1)).get('token') || '';
// The CLI server prints a #token link; it may be reached by loopback or (with --host) a network address over HTTP.
const localServer=!!token&&(['127.0.0.1','localhost','[::1]'].includes(location.hostname)||location.protocol==='http:');
let documentRevision=0,remoteLoad=null,electricalOrigin=null;
let startupReady=Promise.resolve(),documentBaseline='static';
const documentIdentity=data=>data?.input?.sha256||data?.board?.sha256||'empty';
const state={scene:null,selection:{components:[],nets:[],region:null},layers:[],annotations:[],tab:'components',mode:'component',
  zoom:1,offset:[0,0],width:0,height:0,drag:null,editing:null,hoverNet:'',hoverPad:null,trackCopper:[],issues:null,issueSource:null,hiddenLabels:0};
// Electrical review (schematic, power, buses) and layout review (the board) can both be open.
// The mode decides what is shown; "Both" puts them side by side and links their selections.
let mode='layout',syncing=false,sources=null,lastCompile=null;
const electrical=createElectricalReview({message,
  onSelect:sel=>{if(mode==='both')showOnBoard(sel.kind,sel.id,{quiet:true});},
  links:{board:{has:(kind,id)=>!!boardTarget(kind,id),show:(kind,id)=>showOnBoard(kind,id)},
    source:{has:(kind,id)=>!!sourceTarget(kind,id),open:(kind,id)=>openSource(kind,id)}}});
// Both needs a schematic and a board that share parts; an unrelated pair stays apart.
const available=m=>m==='electrical'?electrical.hasModel():m==='both'?!!linkSummary()?.both:m==='assembly'?!!state.scene:true;
// Side panels fold away per mode; Both starts with the board's panels and the schematic list folded.
const PANEL_DEFAULTS={both:{'board-left':true,'board-right':true,'schematic-left':true}};
const folded=(()=>{try{return JSON.parse(localStorage.getItem('copper-review:panels'))||{};}catch{return {};}})();
function applyPanels(){
  for(const button of document.querySelectorAll('.panel-toggle')){
    const panel=button.dataset.panel,left=panel.endsWith('left'),fold=folded[`${mode}:${panel}`]??PANEL_DEFAULTS[mode]?.[panel]??false;
    button.parentElement.classList.toggle('collapsed',fold);button.parentElement.parentElement.classList.toggle(left?'left-collapsed':'right-collapsed',fold);
    button.setAttribute('aria-expanded',String(!fold));button.textContent=left===fold?'›':'‹';button.title=fold?'Show panel':'Hide panel';
  }
}
for(const button of document.querySelectorAll('.panel-toggle'))button.onclick=()=>{
  folded[`${mode}:${button.dataset.panel}`]=button.getAttribute('aria-expanded')==='true';
  try{localStorage.setItem('copper-review:panels',JSON.stringify(folded));}catch{}
  applyPanels();
};
function setMode(next,{remember=true}={}){
  if(!available(next))next=electrical.hasModel()&&!state.scene?'electrical':'layout';
  const changed=next!==mode;mode=next;document.body.dataset.mode=mode;applyPanels();
  electrical.show(mode==='electrical'||mode==='both');$('pcb-review').hidden=mode==='electrical';$('split').hidden=mode!=='both';
  if(mode==='assembly'){setTool('component');renderAssembly();}requestDraw();
  for(const b of document.querySelectorAll('#mode-switch [data-mode]')){const m=b.dataset.mode;b.setAttribute('aria-pressed',String(m===mode));b.disabled=!available(m);
    b.title=m==='both'&&b.disabled&&electrical.hasModel()&&state.scene?'The open schematic and board share no part references':'';}
  $('mode-switch').hidden=!electrical.hasModel()&&!state.scene;
  updateHeading();
  if(remember)try{localStorage.setItem('copper-review:mode',mode);}catch{}
  // The board canvas changes size with the mode; refit once the layout has settled.
  if(changed&&state.scene&&mode!=='electrical')requestAnimationFrame(()=>fit());
}
for(const b of document.querySelectorAll('#mode-switch [data-mode]'))b.onclick=()=>setMode(b.dataset.mode);
/** Parts on the board found by the schematic's names, and the other way round. */
function linkSummary(){
  if(!electrical.hasModel()||!state.scene)return null;
  const model=electrical.model(),board=new Set(state.scene.components.flatMap(c=>[c.source_path,c.reference]));
  const both=[...model.components.keys()].filter(r=>board.has(r)).length;
  return {both,schematicOnly:model.components.size-both,boardOnly:state.scene.components.filter(c=>!model.components.has(c.source_path)&&!model.components.has(c.reference)).length};
}
function updateHeading(){
  const model=electrical.hasModel()?electrical.model():null,scene=state.scene;
  const name=model?.name||scene?.board.name;
  $('board-name').textContent=name||'Open a design to begin';
  showProjectOrigin(mode==='layout'||mode==='assembly'?scene?.board?.origin||null:electricalOrigin||(mode==='both'?scene?.board?.origin:null)||null);
  let meta='';
  if(mode==='both'){const l=linkSummary();meta=`Linked by reference and net name · ${l.both} parts on both${l.schematicOnly?` · ${l.schematicOnly} schematic only`:''}${l.boardOnly?` · ${l.boardOnly} board only`:''} · not checked against source`;}
  else if(mode==='electrical'&&model)meta=`${model.components.size} components · ${model.nets.size} nets · IR ${electrical.input().sha256.slice(0,12)}`;
  else if(scene)meta=`${scene.components.length} components · ${scene.nets.length} nets · ${scene.tracks.length} tracks · ${scene.vias.length} vias · ${scene.board.sha256.slice(0,12)}`;
  $('board-meta').textContent=meta;$('board-meta').title=meta;
  const check=lastCompile?.analysis?.check;$('show-compiler-result').hidden=!lastCompile?.analysis;
  if(check)$('show-compiler-result').textContent=`Compiler check · ${check.passed?'ERC passed':'ERC findings'} · ${(check.diagnostics||[]).length} finding(s)`;
  setEnabled();
}
function showCompilerResult(data){if(data?.analysis)lastCompile=data;updateHeading();}
function compilerReport(){
  const data=lastCompile,content=document.createElement('div');if(!data)return content;
  const analysis=data.analysis,findings=analysis.check?.diagnostics||[];
  const head=document.createElement('p');head.textContent=`CopperScript WASM · ${analysis.check?.passed?'ERC passed':'ERC findings'} · ${findings.length} finding(s)`;content.append(head);
  const origin=document.createElement('p');origin.className='quiet';origin.textContent=`${data.input.source.filename} · ${analysis.compiler.source_revision||'working compiler'}${analysis.compiler.source_modified?' (modified source)':''}`;content.append(origin);
  for(const finding of findings){const row=document.createElement('p');row.textContent=`${finding.severity||''} ${finding.code}: ${finding.message}${finding.location?` (line ${finding.location.line}, column ${finding.location.column})`:''}`;content.append(row);}
  if(data.input.project){const project=document.createElement('p');project.textContent=`Project: ${data.input.project.files?.length||0} source files · ${data.input.project.modules?.length||0} dependency repositories · ${data.input.project.scope}`;content.append(project);}
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Native compiler pin/net queries';pre.textContent=JSON.stringify({components:analysis.components,nets:analysis.nets,pins:analysis.pins},null,2);details.append(summary,pre);content.append(details);
  return content;
}
function showInfo(title,content){$('info-dialog-title').textContent=title;$('info-content').replaceChildren(content);if(!$('info-dialog').open)$('info-dialog').showModal();}
$('info-close').onclick=()=>$('info-dialog').close();
$('show-compiler-result').onclick=()=>showInfo('Compiler check',compilerReport());
$('show-about').onclick=()=>{const box=document.createElement('div');
  for(const text of ['CopperReview inspects CopperScript designs and records review notes for the next iteration. It is read-only: notes never edit the source, the board or solver constraints.',
    'Electrical review draws generated schematic sheets, the power hierarchy and buses from the compiled IR. Values are nominal and states are as declared; there is no simulation, and protocol grouping, power sequencing and device behavior are not validated.',
    'Layout review shows board placement and routing from a CopperScript board export. Routing completeness is never inferred from track counts, and net guides show membership, not verified connections.',
    'In Both, the schematic and the board are linked by reference and net name. Nothing proves the board was built from that exact source.',
    'Assembly tracks a manual build part by part, from the board and an optional CopperScript assembly sheet. Ticks record what was done at the bench; they do not verify placement, orientation or solder joints.',
    'Everything is processed in this browser (or by the local server you started). Notes save in this browser per design revision; export them to keep or share.'])
    {const p=document.createElement('p');p.textContent=text;box.append(p);}
  showInfo('About and limits',box);};
$('show-github-access').onclick=()=>{showProjectDialog();$('github-access').open=true;$('github-token').focus();};
function showProjectOrigin(origin){const label=$('project-origin');label.hidden=!origin;label.textContent=origin?origin.provider==='github'?`${String(origin.repository||'').replace('https://github.com/','')} @ ${String(origin.commit||'').slice(0,12)} · ${origin.path}`:origin.provider==='local'?`${origin.folder}/${origin.path} · local folder`:origin.url:'';label.title=origin?.url||'';}
function loadDocument(data){
  if(data?.schema==='copper-review-electrical/v1'){electrical.load(data);electricalOrigin=data.input.origin||null;sources=data.sources||null;setMode(available('both')?'both':'electrical');}
  else{loadScene(data);electrical.render();setMode(available('both')?'both':'layout');}
  showCompilerResult(data);
}
function beginOpen(){if(remoteLoad){remoteLoad.abort();remoteLoad=null;projectBusy(false);}const revision=++documentRevision;cancelCompiler();$('compiler-cancel').hidden=true;return revision;}
async function openDesignFile(file,{origin=null,prepared=null,revision=beginOpen()}={}){
  if(!file)return;if(file.size>49*1024*1024)throw Error('File exceeds 49 MiB.');
  try{
    await startupReady;if(revision!==documentRevision)return false;const bytes=await file.arrayBuffer();if(revision!==documentRevision)return false;let value;
    if(prepared)value=prepared;
    else if(file.name.toLowerCase().endsWith('.copper')){
      $('compiler-cancel').hidden=false;message('Loading CopperScript WASM and checking source locally…');value=await compileInput(bytes,file.name);
      value.sources={files:{[`workspace/${file.name}`]:new TextDecoder().decode(bytes)},root:'',entry:file.name};
    }else if(file.name.toLowerCase().endsWith('.json')){
      value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(value.schema==='copperscript-ir/v0.1')value=await electricalInput(bytes,file.name);
      // Notes and issue lists belong to an open design (openFiles adds them); a URL can still name one.
      else if(value.schema===ISSUES_SCHEMA||READABLE_REVIEW_SCHEMAS.includes(value.schema)||value.schema==='copper-electrical-review/v1'||value.schema===ASSEMBLY_SHEET_SCHEMA||value.schema===ASSEMBLY_PROGRESS_SCHEMA)
        throw Error(`${file.name} is a ${value.schema===ISSUES_SCHEMA?'CopperScript issue list':value.schema===ASSEMBLY_SHEET_SCHEMA?'CopperScript assembly sheet':value.schema===ASSEMBLY_PROGRESS_SCHEMA?'assembly progress file':'review notes file'}, not a design. Open its design first, then add it with Open → File….`);
    }else{
      if(!localServer)throw Error('Raw KiCad PCB import currently needs the local importer. Open an exported .scene.json in the hosted viewer.');
      const response=await fetch('./api/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Copper-Token':token,'X-Copper-Filename':encodeURIComponent(file.name)},body:bytes});value=await response.json();if(!response.ok)throw Error(value.error);documentBaseline=documentIdentity(value);
    }
    if(revision!==documentRevision)return false;if(origin){if(value.schema==='copper-review-electrical/v1')value.input={...value.input,origin};else if(value.board)value.board={...value.board,origin};}loadDocument(value);try{await rememberDocument(value,documentBaseline,value.schema==='copper-review-electrical/v1'?'electrical':'layout');}catch{message('Design could not be saved in browser storage. Export reviews to keep your notes.',true);return true;}message(`Opened ${file.name}${value.analysis?' · compiled locally with CopperScript WASM':''}`);return true;
  }catch(error){if(revision!==documentRevision)return;throw Error(`${error.message}${state.scene||electrical.hasModel()?' Previous design remains open.':' No design was loaded.'}`);}
  finally{if(revision===documentRevision)$('compiler-cancel').hidden=true;}
}
let projectFiles=[];
function projectBusy(busy){$('project-discover').disabled=busy;$('project-open').disabled=busy;$('project-cancel').hidden=!busy;$('project-url-form').setAttribute('aria-busy',String(busy));}
function cancelProject(){if(remoteLoad){beginOpen();projectBusy(false);$('project-status').textContent='Loading cancelled. Previous design remains open.';}}
function showProjectDialog(){const dialog=$('project-dialog');if(!dialog.open)dialog.showModal();$('project-url').focus();}
$('open-url').onclick=showProjectDialog;$('empty-url').onclick=showProjectDialog;
$('project-close').onclick=()=>{cancelProject();$('project-dialog').close();};$('project-dialog').oncancel=cancelProject;$('project-cancel').onclick=cancelProject;
for(const id of ['project-url','project-ref'])$(id).oninput=()=>{cancelProject();projectFiles=[];$('project-choices').hidden=true;$('project-status').textContent='';};
async function openRemoteFile(file,revision,controller){
  $('project-status').textContent=`Downloading ${file.path}…`;
  const downloaded=await downloadDesign(file,{signal:controller.signal});if(controller.signal.aborted||revision!==documentRevision)return;
  $('project-status').textContent=downloaded.name.endsWith('.copper')?'Compiling with CopperScript WASM…':'Opening design…';
  const prepared=downloaded.name.endsWith('.copper')&&downloaded.origin.provider==='github'?await compileGithubProject(file,downloaded.bytes,{signal:controller.signal,onProgress:text=>{if(revision===documentRevision)$('project-status').textContent=text;}}):null;
  if(controller.signal.aborted||revision!==documentRevision)return;
  if(await openDesignFile(new File([downloaded.bytes],downloaded.name),{origin:downloaded.origin,prepared,revision})){$('project-status').textContent='';$('project-dialog').close();}
}
async function projectAction(action){
  const revision=beginOpen(),controller=new AbortController();remoteLoad=controller;projectBusy(true);
  try{await action(revision,controller);}catch(error){if(!controller.signal.aborted&&revision===documentRevision){$('project-status').textContent=error.message;$('project-status').classList.add('error');}}
  finally{controller.abort(Error('Project loading finished.'));if(remoteLoad===controller){remoteLoad=null;projectBusy(false);}}
}
$('project-url-form').onsubmit=event=>{event.preventDefault();projectFiles=[];$('project-choices').hidden=true;$('project-status').classList.remove('error');$('project-status').textContent='Finding designs…';
  projectAction(async(revision,controller)=>{
    const project=await discoverProject($('project-url').value,{ref:$('project-ref').value,signal:controller.signal});if(controller.signal.aborted||revision!==documentRevision)return;
    projectFiles=project.files;if(project.kind==='file'){await openRemoteFile(project.files[0],revision,controller);return;}
    $('project-revision').textContent=`${project.owner}/${project.repo} · ${project.commit}`;
    $('project-files').replaceChildren();for(const [index,file]of projectFiles.entries()){const option=document.createElement('option');option.value=index;option.textContent=file.path;$('project-files').append(option);}
    $('project-choices').hidden=!projectFiles.length;$('project-files').selectedIndex=0;
    $('project-status').textContent=projectFiles.length?`${projectFiles.length} design file(s). Choose the source or export to review; exports are not checked against current source.`:'No design files found. Paste a direct .json or .copper file URL, or compile the project locally and open its electrical IR.';
  });
};
const TOKEN_KEY='copper-review-github-token';
function showTokenState(text='',error=false){const active=hasGithubToken();$('github-token-state').textContent=active?'· token in use':'';$('github-token-forget').hidden=!active;$('github-token-status').textContent=text;$('github-token-status').classList.toggle('error',error);}
function forgetToken(){setGithubToken('');try{sessionStorage.removeItem(TOKEN_KEY);}catch{}$('github-token').value='';}
try{setGithubToken(sessionStorage.getItem(TOKEN_KEY)||'');}catch{}showTokenState();
$('github-token-form').onsubmit=async event=>{event.preventDefault();cancelProject();const value=$('github-token').value.trim();
  try{setGithubToken(value);}catch(error){showTokenState(error.message,true);return;}
  if(!value){forgetToken();showTokenState('Enter a token, or close this section to stay with public repositories.',true);return;}
  $('github-token').value='';showTokenState('Checking token with GitHub…');
  try{const core=await checkGithubToken();try{sessionStorage.setItem(TOKEN_KEY,value);}catch{}showTokenState(`Token accepted · ${core.remaining??'?'} of ${core.limit??'?'} API requests left this hour. Kept until this tab closes.`);}
  catch(error){forgetToken();showTokenState(error.message,true);}
};
$('github-token-forget').onclick=()=>{cancelProject();forgetToken();showTokenState('Token forgotten. Only public repositories will load.');};
$('project-open').onclick=()=>{const file=projectFiles[Number($('project-files').value)];if(file)projectAction((revision,controller)=>openRemoteFile(file,revision,controller));};
/** Open any mix of files: designs first, then reviews and issue lists that belong to them. */
async function openFiles(list){
  const files=[...list];if(!files.length)return;
  const kinds=await Promise.all(files.map(async file=>{
    const lower=file.name.toLowerCase();if(!lower.endsWith('.json')&&!lower.endsWith('.lock'))return {file,kind:'design'};
    if(file.size>50*1024*1024)throw Error(`${file.name} exceeds 50 MiB.`);
    const bytes=await file.arrayBuffer();
    let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error(`${file.name} is not valid JSON.`);}
    if(lower.endsWith('.lock')){if(!isAssemblyLock(value))throw Error(`${file.name} is not a CopperScript assembly.lock.`);return {file,kind:'assembly-lock',value,sha256:await sha256(bytes)};}
    const kind=value?.schema===ISSUES_SCHEMA?'issues':value?.schema&&isAssemblyLock(value)?'assembly-lock':value?.schema===ASSEMBLY_SHEET_SCHEMA?'assembly-sheet':value?.schema===ASSEMBLY_PROGRESS_SCHEMA?'assembly-progress':READABLE_REVIEW_SCHEMAS.includes(value?.schema)?'layout-review':value?.schema==='copper-electrical-review/v1'?'electrical-review':'design';
    return {file,kind,value};
  }));
  for(const {file}of kinds.filter(k=>k.kind==='design'))await openDesignFile(file);
  for(const {file,kind,value,sha256:digest}of kinds.filter(k=>k.kind!=='design')){
    if(kind==='issues'){if(!state.scene)throw Error(`Open the board before the issue list ${file.name}.`);loadIssues(value);}
    else if(kind.startsWith('assembly-')){const what={'assembly-sheet':'sheet','assembly-lock':'lock','assembly-progress':'progress'}[kind];
      if(!state.scene)throw Error(`Open the board before the assembly ${what} ${file.name}.`);
      if(kind==='assembly-progress'?loadAssemblyProgress(value):loadAssemblySheet(kind==='assembly-lock'?sheetFromLock(value,digest||await sha256(await file.arrayBuffer())):value))setMode('assembly');}
    else if(kind==='layout-review'){if(!state.scene)throw Error(`Open the board before the review ${file.name}.`);loadLayoutReview(value);setMode(mode==='electrical'?'layout':mode);}
    else{if(!electrical.hasModel())throw Error(`Open the schematic before the review ${file.name}.`);electrical.importReview(value);setMode(mode==='layout'?'electrical':mode);message(`Loaded electrical review ${file.name}`);}
  }
}
$('any-file').onchange=guarded(async e=>{const files=[...e.target.files];e.target.value='';await openFiles(files);});
for(const id of ['open-file','empty-open'])$(id).onclick=()=>$('any-file').click();
$('empty-folder').onclick=()=>$('folder-files').click();
// A local project folder: only CopperScript sources and manifests are read; nothing is uploaded.
let folderFiles=null,folderName='',folderRoot=null,folderLocks=new Map();
$('open-folder').onclick=()=>$('folder-files').click();
$('folder-files').onchange=guarded(async e=>{
  const picked=[...e.target.files];e.target.value='';if(!picked.length)return;
  folderName=picked[0].webkitRelativePath.split('/')[0]||'folder';folderRoot=null;folderFiles=new Map();folderLocks=new Map();
  for(const file of picked){const path=file.webkitRelativePath?file.webkitRelativePath.split('/').slice(1).join('/'):file.name;if(/(?:^|\/)(?:\.git|\.copper-cache|node_modules|target)\//.test(path))continue;
    if(path.endsWith('.copper')||/(?:^|\/)copper\.(?:mod|lock)$/.test(path))folderFiles.set(path,file);else if(/(?:^|\/)assembly\.lock$/.test(path))folderLocks.set(path,file);}
  const boards=await localBoardSources(folderFiles);
  if(!boards.length)throw Error(`No board source in ${folderName}. Choose the folder that holds board.copper and copper.mod.`);
  if(boards.length===1){await openLocalBoard(boards[0]);return;}
  const list=$('folder-boards');list.replaceChildren();for(const path of boards){const option=document.createElement('option');option.value=option.textContent=path;list.append(option);}list.selectedIndex=0;$('folder-dialog').showModal();list.focus();
});
async function openLocalBoard(path){
  const revision=beginOpen(),file=folderFiles.get(path),bytes=await file.arrayBuffer();
  // The lock needs only the board, so the Assembly mode has it even if compilation fails.
  await readProjectLock(path);
  $('compiler-cancel').hidden=false;message(`Compiling ${folderName}/${path} with CopperScript WASM…`);
  let prepared;
  try{prepared=await compileLocalProject(folderFiles,path,new Uint8Array(bytes),{onProgress:text=>{if(revision===documentRevision)message(text);}});}
  catch(error){if(revision!==documentRevision)return;$('compiler-cancel').hidden=true;throw Error(`${error.message}${state.scene||electrical.hasModel()?' Previous design remains open.':''}`);}
  if(revision!==documentRevision)return;
  await openDesignFile(new File([bytes],path.split('/').pop()),{origin:{provider:'local',folder:folderName,path,...(folderRoot?{root:folderRoot}:{})},prepared,revision});
}
/** A project served with `copper-review --project`: read its sources fresh and compile them, so a reload recompiles. */
async function openServedProject(project){
  const files=new Map();message(`Reading ${project.files.length} project file(s) from ${project.name}…`);
  await Promise.all(project.files.map(async f=>{const response=await fetch(`./api/project/file?path=${encodeURIComponent(f.path)}`,{headers:{'X-Copper-Token':token},cache:'no-store'});if(!response.ok)throw Error(`Could not read ${f.path} from the server.`);files.set(f.path,new Blob([await response.arrayBuffer()]));}));
  const lockFile=([path])=>/(?:^|\/)assembly\.lock$/.test(path);
  folderFiles=new Map([...files].filter(f=>!lockFile(f)).sort(([a],[b])=>a.localeCompare(b)));folderLocks=new Map([...files].filter(lockFile));folderName=project.name;folderRoot=project.root||null;
  const boards=project.board?[project.board]:await localBoardSources(folderFiles);
  if(!boards.length)throw Error(`No board source in ${project.name}.`);
  if(boards.length===1){await openLocalBoard(boards[0]);return;}
  const list=$('folder-boards');list.replaceChildren();for(const path of boards){const option=document.createElement('option');option.value=option.textContent=path;list.append(option);}list.selectedIndex=0;$('folder-dialog').showModal();list.focus();
}
$('folder-open').onclick=guarded(async()=>{const path=$('folder-boards').value;$('folder-dialog').close();if(path)await openLocalBoard(path);});
$('folder-boards').ondblclick=()=>$('folder-open').click();
$('folder-close').onclick=()=>$('folder-dialog').close();
$('compiler-cancel').onclick=()=>{beginOpen();$('compiler-cancel').hidden=true;message('Compilation cancelled. Previous design remains open.');};
$('empty-example').onclick=()=>$('compiler-example').click();
$('compiler-example').onclick=guarded(async()=>{const response=await fetch(new URL('./example.copper',import.meta.url));if(!response.ok)throw Error('Example is unavailable.');await openDesignFile(new File([await response.arrayBuffer()],'example.copper'));});
// Board colours per theme. The canvas cannot read the stylesheet, so they sit here beside its tokens.
const BOARD_COLORS={
  dark:{layers:['#e5906d','#77a9dd','#be96dd','#75c9a5','#d0be76','#69c6cf'],board:'#0d171b',padText:'#2a2721',focus:'#fff0b6',label:'#c1d0d5',
    cited:'#ffd27a',issue:'#ff7a7a',grid:'#26353d',edge:'#9abfba',keepout:'#d486ac',graphic:'#779099',courtyard:'#8c829c',fab:'#a7b8bd',padless:'#27363b',
    outline:'#ffe9a6',done:'#7fd18b',via:'#bba5d7',guideFocus:'#c6fff0',guide:'#6e9eab',regionDone:'#526662',region:'#c19562',selectFill:'#82d5c019',selectLine:'#84d4c0'},
  light:{layers:['#c4502f','#2f6fb8','#8350bd','#23885e','#9c7c12','#178892'],board:'#eef1ec',padText:'#ffffff',focus:'#e07b00',label:'#2c393e',
    cited:'#b07d00',issue:'#cc3a3a',grid:'#d9dfdb',edge:'#3f5e59',keepout:'#ad3f78',graphic:'#7c8f95',courtyard:'#8577a3',fab:'#62757b',padless:'#c3ccd0',
    outline:'#c46d00',done:'#2e8b4a',via:'#6f55a0',guideFocus:'#0f7c66',guide:'#7fa3ac',regionDone:'#9aaba7',region:'#b06b2c',selectFill:'#16806a1f',selectLine:'#16806a'}};
const darkTheme=()=>document.documentElement.dataset.theme==='dark';
let colors=BOARD_COLORS[darkTheme()?'dark':'light'];
function setTheme(dark){
  document.documentElement.dataset.theme=dark?'dark':'light';colors=BOARD_COLORS[dark?'dark':'light'];
  $('theme-toggle').setAttribute('aria-checked',String(dark));
  try{localStorage.setItem('copper-review:theme',dark?'dark':'light');}catch{}
  requestDraw();view3d?.draw();
}
$('theme-toggle').setAttribute('aria-checked',String(darkTheme()));
$('theme-toggle').onclick=()=>setTheme(!darkTheme());
const copperColor = layer => colors.layers[Math.max(0,state.scene.board.layers.indexOf(layer))%colors.layers.length];
const visible = layers => layers.some(l=>state.layers.includes(l));
let messageTimer,frame;
function message(text,error=false) {
  $('message').textContent=text; $('message').classList.toggle('error',error); $('message').hidden=false;
  clearTimeout(messageTimer); messageTimer=setTimeout(()=>$('message').hidden=true,error?8000:3500);
}
function guarded(action) {return async (...args)=>{try{await action(...args);}catch(e){message(e.message,true);}};}
function requestDraw() {if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
function world(event) {const rect=canvas.getBoundingClientRect();return [(event.clientX-rect.left-state.offset[0])/state.zoom,(event.clientY-rect.top-state.offset[1])/state.zoom];}
function screen(event) {const rect=canvas.getBoundingClientRect();return [event.clientX-rect.left,event.clientY-rect.top];}
function fit(bounds=state.scene?.board.bounds_mm) {
  if(!bounds)return;
  const width=Math.max(2,bounds[2]-bounds[0]),height=Math.max(2,bounds[3]-bounds[1]);
  state.zoom=Math.min((state.width-80)/width,(state.height-80)/height);
  state.zoom=Math.max(.05,state.zoom);
  state.offset=[state.width/2-(bounds[0]+bounds[2])/2*state.zoom,(state.height-20)/2-(bounds[1]+bounds[3])/2*state.zoom];
  state.fitted=bounds===state.scene?.board.bounds_mm;
  requestDraw();
}
function path(points,closed=false) {
  if(!points.length)return;
  ctx.beginPath();ctx.moveTo(...points[0]);for(const p of points.slice(1))ctx.lineTo(...p);if(closed)ctx.closePath();
}
function buildTrackCopper(tracks) {
  const groups=new Map();
  for(const track of tracks) {
    const key=JSON.stringify([track.layer,track.net]);
    if(!groups.has(key))groups.set(key,{layer:track.layer,net:track.net,path:new Path2D(),segments:new Map()});
    const segments=groups.get(key).segments;
    for(let i=1;i<track.points_mm.length;i++) {
      let a=track.points_mm[i-1],b=track.points_mm[i];
      if(a[0]>b[0] || (a[0]===b[0] && a[1]>b[1]))[a,b]=[b,a];
      segments.set(JSON.stringify([track.width_mm,a,b]),{a,b,r:track.width_mm/2});
    }
  }
  for(const group of groups.values()) {
    const copper=group.path;
    // A physical round-ended track is the union of capsules along its segments.
    // All contours wind the same way, so one nonzero fill paints intersections
    // once, even with different widths, branches, reversed or duplicate tracks.
    // Canonical directions/order and duplicate removal also keep antialiasing
    // stable when the source lists the same copper in a different order.
    for(const [,segment] of [...group.segments].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      const {a:[ax,ay],b:[bx,by],r}=segment;
      const angle=Math.atan2(by-ay,bx-ax),start=angle-Math.PI/2;
      copper.moveTo(ax+r*Math.cos(start),ay+r*Math.sin(start));
      copper.lineTo(bx+r*Math.cos(start),by+r*Math.sin(start));
      copper.arc(bx,by,r,start,start+Math.PI);
      copper.lineTo(ax-r*Math.cos(start),ay-r*Math.sin(start));
      copper.arc(ax,ay,r,start+Math.PI,start+2*Math.PI);
      copper.closePath();
    }
    delete group.segments;
  }
  return [...groups.values()];
}
function isNetFocused(net) {return !!net && (net===state.hoverNet || state.selection.nets.includes(net));}
function renderNet(net) {return !$('isolate').checked || !state.selection.nets.length || state.selection.nets.includes(net);}
function opacity(net,selected=false) {return selected || isNetFocused(net) ? 1 : state.hoverNet || state.selection.nets.length ? .22 : .85;}
// Pointing at the board only names what is under the cursor; a net highlights from the list.
function setHover(found={},highlight=false) {
  const net=found.net && renderNet(found.net) ? found.net : '',pad=found.pad?.id || null,shown=highlight?net:'';
  canvas.dataset.hoverNet=net;
  if(shown!==state.hoverNet || pad!==state.hoverPad){state.hoverNet=shown;state.hoverPad=pad;requestDraw();}
}
function clearHover(){setHover();$('hover-info').hidden=true;}
function graphic(g,color) {
  ctx.strokeStyle=color;ctx.lineWidth=Math.max(g.width_mm || .1,.8/state.zoom);ctx.setLineDash([]);path(g.points);
  if(g.filled){ctx.fillStyle=color;ctx.globalAlpha*=.25;ctx.fill();ctx.globalAlpha/= .25;}ctx.stroke();
}
function padPath(p) {
  const [w,h]=p.size_mm;
  ctx.beginPath();
  if(p.shape==='circle')ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);
  else if(p.shape==='oval')ctx.roundRect(-w/2,-h/2,w,h,Math.min(w,h)/2);
  else if(p.shape==='roundrect')ctx.roundRect(-w/2,-h/2,w,h,Math.min(w,h)*p.roundrect_ratio);
  else ctx.rect(-w/2,-h/2,w,h);
}
function drawPadLabel(component,pad,selected) {
  if(!$('show-pad-labels').checked || (!pad.layers.length && !pad.number))return;
  const [x,y]=pad.position_mm,small=Math.min(...pad.size_mm)*state.zoom;
  const hovered=pad.id===state.hoverPad,expanded=hovered || selected || isNetFocused(pad.net);
  ctx.save();ctx.globalAlpha=opacity(pad.net,selected && !state.hoverNet);ctx.textBaseline='middle';ctx.setLineDash([]);
  if(small>=14){ctx.font=`${Math.min(11,small*.45)/state.zoom}px ui-monospace,Consolas,monospace`;ctx.fillStyle=colors.padText;ctx.textAlign='center';ctx.fillText(pad.number,x,y);}
  // Names stay upright and sit outside the pad. Small pads reveal them on hover
  // or component/net focus; overview labels wait until there is readable space.
  if(!(pad.pin_name || pad.net) || (!expanded && (small<8 || Math.max(...pad.size_mm)*state.zoom<24)) || (expanded && !hovered && small<5)){ctx.restore();return;}
  const corners=padCorners(pad),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  const dx=x-component.position_mm[0],dy=y-component.position_mm[1];
  const gap=4/state.zoom;
  let tx=x,ty=y;
  ctx.font=`${10/state.zoom}px ui-monospace,Consolas,monospace`;
  if(Math.abs(dx)>=Math.abs(dy)){ctx.textAlign=dx<0?'right':'left';tx=dx<0?Math.min(...xs)-gap:Math.max(...xs)+gap;}
  else {ctx.textAlign='center';ty=dy<0?Math.min(...ys)-gap-5/state.zoom:Math.max(...ys)+gap+5/state.zoom;}
  const label=padLabel(pad);ctx.lineWidth=3/state.zoom;ctx.strokeStyle=colors.board;ctx.strokeText(label,tx,ty);
  ctx.fillStyle=expanded?colors.focus:colors.label;ctx.fillText(label,tx,ty);ctx.restore();
}
// Reference labels never overlap: selected parts first, then larger bodies; the rest
// wait until zooming in gives them room (the status bar counts them).
function drawReferenceLabels(items) {
  const area=c=>(c.bounds_mm[2]-c.bounds_mm[0])*(c.bounds_mm[3]-c.bounds_mm[1]);
  items.sort((a,b)=>(b[1]-a[1]) || area(b[0])-area(a[0]) || (a[0].reference<b[0].reference?-1:1));
  ctx.font=`${11/state.zoom}px ui-monospace,Consolas,monospace`;ctx.textAlign='center';ctx.textBaseline='bottom';
  const placed=[];let hidden=0;
  for(const [c,selected] of items) {
    const x=c.position_mm[0],y=c.bounds_mm[1]-4/state.zoom;
    const sx=x*state.zoom+state.offset[0],sy=y*state.zoom+state.offset[1],w=ctx.measureText(c.reference).width*state.zoom;
    const box=[sx-w/2-2,sy-13,sx+w/2+2,sy+1];
    if(box[2]<0 || box[0]>state.width || box[3]<0 || box[1]>state.height)continue;
    if(!selected && placed.some(b=>boxesOverlap(b,box))){hidden++;continue;}
    placed.push(box);ctx.globalAlpha=selected?1:.85;ctx.fillStyle=selected?colors.focus:colors.label;ctx.fillText(c.reference,x,y);
  }
  state.hiddenLabels=hidden;canvas.dataset.hiddenLabels=String(hidden);canvas.dataset.shownLabels=String(placed.length);
}
function drawIssues() {
  if(!state.issues || !$('show-issues').checked)return;
  ctx.setLineDash([6/state.zoom,3/state.zoom]);ctx.lineWidth=1.4/state.zoom;ctx.font=`${11/state.zoom}px ui-monospace,Consolas,monospace`;
  ctx.textAlign='left';ctx.textBaseline='bottom';
  for(const issue of state.issues.issues){if(!issue.window_mm)continue;const b=issue.window_mm,cited=citedIssueIds().includes(issue.id);
    ctx.globalAlpha=cited?1:.75;ctx.strokeStyle=cited?colors.cited:colors.issue;ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);
    ctx.fillStyle=ctx.strokeStyle;ctx.fillText(issue.id,b[0],b[1]-2/state.zoom);}
  ctx.setLineDash([]);ctx.globalAlpha=1;
}
function citedIssueIds(){return $('issue-ids').value.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);}
function draw() {
  const dpr=devicePixelRatio || 1;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.clearRect(0,0,state.width,state.height);
  // Screen-space grid uses engineering increments, avoiding dense dots at low zoom.
  const spacing=[.1,.25,.5,1,2,5,10,20,50,100,1000].find(n=>n*state.zoom>=20) || 1000;
  const step=spacing*state.zoom;ctx.fillStyle=colors.grid;
  if(step>0)for(let x=((state.offset[0]%step)+step)%step;x<state.width;x+=step)
    for(let y=((state.offset[1]%step)+step)%step;y<state.height;y+=step)ctx.fillRect(x,y,1,1);
  if(!state.scene)return;
  const scene=state.scene,padLabels=[],referenceLabels=[];ctx.translate(...state.offset);ctx.scale(state.zoom,state.zoom);
  // Assembly mode quiets the copper and shows each part as current, done, still to fit or not tracked.
  const plan=assemblyDrawState(),dim=plan?.18:1;
  // Edge geometry (including inner cutouts) remains visible at all layer settings.
  for(const g of scene.drawings.filter(g=>g.layer==='Edge.Cuts')){ctx.globalAlpha=1;graphic(g,colors.edge);}
  if($('show-zones').checked)for(const z of scene.zones) {
    if(!visible(z.layers) || !renderNet(z.net))continue;
    path(z.points_mm,true);ctx.lineWidth=1/state.zoom;
    ctx.strokeStyle=z.kind==='keepout'?colors.keepout:isNetFocused(z.net)?colors.focus:copperColor(z.layers.find(l=>state.layers.includes(l)));
    ctx.fillStyle=ctx.strokeStyle;
    const actual=['fill','copper'].includes(z.kind);
    ctx.globalAlpha=opacity(z.net)*(actual?(isNetFocused(z.net)?.24:.095):.55)*dim;
    ctx.setLineDash(actual?[]:[4/state.zoom,4/state.zoom]);
    // Native fill polygons link hole contours with retraced, zero-area bridges.
    // Fill the area with even/odd holes, never stroke those internal connectors.
    if(actual)ctx.fill('evenodd');
    else {if(z.kind==='keepout'){ctx.globalAlpha*=.55;ctx.fill('evenodd');ctx.globalAlpha/= .55;}ctx.stroke();}
  }
  ctx.setLineDash([]);
  for(const t of state.trackCopper) {
    if(!state.layers.includes(t.layer) || !renderNet(t.net))continue;
    ctx.globalAlpha=opacity(t.net)*dim;ctx.fillStyle=isNetFocused(t.net)?colors.focus:copperColor(t.layer);
    ctx.fill(t.path,'nonzero');
  }
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const g of scene.drawings.filter(g=>g.layer!=='Edge.Cuts')) {
    const copper=g.layer.endsWith('.Cu');
    if(copper?!state.layers.includes(g.layer):g.layer.startsWith('B.')?!state.layers.includes('B.Cu'):g.layer.startsWith('F.')?!state.layers.includes('F.Cu'):false)continue;
    ctx.globalAlpha=copper?.6:.35;graphic(g,copper?copperColor(g.layer):colors.graphic);
  }
  // Silkscreen text (branding, labels) follows its side like the other silk graphics.
  ctx.globalAlpha=.8;ctx.fillStyle=colors.label;
  for(const text of scene.texts||[])if(state.layers.includes(text.layer.startsWith('B.')?'B.Cu':'F.Cu'))drawText(ctx,text);
  for(const c of scene.components) {
    const role=plan?plan.role(c.reference):null,selected=plan?role==='current':state.selection.components.includes(c.reference);
    const cVisible=state.layers.includes(c.side==='back'?'B.Cu':'F.Cu');
    if(cVisible)for(const g of c.graphics) {
      ctx.globalAlpha=selected?1:plan?.25:.4;
      graphic(g,selected?colors.focus:g.layer.endsWith('CrtYd')?colors.courtyard:colors.fab);
    }
    for(const p of c.pads) {
      if(!p.layers.length && !cVisible)continue;
      if(p.layers.length && (!visible(p.layers) || !renderNet(p.net)))continue;
      ctx.save();ctx.translate(...p.position_mm);ctx.rotate(-p.rotation_deg*Math.PI/180);
      const padSelected=selected && !state.hoverNet;
      ctx.globalAlpha=plan?{current:1,done:.75,todo:.55}[role]??.12:opacity(p.net,padSelected);padPath(p);
      ctx.fillStyle=padSelected || isNetFocused(p.net)?colors.focus:role==='done'?colors.done:p.layers.length?copperColor(p.layers.find(l=>state.layers.includes(l))):colors.padless;
      ctx.fill();
      if(p.drill_mm.length){ctx.beginPath();ctx.ellipse(0,0,p.drill_mm[0]/2,p.drill_mm[1]/2,0,0,Math.PI*2);ctx.fillStyle=colors.board;ctx.fill();}
      ctx.restore();
      padLabels.push([c,p,selected]);
    }
    if(selected){ctx.globalAlpha=1;ctx.strokeStyle=colors.outline;ctx.lineWidth=(plan?.focus===c.reference?3:1.6)/state.zoom;ctx.setLineDash(plan?.focus===c.reference?[]:[5/state.zoom,3/state.zoom]);
      const b=c.bounds_mm;ctx.strokeRect(b[0]-.3,b[1]-.3,b[2]-b[0]+.6,b[3]-b[1]+.6);ctx.setLineDash([]);}
    if(plan?.problem(c.reference)){ctx.globalAlpha=1;ctx.strokeStyle=colors.issue;ctx.lineWidth=1.6/state.zoom;const b=c.bounds_mm;ctx.strokeRect(b[0]-.5,b[1]-.5,b[2]-b[0]+1,b[3]-b[1]+1);}
    // Pin 1 of the part being placed, from its pad numbering: orientation is the usual mistake.
    const one=selected&&plan?pinOne(c):null;
    if(one){ctx.save();ctx.globalAlpha=1;ctx.translate(...one.position_mm);ctx.strokeStyle=colors.issue;ctx.lineWidth=2/state.zoom;ctx.beginPath();ctx.arc(0,0,Math.max(...one.size_mm)/2+.3,0,Math.PI*2);ctx.stroke();ctx.restore();}
    if($('show-labels').checked && cVisible)referenceLabels.push([c,selected]);
  }
  drawReferenceLabels(referenceLabels);
  for(const v of scene.vias) {
    if(!visible(v.layers) || !renderNet(v.net))continue;
    ctx.globalAlpha=opacity(v.net)*dim;ctx.fillStyle=isNetFocused(v.net)?colors.focus:colors.via;
    ctx.beginPath();ctx.arc(...v.position_mm,v.size_mm/2,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=colors.board;ctx.beginPath();ctx.arc(...v.position_mm,v.drill_mm/2,0,Math.PI*2);ctx.fill();
  }
  if($('show-guides').checked){
    ctx.lineWidth=.8/state.zoom;ctx.setLineDash([3/state.zoom,4/state.zoom]);
    for(const n of scene.nets){if(!renderNet(n.name))continue;const pads=n.pads.filter(p=>visible(p.layers));if(pads.length<2)continue;
      ctx.globalAlpha=isNetFocused(n.name)?.9:.25;ctx.strokeStyle=isNetFocused(n.name)?colors.guideFocus:colors.guide;
      // Logical membership guides only: a stable chain, deliberately no open-net count.
      for(let i=1;i<pads.length;i++){path([pads[i-1].position_mm,pads[i].position_mm]);ctx.stroke();}
    }ctx.setLineDash([]);
  }
  for(const args of padLabels)drawPadLabel(...args);
  ctx.globalAlpha=1;if(!plan)drawIssues();
  if(!plan)for(const a of state.annotations){if(!a.selection.region)continue;const b=a.selection.region;ctx.strokeStyle=a.status==='resolved'?colors.regionDone:colors.region;ctx.lineWidth=1/state.zoom;ctx.setLineDash([3/state.zoom,4/state.zoom]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
  ctx.setLineDash([]);
  if(state.selection.region){const b=state.selection.region;ctx.fillStyle=colors.selectFill;ctx.strokeStyle=colors.selectLine;ctx.lineWidth=1.5/state.zoom;ctx.fillRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
  $('zoom-status').textContent=`${state.zoom.toFixed(1)} px/mm · grid ${spacing} mm${state.hiddenLabels?` · ${state.hiddenLabels} labels hidden (zoom in)`:''}`;
}
function hit(point,forHover=false) {
  if(!state.scene)return {};
  const tol=5/state.zoom;
  for(const c of [...state.scene.components].reverse())for(const p of c.pads) {
    if(p.layers.length ? !visible(p.layers) || !renderNet(p.net) : !state.layers.includes(c.side==='back'?'B.Cu':'F.Cu'))continue;
    if(pointInPolygon(point,padCorners(p)))return {component:c,net:p.net,pad:p};
  }
  if(forHover || state.mode!=='component'){
    for(const v of state.scene.vias)if(visible(v.layers) && renderNet(v.net) && Math.hypot(point[0]-v.position_mm[0],point[1]-v.position_mm[1])<=v.size_mm/2+tol)return {net:v.net,via:v};
    for(const t of state.scene.tracks)if(state.layers.includes(t.layer) && renderNet(t.net) && t.points_mm.slice(1).some((p,i)=>distanceToSegment(point,t.points_mm[i],p)<=t.width_mm/2+tol))return {net:t.net,track:t};
  }
  const component=[...state.scene.components].reverse().find(c=>state.layers.includes(c.side==='back'?'B.Cu':'F.Cu') && pointInBox(point,c.bounds_mm));
  if(component)return {component};
  if((forHover || state.mode==='net') && $('show-zones').checked){const z=[...state.scene.zones].reverse().find(z=>['fill','copper'].includes(z.kind) && visible(z.layers) && renderNet(z.net) && pointInPolygon(point,z.points_mm));if(z)return {net:z.net};}
  return {};
}
function setTool(mode) {state.mode=mode;clearHover();for(const m of ['component','net','region'])$(`mode-${m}`).classList.toggle('active',m===mode);canvas.style.cursor=mode==='region'?'crosshair':'default';}
function clearSelection() {state.selection={components:[],nets:[],region:null};updateSelection();}
function select(kind,name,add=false) {
  if(!add)state.selection={components:[],nets:[],region:null};
  const values=state.selection[kind];const index=values.indexOf(name);
  if(index>=0 && add)values.splice(index,1);else if(index<0)values.push(name);
  updateSelection();
}
function updateSelection() {
  const s=state.selection;const rows=[];
  if(s.components.length)for(const ref of s.components){const c=state.scene.components.find(c=>c.reference===ref);rows.push(`${ref} · ${c.source_path===ref?'':c.source_path+' · '}${c.side}\nX ${c.position_mm[0].toFixed(3)} · Y ${c.position_mm[1].toFixed(3)} mm · ${c.rotation_deg.toFixed(1)}°`);}
  if(s.nets.length)for(const net of s.nets){const n=state.scene.nets.find(n=>n.name===net);rows.push(`Net ${net} · ${n.pads.length} pads`);}
  if(s.region){const b=s.region;rows.push(`Region · X ${b[0].toFixed(3)}…${b[2].toFixed(3)} mm\nY ${b[1].toFixed(3)}…${b[3].toFixed(3)} mm`);}
  $('selection-detail').textContent=rows.join('\n\n') || 'Select a component, net, or drag a region on the board.';
  $('selection-status').textContent=`${s.components.length} components · ${s.nets.length} nets${s.region?' · region':''}`;
  renderEntities();requestDraw();renderSelectionLinks();
  if(mode==='both'&&!syncing)showInSchematic({quiet:true});
}
function renderSelectionLinks(){
  const row=$('selection-links');row.replaceChildren();if(!state.scene)return;
  const target=schematicTarget(),source=boardSourceTarget();
  if(target){const b=document.createElement('button');b.type='button';b.textContent='Show in schematic';b.title='Select it in the electrical review (S)';b.onclick=()=>showInSchematic();row.append(b);}
  if(source){const b=document.createElement('button');b.type='button';b.textContent='Source';b.title='Show where it is declared in the CopperScript source';b.onclick=()=>openSource(source.kind,source.id);row.append(b);}
}
function renderEntities() {
  $('entity-list').replaceChildren();if(!state.scene)return;
  const search=$('search').value.toLowerCase(),nets=state.tab==='nets';
  if(state.tab==='issues'){renderIssues(search);return;}
  const list=nets?state.scene.nets:state.scene.components;
  for(const entity of list){const name=nets?entity.name:entity.reference;
    if(!`${name} ${entity.source_path || ''} ${entity.value || ''}`.toLowerCase().includes(search))continue;
    const button=document.createElement('button');button.className='entity';button.type='button';
    button.classList.toggle('selected',state.selection[nets?'nets':'components'].includes(name));
    const label=document.createElement('span');label.textContent=name;const detail=document.createElement('span');detail.className='secondary';detail.textContent=nets?`${entity.pads.length} pads`:engineeringText(entity.value || entity.side);button.append(label,detail);
    button.title=nets?name:`${entity.source_path}\n${entity.footprint}${entity.native_reference!==undefined?`\nnative reference: "${entity.native_reference}"`:''}`;
    if(nets){button.onpointerenter=()=>setHover({net:name},true);button.onpointerleave=clearHover;button.onfocus=()=>setHover({net:name},true);button.onblur=clearHover;}
    button.onclick=e=>{select(nets?'nets':'components',name,e.shiftKey);if(!nets){const b=entity.bounds_mm;fit([b[0]-5,b[1]-5,b[2]+5,b[3]+5]);}};
    $('entity-list').append(button);
  }
}
function renderIssues(search) {
  if(!state.issues)return;
  for(const issue of state.issues.issues){
    if(!`${issue.id} ${issue.code} ${issue.title} ${issue.nets.join(' ')}`.toLowerCase().includes(search))continue;
    const button=document.createElement('button');button.className='entity';button.type='button';
    button.classList.toggle('selected',citedIssueIds().includes(issue.id));
    const label=document.createElement('span');label.textContent=`${issue.id} · ${issue.code}`;
    const detail=document.createElement('span');detail.className='secondary';detail.textContent=issue.window_mm?`${issue.count}×`:'no position';
    button.append(label,detail);button.title=issue.title;
    button.onclick=e=>{
      const ids=e.shiftKey?citedIssueIds():[];if(!ids.includes(issue.id))ids.push(issue.id);$('issue-ids').value=ids.join(', ');
      if(issue.window_mm){const b=issue.window_mm;if(!e.shiftKey)state.selection={components:[],nets:[],region:null};
        state.selection.region=b.map(round);fit([b[0]-2,b[1]-2,b[2]+2,b[3]+2]);}
      updateSelection();message(`${issue.id}: ${issue.title}`);};
    $('entity-list').append(button);
  }
}
// ---- Linking the schematic and the board ------------------------------------------------------
// Parts match by CopperScript path (the board export's source_path) or reference; nets by name.
const plainNet=name=>String(name).replace(/^\//,'');
const boardPart=ref=>state.scene?.components.find(c=>c.source_path===ref)||state.scene?.components.find(c=>c.reference===ref);
const boardNet=name=>state.scene?.nets.find(n=>n.name===name)||state.scene?.nets.find(n=>plainNet(n.name)===plainNet(name));
function boardTarget(kind,id){
  if(!state.scene||!electrical.hasModel())return null;const model=electrical.model();
  if(kind==='component'){const c=boardPart(id);return c?{components:[c.reference],nets:[]}:null;}
  if(kind==='pin'){const pin=model.pins.get(id),c=pin&&boardPart(pin.component),net=pin?.net&&boardNet(pin.net);return c?{components:[c.reference],nets:net?[net.name]:[]}:null;}
  if(kind==='net'){const n=boardNet(id);return n?{components:[],nets:[n.name]}:null;}
  if(kind==='bus'){const bus=model.buses.find(b=>b.id===id),nets=(bus?.nets||[]).map(boardNet).filter(Boolean).map(n=>n.name);return nets.length?{components:[],nets}:null;}
  return null;
}
function focusBoard(target){
  const boxes=[...target.components.map(r=>state.scene.components.find(c=>c.reference===r)?.bounds_mm),
    ...target.nets.flatMap(n=>(state.scene.nets.find(x=>x.name===n)?.pads||[]).map(p=>[p.position_mm[0],p.position_mm[1],p.position_mm[0],p.position_mm[1]]))].filter(Boolean);
  if(!boxes.length)return;
  const b=[Math.min(...boxes.map(x=>x[0])),Math.min(...boxes.map(x=>x[1])),Math.max(...boxes.map(x=>x[2])),Math.max(...boxes.map(x=>x[3]))];const margin=Math.max(12,(b[2]-b[0])*.6,(b[3]-b[1])*.6);fit([b[0]-margin,b[1]-margin,b[2]+margin,b[3]+margin]);
}
function showOnBoard(kind,id,{quiet=false}={}){
  const target=boardTarget(kind,id);
  if(!target){if(!quiet)message(state.scene?`${id} is not on the board`:'Open a board export to show it on the board',true);return;}
  if(!quiet&&mode==='electrical')setMode('layout');
  syncing=true;try{state.selection={components:target.components,nets:target.nets,region:null};updateSelection();}finally{syncing=false;}
  focusBoard(target);
}
function schematicTarget(){
  if(!electrical.hasModel()||!state.scene)return null;const s=state.selection,model=electrical.model();
  for(const ref of s.components){const c=state.scene.components.find(c=>c.reference===ref);for(const id of [c?.source_path,ref])if(id&&model.components.has(id))return {kind:'component',id};}
  for(const net of s.nets){if(model.nets.has(net))return {kind:'net',id:net};const found=[...model.nets.keys()].find(k=>plainNet(k)===plainNet(net));if(found)return {kind:'net',id:found};}
  return null;
}
function showInSchematic({quiet=false}={}){
  const target=schematicTarget();
  if(!target){if(!quiet)message(electrical.hasModel()?'Not in the schematic':'Open the schematic (IR or .copper) to show it there',true);return;}
  if(!quiet&&mode==='layout')setMode('electrical');electrical.reveal(target.kind,target.id);
}
// ---- Source links -----------------------------------------------------------------------------
function sourceTarget(kind,id){
  if(!sources||!electrical.hasModel())return null;const model=electrical.model();
  const ref=kind==='component'?id:kind==='pin'?model.pins.get(id)?.component:null;
  return ref?findDeclaration(sources,model.ir,'component',ref):kind==='net'?findDeclaration(sources,model.ir,'net',id):null;
}
function boardSourceTarget(){
  const target=schematicTarget();return target&&sourceTarget(target.kind,target.id)?target:null;
}
function openSource(kind,id){
  const found=sourceTarget(kind,id);if(!found){message(`No declaration of ${id} found in the project source`,true);return;}
  $('source-dialog-title').textContent=`${found.path}:${found.line}`;
  $('source-note').textContent=`${kind==='net'?'net':'component'} ${id.split('/').pop()} · found by searching the compiled project source; the IR does not record source lines.`;
  const pre=$('source-text');pre.replaceChildren();
  for(const [i,text]of found.text.split('\n').entries()){const line=document.createElement('span');line.className='source-line';line.dataset.line=String(i+1);line.textContent=text+'\n';if(i+1===found.line)line.classList.add('current');pre.append(line);}
  const links=$('source-links');links.replaceChildren();
  const origin=electricalOrigin,github=githubLink(sources,found.id,found.line,origin,electrical.input()?.project?.modules||[]);
  if(github){const a=document.createElement('a');a.href=github;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open on GitHub';links.append(a);}
  if(origin?.provider==='local'&&origin.root&&found.id.startsWith('workspace/')){const a=document.createElement('a');a.href=`vscode://file/${origin.root.replace(/\\/g,'/').replace(/^\/+/,'')}/${displayPath(sources,found.id)}:${found.line}`;a.textContent='Open in VS Code';links.append(a);}
  if(!$('source-dialog').open)$('source-dialog').showModal();
  pre.querySelector('.current')?.scrollIntoView({block:'center'});
}
$('source-close').onclick=()=>$('source-dialog').close();
function issuesFromForm() {
  const ids=citedIssueIds();if(!ids.length)return [];
  const old=state.editing && state.annotations.find(a=>a.id===state.editing);
  // Editing a note whose citations are unchanged needs no issue list: keep the saved summaries.
  if(!state.issues && old?.context?.issues && JSON.stringify(ids)===JSON.stringify(old.issues || []))return clone(old.context.issues);
  if(!state.issues)throw new Error('Load the CopperScript issue list (Load issues) before citing issue ids.');
  return ids.map(id=>{const issue=state.issues.issues.find(i=>i.id===id);if(!issue)throw new Error(`Issue ${id} is not in the loaded list.`);return issue;});
}
function storageKey(){return `copper-review:v1:${state.scene.board.sha256}`;}
function saveLocal() {
  if(!state.scene)return;
  try {localStorage.setItem(storageKey(),JSON.stringify({schema:'copper-review-local/v1',annotations:state.annotations,summary:$('summary').value,stage:$('stage').value,copperscript_issues:issueSource()}));$('autosave-status').textContent='Saved in this browser · export JSON to share';}
  catch {$('autosave-status').textContent='Local storage unavailable/full · export JSON now';}
}
function renderNotes() {
  $('note-count').textContent=state.annotations.length;$('note-list').replaceChildren();
  if(!state.annotations.length){const p=document.createElement('p');p.className='quiet';p.textContent='Your observations will appear here.';$('note-list').append(p);}
  for(const a of state.annotations){const row=document.createElement('div');row.className='note-row';
    const priority=document.createElement('span');priority.className=`priority ${a.priority}`;priority.textContent=a.priority;
    const button=document.createElement('button');button.className='note';const title=document.createElement('span');title.className='note-title';title.textContent=a.observation;
    const caption=document.createElement('span');caption.className='note-caption';caption.textContent=`${a.category} · ${a.status} · ${[...a.selection.components,...a.selection.nets,a.selection.region?'region':null,a.board_wide?'board-wide':null,...(a.issues || []).map(id=>`issue ${id}`)].filter(Boolean).join(', ')}`;button.append(title,caption);button.onclick=()=>editNote(a);
    const remove=document.createElement('button');remove.className='delete-note';remove.textContent='×';remove.title='Delete annotation';remove.setAttribute('aria-label',`Delete annotation: ${a.observation}`);
    remove.onclick=()=>{state.annotations=state.annotations.filter(n=>n.id!==a.id);if(state.editing===a.id)resetForm();renderNotes();saveLocal();requestDraw();};
    row.append(priority,button,remove);$('note-list').append(row);
  }
}
function editNote(a) {
  state.editing=a.id;state.selection=clone(a.selection);state.layers=[...a.visible_layers];
  $('category').value=a.category;$('priority').value=a.priority;$('observation').value=a.observation;$('desired').value=a.desired_behavior;$('note-status').value=a.status;$('board-wide').checked=a.board_wide;
  $('issue-ids').value=(a.issues || []).join(', ');
  $('save-note').textContent='Save changes';$('cancel-edit').hidden=false;renderLayers();updateSelection();
  if(a.selection.region){const b=a.selection.region;fit([b[0]-3,b[1]-3,b[2]+3,b[3]+3]);}
  else if(a.selection.components.length){const c=state.scene.components.find(c=>c.reference===a.selection.components[0]);const b=c.bounds_mm;fit([b[0]-5,b[1]-5,b[2]+5,b[3]+5]);}
  $('observation').focus();
}
function resetForm() {state.editing=null;$('observation').value='';$('issue-ids').value='';$('desired').value='';$('note-status').value='open';$('board-wide').checked=false;$('save-note').textContent='Add annotation';$('cancel-edit').hidden=true;}
function renderLayers() {
  $('layer-list').replaceChildren();
  for(const layer of state.scene.board.layers){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=state.layers.includes(layer);input.dataset.layer=layer;
    input.onchange=()=>{state.layers=Array.from($('layer-list').querySelectorAll('input:checked')).map(i=>i.dataset.layer);clearHover();requestDraw();};
    const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=copperColor(layer);label.append(input,swatch,document.createTextNode(layer));$('layer-list').append(label);
  }
}
function loadScene(scene) {
  validateScene(scene);if(state.issues)setIssues(null);state.scene=scene;state.trackCopper=buildTrackCopper(scene.tracks);state.layers=[...scene.board.layers];state.annotations=[];clearHover();clearSelection();resetForm();$('summary').value='';$('stage').value=scene.board.stage || 'unknown';
  state.issueSource=null;let raw=null;
  try{raw=localStorage.getItem(storageKey());const saved=JSON.parse(raw || 'null');if(saved){validateReview({schema:REVIEW_SCHEMA,board:{sha256:scene.board.sha256,stage:saved.stage},annotations:saved.annotations},scene);state.annotations=refreshContexts(scene,saved.annotations);$('summary').value=saved.summary || '';$('stage').value=saved.stage;state.issueSource=saved.copperscript_issues || null;}}
  catch{
    // Keep the unreadable notes instead of overwriting them with the next autosave.
    try{if(raw)localStorage.setItem(`${storageKey()}:unreadable:${new Date().toISOString()}`,raw);}catch{}
    message('Saved local notes could not be read; they were kept under an ":unreadable" key. Load an exported review to recover.',true);}
  $('component-count').textContent=scene.components.length;$('net-count').textContent=scene.nets.length;$('empty-state').hidden=true;
  $('warnings').replaceChildren();for(const warning of scene.warnings){const li=document.createElement('li');li.textContent=warning;$('warnings').append(li);}$('warning-count').textContent=`(${scene.warnings.length})`;
  renderLayers();renderEntities();renderNotes();loadAssemblyState();fit();setEnabled();
  if(!view3dCanvas.hidden)show3d(true);
}
function reviewText() {if(!state.scene)throw new Error('Open a board first.');return JSON.stringify(makeReview(state.scene,state.annotations,$('stage').value,$('summary').value,issueSource()),null,2)+'\n';}
function download(name,text,type='application/json') {const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function setEnabled(){for(const id of ['export-scene','export-review','copy-review','export-assembly','save-note','fit','clear'])$(id).disabled=!state.scene;$('electrical-export').disabled=!electrical.hasModel();$('export-menu').disabled=!state.scene&&!electrical.hasModel();}
// The issue list loaded now, else the one recorded with loaded or saved notes.
function issueSource(){return state.issues?.source || state.issueSource || null;}
function setIssues(issues) {
  state.issues=issues;const shown=!!issues;$('tab-issues').hidden=!shown;$('show-issues-label').hidden=!shown;
  $('issue-count').textContent=issues?issues.issues.length:0;if(!shown && state.tab==='issues'){state.tab='components';for(const t of ['components','nets','issues'])$(`tab-${t}`).classList.toggle('active',t==='components');}
  renderEntities();requestDraw();
}
function loadIssues(value){
  const issues=validateIssues(value,state.scene);setIssues(issues);
  message(`Loaded ${issues.issues.length} CopperScript issues${issues.source.board_verified?'':' (no board hash in the file: could not confirm they belong to this board)'}`,!issues.source.board_verified);
}
function loadLayoutReview(value){
  const review=validateReview(value,state.scene);state.annotations=refreshContexts(state.scene,review.annotations);state.issueSource=review.copperscript_issues || null;$('summary').value=review.summary || '';$('stage').value=review.board.stage;
  resetForm();renderNotes();saveLocal();requestDraw();message(`Loaded ${state.annotations.length} layout notes`);
}
$('export-review').onclick=guarded(()=>{download(`${state.scene.board.name}.review.json`,reviewText());message('Layout review exported. Paste its contents into your next LLM prompt.');});
$('electrical-export').onclick=guarded(()=>electrical.exportReview());
$('export-scene').onclick=guarded(()=>download(`${state.scene.board.name}.scene.json`,JSON.stringify(state.scene,null,2)+'\n'));
// The clipboard API needs a secure context; a network address falls back to a selected text area.
$('copy-review').onclick=guarded(async()=>{const text=reviewText();try{await navigator.clipboard.writeText(text);}catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw Error('Copy is unavailable here; use Export review JSON.');}message('Review JSON copied.');});
$('save-note').onclick=guarded(()=>{
  const note=makeAnnotation(state.scene,state.selection,state.layers,{category:$('category').value,priority:$('priority').value,status:$('note-status').value,observation:$('observation').value,desired_behavior:$('desired').value,boardWide:$('board-wide').checked,issues:issuesFromForm()},state.editing || randomId());
  if(state.editing){const i=state.annotations.findIndex(a=>a.id===state.editing);note.created_at=state.annotations[i].created_at;note.updated_at=new Date().toISOString();state.annotations[i]=note;}else state.annotations.push(note);
  renderNotes();saveLocal();resetForm();requestDraw();message('Annotation saved.');
});
$('cancel-edit').onclick=resetForm;$('summary').oninput=saveLocal;$('stage').onchange=saveLocal;
$('search').oninput=renderEntities;
for(const tab of ['components','nets','issues'])$(`tab-${tab}`).onclick=()=>{state.tab=tab;for(const t of ['components','nets','issues'])$(`tab-${t}`).classList.toggle('active',t===tab);renderEntities();};
for(const mode of ['component','net','region'])$(`mode-${mode}`).onclick=()=>setTool(mode);
for(const id of ['show-labels','show-pad-labels','show-guides','show-zones','isolate','show-issues'])$(id).onchange=()=>{clearHover();requestDraw();};
$('issue-ids').oninput=()=>{requestDraw();if(state.tab==='issues')renderEntities();};
// Bodies fetched, read or generated for the open board, kept while it stays open so turning 3D off
// and on again redoes nothing; a STEP problem is kept with them so the message still names it.
let bodyCache={scene:null,bodies:new Map(),stepProblem:''};
async function fetchBody(path,cache=bodyCache){
  if(!localServer)return null;
  const response=await fetch(`/api/board-asset?path=${encodeURIComponent(path)}`,{headers:{'X-Copper-Token':token}});
  if(!response.ok)return null;
  if(modelKind(path)!=='step')return parseVrml(await response.text());
  try{return await readStep(await response.arrayBuffer());}
  catch(error){cache.stepProblem=error.message;return null;} // the generated body stands in
}
async function show3d(on){
  $('view-3d').setAttribute('aria-pressed',String(on));$('view-3d').classList.toggle('active',on);
  canvas.hidden=on;view3dCanvas.hidden=!on;$('view-flip').hidden=!on;if(!on)return;
  const scene=state.scene;
  if(!scene){message('Open a board first.',true);return show3d(false);}
  try{view3d||=createView3d(view3dCanvas);}catch(e){message(`3D view failed: ${e.message}`,true);return show3d(false);}
  if(!view3d){message('This browser has no WebGL.',true);return show3d(false);}
  message('Preparing 3D bodies…');
  if(bodyCache.scene!==scene)bodyCache={scene,bodies:new Map(),stepProblem:''};
  const cache=bodyCache;let bodies,generateError='';
  try{bodies=await loadBodies(scene,{cache:cache.bodies,fetchBody:path=>fetchBody(path,cache),generate:async requests=>{try{return await generateBodies(requests);}catch(e){generateError=e.message;return [];}}});}
  catch(e){message(`3D bodies failed: ${e.message}`,true);return show3d(false);}
  if(state.scene!==scene||view3dCanvas.hidden)return;
  const soup=buildSoup(scene,bodies,undefined,{textRects}),{drawn,approximate,missing}=soup.summary;
  if(!drawn){message(generateError||'This board has no footprint geometry to build 3D bodies from.',true);return show3d(false);}
  view3d.setSoup(soup,scene.board.bounds_mm);
  message(`3D: ${drawn} bodies${approximate?` (${approximate} generated by CopperScript, approximate)`:''}${missing?` · ${missing} without a body`:''}${generateError?` · ${generateError}`:''}${cache.stepProblem?` · STEP models not drawn: ${cache.stepProblem}`:''} · board thickness assumed 1.6 mm`);
}
$('view-3d').onclick=guarded(()=>show3d(view3dCanvas.hidden));
$('view-flip').onclick=()=>view3d?.flip();
$('fit').onclick=()=>{if(!view3dCanvas.hidden&&view3d&&state.scene)view3d.fit(state.scene.board.bounds_mm);else fit();};$('clear').onclick=()=>{clearSelection();resetForm();};
canvas.oncontextmenu=e=>e.preventDefault();
canvas.addEventListener('wheel',e=>{if(!state.scene)return;e.preventDefault();state.fitted=false;const p=world(e),s=screen(e),z=Math.max(.05,Math.min(2500,state.zoom*Math.exp(-e.deltaY*.0015)));state.zoom=z;state.offset=[s[0]-p[0]*z,s[1]-p[1]*z];requestDraw();},{passive:false});
canvas.addEventListener('pointerdown',e=>{
  if(!state.scene || ![0,1,2].includes(e.button))return;e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);
  clearHover();
  const point=world(e),pan=e.button===2 || e.button===1;state.drag={pan,start:point,screen:screen(e),offset:[...state.offset],moved:false};
  if(!pan && mode==='assembly'){const found=hit(point);if(found.component)pickAssemblyPart(found.component.reference);}
  else if(!pan && state.mode==='region'){if(!e.shiftKey)clearSelection();state.selection.region=[...point,...point];updateSelection();}
  else if(!pan){const found=hit(point);if(state.mode==='net' && found.net)select('nets',found.net,e.shiftKey);else if(state.mode==='component' && found.component)select('components',found.component.reference,e.shiftKey);else if(!e.shiftKey)clearSelection();}
});
canvas.addEventListener('pointermove',e=>{
  if(!state.scene)return;const point=world(e);$('cursor').textContent=`X ${point[0].toFixed(3)} mm · Y ${point[1].toFixed(3)} mm`;
  if(state.drag){const drag=state.drag,s=screen(e);drag.moved=true;
    if(drag.pan){state.fitted=false;state.offset=[drag.offset[0]+s[0]-drag.screen[0],drag.offset[1]+s[1]-drag.screen[1]];requestDraw();}
    else if(state.mode==='region'){state.selection.region=[Math.min(drag.start[0],point[0]),Math.min(drag.start[1],point[1]),Math.max(drag.start[0],point[0]),Math.max(drag.start[1],point[1])].map(round);updateSelection();}
  }else{const found=hit(point,true);setHover(found);$('hover-info').hidden=!(found.component || found.net);$('hover-info').textContent=[found.component?.reference,found.pad?`Pad ${padLabel(found.pad)}`:'',found.net?`Net ${found.net}`:'',found.track?`${found.track.layer} · ${found.track.width_mm} mm`:''].filter(Boolean).join(' · ');}
});
function endDrag(e){if(state.drag && state.mode==='region' && !state.drag.pan && state.selection.region && (state.selection.region[2]-state.selection.region[0]<.01 || state.selection.region[3]-state.selection.region[1]<.01)){state.selection.region=null;updateSelection();}state.drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('pointerleave',clearHover);
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.ctrlKey || e.metaKey || e.altKey)return;
  if(mode==='electrical'||mode==='assembly'||mode==='both'&&!e.target.closest?.('#pcb-review')||document.querySelector('dialog[open]'))return;
  const keys={c:'component',n:'net',r:'region'};if(keys[e.key.toLowerCase()])setTool(keys[e.key.toLowerCase()]);if(e.key.toLowerCase()==='f')$('fit').click();if(e.key==='Escape'){clearSelection();resetForm();}});
// A resize (panel folded, splitter, window) refits a fitted board and otherwise keeps the middle of the view in place.
new ResizeObserver(()=>{const rect=canvas.parentElement.getBoundingClientRect();if(!rect.width||!rect.height)return;const first=state.width===0;
  if(!first&&!state.fitted)state.offset=[state.offset[0]+(rect.width-state.width)/2,state.offset[1]+(rect.height-state.height)/2];state.width=rect.width;state.height=rect.height;canvas.width=rect.width*(devicePixelRatio || 1);canvas.height=rect.height*(devicePixelRatio || 1);if((first||state.fitted) && state.scene)fit();else requestDraw();}).observe(canvas.parentElement);
// ---- Assembly: track a manual build part by part ------------------------------------------------
// The plan comes from the board (and the assembly sheet, when one is open); progress is what the
// person at the bench reported, saved per board file in this browser.
const asm={sheet:null,plan:null,progress:null,current:null,focus:null,filter:'all',warnings:[]};
// The assembly.lock beside the board source of an opened project folder, read fresh on each compile.
let projectLock=null;
const assemblyStorageKey=()=>`copper-review:assembly:v1:${state.scene.board.sha256}`;
const currentLine=()=>asm.plan?.lines.find(l=>l.id===asm.current)||null;
const lineOf=ref=>asm.plan?.lines.find(l=>l.items.some(i=>i.reference===ref))||null;
const shortFootprint=f=>String(f||'').split(/[/:]/).pop().replace(/\.kicad_mod$/,'');
const forward=line=>line.phase==='not-fitted'||line.phase==='supplier'?'inspected':'placed';
function assemblyDrawState(){
  if(mode!=='assembly'||!asm.plan)return null;
  const line=currentLine(),current=new Set(line?line.items.map(i=>i.reference):[]);
  return {focus:asm.focus,problem:ref=>!!asm.progress.components[ref]?.problem,
    role:ref=>current.has(ref)?'current':!asm.plan.items.has(ref)?'untracked':statusOf(asm.progress,ref)==='todo'&&asm.plan.items.get(ref).route!=='do not fit'?'todo':'done'};
}
function saveAssembly(){
  if(!state.scene||!asm.plan)return;
  try{localStorage.setItem(assemblyStorageKey(),JSON.stringify({sheet:asm.sheet,progress:asm.progress,current:asm.current,filter:asm.filter}));$('assembly-save-status').textContent='Saved in this browser · export progress to move it to another device';}
  catch{$('assembly-save-status').textContent='Browser storage unavailable or full · export progress now';}
}
/** Build the plan from the board and a sheet, keep the progress of unchanged parts, and say what changed. */
function planAssembly(sheet,saved){
  const plan=buildAssembly(state.scene,sheet),{progress,reset}=reconcileProgress(saved,plan,state.scene),list=(refs,n=12)=>refs.slice(0,n).join(', ')+(refs.length>n?`, +${refs.length-n} more`:'');
  asm.sheet=sheet;asm.plan=plan;asm.progress=progress;asm.focus=null;
  const warnings=[];
  if(sheet)warnings.push(`${sheet.origin==='assembly.lock'?'assembly.lock':'Assembly sheet'} for ${sheet.board} (lock ${String(sheet.lock?.sha256||'').slice(0,12)}). Parts match the board by CopperScript path, then designator; nothing proves the board was built from that source.`);
  if(sheet?.origin==='assembly.lock'){
    warnings.push('Read straight from assembly.lock: copper assembly check has not run here, so selections out of date with the source are not detected. Values come from the board.');
    const unreviewed=sheet.components.filter(c=>!c.reviewed).map(c=>c.reference);
    if(unreviewed.length)warnings.push(`${unreviewed.length} selection(s) not yet reviewed in the lock: ${list(unreviewed)}.`);
    if(sheet.components.some(c=>c.electrical_sha256===null))warnings.push(`Legacy lock (${sheet.lock.schema}): parts have no digest of their own, so progress is kept while the MPN and footprint are unchanged.`);
  }
  else warnings.push('No assembly sheet: parts, values and footprints come from the board file, without MPNs or fit routes. Run copper assembly bom … --assembly-sheet and open the sheet for them.');
  if(plan.unmatched.length)warnings.push(`${plan.unmatched.length} sheet part(s) are not on this board: ${list(plan.unmatched)}.`);
  if(plan.untracked.length)warnings.push(sheet?`${plan.untracked.length} board footprint(s) are not in the sheet (not assembled, or not in the lock): ${list(plan.untracked)}.`:`${plan.untracked.length} footprint(s) without solderable pads are not listed: ${list(plan.untracked)}.`);
  if(reset.length)warnings.push(`Progress cleared for ${reset.length} part(s) whose part identity changed: ${list(reset)}.`);
  asm.warnings=warnings;
  if(!currentLine())asm.current=(plan.lines.find(l=>!lineDone(l,progress))||plan.lines[0])?.id||null;
  return reset;
}
function loadAssemblyState(){
  Object.assign(asm,{sheet:null,plan:null,progress:null,current:null,focus:null,filter:'all',warnings:[]});
  let raw=null;
  try{raw=localStorage.getItem(assemblyStorageKey());const saved=JSON.parse(raw||'null');
    if(saved?.sheet)validateSheet(saved.sheet);
    asm.current=typeof saved?.current==='string'?saved.current:null;asm.filter=['all','remaining','problems'].includes(saved?.filter)?saved.filter:'all';
    planAssembly(saved?.sheet||null,saved?.progress||null);}
  catch{
    try{if(raw)localStorage.setItem(`${assemblyStorageKey()}:unreadable:${new Date().toISOString()}`,raw);}catch{}
    if(raw)message('Saved assembly progress could not be read; it was kept under an ":unreadable" key. Open an exported progress file to recover.',true);
    try{planAssembly(null,null);}catch{asm.plan=null;}}
  $('assembly-filter').value=asm.filter;renderAssembly();applyProjectLock();
}
async function readProjectLock(boardPath){
  const directory=boardPath.split('/').slice(0,-1).join('/'),file=folderLocks.get(directory?`${directory}/assembly.lock`:'assembly.lock');
  projectLock=null;if(!file)return;
  try{const bytes=await file.arrayBuffer(),value=JSON.parse(new TextDecoder().decode(bytes));projectLock={sheet:sheetFromLock(value,await sha256(bytes)),path:file.name};}
  catch(error){message(`The project's assembly.lock could not be read: ${error.message}`,true);return;}
  applyProjectLock();
}
/** Use the project's lock unless a sheet the reviewer opened is in use; a changed lock replaces the old one. */
function applyProjectLock(){
  if(!projectLock||!state.scene||!asm.plan)return;
  const current=asm.sheet;
  if(current&&(current.origin!=='assembly.lock'||current.lock?.sha256===projectLock.sheet.lock.sha256))return;
  try{buildAssembly(state.scene,projectLock.sheet);}catch{return;} // the lock is for another board
  loadAssemblySheet(projectLock.sheet);
}
function loadAssemblySheet(value){
  const sheet=validateSheet(value),recorded=Object.keys(asm.progress?.components||{}).length;
  // Progress recorded from the board alone has no selection identity to carry over to a sheet.
  if(!asm.sheet&&recorded&&!confirm(`Opening the assembly sheet starts the progress again: ${recorded} part record(s) made without a sheet cannot be matched to its selections. Continue?`))return false;
  const reset=planAssembly(sheet,asm.sheet?asm.progress:null);saveAssembly();renderAssembly();requestDraw();
  const s=summarize(asm.plan,asm.progress);
  message(`Assembly sheet: ${s.parts} parts on the board${asm.plan.unmatched.length?`, ${asm.plan.unmatched.length} not on it`:''}${reset.length?` · progress cleared for ${reset.length} changed part(s)`:''}`,asm.plan.unmatched.length>0);
  return true;
}
function loadAssemblyProgress(value){
  const file=validateProgress(value,state.scene),reset=planAssembly(file.sheet||null,file);saveAssembly();renderAssembly();requestDraw();
  message(`Loaded assembly progress for ${Object.keys(asm.progress.components).length} part(s)${reset.length?` · ${reset.length} no longer match their part and were cleared`:''}`,reset.length>0);
  return true;
}
function visibleLines(){
  const {lines}=asm.plan;
  if(asm.filter==='remaining')return lines.filter(l=>!lineDone(l,asm.progress)||l.id===asm.current);
  if(asm.filter==='problems')return lines.filter(l=>l.items.some(i=>entryOf(asm.progress,i.reference).problem)||l.id===asm.current);
  return lines;
}
function lineTitle(line){return line.value||line.mpn||shortFootprint(line.footprint)||line.items[0].designator;}
function renderAssembly(){
  if(!state.scene||!asm.plan){$('assembly-lines').replaceChildren();$('assembly-progress-text').textContent='Open a board to plan its assembly.';renderAssemblyDetail();return;}
  const s=summarize(asm.plan,asm.progress);
  $('assembly-progress-text').textContent=`${s.placed}/${s.to_place} placed · ${s.inspected}/${s.fitted} inspected · ${s.lines_done}/${s.lines} lines done${s.problems?` · ${s.problems} need rework`:''}`;
  $('assembly-bar-fill').style.width=`${(s.to_place?s.placed/s.to_place:s.fitted?s.inspected/s.fitted:0)*100}%`;
  const source=$('assembly-source');source.replaceChildren();
  source.append(document.createTextNode(asm.sheet?`${asm.sheet.origin==='assembly.lock'?'assembly.lock':'Sheet'}: ${asm.sheet.board} · ${asm.sheet.components.length} parts`:'From the board file only · no MPNs or fit routes'));
  const open=document.createElement('button');open.type='button';open.textContent=asm.sheet?'Open another lock or sheet…':'Open assembly.lock…';open.title='assembly.lock, or a sheet from copper assembly bom --assembly-sheet';open.onclick=()=>$('any-file').click();source.append(document.createElement('br'),open);
  const list=$('assembly-lines');list.replaceChildren();let phase=null;
  for(const line of visibleLines()){
    if(line.phase!==phase){phase=line.phase;const head=document.createElement('div');head.className='assembly-phase';head.textContent=phaseLabel(phase);const hint=document.createElement('small');hint.textContent=phaseHint(phase);head.append(hint);list.append(head);}
    const done=line.items.filter(i=>statusOf(asm.progress,i.reference)!=='todo').length,complete=lineDone(line,asm.progress);
    const button=document.createElement('button');button.type='button';button.className='assembly-line';button.classList.toggle('current',line.id===asm.current);button.classList.toggle('done',complete);button.classList.toggle('partial',!complete&&done>0);
    button.setAttribute('aria-current',String(line.id===asm.current));
    const check=document.createElement('span');check.className='line-check';check.textContent=complete?'✓':'';check.setAttribute('aria-hidden','true');
    const body=document.createElement('span');body.className='line-text';const title=document.createElement('span');title.className='line-title';title.textContent=lineTitle(line);
    const caption=document.createElement('span');caption.className='line-caption';caption.textContent=[shortFootprint(line.footprint),line.mpn,line.items.map(i=>i.designator).join(' ')].filter(Boolean).join(' · ');body.append(title,caption);
    const count=document.createElement('span');count.className='line-count';count.textContent=`${done}/${line.items.length}`;
    button.append(check,body,count);
    if(line.items.some(i=>entryOf(asm.progress,i.reference).problem)){const flag=document.createElement('span');flag.className='line-problem';flag.textContent='!';flag.title='A part needs rework';button.append(flag);}
    button.title=`${lineTitle(line)}${complete?' · done':''}`;
    button.onclick=()=>{asm.current=line.id;asm.focus=null;saveAssembly();renderAssembly();requestDraw();};
    list.append(button);
  }
  if(!asm.plan.lines.length){const p=document.createElement('p');p.className='quiet';p.textContent='Nothing to assemble: no part on this board has solderable pads.';list.append(p);}
  $('assembly-warnings').replaceChildren();for(const warning of asm.warnings){const li=document.createElement('li');li.textContent=warning;$('assembly-warnings').append(li);}
  $('assembly-warning-count').textContent=`(${asm.warnings.length})`;
  renderAssemblyDetail();list.querySelector('.assembly-line.current')?.scrollIntoView({block:'nearest'});
}
function renderAssemblyDetail(){
  const line=currentLine(),box=$('assembly-current');box.replaceChildren();
  for(const id of ['assembly-mark','assembly-inspect','assembly-prev','assembly-next','assembly-zoom','assembly-reset'])$(id).disabled=!line;
  $('assembly-refs').replaceChildren();$('assembly-part').hidden=true;
  if(!line){box.textContent=asm.plan?'Choose a line on the left.':'Open a board to plan its assembly.';return;}
  const title=document.createElement('strong');title.textContent=lineTitle(line);box.append(title);
  const facts=document.createElement('dl'),fact=(name,value)=>{if(!value)return;const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;if(value instanceof Node)dd.append(value);else dd.textContent=value;facts.append(dt,dd);};
  fact('Pass',`${phaseLabel(line.phase)} · ${phaseHint(line.phase)}`);
  fact('Quantity',String(line.items.length));fact('Parts',line.items.map(i=>i.designator).join(' '));
  fact('Footprint',shortFootprint(line.footprint));fact('Manufacturer',line.manufacturer);fact('MPN',line.mpn);
  const unreviewed=line.items.filter(i=>i.reviewed===false).length;if(unreviewed)fact('Review',`${unreviewed} of ${line.items.length} not reviewed in the lock`);
  if(line.supplier||line.supplier_part){let value=[line.supplier,line.supplier_part].filter(Boolean).join(' ');
    if(/^https:\/\//.test(line.source_url)){const a=document.createElement('a');a.href=line.source_url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=value||'catalogue';value=a;}fact('Supplier',value);}
  const ones=line.items.filter(i=>pinOne(state.scene.components.find(c=>c.reference===i.reference)||{pads:[]})).length;
  fact('Pin 1',ones?`ringed on the board${ones<line.items.length?` for ${ones} of ${line.items.length}`:''} (pad 1 / A1)`:'no pad numbered 1 or A1');
  box.append(facts);
  const target=forward(line),complete=lineDone(line,asm.progress);
  $('assembly-mark').textContent=complete?(target==='placed'?'Mark not placed':'Undo check'):line.phase==='not-fitted'?'Confirm left empty':target==='inspected'?'Mark inspected':'Mark placed';
  $('assembly-inspect').hidden=target==='inspected';
  $('assembly-inspect').textContent=line.items.every(i=>statusOf(asm.progress,i.reference)==='inspected')?'Undo inspected':'Mark inspected';
  for(const item of line.items){
    const entry=entryOf(asm.progress,item.reference),row=document.createElement('button');row.type='button';row.className='assembly-ref';row.classList.toggle('focused',item.reference===asm.focus);
    const name=document.createElement('span');name.className='ref-name';name.textContent=`${item.designator}${item.side==='back'?' · back':''}`;
    const status=document.createElement('span');status.className=`ref-status ${entry.status}`;status.textContent={todo:line.phase==='not-fitted'?'not checked':'to place',placed:'placed',inspected:line.phase==='not-fitted'?'left empty':'inspected'}[entry.status];
    row.append(name);if(entry.problem){const p=document.createElement('span');p.className='ref-problem';p.textContent='rework';row.append(p);}row.append(status);
    row.title=`${item.path}${entry.note?`\n${entry.note}`:''}\nClick to select · double-click to toggle ${target}`;
    row.onclick=()=>pickAssemblyPart(item.reference);row.ondblclick=()=>setParts([item],statusOf(asm.progress,item.reference)==='todo'?target:'todo');
    $('assembly-refs').append(row);
  }
  const item=asm.focus&&line.items.find(i=>i.reference===asm.focus);
  if(item){const entry=entryOf(asm.progress,item.reference);$('assembly-part').hidden=false;$('assembly-part-title').textContent=`PART ${item.designator}`;
    $('assembly-part-status').value=entry.status;$('assembly-problem').checked=entry.problem;if(document.activeElement!==$('assembly-note'))$('assembly-note').value=entry.note;}
}
function setParts(items,status){
  for(const item of items){const now=statusOf(asm.progress,item.reference);
    // Marking a line placed never downgrades parts already inspected.
    updateEntry(asm.progress,item,{status:status==='placed'&&now==='inspected'?'inspected':status});}
  saveAssembly();renderAssembly();requestDraw();
}
function nextLine(from,test){const lines=visibleLines(),start=lines.findIndex(l=>l.id===from);return lines.slice(start+1).find(test)||null;}
function markCurrent(){
  const line=currentLine();if(!line)return;
  if(lineDone(line,asm.progress)){setParts(line.items,'todo');return;}
  setParts(line.items,forward(line));
  const next=nextLine(line.id,l=>!lineDone(l,asm.progress));if(next){asm.current=next.id;asm.focus=null;saveAssembly();renderAssembly();requestDraw();}
  else if(asm.plan.lines.every(l=>lineDone(l,asm.progress)))message('Every line is done. Inspect the board before powering it.');
}
function inspectCurrent(){
  const line=currentLine();if(!line)return;
  if(line.items.every(i=>statusOf(asm.progress,i.reference)==='inspected')){setParts(line.items,'placed');return;}
  setParts(line.items,'inspected');
  const next=nextLine(line.id,l=>l.items.some(i=>statusOf(asm.progress,i.reference)!=='inspected'));if(next){asm.current=next.id;asm.focus=null;saveAssembly();renderAssembly();requestDraw();}
}
function stepLine(delta){const lines=visibleLines();if(!lines.length)return;const index=lines.findIndex(l=>l.id===asm.current);
  const next=lines[Math.min(lines.length-1,Math.max(0,index<0?0:index+delta))];asm.current=next.id;asm.focus=null;saveAssembly();renderAssembly();requestDraw();}
function zoomLine(){const line=currentLine();if(!line)return;const boxes=line.items.map(i=>state.scene.components.find(c=>c.reference===i.reference)?.bounds_mm).filter(Boolean);if(!boxes.length)return;
  fit([Math.min(...boxes.map(b=>b[0]))-4,Math.min(...boxes.map(b=>b[1]))-4,Math.max(...boxes.map(b=>b[2]))+4,Math.max(...boxes.map(b=>b[3]))+4]);}
function pickAssemblyPart(ref){
  const line=lineOf(ref);if(!line){message(`${ref} is not in the assembly plan.`);return;}
  asm.current=line.id;asm.focus=ref;saveAssembly();renderAssembly();requestDraw();
}
function updateFocused(change){const line=currentLine(),item=line?.items.find(i=>i.reference===asm.focus);if(!item)return;updateEntry(asm.progress,item,change);saveAssembly();renderAssembly();requestDraw();}
$('assembly-mark').onclick=markCurrent;$('assembly-inspect').onclick=inspectCurrent;
$('assembly-prev').onclick=()=>stepLine(-1);$('assembly-next').onclick=()=>stepLine(1);$('assembly-zoom').onclick=zoomLine;
$('assembly-filter').onchange=()=>{asm.filter=$('assembly-filter').value;saveAssembly();renderAssembly();};
$('assembly-part-status').onchange=()=>updateFocused({status:$('assembly-part-status').value});
$('assembly-problem').onchange=()=>updateFocused({problem:$('assembly-problem').checked});
$('assembly-note').oninput=()=>{const line=currentLine(),item=line?.items.find(i=>i.reference===asm.focus);if(!item)return;updateEntry(asm.progress,item,{note:$('assembly-note').value});saveAssembly();
  // Keep typing in place: refresh only the counts and flags, not the note field.
  renderAssembly();};
$('assembly-to-layout').onclick=()=>{const line=currentLine(),item=line?.items.find(i=>i.reference===asm.focus);if(!item)return;const entry=entryOf(asm.progress,item.reference);
  setMode('layout');select('components',item.reference);resetForm();$('category').value='other';
  $('observation').value=`Assembly, ${item.designator} (${lineTitle(line)}): ${entry.note||'needs rework'}`;$('observation').focus();};
$('assembly-reset').onclick=()=>{if(!asm.plan||!confirm('Clear the assembly progress of this board in this browser? Export it first to keep a copy.'))return;asm.progress=emptyProgress(state.scene);saveAssembly();renderAssembly();requestDraw();};
$('export-assembly').onclick=guarded(()=>{if(!asm.plan)throw Error('Open a board first.');download(`${state.scene.board.name}.assembly.json`,JSON.stringify(makeProgress(state.scene,asm.sheet,asm.progress,asm.plan),null,2)+'\n');message('Assembly progress exported. Open it with the same board file to continue elsewhere.');});
canvas.addEventListener('dblclick',e=>{if(mode!=='assembly'||!asm.plan)return;const found=hit(world(e));const item=found.component&&asm.plan.items.get(found.component.reference);if(!item)return;
  const line=lineOf(item.reference);setParts([item],statusOf(asm.progress,item.reference)==='todo'?forward(line):'todo');});
// Bench keys: Space marks the line and moves on, I inspects, J/K or arrows step, Z zooms, P flags rework.
document.addEventListener('keydown',e=>{
  if(mode!=='assembly'||!asm.plan||document.querySelector('dialog[open]')||e.target.closest?.('input,textarea,select,[contenteditable]'))return;
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.target.tagName==='BUTTON'&&(e.key===' '||e.key==='Enter'))return;
  const key=e.key.length===1?e.key.toLowerCase():e.key,actions={' ':markCurrent,i:inspectCurrent,j:()=>stepLine(1),ArrowDown:()=>stepLine(1),k:()=>stepLine(-1),ArrowUp:()=>stepLine(-1),z:zoomLine,f:()=>$('fit').click(),
    p:()=>{if(asm.focus)updateFocused({problem:!entryOf(asm.progress,asm.focus).problem});else message('Click a part first to flag it for rework.');},Escape:()=>{asm.focus=null;renderAssembly();requestDraw();}};
  if(actions[key]){e.preventDefault();actions[key]();}
});
// ---- Menus ------------------------------------------------------------------------------------
function closeMenus(except){for(const list of document.querySelectorAll('.menu-list'))if(list!==except){list.hidden=true;list.previousElementSibling?.setAttribute('aria-expanded','false');}}
for(const menu of document.querySelectorAll('.menu')){const trigger=menu.querySelector(':scope>button'),list=menu.querySelector('.menu-list');
  trigger.onclick=e=>{e.stopPropagation();const open=list.hidden;closeMenus(list);list.hidden=!open;trigger.setAttribute('aria-expanded',String(open));if(open)list.querySelector('button:not([hidden]):not(:disabled)')?.focus();};
  list.addEventListener('click',e=>{if(e.target.closest('button'))closeMenus();});}
document.addEventListener('click',e=>{if(!e.target.closest?.('.menu'))closeMenus();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenus();});
// ---- Drop files anywhere ------------------------------------------------------------------------
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();dragDepth++;$('drop-hint').hidden=false;});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-hint').hidden=true;});
document.addEventListener('drop',guarded(async e=>{e.preventDefault();dragDepth=0;$('drop-hint').hidden=true;
  const items=[...e.dataTransfer.items||[]];if(items.some(i=>i.webkitGetAsEntry?.()?.isDirectory))throw Error('To open a folder, use Open → Project folder…');
  await openFiles(e.dataTransfer.files);}));
// ---- Keys: Ctrl+O opens, E / L / B switch the mode, S shows the selection on the other side ----
document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]')||e.target.closest?.('input,textarea,select,[contenteditable]'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();$('any-file').click();return;}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const key=e.key.toLowerCase(),modes={e:'electrical',l:'layout',b:'both',a:'assembly'};
  if(modes[key]&&available(modes[key])){e.preventDefault();setMode(modes[key]);return;}
  if(key==='s'&&mode!=='assembly'){const inBoard=mode==='layout'||mode==='both'&&e.target.closest?.('#pcb-review');
    if(inBoard)showInSchematic();else{const sel=electrical.selection();if(sel)showOnBoard(sel.kind,sel.id);}e.preventDefault();}
});
// ---- The divider between schematic and board ----------------------------------------------------
{const split=$('split'),workspace=$('workspace');let dragging=null;
  const place=fraction=>{const f=Math.min(.8,Math.max(.2,fraction));workspace.style.setProperty('--split',`${(f*100).toFixed(1)}%`);try{localStorage.setItem('copper-review:split',String(f));}catch{}};
  try{const saved=Number(localStorage.getItem('copper-review:split'));if(saved)workspace.style.setProperty('--split',`${(saved*100).toFixed(1)}%`);}catch{}
  split.addEventListener('pointerdown',e=>{dragging=e.pointerId;split.setPointerCapture(e.pointerId);document.body.classList.add('resizing');});
  split.addEventListener('pointermove',e=>{if(dragging!==e.pointerId)return;const r=workspace.getBoundingClientRect();place((e.clientX-r.left)/r.width);});
  for(const type of ['pointerup','pointercancel'])split.addEventListener(type,()=>{dragging=null;document.body.classList.remove('resizing');if(state.scene)fit();});
  split.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const r=workspace.getBoundingClientRect(),current=$('electrical-review').getBoundingClientRect().width/r.width;place(current+(e.key==='ArrowLeft'?-.05:.05));});}
new ResizeObserver(entries=>document.documentElement.style.setProperty('--topbar-height',`${entries[0].target.getBoundingClientRect().height}px`)).observe(document.querySelector('body>header'));
setMode('layout',{remember:false});
setEnabled();
startupReady=guarded(async()=>{const revision=documentRevision;let data=null,project=null;
  // A #token link on a page that is not the CLI server (a static http host, a stale link) opens as static.
  if(localServer)try{
    const response=await fetch('./api/scene',{headers:{'X-Copper-Token':token}});const scene=await response.json();if(!response.ok)throw new Error(scene.error);
    const served=await fetch('./api/project',{headers:{'X-Copper-Token':token},cache:'no-store'});const listing=await served.json();if(!served.ok)throw new Error(listing.error);
    data=scene;project=listing;documentBaseline=documentIdentity(data);
  }catch(error){message(`Local server unavailable (${error.message}); opened as a static viewer.`,true);}
  let preferred=null;try{preferred=localStorage.getItem('copper-review:mode');}catch{}
  const remembered=async slot=>{try{return await rememberedDocument(documentBaseline,slot);}catch{return null;}};
  // A design opened here since this server input was loaded wins over it, as before; the baseline
  // keeps an unrelated saved design from replacing a new server input.
  const isSchematic=d=>d?.schema==='copper-review-electrical/v1',legacy=project?null:await remembered('last');
  const layout=await remembered('layout')||(isSchematic(legacy)?null:legacy)||(isSchematic(data)?null:data);
  if(layout&&revision===documentRevision)loadDocument(layout);
  // Opening waits for startup to finish; this is startup, so release that wait first.
  if(project){startupReady=null;await openServedProject(project);}
  else{const schematic=await remembered('electrical')||(isSchematic(legacy)?legacy:null)||(isSchematic(data)?data:null);if(schematic&&revision===documentRevision)loadDocument(schematic);}
  // A served schematic and board open side by side; otherwise the mode last chosen here, if any.
  if(data&&project)setMode('both',{remember:false});else if(preferred)setMode(preferred,{remember:false});
})();
