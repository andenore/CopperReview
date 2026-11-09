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
  mcp=spawn(python,['-m','copper_review.agent_mcp'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let nextId=0;
  createInterface({input:mcp.stdout}).on('line',line=>{const r=JSON.parse(line);const handler=pending.get(r.id);if(handler){pending.delete(r.id);handler(r);}});
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`MCP timeout: ${method}`));},12000);pending.set(id,r=>{clearTimeout(timer);resolve(r);});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Browser test',version:'1'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert(!r.error,JSON.stringify(r));assert(!r.result.isError,r.result.content[0].text);return JSON.parse(r.result.content[0].text);}
  browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelectorAll('.entity').length===4);
  await page.locator('.entity').filter({hasText:'U1'}).first().click();await page.locator('#agent-open').click();
  await until(async()=>/No agent connected/.test(await page.locator('#agent-status').textContent()));
  const waiting=tool('wait_for_question',{agent:'Design helper',timeout_seconds:5});
  await page.locator('#agent-prompt').fill('What is U1, and which source instance is it?');await page.locator('#agent-send').click();
  const q=await waiting,doc=q.context.documents.layout;
  assert.equal(q.status,'answering');assert.equal(doc.context.components[0].reference,'U1');
  await tool('report_progress',{request_id:q.id,claim_id:q.claim_id,agent:'Design helper',message:'Reading the exported component record'});
  await until(async()=>/Reading the exported component record/.test(await page.locator('#agent-results').textContent()));
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
  const follow=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:0});assert.equal(follow.parent_id,q.id);
  await page.locator('#agent-results').getByRole('button',{name:'Cancel',exact:true}).click();
  const cancelled=await rpc('tools/call',{name:'publish_answer',arguments:{...result,request_id:follow.id,claim_id:follow.claim_id,answer_id:'cancelled'}});assert.equal(cancelled.result.isError,true);
  // General design questions have a bounded component/net catalog even without a selection.
  await page.locator('#clear').click();await page.locator('#agent-new-question').click();
  await page.locator('#agent-prompt').fill('What components are on this board?');await page.locator('#agent-send').click();
  const whole=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:0});assert.equal(whole.parent_id,null);assert.equal(whole.context.documents.layout.catalog.components.length,4);
  await tool('publish_answer',{request_id:whole.id,claim_id:whole.claim_id,answer_id:'qa-all',agent:'Design helper',based_on:{layout:doc.sha256},answer:'The export lists U1, U2, C1 and J1.',citations:[{label:'Component catalog',pointer:'/documents/layout/catalog/components'}]});
  await until(async()=>/lists U1/.test(await page.locator('#agent-results').textContent()));
  const download=page.waitForEvent('download');await page.locator('#agent-export').click();await (await download).saveAs('test-results/questions.json');
  const conversation=JSON.parse(readFileSync('test-results/questions.json'));assert.equal(conversation.schema,'copper-review-conversation/v1');assert.equal(conversation.requests[0].answer.payload.answer,result.answer);
  // A changed board flags old answers and prevents navigation of old geometry.
  await page.locator('#any-file').setInputFiles({name:'changed.kicad_pcb',mimeType:'application/octet-stream',buffer:Buffer.concat([readFileSync('examples/demo.kicad_pcb'),Buffer.from('\n')])});
  await until(async()=>/Earlier design revision/.test(await page.locator('#agent-results').textContent()));
  await page.locator('#agent-results summary').getByText('U1 component record',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'Show on board',exact:true}).isEnabled(),false);
  await page.screenshot({path:'test-results/questions-layout.png'});
  // Electrical context and evidence navigation use the exact loaded IR identity.
  await page.locator('#any-file').setInputFiles('tests/fixtures/electrical-ir.json');await page.locator('#mode-switch [data-mode="electrical"]').click();
  await page.locator('#electrical-search').fill('DATA');await page.locator('#electrical-entities [data-kind="net"][data-entity="DATA"]').click();
  await page.locator('#agent-prompt').fill('Explain the selected net using the electrical design.');await page.locator('#agent-send').click();
  const eq=await tool('wait_for_question',{agent:'Design helper',timeout_seconds:0}),ed=eq.context.documents.electrical;assert.equal(ed.selection.id,'DATA');
  await tool('publish_answer',{request_id:eq.id,claim_id:eq.claim_id,answer_id:'qa-ir',agent:'Design helper',based_on:{electrical:ed.sha256},answer:'DATA is the selected electrical net. The compiled IR supplies its declared connectivity; this does not prove routed copper connectivity.',citations:[{label:'Electrical selection',pointer:'/documents/electrical/selection',selection:{kind:'net',id:'DATA'}}]});
  await until(async()=>/DATA is the selected/.test(await page.locator('#agent-results').textContent()));
  await page.locator('#agent-results summary').getByText('Electrical selection',{exact:true}).click();await page.getByRole('button',{name:'Show in schematic',exact:true}).click();
  assert.equal(await page.locator('#electrical-inspector h3').textContent(),'DATA');
  await page.screenshot({path:'test-results/questions-electrical.png'});
  await page.setViewportSize({width:900,height:900});await page.locator('#agent-panel').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/questions-narrow.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: discovered MCP, waiting/progress, Q&A evidence, no unsolicited notes, live selection, follow-ups, cancellation, whole-board context, stale answers, electrical navigation, export');
}finally{
  if(browser)await browser.close();
  if(mcp){mcp.stdin.end();if(mcp.exitCode===null)await once(mcp,'exit');}
  server.kill();if(server.exitCode===null)await once(server,'exit');
}
