/* Pure geometry and review contract, also exercised by Node's built-in tests. */
import {randomId} from './hash.js';
export const REVIEW_SCHEMA = 'copper-review/v2';
// v1 reviews (full geometry copies in each context) still load; their contexts are recomputed.
export const READABLE_REVIEW_SCHEMAS = ['copper-review/v1', REVIEW_SCHEMA];
export const TOOL_VERSION = '0.2.1';
export const SCENE_SCHEMA = 'copper-review-scene/v1';
export const round = value => Math.round(value * 1e6) / 1e6;
export const clone = value => JSON.parse(JSON.stringify(value));
export function padLabel(pad) {
  const name=pad.pin_name || pad.net;
  return name ? `${pad.number} · ${name}` : pad.number;
}
export function engineeringText(value) {
  // Format inherited scientific notation without floating-point rounding.
  return String(value).replace(/([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)/g,(_,sign,whole,fraction='',exponent)=>{
    const shift=Number(exponent);if(Math.abs(shift)>100)return _;
    const digits=whole+fraction,point=whole.length+shift;
    let result=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
    result=result.replace(/^0+(?=\d)/,'');
    return sign+result;
  });
}
export const pointInBox = (p,b) => p[0]>=b[0] && p[0]<=b[2] && p[1]>=b[1] && p[1]<=b[3];
export const boxesOverlap = (a,b) => a[0]<=b[2] && a[2]>=b[0] && a[1]<=b[3] && a[3]>=b[1];
export function distanceToSegment(p,a,b) {
  const dx=b[0]-a[0], dy=b[1]-a[1], d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)) : 0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
export function segmentIntersectsBox(a,b,box) {
  if(pointInBox(a,box) || pointInBox(b,box)) return true;
  let t0=0,t1=1;
  const dx=b[0]-a[0],dy=b[1]-a[1];
  const ps=[-dx,dx,-dy,dy],qs=[a[0]-box[0],box[2]-a[0],a[1]-box[1],box[3]-a[1]];
  for(let i=0;i<4;i++) {
    if(ps[i]===0) {if(qs[i]<0) return false;}
    else {const t=qs[i]/ps[i]; if(ps[i]<0) t0=Math.max(t0,t); else t1=Math.min(t1,t); if(t0>t1) return false;}
  }
  return true;
}
export function pointInPolygon(p,points) {
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++) {
    const a=points[i],b=points[j];
    if(distanceToSegment(p,a,b)<1e-9) return true;
    if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
export function polygonIntersectsBox(points,box) {
  if(points.some(p=>pointInBox(p,box))) return true;
  const corners=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]];
  if(corners.some(p=>pointInPolygon(p,points))) return true;
  return points.some((p,i)=>segmentIntersectsBox(p,points[(i+1)%points.length],box));
}
const expand = (box,r) => [box[0]-r,box[1]-r,box[2]+r,box[3]+r];
export function padCorners(pad) {
  const [w,h]=pad.size_mm, [x,y]=pad.position_mm, r=pad.rotation_deg*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
  return [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([a,b])=>[x+a*c+b*s,y-a*s+b*c]);
}
// Annotation context limits. A review is pasted into prompts, so it carries
// identities and summaries; the scene (or the PCB) holds the full geometry.
export const CONTEXT_LIMITS = {list_pads:64, region_components:60, region_pads:120, region_tracks:160,
  region_vias:100, region_zones:40, region_drawings:40, net_zones:40, clipped_points:200};
const r6 = p => [round(p[0]),round(p[1])];
// Clipped outlines are derived geometry: 0.1 um is ample and keeps them short.
const r4 = p => [Math.round(p[0]*1e4)/1e4,Math.round(p[1]*1e4)/1e4];
function boundsOf(points) {
  // A loop, not Math.min(...points): fills can hold hundreds of thousands of points.
  if(!points.length)return null;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const [x,y] of points){if(x<x0)x0=x;if(y<y0)y0=y;if(x>x1)x1=x;if(y>y1)y1=y;}
  return [x0,y0,x1,y1].map(round);
}
function mergeBounds(list) {
  const valid=list.filter(Boolean);if(!valid.length)return null;
  return boundsOf(valid.flatMap(b=>[[b[0],b[1]],[b[2],b[3]]]));
}
export function polygonArea(points) {
  let a=0;for(let i=0,j=points.length-1;i<points.length;j=i++)a+=(points[j][0]+points[i][0])*(points[j][1]-points[i][1]);
  return Math.abs(a)/2;
}
/** Sutherland-Hodgman clip of a polygon (holes linked by bridges are kept as such) to a rectangle. */
export function clipPolygonToBox(points,box) {
  let out=points;
  const edges=[[p=>p[0]>=box[0],(a,b)=>[box[0],a[1]+(b[1]-a[1])*(box[0]-a[0])/(b[0]-a[0])]],
    [p=>p[0]<=box[2],(a,b)=>[box[2],a[1]+(b[1]-a[1])*(box[2]-a[0])/(b[0]-a[0])]],
    [p=>p[1]>=box[1],(a,b)=>[a[0]+(b[0]-a[0])*(box[1]-a[1])/(b[1]-a[1]),box[1]]],
    [p=>p[1]<=box[3],(a,b)=>[a[0]+(b[0]-a[0])*(box[3]-a[1])/(b[1]-a[1]),box[3]]]];
  for(const [inside,cut] of edges) {
    const input=out;out=[];if(!input.length)break;
    for(let i=0;i<input.length;i++) {
      const cur=input[i],prev=input[(i+input.length-1)%input.length];
      if(inside(cur)){if(!inside(prev))out.push(cut(prev,cur));out.push(cur);}
      else if(inside(prev))out.push(cut(prev,cur));
    }
  }
  const unique=[];for(const p of out.map(r4))if(!unique.length || unique.at(-1)[0]!==p[0] || unique.at(-1)[1]!==p[1])unique.push(p);
  while(unique.length>1 && unique[0][0]===unique.at(-1)[0] && unique[0][1]===unique.at(-1)[1])unique.pop();
  // Only an area counts: a polygon that merely touches the region edge clips to nothing.
  return unique.length>=3 && polygonArea(unique)>1e-9 ? unique : [];
}
/** Runs of consecutive polyline segments touching the box (expanded by half the stroke). */
function polylineRuns(points,box,halfWidth) {
  const runs=[];let run=null;const query=[box[0]-halfWidth,box[1]-halfWidth,box[2]+halfWidth,box[3]+halfWidth];
  for(let i=1;i<points.length;i++) {
    if(segmentIntersectsBox(points[i-1],points[i],query)){if(!run){run=[r6(points[i-1])];runs.push(run);}run.push(r6(points[i]));}
    else run=null;
  }
  // A closed outline that touches the region across its start point is one run, not two.
  const closed=points.length>2 && points[0][0]===points.at(-1)[0] && points[0][1]===points.at(-1)[1];
  if(closed && runs.length>1 && run===runs.at(-1) && segmentIntersectsBox(points[0],points[1],query)){
    const last=runs.pop();runs[0]=[...last,...runs[0].slice(1)];
  }
  return runs;
}
const capped = (items,limit,name,truncated) => {if(items.length>limit)truncated[name]=items.length;return items.slice(0,limit);};
const padBrief = (p,component) => ({...(component?{component}:{}),number:p.number,...(p.pin_name?{pin_name:p.pin_name}:{}),
  position_mm:r6(p.position_mm)});
const padDetail = p => ({id:p.id,number:p.number,...(p.pin_name?{pin_name:p.pin_name}:{}),net:p.net,position_mm:r6(p.position_mm),
  size_mm:r6(p.size_mm),...(p.rotation_deg?{rotation_deg:p.rotation_deg}:{}),shape:p.shape,layers:[...p.layers],
  ...(p.drill_mm.length?{drill_mm:[...p.drill_mm]}:{})});
const zoneBrief = z => ({id:z.id,net:z.net,kind:z.kind,layers:[...z.layers],...(z.owner?{owner:z.owner}:{}),
  bounds_mm:boundsOf(z.points_mm),point_count:z.points_mm.length,area_mm2:round(polygonArea(z.points_mm))});
function groupNumbers(pads,key) {
  const groups={};for(const p of pads)(groups[p[key]] ??= []).push(p.number);return groups;
}
export function componentContext(c) {
  const many=c.pads.length>CONTEXT_LIMITS.list_pads;
  return {id:c.id,reference:c.reference,...(c.native_reference!==undefined?{native_reference:c.native_reference}:{}),
    source_path:c.source_path,value:c.value ?? '',footprint:c.footprint ?? '',position_mm:r6(c.position_mm),rotation_deg:c.rotation_deg,
    side:c.side,locked:!!c.locked,bounds_mm:c.bounds_mm.map(round),pad_count:c.pads.length,
    ...(many?{pads_by_net:groupNumbers(c.pads,'net')}:{pads:c.pads.map(padDetail)}),graphics_count:c.graphics.length};
}
export function netContext(scene,net) {
  const tracks=scene.tracks.filter(t=>t.net===net.name),vias=scene.vias.filter(v=>v.net===net.name),zones=scene.zones.filter(z=>z.net===net.name);
  const byLayer={};
  for(const t of tracks){const l=(byLayer[t.layer] ??= {segments:0,arcs:0,length_mm:0,widths_mm:new Set()});
    // Native objects: an arc counts once, not per display sample.
    if(t.arc)l.arcs++;else l.segments+=t.points_mm.length-1;l.widths_mm.add(t.width_mm);
    for(let i=1;i<t.points_mm.length;i++)l.length_mm+=Math.hypot(t.points_mm[i][0]-t.points_mm[i-1][0],t.points_mm[i][1]-t.points_mm[i-1][1]);}
  for(const l of Object.values(byLayer)){l.length_mm=round(l.length_mm);l.widths_mm=[...l.widths_mm].sort((a,b)=>a-b);}
  const spans={};for(const v of vias){const key=`${v.layers[0]}-${v.layers.at(-1)}`;spans[key]=(spans[key] || 0)+1;}
  const truncated={},many=net.pads.length>CONTEXT_LIMITS.list_pads;
  const bounds=mergeBounds([boundsOf(net.pads.map(p=>p.position_mm)),...tracks.map(t=>boundsOf(t.points_mm)),
    boundsOf(vias.map(v=>v.position_mm)),...zones.map(z=>boundsOf(z.points_mm))]);
  return {name:net.name,pad_count:net.pads.length,
    ...(many?{pads_by_component:groupNumbers(net.pads,'component')}:{pads:net.pads.map(p=>padBrief(p,p.component))}),
    bounds_mm:bounds && bounds.map(round),tracks_by_layer:byLayer,
    vias:{count:vias.length,by_span:spans,sizes_mm:[...new Set(vias.map(v=>`${v.size_mm}/${v.drill_mm}`))].sort()},
    zones:capped(zones.map(zoneBrief),CONTEXT_LIMITS.net_zones,'zones',truncated),
    ...(Object.keys(truncated).length?{truncated}:{})};
}
export function regionContext(scene,box,layers) {
  const L=CONTEXT_LIMITS,truncated={},visible = ls => ls.some(l=>layers.includes(l));
  const components=scene.components.filter(c=>boxesOverlap(c.bounds_mm,box)).map(c=>({reference:c.reference,
    source_path:c.source_path,position_mm:r6(c.position_mm),rotation_deg:c.rotation_deg,side:c.side,locked:!!c.locked,bounds_mm:c.bounds_mm.map(round)}));
  const pads=scene.components.flatMap(c=>c.pads.filter(p=>visible(p.layers) && polygonIntersectsBox(padCorners(p),box))
    .map(p=>({component:c.reference,...padDetail(p)})));
  const tracks=scene.tracks.filter(t=>layers.includes(t.layer)).map(t=>({t,runs:polylineRuns(t.points_mm,box,t.width_mm/2)}))
    .filter(x=>x.runs.length).map(({t,runs})=>({id:t.id,net:t.net,layer:t.layer,width_mm:t.width_mm,
      ...(t.arc?{arc:{start_mm:r6(t.arc.start_mm),mid_mm:r6(t.arc.mid_mm),end_mm:r6(t.arc.end_mm)}}:{}),
      // Whole segments that touch the region (not cut at its edge); arcs keep their native start/mid/end.
      points_mm:t.arc?undefined:runs.length===1?runs[0]:undefined,...(t.arc || runs.length===1?{}:{runs_mm:runs})}))
    .map(t=>JSON.parse(JSON.stringify(t)));
  const vias=scene.vias.filter(v=>visible(v.layers) && pointInBox(v.position_mm,expand(box,v.size_mm/2)))
    .map(v=>({id:v.id,net:v.net,position_mm:r6(v.position_mm),size_mm:v.size_mm,drill_mm:v.drill_mm,layers:[...v.layers]}));
  const zones=scene.zones.filter(z=>visible(z.layers) && polygonIntersectsBox(z.points_mm,box)).map(z=>{
    const clipped=clipPolygonToBox(z.points_mm,box),brief=zoneBrief(z);
    if(!clipped.length)return {...brief,clipped_area_mm2:0};
    return {...brief,...(clipped.length<=L.clipped_points?{clipped_points_mm:clipped}:{clipped_point_count:clipped.length,
      clipped_bounds_mm:boundsOf(clipped)}),clipped_area_mm2:round(polygonArea(clipped))};
  });
  const nets=[...new Set([...pads,...tracks,...vias,...zones].map(p=>p.net).filter(Boolean))].sort();
  const drawings=scene.drawings.filter(g=>layers.includes(g.layer) || g.layer==='Edge.Cuts').map(g=>{
    if(g.filled){const clipped=polygonIntersectsBox(g.points,box)?clipPolygonToBox(g.points,box):[];
      return clipped.length?{layer:g.layer,width_mm:g.width_mm,filled:true,clipped_points_mm:clipped}:null;}
    const runs=polylineRuns(g.points,box,g.width_mm/2);
    return runs.length?{layer:g.layer,width_mm:g.width_mm,filled:false,runs_mm:runs}:null;
  }).filter(Boolean);
  return {components:capped(components,L.region_components,'components',truncated),nets,
    pads:capped(pads,L.region_pads,'pads',truncated),tracks:capped(tracks,L.region_tracks,'tracks',truncated),
    vias:capped(vias,L.region_vias,'vias',truncated),zones:capped(zones,L.region_zones,'zones',truncated),
    drawings:capped(drawings,L.region_drawings,'drawings',truncated),...(Object.keys(truncated).length?{truncated}:{})};
}
export function snapshotSelection(scene,selection,layers) {
  const selectedComponents=scene.components.filter(c=>selection.components.includes(c.reference));
  const selectedNets=scene.nets.filter(n=>selection.nets.includes(n.name));
  return {format:'compact/v2',components:selectedComponents.map(componentContext),nets:selectedNets.map(n=>netContext(scene,n)),
    region:selection.region ? {bounds_mm:selection.region.map(round), query_layers:[...layers],
      query_precision:'conservative intersection; pad bounding polygons and stroke-expanded boxes; arcs sampled <=0.01 mm; '+
        'tracks and outlines list whole segments touching the region; zone and filled-shape outlines are clipped to it',
      context:regionContext(scene,selection.region,layers)} : null};
}
export function makeAnnotation(scene,selection,layers,fields,id=randomId()) {
  if(!fields.observation.trim()) throw new Error('Write an observation before saving.');
  const cited=fields.issues || [];
  if(!selection.components.length && !selection.nets.length && !selection.region && !fields.boardWide && !cited.length)
    throw new Error('Select a component, net, region, cite an issue, or enable a board-wide note.');
  const context=snapshotSelection(scene,selection,layers);
  if(cited.length)context.issues=cited.map(issueBrief);
  return {id,created_at:new Date().toISOString(),category:fields.category,priority:fields.priority,
    status:fields.status || 'open',observation:fields.observation.trim(),desired_behavior:fields.desired_behavior.trim(),
    board_wide:!!fields.boardWide,selection:clone(selection),visible_layers:[...layers],
    ...(cited.length?{issues:cited.map(i=>i.id)}:{}),context};
}
// CopperScript `copper issues RUN --json` documents, shown as framed windows.
export const ISSUES_SCHEMA = 'copperscript.run-issues/v1';
// CopperScript caps long net lists with a "+N more" entry: keep it as a count, not a net name.
const MORE = /^\+(\d+) more$/;
const issueBrief = i => ({id:i.id,stage:i.stage,code:i.code,title:i.title,count:i.count,
  nets:(i.nets || []).filter(n=>!MORE.test(n)),
  ...((i.nets || []).some(n=>MORE.test(n))?{nets_omitted:Number((i.nets.find(n=>MORE.test(n))).match(MORE)[1])}:{}),
  ...(i.nets_omitted?{nets_omitted:i.nets_omitted}:{}),window_mm:i.window_mm ? [...i.window_mm] : null,...(i.caused_by?{caused_by:i.caused_by}:{})});
export function validateIssues(doc,scene) {
  if(doc?.schema!==ISSUES_SCHEMA || !Array.isArray(doc.issues))
    throw new Error('Not a CopperScript issue list. Save one with: copper issues RUN --json > issues.json');
  const hashes=[doc.board_sha256,doc.filled_board_sha256].filter(h=>typeof h==='string');
  if(hashes.length && !hashes.includes(scene.board.sha256))
    throw new Error("These issues belong to a different board revision. Open that run's board.kicad_pcb (or its refilled board) first.");
  const ids=new Set();
  doc.issues.forEach((i,n)=>{
    const where=`issues[${n}]`;
    if(typeof i?.id!=='string' || !i.id || ids.has(i.id))throw new Error(`Invalid issue list: ${where}.id must be a unique string.`);
    ids.add(i.id);
    if(typeof i.code!=='string' || typeof i.title!=='string')throw new Error(`Invalid issue list: ${where} (${i.id}) needs code and title.`);
    if(i.window_mm!==null && i.window_mm!==undefined && !(Array.isArray(i.window_mm) && i.window_mm.length===4 &&
       i.window_mm.every(v=>typeof v==='number' && Number.isFinite(v)) && i.window_mm[0]<=i.window_mm[2] && i.window_mm[1]<=i.window_mm[3]))
      throw new Error(`Invalid issue list: ${where} (${i.id}).window_mm must be [x0,y0,x1,y1] mm.`);
    if(i.nets!==undefined && !(Array.isArray(i.nets) && i.nets.every(s=>typeof s==='string')))throw new Error(`Invalid issue list: ${where} (${i.id}).nets must be strings.`);
  });
  return {source:{schema:ISSUES_SCHEMA,run:typeof doc.run==='string'?doc.run:null,status:doc.status ?? null,
    board_sha256:doc.board_sha256 ?? null,filled_board_sha256:doc.filled_board_sha256 ?? null,
    board_verified:hashes.length>0,omitted:Number.isInteger(doc.omitted)?doc.omitted:0},
    issues:doc.issues.map(issueBrief)};
}
export function makeReview(scene,annotations,stage,summary,issueSource=null) {
  return {schema:REVIEW_SCHEMA,tool:{name:'CopperReview',version:TOOL_VERSION},exported_at:new Date().toISOString(),
    board:{...clone(scene.board),stage,stage_evidence:'reviewer-declared; not connectivity validation'},
    summary:summary.trim(),geometry_counts:{components:scene.components.length,nets:scene.nets.length,
      track_segments:scene.tracks.length,vias:scene.vias.length,zone_polygons:scene.zones.length},
    inspection_limits:[...scene.warnings,'Net guides show logical membership, not measured open connections.',
      'Annotations are reviewer or agent observations and requests, not validated solver constraints or DRC results.'],
    ...(issueSource && annotations.some(a=>a.issues?.length)?{copperscript_issues:clone(issueSource)}:{}),
    annotations:clone(annotations)};
}
export function validateScene(scene) {
  if(scene?.schema!==SCENE_SCHEMA || !scene.board || !/^[0-9a-f]{64}$/.test(scene.board.sha256))
    throw new Error('Not a CopperReview scene v1. Open a .kicad_pcb export or a scene exported by this app.');
  for(const key of ['components','nets','tracks','vias','zones','drawings','warnings'])
    if(!Array.isArray(scene[key])) throw new Error(`Invalid scene: ${key}`);
  if(!Array.isArray(scene.board.layers) || !Array.isArray(scene.board.bounds_mm) || scene.board.bounds_mm.length!==4 ||
     scene.board.bounds_mm.some(n=>typeof n!=='number' || !Number.isFinite(n))) throw new Error('Invalid board coordinates');
  // Each failure names the object (index plus id/reference/name) and the field.
  const fail=(where,field,why='is invalid')=>{throw new Error(`Invalid scene geometry or identity: ${where}.${field} ${why}.`);};
  const finite=n=>typeof n==='number' && Number.isFinite(n) && Math.abs(n)<=1e8;
  const vector=(v,len=2)=>Array.isArray(v) && v.length===len && v.every(finite);
  const strings=v=>Array.isArray(v) && v.every(s=>typeof s==='string');
  const points=v=>Array.isArray(v) && v.every(p=>vector(p));
  const label=(kind,i,o,key='id')=>`${kind}[${i}]${o && typeof o[key]==='string' && o[key]?` (${o[key]})`:''}`;
  const check=(ok,where,field,why)=>{if(!ok)fail(where,field,why);};
  const graphicCheck=(g,where)=>{check(points(g.points),where,'points','must be [x,y] mm pairs');check(typeof g.layer==='string',where,'layer');
    check(finite(g.width_mm) && g.width_mm>=0,where,'width_mm','must be a finite width >= 0');check(typeof g.filled==='boolean',where,'filled','must be true/false');};
  const coordinates=scene.board.coordinates;
  for(const [key,value] of [['units','mm'],['x_axis','right'],['y_axis','down']])
    check(coordinates?.[key]===value,'board',`coordinates.${key}`,`must be "${value}"`);
  check(strings(scene.board.layers),'board','layers','must be layer names');check(strings(scene.warnings),'scene','warnings','must be strings');
  check(typeof scene.board.name==='string','board','name','must be a string');
  check(scene.board.bounds_mm[0]<=scene.board.bounds_mm[2] && scene.board.bounds_mm[1]<=scene.board.bounds_mm[3],'board','bounds_mm','must be ascending');
  const refs=new Set();
  scene.components.forEach((c,i)=>{
    const where=label('components',i,c,'reference');
    check(typeof c.reference==='string',where,'reference','must be a string');
    check(!refs.has(c.reference),where,'reference','repeats an earlier component; open the .kicad_pcb again to rename duplicates');
    refs.add(c.reference);
    check(c.native_reference===undefined || typeof c.native_reference==='string',where,'native_reference');
    check(typeof c.source_path==='string',where,'source_path');check(typeof c.id==='string',where,'id');
    check(vector(c.position_mm),where,'position_mm','must be [x,y] mm');check(vector(c.bounds_mm,4),where,'bounds_mm','must be 4 numbers');
    check(finite(c.rotation_deg),where,'rotation_deg');check(['front','back'].includes(c.side),where,'side','must be front or back');
    check(Array.isArray(c.graphics),where,'graphics','must be a list');c.graphics.forEach((g,j)=>graphicCheck(g,`${where}.graphics[${j}]`));
    check(Array.isArray(c.pads),where,'pads','must be a list');
    c.pads.forEach((p,j)=>{const at=`${where}.pads[${j}]${typeof p.number==='string'?` (${p.number})`:''}`;
      check(typeof p.id==='string',at,'id');check(typeof p.number==='string',at,'number','must be a string');check(typeof p.net==='string',at,'net','must be a string');
      check(p.pin_name===undefined || typeof p.pin_name==='string',at,'pin_name');
      check(vector(p.position_mm),at,'position_mm','must be [x,y] mm');check(vector(p.size_mm) && p.size_mm.every(n=>n>0),at,'size_mm','must be two positive mm values');
      check(finite(p.rotation_deg),at,'rotation_deg');check(typeof p.shape==='string',at,'shape');check(strings(p.layers),at,'layers','must be layer names');
      check(Array.isArray(p.drill_mm) && [0,2].includes(p.drill_mm.length) && p.drill_mm.every(finite),at,'drill_mm','must be [] or [x,y] mm');
      check(finite(p.roundrect_ratio) && p.roundrect_ratio>=0 && p.roundrect_ratio<=.5,at,'roundrect_ratio','must be within 0..0.5');});
  });
  scene.tracks.forEach((t,i)=>{const where=label('tracks',i,t);
    check(typeof t.id==='string',where,'id');check(typeof t.net==='string',where,'net','must be a string');
    check(points(t.points_mm) && t.points_mm.length>=2,where,'points_mm','must hold at least two [x,y] mm points');
    check(finite(t.width_mm) && t.width_mm>0,where,'width_mm','must be a positive width');check(typeof t.layer==='string',where,'layer');});
  scene.vias.forEach((v,i)=>{const where=label('vias',i,v);
    check(typeof v.id==='string',where,'id');check(typeof v.net==='string',where,'net','must be a string');check(vector(v.position_mm),where,'position_mm','must be [x,y] mm');
    check(finite(v.size_mm) && v.size_mm>0,where,'size_mm','must be positive');check(finite(v.drill_mm) && v.drill_mm>0,where,'drill_mm','must be positive');
    check(strings(v.layers),where,'layers','must be layer names');});
  scene.zones.forEach((z,i)=>{const where=label('zones',i,z);
    check(typeof z.id==='string',where,'id');check(typeof z.net==='string',where,'net','must be a string');
    check(points(z.points_mm),where,'points_mm','must be [x,y] mm points');
    check(strings(z.layers),where,'layers','must be layer names');check(['intent','fill','keepout','copper'].includes(z.kind),where,'kind','must be intent, fill, keepout or copper');});
  scene.nets.forEach((n,i)=>{const where=label('nets',i,n,'name');
    check(typeof n.name==='string',where,'name');check(Array.isArray(n.pads),where,'pads','must be a list');
    n.pads.forEach((p,j)=>check(typeof p.component==='string' && typeof p.number==='string' && vector(p.position_mm) && strings(p.layers),
      `${where}.pads[${j}]`,'component/number/position_mm/layers'));});
  scene.drawings.forEach((g,i)=>graphicCheck(g,`drawings[${i}]`));
  // Older scenes have no texts.
  check(scene.texts===undefined || Array.isArray(scene.texts),'scene','texts','must be a list');
  (scene.texts||[]).forEach((x,i)=>{const where=`texts[${i}]`;
    check(typeof x.text==='string',where,'text','must be a string');check(vector(x.position_mm),where,'position_mm','must be [x,y] mm');
    check(vector(x.size_mm) && x.size_mm.every(n=>n>0),where,'size_mm','must be two positive mm values');check(finite(x.rotation_deg),where,'rotation_deg');
    check(typeof x.layer==='string',where,'layer');check(strings(x.justify),where,'justify','must be strings');check(typeof x.mirror==='boolean',where,'mirror','must be true/false');});
  return scene;
}
export function validateReview(review,scene) {
  if(!READABLE_REVIEW_SCHEMAS.includes(review?.schema) || !Array.isArray(review.annotations)) throw new Error('Not a CopperReview review (v1 or v2).');
  if(review.board?.sha256!==scene.board.sha256) throw new Error('This review belongs to a different board revision. Load the exact PCB/scene first.');
  const ids=new Set();
  for(const a of review.annotations) {
    if(typeof a.id!=='string' || typeof a.observation!=='string' || typeof a.desired_behavior!=='string' ||
       !a.selection || !Array.isArray(a.selection.components) || !Array.isArray(a.selection.nets) || !Array.isArray(a.visible_layers))
      throw new Error('Invalid review annotation.');
    if(ids.has(a.id) || !['placement','routing','package_escape','return_path','mechanical','algorithm','other'].includes(a.category) ||
       !['low','medium','high'].includes(a.priority) || !['open','resolved'].includes(a.status) ||
       typeof a.board_wide!=='boolean' || a.visible_layers.some(l=>!scene.board.layers.includes(l)) ||
       (a.issues!==undefined && !(Array.isArray(a.issues) && a.issues.every(s=>typeof s==='string')))) throw new Error('Invalid review annotation fields.');
    ids.add(a.id);
    // Older imports named a blank or repeated reference by its native text; map it to the
    // renamed component when exactly one component carries that native reference.
    a.selection.components=a.selection.components.map(r=>{
      if(scene.components.some(c=>c.reference===r))return r;
      const renamed=scene.components.filter(c=>c.native_reference===r);
      return renamed.length===1 ? renamed[0].reference : r;
    });
    if(a.selection.components.some(r=>!scene.components.some(c=>c.reference===r)) ||
       a.selection.nets.some(n=>!scene.nets.some(net=>net.name===n))) throw new Error('Review references missing entities.');
    if(a.selection.region && (!Array.isArray(a.selection.region) || a.selection.region.length!==4 ||
       a.selection.region.some(n=>typeof n!=='number' || !Number.isFinite(n)) ||
       a.selection.region[0]>a.selection.region[2] || a.selection.region[1]>a.selection.region[3])) throw new Error('Invalid review region.');
  }
  if(!['unknown','placed','partially_routed','fully_routed'].includes(review.board.stage)) throw new Error('Invalid review stage.');
  return review;
}
/** Rebuild each annotation's context from the (hash-identical) scene in the current compact format. */
export function refreshContexts(scene,annotations) {
  // Cited CopperScript issues are not part of the scene: keep their saved summaries.
  return annotations.map(a=>{const context=snapshotSelection(scene,a.selection,a.visible_layers);
    if(a.context?.issues)context.issues=clone(a.context.issues);return {...clone(a),context};});
}
