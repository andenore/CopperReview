import test from 'node:test';
import assert from 'node:assert/strict';
import {orthographic,perspective,lookAt,cameraEye,TOP_PITCH} from '../copper_review/web/view3d.js';
const apply=(m,[x,y,z])=>{const w=m[3]*x+m[7]*y+m[11]*z+m[15];return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,(m[1]*x+m[5]*y+m[9]*z+m[13])/w,(m[2]*x+m[6]*y+m[10]*z+m[14])/w];};
const near=(a,b)=>a.every((x,i)=>Math.abs(x-b[i])<1e-6);

test('orthographic projection keeps sizes independent of depth',()=>{
  const m=orthographic(10,2,1,100);
  assert(near(apply(m,[20,10,-5]).slice(0,2),[1,1]));
  assert(near(apply(m,[20,10,-50]).slice(0,2),[1,1]),'farther away, same place on screen');
  assert(Math.abs(apply(m,[0,0,-1])[2]+1)<1e-6&&Math.abs(apply(m,[0,0,-100])[2]-1)<1e-6,'near and far planes map to -1 and 1');
  const p=perspective(.7,2,1,100);
  assert(!near(apply(p,[20,10,-5]).slice(0,2),apply(p,[20,10,-50]).slice(0,2)),'perspective does shrink with depth');
});

test('the top view looks straight down with the board top edge up on screen',()=>{
  const camera={target:[25,-17.5,0],distance:80,yaw:0,pitch:TOP_PITCH},eye=cameraEye(camera);
  assert(Math.abs(eye[0]-25)<1e-9&&Math.abs(eye[1]+17.5)<.1&&Math.abs(eye[2]-80)<1e-3);
  const view=lookAt(eye,camera.target,[0,0,1]);
  // Board y is negated in the 3D world: the board's top edge (world y up) is up on screen.
  const top=apply(view,[25,-10,0]),bottom=apply(view,[25,-25,0]);
  assert(top[1]>bottom[1]);
  assert(Math.abs(apply(view,[30,-17.5,0])[0]-5)<1e-3,'board x runs left to right');
});

test('named views are recognised from the camera, and nothing in between',async()=>{
  const {VIEWS,viewName}=await import('../copper_review/web/view3d.js');
  for(const [name,view] of Object.entries(VIEWS))assert.equal(viewName(view),name);
  assert.equal(viewName({yaw:.4,pitch:TOP_PITCH}),'top','any turn looking straight down is still the top');
  assert.equal(viewName({yaw:2*Math.PI,pitch:0}),'front');
  assert.equal(viewName({yaw:0,pitch:.9}),null);
  assert.equal(viewName({yaw:.3,pitch:0}),null);
});
