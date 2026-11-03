/* 3D bodies: VRML parsing, model choice and placement. Pure, so Node tests it.
   World frame: millimetres, x right, y up the page (board y negated), z up from the top copper face.
   Board slab is thickness below z=0; back-side parts hang below it. */
export const WRL_UNIT_MM = 2.54; // KiCad reads one VRML unit as 0.1 inch.
export const DEFAULT_THICKNESS_MM = 1.6;
const SIZE_LIMIT = 20e6;

/** Triangles of every IndexedFaceSet in `text` (the flat Shape/Coordinate subset CopperScript writes). */
export function parseVrml(text) {
  if(typeof text!=='string' || text.length>SIZE_LIMIT || !text.startsWith('#VRML V2.0'))throw new Error('Not a VRML 2.0 file');
  const unsupported=/\b(Inline|Script|PROTO)\b/.test(text);
  const parts=[];let color=[.7,.7,.7],name='';
  const tokens=text.replace(/#.*$/gm,'').replace(/[{}[\],]/g,m=>` ${m==='['||m===']'?m:m==='{'||m==='}'?m:' '} `).split(/\s+/).filter(Boolean);
  const numbersAfter=(i)=>{ // tokens[i] === '[': numbers up to ']'
    const values=[];for(i++;i<tokens.length && tokens[i]!==']';i++)values.push(Number(tokens[i]));
    if(values.some(v=>!Number.isFinite(v)))throw new Error('Invalid number in VRML');return values;};
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token==='DEF')name=tokens[i+1]||'';
    else if(token==='diffuseColor'){const c=tokens.slice(i+1,i+4).map(Number);if(c.length===3&&c.every(Number.isFinite))color=c;}
    else if(token==='point'&&tokens[i+1]==='['){parts.push({name,color:[...color],points:numbersAfter(i+1),index:[]});}
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
  return {parts:result,unsupported};
}

/** `${KIPRJMOD}/Dir.3dshapes/file.wrl` (or already relative) to `Dir.3dshapes/file.wrl`; null if the viewer cannot fetch it. */
export function resolveModelPath(path) {
  if(typeof path!=='string')return null;
  const relative=path.startsWith('${KIPRJMOD}/')?path.slice('${KIPRJMOD}/'.length):path;
  const parts=relative.split('/');
  if(parts.length!==2||!parts[0].endsWith('.3dshapes')||!parts[1].toLowerCase().endsWith('.wrl')||parts.includes('..')||relative.includes('\\'))return null;
  return relative;
}

/** The model to draw for a component: its first fetchable WRL, else its generated body. */
export function pickModel(component) {
  const body=resolveModelPath(component.body_model);
  for(const model of component.models||[]){
    const path=resolveModelPath(model.path);
    if(path)return {path,model,approximate:path===body};
  }
  if(body)return {path:body,model:{offset_mm:[0,0,0],scale:[1,1,1],rotate_deg:[0,0,0]},approximate:true};
  return null;
}

const mul3=(a,b)=>{const r=new Array(9).fill(0);for(let i=0;i<3;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++)r[i*3+j]+=a[i*3+k]*b[k*3+j];return r;};
function rotation([rx,ry,rz]) {
  const [cx,sx,cy,sy,cz,sz]=[rx,ry,rz].flatMap(d=>{const r=d*Math.PI/180;return [Math.cos(r),Math.sin(r)];});
  const X=[1,0,0,0,cx,-sx,0,sx,cx],Y=[cy,0,sy,0,1,0,-sy,0,cy],Z=[cz,-sz,0,sz,cz,0,0,0,1];
  return mul3(Z,mul3(Y,X)); // x first; only the identity is checked against KiCad
}

/** Maps a model-frame point (VRML units) to the world frame for `component`. */
export function placement(component, model, thickness=DEFAULT_THICKNESS_MM) {
  const scale=model.scale||[1,1,1],offset=model.offset_mm||[0,0,0],R=rotation(model.rotate_deg||[0,0,0]);
  const back=component.side==='back',angle=(component.rotation_deg||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const [px,py]=component.position_mm;
  return point=>{
    const m=[point[0]*WRL_UNIT_MM*scale[0],point[1]*WRL_UNIT_MM*scale[1],point[2]*WRL_UNIT_MM*scale[2]];
    let x=R[0]*m[0]+R[1]*m[1]+R[2]*m[2]+offset[0],y=R[3]*m[0]+R[4]*m[1]+R[5]*m[2]+offset[1],z=R[6]*m[0]+R[7]*m[1]+R[8]*m[2]+offset[2];
    if(back){x=-x;z=-z-thickness;}
    return [px+x*c-y*s,-py+x*s+y*c,z];
  };
}

/** One flat-shaded triangle soup for the whole board: board slab plus every placed body. */
export function buildSoup(scene, bodies, thickness=DEFAULT_THICKNESS_MM) {
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
  let drawn=0,approximate=0;
  for(const component of scene.components){
    const choice=pickModel(component),body=choice&&bodies.get(choice.path);
    if(!body)continue;
    const place=placement(component,choice.model,thickness),start=positions.length/3;
    for(const part of body.parts){
      const p=i=>place([part.points[i*3],part.points[i*3+1],part.points[i*3+2]]);
      for(let t=0;t<part.triangles.length;t+=3)triangle(p(part.triangles[t]),p(part.triangles[t+1]),p(part.triangles[t+2]),part.color);
    }
    // A mirrored (back) placement flips the winding; the shader lights both faces, so it only costs a sign.
    ranges.push({reference:component.reference,start,count:positions.length/3-start,approximate:choice.approximate});
    drawn++;if(choice.approximate)approximate++;
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),colors:Float32Array.from(colors),ranges,
          summary:{components:scene.components.length,drawn,approximate,missing:scene.components.length-drawn}};
}

/** Model paths to fetch for a scene, once each. */
export function modelPaths(scene) {
  return [...new Set(scene.components.map(c=>pickModel(c)?.path).filter(Boolean))].sort();
}
