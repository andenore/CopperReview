/* Minimal WebGL view of a triangle soup (see model3d.js buildSoup): orbit camera, two-sided flat lighting. */
const VERTEX=`attribute vec3 position;attribute vec3 normal;attribute vec3 color;uniform mat4 viewProjection;
varying vec3 vNormal;varying vec3 vColor;void main(){vNormal=normal;vColor=color;gl_Position=viewProjection*vec4(position,1.0);}`;
const FRAGMENT=`precision mediump float;varying vec3 vNormal;varying vec3 vColor;
void main(){vec3 light=normalize(vec3(-.35,-.5,.8));float d=abs(dot(normalize(vNormal),light));
gl_FragColor=vec4(vColor*(.38+.62*d),1.0);}`;

const multiply=(a,b)=>{const r=new Float32Array(16);for(let c=0;c<4;c++)for(let row=0;row<4;row++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+row]*b[c*4+k];r[c*4+row]=v;}return r;};
export function perspective(fov,aspect,near,far) {
  const f=1/Math.tan(fov/2),r=new Float32Array(16);
  r[0]=f/aspect;r[5]=f;r[10]=(far+near)/(near-far);r[11]=-1;r[14]=2*far*near/(near-far);return r;
}
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

export function createView3d(canvas) {
  const gl=canvas.getContext('webgl',{antialias:true});
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
  const buffers={},attribute=name=>gl.getAttribLocation(program,name),viewProjection=gl.getUniformLocation(program,'viewProjection');
  let count=0,camera={target:[0,0,0],distance:100,yaw:0,pitch:.9},radius=50,frame=0;
  const view=()=>{
    const aspect=canvas.width/Math.max(1,canvas.height);
    return multiply(perspective(.7,aspect,radius/50,radius*40),lookAt(cameraEye(camera),camera.target,[0,0,1]));
  };
  function draw() {
    frame=0;
    const width=Math.max(1,Math.floor(canvas.clientWidth*devicePixelRatio)),height=Math.max(1,Math.floor(canvas.clientHeight*devicePixelRatio));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    gl.viewport(0,0,width,height);gl.clearColor(.063,.086,.098,1);gl.enable(gl.DEPTH_TEST);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(!count)return;
    gl.uniformMatrix4fv(viewProjection,false,view());gl.drawArrays(gl.TRIANGLES,0,count);
  }
  const request=()=>{if(!frame)frame=requestAnimationFrame(draw);};
  function upload(name,data) {
    if(!buffers[name])buffers[name]=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buffers[name]);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    const location=attribute(name);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);
  }
  function fit(bounds) {
    const [x0,y0,x1,y1]=bounds;
    camera={target:[(x0+x1)/2,-(y0+y1)/2,0],yaw:0,pitch:.9,distance:1};
    radius=Math.max(10,Math.hypot(x1-x0,y1-y0)/2);camera.distance=radius*2.4;request();
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
    }else{camera.yaw-=dx*.008;camera.pitch=Math.max(.05,Math.min(Math.PI/2-.01,camera.pitch+dy*.008));}
    request();
  });
  canvas.addEventListener('wheel',e=>{e.preventDefault();camera.distance=Math.max(radius*.2,Math.min(radius*12,camera.distance*Math.exp(e.deltaY*.0012)));request();},{passive:false});
  return {
    setSoup(soup,bounds){count=soup.positions.length/3;upload('position',soup.positions);upload('normal',soup.normals);upload('color',soup.colors);fit(bounds);},
    fit,draw:request,
    get camera(){return camera;},set camera(value){camera={...camera,...value};request();},
  };
}
