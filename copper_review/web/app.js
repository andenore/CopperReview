import {clone,round,engineeringText,distanceToSegment,pointInBox,pointInPolygon,padCorners,makeAnnotation,makeReview,validateScene,validateReview} from './core.js';
const $ = id => document.getElementById(id);
const canvas=$('board-canvas'),ctx=canvas.getContext('2d');
const token=new URLSearchParams(location.hash.slice(1)).get('token') || '';
const state={scene:null,selection:{components:[],nets:[],region:null},layers:[],annotations:[],tab:'components',mode:'component',
  zoom:1,offset:[0,0],width:0,height:0,drag:null,editing:null};
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
function isNetFocused(net) {return state.selection.nets.includes(net);}
function renderNet(net) {return !$('isolate').checked || !state.selection.nets.length || isNetFocused(net);}
function opacity(net,selected=false) {return selected || isNetFocused(net) ? 1 : state.selection.nets.length ? .22 : .85;}
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
function draw() {
  const dpr=devicePixelRatio || 1;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.clearRect(0,0,state.width,state.height);
  // Screen-space grid uses engineering increments, avoiding dense dots at low zoom.
  const spacing=[.1,.25,.5,1,2,5,10,20,50,100,1000].find(n=>n*state.zoom>=20) || 1000;
  const step=spacing*state.zoom;ctx.fillStyle='#26353d';
  if(step>0)for(let x=((state.offset[0]%step)+step)%step;x<state.width;x+=step)
    for(let y=((state.offset[1]%step)+step)%step;y<state.height;y+=step)ctx.fillRect(x,y,1,1);
  if(!state.scene)return;
  const scene=state.scene;ctx.translate(...state.offset);ctx.scale(state.zoom,state.zoom);
  // Edge geometry (including inner cutouts) remains visible at all layer settings.
  for(const g of scene.drawings.filter(g=>g.layer==='Edge.Cuts')){ctx.globalAlpha=1;graphic(g,'#9abfba');}
  if($('show-zones').checked)for(const z of scene.zones) {
    if(!visible(z.layers) || !renderNet(z.net))continue;
    path(z.points_mm,true);ctx.lineWidth=1/state.zoom;
    ctx.strokeStyle=z.kind==='keepout'?'#d486ac':copperColor(z.layers.find(l=>state.layers.includes(l)));
    ctx.fillStyle=ctx.strokeStyle;
    const actual=['fill','copper'].includes(z.kind);
    ctx.globalAlpha=opacity(z.net)*(actual?.17:.55);
    ctx.setLineDash(actual?[]:[4/state.zoom,4/state.zoom]);
    if(actual || z.kind==='keepout'){ctx.globalAlpha*=.55;ctx.fill();ctx.globalAlpha/= .55;}ctx.stroke();
  }
  ctx.setLineDash([]);
  for(const t of scene.tracks) {
    if(!state.layers.includes(t.layer) || !renderNet(t.net))continue;
    ctx.globalAlpha=opacity(t.net);ctx.strokeStyle=isNetFocused(t.net)?'#fff0b6':copperColor(t.layer);
    ctx.lineWidth=t.width_mm;ctx.lineCap='round';ctx.lineJoin='round';path(t.points_mm);ctx.stroke();
  }
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
      ctx.globalAlpha=opacity(p.net,selected);padPath(p);
      ctx.fillStyle=selected || isNetFocused(p.net)?'#fff0b6':p.layers.length?copperColor(p.layers.find(l=>state.layers.includes(l))):'#27363b';
      ctx.fill();
      if(p.drill_mm.length){ctx.beginPath();ctx.ellipse(0,0,p.drill_mm[0]/2,p.drill_mm[1]/2,0,0,Math.PI*2);ctx.fillStyle='#0d171b';ctx.fill();}
      if(state.zoom*Math.min(...p.size_mm)>14 && p.layers.length){ctx.fillStyle='#2a2721';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`${Math.min(.6,Math.min(...p.size_mm)*.45)}px ui-monospace,Consolas,monospace`;ctx.fillText(p.number,0,0);}
      ctx.restore();
    }
    if(selected){ctx.globalAlpha=1;ctx.strokeStyle='#ffe9a6';ctx.lineWidth=1.6/state.zoom;ctx.setLineDash([5/state.zoom,3/state.zoom]);
      const b=c.bounds_mm;ctx.strokeRect(b[0]-.3,b[1]-.3,b[2]-b[0]+.6,b[3]-b[1]+.6);ctx.setLineDash([]);}
    if($('show-labels').checked && cVisible){ctx.globalAlpha=selected?1:.85;ctx.font=`${11/state.zoom}px ui-monospace,Consolas,monospace`;ctx.fillStyle=selected?'#fff0b6':'#c1d0d5';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(c.reference,c.position_mm[0],c.bounds_mm[1]-4/state.zoom);}
  }
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
  ctx.globalAlpha=1;
  for(const a of state.annotations){if(!a.selection.region)continue;const b=a.selection.region;ctx.strokeStyle=a.status==='resolved'?'#526662':'#c19562';ctx.lineWidth=1/state.zoom;ctx.setLineDash([3/state.zoom,4/state.zoom]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
  ctx.setLineDash([]);
  if(state.selection.region){const b=state.selection.region;ctx.fillStyle='#82d5c019';ctx.strokeStyle='#84d4c0';ctx.lineWidth=1.5/state.zoom;ctx.fillRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
  $('zoom-status').textContent=`${state.zoom.toFixed(1)} px/mm · grid ${spacing} mm`;
}
function hit(point) {
  if(!state.scene)return {};
  const tol=5/state.zoom;
  for(const c of [...state.scene.components].reverse())for(const p of c.pads) {
    if(p.layers.length ? !visible(p.layers) || !renderNet(p.net) : !state.layers.includes(c.side==='back'?'B.Cu':'F.Cu'))continue;
    if(pointInPolygon(point,padCorners(p)))return {component:c,net:p.net,pad:p};
  }
  if(state.mode!=='component'){
    for(const v of state.scene.vias)if(visible(v.layers) && renderNet(v.net) && Math.hypot(point[0]-v.position_mm[0],point[1]-v.position_mm[1])<=v.size_mm/2+tol)return {net:v.net,via:v};
    for(const t of state.scene.tracks)if(state.layers.includes(t.layer) && renderNet(t.net) && t.points_mm.slice(1).some((p,i)=>distanceToSegment(point,t.points_mm[i],p)<=t.width_mm/2+tol))return {net:t.net,track:t};
  }
  const component=[...state.scene.components].reverse().find(c=>state.layers.includes(c.side==='back'?'B.Cu':'F.Cu') && pointInBox(point,c.bounds_mm));
  if(component)return {component};
  if(state.mode==='net' && $('show-zones').checked){const z=[...state.scene.zones].reverse().find(z=>['fill','copper'].includes(z.kind) && visible(z.layers) && renderNet(z.net) && pointInPolygon(point,z.points_mm));if(z)return {net:z.net};}
  return {};
}
function setMode(mode) {state.mode=mode;for(const m of ['component','net','region'])$(`mode-${m}`).classList.toggle('active',m===mode);canvas.style.cursor=mode==='region'?'crosshair':'default';}
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
  const list=nets?state.scene.nets:state.scene.components;
  for(const entity of list){const name=nets?entity.name:entity.reference;
    if(!`${name} ${entity.source_path || ''} ${entity.value || ''}`.toLowerCase().includes(search))continue;
    const button=document.createElement('button');button.className='entity';button.type='button';
    button.classList.toggle('selected',state.selection[nets?'nets':'components'].includes(name));
    const label=document.createElement('span');label.textContent=name;const detail=document.createElement('span');detail.className='secondary';detail.textContent=nets?`${entity.pads.length} pads`:engineeringText(entity.value || entity.side);button.append(label,detail);
    button.title=nets?name:`${entity.source_path}\n${entity.footprint}`;
    button.onclick=e=>{select(nets?'nets':'components',name,e.shiftKey);if(!nets){const b=entity.bounds_mm;fit([b[0]-5,b[1]-5,b[2]+5,b[3]+5]);}};
    $('entity-list').append(button);
  }
}
function storageKey(){return `copper-review:v1:${state.scene.board.sha256}`;}
function saveLocal() {
  if(!state.scene)return;
  try {localStorage.setItem(storageKey(),JSON.stringify({schema:'copper-review-local/v1',annotations:state.annotations,summary:$('summary').value,stage:$('stage').value}));$('autosave-status').textContent='Saved in this browser · export JSON to share';}
  catch {$('autosave-status').textContent='Local storage unavailable/full · export JSON now';}
}
function renderNotes() {
  $('note-count').textContent=state.annotations.length;$('note-list').replaceChildren();
  if(!state.annotations.length){const p=document.createElement('p');p.className='quiet';p.textContent='Your observations will appear here.';$('note-list').append(p);}
  for(const a of state.annotations){const row=document.createElement('div');row.className='note-row';
    const priority=document.createElement('span');priority.className=`priority ${a.priority}`;priority.textContent=a.priority;
    const button=document.createElement('button');button.className='note';const title=document.createElement('span');title.className='note-title';title.textContent=a.observation;
    const caption=document.createElement('span');caption.className='note-caption';caption.textContent=`${a.category} · ${a.status} · ${[...a.selection.components,...a.selection.nets,a.selection.region?'region':null,a.board_wide?'board-wide':null].filter(Boolean).join(', ')}`;button.append(title,caption);button.onclick=()=>editNote(a);
    const remove=document.createElement('button');remove.className='delete-note';remove.textContent='×';remove.title='Delete annotation';remove.setAttribute('aria-label',`Delete annotation: ${a.observation}`);
    remove.onclick=()=>{state.annotations=state.annotations.filter(n=>n.id!==a.id);if(state.editing===a.id)resetForm();renderNotes();saveLocal();requestDraw();};
    row.append(priority,button,remove);$('note-list').append(row);
  }
}
function editNote(a) {
  state.editing=a.id;state.selection=clone(a.selection);state.layers=[...a.visible_layers];
  $('category').value=a.category;$('priority').value=a.priority;$('observation').value=a.observation;$('desired').value=a.desired_behavior;$('note-status').value=a.status;$('board-wide').checked=a.board_wide;
  $('save-note').textContent='Save changes';$('cancel-edit').hidden=false;renderLayers();updateSelection();
  if(a.selection.region){const b=a.selection.region;fit([b[0]-3,b[1]-3,b[2]+3,b[3]+3]);}
  else if(a.selection.components.length){const c=state.scene.components.find(c=>c.reference===a.selection.components[0]);const b=c.bounds_mm;fit([b[0]-5,b[1]-5,b[2]+5,b[3]+5]);}
  $('observation').focus();
}
function resetForm() {state.editing=null;$('observation').value='';$('desired').value='';$('note-status').value='open';$('board-wide').checked=false;$('save-note').textContent='Add annotation';$('cancel-edit').hidden=true;}
function renderLayers() {
  $('layer-list').replaceChildren();
  for(const layer of state.scene.board.layers){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=state.layers.includes(layer);input.dataset.layer=layer;
    input.onchange=()=>{state.layers=Array.from($('layer-list').querySelectorAll('input:checked')).map(i=>i.dataset.layer);requestDraw();};
    const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=copperColor(layer);label.append(input,swatch,document.createTextNode(layer));$('layer-list').append(label);
  }
}
function loadScene(scene) {
  validateScene(scene);state.scene=scene;state.layers=[...scene.board.layers];state.annotations=[];clearSelection();resetForm();$('summary').value='';$('stage').value=scene.board.stage || 'unknown';
  try{const saved=JSON.parse(localStorage.getItem(storageKey()) || 'null');if(saved){validateReview({schema:'copper-review/v1',board:{sha256:scene.board.sha256,stage:saved.stage},annotations:saved.annotations},scene);state.annotations=saved.annotations;$('summary').value=saved.summary || '';$('stage').value=saved.stage;}}catch{message('Saved local notes were invalid; load an exported review to recover them.',true);}
  $('board-name').textContent=scene.board.name;$('board-meta').textContent=`${scene.components.length} components · ${scene.nets.length} nets · ${scene.tracks.length} tracks · ${scene.vias.length} vias · ${scene.board.sha256.slice(0,12)}`;
  $('component-count').textContent=scene.components.length;$('net-count').textContent=scene.nets.length;$('empty-state').hidden=true;
  $('warnings').replaceChildren();for(const warning of scene.warnings){const li=document.createElement('li');li.textContent=warning;$('warnings').append(li);}$('warning-count').textContent=`(${scene.warnings.length})`;
  renderLayers();renderEntities();renderNotes();fit();setEnabled();
}
function reviewText() {if(!state.scene)throw new Error('Open a board first.');return JSON.stringify(makeReview(state.scene,state.annotations,$('stage').value,$('summary').value),null,2)+'\n';}
function download(name,text,type='application/json') {const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function setEnabled(){for(const id of ['load-review','export-scene','export-review','copy-review','save-note','fit','clear'])$(id).disabled=!state.scene;}
for(const id of ['open-board','empty-open'])$(id).onclick=()=>$('board-file').click();
$('load-review').onclick=()=>$('review-file').click();
$('board-file').onchange=guarded(async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;if(file.size>49*1024*1024)throw new Error('File exceeds the local upload limit (49 MiB).');
  if(file.name.toLowerCase().endsWith('.json')){const value=JSON.parse(await file.text());if(value.schema==='copper-review/v1')throw new Error('Use Load review for annotation files; first open the matching PCB or scene.');loadScene(value);}
  else{const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Copper-Token':token,'X-Copper-Filename':encodeURIComponent(file.name)},body:await file.arrayBuffer()});const scene=await response.json();if(!response.ok)throw new Error(scene.error);loadScene(scene);}
  message(`Opened ${file.name}`);
});
$('review-file').onchange=guarded(async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;if(file.size>50*1024*1024)throw new Error('Review exceeds 50 MiB.');
  const review=validateReview(JSON.parse(await file.text()),state.scene);state.annotations=clone(review.annotations);$('summary').value=review.summary || '';$('stage').value=review.board.stage;
  resetForm();renderNotes();saveLocal();requestDraw();message(`Loaded ${state.annotations.length} review notes`);
});
$('export-review').onclick=guarded(()=>{download(`${state.scene.board.name}.review.json`,reviewText());message('Review exported. Paste its contents into your next LLM prompt.');});
$('export-scene').onclick=guarded(()=>download(`${state.scene.board.name}.scene.json`,JSON.stringify(state.scene,null,2)+'\n'));
$('copy-review').onclick=guarded(async()=>{await navigator.clipboard.writeText(reviewText());message('Review JSON copied.');});
$('save-note').onclick=guarded(()=>{
  const note=makeAnnotation(state.scene,state.selection,state.layers,{category:$('category').value,priority:$('priority').value,status:$('note-status').value,observation:$('observation').value,desired_behavior:$('desired').value,boardWide:$('board-wide').checked},state.editing || crypto.randomUUID());
  if(state.editing){const i=state.annotations.findIndex(a=>a.id===state.editing);note.created_at=state.annotations[i].created_at;note.updated_at=new Date().toISOString();state.annotations[i]=note;}else state.annotations.push(note);
  renderNotes();saveLocal();resetForm();requestDraw();message('Annotation saved.');
});
$('cancel-edit').onclick=resetForm;$('summary').oninput=saveLocal;$('stage').onchange=saveLocal;
$('search').oninput=renderEntities;
for(const tab of ['components','nets'])$(`tab-${tab}`).onclick=()=>{state.tab=tab;for(const t of ['components','nets'])$(`tab-${t}`).classList.toggle('active',t===tab);renderEntities();};
for(const mode of ['component','net','region'])$(`mode-${mode}`).onclick=()=>setMode(mode);
for(const id of ['show-labels','show-guides','show-zones','isolate'])$(id).onchange=requestDraw;
$('fit').onclick=()=>fit();$('clear').onclick=()=>{clearSelection();resetForm();};
canvas.oncontextmenu=e=>e.preventDefault();
canvas.addEventListener('wheel',e=>{if(!state.scene)return;e.preventDefault();const p=world(e),s=screen(e),z=Math.max(.05,Math.min(2500,state.zoom*Math.exp(-e.deltaY*.0015)));state.zoom=z;state.offset=[s[0]-p[0]*z,s[1]-p[1]*z];requestDraw();},{passive:false});
canvas.addEventListener('pointerdown',e=>{
  if(!state.scene || ![0,1,2].includes(e.button))return;e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);
  const point=world(e),pan=e.button===2 || e.button===1;state.drag={pan,start:point,screen:screen(e),offset:[...state.offset],moved:false};
  if(!pan && state.mode==='region'){if(!e.shiftKey)clearSelection();state.selection.region=[...point,...point];updateSelection();}
  else if(!pan){const found=hit(point);if(state.mode==='net' && found.net)select('nets',found.net,e.shiftKey);else if(state.mode==='component' && found.component)select('components',found.component.reference,e.shiftKey);else if(!e.shiftKey)clearSelection();}
});
canvas.addEventListener('pointermove',e=>{
  if(!state.scene)return;const point=world(e);$('cursor').textContent=`X ${point[0].toFixed(3)} mm · Y ${point[1].toFixed(3)} mm`;
  if(state.drag){const drag=state.drag,s=screen(e);drag.moved=true;
    if(drag.pan){state.offset=[drag.offset[0]+s[0]-drag.screen[0],drag.offset[1]+s[1]-drag.screen[1]];requestDraw();}
    else if(state.mode==='region'){state.selection.region=[Math.min(drag.start[0],point[0]),Math.min(drag.start[1],point[1]),Math.max(drag.start[0],point[0]),Math.max(drag.start[1],point[1])].map(round);updateSelection();}
  }else{const found=hit(point);$('hover-info').hidden=!(found.component || found.net);$('hover-info').textContent=[found.component?.reference,found.pad?`Pad ${found.pad.number}`:'',found.net?`Net ${found.net}`:'',found.track?`${found.track.layer} · ${found.track.width_mm} mm`:''].filter(Boolean).join(' · ');}
});
function endDrag(e){if(state.drag && state.mode==='region' && !state.drag.pan && state.selection.region && (state.selection.region[2]-state.selection.region[0]<.01 || state.selection.region[3]-state.selection.region[1]<.01)){state.selection.region=null;updateSelection();}state.drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('pointerleave',()=>{$('hover-info').hidden=true;});
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.ctrlKey || e.metaKey || e.altKey)return;
  const keys={c:'component',n:'net',r:'region'};if(keys[e.key.toLowerCase()])setMode(keys[e.key.toLowerCase()]);if(e.key.toLowerCase()==='f')fit();if(e.key==='Escape'){clearSelection();resetForm();}});
new ResizeObserver(()=>{const rect=canvas.parentElement.getBoundingClientRect();const first=state.width===0;state.width=rect.width;state.height=rect.height;canvas.width=rect.width*(devicePixelRatio || 1);canvas.height=rect.height*(devicePixelRatio || 1);if(first && state.scene)fit();else requestDraw();}).observe(canvas.parentElement);
setEnabled();
guarded(async()=>{const response=await fetch('/api/scene',{headers:{'X-Copper-Token':token}});const data=await response.json();if(!response.ok)throw new Error(data.error);if(data)loadScene(data);})();
