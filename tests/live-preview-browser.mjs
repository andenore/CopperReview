/* Real file saves -> read-only server snapshots -> WASM -> browser -> MCP proof. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url),{chromium}=require(process.env.COPPER_PLAYWRIGHT_MODULE||'playwright');
mkdirSync('test-results',{recursive:true});
const root=mkdtempSync(resolve('test-results/live-project-')),pcb=join(root,'board.kicad_pcb'),part=join(root,'parts','stage.copper');
mkdirSync(join(root,'parts'));
writeFileSync(join(root,'board.copper'),'board LiveBoard { use library "tiny"; import parts "./parts"; module M: parts.Stage; }');
const source=value=>'module Stage { use library "tiny"; component R1: RESISTOR { value = '+value+' kohm; } }';
writeFileSync(part,source(1));const board=readFileSync('examples/demo.kicad_pcb');writeFileSync(pcb,board);
const env={...process.env,COPPER_REVIEW_REGISTRY:join(root,'registry')};delete env.COPPER_REVIEW_URL;
const server=spawn(process.env.COPPER_PYTHON||'python',['-m','copper_review',pcb,'--project',root,'--entry','board.copper','--agents','--watch','--no-browser'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',stderr='',browser,page,mcp;server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>stderr+=b);
const errors=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<200;i++){const result=await fn();if(result)return result;await delay(150);}throw Error('Timed out: '+stderr);}
try{
  const url=await until(()=>output.match(/CopperReview: (http:\/\/[^\s]+)/)?.[1]);
  browser=await chromium.launch({headless:true,executablePath:process.env.COPPER_BROWSER_EXECUTABLE||undefined});
  page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  const token=new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  const config=await(await fetch(new URL('/api/agents/setup',url),{headers:{'X-Copper-Token':token}})).json();
  mcp=spawn(config.config.command,config.config.args,{env:{...env,...config.config.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let id=0;
  createInterface({input:mcp.stdout}).on('line',line=>{const result=JSON.parse(line);pending.get(result.id)?.(result);pending.delete(result.id);});
  function rpc(method,params){return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error('MCP timeout')),15000);pending.set(key,r=>{clearTimeout(timer);resolve(r);});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});}
  await rpc('initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'Live preview test'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});assert(!r.result?.isError,JSON.stringify(r));return JSON.parse(r.result.content[0].text);}
  await until(async()=>(await tool('list_sessions')).some(s=>s.documents.electrical));
  const initial=await until(async()=>{const s=await tool('get_preview_status');return s.current.source&&s.current.layout&&s;});
  await page.locator('#mode-switch [data-mode="electrical"]').click();
  await page.locator('#electrical-search').fill('M/R1');
  await page.locator('#electrical-entities [data-kind="component"][data-entity="M/R1"]').click();
  await page.locator('#electrical-canvas').hover();await page.mouse.wheel(0,-400);await delay(150);
  const zoomOf=()=>page.locator('#electrical-canvas svg').first().evaluate(e=>parseFloat(e.style.width)/Number(e.dataset.naturalWidth));
  const scale=await zoomOf();
  writeFileSync(part,source(10));
  const updated=await until(async()=>{const s=await tool('get_preview_status');return s.current.source&&s.browser.source.revision!==initial.browser.source.revision&&s;});
  assert.equal(await page.locator('#electrical-inspector h3').textContent(),'M/R1');
  assert(Math.abs(await zoomOf()-scale)<.0001);
  const selected=await tool('get_current_selection');
  assert.equal(selected.context.documents.electrical.selection.id,'M/R1');
  assert.equal(updated.disk.source.files['parts/stage.copper'],(await import('node:crypto')).createHash('sha256').update(source(10)).digest('hex'));
  // Failed compile keeps the last successful design, with an explicit stale status.
  writeFileSync(part,'module Stage { invalid !!!');
  await until(async()=>(await tool('get_preview_status')).browser.source?.state==='error');
  assert.equal((await tool('get_current_selection')).context.documents.electrical.sha256,selected.context.documents.electrical.sha256);
  assert.match(await page.locator('#live-preview-label').textContent(),/Out of date/);
  await page.locator('#live-preview-label').click();
  await page.screenshot({path:'test-results/live-preview-error.png'});
  await page.setViewportSize({width:700,height:900});
  assert(await page.locator('.live-preview-popover').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  await page.screenshot({path:'test-results/live-preview-narrow.png'});
  await page.setViewportSize({width:1600,height:1000});
  await page.locator('#live-preview-label').click();
  // Draft prevents replacement; save remains tied to the old hash and selection.
  await page.locator('#electrical-intent').getByRole('button',{name:'Notes',exact:true}).click();
  await page.locator('#electrical-observation').fill('Note on the 10k revision');
  writeFileSync(part,source(22));
  await until(async()=>(await tool('get_preview_status')).browser.source?.state==='deferred');
  assert.equal(await page.locator('#electrical-observation').inputValue(),'Note on the 10k revision');
  await page.locator('#electrical-save-note').click();
  await until(async()=>{const s=await tool('get_preview_status');return s.current.source&&s.browser.source.revision!==updated.browser.source.revision;});
  const oldNotes=await page.evaluate(hash=>JSON.parse(localStorage.getItem('copper-review:electrical:v1:'+hash)),selected.context.documents.electrical.sha256);
  assert.equal(oldNotes.notes[0].selection.id,'M/R1');
  // Pause/resume and manual file opens cannot be overwritten by background compilation.
  await page.locator('#live-preview-label').click();await page.locator('#live-preview-enabled').uncheck();
  writeFileSync(part,source(33));
  await until(async()=>{const s=await tool('get_preview_status');return s.browser.paused&&!s.current.source;});
  await page.locator('#live-preview-enabled').check();
  await until(async()=>(await tool('get_preview_status')).current.source);
  await page.locator('#live-preview-label').click();
  // Rebuilt PCB refresh is independent; a partial file keeps the old board.
  await page.locator('#mode-switch [data-mode="layout"]').click();
  await page.locator('.entity').filter({hasText:'U1'}).first().click();
  await page.locator('#board-canvas').hover();await page.mouse.wheel(0,-250);await delay(150);
  const zoom=await page.locator('#zoom-status').textContent(),oldBoard=(await tool('get_current_selection')).context.documents.layout.sha256;
  writeFileSync(pcb,'(kicad_pcb (version');
  await until(async()=>(await tool('get_preview_status')).disk.layout.state==='error');
  assert.equal((await tool('get_current_selection')).context.documents.layout.sha256,oldBoard);
  await page.locator('#observation').fill('PCB draft stays on U1');
  writeFileSync(pcb,Buffer.concat([board,Buffer.from('\n')]));
  await until(async()=>(await tool('get_preview_status')).browser.layout?.state==='deferred');
  assert.equal(await page.locator('#observation').inputValue(),'PCB draft stays on U1');
  await page.locator('#cancel-edit').click();
  await until(async()=>{const s=await tool('get_preview_status');return s.current.layout&&s.browser.layout.sha256!==oldBoard;});
  assert.match(await page.locator('#selection-detail').textContent(),/U1/);
  assert.equal(await page.locator('#zoom-status').textContent(),zoom);
  await page.locator('#any-file').setInputFiles('tests/fixtures/electrical-ir.json');
  await until(async()=>(await tool('get_preview_status')).browser.paused);
  await page.locator('#live-preview-label').click();await page.locator('#live-preview-enabled').check();
  await until(async()=>(await tool('get_preview_status')).current.source);
  assert.equal((await tool('get_preview_status')).browser.source.entry,'board.copper');
  await page.locator('#live-preview-enabled').uncheck();
  writeFileSync(part,source(47));await delay(1600);
  assert.equal((await tool('get_preview_status')).browser.paused,true);
  assert.deepEqual(errors,[]);
  console.log('PASS: real WASM imported-source edits, hashes/status through MCP, selection/zoom, failed compile recovery, schematic/PCB drafts, independent PCB refresh, pause/resume and manual-open isolation');
}catch(error){if(page){console.error(await page.locator('#live-preview-details').textContent(),errors);await page.screenshot({path:'test-results/live-preview-failure.png'});}throw error;}
finally{await browser?.close();mcp?.kill();server.kill();}
