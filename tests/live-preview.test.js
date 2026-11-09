import test from 'node:test';
import assert from 'node:assert/strict';
import {createLivePreview} from '../copper_review/web/live-preview.js';

function fixture(prepare=async()=>({})){
  let revision='one',editing=false;
  const applied=[];
  const controller=createLivePreview({
    request:async path=>path.startsWith('/api/preview/snapshot')?{revision,data:{revision}}:{enabled:true,source:{state:'ready',revision}},
    prepare,apply:(_kind,data)=>{applied.push(data);return {sha256:'hash'};},isEditing:()=>editing
  });
  return {controller,applied,change:value=>{revision=value;},edit:value=>{editing=value;}};
}
test('compilation failures keep the preview and do not retry unchanged inputs',async()=>{
  let calls=0;
  const f=fixture(async()=>{if(++calls===1)throw Error('Source syntax error');return {};});
  await f.controller.poll();await f.controller.poll();
  assert.equal(calls,1);assert.equal(f.applied.length,0);assert.equal(f.controller.status().source.state,'error');
  f.change('two');await f.controller.poll();assert.equal(f.applied.length,1);
});
test('newer saves supersede a finished compile before it can be displayed',async()=>{
  const f=fixture(async(_kind,data)=>{if(data.revision==='one')f.change('two');return data;});
  await f.controller.poll();assert.equal(f.applied.length,0);
  await f.controller.poll();assert.equal(f.applied[0].revision,'two');
});
test('a note started during compilation defers replacement without losing the prepared result',async()=>{
  let calls=0;
  const f=fixture(async()=>{calls++;f.edit(true);return {};});
  await f.controller.poll();assert.equal(f.controller.status().source.state,'deferred');
  await f.controller.poll();assert.equal(calls,1);assert.equal(f.applied.length,0);
  f.edit(false);await f.controller.poll();assert.equal(calls,1);assert.equal(f.applied.length,1);
});
test('pausing during a compile prevents its result replacing a manually opened document',async()=>{
  const f=fixture(async()=>{f.controller.setPaused(true);return {};});
  await f.controller.poll();assert.equal(f.applied.length,0);assert.equal(f.controller.status().paused,true);
});
test('resume restores watched inputs even if disk did not change while paused',async()=>{
  const f=fixture();await f.controller.poll();
  f.controller.setPaused(true);f.controller.setPaused(false);
  await f.controller.poll();assert.equal(f.applied.length,2);
});
test('pause/resume while the status request is in flight cannot strand a revision',async()=>{
  let release,first=true,applied=0;
  const controller=createLivePreview({
    request:async path=>{
      if(first){first=false;await new Promise(resolve=>{release=resolve;});}
      return path.includes('snapshot')?{data:{}}:{enabled:true,source:{state:'ready',revision:'one'}};
    },prepare:async()=>({}),apply:()=>{applied++;return {sha256:'hash'};},isEditing:()=>false
  });
  const poll=controller.poll();controller.setPaused(true);controller.setPaused(false);release();await poll;
  await controller.poll();assert.equal(applied,1);assert.equal(controller.status().source.state,'current');
});
