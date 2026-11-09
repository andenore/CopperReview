import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFeedback,matchesAnswer,describeSelection} from '../copper_review/web/agents.js';

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
