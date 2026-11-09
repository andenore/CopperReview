/* Viewer + automatically discovered MCP subprocess + actual browser Q&A. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
mkdirSync('test-results',{recursive:true});
const env={...process.env,COPPER_REVIEW_REGISTRY:resolve('test-results/question-registry')};delete env.COPPER_REVIEW_URL;
const python=process.env.COPPER_PYTHON||'python';
const server=spawn(python,['-m','copper_review','examples/demo.kicad_pcb','--agents','--no-browser'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',serverErrors='',browser,mcp;server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>serverErrors+=b);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){const result=await fn();if(result)return result;await delay(100);}throw Error(`Timed out: ${serverErrors}`);}
try{
  const url=await until(()=>output.match(/CopperReview: (http:\/\/[^\s]+)/)?.[1]);
  await until(()=>output.includes('discovers this viewer automatically'));
  const viewerUrl=new URL(url),viewerToken=new URLSearchParams(viewerUrl.hash.slice(1)).get('token');
  const generated=await (await fetch(viewerUrl.origin+'/api/agents/setup',{headers:{'X-Copper-Token':viewerToken}})).json();
  mcp=spawn(generated.config.command,generated.config.args,{env:{...env,...generated.config.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),notifications=[];let nextId=0;
  createInterface({input:mcp.stdout}).on('line',line=>{const r=JSON.parse(line);if(r.method)notifications.push(r);const handler=pending.get(r.id);if(handler){pending.delete(r.id);handler(r);}});
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`MCP timeout: ${method}`));},12000);pending.set(id,r=>{clearTimeout(timer);resolve(r);});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Browser test',version:'1'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert(!r.error,JSON.stringify(r));assert(!r.result.isError,r.result.content[0].text);return JSON.parse(r.result.content[0].text);}
  browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  // Host-side chat works before the viewer's question panel has ever opened.
  await until(async()=>(await tool('list_sessions')).some(s=>s.active&&s.documents.layout));
  assert.equal(await page.locator('#agent-panel').isVisible(),false);
  await until(async()=>(await page.locator('#agent-connect').textContent())==='Agent connected');
  await page.locator('#agent-connect').click();
  await until(async()=>(await page.locator('#agent-command').inputValue())!=='');
  assert.equal(await page.locator('#agent-command').inputValue(),generated.config.command);
  assert.match(await page.locator('#agent-shared-design').textContent(),/demo/i);
  await page.screenshot({path:'test-results/agent-setup-chatgpt.png'});
  await page.locator('#agent-setup-client').selectOption('claude');
  const bundleDownload=page.waitForEvent('download');await page.locator('#agent-extension-download').click();
  await (await bundleDownload).saveAs('test-results/downloaded-copper-review.mcpb');
  assert.equal(readFileSync('test-results/downloaded-copper-review.mcpb').subarray(0,2).toString(),'PK');
  await page.locator('#agent-test').click();
  await until(async()=>(await page.locator('#agent-test-prompt').inputValue())!=='');
  assert.match(await page.locator('#agent-test-prompt').inputValue(),/get_current_selection/);
  assert.match(await page.locator('#agent-test-result').textContent(),/Waiting/);
  const proof=await tool('get_current_selection');
  await until(async()=>/Passed: Browser test/.test(await page.locator('#agent-test-result').textContent()));
  assert.match(await page.locator('#agent-test-prompt').inputValue(),new RegExp(proof.session_id));
  await page.screenshot({path:'test-results/agent-setup-claude.png'});
  await page.setViewportSize({width:700,height:900});await page.screenshot({path:'test-results/agent-setup-narrow.png'});
  await page.setViewportSize({width:1600,height:1000});
  await page.locator('#agent-setup-close').click();
  assert.equal(await page.locator('#agent-connect').textContent(),'Selection read');
  const listed=await rpc('resources/list',{});assert.equal(listed.result.resources[0].uri,'copper-review://selection');
  const prompts=await rpc('prompts/list',{});assert(prompts.result.prompts.some(p=>p.name==='explain-selection'));
  const prompt=await rpc('prompts/get',{name:'explain-selection',arguments:{question:'What does this do?'}});
  assert.match(prompt.result.messages[0].content.text,/get_current_selection/);
  await rpc('resources/subscribe',{uri:'copper-review://selection'});
  const beforeNotifications=notifications.length;
  await page.locator('.entity').filter({hasText:'U2'}).first().click();
  // No tool call is keeping the agent alive here: the adapter emits the update while stdin is idle.
  await until(()=>notifications.length>beforeNotifications);
  assert.equal(notifications.at(-1).method,'notifications/resources/updated');
  const resource=await rpc('resources/read',{uri:'copper-review://selection'});
  const selected=JSON.parse(resource.result.contents[0].text);
  assert.deepEqual(selected.context.documents.layout.selection.components,['U2']);
  assert.equal((await tool('list_requests')).length,0);
  const highlight=await tool('show_on_board',{target:'layout',sha256:selected.context.documents.layout.sha256,
    selection:{components:['U1'],nets:[],region:null}});
  assert.equal(highlight.status,'queued');
  await until(async()=>(await tool('get_navigation_status',{session_id:highlight.session_id,command_id:highlight.command_id})).status==='applied');
  assert.match(await page.locator('#selection-detail').textContent(),/U1/);
  assert.equal(await page.locator('#note-count').textContent(),'0');
  // A highlight cannot retarget an unsaved layout note.
  await page.locator('#observation').fill('Draft belongs to U1');
  const blocked=await tool('show_on_board',{target:'layout',sha256:selected.context.documents.layout.sha256,
    selection:{components:['U2'],nets:[],region:null}});
  const rejected=await until(async()=>{const r=await tool('get_navigation_status',{session_id:blocked.session_id,command_id:blocked.command_id});return r.status==='rejected'&&r;});
  assert.match(rejected.reason,/editing a note/);
  assert.match(await page.locator('#selection-detail').textContent(),/U1/);
  await page.locator('#save-note').click();
  const savedLayout=await page.evaluate(()=>Object.values(localStorage).flatMap(raw=>{try{return JSON.parse(raw)?.annotations||[];}catch{return [];}}).find(n=>n.observation==='Draft belongs to U1'));
  assert.deepEqual(savedLayout.selection.components,['U1']);
  await page.getByRole('button',{name:'Delete annotation: Draft belongs to U1',exact:true}).click();
  // window.open copies sessionStorage just like Duplicate tab. Contexts stay separate.
  const originalSession=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('copper-review:agent-session')));
  const popup=page.waitForEvent('popup');
  await page.evaluate(url=>window.open(url,'_blank'),url);
  const duplicate=await popup;
  duplicate.on('pageerror',e=>errors.push(e.message));
  await duplicate.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  await until(async()=>await duplicate.evaluate(original=>{const id=JSON.parse(sessionStorage.getItem('copper-review:agent-session'));return id&&id!==original;},originalSession));
  await duplicate.bringToFront();
  await duplicate.locator('.entity').filter({hasText:'U2'}).first().click();
  const duplicateSelection=await until(async()=>{const r=await tool('get_current_selection');return r.session_id!==originalSession&&r.context.documents.layout?.selection.components.includes('U2')&&r;});
  assert.equal(duplicateSelection.chosen_by,'most recently used active tab');
  await page.bringToFront();
  await page.locator('.entity').filter({hasText:'U1'}).first().click();
  await until(async()=>(await tool('get_current_selection')).session_id===originalSession);
  assert.deepEqual((await tool('get_current_selection',{session_id:duplicateSelection.session_id})).context.documents.layout.selection.components,['U2']);
  await duplicate.close();
  // A response delayed past its deadline must not navigate a resumed browser tab.
  await page.route('**/api/agents/navigation?*',async route=>{
    const response=await route.fetch(),command=await response.json();
    await route.fulfill({response,json:command?.status==='queued'?{...command,expires_at:0}:command});
  });
  const expiredHighlight=await tool('show_on_board',{target:'layout',sha256:selected.context.documents.layout.sha256,
    selection:{components:['U2'],nets:[],region:null}});
  await until(async()=>(await tool('get_navigation_status',{session_id:expiredHighlight.session_id,command_id:expiredHighlight.command_id})).status==='rejected');
  assert.match(await page.locator('#selection-detail').textContent(),/U1/);
  await page.unroute('**/api/agents/navigation?*');
  await rpc('resources/unsubscribe',{uri:'copper-review://selection'});
  await page.locator('.entity').filter({hasText:'U1'}).first().click();await page.locator('#agent-open').click();
  await until(async()=>/connected/.test(await page.locator('#agent-status').textContent()));
  const waiting=tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});
  await page.locator('#agent-prompt').fill('What is U1, and which source instance is it?');await page.locator('#agent-send').click();
  const q=await waiting,doc=q.context.documents.layout;
  assert.equal(q.status,'answering');assert.equal(doc.context.components[0].reference,'U1');
  await until(async()=>(await page.locator('[data-request-id]').count())===1);
  await page.evaluate(()=>window.pendingRow=document.querySelector('[data-request-id]'));
  await tool('report_progress',{request_id:q.id,claim_id:q.claim_id,agent:'Design helper',message:'Reading the exported component record'});
  await until(async()=>/Reading the exported component record/.test(await page.locator('#agent-results').textContent()));
  assert.equal(await page.evaluate(()=>window.pendingRow===document.querySelector('[data-request-id]')),true);
  const result={request_id:q.id,claim_id:q.claim_id,answer_id:'qa-1',agent:'Design helper',based_on:{layout:doc.sha256},
    answer:'U1 is labeled Controller in this board export. Its CopperScript source path is control.U1.\nThe label suggests a controller role, but does not establish its exact behavior.',
    limitations:'A part contract or datasheet is needed to explain its full behavior.',citations:[{label:'U1 component record',pointer:'/documents/layout/context/components/0',selection:{components:['U1'],nets:[],region:null}}]};
  await tool('publish_answer',result);
  await until(async()=>/labeled Controller/.test(await page.locator('#agent-results').textContent()));
  assert.equal(await page.locator('#note-count').textContent(),'0');
  // Selecting the board works while the question panel stays open; evidence navigates back.
  await page.locator('#clear').click();await page.locator('#agent-results summary').getByText('U1 component record',{exact:true}).click();
  await page.getByRole('button',{name:'Show on board',exact:true}).click();assert.match(await page.locator('#selection-detail').textContent(),/U1/);
  await page.locator('#agent-prompt').fill('Which pins are connected?');await page.locator('#agent-send').click();
  const follow=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});assert.equal(follow.parent_id,q.id);
  await page.locator('#agent-results').getByRole('button',{name:'Cancel',exact:true}).click();
  const cancelled=await rpc('tools/call',{name:'publish_answer',arguments:{...result,request_id:follow.id,claim_id:follow.claim_id,answer_id:'cancelled'}});assert.equal(cancelled.result.isError,true);
  // General design questions have a bounded component/net catalog even without a selection.
  await page.locator('#clear').click();await page.locator('#agent-new-question').click();
  await page.locator('#agent-prompt').fill('What components are on this board?');await page.locator('#agent-send').click();
  const whole=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});assert.equal(whole.parent_id,null);assert.equal(whole.context.documents.layout.catalog.components.length,4);
  await tool('publish_answer',{request_id:whole.id,claim_id:whole.claim_id,answer_id:'qa-all',agent:'Design helper',based_on:{layout:doc.sha256},answer:'The export lists U1, U2, C1 and J1.',citations:[{label:'Component catalog',pointer:'/documents/layout/catalog/components'}]});
  await until(async()=>/lists U1/.test(await page.locator('#agent-results').textContent()));
  // Ask again on an older question starts a fresh thread, not a reply to the latest question.
  await page.locator('[data-request-id]').first().getByRole('button',{name:'Ask again',exact:true}).click();
  const again=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});
  assert.equal(again.prompt,q.prompt);assert.equal(again.parent_id,null);
  await page.locator('[data-request-id]').last().getByRole('button',{name:'Cancel',exact:true}).click();
  // Reloads preserve the session/history rather than exhausting eight session slots.
  for(let i=0;i<9;i++){
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
    await page.locator('#agent-open').click();
    await until(async()=>/labeled Controller/.test(await page.locator('#agent-results').textContent()));
  }
  const sessions=await tool('list_sessions');assert.equal(sessions.length,2);assert.deepEqual(sessions.filter(s=>s.active).map(s=>s.session_id),[q.session_id]);
  // Idle polling, including with the panel closed, does not re-upload full contexts.
  await until(async()=>{const current=await tool('get_current_selection');return current.context.documents.layout?.sha256===doc.sha256&&!current.context.documents.layout.selection.components.length;});
  let contextPosts=0;const onRequest=r=>{if(r.url().includes('/api/agents/context'))contextPosts++;};
  page.on('request',onRequest);await page.locator('#agent-close').click();await delay(2200);
  assert.equal(contextPosts,0);page.off('request',onRequest);await page.locator('#agent-open').click();
  const download=page.waitForEvent('download');await page.locator('#agent-export').click();await (await download).saveAs('test-results/questions.json');
  const conversation=JSON.parse(readFileSync('test-results/questions.json'));assert.equal(conversation.schema,'copper-review-conversation/v1');assert.equal(conversation.requests[0].answer.payload.answer,result.answer);
  // A changed board flags old answers and prevents navigation of old geometry.
  let releaseNavigation,heldNavigation=false;const navigationGate=new Promise(resolve=>releaseNavigation=resolve);
  await page.route('**/api/agents/navigation?*',async route=>{heldNavigation=true;await navigationGate;await route.continue();});
  await until(()=>heldNavigation);
  const oldHighlight=await tool('show_on_board',{target:'layout',sha256:doc.sha256,selection:{components:['U1'],nets:[],region:null}});
  await page.locator('#any-file').setInputFiles({name:'changed.kicad_pcb',mimeType:'application/octet-stream',buffer:Buffer.concat([readFileSync('examples/demo.kicad_pcb'),Buffer.from('\n')])});
  await until(async()=>/changed/.test(await page.locator('#board-name').textContent()));
  releaseNavigation();
  await until(async()=>(await tool('get_navigation_status',{session_id:oldHighlight.session_id,command_id:oldHighlight.command_id})).status==='rejected');
  await page.unroute('**/api/agents/navigation?*');
  await until(async()=>/Earlier design revision/.test(await page.locator('#agent-results').textContent()));
  await page.locator('#agent-results summary').getByText('U1 component record',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'Show on board',exact:true}).isEnabled(),false);
  await page.screenshot({path:'test-results/questions-layout.png'});
  // Electrical context and evidence navigation use the exact loaded IR identity.
  await page.locator('#any-file').setInputFiles('tests/fixtures/electrical-ir.json');await page.locator('#mode-switch [data-mode="electrical"]').click();
  await page.locator('#electrical-search').fill('DATA');await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  const electricalContext=await until(async()=>{const current=await tool('get_current_selection');return current.context.documents.electrical?.selection?.id==='DATA'&&current;});
  const electricalHighlight=await tool('show_on_board',{target:'electrical',sha256:electricalContext.context.documents.electrical.sha256,selection:{kind:'net',id:'DATA'}});
  await until(async()=>(await tool('get_navigation_status',{session_id:electricalHighlight.session_id,command_id:electricalHighlight.command_id})).status==='applied');
  await page.locator('#electrical-intent').getByRole('button',{name:'Notes',exact:true}).click();
  await page.locator('#electrical-observation').fill('Draft belongs to DATA');
  const blockedElectrical=await tool('show_on_board',{target:'electrical',sha256:electricalContext.context.documents.electrical.sha256,selection:{kind:'component',id:'HOST'}});
  await until(async()=>{const r=await tool('get_navigation_status',{session_id:blockedElectrical.session_id,command_id:blockedElectrical.command_id});return r.status==='rejected'&&/editing a note/.test(r.reason);});
  assert.equal(await page.locator('#electrical-observation').inputValue(),'Draft belongs to DATA');
  await page.locator('#electrical-save-note').click();
  const savedElectrical=await page.evaluate(()=>Object.values(localStorage).flatMap(raw=>{try{return JSON.parse(raw)?.notes||[];}catch{return [];}}).find(n=>n.observation==='Draft belongs to DATA'));
  assert.deepEqual(savedElectrical.selection,{kind:'net',id:'DATA'});
  await page.locator('#agent-prompt').fill('Explain the selected net using the electrical design.');await page.locator('#agent-send').click();
  const eq=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:5}),ed=eq.context.documents.electrical;assert.equal(ed.selection.id,'DATA');
  await tool('publish_answer',{request_id:eq.id,claim_id:eq.claim_id,answer_id:'qa-ir',agent:'Design helper',based_on:{electrical:ed.sha256},answer:'DATA is the selected electrical net. The compiled IR supplies its declared connectivity; this does not prove routed copper connectivity.',citations:[{label:'Electrical selection',pointer:'/documents/electrical/selection',selection:{kind:'net',id:'DATA'}}]});
  await until(async()=>/DATA is the selected/.test(await page.locator('#agent-results').textContent()));
  await page.locator('#agent-results summary').getByText('Electrical selection',{exact:true}).click();await page.getByRole('button',{name:'Show in schematic',exact:true}).click();
  assert.equal(await page.locator('#electrical-inspector h3').textContent(),'DATA');
  await page.screenshot({path:'test-results/questions-electrical.png'});
  // Oversize IR remains usable through bounded selected connectivity, with explicit omissions.
  const large=JSON.parse(readFileSync('tests/fixtures/electrical-ir.json'));large.agent_test_padding='µ'.repeat(3*1024*1024);
  await page.locator('#any-file').setInputFiles({name:'large-ir.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(large))});
  await page.locator('#electrical-search').fill('DATA');await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  await page.locator('#agent-prompt').fill('Explain DATA on the large design.');await page.locator('#agent-send').click();
  const largeQuestion=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});
  assert.equal(largeQuestion.context.documents.electrical.ir,undefined);
  assert(largeQuestion.context.omissions.some(s=>s.includes('/electrical/ir')));
  assert(largeQuestion.context.documents.electrical.selection_context.nets.some(n=>n.name==='DATA'));
  assert.match(await page.locator('#agent-context-warning').textContent(),/omitted/);
  await tool('publish_answer',{request_id:largeQuestion.id,claim_id:largeQuestion.claim_id,answer_id:'qa-large',agent:'Design helper',
    based_on:{electrical:largeQuestion.context.documents.electrical.sha256},answer:'Selected DATA connectivity remains available.',
    citations:[{label:'Selected connectivity',pointer:'/documents/electrical/selection_context'}]});
  await until(async()=>/Selected DATA connectivity remains available/.test(await page.locator('#agent-results').textContent()));
  // A server size rejection is shown once; polling does not keep POSTing the payload.
  let rejectedPosts=0;
  await page.route('**/api/agents/context',async route=>{rejectedPosts++;await route.fulfill({status:413,contentType:'application/json',body:JSON.stringify({error:'Selection context exceeds 4 MiB; select a smaller area'})});});
  await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  await until(async()=>/select a smaller area/.test(await page.locator('#agent-status').textContent()));
  await delay(2200);assert.equal(rejectedPosts,1);
  await page.unroute('**/api/agents/context');
  await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  await until(async()=>/connected/.test(await page.locator('#agent-status').textContent()));
  await page.setViewportSize({width:900,height:900});await page.locator('#agent-panel').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/questions-narrow.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: host chat, prompts, resource notifications, highlights, layout/schematic draft protection, duplicated tab isolation, focus selection, Q&A evidence, nine reloads, idle polling, cancellation, stale answers, large IR fallback, setup, extension download, export');
}finally{
  if(browser)await browser.close();
  if(mcp){mcp.stdin.end();if(mcp.exitCode===null)await once(mcp,'exit');}
  server.kill();if(server.exitCode===null)await once(server,'exit');
}
