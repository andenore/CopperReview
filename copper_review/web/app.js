import {compileGithubProject,compileLocalProject,localBoardSources} from './project-compiler.js';
import {discoverProject,downloadDesign,setGithubToken,hasGithubToken,checkGithubToken} from './projects.js';
import {compileInput,electricalInput,cancelCompiler} from './compiler.js';
import {rememberDocument,rememberedDocument} from './documents.js';
import {createElectricalReview} from './electrical.js';
import {chipify} from './chips.js';
for(const id of ['category','priority','note-status'])chipify(document.getElementById(id));
import {clone,round,padLabel,engineeringText,distanceToSegment,pointInBox,pointInPolygon,padCorners,boxesOverlap,makeAnnotation,makeReview,validateScene,validateReview,validateIssues,refreshContexts,REVIEW_SCHEMA,READABLE_REVIEW_SCHEMAS,ISSUES_SCHEMA} from './core.js';
const $ = id => document.getElementById(id);
const canvas=$('board-canvas'),ctx=canvas.getContext('2d');
const token=new URLSearchParams(location.hash.slice(1)).get('token') || '';
const localServer=!!token&&['127.0.0.1','localhost','[::1]'].includes(location.hostname);
let documentRevision=0,remoteLoad=null,electricalOrigin=null;
let startupReady=Promise.resolve(),documentBaseline='static';
const documentIdentity=data=>data?.input?.sha256||data?.board?.sha256||'empty';
const state={scene:null,selection:{components:[],nets:[],region:null},layers:[],annotations:[],tab:'components',mode:'component',
  zoom:1,offset:[0,0],width:0,height:0,drag:null,editing:null,hoverNet:'',hoverPad:null,trackCopper:[],issues:null,issueSource:null,hiddenLabels:0};
const electrical=createElectricalReview({message,onMode:(shown,model)=>{
  showProjectOrigin(shown?electricalOrigin:state.scene?.board?.origin);
  for(const id of ['load-review','load-issues','export-scene','export-review'])$(id).hidden=shown;
  $('show-electrical').hidden=!electrical.hasModel()||shown;
  if(shown){$('board-name').textContent=model.name;$('board-meta').textContent='Electrical IR · no layout required';}
  else if(state.scene){$('board-name').textContent=state.scene.board.name;$('board-meta').textContent='PCB geometry review';fit();}
  else{$('board-name').textContent='Open a board to begin';$('board-meta').textContent='Local PCB inspection · no KiCad required';}
}});
function showCompilerResult(data){
  const panel=$('compiler-result');panel.hidden=!data.analysis;if(!data.analysis)return;
  const analysis=data.analysis,findings=analysis.check?.diagnostics||[];
  $('compiler-result-title').textContent=`CopperScript WASM · ${analysis.check?.passed?'ERC passed':'ERC findings'} · ${findings.length} finding(s)`;
  const content=$('compiler-result-content');content.replaceChildren();
  const origin=document.createElement('p');origin.textContent=`${data.input.source.filename} · ${analysis.compiler.source_revision||'working compiler'}${analysis.compiler.source_modified?' (modified source)':''}`;content.append(origin);
  for(const finding of findings){const row=document.createElement('p');row.textContent=`${finding.severity||''} ${finding.code}: ${finding.message}${finding.location?` (line ${finding.location.line}, column ${finding.location.column})`:''}`;content.append(row);}
  if(data.input.project){const project=document.createElement('p');project.textContent=`Project: ${data.input.project.files?.length||0} source files · ${data.input.project.modules?.length||0} dependency repositories · ${data.input.project.scope}`;content.append(project);}
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Native compiler pin/net queries';pre.textContent=JSON.stringify({components:analysis.components,nets:analysis.nets,pins:analysis.pins},null,2);details.append(summary,pre);content.append(details);
}
function showProjectOrigin(origin){const label=$('project-origin');label.hidden=!origin;label.textContent=origin?origin.provider==='github'?`${String(origin.repository||'').replace('https://github.com/','')} @ ${String(origin.commit||'').slice(0,12)} · ${origin.path}`:origin.provider==='local'?`${origin.folder}/${origin.path} · local folder`:origin.url:'';label.title=origin?.url||'';}
function loadDocument(data){if(data?.schema==='copper-review-electrical/v1'){electrical.load(data);electricalOrigin=data.input.origin||null;showProjectOrigin(electricalOrigin);}else {loadScene(data);electrical.show(false);}showCompilerResult(data);}
function beginOpen(){if(remoteLoad){remoteLoad.abort();remoteLoad=null;projectBusy(false);}const revision=++documentRevision;cancelCompiler();$('compiler-cancel').hidden=true;return revision;}
async function openDesignFile(file,electricalOnly=false,{origin=null,prepared=null,revision=beginOpen()}={}){
  if(!file)return;if(file.size>49*1024*1024)throw Error('File exceeds 49 MiB.');
  try{
    await startupReady;if(revision!==documentRevision)return false;const bytes=await file.arrayBuffer();if(revision!==documentRevision)return false;let value;
    if(prepared)value=prepared;
    else if(file.name.toLowerCase().endsWith('.copper')){
      $('compiler-cancel').hidden=false;message('Loading CopperScript WASM and checking source locally…');value=await compileInput(bytes,file.name);
    }else if(file.name.toLowerCase().endsWith('.json')){
      value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(value.schema==='copperscript-ir/v0.1')value=await electricalInput(bytes,file.name);
      else if(value.schema===ISSUES_SCHEMA)throw Error('Use Load issues for issue lists.');
      else if(READABLE_REVIEW_SCHEMAS.includes(value.schema))throw Error('Use Load review for annotation files.');
      else if(electricalOnly&&value.schema!=='copper-review-electrical/v1')throw Error('Expected compiled electrical IR.');
    }else{
      if(electricalOnly)throw Error('Choose electrical IR JSON or .copper source.');
      if(!localServer)throw Error('Raw KiCad PCB import currently needs the local importer. Open an exported .scene.json in the hosted viewer.');
      const response=await fetch('./api/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Copper-Token':token,'X-Copper-Filename':encodeURIComponent(file.name)},body:bytes});value=await response.json();if(!response.ok)throw Error(value.error);documentBaseline=documentIdentity(value);
    }
    if(revision!==documentRevision)return false;if(origin){if(value.schema==='copper-review-electrical/v1')value.input={...value.input,origin};else if(value.board)value.board={...value.board,origin};}loadDocument(value);try{await rememberDocument(value,documentBaseline);}catch{message('Design could not be saved in browser storage. Export reviews to keep your notes.',true);return true;}message(`Opened ${file.name}${value.analysis?' · compiled locally with CopperScript WASM':''}`);return true;
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
  if(await openDesignFile(new File([downloaded.bytes],downloaded.name),false,{origin:downloaded.origin,prepared,revision})){$('project-status').textContent='';$('project-dialog').close();}
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
$('open-electrical').onclick=()=>$('electrical-file').click();
$('electrical-file').onchange=guarded(async e=>{const file=e.target.files[0];e.target.value='';await openDesignFile(file,true);});
// A local project folder: only CopperScript sources and manifests are read; nothing is uploaded.
let folderFiles=null,folderName='';
$('open-folder').onclick=()=>$('folder-files').click();
$('folder-files').onchange=guarded(async e=>{
  const picked=[...e.target.files];e.target.value='';if(!picked.length)return;
  folderName=picked[0].webkitRelativePath.split('/')[0]||'folder';folderFiles=new Map();
  for(const file of picked){const path=file.webkitRelativePath?file.webkitRelativePath.split('/').slice(1).join('/'):file.name;if(/(?:^|\/)(?:\.git|\.copper-cache|node_modules|target)\//.test(path))continue;if(path.endsWith('.copper')||/(?:^|\/)copper\.(?:mod|lock)$/.test(path))folderFiles.set(path,file);}
  const boards=await localBoardSources(folderFiles);
  if(!boards.length)throw Error(`No board source in ${folderName}. Choose the folder that holds board.copper and copper.mod.`);
  if(boards.length===1){await openLocalBoard(boards[0]);return;}
  const list=$('folder-boards');list.replaceChildren();for(const path of boards){const option=document.createElement('option');option.value=option.textContent=path;list.append(option);}list.selectedIndex=0;$('folder-dialog').showModal();list.focus();
});
async function openLocalBoard(path){
  const revision=beginOpen(),file=folderFiles.get(path),bytes=await file.arrayBuffer();
  $('compiler-cancel').hidden=false;message(`Compiling ${folderName}/${path} with CopperScript WASM…`);
  let prepared;
  try{prepared=await compileLocalProject(folderFiles,path,new Uint8Array(bytes),{onProgress:text=>{if(revision===documentRevision)message(text);}});}
  catch(error){if(revision!==documentRevision)return;$('compiler-cancel').hidden=true;throw Error(`${error.message}${state.scene||electrical.hasModel()?' Previous design remains open.':''}`);}
  if(revision!==documentRevision)return;
  await openDesignFile(new File([bytes],path.split('/').pop()),false,{origin:{provider:'local',folder:folderName,path},prepared,revision});
}
$('folder-open').onclick=guarded(async()=>{const path=$('folder-boards').value;$('folder-dialog').close();if(path)await openLocalBoard(path);});
$('folder-boards').ondblclick=()=>$('folder-open').click();
$('folder-close').onclick=()=>$('folder-dialog').close();
$('open-source').onclick=()=>$('source-file').click();
$('source-file').onchange=guarded(async e=>{const file=e.target.files[0];e.target.value='';await openDesignFile(file);});
$('compiler-cancel').onclick=()=>{beginOpen();$('compiler-cancel').hidden=true;message('Compilation cancelled. Previous design remains open.');};
$('compiler-example').onclick=guarded(async()=>{const response=await fetch(new URL('./example.copper',import.meta.url));if(!response.ok)throw Error('Example is unavailable.');await openDesignFile(new File([await response.arrayBuffer()],'example.copper'));});
const palette=['#e5906d','#77a9dd','#be96dd','#75c9a5','#d0be76','#69c6cf'];
const copperColor = layer => palette[Math.max(0,state.scene.board.layers.indexOf(layer))%palette.length];
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
function setHover(found={}) {
  const net=found.net && renderNet(found.net) ? found.net : '',pad=found.pad?.id || null;
  if(net!==state.hoverNet || pad!==state.hoverPad){state.hoverNet=net;state.hoverPad=pad;canvas.dataset.hoverNet=net;requestDraw();}
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
  if(small>=14){ctx.font=`${Math.min(11,small*.45)/state.zoom}px ui-monospace,Consolas,monospace`;ctx.fillStyle='#2a2721';ctx.textAlign='center';ctx.fillText(pad.number,x,y);}
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
  const label=padLabel(pad);ctx.lineWidth=3/state.zoom;ctx.strokeStyle='#0d171b';ctx.strokeText(label,tx,ty);
  ctx.fillStyle=expanded?'#fff0b6':'#c1d0d5';ctx.fillText(label,tx,ty);ctx.restore();
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
    placed.push(box);ctx.globalAlpha=selected?1:.85;ctx.fillStyle=selected?'#fff0b6':'#c1d0d5';ctx.fillText(c.reference,x,y);
  }
  state.hiddenLabels=hidden;canvas.dataset.hiddenLabels=String(hidden);canvas.dataset.shownLabels=String(placed.length);
}
function drawIssues() {
  if(!state.issues || !$('show-issues').checked)return;
  ctx.setLineDash([6/state.zoom,3/state.zoom]);ctx.lineWidth=1.4/state.zoom;ctx.font=`${11/state.zoom}px ui-monospace,Consolas,monospace`;
  ctx.textAlign='left';ctx.textBaseline='bottom';
  for(const issue of state.issues.issues){if(!issue.window_mm)continue;const b=issue.window_mm,cited=citedIssueIds().includes(issue.id);
    ctx.globalAlpha=cited?1:.75;ctx.strokeStyle=cited?'#ffd27a':'#ff7a7a';ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);
    ctx.fillStyle=ctx.strokeStyle;ctx.fillText(issue.id,b[0],b[1]-2/state.zoom);}
  ctx.setLineDash([]);ctx.globalAlpha=1;
}
function citedIssueIds(){return $('issue-ids').value.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);}
function draw() {
  const dpr=devicePixelRatio || 1;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.clearRect(0,0,state.width,state.height);
  // Screen-space grid uses engineering increments, avoiding dense dots at low zoom.
  const spacing=[.1,.25,.5,1,2,5,10,20,50,100,1000].find(n=>n*state.zoom>=20) || 1000;
  const step=spacing*state.zoom;ctx.fillStyle='#26353d';
  if(step>0)for(let x=((state.offset[0]%step)+step)%step;x<state.width;x+=step)
    for(let y=((state.offset[1]%step)+step)%step;y<state.height;y+=step)ctx.fillRect(x,y,1,1);
  if(!state.scene)return;
  const scene=state.scene,padLabels=[],referenceLabels=[];ctx.translate(...state.offset);ctx.scale(state.zoom,state.zoom);
  // Edge geometry (including inner cutouts) remains visible at all layer settings.
  for(const g of scene.drawings.filter(g=>g.layer==='Edge.Cuts')){ctx.globalAlpha=1;graphic(g,'#9abfba');}
  if($('show-zones').checked)for(const z of scene.zones) {
    if(!visible(z.layers) || !renderNet(z.net))continue;
    path(z.points_mm,true);ctx.lineWidth=1/state.zoom;
    ctx.strokeStyle=z.kind==='keepout'?'#d486ac':isNetFocused(z.net)?'#fff0b6':copperColor(z.layers.find(l=>state.layers.includes(l)));
    ctx.fillStyle=ctx.strokeStyle;
    const actual=['fill','copper'].includes(z.kind);
    ctx.globalAlpha=opacity(z.net)*(actual?(isNetFocused(z.net)?.24:.095):.55);
    ctx.setLineDash(actual?[]:[4/state.zoom,4/state.zoom]);
    // Native fill polygons link hole contours with retraced, zero-area bridges.
    // Fill the area with even/odd holes, never stroke those internal connectors.
    if(actual)ctx.fill('evenodd');
    else {if(z.kind==='keepout'){ctx.globalAlpha*=.55;ctx.fill('evenodd');ctx.globalAlpha/= .55;}ctx.stroke();}
  }
  ctx.setLineDash([]);
  for(const t of state.trackCopper) {
    if(!state.layers.includes(t.layer) || !renderNet(t.net))continue;
    ctx.globalAlpha=opacity(t.net);ctx.fillStyle=isNetFocused(t.net)?'#fff0b6':copperColor(t.layer);
    ctx.fill(t.path,'nonzero');
  }
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const g of scene.drawings.filter(g=>g.layer!=='Edge.Cuts')) {
    const copper=g.layer.endsWith('.Cu');
    if(copper?!state.layers.includes(g.layer):g.layer.startsWith('B.')?!state.layers.includes('B.Cu'):g.layer.startsWith('F.')?!state.layers.includes('F.Cu'):false)continue;
    ctx.globalAlpha=copper?.6:.35;graphic(g,copper?copperColor(g.layer):'#779099');
  }
  for(const c of scene.components) {
    const selected=state.selection.components.includes(c.reference);
    const cVisible=state.layers.includes(c.side==='back'?'B.Cu':'F.Cu');
    if(cVisible)for(const g of c.graphics) {
      ctx.globalAlpha=selected?1:.4;
      graphic(g,selected?'#fff0b6':g.layer.endsWith('CrtYd')?'#8c829c':'#a7b8bd');
    }
    for(const p of c.pads) {
      if(!p.layers.length && !cVisible)continue;
      if(p.layers.length && (!visible(p.layers) || !renderNet(p.net)))continue;
      ctx.save();ctx.translate(...p.position_mm);ctx.rotate(-p.rotation_deg*Math.PI/180);
      const padSelected=selected && !state.hoverNet;
      ctx.globalAlpha=opacity(p.net,padSelected);padPath(p);
      ctx.fillStyle=padSelected || isNetFocused(p.net)?'#fff0b6':p.layers.length?copperColor(p.layers.find(l=>state.layers.includes(l))):'#27363b';
      ctx.fill();
      if(p.drill_mm.length){ctx.beginPath();ctx.ellipse(0,0,p.drill_mm[0]/2,p.drill_mm[1]/2,0,0,Math.PI*2);ctx.fillStyle='#0d171b';ctx.fill();}
      ctx.restore();
      padLabels.push([c,p,selected]);
    }
    if(selected){ctx.globalAlpha=1;ctx.strokeStyle='#ffe9a6';ctx.lineWidth=1.6/state.zoom;ctx.setLineDash([5/state.zoom,3/state.zoom]);
      const b=c.bounds_mm;ctx.strokeRect(b[0]-.3,b[1]-.3,b[2]-b[0]+.6,b[3]-b[1]+.6);ctx.setLineDash([]);}
    if($('show-labels').checked && cVisible)referenceLabels.push([c,selected]);
  }
  drawReferenceLabels(referenceLabels);
  for(const v of scene.vias) {
    if(!visible(v.layers) || !renderNet(v.net))continue;
    ctx.globalAlpha=opacity(v.net);ctx.fillStyle=isNetFocused(v.net)?'#fff0b6':'#bba5d7';
    ctx.beginPath();ctx.arc(...v.position_mm,v.size_mm/2,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#0d171b';ctx.beginPath();ctx.arc(...v.position_mm,v.drill_mm/2,0,Math.PI*2);ctx.fill();
  }
  if($('show-guides').checked){
    ctx.lineWidth=.8/state.zoom;ctx.setLineDash([3/state.zoom,4/state.zoom]);
    for(const n of scene.nets){if(!renderNet(n.name))continue;const pads=n.pads.filter(p=>visible(p.layers));if(pads.length<2)continue;
      ctx.globalAlpha=isNetFocused(n.name)?.9:.25;ctx.strokeStyle=isNetFocused(n.name)?'#c6fff0':'#6e9eab';
      // Logical membership guides only: a stable chain, deliberately no open-net count.
      for(let i=1;i<pads.length;i++){path([pads[i-1].position_mm,pads[i].position_mm]);ctx.stroke();}
    }ctx.setLineDash([]);
  }
  for(const args of padLabels)drawPadLabel(...args);
  ctx.globalAlpha=1;drawIssues();
  for(const a of state.annotations){if(!a.selection.region)continue;const b=a.selection.region;ctx.strokeStyle=a.status==='resolved'?'#526662':'#c19562';ctx.lineWidth=1/state.zoom;ctx.setLineDash([3/state.zoom,4/state.zoom]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
  ctx.setLineDash([]);
  if(state.selection.region){const b=state.selection.region;ctx.fillStyle='#82d5c019';ctx.strokeStyle='#84d4c0';ctx.lineWidth=1.5/state.zoom;ctx.fillRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
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
function setMode(mode) {state.mode=mode;clearHover();for(const m of ['component','net','region'])$(`mode-${m}`).classList.toggle('active',m===mode);canvas.style.cursor=mode==='region'?'crosshair':'default';}
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
  renderEntities();requestDraw();
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
    if(nets){button.onpointerenter=()=>setHover({net:name});button.onpointerleave=clearHover;button.onfocus=()=>setHover({net:name});button.onblur=clearHover;}
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
  $('board-name').textContent=scene.board.name;$('board-meta').textContent=`${scene.components.length} components · ${scene.nets.length} nets · ${scene.tracks.length} tracks · ${scene.vias.length} vias · ${scene.board.sha256.slice(0,12)}`;
  $('component-count').textContent=scene.components.length;$('net-count').textContent=scene.nets.length;$('empty-state').hidden=true;
  $('warnings').replaceChildren();for(const warning of scene.warnings){const li=document.createElement('li');li.textContent=warning;$('warnings').append(li);}$('warning-count').textContent=`(${scene.warnings.length})`;
  renderLayers();renderEntities();renderNotes();fit();setEnabled();
}
function reviewText() {if(!state.scene)throw new Error('Open a board first.');return JSON.stringify(makeReview(state.scene,state.annotations,$('stage').value,$('summary').value,issueSource()),null,2)+'\n';}
function download(name,text,type='application/json') {const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function setEnabled(){for(const id of ['load-review','load-issues','export-scene','export-review','copy-review','save-note','fit','clear'])$(id).disabled=!state.scene;}
// The issue list loaded now, else the one recorded with loaded or saved notes.
function issueSource(){return state.issues?.source || state.issueSource || null;}
function setIssues(issues) {
  state.issues=issues;const shown=!!issues;$('tab-issues').hidden=!shown;$('show-issues-label').hidden=!shown;
  $('issue-count').textContent=issues?issues.issues.length:0;if(!shown && state.tab==='issues'){state.tab='components';for(const t of ['components','nets','issues'])$(`tab-${t}`).classList.toggle('active',t==='components');}
  renderEntities();requestDraw();
}
for(const id of ['open-board','empty-open'])$(id).onclick=()=>$('board-file').click();
$('load-review').onclick=()=>$('review-file').click();
$('load-issues').onclick=()=>$('issues-file').click();
$('issues-file').onchange=guarded(async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;if(file.size>20*1024*1024)throw new Error('Issue list exceeds 20 MiB.');
  const issues=validateIssues(JSON.parse(await file.text()),state.scene);setIssues(issues);
  message(`Loaded ${issues.issues.length} CopperScript issues${issues.source.board_verified?'':' (no board hash in the file: could not confirm they belong to this board)'}`,!issues.source.board_verified);
});
$('board-file').onchange=guarded(async event=>{const file=event.target.files[0];event.target.value='';await openDesignFile(file);});
$('review-file').onchange=guarded(async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;if(file.size>50*1024*1024)throw new Error('Review exceeds 50 MiB.');
  const review=validateReview(JSON.parse(await file.text()),state.scene);state.annotations=refreshContexts(state.scene,review.annotations);state.issueSource=review.copperscript_issues || null;$('summary').value=review.summary || '';$('stage').value=review.board.stage;
  resetForm();renderNotes();saveLocal();requestDraw();message(`Loaded ${state.annotations.length} review notes`);
});
$('export-review').onclick=guarded(()=>{download(`${state.scene.board.name}.review.json`,reviewText());message('Review exported. Paste its contents into your next LLM prompt.');});
$('export-scene').onclick=guarded(()=>download(`${state.scene.board.name}.scene.json`,JSON.stringify(state.scene,null,2)+'\n'));
$('copy-review').onclick=guarded(async()=>{await navigator.clipboard.writeText(reviewText());message('Review JSON copied.');});
$('save-note').onclick=guarded(()=>{
  const note=makeAnnotation(state.scene,state.selection,state.layers,{category:$('category').value,priority:$('priority').value,status:$('note-status').value,observation:$('observation').value,desired_behavior:$('desired').value,boardWide:$('board-wide').checked,issues:issuesFromForm()},state.editing || crypto.randomUUID());
  if(state.editing){const i=state.annotations.findIndex(a=>a.id===state.editing);note.created_at=state.annotations[i].created_at;note.updated_at=new Date().toISOString();state.annotations[i]=note;}else state.annotations.push(note);
  renderNotes();saveLocal();resetForm();requestDraw();message('Annotation saved.');
});
$('cancel-edit').onclick=resetForm;$('summary').oninput=saveLocal;$('stage').onchange=saveLocal;
$('search').oninput=renderEntities;
for(const tab of ['components','nets','issues'])$(`tab-${tab}`).onclick=()=>{state.tab=tab;for(const t of ['components','nets','issues'])$(`tab-${t}`).classList.toggle('active',t===tab);renderEntities();};
for(const mode of ['component','net','region'])$(`mode-${mode}`).onclick=()=>setMode(mode);
for(const id of ['show-labels','show-pad-labels','show-guides','show-zones','isolate','show-issues'])$(id).onchange=()=>{clearHover();requestDraw();};
$('issue-ids').oninput=()=>{requestDraw();if(state.tab==='issues')renderEntities();};
$('fit').onclick=()=>fit();$('clear').onclick=()=>{clearSelection();resetForm();};
canvas.oncontextmenu=e=>e.preventDefault();
canvas.addEventListener('wheel',e=>{if(!state.scene)return;e.preventDefault();const p=world(e),s=screen(e),z=Math.max(.05,Math.min(2500,state.zoom*Math.exp(-e.deltaY*.0015)));state.zoom=z;state.offset=[s[0]-p[0]*z,s[1]-p[1]*z];requestDraw();},{passive:false});
canvas.addEventListener('pointerdown',e=>{
  if(!state.scene || ![0,1,2].includes(e.button))return;e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);
  clearHover();
  const point=world(e),pan=e.button===2 || e.button===1;state.drag={pan,start:point,screen:screen(e),offset:[...state.offset],moved:false};
  if(!pan && state.mode==='region'){if(!e.shiftKey)clearSelection();state.selection.region=[...point,...point];updateSelection();}
  else if(!pan){const found=hit(point);if(state.mode==='net' && found.net)select('nets',found.net,e.shiftKey);else if(state.mode==='component' && found.component)select('components',found.component.reference,e.shiftKey);else if(!e.shiftKey)clearSelection();}
});
canvas.addEventListener('pointermove',e=>{
  if(!state.scene)return;const point=world(e);$('cursor').textContent=`X ${point[0].toFixed(3)} mm · Y ${point[1].toFixed(3)} mm`;
  if(state.drag){const drag=state.drag,s=screen(e);drag.moved=true;
    if(drag.pan){state.offset=[drag.offset[0]+s[0]-drag.screen[0],drag.offset[1]+s[1]-drag.screen[1]];requestDraw();}
    else if(state.mode==='region'){state.selection.region=[Math.min(drag.start[0],point[0]),Math.min(drag.start[1],point[1]),Math.max(drag.start[0],point[0]),Math.max(drag.start[1],point[1])].map(round);updateSelection();}
  }else{const found=hit(point,true);setHover(found);$('hover-info').hidden=!(found.component || found.net);$('hover-info').textContent=[found.component?.reference,found.pad?`Pad ${padLabel(found.pad)}`:'',found.net?`Net ${found.net}`:'',found.track?`${found.track.layer} · ${found.track.width_mm} mm`:''].filter(Boolean).join(' · ');}
});
function endDrag(e){if(state.drag && state.mode==='region' && !state.drag.pan && state.selection.region && (state.selection.region[2]-state.selection.region[0]<.01 || state.selection.region[3]-state.selection.region[1]<.01)){state.selection.region=null;updateSelection();}state.drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('pointerleave',clearHover);
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.ctrlKey || e.metaKey || e.altKey)return;
  const keys={c:'component',n:'net',r:'region'};if(keys[e.key.toLowerCase()])setMode(keys[e.key.toLowerCase()]);if(e.key.toLowerCase()==='f')fit();if(e.key==='Escape'){clearSelection();resetForm();}});
new ResizeObserver(()=>{const rect=canvas.parentElement.getBoundingClientRect();const first=state.width===0;state.width=rect.width;state.height=rect.height;canvas.width=rect.width*(devicePixelRatio || 1);canvas.height=rect.height*(devicePixelRatio || 1);if(first && state.scene)fit();else requestDraw();}).observe(canvas.parentElement);
setEnabled();
startupReady=guarded(async()=>{const revision=documentRevision;let data=null;if(localServer){const response=await fetch('./api/scene',{headers:{'X-Copper-Token':token}});data=await response.json();if(!response.ok)throw new Error(data.error);documentBaseline=documentIdentity(data);}try{data=await rememberedDocument(documentBaseline)||data;}catch{}if(data&&revision===documentRevision)loadDocument(data);})();
