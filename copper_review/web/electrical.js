import {powerGraph,busGraph,layoutGraph,routeGraph} from './topology.js';
import {electricalModel,focusCircuit,powerTopology,isPassive,quantity,ELECTRICAL_SCHEMA} from './electrical-model.js';
import {schematicSheets,layoutSheet,netRole,compactQuantity,glyph} from './schematic.js';
import {randomId} from './hash.js';
import {chips} from './chips.js';

const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const distinct=a=>[...new Set(a)];
const json=x=>JSON.stringify(x,null,2);
// Electrical notes share the PCB annotation fields: category, priority, status, observation, desired behavior.
export const NOTE_CATEGORIES=[['connectivity','Connectivity'],['power','Power'],['interface','Interface'],['part_choice','Part choice'],['protection','Protection'],['other','Other']];
export const NOTE_PRIORITIES=[['low','Low'],['medium','Medium'],['high','High']];
const blankDraft=()=>({observation:'',desired:'',category:'connectivity',priority:'medium'});
const normalNote=n=>({...n,category:NOTE_CATEGORIES.some(([k])=>k===n.category)?n.category:'other',priority:NOTE_PRIORITIES.some(([k])=>k===n.priority)?n.priority:'medium',status:n.status==='resolved'?'resolved':'open'});
function download(name,value){const u=URL.createObjectURL(new Blob([json(value)+'\n'],{type:'application/json'}));const a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
/** The electrical review. `onSelect` hears selections the reviewer makes here; `links` lets the
 * side panel offer "Show on board" and "Source" when the host can answer them. */
export function createElectricalReview({message,onSelect=()=>{},links={}}){
  const root=$('electrical-review');
  let model,input,selection=null,focusSelection=null,view='schematic',focusRef=null,powerState='',notes=[],detail='intent',editing=null;
  let draft=blankDraft(),storageWarning='',fade=true;
  let showPassives=false,history=[],selectionSel=null;
  let powerConnections=false,powerZoom=1,busConnections=false,busZoom=1;
  let nativeCheck=null,powerDrawing=new Map(),busDrawing=new Map(),schematic=null,sheetId=null,sheetZoom=1,reveal=null;
  const button=(label,action,cls)=>{const b=el('button',label,cls);b.type='button';b.onclick=action;return b;};
  const key=()=>`copper-review:electrical:v1:${input.sha256}`;
  function selected(kind,id){return selection?.kind===kind&&selection.id===id;}
  let quiet=false;
  function choose(kind,id){selection={kind,id};if(kind==='component')focusRef=id;save();render();for(const pane of root.querySelectorAll('.electrical-sidebar>section'))pane.scrollTo(0,0);if(!quiet)onSelect(selection);}
  /** A temporary Selection sheet: the entity and everything one connection away, across sheets. */
  function focusEntity(kind,id){
    const refs=selectionRefs({kind,id});
    if(!refs.length||refs.length>SELECTION_LIMIT){message(refs.length?`The selection reaches ${refs.length} parts; showing its own sheet instead`:'Nothing to draw for this selection',!refs.length);locate(kind,id);return;}
    history.push({selection:selection?{...selection}:null,view,sheetId,selectionSel});
    focusSelection={kind,id};selectionSel={kind,id};view='schematic';sheetId='selection';choose(kind,id);$('electrical-canvas').scrollTo(0,0);
  }
  function selectionRefs(sel){
    // A folded series link is drawn as a wire, so the parts on its far side count as one hop.
    const s=sheets(),refs=new Set(focusCircuit(model,sel,focusRef).components.map(c=>c.ref));
    for(const r of [...refs]){const f=s.folded.get(r);if(f?.kind==='series')for(const n of f.nets)for(const p of model.nets.get(n).pins)refs.add(p.component);}
    return [...refs].filter(r=>s.view.components.has(r)&&!s.folded.has(r));
  }
  function group(parent,items,makeItem,hidden,label){const folded=items.filter(hidden),shown=items.filter(x=>!hidden(x));for(const x of shown)parent.append(makeItem(x));if(folded.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${folded.length} ${label}`));for(const x of folded)d.append(makeItem(x));parent.append(d);}}
  function entity(kind,id,label=id){const b=button(label,()=>choose(kind,id),'electrical-entity');b.dataset.kind=kind;b.dataset.entity=id;b.setAttribute('aria-pressed',selected(kind,id));return b;}
  function save(){if(!input)return;try{localStorage.setItem(key(),json({view,selection,focusSelection,focusRef,powerState,notes,showPassives}));storageWarning='';}catch{storageWarning='Browser storage unavailable/full. Export notes to keep them.';}}
  function validSelection(s){return s&&({component:model.components,pin:model.pins,net:model.nets}[s.kind]?.has(s.id)||s.kind==='bus'&&model.buses.some(b=>b.id===s.id));}
  function activeNets(){if(!selection)return [];if(selection.kind==='net')return [selection.id];if(selection.kind==='pin')return [model.pins.get(selection.id).net].filter(Boolean);if(selection.kind==='bus')return model.buses.find(b=>b.id===selection.id).pathNets;return distinct(model.components.get(selection.id).pins.map(p=>p.net).filter(Boolean));}
  function stateOf(name){return model.powerStates.find(s=>s.name===powerState)?.rails[name]||'unspecified';}
  function load(envelope){
    if(envelope?.schema!==ELECTRICAL_SCHEMA||!envelope.input||!/^([a-f0-9]{64})$/.test(envelope.input.sha256))throw Error('Invalid electrical input identity');
    const next=electricalModel(envelope.ir); // Validate completely before replacing the current document.
    nativeCheck=envelope.analysis?.check||null;powerDrawing=new Map();busDrawing=new Map();schematic=null;sheetId=null;sheetZoom=1;
    model=next;input=envelope.input;selection=null;view='schematic';powerState='';notes=[];focusRef=model.components.keys().next().value||null;editing=null;draft=blankDraft();detail='intent';focusSelection=null;history=[];selectionSel=null;showPassives=false;powerConnections=false;powerZoom=1;busConnections=false;busZoom=1;
    try{const raw=localStorage.getItem(key());if(raw){const saved=JSON.parse(raw);if(!saved||!Array.isArray(saved.notes)||saved.notes.some(n=>!n||!validSelection(n.selection)||typeof n.observation!=='string'))throw Error('Invalid local notes');notes=saved.notes.map(normalNote);selection=validSelection(saved.selection)?saved.selection:null;view=['power','bus'].includes(saved.view)?saved.view:'schematic';powerState=model.powerStates.some(s=>s.name===saved.powerState)?saved.powerState:'';focusRef=model.components.has(saved.focusRef)?saved.focusRef:focusRef;}}
    catch{storageWarning='Saved electrical review could not be read. Existing storage was left untouched.';}
    const initial=model.buses.find(b=>b.provenance==='Configured peripheral')||model.buses[0];if(!selection)selection=initial?{kind:'bus',id:initial.id}:focusRef?{kind:'component',id:focusRef}:null;
    focusSelection=selection;
    try{const saved=JSON.parse(localStorage.getItem(key())||'null');if(validSelection(saved?.focusSelection))focusSelection=saved.focusSelection;showPassives=saved?.showPassives===true;}catch{}
    render();$('electrical-canvas').scrollTo(0,0);
  }
  function show(value){root.hidden=!value;if(value&&model)render();}
  function render(){
    for(const b of root.querySelectorAll('[data-electrical-view]')){b.classList.toggle('active',b.dataset.electricalView===view);b.setAttribute('aria-selected',b.dataset.electricalView===view);}
    const picker=$('electrical-focus');picker.replaceChildren();
    for(const [label,items]of [['Interfaces',model.buses.filter(b=>b.provenance!=='Net membership').map(b=>['bus',b.id,b.name])],['Components',[...model.components.values()].filter(c=>showPassives||!isPassive(c)||selected('component',c.ref)).map(c=>['component',c.ref,c.ref])],['Rails',model.rails.filter(r=>r.supplies.length||r.sources.length).map(r=>['net',r.net,r.net])]]){const g=el('optgroup');g.label=label;for(const [kind,id,name]of items){const o=el('option',name);o.value=JSON.stringify({kind,id});g.append(o);}picker.append(g);}
    if(focusSelection){const v=JSON.stringify(focusSelection);if(![...picker.options].some(o=>o.value===v)){const o=el('option',focusSelection.id);o.value=v;picker.append(o);}picker.value=v;}
    $('electrical-notes-list').textContent=`Notes (${notes.length})`;
    $('electrical-back').disabled=!history.length;$('electrical-show-passives').checked=showPassives;$('electrical-zoom').hidden=view!=='schematic'&&(view!=='power'||powerConnections)&&(view!=='bus'||busConnections);
    $('electrical-state').replaceChildren(el('option','No state selected'));$('electrical-state').firstChild.value='';for(const s of model.powerStates){const o=el('option',s.name);o.value=s.name;$('electrical-state').append(o);}$('electrical-state').value=powerState;
    $('electrical-state').disabled=!model.powerStates.length;
    $('electrical-disclaimer').textContent=`Nominal values and declared states; ${nativeCheck?`compiler ERC ${nativeCheck.passed?'passed':'has findings'}; no simulation`:'no simulation or ERC run'}. Connectivity and ratings come from the IR; purpose, protocol grouping, power sequencing and device behavior are not validated. ${storageWarning}`;
    const canvas=$('electrical-canvas'),scroll=[canvas.scrollLeft,canvas.scrollTop];canvas.replaceChildren();({schematic:renderSchematic,power:renderPower,bus:renderBuses})[view](canvas);canvas.scrollTo(...scroll);if(reveal){const target=canvas.querySelector(`.electrical-sch [data-kind="${reveal.kind}"][data-entity="${CSS.escape(reveal.id)}"]`);reveal=null;target?.scrollIntoView({block:'center',inline:'center'});}renderInspector();renderIntent();renderExplorer();
    if(pendingPop){const target=pendingPop;pendingPop=null;openNote(canvas.querySelector(target)?.getBoundingClientRect());}
  }
  function renderExplorer(){const query=$('electrical-search').value.toLowerCase(),list=$('electrical-entities');list.replaceChildren();
    const add=(kind,id,label=id)=>{const b=entity(kind,id,label);b.onclick=()=>view==='schematic'?locate(kind,id):choose(kind,id);return b;};
    for(const b of model.buses)if(b.provenance!=='Net membership'&&b.name.toLowerCase().includes(query))list.append(add('bus',b.id,b.name));
    const matches=[...model.components.values()].filter(c=>`${c.ref} ${c.part}`.toLowerCase().includes(query));group(list,matches,c=>add('component',c.ref),c=>!query&&!showPassives&&isPassive(c),'passive components');
    const railNames=new Set(model.rails.filter(r=>r.sources.length||r.supplies.length).map(r=>r.net));const nets=[...model.nets.values()].filter(n=>n.name.toLowerCase().includes(query));group(list,nets,n=>add('net',n.name),n=>!query&&!railNames.has(n.name),'other nets');
  }
  let pendingPop=null;const SELECTION_LIMIT=60;
  function sheets(){if(!schematic||schematic.showPassives!==showPassives)schematic={showPassives,...schematicSheets(model,{showPassives}),layouts:new Map()};return schematic;}
  /** Open the sheet that shows an entity, select it and scroll it into view. */
  function locate(kind,id){
    const s=sheets(),ref=kind==='component'?id:kind==='pin'?model.pins.get(id)?.component:null;
    const nets=kind==='net'?[id]:kind==='bus'?model.buses.find(b=>b.id===id)?.pathNets||[]:[];
    const target=ref?s.sheetOf.get(ref):s.sheets.find(sh=>sh.refs.some(r=>model.components.get(r).pins.some(p=>nets.includes(p.net))))?.id;
    if(target)sheetId=target;reveal=ref&&!s.folded.has(ref)?{kind:'component',id:ref}:kind==='net'?{kind:'net',id}:null;choose(kind,id);
  }
  /** Sheets that show an entity (a net or bus can span several). */
  function sheetsOf(sel){
    const s=sheets(),ref=sel.kind==='component'?sel.id:sel.kind==='pin'?model.pins.get(sel.id)?.component:null;
    if(ref)return [s.sheetOf.get(ref)].filter(Boolean);
    const raw=sel.kind==='net'?[sel.id]:model.buses.find(b=>b.id===sel.id)?.pathNets||[],drawn=new Set(raw.map(n=>drawnNet(s,n)));
    const refs=new Set([...drawn].flatMap(n=>s.view.nets.get(n)?.pins.map(p=>p.component)||[]));
    return s.sheets.filter(sh=>sh.refs.some(r=>refs.has(r))).map(sh=>sh.id);
  }
  function drawnNet(s,n){for(const [rep,names]of s.merged)if(names.includes(n))return rep;return n;}
  /** Numbered note markers at each note's entity; click one to edit it. */
  function drawMarkers(svg,anchorOf){
    const ns=svg.namespaceURI,draw=(tag,attrs,label,parent)=>{const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;};
    const markers=draw('g',{class:'electrical-sch-markers'},undefined,svg),stacked=new Map();
    for(const [i,n]of notes.entries()){
      const found=anchorOf(n.selection);if(!found)continue;const [key,at]=found,k=stacked.get(key)||0;stacked.set(key,k+1);const x=at[0]+4+k*18,y=at[1]-8;
      const g=draw('g',{class:`electrical-sch-marker ${n.status==='resolved'?'resolved':''} ${n.priority||''}`,'data-note':n.id,role:'button',tabindex:'0','aria-label':`Note ${i+1}: ${n.observation}`},undefined,markers);
      draw('title',{},`${i+1}. ${n.category} · ${n.priority} · ${n.status}\n${n.observation}`,g);draw('circle',{cx:x,cy:y,r:8},undefined,g);draw('text',{x,y:y+3.5,'text-anchor':'middle'},String(i+1),g);
      const open=event=>{event.stopPropagation();editNote(i);};g.onclick=open;g.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open(event);}};
    }
  }
  /** Marker anchors for generated graphs: the entity's box, its label, or for a pin its component. */
  function boxAnchor(svg){
    const find=(kind,id)=>{const all=[...svg.querySelectorAll(`[data-kind="${kind}"][data-entity="${CSS.escape(id)}"]`)];return all.find(e=>e.dataset.topologyNode)||all.find(e=>e.tagName==='text')||all[0]||(kind==='component'?[...svg.querySelectorAll('[data-members]')].find(e=>e.dataset.members.split(' ').includes(id)):null);};
    return sel=>{const e=find(sel.kind,sel.id)||(sel.kind==='pin'?find('component',model.pins.get(sel.id)?.component):null);if(!e)return null;const b=e.getBBox();return [`${e.dataset.kind}:${e.dataset.entity}`,[b.x+b.width,b.y]];};
  }
  function renderSchematic(canvas){
    const s=sheets();if(!s.sheets.length){canvas.append(el('p','No components in this IR.'));return;}
    const special=selectionSel&&{id:'selection',title:`Selection · ${selectionSel.id}`,scope:null,refs:selectionRefs(selectionSel),cache:`selection:${selectionSel.kind}:${selectionSel.id}`};
    const list=special&&special.refs.length?[special,...s.sheets]:s.sheets;
    if(!list.some(x=>x.id===sheetId)){const ref=selection?.kind==='component'?selection.id:selection?.kind==='pin'?model.pins.get(selection.id).component:null;sheetId=s.sheetOf.get(ref)||s.sheets[0].id;}
    const sheet=list.find(x=>x.id===sheetId),bar=el('div',undefined,'electrical-sheet-bar'),pick=el('select');pick.id='electrical-sheet';pick.setAttribute('aria-label','Sheet');
    const noteCount=new Map();for(const n of notes)for(const id of sheetsOf(n.selection))noteCount.set(id,(noteCount.get(id)||0)+1);
    if(special&&special.refs.length){const o=el('option',`${special.title} · ${special.refs.length} parts`);o.value='selection';pick.append(o);}
    for(const [i,x]of s.sheets.entries()){const k=noteCount.get(x.id);const o=el('option',`${i+1} / ${s.sheets.length} · ${x.title} · ${x.refs.length} parts${k?` · ✎ ${k}`:''}`);o.value=x.id;pick.append(o);}
    pick.value=sheetId;pick.onchange=()=>{sheetId=pick.value;render();$('electrical-canvas').scrollTo(0,0);};
    const fadeBox=el('label',undefined,'electrical-sheet-fade'),fadeInput=el('input');fadeInput.type='checkbox';fadeInput.checked=fade;fadeInput.onchange=()=>{fade=fadeInput.checked;render();};fadeBox.append(fadeInput,' Fade unrelated');
    const about=el('span','ⓘ Generated','quiet');about.title='Generated from the IR, not an authored drawing. Power and ground pins are flags; nets that would cross a symbol use labels; interfaces are drawn as one bus line until selected. Sheets split the board by connectivity.\nWheel zooms, right- or middle-drag pans. Double-click or press N to note the selection.';
    bar.append(pick);
    if(sheet.id==='selection'){const close=button('Close selection',()=>{const sel=selectionSel;selectionSel=null;locate(sel.kind,sel.id);});close.title='Back to the sheet that holds the selection';bar.append(close);}
    bar.append(fadeBox,about);canvas.append(bar);
    const cacheKey=sheet.cache||sheet.id;if(!s.layouts.has(cacheKey))s.layouts.set(cacheKey,layoutSheet(model,sheet,s));
    const L=s.layouts.get(cacheKey),V=s.view,drawn=n=>drawnNet(s,n),active=new Set(activeNets().map(drawn));
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('electrical-topology','electrical-sch');svg.setAttribute('role','group');svg.setAttribute('aria-label',`Generated schematic sheet ${sheet.title}`);
    function draw(tag,attrs,label,parent=svg){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;}
    function pickable(e,kind,id,title){e.dataset.kind=kind;e.dataset.entity=id;e.setAttribute('role','button');e.setAttribute('tabindex','0');e.setAttribute('aria-label',title||id);e.classList.add('electrical-svg-pick');e.onclick=event=>{event.stopPropagation();if(!selected(kind,id))choose(kind,id);};e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();choose(kind,id);}};if(title)draw('title',{},title,e);return e;}
    const net=n=>active.has(n)?' selected':'',short=(v,max=26)=>v.length>max?'…'+v.slice(-(max-1)):v;
    // Fade: a selection keeps its signal nets and the parts on them; rails only relate when selected directly.
    const relNets=new Set(selection?.kind==='component'?[...active].filter(n=>netRole(V,n)==='signal'):active);
    const relRefs=new Set([...relNets].flatMap(n=>V.nets.get(n)?.pins.map(p=>p.component)||[]));
    if(selection?.kind==='component')relRefs.add(selection.id);if(selection?.kind==='pin')relRefs.add(model.pins.get(selection.id).component);
    const focusing=fade&&!!selection&&L.symbols.some(sym=>relRefs.has(sym.ref));if(focusing)svg.classList.add('electrical-sch-focus');
    const fadeable=(e,related)=>{e.classList.add('electrical-sch-fade');if(related)e.classList.add('rel');return e;};
    // Interfaces whose nets all run as wires between the same parts, side by side, draw as one bus line.
    const pinById=new Map(L.symbols.flatMap(sym=>sym.pins.map(p=>[p.id,{sym,p}]))),busOf=new Map(),buses=[];
    for(const b of model.buses){
      if(b.provenance==='Net membership')continue;
      const members=distinct(b.nets.map(drawn)),ws=members.map(n=>L.wires.find(w=>w.net===n));
      if(members.length<2||ws.some(w=>!w)||members.some(n=>busOf.has(n)))continue;
      // A selected bus, net or pin expands every bus that shares its nets.
      if(selection&&selection.kind!=='component'&&members.some(n=>active.has(n)))continue;
      const refsOf=w=>distinct(w.pins.map(id=>pinById.get(id).sym.ref)).sort().join();if(new Set(ws.map(refsOf)).size!==1)continue;
      const trunks=[];let ok=true;
      for(const ref of refsOf(ws[0]).split(',')){
        const sym=L.symbols.find(x=>x.ref===ref),pins=sym.pins.filter(p=>ws.some(w=>w.pins.includes(p.id)));
        if(pins.some(p=>p.side!==pins[0].side)){ok=false;break;}
        const order=sym.pins.filter(p=>p.side===pins[0].side).sort((a,c)=>a.y-c.y),idx=pins.map(p=>order.indexOf(p)).sort((a,c)=>a-c);
        if(idx.at(-1)-idx[0]!==idx.length-1){ok=false;break;}
        trunks.push([pins[0].end,Math.min(...pins.map(p=>p.y)),Math.max(...pins.map(p=>p.y))]);
      }
      if(!ok)continue;
      buses.push({bus:b,members,wire:ws[0],trunks,offsheet:ws.some(w=>w.offsheet)});for(const n of members)busOf.set(n,b);
    }
    const wires=draw('g',{class:'electrical-sch-wires'}),parts=draw('g',{}),anchors=new Map();
    for(const B of buses){
      const g=fadeable(pickable(draw('g',{'data-bus':B.bus.id},undefined,wires),'bus',B.bus.id,`${B.bus.name} · ${B.bus.type} · ${B.members.join(', ')} (select to expand)`),B.members.some(n=>relNets.has(n)));
      const d=B.wire.segments.map(([a,b,c,e])=>`M${a} ${b}L${c} ${e}`).join('')+B.trunks.map(([x,a,b])=>`M${x} ${a}L${x} ${b}`).join('');
      draw('path',{d,class:'electrical-sch-bus'},undefined,g);draw('path',{d,class:'electrical-graph-hit'},undefined,g);
      const [lx,lo]=B.wire.segments[0];draw('text',{x:lx+6,y:lo-5,class:'electrical-sch-bus-label'},`${short(B.bus.name,22)} ×${B.members.length}${B.offsheet?' ↗':''}`,g);
      anchors.set(`bus:${B.bus.id}`,[lx,lo]);for(const n of B.members)anchors.set(`net:${n}`,[lx,lo]);
    }
    for(const w of L.wires){if(busOf.has(w.net))continue;const g=fadeable(draw('g',{'data-net':w.net},undefined,wires),relNets.has(w.net)),d=w.segments.map(([a,b,c,e])=>`M${a} ${b}L${c} ${e}`).join('');draw('path',{d,class:`electrical-sch-wire${net(w.net)}`},undefined,g);pickable(draw('path',{d,class:'electrical-graph-hit'},undefined,g),'net',w.net,w.net);for(const [x,y]of w.dots)draw('circle',{cx:x,cy:y,r:2.6,class:`electrical-sch-dot${net(w.net)}`},undefined,g);if(w.offsheet)pickable(draw('text',{x:w.offsheet.x,y:w.offsheet.y-4,'text-anchor':w.offsheet.anchor,class:`electrical-sch-label${net(w.net)}`},`${short(w.net)} ↗`,g),'net',w.net,`${w.net} continues on other sheets`);anchors.set(`net:${w.net}`,[w.segments[0][0],w.segments[0][1]]);}
    for(const l of L.labels){
      if(l.tie){
        // A logic pin strapped to a rail: stub, rail or ground mark, net name.
        const g=fadeable(draw('g',{},undefined,wires),relNets.has(l.net)||relRefs.has(model.pins.get(l.pin)?.component)),dir=l.anchor==='start'?1:-1,x=l.x;
        draw('path',{d:`M${l.x0} ${l.y}L${x} ${l.y}`,class:`electrical-sch-stub${net(l.net)}`},undefined,g);
        draw('path',{d:l.tie==='ground'?`M${x} ${l.y-6}L${x} ${l.y+6}M${x+dir*3} ${l.y-4}L${x+dir*3} ${l.y+4}M${x+dir*6} ${l.y-2}L${x+dir*6} ${l.y+2}`:`M${x} ${l.y-6}L${x} ${l.y+6}`,class:l.tie==='ground'?`electrical-sch-ground${net(l.net)}`:`electrical-sch-power${net(l.net)}`},undefined,g);
        pickable(draw('text',{x:x+dir*10,y:l.y+4,'text-anchor':l.anchor,class:l.tie==='ground'?'electrical-sch-tie-ground':'electrical-sch-rail'},short(l.net,14),g),'net',l.net,`${l.pin} tied to ${l.net}`);
        continue;
      }
      const g=fadeable(draw('g',{},undefined,wires),relNets.has(l.net));draw('path',{d:`M${l.x0} ${l.y}L${l.x} ${l.y}`,class:`electrical-sch-stub${net(l.net)}`},undefined,g);pickable(draw('text',{x:l.x+(l.anchor==='start'?4:-4),y:l.y+4,'text-anchor':l.anchor,class:`electrical-sch-label${net(l.net)}`},`${short(l.net)}${l.offsheet?' ↗':''}`,g),'net',l.net,l.offsheet?`${l.net} (also on other sheets)`:l.net);if(!anchors.has(`net:${l.net}`))anchors.set(`net:${l.net}`,[l.x,l.y]);}
    for(const n of L.notes){fadeable(pickable(draw('text',{x:n.x,y:n.y,'text-anchor':n.anchor,class:'electrical-sch-note'},n.text,wires),'component',n.refs[0],n.title),relNets.has(n.net)||n.refs.some(r=>selected('component',r)));for(const r of n.refs)if(!anchors.has(`component:${r}`))anchors.set(`component:${r}`,[n.x,n.y-12]);}
    for(const sym of L.symbols){
      const c=model.components.get(sym.ref),g=fadeable(pickable(draw('g',{'data-symbol':sym.ref},undefined,parts),'component',sym.ref,`${sym.ref} · ${sym.part}${c.value?` · ${quantity(c.value)}`:''} · ${c.pins.length} pins`),relRefs.has(sym.ref)),cls=`electrical-sch-symbol${selected('component',sym.ref)?' selected':''}`;
      anchors.set(`component:${sym.ref}`,[sym.x+sym.w,sym.y]);
      const shape=sym.kind&&glyph(sym.kind,sym.x,sym.y,sym.w,sym.h,sym.cathode);
      if(shape){draw('rect',{x:sym.x,y:sym.y-4,width:sym.w,height:sym.h+8,class:'electrical-sch-glyph-hit'},undefined,g);for(const s of shape)draw('path',{d:s.d,class:`electrical-sch-glyph${s.fill?' solid':''}${selected('component',sym.ref)?' selected':''}`},undefined,g);}
      else draw('rect',{x:sym.x,y:sym.y,width:sym.w,height:sym.h,rx:sym.two?3:4,class:cls},undefined,g);
      if(sym.two){const inline=sym.inline,tx=inline?sym.x:sym.x+sym.w+8;draw('text',{x:tx,y:inline?sym.y-5:sym.y+sym.h/2-2,class:'electrical-sch-ref'},sym.title,g);draw('text',{x:tx,y:inline?sym.y+sym.h+13:sym.y+sym.h/2+11,class:'electrical-sch-meta'},sym.subtitle,g);}
      else{draw('text',{x:sym.x+8,y:sym.y+16,class:'electrical-sch-ref'},sym.title,g);draw('text',{x:sym.x+8,y:sym.y+31,class:'electrical-sch-meta'},short(sym.subtitle,Math.floor((sym.w-16)/6.5)),g);if(sym.nc&&selected('component',sym.ref))draw('text',{x:sym.x+8,y:sym.y+sym.h-5,class:'electrical-sch-meta'},`${sym.nc} unconnected pin${sym.nc>1?'s':''}`,g);}
      for(const p of sym.pins){anchors.set(`pin:${p.id}`,[p.end,p.y]);draw('path',{d:`M${p.x} ${p.y}L${p.end} ${p.y}`,class:`electrical-sch-stub${net(p.net)}`},undefined,g);if(!sym.two)pickable(draw('text',{x:p.side==='left'?p.x+6:p.x-6,y:p.y+4,'text-anchor':p.side==='left'?'start':'end',class:`electrical-sch-pin${selected('pin',p.id)?' selected':''}`},p.name,g),'pin',p.id,`${p.id} · pin ${p.number||'?'} · ${p.raw}`);}
      for(const f of sym.top){if(!anchors.has(`net:${f.net}`))anchors.set(`net:${f.net}`,[f.x,f.end]);const t=pickable(draw('g',{},undefined,g),'net',f.net,`${f.net} · ${f.names.join(', ')}${f.badges.length?` · folded: ${f.badges.join(', ')}`:''}`);draw('path',{d:`M${f.x} ${f.y}L${f.x} ${f.end}M${f.x-9} ${f.end}L${f.x+9} ${f.end}`,class:`electrical-sch-power${net(f.net)}`},undefined,t);draw('text',{x:f.x,y:f.end-5,'text-anchor':f.anchor,class:'electrical-sch-rail'},short(f.net,14),t);if(f.names.length>1)draw('text',{x:f.x+4,y:f.y-3,class:'electrical-sch-meta'},`×${f.names.length}`,t);if(f.badges.length)draw('text',{x:f.x-4,y:f.y-3,'text-anchor':'end',class:'electrical-sch-note'},`C×${f.badges.length}`,t);}
      for(const f of sym.bottom){if(!anchors.has(`net:${f.net}`))anchors.set(`net:${f.net}`,[f.x,f.end+8]);const t=pickable(draw('g',{},undefined,g),'net',f.net,`${f.net} · ${f.names.join(', ')}`);draw('path',{d:`M${f.x} ${f.y}L${f.x} ${f.end}M${f.x-9} ${f.end}L${f.x+9} ${f.end}M${f.x-6} ${f.end+4}L${f.x+6} ${f.end+4}M${f.x-3} ${f.end+8}L${f.x+3} ${f.end+8}`,class:`electrical-sch-ground${net(f.net)}`},undefined,t);if(!/^GND$/i.test(f.net))draw('text',{x:f.x,y:f.end+21,'text-anchor':f.anchor,class:'electrical-sch-meta'},short(f.net,14),t);if(f.names.length>1)draw('text',{x:f.x+4,y:f.y+12,class:'electrical-sch-meta'},`×${f.names.length}`,t);}
    }
    drawMarkers(svg,sel=>{const key=sel.kind==='net'?`net:${drawn(sel.id)}`:sel.kind==='bus'?(anchors.has(`bus:${sel.id}`)?`bus:${sel.id}`:`net:${drawn(model.buses.find(b=>b.id===sel.id)?.nets[0])}`):`${sel.kind}:${sel.id}`;return anchors.has(key)?[key,anchors.get(key)]:null;});
    svg.onclick=event=>{if(event.target===svg&&selection){selection=null;save();render();}};
    svg.setAttribute('viewBox',`0 0 ${L.width} ${L.height}`);svg.dataset.naturalWidth=L.width;svg.dataset.naturalHeight=L.height;svg.style.width=`${L.width*sheetZoom}px`;svg.style.height=`${L.height*sheetZoom}px`;canvas.append(svg);
    const here=[...s.folded.values()].filter(f=>s.sheetOf.get(f.ref)===sheetId);
    const describe=f=>f.kind==='support'?`support on ${f.net}${f.pin?` for ${f.pin}`:''}`:f.kind==='series'?`series ${f.nets.join(' ↔ ')}`:f.kind==='protect'?`ESD on ${f.nets.join(', ')}`:`${f.kind==='pullup'?'pull-up':'pull-down'} ${f.net} → ${f.rail}`;
    if(here.length){const d=el('details',undefined,'electrical-folded'),sum=el('summary',`${here.length} folded parts`);sum.title='Decoupling shows as C×n by rail flags; pull resistors as ↑/↓, series links as ⟷ and ESD parts as ESD notes. Show passives draws them.';d.append(sum);const list=el('div');for(const f of here){const c=model.components.get(f.ref);list.append(entity('component',f.ref,`${f.ref} · ${c.value?compactQuantity(c.value):c.part.split('.').pop()} · ${describe(f)}`));}d.append(list);bar.insertBefore(d,about);}
  }
  function netHeader(n){const h=el('div',undefined,'electrical-net-heading');h.append(entity('net',n.name));const q=distinct(n.supplies.map(s=>quantity(s.voltage)));if(q.length)h.append(el('span',q.join(' / ')+' nominal','quiet'));return h;}
  function renderPower(canvas){
    const modes=el('div',undefined,'tabs');const topology=button('Topology',()=>{powerConnections=false;render();$('electrical-canvas').scrollTo(0,0);});topology.id='electrical-power-topology';topology.classList.toggle('active',!powerConnections);const connections=button('Connections',()=>{powerConnections=true;render();$('electrical-canvas').scrollTo(0,0);});connections.id='electrical-power-connections';connections.classList.toggle('active',powerConnections);modes.append(topology,connections);canvas.append(modes);
    if(!powerConnections){renderPowerTopology(canvas);return;}
    const rails=model.rails.filter(r=>r.supplies.length||r.sources.length),railNames=new Set(rails.map(r=>r.net));
    canvas.append(el('p','Parent rails feed power pins on the same source IC. These are inferred dependencies, not verified internal transfer paths.','quiet'));
    const children=new Map(rails.map(r=>[r.net,[]]));for(const r of rails)for(const n of r.inputs)if(children.has(n))children.get(n).push(r);
    const emitted=new Set();
    function rail(r,path){const card=el('section',undefined,'electrical-rail');card.dataset.rail=r.net;const n=model.nets.get(r.net);card.append(netHeader(n));const state=stateOf(r.net);card.append(el('div',`${powerState?`${powerState}: `:''}${state==='unspecified'?'State unspecified':`Declared ${state}`} · ${r.declaredSources.length?'Declared source':r.through?.length?`Fed through ${r.through.join(', ')}`:r.sources.length?'Source inferred from power-output pin':'External / source unspecified'}`,'quiet'));
      for(const s of r.sources)card.append(entity('pin',s,`Source: ${s}`));
      const inputRow=el('div',undefined,'electrical-chips');for(const s of r.inputs)inputRow.append(entity('net',s,`${r.through?.length?'Upstream rail':'Power pin on source IC'} ← ${s}`));card.append(inputRow);
      for(const c of r.controls){const row=el('div',undefined,'electrical-control');row.append(el('span','Control candidate (pin-name inference): '),entity('pin',c.id,c.id),el('span','←'),entity('net',c.net));const controlNet=model.nets.get(c.net),fixed=model.supplyNets.has(c.net)||controlNet.pins.some(p=>p.profile.domains?.includes('ground'));if(!fixed)for(const p of controlNet.pins.filter(p=>p.id!==c.id&&!isPassive(model.components.get(p.component))&&p.profile.directions?.some(d=>['output','bidirectional'].includes(d))))row.append(entity('pin',p.id,p.id));card.append(row);}
      const loads=el('div',undefined,'electrical-loads');const makeLoad=ref=>{const p=n.pins.filter(p=>p.component===ref).map(p=>p.name).join(', ');const row=el('div',undefined,'electrical-load');row.append(entity('component',ref),el('span',p,'quiet'));return row;};group(loads,r.loads,makeLoad,ref=>!showPassives&&isPassive(model.components.get(ref))&&!selected('component',ref),'passive loads');card.append(loads);
      if(path.has(r.net)){card.append(el('p','Cyclic dependency; expand this rail from the root list.','electrical-warning'));return card;}
      emitted.add(r.net);const next=new Set([...path,r.net]);const branch=el('div',undefined,'electrical-branches');for(const child of children.get(r.net)||[])if(!next.has(child.net)){if(emitted.has(child.net)){branch.append(entity('net',child.net,`Shared dependent rail → ${child.net}`));}else branch.append(rail(child,next));}card.append(branch);return card;
    }
    for(const r of rails)if(!r.inputs.some(n=>railNames.has(n)))canvas.append(rail(r,new Set()));
    for(const r of rails)if(!emitted.has(r.net))canvas.append(rail(r,new Set()));
    if(!rails.length)canvas.append(el('p','No declared supplies or power-output rails in this IR.'));
    const aux=model.rails.filter(r=>!railNames.has(r.net));if(aux.length){const d=el('details');d.append(el('summary',`${aux.length} additional power-pin nets (roles unspecified)`));for(const r of aux)d.append(entity('net',r.net));canvas.append(d);}
    canvas.append(el('p','A declared off rail does not establish discharge, isolation or absence of backup power. Only explicitly assigned state values are shown.','quiet'));
  }
  function renderPowerTopology(canvas){
    canvas.append(el('p','One box per device. Dots mark shared rail branches; gaps distinguish crossings.','quiet'));
    renderConnectedGraph(canvas,powerGraph(model,{showPassives}),'power');
  }
  function renderBuses(canvas){
    const modes=el('div',undefined,'tabs');
    for(const [name,connections]of [['Topology',false],['Connections',true]]){const b=button(name,()=>{busConnections=connections;render();$('electrical-canvas').scrollTo(0,0);});b.id=connections?'electrical-bus-connections':'electrical-bus-topology';b.classList.toggle('active',busConnections===connections);modes.append(b);}canvas.append(modes);
    if(busConnections){renderBusConnections(canvas);return;}
    const graph=busGraph(model,{showPassives});
    canvas.append(el('p','One box per device. Named buses group actual signal nets; translator/filter sides stay separate. Dots mark shared branches; gaps distinguish crossings.','quiet'));
    const legend=el('div',undefined,'electrical-bus-legend');legend.setAttribute('aria-label','Bus protocol legend');legend.append(el('span','Bus types','quiet'));
    const protocols=new Map(graph.nodes.filter(n=>!n.device).map(n=>[n.protocol.label,n.protocol]));
    for(const protocol of protocols.values()){const item=el('span',protocol.label,'electrical-bus-key');item.dataset.busProtocol=protocol.key;legend.append(item);}if(protocols.size)canvas.append(legend);
    renderConnectedGraph(canvas,graph,'bus');
    if(graph.otherSignals)canvas.append(el('p',`${graph.otherSignals} other signal nets are available in Connections.`,'quiet'));
  }
  function renderConnectedGraph(canvas,graph,mode){
    if(!graph.nodes.length){canvas.append(el('p',mode==='power'?'No power rails in this IR.':'No declared or configured interfaces. See Connections for other signals.'));return;}
    const drawings=mode==='power'?powerDrawing:busDrawing;
    if(!drawings.has(showPassives)){const layout=layoutGraph(graph);drawings.set(showPassives,{layout,routed:routeGraph(layout)});}
    const {layout,routed}=drawings.get(showPassives);
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('electrical-topology','electrical-connected-graph',mode==='power'?'electrical-power-topology':'electrical-bus-topology');svg.setAttribute('role','group');svg.setAttribute('aria-label',mode==='power'?'Connected power topology with one box per device':'Connected bus topology with one box per device');
    function draw(tag,attrs,label,parent=svg){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(label!==undefined)e.textContent=label;parent.append(e);return e;}
    function pick(e,kind,id){e.dataset.kind=kind;e.dataset.entity=id;e.setAttribute('role','button');e.setAttribute('tabindex','0');e.setAttribute('aria-label',id);e.classList.add('electrical-svg-pick');e.onclick=()=>{if(!selected(kind,id))choose(kind,id);};e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(kind,id);}};}
    const wires=draw('g',{'class':'electrical-graph-wires'}),boxes=draw('g',{'class':'electrical-graph-boxes'});
    if(mode==='power'){
      const groups=new Map();
      for(const r of routed.routes){if(!groups.has(r.entity))groups.set(r.entity,[]);groups.get(r.entity).push(r);}
      for(const [entity,routes]of [...groups].sort(([a],[b])=>Number(selected('net',a))-Number(selected('net',b)))){
        const d=routes.map(r=>r.points.map((p,i)=>`${i?'L':'M'}${p[0]} ${p[1]}`).join(' ')).join(' '),g=draw('g',{'data-power-net':entity},undefined,wires);
        draw('path',{d,class:'electrical-power-underlay'},undefined,g);
        draw('path',{d,class:`electrical-graph-wire electrical-power-wire${selected('net',entity)?' selected':''}${stateOf(entity)==='off'?' is-off':''}`},undefined,g);
        const hit=draw('path',{d,class:'electrical-graph-hit'},undefined,g);pick(hit,'net',entity);draw('title',{},[entity,...distinct(routes.flatMap(r=>r.pins))].join(' · '),hit);
        for(const j of routed.junctions.filter(j=>j.entity===entity))draw('circle',{cx:j.point[0],cy:j.point[1],r:2.4,class:'electrical-power-junction','pointer-events':'none'},undefined,g);
      }
    }else{
      const groups=new Map();
      for(const r of routed.routes){if(!groups.has(r.bundle))groups.set(r.bundle,[]);groups.get(r.bundle).push(r);}
      for(const [bundle,routes]of [...groups].sort(([,a],[,b])=>Number(selected('bus',a[0].entity))-Number(selected('bus',b[0].entity)))){
        const {entity,protocol}=routes[0],hub=layout.nodes.find(n=>n.id===bundle),d=routes.map(r=>r.points.map((p,i)=>`${i?'L':'M'}${p[0]} ${p[1]}`).join(' ')).join(' ');
        const g=draw('g',{'data-bus-bundle':bundle,'data-bus-protocol':protocol.key},undefined,wires);
        draw('path',{d,class:'electrical-bus-underlay'},undefined,g);
        draw('path',{d,class:`electrical-graph-wire electrical-bus-wire${selected('bus',entity)?' selected':''}`},undefined,g);
        const hit=draw('path',{d,class:'electrical-graph-hit'},undefined,g);pick(hit,'bus',entity);draw('title',{},[hub.label,hub.subtitle,...hub.types,...hub.aliases,...distinct(routes.flatMap(r=>r.pins))].join(' · '),hit);
        for(const j of routed.junctions.filter(j=>j.bundle===bundle))draw('circle',{cx:j.point[0],cy:j.point[1],r:2.4,class:'electrical-bus-junction','pointer-events':'none'},undefined,g);
      }
    }
    const shortened=(value,max=24)=>value.length>max?'…'+value.slice(-(max-1)):value;
    for(const n of layout.nodes){
      const g=draw('g',{'data-topology-node':n.id},undefined,boxes);pick(g,n.kind,n.entity);if(n.members)g.dataset.members=n.members.join(' ');if(n.device)g.dataset.topologyDevice=n.entity;else if(mode==='power')g.dataset.powerRail=n.entity;else{g.dataset.topologyBus=n.id;g.dataset.busProtocol=n.protocol.key;}
      const title=[n.label,n.subtitle,...(n.members||[]),...(n.aliases||[]),...(n.types||[]),...(n.nets||[]),mode==='power'&&!n.device?`State: ${stateOf(n.entity)}; ${n.passives||0} collapsed passives`:''];draw('title',{},distinct(title).join(' · '),g);
      draw('rect',{x:n.x,y:n.y,width:n.width,height:n.height,rx:n.device?5:15,class:`electrical-graph-node ${n.device?'device':'junction'}${selected(n.kind,n.entity)||n.members?.some(r=>selected('component',r))?' selected':''}`},undefined,g);
      draw('text',{x:n.x+10,y:n.y+20,class:n.device?'':'electrical-net-label'},shortened(n.label,Math.floor((n.width-20)/7)),g);
      draw('text',{x:n.x+10,y:n.y+38,class:'electrical-graph-meta'},shortened(n.subtitle==='Voltage unspecified'?'Unspecified':n.subtitle,Math.floor((n.width-20)/6)),g);
      if(mode==='power'){
        if(n.device){const controls=model.components.get(n.entity).pins.filter(p=>p.net&&/^(EN|ENABLE|CE|OE)(_N|B)?$/i.test(p.name));if(controls.length){const p=controls[0],t=draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},shortened(`${p.name} ← ${p.net}`,26),g);pick(t,'pin',p.id);t.onclick=event=>{event.stopPropagation();choose('pin',p.id);};t.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();choose('pin',p.id);}};}}
        else{const declared=stateOf(n.entity);draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},declared==='unspecified'?'':`Declared ${declared}`,g);if(n.passives)draw('text',{x:n.x+10,y:n.y+71,class:'electrical-graph-meta'},`+${n.passives} passives`,g);}
      }else if(!n.device){
        const aliases=n.aliases.filter(name=>name!==n.label),meta=aliases.length?aliases.join(' / '):n.types.join(' / ');
        draw('text',{x:n.x+10,y:n.y+56,class:'electrical-graph-meta'},shortened(meta,Math.floor((n.width-20)/6)),g);
      }
    }
    const width=layout.width+35,height=layout.height,zoom=mode==='power'?powerZoom:busZoom;
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.dataset.naturalWidth=width;svg.dataset.naturalHeight=height;svg.style.width=`${width*zoom}px`;svg.style.height=`${height*zoom}px`;canvas.append(svg);drawMarkers(svg,boxAnchor(svg));
  }
  function renderBusConnections(canvas){
    const other=el('details',undefined,'electrical-other-signals');other.append(el('summary',`${model.buses.filter(b=>b.provenance==='Net membership').length} other signal nets`));
    for(const b of model.buses){const card=el('section',undefined,'electrical-bus');const title=entity('bus',b.id,b.name);title.onclick=()=>focusEntity('bus',b.id);card.append(title,el('div',`${b.type} · ${b.provenance}`,'quiet'));const path=el('div',undefined,'electrical-path');group(path,b.componentRefs,r=>entity('component',r),r=>!showPassives&&isPassive(model.components.get(r)),'passive support components');card.append(path);const signals=el('div',undefined,'electrical-chips');for(const [s,n]of Object.entries(b.signals))signals.append(entity('net',n,`${s} → ${n}`));card.append(signals);if(b.pathNets.length>b.nets.length)card.append(el('p','Expanded through translator/filter signal pins; channel correspondence is not inferred.','quiet'));(b.provenance==='Net membership'?other:canvas).append(card);}
    if(other.childElementCount>1)canvas.append(other);
    if(!model.buses.length)canvas.append(el('p','No configured interfaces or connected signal nets in this IR.'));
  }
  // A part's datasheet, revision and the place in it that the definition cites.
  function partDocument(c){const src=c.partDefinition.source||{};let href=null;try{const u=new URL(src.url);if(['https:','http:'].includes(u.protocol))href=u.href;}catch{}
    if(!src.document&&!href&&!src.location)return null;
    const box=el('div',undefined,'electrical-doc'),name=src.document||(href?decodeURIComponent(new URL(href).pathname.split('/').pop())||new URL(href).host:'Source document'),link=el(href?'a':'span',name);
    if(href){link.href=href;link.target='_blank';link.rel='noopener noreferrer';link.title=href;}
    box.append(el('span','Datasheet','electrical-label'),link);const where=[src.revision,src.location].filter(Boolean).join(' · ');if(where)box.append(el('p',where,'quiet'));return box;}
  // Rows of aligned cells; long values clip and keep the full text as a tooltip.
  function grid(rows,cls=''){const g=el('div',undefined,`electrical-grid ${cls}`);for(const cells of rows)for(const cell of cells){const e=typeof cell==='string'?el('span',cell):cell;if(!e.title)e.title=e.textContent;g.append(e);}return g;}
  function pinTable(c){
    const natural=(a,b)=>String(a.number??'').localeCompare(String(b.number??''),undefined,{numeric:true}),pins=[...c.pins].sort(natural);
    const open=pins.filter(p=>!p.net&&!selected('pin',p.id)),row=p=>[el('span',p.number||'?','electrical-pin-number'),entity('pin',p.id,p.name),p.net?entity('net',p.net):el('span',p.connection_policy&&p.connection_policy!=='normal'?`— ${p.connection_policy}`:'—','quiet')];
    const box=el('div',undefined,'electrical-pins');box.append(el('div',`Pins · ${pins.length}${open.length?` · ${open.length} unconnected`:''}`,'electrical-label'),grid(pins.filter(p=>!open.includes(p)).map(row),'electrical-pin-grid'));
    if(open.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${open.length} unconnected`),grid(open.map(row),'electrical-pin-grid'));box.append(d);}
    return box;}
  function renderInspector(){const inspector=$('electrical-inspector');inspector.replaceChildren();if(!selection){inspector.append(el('p','Select a pin, net, component or interface.'));return;}
    const {kind,id}=selection,owner=kind==='component'?model.components.get(id):kind==='pin'?model.components.get(model.pins.get(id).component):null;
    inspector.append(el('h3',id));
    if(kind==='component'){const c=owner;const value=c.value?quantity(c.value):'';inspector.append(el('p',`${c.part}${value&&!c.part.endsWith(value)?` · ${value}`:''}`,'electrical-subtitle'));const about=[c.partDefinition.manufacturer,c.partDefinition.category].filter(Boolean).join(' · ');if(about)inspector.append(el('p',about,'quiet'));}
    const row=el('div',undefined,'link-row'),show=button('Focus sheet',()=>focusEntity(kind,id));show.title='Draw the selection and everything one connection away on one sheet, across sheets and modules';row.append(show);
    if(links.board?.has(kind,id)){const b=button('On board',()=>links.board.show(kind,id));b.title='Select it on the board (S)';row.append(b);}
    if(links.source?.has(kind,id)){const b=button('Source',()=>links.source.open(kind,id));b.title='Show where it is declared in the CopperScript source';row.append(b);}
    inspector.append(row);
    if(kind==='pin'){const p=model.pins.get(id);inspector.append(grid([['Pin',p.number||'unspecified'],['Net',p.net?entity('net',p.net):el('span','No net in IR (intent unspecified)','quiet')],['Direction',(p.profile.directions||[]).join(', ')||'unspecified'],['Domain',(p.profile.domains||[]).join(', ')||'unspecified'],...(p.profile.voltage?[['Voltage',`${quantity(p.profile.voltage.minimum)} … ${quantity(p.profile.voltage.maximum)} · ${p.profile.voltage.rating||'rating unspecified'}`]]:[]),['Unpowered',p.unpowered_behavior]],'electrical-facts'));}
    const doc=owner&&partDocument(owner);if(doc)inspector.append(doc);
    if(kind==='component'){const c=owner,props=Object.entries(c.properties||{});
      if(props.length)inspector.append(grid(props.map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]),'electrical-facts'));
      const support=[...model.components.values()].filter(d=>typeof d.properties?.decouples==='string'&&d.scope===c.scope&&d.properties.decouples.startsWith(c.ref.split('/').pop()+'.'));
      if(support.length)inspector.append(el('div',`Support · ${support.length}`,'electrical-label'),grid(support.map(d=>[entity('component',d.ref),d.value?compactQuantity(d.value):'',d.properties.decouples.split('.').pop()]),'electrical-support-grid'));
      inspector.append(pinTable(c));}
    if(kind!=='component')for(const name of activeNets()){const n=model.nets.get(name);if(kind==='bus')inspector.append(entity('net',name));if(n.aliases.length>1)inspector.append(el('p',`Aliases: ${n.aliases.join(', ')}`,'quiet'));if(n.unresolved?.length)inspector.append(el('p',`Unresolved endpoints: ${n.unresolved.join(', ')}`,'electrical-warning'));const hidden=p=>!showPassives&&isPassive(model.components.get(p.component))&&!selected('pin',p.id),row=p=>[entity('pin',p.id),el('span',p.number||'?','electrical-pin-number')],folded=n.pins.filter(hidden);inspector.append(el('div',`Endpoints · ${n.pins.length}`,'electrical-label'),grid(n.pins.filter(p=>!hidden(p)).map(row),'electrical-endpoint-grid'));if(folded.length){const d=el('details',undefined,'electrical-folded');d.append(el('summary',`${folded.length} passive terminals`),grid(folded.map(row),'electrical-endpoint-grid'));inspector.append(d);}}
  }
  function renderIntent(){const box=$('electrical-intent');box.replaceChildren();const tabs=el('div',undefined,'tabs');for(const id of ['intent','source','notes']){const b=button({intent:'Details',source:'Source',notes:'Notes'}[id],()=>{detail=id;renderIntent();});b.classList.toggle('active',detail===id);tabs.append(b);}box.append(tabs);
    if(detail==='notes'){renderNotes(box);return;}
    if(!selection)return;
    const netNames=activeNets(),refs=selection.kind==='component'?[selection.id]:selection.kind==='pin'?[model.pins.get(selection.id).component]:distinct(netNames.flatMap(n=>model.nets.get(n).pins.map(p=>p.component)));
    if(detail==='source'){const source={selection,nets:netNames.map(n=>{const x=model.nets.get(n);return {name:n,aliases:x.aliases,endpoints:x.pins.map(p=>p.id),supplies:x.supplies};}),components:refs.map(r=>{const c=model.components.get(r);return {ref:r,part:c.part,properties:c.properties,source:c.partDefinition.source};})};box.append(el('p','Resolved IR excerpt; not original source text.','quiet'),el('pre',json(source)));return;}
    box.append(el('h3','Declared facts'));
    for(const n of netNames){const net=model.nets.get(n);for(const s of net.supplies)box.append(el('p',`${s.name}: ${quantity(s.voltage)} nominal${s.source?` · source ${s.source}`:s.externally_driven?' · external in this scope':''}`));if(powerState)box.append(el('p',`${n}: ${stateOf(n)} in ${powerState}`,'quiet'));}
    for(const b of model.buses.filter(b=>b.provenance!=='Net membership'&&b.nets.some(n=>netNames.includes(n))))box.append(el('p',`${b.provenance}: ${b.name} · ${b.type}${b.pullup_supply?` · pull-up ${b.pullup_supply}`:''}`));
    for(const r of refs){const c=model.components.get(r),own=selection.kind==='component'&&selection.id===r||selection.kind==='pin'&&model.pins.get(selection.id).component===r;if(selection.kind==='component'&&own||!showPassives&&isPassive(c)&&!own)continue;for(const [k,v]of Object.entries(c.properties||{}))box.append(el('p',`${r} · ${k}: ${typeof v==='object'?json(v):v}`));const src=c.partDefinition.source;if(src?.document&&!own){box.append(el('p',`${r}: ${src.document}${src.revision?' · '+src.revision:''}`,'quiet'));if(src.url){try{const u=new URL(src.url);if(['https:','http:'].includes(u.protocol)){const a=el('a','Open source document');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}}catch{}}}}
    if(model.warnings.length){const d=el('details');d.append(el('summary',`${model.warnings.length} import warnings`));for(const w of model.warnings)d.append(el('p',w));box.append(d);}
  }
  function renderNotes(box){
    if(!notes.length)box.append(el('p','No notes yet. Select something, then double-click it on the schematic or press N.','quiet'));
    for(const [i,n]of notes.entries()){const row=el('div',undefined,`electrical-note${n.status==='resolved'?' resolved':''}`);row.append(el('span',String(i+1),`electrical-note-number ${n.priority}`),button(`${n.selection.id}: ${n.observation}`,()=>editNote(i)),button('Delete',()=>{notes.splice(i,1);if(editing===i){editing=null;draft=blankDraft();}else if(editing>i)editing--;save();render();}));row.title=`${n.category} · ${n.priority} · ${n.status}`;box.append(row);}
    box.append(el('h3',editing===null?'New note':`Edit note ${editing+1}`),noteForm(true).form);
    box.append(button('Export electrical review',exportReview),el('p','Electrical reviews carry the IR hash and exact entity identities; they use a separate contract from PCB reviews.','quiet'));
  }
  /** The note editor shared by the Notes tab and the popover on the drawing. */
  function noteForm(withIds,onDone=()=>{}){
    const form=el('div',undefined,'electrical-note-form');
    if(selection)form.append(el('div',selection.id,'electrical-note-target'));
    form.append(chips(NOTE_CATEGORIES,draft.category,v=>{draft.category=v;},'Category'),chips(NOTE_PRIORITIES,draft.priority,v=>{draft.priority=v;},'Priority'));
    const observation=el('textarea');observation.placeholder='What do you observe?';observation.setAttribute('aria-label','Observation');observation.value=draft.observation;observation.oninput=()=>{draft.observation=observation.value;};
    const more=el('details'),desired=el('textarea');desired.placeholder='What should change? (optional)';desired.setAttribute('aria-label','Desired behavior');desired.value=draft.desired;desired.oninput=()=>{draft.desired=desired.value;};more.open=!!draft.desired;more.append(el('summary','Desired behavior'),desired);
    if(withIds){observation.id='electrical-observation';desired.id='electrical-desired';}
    const actions=el('div',undefined,'electrical-note-actions'),add=button(editing===null?'Add note':'Save note',()=>{if(saveDraft())onDone();});if(withIds)add.id='electrical-save-note';actions.append(add);
    if(editing!==null&&notes[editing]){const n=notes[editing];actions.append(button(n.status==='resolved'?'Reopen':'Resolve',()=>{n.status=n.status==='resolved'?'open':'resolved';n.updated_at=new Date().toISOString();editing=null;draft=blankDraft();save();render();}));}
    const cancel=()=>{editing=null;draft=blankDraft();onDone();render();};actions.append(button('Cancel',cancel));
    form.append(observation,more,actions);
    form.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();add.click();}else if(e.key==='Escape'){e.preventDefault();cancel();}});
    return {form,focus:()=>observation.focus()};
  }
  function saveDraft(){
    if(!selection||!draft.observation.trim()){message('Select an electrical entity and enter an observation.',true);return false;}
    const old=editing===null?null:notes[editing],now=new Date().toISOString();
    const note={id:old?.id||randomId(),selection:{...selection},view,power_state:powerState||null,category:draft.category,priority:draft.priority,status:old?.status||'open',observation:draft.observation.trim(),desired_behavior:draft.desired.trim(),created_at:old?.created_at||now,updated_at:now};
    if(old)notes[editing]=note;else notes.push(note);editing=null;draft=blankDraft();save();render();return true;
  }
  function editNote(i){
    const n=notes[i];editing=i;draft={observation:n.observation,desired:n.desired_behavior||'',category:n.category,priority:n.priority};
    pendingPop=`[data-note="${CSS.escape(n.id)}"]`;
    view=['power','bus'].includes(n.view)?n.view:'schematic';if(view==='power')powerConnections=false;if(view==='bus')busConnections=false;
    if(view==='schematic')locate(n.selection.kind,n.selection.id);else{selection={...n.selection};save();render();}
  }
  /** Notes as plain text for an issue, a chat or a prompt. */
  function notesText(list){
    return [`CopperReview electrical notes · ${model.name} · IR ${input.sha256.slice(0,12)}`,...list.map(n=>`${notes.indexOf(n)+1}. [${n.priority} · ${n.category} · ${n.status}] ${n.selection.kind} ${n.selection.id} (${n.view}${n.power_state?`, ${n.power_state}`:''})\n   Observation: ${n.observation}${n.desired_behavior?`\n   Desired: ${n.desired_behavior}`:''}`)].join('\n');
  }
  async function copyText(text,what){
    try{await navigator.clipboard.writeText(text);}catch{const t=el('textarea');t.value=text;document.body.append(t);t.select();document.execCommand('copy');t.remove();}
    message(`Copied ${what}`);
  }
  /** Every note in one list: click to go back to it, copy one or all. */
  function showNotesList(){
    let d=$('electrical-notes-dialog');
    if(!d){d=el('dialog',undefined,'electrical-notes-dialog');d.id='electrical-notes-dialog';d.setAttribute('aria-label','Review notes');document.body.append(d);d.addEventListener('click',e=>{if(e.target===d)d.close();});}
    d.replaceChildren();
    const open=notes.filter(n=>n.status!=='resolved'),head=el('div',undefined,'electrical-notes-head');head.append(el('h3',`Review notes (${notes.length})`));
    const all=button('Copy all',()=>copyText(notesText(notes),`${notes.length} notes`)),openOnly=button(`Copy open (${open.length})`,()=>copyText(notesText(open),`${open.length} open notes`));all.disabled=!notes.length;openOnly.disabled=!open.length;
    head.append(all,openOnly,button('Close',()=>d.close()));d.append(head);
    if(!notes.length)d.append(el('p','No notes yet. Select something and press N, or double-click it in a drawing.','quiet'));
    const list=el('div',undefined,'electrical-notes-items');
    for(const [i,n]of notes.entries()){
      const row=el('div',undefined,`electrical-notes-row${n.status==='resolved'?' resolved':''}`),go=button('',()=>{d.close();editNote(i);},'electrical-notes-go');
      const top=el('div');top.append(el('span',String(i+1),`electrical-note-number ${n.priority}`),el('strong',n.selection.id),el('span',`${n.category} · ${n.priority} · ${n.status} · ${n.view}`,'quiet'));
      go.append(top,el('div',n.observation));if(n.desired_behavior)go.append(el('div',`→ ${n.desired_behavior}`,'quiet'));
      row.append(go,button('Copy',()=>copyText(notesText([n]),`note ${i+1}`)));list.append(row);
    }
    d.append(list);d.showModal();
  }
  /** A small note editor next to an element of the drawing. */
  function openNote(rect){
    const canvas=$('electrical-canvas');canvas.querySelector('.electrical-note-pop')?.remove();if(!selection)return;
    const pop=el('div',undefined,'electrical-note-pop'),{form,focus}=noteForm(false,()=>pop.remove());pop.append(form);canvas.append(pop);
    const c=canvas.getBoundingClientRect(),r=rect||{left:c.left+40,right:c.left+40,top:c.top+60,bottom:c.top+60},w=pop.offsetWidth,h=pop.offsetHeight;
    let x=r.right-c.left+canvas.scrollLeft+10,y=r.top-c.top+canvas.scrollTop;
    if(x+w>canvas.scrollLeft+canvas.clientWidth-8)x=Math.max(canvas.scrollLeft+8,r.left-c.left+canvas.scrollLeft-w-10);
    y=Math.max(canvas.scrollTop+8,Math.min(y,canvas.scrollTop+canvas.clientHeight-h-8));
    pop.style.left=`${x}px`;pop.style.top=`${y}px`;focus();
  }
  function exportReview(){download(`${model.name}.electrical.review.json`,{schema:'copper-electrical-review/v1',input,selection,view,power_state:powerState||null,annotations:notes});}
  function importReview(value){if(value?.schema!=='copper-electrical-review/v1'||value.input?.sha256!==input?.sha256)throw Error('Electrical review does not match the loaded IR hash');if(!Array.isArray(value.annotations)||value.annotations.some(n=>!n||!validSelection(n.selection)||typeof n.observation!=='string'||typeof n.id!=='string'))throw Error('Invalid electrical review notes');notes=value.annotations.map(normalNote);draft=blankDraft();editing=null;save();render();}
  for(const b of root.querySelectorAll('[data-electrical-view]'))b.onclick=()=>{view=b.dataset.electricalView;save();render();};
  $('electrical-focus').onchange=e=>{if(e.target.value){const s=JSON.parse(e.target.value);focusSelection=s;if(view==='schematic')locate(s.kind,s.id);else choose(s.kind,s.id);}};
  $('electrical-back').onclick=()=>{const prev=history.pop();if(prev){selection=prev.selection;view=prev.view;sheetId=prev.sheetId;selectionSel=prev.selectionSel;save();render();}};
  $('electrical-show-passives').onchange=e=>{showPassives=e.target.checked;save();render();};
  $('electrical-fit').onclick=()=>{const svg=root.querySelector('.electrical-topology');if(svg){const c=$('electrical-canvas'),[mx,my]=view==='schematic'?[26,(c.querySelector('.electrical-sheet-bar')?.offsetHeight||0)+20]:[44,100],zoom=Math.min(view==='schematic'?4:1,Math.max(.15,(c.clientWidth-mx)/Number(svg.dataset.naturalWidth)),Math.max(.15,(c.clientHeight-my)/Number(svg.dataset.naturalHeight)));if(view==='power')powerZoom=zoom;else if(view==='bus')busZoom=zoom;else sheetZoom=zoom;render();c.scrollTo(0,0);}};
  // Schematic: wheel zooms under the pointer, right/middle-drag pans (as in the PCB view).
  // Every drawing: wheel zooms under the pointer, right/middle-drag pans (as in the PCB view).
  const getZoom=()=>view==='power'?powerZoom:view==='bus'?busZoom:sheetZoom;
  const setZoom=z=>{if(view==='power')powerZoom=z;else if(view==='bus')busZoom=z;else sheetZoom=z;};
  const drawing=e=>{const svg=$('electrical-canvas').querySelector('svg.electrical-topology');return svg&&(e.target.closest?.('svg.electrical-topology')||e.target.id==='electrical-canvas')?svg:null;};
  const modal=()=>!!document.querySelector('dialog[open]');
  // Double-click an element of a drawing, or press N, to note the selection.
  $('electrical-canvas').addEventListener('dblclick',e=>{const target=e.target.closest?.('svg.electrical-topology .electrical-svg-pick');if(target){e.preventDefault();openNote(target.getBoundingClientRect());}});
  document.addEventListener('keydown',e=>{
    if(root.hidden||modal()||e.key.toLowerCase()!=='n'||e.ctrlKey||e.metaKey||e.altKey||!selection||e.target.closest?.('input,textarea,select,[contenteditable],#pcb-review'))return;
    e.preventDefault();editing=null;
    const svg=$('electrical-canvas').querySelector('svg.electrical-topology'),target=svg?.querySelector(`[data-kind="${selection.kind}"][data-entity="${CSS.escape(selection.id)}"]`);
    if(svg)openNote(target?.getBoundingClientRect());else{detail='notes';renderIntent();$('electrical-observation')?.focus();}
  });
  $('electrical-canvas').addEventListener('wheel',e=>{const svg=drawing(e);if(!svg)return;e.preventDefault();const c=e.currentTarget,before=svg.getBoundingClientRect(),fx=(e.clientX-before.left)/before.width,fy=(e.clientY-before.top)/before.height;const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?c.clientHeight:1),zoom=Math.max(.1,Math.min(4,getZoom()*Math.exp(-delta*.0015)));setZoom(zoom);svg.style.width=`${Number(svg.dataset.naturalWidth)*zoom}px`;svg.style.height=`${Number(svg.dataset.naturalHeight)*zoom}px`;const after=svg.getBoundingClientRect();c.scrollLeft+=after.left+fx*after.width-e.clientX;c.scrollTop+=after.top+fy*after.height-e.clientY;},{passive:false});
  let pan=null;
  $('electrical-canvas').addEventListener('pointerdown',e=>{if((e.button!==2&&e.button!==1)||!drawing(e))return;e.preventDefault();const c=e.currentTarget;pan={id:e.pointerId,x:e.clientX,y:e.clientY,left:c.scrollLeft,top:c.scrollTop};c.setPointerCapture(e.pointerId);c.classList.add('panning');});
  $('electrical-canvas').addEventListener('pointermove',e=>{if(pan?.id!==e.pointerId)return;const c=e.currentTarget;c.scrollLeft=pan.left-(e.clientX-pan.x);c.scrollTop=pan.top-(e.clientY-pan.y);});
  for(const type of ['pointerup','pointercancel'])$('electrical-canvas').addEventListener(type,e=>{if(pan?.id!==e.pointerId)return;pan=null;e.currentTarget.classList.remove('panning');});
  $('electrical-canvas').addEventListener('contextmenu',e=>{if(drawing(e))e.preventDefault();});
  $('electrical-notes-list').onclick=showNotesList;
  $('electrical-actual-size').onclick=()=>{if(view==='power')powerZoom=1;else if(view==='bus')busZoom=1;else sheetZoom=1;render();};
  const maximize=on=>{document.body.classList.toggle('electrical-maximized',on);$('electrical-maximize').setAttribute('aria-pressed',String(on));$('electrical-maximize').textContent=on?'Restore':'Maximize';};
  $('electrical-maximize').onclick=()=>maximize(!document.body.classList.contains('electrical-maximized'));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal()&&document.body.classList.contains('electrical-maximized'))maximize(false);});
  $('electrical-state').onchange=e=>{powerState=e.target.value;save();render();};
  $('electrical-search').oninput=renderExplorer;
  $('electrical-export').onclick=exportReview;
  /** Select something chosen elsewhere (the board) without echoing it back. */
  function revealEntity(kind,id){if(!model||!validSelection({kind,id}))return false;quiet=true;try{if(view==='schematic')locate(kind,id);else choose(kind,id);}finally{quiet=false;}return true;}
  return {load,show,render:()=>{if(model)render();},hasModel:()=>!!model,model:()=>model,input:()=>input,selection:()=>selection,
    has:(kind,id)=>!!model&&validSelection({kind,id}),reveal:revealEntity,exportReview:()=>{if(!model)throw Error('Open a schematic first.');exportReview();},importReview};
}
