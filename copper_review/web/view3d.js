/* Minimal WebGL view of a triangle soup (see model3d.js buildSoup): orbit camera, two-sided flat faces.
   A key and a fill light follow the camera, so every side (the bottom too) is lit; specular and rim terms give
   the faces depth. Copper fills are polygons with bridged holes, drawn through the stencil buffer (even-odd). */
const VERTEX=`attribute vec3 position;attribute vec3 normal;attribute vec3 color;uniform mat4 viewProjection;
varying vec3 vNormal;varying vec3 vColor;varying vec3 vPosition;
void main(){vNormal=normal;vColor=color;vPosition=position;gl_Position=viewProjection*vec4(position,1.0);}`;
const FRAGMENT=`#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vNormal;varying vec3 vColor;varying vec3 vPosition;uniform vec3 eye;uniform vec3 keyLight;uniform vec3 fillLight;
void main(){vec3 n=normalize(vNormal),v=normalize(eye-vPosition);if(dot(n,v)<0.0)n=-n;
float key=max(dot(n,keyLight),0.0),fill=max(dot(n,fillLight),0.0),facing=max(dot(n,v),0.0);
float shine=pow(max(dot(n,normalize(keyLight+v)),0.0),48.0)*step(0.001,key);
vec3 c=vColor*(.2+.72*key+.28*fill)+vec3(.3)*shine+vColor*.3*pow(1.0-facing,3.0);
gl_FragColor=vec4(pow(c,vec3(.92)),1.0);}`;

const multiply=(a,b)=>{const r=new Float32Array(16);for(let c=0;c<4;c++)for(let row=0;row<4;row++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+row]*b[c*4+k];r[c*4+row]=v;}return r;};
export function perspective(fov,aspect,near,far) {
  const f=1/Math.tan(fov/2),r=new Float32Array(16);
  r[0]=f/aspect;r[5]=f;r[10]=(far+near)/(near-far);r[11]=-1;r[14]=2*far*near/(near-far);return r;
}
/** Orthographic projection: `half` is half the visible height at any depth. */
export function orthographic(half,aspect,near,far) {
  const r=new Float32Array(16);
  r[0]=1/(half*aspect);r[5]=1/half;r[10]=-2/(far-near);r[14]=-(far+near)/(far-near);r[15]=1;return r;
}
/** Straight down on the top side (a hair off vertical, so "up" on screen stays the board's top edge). */
export const TOP_PITCH=Math.PI/2-.001;
/**
 * Named views as camera angles. World x is board x, world y is up the page (board y negated), z up
 * out of the top side. Front looks from the board's bottom edge, right from its right edge.
 */
export const VIEWS={top:{yaw:0,pitch:TOP_PITCH},bottom:{yaw:0,pitch:-TOP_PITCH},front:{yaw:0,pitch:0},back:{yaw:Math.PI,pitch:0},right:{yaw:Math.PI/2,pitch:0},left:{yaw:-Math.PI/2,pitch:0}};
/** The named view a camera is in, or null between views. */
export function viewName({yaw,pitch}){
  const turn=a=>Math.abs(Math.atan2(Math.sin(a),Math.cos(a)));
  for(const [name,view] of Object.entries(VIEWS)){
    if(Math.abs(pitch-view.pitch)>.02)continue;
    if(Math.abs(view.pitch)>1.5||turn(yaw-view.yaw)<.02)return name;
  }
  return null;
}
const FOV=.7;
export function lookAt(eye,target,up) {
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],norm=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const z=norm(sub(eye,target)),x=norm(cross(up,z)),y=cross(z,x),r=new Float32Array(16);
  r.set([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);return r;
}

/** Camera state: orbit around `target` at `distance`, yaw about z, pitch above the board plane. */
export function cameraEye({target,distance,yaw,pitch}) {
  return [target[0]+distance*Math.cos(pitch)*Math.sin(yaw),target[1]-distance*Math.cos(pitch)*Math.cos(yaw),target[2]+distance*Math.sin(pitch)];
}

/** The page's --board-bg colour as GL components, so the 3D view follows the light or dark theme. */
function backgroundOf(element) {
  const hex=getComputedStyle(element).getPropertyValue('--board-bg').trim().match(/^#([0-9a-f]{6})/i)?.[1];
  return hex?[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255):[.063,.086,.098];
}

export function createView3d(canvas) {
  const background=()=>backgroundOf(canvas);
  const gl=canvas.getContext('webgl',{antialias:true,stencil:true});
  if(!gl)return null;
  const program=gl.createProgram();
  for(const [type,source] of [[gl.VERTEX_SHADER,VERTEX],[gl.FRAGMENT_SHADER,FRAGMENT]]){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffers={},attribute=name=>gl.getAttribLocation(program,name),uniform=name=>gl.getUniformLocation(program,name);
  const viewProjection=uniform('viewProjection'),eyeAt=uniform('eye'),keyAt=uniform('keyLight'),fillAt=uniform('fillLight');
  let count=0,fills=[],camera={target:[0,0,0],distance:100,yaw:0,pitch:.9},radius=50,frame=0,ortho=false,onDraw=null;
  // Orthographic keeps the size perspective shows at the target, so switching does not jump; the eye
  // stands well back so zooming in never clips the board.
  const eyeOf=()=>ortho?cameraEye({...camera,distance:Math.max(camera.distance,radius*4)}):cameraEye(camera);
  const view=()=>{
    const aspect=(canvas.clientWidth||canvas.width)/Math.max(1,canvas.clientHeight||canvas.height),eye=eyeOf();
    const projection=ortho?orthographic(camera.distance*Math.tan(FOV/2),aspect,radius/50,Math.hypot(...eye.map((x,i)=>x-camera.target[i]))+radius*4)
      :perspective(FOV,aspect,radius/50,radius*40);
    return multiply(projection,lookAt(eye,camera.target,[0,0,1]));
  };
  function draw() {
    frame=0;
    const width=Math.max(1,Math.floor(canvas.clientWidth*devicePixelRatio)),height=Math.max(1,Math.floor(canvas.clientHeight*devicePixelRatio));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    gl.viewport(0,0,width,height);gl.clearColor(...background(),1);gl.enable(gl.DEPTH_TEST);gl.clearStencil(0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
    onDraw?.(camera,ortho);
    if(!count)return;
    const eye=eyeOf(),norm=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
    const back=norm(eye.map((x,i)=>x-camera.target[i])),right=norm([back[1],-back[0],0]);
    const up=[right[1]*back[2]-right[2]*back[1],right[2]*back[0]-right[0]*back[2],right[0]*back[1]-right[1]*back[0]];
    const toward=(u,r)=>norm(back.map((x,i)=>x+u*up[i]+r*right[i]));
    gl.uniformMatrix4fv(viewProjection,false,view());gl.uniform3fv(eyeAt,eye);
    gl.uniform3fv(keyAt,toward(.8,-.55));gl.uniform3fv(fillAt,toward(-.3,.9));
    for(const name of ['position','normal','color'])bind(name);
    gl.drawArrays(gl.TRIANGLES,0,count);
    if(fills.length)drawFills();
  }
  // Even-odd fill: each fan flips the stencil, then the same fan paints where it is set and clears it again.
  function drawFills() {
    bind('fill');for(const name of ['normal','color'])gl.disableVertexAttribArray(attribute(name));
    gl.enable(gl.STENCIL_TEST);
    for(const fill of fills){
      gl.vertexAttrib3fv(attribute('normal'),fill.normal);gl.vertexAttrib3fv(attribute('color'),fill.color);
      gl.colorMask(false,false,false,false);gl.depthMask(false);gl.stencilFunc(gl.ALWAYS,0,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT);
      gl.drawArrays(gl.TRIANGLE_FAN,fill.first,fill.count);
      gl.colorMask(true,true,true,true);gl.depthMask(true);gl.stencilFunc(gl.NOTEQUAL,0,255);gl.stencilOp(gl.ZERO,gl.ZERO,gl.ZERO);
      gl.drawArrays(gl.TRIANGLE_FAN,fill.first,fill.count);
    }
    gl.disable(gl.STENCIL_TEST);
  }
  const request=()=>{if(!frame)frame=requestAnimationFrame(draw);};
  function upload(name,data) {
    if(!buffers[name])buffers[name]=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buffers[name]);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  }
  // The fill polygons share the position attribute with the soup, so each pass binds its own buffer.
  function bind(name) {
    const location=attribute(name==='fill'?'position':name);
    gl.bindBuffer(gl.ARRAY_BUFFER,buffers[name]);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);
  }
  function fit(bounds,{pitch,yaw=0}={}) {
    const [x0,y0,x1,y1]=bounds;
    camera={target:[(x0+x1)/2,-(y0+y1)/2,0],yaw,pitch:pitch??(camera.pitch<0?-.9:.9),distance:1}; // stays on the side in view
    radius=Math.max(10,Math.hypot(x1-x0,y1-y0)/2);
    // The closest distance that keeps every corner of the board (and a few millimetres of parts) on screen.
    const corners=[];for(const x of [x0,x1])for(const y of [-y0,-y1])for(const z of [-6,6])corners.push([x,y,z]);
    const inside=()=>{const m=view();return corners.every(([x,y,z])=>{const w=m[3]*x+m[7]*y+m[11]*z+m[15];
      return w>0&&Math.abs((m[0]*x+m[4]*y+m[8]*z+m[12])/w)<.92&&Math.abs((m[1]*x+m[5]*y+m[9]*z+m[13])/w)<.92;});};
    let near=radius*.3,far=radius*12;
    for(let i=0;i<32;i++){camera.distance=(near+far)/2;if(inside())far=camera.distance;else near=camera.distance;}
    camera.distance=far;request();
  }
  const drag={};
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);Object.assign(drag,{x:e.clientX,y:e.clientY,pan:e.button===2||e.shiftKey,active:true});});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{drag.active=false;});
  // The canvas follows its box (window resize, the Both split) without waiting for a drag.
  new ResizeObserver(()=>{if(!canvas.hidden)request();}).observe(canvas);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('pointermove',e=>{
    if(!drag.active)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;
    if(drag.pan){
      const k=camera.distance/Math.max(1,canvas.clientHeight)*.9,c=Math.cos(camera.yaw),s=Math.sin(camera.yaw);
      camera.target=[camera.target[0]-(dx*c+dy*s*Math.sin(camera.pitch))*k,camera.target[1]-(dx*s-dy*c*Math.sin(camera.pitch))*k,camera.target[2]];
    }else{camera.yaw-=dx*.008;camera.pitch=Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,camera.pitch+dy*.008));} // below zero looks at the bottom
    request();
  });
  canvas.addEventListener('wheel',e=>{e.preventDefault();camera.distance=Math.max(radius*.2,Math.min(radius*12,camera.distance*Math.exp(e.deltaY*.0012)));request();},{passive:false});
  return {
    setSoup(soup,bounds){
      count=soup.positions.length/3;upload('position',soup.positions);upload('normal',soup.normals);upload('color',soup.colors);
      let first=0;fills=(soup.fills||[]).map(f=>{const n=f.points.length/3,fill={...f,first,count:n};first+=n;return fill;});
      const all=new Float32Array(first*3);fills.forEach(f=>all.set(f.points,f.first*3));upload('fill',all);fit(bounds);
    },
    /** Turn the board over: the same angle from the other side. */
    flip(){camera={...camera,pitch:-camera.pitch};request();},
    /** Look at the whole board from a named view (top, bottom, front, back, left, right). */
    view(name,bounds){fit(bounds,VIEWS[name]);},
    /** Called after every frame drawn, with the camera, so an indicator can follow it. */
    set onDraw(callback){onDraw=callback;},
    get orthographic(){return ortho;},set orthographic(on){ortho=!!on;request();},
    fit,draw:request,
    get camera(){return camera;},set camera(value){camera={...camera,...value};request();},
  };
}
