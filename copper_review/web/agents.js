/* Provider-neutral design Q&A. Models run in the user's agent host. */
import {randomId} from './hash.js';

export function matchesFeedback(feedback,documents){return documents[feedback.payload.target]?.sha256===feedback.payload.sha256;}
export function matchesAnswer(answer,documents){return Object.entries(answer.payload.based_on).every(([target,hash])=>documents[target]?.sha256===hash);}
const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
function saved(key,fallback){try{return JSON.parse(sessionStorage.getItem(key))??fallback;}catch{return fallback;}}
function save(key,value){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}

export function createAgentReview({token,localServer,snapshot,applyFeedback,revealEvidence,message}){
  const $=id=>document.getElementById(id),sessionId=randomId();
  let connected=false,busy=false,lastContext='',lastRendered='',parentId=null,newThread=false,timer=null,records=[],presence=[];
  const outcomes=new Map(saved('copper-review:agent-outcomes',[]));
  async function api(path,body){
    const response=await fetch(`./api/agents${path}`,{method:body===undefined?'GET':'POST',
      headers:{'X-Copper-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const value=await response.json();if(!response.ok)throw Error(value.error||'Agent connection unavailable');return value;
  }
  function status(text){$('agent-status').textContent=text;}
  function followUp(r){parentId=r.id;$('agent-reply-context').hidden=false;$('agent-reply-label').textContent=`Follow-up: ${r.prompt}`;$('agent-prompt').focus();}
  function action(label,fn){const b=element('button',label);b.type='button';b.onclick=async()=>{try{await fn();}catch(error){status(error.message);}};return b;}
  function render(documents){
    const hashes=Object.fromEntries(Object.entries(documents).map(([k,d])=>[k,d.sha256]));
    const signature=JSON.stringify([records,[...outcomes],hashes]);if(signature===lastRendered)return;lastRendered=signature;
    const list=$('agent-results'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60,scroll=list.scrollTop;list.replaceChildren();
    if(!records.length)list.append(element('p','Ask what a part does, how a net connects, or what the available design data says about a supply.','quiet'));
    for(const r of records){
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
          if(!matchesFeedback(feedback,snapshot().documents))throw Error('Design changed');
          applyFeedback(r);outcomes.set(r.id,'Added to review notes');save('copper-review:agent-outcomes',[...outcomes].slice(-64));render(snapshot().documents);
        }));
      }else row.append(element('p',r.status==='answering'?`${r.claimed_by} is answering${r.progress?` · ${r.progress}`:''}`:r.status==='cancelled'?'Cancelled':'Waiting for an agent','quiet'));
      const actions=element('div',undefined,'agent-actions');
      if(['queued','answering'].includes(r.status))actions.append(action('Cancel',async()=>{await api('/cancel',{session_id:sessionId,request_id:r.id});await refresh();}));
      else{actions.append(action('Follow up',()=>followUp(r)));actions.append(action('Ask again',()=>{$('agent-prompt').value=r.prompt;parentId=null;return send();}));}
      row.append(actions);list.append(row);
    }
    if(nearBottom)list.scrollTop=list.scrollHeight;else list.scrollTop=scroll;
  }
  async function sync(){
    const context=snapshot(),serialized=JSON.stringify(context);
    const active=context.documents[context.mode==='electrical'?'electrical':'layout'];
    $('agent-selection').textContent=active?.selection?describeSelection(active.selection):'Whole design';
    if(serialized!==lastContext){await api('/context',{session_id:sessionId,context});lastContext=serialized;}
  }
  async function refresh(){
    const values=await Promise.all([api(`/updates?session_id=${encodeURIComponent(sessionId)}`),api(`/status?session_id=${encodeURIComponent(sessionId)}`)]);
    records=values[0];presence=values[1].agents;render(snapshot().documents);
    const answering=records.filter(r=>r.status==='answering').length,pending=records.filter(r=>r.status==='queued').length;
    status(answering?`${answering} question(s) being answered`:presence.length?`${presence.map(a=>a.name).join(', ')} connected${pending?` · ${pending} waiting`:''}`:`No agent connected${pending?` · ${pending} question(s) waiting`:''}`);
  }
  async function poll(){
    if(!connected||busy)return;busy=true;
    try{await sync();await refresh();}
    catch(error){lastContext='';status(`Connection: ${error.message} Retrying…`);}
    finally{busy=false;if(connected)timer=setTimeout(poll,1000);}
  }
  async function send(){
    const prompt=$('agent-prompt').value.trim();if(!prompt){status('Enter a question about the design.');$('agent-prompt').focus();return;}
    if(!connected)return;
    $('agent-send').disabled=true;
    try{
      const replyTo=parentId||(newThread?null:records.filter(r=>r.status!=='cancelled').at(-1)?.id)||null;
      await api('/requests',{session_id:sessionId,prompt,parent_id:replyTo,context:snapshot()});lastContext='';parentId=null;newThread=false;
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
  if(localServer)api('').then(value=>{$('agent-open').hidden=!value.enabled;}).catch(()=>{});
  window.addEventListener('pagehide',()=>{connected=false;clearTimeout(timer);});
}

export function describeSelection(s){
  if(s.kind)return `${s.kind}: ${s.id}`;
  return [...(s.components||[]),...(s.nets||[]),s.region?'selected region':null].filter(Boolean).join(', ')||'Whole board';
}
