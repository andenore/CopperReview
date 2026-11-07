/* 3D bodies: VRML parsing, model choice and placement. Pure, so Node tests it.
   World frame: millimetres, x right, y up the page (board y negated), z up from the top copper face.
   Board slab is thickness below z=0; back-side parts hang below it. */
import {textTransform} from './silk-text.js';

export const WRL_UNIT_MM = 2.54; // KiCad reads one VRML unit as 0.1 inch. STEP bodies are already millimetres.
export const MAX_TRIANGLES = 3e6;
export const DEFAULT_THICKNESS_MM = 1.6;
const SIZE_LIMIT = 20e6;

/** Triangles of every IndexedFaceSet in `text`: the flat Shape/Coordinate subset CopperScript writes, and
    KiCad's library files, which name materials once (DEF) and reuse them (USE), often after the geometry. */
export function parseVrml(text) {
  if(typeof text!=='string' || text.length>SIZE_LIMIT || !text.startsWith('#VRML V2.0'))throw new Error('Not a VRML 2.0 file');
  const unsupported=/\b(Inline|Script|PROTO)\b/.test(text);
  const parts=[],materials=new Map();let color=[.7,.7,.7],name='',material=null,shapeStart=0;
  const paint=c=>{color=c;for(let k=shapeStart;k<parts.length;k++)parts[k].color=[...c];};
  const tokens=text.replace(/#.*$/gm,'').replace(/[{}[\],]/g,m=>` ${m==='['||m===']'?m:m==='{'||m==='}'?m:' '} `).split(/\s+/).filter(Boolean);
  const numbersAfter=(i)=>{ // tokens[i] === '[': numbers up to ']'
    const values=[];for(i++;i<tokens.length && tokens[i]!==']';i++)values.push(Number(tokens[i]));
    if(values.some(v=>!Number.isFinite(v)))throw new Error('Invalid number in VRML');return values;};
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token==='Shape')shapeStart=parts.length;
    else if(token==='DEF'){if(tokens[i+2]==='Material')material=tokens[i+1];else if(tokens[i+2]!=='Appearance')name=tokens[i+1]||'';}
    else if(token==='USE'&&tokens[i-1]==='material'&&materials.has(tokens[i+1]))paint(materials.get(tokens[i+1]));
    else if(token==='diffuseColor'){const c=tokens.slice(i+1,i+4).map(Number);if(c.length===3&&c.every(Number.isFinite)){if(material)materials.set(material,c);material=null;paint(c);}}
    // Only a Coordinate's points are vertices; a TextureCoordinate's are 2D and skipped.
    else if(token==='point'&&tokens[i+1]==='['&&tokens[i-2]==='Coordinate'){parts.push({name,color:[...color],points:numbersAfter(i+1),index:[]});}
    else if(token==='coordIndex'&&tokens[i+1]==='['&&parts.length){parts[parts.length-1].index=numbersAfter(i+1);}
  }
  const result=[];
  for(const part of parts){
    if(part.points.length%3)throw new Error('VRML coordinates are not triples');
    const count=part.points.length/3,triangles=[];let face=[];
    for(const raw of part.index){
      if(raw<0){for(let k=1;k+1<face.length;k++)triangles.push(face[0],face[k],face[k+1]);face=[];}
      else{if(!Number.isInteger(raw)||raw>=count)throw new Error('VRML index out of range');face.push(raw);}
    }
    result.push({name:part.name,color:part.color,points:Float32Array.from(part.points),triangles:Uint32Array.from(triangles)});
  }
  return {parts:result,unsupported,unit:WRL_UNIT_MM};
}

/** sRGB from the linear RGB occt-import-js reports. OpenCascade converts a STEP file's colours, which are
    sRGB like VRML's and the viewer's, to linear light; drawn unconverted they come out far too dark
    (KiCad's SMA connector body, 0.298 grey in the file, arrives as 0.072 and looked black). */
export function linearToSrgb(color) {
  return color.map(c=>{const v=Math.min(1,Math.max(0,c));return v<=.0031308?v*12.92:v>=1?1:1.055*Math.pow(v,1/2.4)-.055;});
}

/** A STEP file read by occt-import-js (see step-worker.js) as a body in millimetres. Faces with their own
    colour become separate parts; the rest take the mesh colour. Colours are converted back to sRGB. */
export function occtToBody(result) {
  const parts=[];let triangles=0;
  for(const mesh of result?.meshes||[]){
    const {position:points,index}=mesh,count=points.length/3;
    if(points.length%3||index.length%3)throw new Error('STEP mesh is not made of triangles');
    for(let i=0;i<index.length;i++)if(!(index[i]<count))throw new Error('STEP mesh index out of range');
    const base=Array.isArray(mesh.color)&&mesh.color.length===3?linearToSrgb(mesh.color):[.72,.72,.74];
    const faces=(mesh.faces||[]).filter(f=>Number.isInteger(f.first)&&Number.isInteger(f.last)&&f.first>=0&&f.last*3+2<index.length);
    triangles+=index.length/3;
    if(triangles>MAX_TRIANGLES)throw new Error('STEP model is too detailed to draw');
    if(faces.some(f=>f.color)){
      const groups=new Map();
      for(const f of faces){
        const color=Array.isArray(f.color)&&f.color.length===3?linearToSrgb(f.color):base,key=color.join(',');
        if(!groups.has(key))groups.set(key,{color,ranges:[]});
        groups.get(key).ranges.push([f.first,f.last]);
      }
      for(const group of groups.values()){
        let n=0;for(const [a,b] of group.ranges)n+=Math.max(0,b-a+1);
        const picked=new Uint32Array(n*3);let o=0;
        for(const [a,b] of group.ranges)for(let t=a;t<=b;t++){picked[o++]=index[t*3];picked[o++]=index[t*3+1];picked[o++]=index[t*3+2];}
        parts.push({name:mesh.name||'',color:group.color,points,triangles:picked});
      }
    }else parts.push({name:mesh.name||'',color:base,points,triangles:index});
  }
  return {parts,unsupported:false,unit:1};
}

/** `wrl` or `step` for a model path, else null. */
export function modelKind(path) {
  const extension=String(path).toLowerCase().split('.').pop();
  return extension==='wrl'?'wrl':extension==='step'||extension==='stp'?'step':null;
}

/** `${KIPRJMOD}/Dir.3dshapes/file.wrl|step` (or already relative) to `Dir.3dshapes/file.ext`; null if the viewer cannot fetch it. */
export function resolveModelPath(path) {
  if(typeof path!=='string')return null;
  const relative=path.startsWith('${KIPRJMOD}/')?path.slice('${KIPRJMOD}/'.length):path;
  const parts=relative.split('/');
  if(parts.length!==2||!parts[0].endsWith('.3dshapes')||!modelKind(parts[1])||parts.includes('..')||relative.includes('\\'))return null;
  return relative;
}

const IDENTITY_MODEL={offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]};

/** Where a component's body may come from, best first: its own models in file order, then the generated body. */
export function candidates(component) {
  const body=resolveModelPath(component.body_model),found=[];
  for(const model of component.models||[]){
    const path=resolveModelPath(model.path);
    if(path&&!found.some(c=>c.path===path))found.push({path,model,approximate:path===body,kind:modelKind(path)});
  }
  if(body&&!found.some(c=>c.path===body))found.push({path:body,model:IDENTITY_MODEL,approximate:true,kind:modelKind(body)});
  return found;
}

/** The first candidate: the model to draw when everything can be fetched. */
export function pickModel(component) {
  return candidates(component)[0]||null;
}

/** The first candidate whose body is available, or null. */
export function chosen(component, bodies) {
  return candidates(component).find(c=>bodies.has(c.path))||null;
}

const mul3=(a,b)=>{const r=new Array(9).fill(0);for(let i=0;i<3;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++)r[i*3+j]+=a[i*3+k]*b[k*3+j];return r;};
function rotation([rx,ry,rz]) {
  const [cx,sx,cy,sy,cz,sz]=[rx,ry,rz].flatMap(d=>{const r=d*Math.PI/180;return [Math.cos(r),Math.sin(r)];});
  const X=[1,0,0,0,cx,-sx,0,sx,cx],Y=[cy,0,sy,0,1,0,-sy,0,cy],Z=[cz,-sz,0,sz,cz,0,0,0,1];
  return mul3(Z,mul3(Y,X)); // x first; only the identity is checked against KiCad
}

export const BODY_INPUT_SCHEMA = 'copperscript.body-input/v1';
/** The request that makes CopperScript generate this component's body (also the cache key), or null. */
export function bodyInputKey(component) {
  const input=component.body_input;
  return input&&Array.isArray(input.pads)?JSON.stringify({schema:BODY_INPUT_SCHEMA,...input}):null;
}

/** Maps a model-frame point to the world frame for `component`.
    `unit` is mm per model unit; `mirror` flips back-side parts' x, as KiCad does for library models. */
export function placement(component, model, thickness=DEFAULT_THICKNESS_MM, {unit=WRL_UNIT_MM,mirror=true}={}) {
  const scale=model.scale||[1,1,1],offset=model.offset_mm||[0,0,0],R=rotation(model.rotate_deg||[0,0,0]);
  const back=component.side==='back',angle=(component.rotation_deg||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const [px,py]=component.position_mm;
  return point=>{
    const m=[point[0]*unit*scale[0],point[1]*unit*scale[1],point[2]*unit*scale[2]];
    let x=R[0]*m[0]+R[1]*m[1]+R[2]*m[2]+offset[0],y=R[3]*m[0]+R[4]*m[1]+R[5]*m[2]+offset[1],z=R[6]*m[0]+R[7]*m[1]+R[8]*m[2]+offset[2];
    if(back){if(mirror)x=-x;z=-z-thickness;}
    return [px+x*c-y*s,-py+x*s+y*c,z];
  };
}

export const BOARD_FEATURE_COLORS={copper:[.18,.47,.31],pad:[.82,.66,.34],silk:[.93,.93,.89],hole:[.04,.05,.05]};
const LIFT={fill:.015,copper:.03,pad:.045,silk:.06,hole:.07};

/** A pad's outline in board millimetres (y down): a convex polygon, rotated like the 2D view draws it. */
export function padOutline(pad) {
  const [w,h]=pad.size_mm,[px,py]=pad.position_mm,local=[];
  const arc=(cx,cy,r,from,steps)=>{for(let i=0;i<=steps;i++){const a=from+(steps?i*Math.PI/2/steps:0);local.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}};
  if(pad.shape==='circle'){const r=w/2;for(let i=0;i<24;i++){const a=i*Math.PI/12;local.push([r*Math.cos(a),r*Math.sin(a)]);}}
  else{
    // Rounded rectangle covers rect (r=0), roundrect (KiCad's ratio of the short side) and oval (a full half circle).
    const r=pad.shape==='oval'?Math.min(w,h)/2:pad.shape==='roundrect'?Math.min(w,h)*Math.min(.5,pad.roundrect_ratio??.25):0;
    const x=w/2-r,y=h/2-r,steps=r?6:0;
    arc(x,y,r,0,steps);arc(-x,y,r,Math.PI/2,steps);arc(-x,-y,r,Math.PI,steps);arc(x,-y,r,Math.PI*1.5,steps);
  }
  const t=(pad.rotation_deg||0)*Math.PI/180,c=Math.cos(t),s=Math.sin(t);
  return local.map(([x,y])=>[px+x*c+y*s,py-x*s+y*c]);
}

/** Copper, pads, vias, drill holes and silkscreen on the outer faces, as triangles; copper fills come back as
    polygons (their holes joined by zero-width bridges) for the viewer to fill with a stencil, and so do filled silk
    shapes such as logos. `textRects(text)` gives a silk text's glyph rectangles in its own frame (see silk-text.js).
    Inner layers are hidden. */
function boardFeatures(scene,thickness,triangle,textRects) {
  const faces=layer=>layer==='F.Cu'||layer==='F.SilkS'?[1]:layer==='B.Cu'||layer==='B.SilkS'?[-1]:[];
  const at=(side,lift)=>([x,y])=>[x,-y,side>0?lift:-thickness-lift];
  const polygon=(points,color)=>{for(let i=1;i+1<points.length;i++)triangle(points[0],points[i],points[i+1],color);};
  const disc=(center,r,place,color,steps=16)=>{const ring=[];for(let i=0;i<steps;i++){const a=i*2*Math.PI/steps;ring.push(place([center[0]+r*Math.cos(a),center[1]+r*Math.sin(a)]));}polygon(ring,color);};
  const stroke=(points,width,place,color)=>{
    const r=width/2;
    for(let i=1;i<points.length;i++){
      const [a,b]=[points[i-1],points[i]],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!length)continue;
      const n=[-(b[1]-a[1])/length*r,(b[0]-a[0])/length*r];
      polygon([[a[0]+n[0],a[1]+n[1]],[b[0]+n[0],b[1]+n[1]],[b[0]-n[0],b[1]-n[1]],[a[0]-n[0],a[1]-n[1]]].map(place),color);
    }
    for(const p of points)disc(p,r,place,color,10);
  };
  const C=BOARD_FEATURE_COLORS,fills=[];
  for(const zone of scene.zones||[]){
    if(zone.kind!=='fill'||zone.points_mm.length<3)continue;
    for(const side of zone.layers.flatMap(faces))
      fills.push({points:Float32Array.from(zone.points_mm.flatMap(at(side,LIFT.fill))),color:C.copper,normal:[0,0,side]});
  }
  for(const track of scene.tracks||[])for(const side of faces(track.layer))stroke(track.points_mm,track.width_mm,at(side,LIFT.copper),C.copper);
  for(const via of scene.vias||[])for(const side of [1,-1]){
    disc(via.position_mm,via.size_mm/2,at(side,LIFT.copper),C.copper);if(via.drill_mm)disc(via.position_mm,via.drill_mm/2,at(side,LIFT.hole),C.hole,10);
  }
  for(const component of scene.components)for(const pad of component.pads||[]){
    if(!pad.size_mm||!pad.position_mm)continue;
    const sides=new Set((pad.layers||[]).flatMap(faces)),drill=pad.drill_mm?.length?Math.min(...pad.drill_mm)/2:0;
    for(const side of sides){polygon(padOutline(pad).map(at(side,LIFT.pad)),C.pad);if(drill)disc(pad.position_mm,drill,at(side,LIFT.hole),C.hole);}
  }
  const silk=[...scene.drawings||[],...scene.components.flatMap(c=>c.graphics||[])];
  for(const g of silk)for(const side of faces(g.layer))if(g.points?.length){
    stroke(g.points,g.width_mm||.12,at(side,LIFT.silk),C.silk);
    if(g.filled&&g.points.length>=3)fills.push({points:Float32Array.from(g.points.flatMap(at(side,LIFT.silk))),color:C.silk,normal:[0,0,side]});
  }
  if(textRects)for(const text of scene.texts||[])for(const side of faces(text.layer)){
    const board=textTransform(text),place=at(side,LIFT.silk);
    for(const [x0,y0,x1,y1] of textRects(text))polygon([[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(p=>place(board(p))),C.silk);
  }
  return fills;
}

/** One flat-shaded triangle soup for the whole board: board slab, its outer copper and silkscreen, and every placed body. */
export function buildSoup(scene, bodies, thickness=DEFAULT_THICKNESS_MM, {textRects}={}) {
  const positions=[],normals=[],colors=[],ranges=[];
  const triangle=(a,b,c,color)=>{
    const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...n);if(!length)return;n=n.map(x=>x/length);
    for(const p of [a,b,c]){positions.push(...p);normals.push(...n);colors.push(...color);}
  };
  const [x0,y0,x1,y1]=scene.board.bounds_mm,[X0,X1,Y0,Y1]=[x0,x1,-y1,-y0];
  const slab=[[X0,Y0],[X1,Y0],[X1,Y1],[X0,Y1]],green=[.1,.32,.22];
  const quad=(a,b,c,d,color)=>{triangle(a,b,c,color);triangle(a,c,d,color);};
  const top=slab.map(p=>[...p,0]),bottom=slab.map(p=>[...p,-thickness]);
  quad(top[0],top[1],top[2],top[3],green);quad(bottom[3],bottom[2],bottom[1],bottom[0],green);
  for(let i=0;i<4;i++){const j=(i+1)%4;quad(bottom[i],bottom[j],top[j],top[i],[.07,.22,.15]);}
  const fills=boardFeatures(scene,thickness,triangle,textRects);
  let drawn=0,approximate=0;
  for(const component of scene.components){
    const choice=chosen(component,bodies),served=choice&&bodies.get(choice.path),key=bodyInputKey(component);
    const generated=!served&&key&&bodies.get('input:'+key);
    const body=served||generated;
    if(!body)continue;
    // A file model follows KiCad's conventions. A body generated from the footprint's own frame is already
    // in millimetres and, for back parts, already mirrored like the file's pads.
    const place=served?placement(component,choice.model,thickness,{unit:served.unit??WRL_UNIT_MM}):placement(component,{},thickness,{unit:1,mirror:false}),start=positions.length/3;
    for(const part of body.parts){
      const p=i=>place([part.points[i*3],part.points[i*3+1],part.points[i*3+2]]);
      for(let t=0;t<part.triangles.length;t+=3)triangle(p(part.triangles[t]),p(part.triangles[t+1]),p(part.triangles[t+2]),part.color);
    }
    // A mirrored (back) placement flips the winding; the shader lights both faces, so it only costs a sign.
    const guess=!served||choice.approximate;
    ranges.push({reference:component.reference,start,count:positions.length/3-start,approximate:guess});
    drawn++;if(guess)approximate++;
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),colors:Float32Array.from(colors),ranges,fills,
          summary:{components:scene.components.length,drawn,approximate,missing:scene.components.length-drawn}};
}

/** Model paths to fetch for a scene, once each. */
export function modelPaths(scene) {
  return [...new Set(scene.components.flatMap(c=>candidates(c).map(x=>x.path)))].sort();
}

/** Bodies for a scene: each component's own WRL or STEP model first, then CopperScript-generated ones for every component without one.
    `fetchBody(path)` gives a parsed body or null; `generate(requests)` gives `{wrl}|{error}` per request.
    A component's candidates are tried in order and later ones are not fetched once one loads. `cache` (a Map
    kept by the caller for one board) holds what earlier calls fetched or generated, so they are not redone. */
export async function loadBodies(scene, {fetchBody,generate,cache=new Map()}) {
  const bodies=new Map();
  const get=path=>{if(!cache.has(path))cache.set(path,Promise.resolve().then(()=>fetchBody(path)).catch(()=>null));return cache.get(path);};
  await Promise.all(scene.components.map(async component=>{
    for(const {path} of candidates(component)){const body=await get(path);if(body){bodies.set(path,body);break;}}
  }));
  const keys=[...new Set(scene.components.filter(c=>!chosen(c,bodies)).map(bodyInputKey).filter(Boolean))];
  const needed=keys.filter(key=>!cache.has('input:'+key));
  if(needed.length&&generate){
    const results=await generate(needed);
    // A batch that failed as a whole (no result) is not remembered, so the next call tries again.
    needed.forEach((key,i)=>{if(!results[i])return;let body=null;if(results[i]?.wrl){try{body=parseVrml(results[i].wrl);}catch{}}cache.set('input:'+key,Promise.resolve(body));});
  }
  for(const key of keys){const body=await cache.get('input:'+key);if(body)bodies.set('input:'+key,body);}
  return bodies;
}
