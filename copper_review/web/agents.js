/* Provider-neutral design Q&A. Models run in the user's agent host. */
import {randomId} from './hash.js';

export function matchesFeedback(feedback,documents){return documents[feedback.payload.target]?.sha256===feedback.payload.sha256;}
export function matchesAnswer(answer,documents){return Object.entries(answer.payload.based_on).every(([target,hash])=>documents[target]?.sha256===hash);}
const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
function saved(key,fallback){try{return JSON.parse(sessionStorage.getItem(key))??fallback;}catch{return fallback;}}
function save(key,value){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}

export function prepareContext(snapshot,limit=4*1024*1024){
  const context={...snapshot,documents:Object.fromEntries(Object.entries(snapshot.documents).map(([k,d])=>[k,{...d}])),omissions:[...(snapshot.omissions||[])]};
  const encoder=new TextEncoder();
  function fit(){const serialized=JSON.stringify(context);return encoder.encode(serialized).length<=limit?{context:JSON.parse(serialized),serialized,omissions:context.omissions}:null;}
  let result=fit();if(result)return result;
  for(const [target,key] of [['electrical','ir'],['layout','catalog'],['electrical','annotations'],['layout','annotations'],['layout','issues']]){
    const doc=context.documents[target];if(!doc||!(key in doc))continue;
    delete doc[key];context.omissions.push(`/documents/${target}/${key} omitted to fit the context limit; do not assume this information was checked.`);
    result=fit();if(result)return result;
  }
  throw Error('This selection still exceeds the 4 MiB context limit after omitting large optional data. Select a smaller area or open a smaller design.');
}

export function createContextCache(snapshot,state,prepare=prepareContext){
  let key,value,error;
  return {read(){const next=state().key;if(next!==key){key=next;value=undefined;error=undefined;try{value=prepare(snapshot());}catch(e){error=e;}}
    if(error)throw error;return {...value,key};}};
}

export function createAgentReview({token,localServer,snapshot,contextState,applyFeedback,revealEvidence,message}){
  const $=id=>document.getElementById(id),sessionId=saved('copper-review:agent-session',null)||randomId();
  save('copper-review:agent-session',sessionId);
  const cache=createContextCache(snapshot,contextState),rows=new Map();
  let connected=false,busy=false,lastContext='',parentId=null,newThread=false,timer=null,records=[],presence=[],blockedKey=null,blockedError=null;
  const outcomes=new Map(saved('copper-review:agent-outcomes',[]));
  let navigationResult=null;
  async function api(path,body){
    const response=await fetch(`./api/agents${path}`,{method:body===undefined?'GET':'POST',
      headers:{'X-Copper-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const value=await response.json();if(!response.ok){const error=Error(value.error||'Agent connection unavailable');error.status=response.status;throw error;}return value;
  }
  function status(text){$('agent-status').textContent=text;}
  function followUp(r){parentId=r.id;$('agent-reply-context').hidden=false;$('agent-reply-label').textContent=`Follow-up: ${r.prompt}`;$('agent-prompt').focus();}
  function action(label,fn){const b=element('button',label);b.type='button';b.onclick=async()=>{try{await fn();}catch(error){status(error.message);}};return b;}
  function render(documents){
    const hashes=Object.fromEntries(Object.entries(documents).map(([k,d])=>[k,d.sha256]));
    const list=$('agent-results'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60,scroll=list.scrollTop;
    const ids=new Set(records.map(r=>r.id));for(const [id,entry] of rows)if(!ids.has(id)){entry.node.remove();rows.delete(id);}
    const placeholder=list.querySelector('[data-agent-empty]');if(records.length)placeholder?.remove();
    else if(!placeholder){const empty=element('p','Ask what a part does, how a net connects, or what the available design data says about a supply.','quiet');empty.dataset.agentEmpty='';list.append(empty);}
    for(const r of records){
      const signature=JSON.stringify([r,outcomes.get(r.id),hashes]),old=rows.get(r.id),pending=['queued','answering'].includes(r.status);
      if(old?.signature===signature)continue;
      if(old?.pending&&pending){old.node.querySelector('.agent-progress').textContent=progressText(r);old.signature=signature;continue;}
      const row=element('article'),question=element('p',r.prompt,'agent-question');row.append(element('strong','You'),question);
      const answer=r.answer,feedback=r.feedback;
      const stale=r.status==='stale'||(answer&&!matchesAnswer(answer,documents))||(feedback&&!matchesFeedback(feedback,documents));
      if(answer){
        row.append(element('strong',answer.payload.agent),element('p',stale?'Earlier design revision — check against the current board':'Answer','agent-answer-state'),element('div',answer.payload.answer,'agent-answer'));
        if(answer.payload.limitations)row.append(element('p',`Limits: ${answer.payload.limitations}`,'quiet'));
        for(const cite of answer.evidence){
          const detail=element('details'),summary=element('summary',cite.label);detail.append(summary,element('pre',cite.excerpt));
          if(cite.truncated)detail.append(element('p','Excerpt shortened; the agent cited a larger record.','quiet'));
          if(cite.selection){const show=action(cite.target==='layout'?'Show on board':'Show in schematic',()=>revealEvidence(cite));
            show.disabled=stale||documents[cite.target]?.sha256!==cite.sha256;detail.append(show);}
          row.append(detail);
        }
      }else if(feedback){
        row.append(element('strong',feedback.payload.agent),element('p',feedback.payload.summary));
        for(const finding of feedback.annotations)row.append(element('p',finding.observation));
        const outcome=outcomes.get(r.id);
        if(stale)row.append(element('p','Earlier design revision — findings were not added','quiet'));
        else if(outcome)row.append(element('p',outcome,'quiet'));
        else row.append(action('Add findings to review notes',()=>{
          if(!matchesFeedback(feedback,contextState().documents))throw Error('Design changed');
          applyFeedback(r);outcomes.set(r.id,'Added to review notes');save('copper-review:agent-outcomes',[...outcomes].slice(-64));render(contextState().documents);
        }));
      }else row.append(element('p',progressText(r),'quiet agent-progress'));
      const actions=element('div',undefined,'agent-actions');
      if(['queued','answering'].includes(r.status))actions.append(action('Cancel',async()=>{await api('/cancel',{session_id:sessionId,request_id:r.id});await refresh();}));
      else{actions.append(action('Follow up',()=>followUp(r)));actions.append(action('Ask again',()=>{$('agent-prompt').value=r.prompt;parentId=null;newThread=true;return send();}));}
      row.dataset.requestId=r.id;row.append(actions);if(old)old.node.replaceWith(row);else list.append(row);rows.set(r.id,{node:row,signature,pending});
    }
    if(nearBottom)list.scrollTop=list.scrollHeight;else list.scrollTop=scroll;
  }
  async function sync(){
    const state=contextState();$('agent-selection').textContent=state.selection?describeSelection(state.selection):'Whole design';
    if(state.key===blockedKey)throw blockedError;
    if(state.key===lastContext)return;
    let prepared;
    async function block(error){blockedKey=state.key;blockedError=error;await api('/detach',{session_id:sessionId}).catch(()=>{});}
    try{prepared=cache.read();}catch(error){await block(error);throw error;}
    try{
      $('agent-context-warning').textContent=prepared.omissions.length?'Some large design data was omitted. The agent can see the omissions and selected context.':'';
      await api('/context',`{"session_id":${JSON.stringify(sessionId)},"context":${prepared.serialized}}`);lastContext=prepared.key;
    }catch(error){
      // Capacity and transport errors can recover without a design change.
      if(error.status===413||(error.status===400&&error.message.includes('exceeds 4 MiB')))await block(error);
      throw error;
    }
  }
  async function refresh(){
    const values=await Promise.all([api(`/updates?session_id=${encodeURIComponent(sessionId)}`),api(`/status?session_id=${encodeURIComponent(sessionId)}`),api(`/navigation?session_id=${encodeURIComponent(sessionId)}`)]);
    const command=values[2];
    if(command?.status==='queued'){
      if(navigationResult?.command_id!==command.command_id){
        navigationResult={session_id:sessionId,command_id:command.command_id,status:'applied'};
        try{
          if(Date.now()/1000>=command.expires_at)throw Error('Highlight expired before navigation');
          if(contextState().documents[command.target]?.sha256!==command.sha256)throw Error('Design changed before navigation');
          revealEvidence(command);message('Agent highlighted the requested selection.');
        }catch(error){navigationResult.status='rejected';navigationResult.reason=error.message.slice(0,300);}
      }
      await api('/navigation',navigationResult);
    }
    records=values[0];presence=values[1].agents;render(contextState().documents);
    const answering=records.filter(r=>r.status==='answering').length,pending=records.filter(r=>r.status==='queued').length;
    status(answering?`${answering} question(s) being answered`:presence.length?`${presence.map(a=>a.name).join(', ')} connected${pending?` · ${pending} waiting`:''}`:`No agent connected${pending?` · ${pending} question(s) waiting`:''}`);
  }
  async function poll(){
    if(!connected||busy)return;busy=true;
    try{await sync();await refresh();}
    catch(error){if(blockedKey===contextState().key)status(error.message);else{lastContext='';status(`Connection: ${error.message} Retrying…`);}}
    finally{busy=false;if(connected)timer=setTimeout(poll,1000);}
  }
  async function send(){
    const prompt=$('agent-prompt').value.trim();if(!prompt){status('Enter a question about the design.');$('agent-prompt').focus();return;}
    if(!connected)return;
    $('agent-send').disabled=true;
    try{
      await sync();const prepared=cache.read();
      const replyTo=parentId||(newThread?null:records.filter(r=>r.status!=='cancelled').at(-1)?.id)||null;
      const envelope=JSON.stringify({session_id:sessionId,prompt,parent_id:replyTo});
      await api('/requests',`${envelope.slice(0,-1)},"context":${prepared.serialized}}`);parentId=null;newThread=false;
      $('agent-reply-context').hidden=true;$('agent-prompt').value='';await refresh();
    }catch(error){status(error.message);}
    finally{$('agent-send').disabled=false;}
  }
  function show(on){$('agent-panel').hidden=!on;document.body.classList.toggle('agent-panel-open',on);$('agent-open').setAttribute('aria-expanded',String(on));}
  $('agent-send').onclick=send;
  $('agent-prompt').addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}});
  $('agent-new-question').onclick=()=>{parentId=null;newThread=true;$('agent-reply-context').hidden=true;status('Starting a new question thread');};
  $('agent-close').onclick=()=>show(false);
  $('agent-open').onclick=async()=>{show($('agent-panel').hidden);if(!connected){connected=true;await poll();}if(!$('agent-panel').hidden)$('agent-prompt').focus();};
  $('agent-export').onclick=()=>{
    const value={schema:'copper-review-conversation/v1',exported_at:new Date().toISOString(),requests:records};
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'})),a=element('a');a.href=url;a.download='design-questions.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  for(const button of document.querySelectorAll('[data-agent-question]'))button.onclick=()=>{$('agent-prompt').value=button.dataset.agentQuestion;$('agent-prompt').focus();};
  if(localServer)api('').then(value=>{$('agent-open').hidden=!value.enabled;if(value.enabled&&!connected){connected=true;poll();}}).catch(()=>{});
  window.addEventListener('pagehide',()=>{const wasConnected=connected;connected=false;clearTimeout(timer);if(wasConnected)fetch('./api/agents/detach',{
    method:'POST',headers:{'X-Copper-Token':token,'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId}),keepalive:true}).catch(()=>{});});
  window.addEventListener('pageshow',e=>{if(e.persisted&&localServer&&!$('agent-open').hidden){connected=true;lastContext='';poll();}});
}

function progressText(r){return r.status==='answering'?`${r.claimed_by} is answering${r.progress?` · ${r.progress}`:''}`:r.status==='cancelled'?'Cancelled':'Waiting for an agent';}

export function describeSelection(s){
  if(s.kind)return `${s.kind}: ${s.id}`;
  return [...(s.components||[]),...(s.nets||[]),s.region?'selected region':null].filter(Boolean).join(', ')||'Whole board';
}
