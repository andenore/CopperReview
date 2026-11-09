/* Real UI + local mailbox; no hosted model or runtime dependency. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
mkdirSync('test-results',{recursive:true});
import {once} from 'node:events';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
const server=spawn(process.env.COPPER_PYTHON||'python',['-m','copper_review','examples/demo.kicad_pcb','--agents','--no-browser'],{env:{...process.env,COPPER_REVIEW_REGISTRY:resolve('test-results/agent-registry')},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,output='',serverErrors='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>serverErrors+=b);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await delay(100);}throw Error(`Timed out. ${serverErrors}`);}
try{
  const url=await until(()=>output.match(/CopperReview: (http:\/\/[^\s]+)/)?.[1]);
  const parsed=new URL(url),token=new URLSearchParams(parsed.hash.slice(1)).get('token');
  const agentUrl=await until(()=>output.match(/Agent MCP: (http:\/\/[^\s]+)/)?.[1]),agentToken=new URLSearchParams(new URL(agentUrl).hash.slice(1)).get('token');
  async function api(path,body){const response=await fetch(`${parsed.origin}/api/agents${path}`,{method:body===undefined?'GET':'POST',headers:{'X-Copper-Token':path==='/tool'?agentToken:token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;}
  const tool=(name,args={})=>api('/tool',{name,arguments:args});
  const requests=()=>tool('list_requests');
  browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
  const page=await browser.newPage({viewport:{width:1520,height:1020}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  await page.locator('.entity').filter({hasText:'U1'}).first().click();
  await page.locator('#agent-open').click();await page.locator('#agent-prompt').fill('Check the return path');await page.locator('#agent-send').click();
  const first=(await until(async()=>{const r=await requests();return r.length===1&&r;}))[0];
  const request=await tool('wait_for_question',{agent:'Test reviewer',timeout_seconds:0});
  assert.deepEqual(request.context.documents.layout.selection.components,['U1']);
  assert.equal(request.context.documents.layout.context.components[0].source_path,'control.U1');
  const payload={request_id:first.id,claim_id:request.claim_id,feedback_id:'browser-result-1',agent:'Test reviewer',target:'layout',sha256:request.context.documents.layout.sha256,
    summary:'One observation',findings:[{observation:'Inspect U1 return path <script>bad()</script>',category:'return_path',priority:'high'}]};
  await tool('publish_feedback',payload);
  await page.getByRole('button',{name:'Add findings to review notes',exact:true}).click();
  await until(async()=>(await page.locator('#note-count').textContent())==='1');
  assert.match(await page.locator('#note-list').textContent(),/Agent: Test reviewer/);
  await tool('publish_feedback',payload);await delay(1200);assert.equal(await page.locator('#note-count').textContent(),'1');
  await page.locator('#agent-results button').getByText('Follow up',{exact:true}).click();
  await page.locator('#agent-prompt').fill('Which geometry supports this?');await page.locator('#agent-send').click();
  const reply=(await until(async()=>{const r=await requests();return r.length===2&&r;}))[1];assert.equal(reply.parent_id,first.id);
  await page.locator('#agent-close').click();
  mkdirSync('test-results',{recursive:true});
  await page.locator('#note-list .note').click();
  await page.locator('#observation').fill('Human-edited return-path observation');await page.locator('#save-note').click();
  await page.locator('#export-menu').click();const download=page.waitForEvent('download');await page.locator('#export-review').click();
  await (await download).saveAs('test-results/agent-layout.review.json');
  const exported=JSON.parse(readFileSync('test-results/agent-layout.review.json'));assert.equal(exported.annotations[0].author.name,'Test reviewer');
  // A new exact-byte revision must not receive a response to the original board.
  await page.locator('#any-file').setInputFiles({name:'changed.kicad_pcb',mimeType:'application/octet-stream',buffer:Buffer.concat([readFileSync('examples/demo.kicad_pcb'),Buffer.from('\n')])});
  await until(async()=>{const c=await tool('get_context',{session_id:first.session_id});return c.documents.layout.sha256!==payload.sha256;});
  const replyClaim=await tool('wait_for_question',{agent:'Test reviewer',timeout_seconds:0});
  const stale=await tool('publish_feedback',{...payload,request_id:reply.id,claim_id:replyClaim.claim_id,feedback_id:'stale-result'});assert.equal(stale.status,'stale');
  await page.locator('#agent-open').click();await until(async()=>/Earlier design revision/.test(await page.locator('#agent-results').textContent()));
  assert.equal(await page.locator('#note-count').textContent(),'0');await page.locator('#agent-close').click();
  // Electrical target, exact native entity IDs, author metadata and exported selection.
  await page.locator('#any-file').setInputFiles('tests/fixtures/electrical-ir.json');
  await page.waitForSelector('#electrical-review:not([hidden])');
  await page.locator('#mode-switch [data-mode="electrical"]').click();
  await page.locator('#electrical-search').fill('DATA');
  await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  await page.locator('#agent-open').click();await page.locator('#agent-prompt').fill('Review this electrical net');await page.locator('#agent-send').click();
  const electrical=(await until(async()=>{const r=await requests();return r.length===3&&r;}))[2];
  const er=await tool('wait_for_question',{agent:'Electrical reviewer',timeout_seconds:0}),ed=er.context.documents.electrical;
  assert.equal(ed.selection.id,'DATA');assert.equal(ed.ir.schema,'copperscript-ir/v0.1');
  await tool('publish_feedback',{request_id:electrical.id,claim_id:er.claim_id,feedback_id:'electrical-result',target:'electrical',sha256:ed.sha256,agent:'Electrical reviewer',summary:'Check termination',findings:[{category:'interface',observation:'Check DATA termination against the source contract.'}]});
  await until(async()=>/Electrical reviewer/.test(await page.locator('#agent-results').textContent()));
  await page.getByRole('button',{name:'Add findings to review notes',exact:true}).click();
  await page.locator('#agent-close').click();
  await page.locator('#electrical-intent').getByRole('button',{name:'Notes',exact:true}).click();
  await until(async()=>(await page.locator('.electrical-note').count())===1);
  assert.match(await page.locator('.electrical-note').textContent(),/Agent: Electrical reviewer/);
  await page.locator('#export-menu').click();const electricalDownload=page.waitForEvent('download');await page.locator('#electrical-export').click();
  await (await electricalDownload).saveAs('test-results/agent-electrical.review.json');
  const eexport=JSON.parse(readFileSync('test-results/agent-electrical.review.json'));assert.equal(eexport.annotations[0].author.name,'Electrical reviewer');assert.equal(eexport.annotations[0].selection.id,'DATA');
  await page.screenshot({path:'test-results/agent-review.png'});
  await page.locator('#agent-open').click();await page.screenshot({path:'test-results/agent-panel.png'});await page.locator('#agent-close').click();
  await page.reload();await page.waitForSelector('#electrical-review:not([hidden])');await page.locator('#electrical-intent').getByRole('button',{name:'Notes',exact:true}).click();
  assert.equal(await page.locator('.electrical-note').count(),1);assert.match(await page.locator('.electrical-note').textContent(),/Electrical reviewer/);
  // Static hosting is allowed to load the new module but must never call the local API.
  const staticPage=await browser.newPage(),agentCalls=[];staticPage.on('request',r=>{if(r.url().includes('/api/agents'))agentCalls.push(r.url());});
  await staticPage.goto(parsed.origin);await delay(1200);assert.equal(await staticPage.locator('#agent-open').isVisible(),false);assert.deepEqual(agentCalls,[]);
  assert.deepEqual(errors,[]);
  console.log('PASS: live layout/electrical feedback, reply, idempotence, stale rejection, export, persistence, static isolation');
}finally{
  if(browser)await browser.close();
  server.kill();if(server.exitCode===null)await once(server,'exit');
}
