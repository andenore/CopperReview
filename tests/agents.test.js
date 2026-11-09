import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFeedback,matchesAnswer,describeSelection,prepareContext,createContextCache} from '../copper_review/web/agents.js';

test('unchanged polling never rebuilds context, including cached size failures',()=>{
  let revision=0,calls=0;
  const cache=createContextCache(()=>{calls++;return {documents:{layout:{sha256:'a',selection:{components:['U1']}}}};},()=>({key:revision}));
  for(let i=0;i<50;i++)assert.equal(cache.read().key,0);
  assert.equal(calls,1);revision++;assert.equal(cache.read().key,1);assert.equal(calls,2);
  let attempts=0;
  const broken=createContextCache(()=>{attempts++;return {};},()=>({key:revision}),()=>{throw Error('context limit');});
  for(let i=0;i<10;i++)assert.throws(()=>broken.read(),/context limit/);
  assert.equal(attempts,1);revision++;assert.throws(()=>broken.read());assert.equal(attempts,2);
});

test('oversize contexts progressively omit optional data and preserve selection and exact identities',()=>{
  const snapshot={documents:{electrical:{sha256:'e',ir:{huge:'µ'.repeat(1000)},selection:{kind:'net',id:'DATA'},
    selection_context:{nets:[{name:'DATA',pins:['U1.1']}]},annotations:[]},layout:{sha256:'a',catalog:{huge:'x'.repeat(1000)}}}};
  const packed=prepareContext(snapshot,1000);
  assert.equal(packed.context.documents.electrical.ir,undefined);
  assert.equal(packed.context.documents.layout.catalog,undefined);
  assert.equal(packed.omissions.length,2);
  assert.equal(packed.context.documents.electrical.selection_context.nets[0].name,'DATA');
  assert.equal(packed.context.documents.layout.sha256,'a');
  assert(snapshot.documents.electrical.ir);assert(snapshot.documents.layout.catalog);
  assert(new TextEncoder().encode(packed.serialized).length<=1000);
  assert.throws(()=>prepareContext({documents:{layout:{context:'x'.repeat(2000)}}},1000),/Select a smaller area/);
});

test('context limits count compact UTF-8 bytes and captured values are immutable',()=>{
  const snapshot={documents:{layout:{name:'µ'.repeat(20)}}};
  const serialized=JSON.stringify({...snapshot,omissions:[]}),bytes=new TextEncoder().encode(serialized).length;
  const packed=prepareContext(snapshot,bytes);
  assert.equal(packed.serialized,serialized);
  assert.throws(()=>prepareContext(snapshot,bytes-1),/context limit/);
  snapshot.documents.layout.name='changed';assert.equal(packed.context.documents.layout.name,'µ'.repeat(20));
});

test('feedback belongs to the exact document kind and hash, independently of other open documents',()=>{
  const feedback={payload:{target:'layout',sha256:'a'}};
  assert.equal(matchesFeedback(feedback,{layout:{sha256:'a'},electrical:{sha256:'b'}}),true);
  assert.equal(matchesFeedback(feedback,{layout:{sha256:'b'},electrical:{sha256:'a'}}),false);
  assert.equal(matchesFeedback(feedback,{electrical:{sha256:'a'}}),false);
});

test('an answer becomes outdated when any document it used changes',()=>{
  const answer={payload:{based_on:{layout:'a',electrical:'b'}}};
  assert.equal(matchesAnswer(answer,{layout:{sha256:'a'},electrical:{sha256:'b'}}),true);
  assert.equal(matchesAnswer(answer,{layout:{sha256:'a'},electrical:{sha256:'c'}}),false);
  assert.equal(matchesAnswer(answer,{layout:{sha256:'a'}}),false);
  assert.equal(describeSelection({components:[],nets:[],region:null}),'Whole board');
  assert.equal(describeSelection({kind:'net',id:'DATA'}),'net: DATA');
});
