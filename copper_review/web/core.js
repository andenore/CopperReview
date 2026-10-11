/* Pure geometry and review contract, also exercised by Node's built-in tests. */
export const REVIEW_SCHEMA = 'copper-review/v1';
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
export function regionContext(scene,box,layers) {
  const visible = ls => ls.some(l=>layers.includes(l));
  const components=scene.components.filter(c=>boxesOverlap(c.bounds_mm,box)).map(c=>({reference:c.reference,
    source_path:c.source_path,position_mm:clone(c.position_mm),rotation_deg:c.rotation_deg,side:c.side,locked:c.locked,bounds_mm:clone(c.bounds_mm)}));
  const pads=scene.components.flatMap(c=>c.pads.filter(p=>visible(p.layers) && polygonIntersectsBox(padCorners(p),box))
    .map(p=>({component:c.reference,source_path:c.source_path,...clone(p)})));
  const tracks=scene.tracks.filter(t=>layers.includes(t.layer) && t.points_mm.slice(1).some((p,i)=>segmentIntersectsBox(t.points_mm[i],p,expand(box,t.width_mm/2))));
  const vias=scene.vias.filter(v=>visible(v.layers) && pointInBox(v.position_mm,expand(box,v.size_mm/2)));
  const zones=scene.zones.filter(z=>visible(z.layers) && polygonIntersectsBox(z.points_mm,box));
  const nets=[...new Set([...pads,...tracks,...vias,...zones].map(p=>p.net).filter(Boolean))].sort();
  const drawings=scene.drawings.filter(g=>(layers.includes(g.layer) || g.layer==='Edge.Cuts') &&
    (g.filled ? polygonIntersectsBox(g.points,box) : g.points.slice(1).some((p,i)=>segmentIntersectsBox(g.points[i],p,expand(box,g.width_mm/2)))));
  return {components,nets,pads,tracks:clone(tracks),vias:clone(vias),zones:clone(zones),drawings:clone(drawings)};
}
export function snapshotSelection(scene,selection,layers) {
  const selectedComponents=scene.components.filter(c=>selection.components.includes(c.reference));
  const selectedNets=scene.nets.filter(n=>selection.nets.includes(n.name));
  const tracked=scene.tracks.filter(t=>selection.nets.includes(t.net));
  const vias=scene.vias.filter(v=>selection.nets.includes(v.net));
  return {components:selectedComponents.map(c=>clone(c)), nets:selectedNets.map(n=>({...clone(n),
    tracks:clone(tracked.filter(t=>t.net===n.name)),vias:clone(vias.filter(v=>v.net===n.name)),
    zones:clone(scene.zones.filter(z=>z.net===n.name))})),
    region:selection.region ? {bounds_mm:selection.region.map(round), query_layers:[...layers],
      query_precision:'conservative intersection; pad bounding polygons and stroke-expanded boxes; arcs sampled <=0.01 mm',
      context:regionContext(scene,selection.region,layers)} : null};
}
export function makeAnnotation(scene,selection,layers,fields,id=globalThis.crypto.randomUUID()) {
  if(!fields.observation.trim()) throw new Error('Write an observation before saving.');
  if(!selection.components.length && !selection.nets.length && !selection.region && !fields.boardWide)
    throw new Error('Select a component, net, region, or enable a board-wide note.');
  return {id,created_at:new Date().toISOString(),category:fields.category,priority:fields.priority,
    status:fields.status || 'open',observation:fields.observation.trim(),desired_behavior:fields.desired_behavior.trim(),
    board_wide:!!fields.boardWide,selection:clone(selection),visible_layers:[...layers],
    context:snapshotSelection(scene,selection,layers)};
}
export function makeReview(scene,annotations,stage,summary) {
  return {schema:REVIEW_SCHEMA,tool:{name:'CopperReview',version:'0.1.0'},exported_at:new Date().toISOString(),
    board:{...clone(scene.board),stage,stage_evidence:'reviewer-declared; not connectivity validation'},
    summary:summary.trim(),geometry_counts:{components:scene.components.length,nets:scene.nets.length,
      track_segments:scene.tracks.length,vias:scene.vias.length,zone_polygons:scene.zones.length},
    inspection_limits:[...scene.warnings,'Net guides show logical membership, not measured open connections.',
      'Annotations are human observations and requests, not validated solver constraints or DRC results.'],
    annotations:clone(annotations)};
}
export function validateScene(scene) {
  if(scene?.schema!==SCENE_SCHEMA || !scene.board || !/^[0-9a-f]{64}$/.test(scene.board.sha256))
    throw new Error('Not a CopperReview scene v1. Open a .kicad_pcb export or a scene exported by this app.');
  for(const key of ['components','nets','tracks','vias','zones','drawings','warnings'])
    if(!Array.isArray(scene[key])) throw new Error(`Invalid scene: ${key}`);
  if(!Array.isArray(scene.board.layers) || !Array.isArray(scene.board.bounds_mm) || scene.board.bounds_mm.length!==4 ||
     scene.board.bounds_mm.some(n=>typeof n!=='number' || !Number.isFinite(n))) throw new Error('Invalid board coordinates');
  const fail=()=>{throw new Error('Invalid scene geometry or identity.');};
  const finite=n=>typeof n==='number' && Number.isFinite(n) && Math.abs(n)<=1e8;
  const vector=(v,len=2)=>Array.isArray(v) && v.length===len && v.every(finite);
  const strings=v=>Array.isArray(v) && v.every(s=>typeof s==='string');
  const points=v=>Array.isArray(v) && v.every(p=>vector(p));
  const gValid=g=>points(g.points) && typeof g.layer==='string' && finite(g.width_mm) && g.width_mm>=0 && typeof g.filled==='boolean';
  if(scene.board.coordinates?.units!=='mm' || scene.board.coordinates?.x_axis!=='right' || scene.board.coordinates?.y_axis!=='down' ||
     !strings(scene.board.layers) || !strings(scene.warnings) || typeof scene.board.name!=='string' ||
     scene.board.bounds_mm[0]>scene.board.bounds_mm[2] || scene.board.bounds_mm[1]>scene.board.bounds_mm[3])fail();
  const refs=new Set();
  for(const c of scene.components){
    if(typeof c.reference!=='string' || refs.has(c.reference) || typeof c.source_path!=='string' || typeof c.id!=='string' ||
       !vector(c.position_mm) || !vector(c.bounds_mm,4) || !finite(c.rotation_deg) || !['front','back'].includes(c.side) ||
       !Array.isArray(c.graphics) || !c.graphics.every(gValid) || !Array.isArray(c.pads))fail();
    refs.add(c.reference);
    for(const p of c.pads)if(typeof p.id!=='string' || typeof p.number!=='string' || typeof p.net!=='string' ||
       (p.pin_name!==undefined && typeof p.pin_name!=='string') ||
       !vector(p.position_mm) || !vector(p.size_mm) || p.size_mm.some(n=>n<=0) || !finite(p.rotation_deg) ||
       typeof p.shape!=='string' || !strings(p.layers) || !Array.isArray(p.drill_mm) ||
       ![0,2].includes(p.drill_mm.length) || !p.drill_mm.every(finite) || !finite(p.roundrect_ratio) || p.roundrect_ratio<0 || p.roundrect_ratio>.5)fail();
  }
  for(const t of scene.tracks)if(typeof t.id!=='string' || typeof t.net!=='string' || !points(t.points_mm) || t.points_mm.length<2 ||
    !finite(t.width_mm) || t.width_mm<=0 || typeof t.layer!=='string')fail();
  for(const v of scene.vias)if(typeof v.id!=='string' || typeof v.net!=='string' || !vector(v.position_mm) ||
    !finite(v.size_mm) || v.size_mm<=0 || !finite(v.drill_mm) || v.drill_mm<=0 || !strings(v.layers))fail();
  for(const z of scene.zones)if(typeof z.id!=='string' || typeof z.net!=='string' || !points(z.points_mm) ||
    !strings(z.layers) || !['intent','fill','keepout','copper'].includes(z.kind))fail();
  for(const n of scene.nets)if(typeof n.name!=='string' || !Array.isArray(n.pads) ||
    !n.pads.every(p=>typeof p.component==='string' && typeof p.number==='string' && vector(p.position_mm) && strings(p.layers)))fail();
  if(!scene.drawings.every(gValid))fail();
  return scene;
}
export function validateReview(review,scene) {
  if(review?.schema!==REVIEW_SCHEMA || !Array.isArray(review.annotations)) throw new Error('Not a CopperReview review v1.');
  if(review.board?.sha256!==scene.board.sha256) throw new Error('This review belongs to a different board revision. Load the exact PCB/scene first.');
  const ids=new Set();
  for(const a of review.annotations) {
    if(typeof a.id!=='string' || typeof a.observation!=='string' || typeof a.desired_behavior!=='string' ||
       !a.selection || !Array.isArray(a.selection.components) || !Array.isArray(a.selection.nets) || !Array.isArray(a.visible_layers))
      throw new Error('Invalid review annotation.');
    if(ids.has(a.id) || !['placement','routing','package_escape','return_path','mechanical','algorithm','other'].includes(a.category) ||
       !['low','medium','high'].includes(a.priority) || !['open','resolved'].includes(a.status) ||
       typeof a.board_wide!=='boolean' || a.visible_layers.some(l=>!scene.board.layers.includes(l))) throw new Error('Invalid review annotation fields.');
    ids.add(a.id);
    if(a.selection.components.some(r=>!scene.components.some(c=>c.reference===r)) ||
       a.selection.nets.some(n=>!scene.nets.some(net=>net.name===n))) throw new Error('Review references missing entities.');
    if(a.selection.region && (!Array.isArray(a.selection.region) || a.selection.region.length!==4 ||
       a.selection.region.some(n=>typeof n!=='number' || !Number.isFinite(n)) ||
       a.selection.region[0]>a.selection.region[2] || a.selection.region[1]>a.selection.region[3])) throw new Error('Invalid review region.');
  }
  if(!['unknown','placed','partially_routed','fully_routed'].includes(review.board.stage)) throw new Error('Invalid review stage.');
  return review;
}
