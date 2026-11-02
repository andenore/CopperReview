import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {electricalModel} from '../copper_review/web/electrical-model.js';
import {schematicSheets,layoutSheet,netRole,compactQuantity} from '../copper_review/web/schematic.js';
const pin=(name,domains,directions=['passive'])=>({name,number:name,profile:{domains,directions},bonds:[]});
const volts=v=>({base_value:String(v),unit:'V',value:String(v)});
const ohms=v=>({base_value:String(v),unit:'ohm',value:String(v)});
const parts=[
 {name:'MCU',category:'semiconductor.mcu',pins:[pin('VDD',['power'],['input']),pin('VSS',['ground'],['input']),pin('TX',['digital'],['output']),pin('IRQ',['digital'],['input']),pin('NC1',['digital'],['input'])]},
 {name:'BUF',category:'logic.buffer',pins:[pin('VCC',['power'],['input']),pin('GND',['ground'],['input']),pin('A',['digital'],['input']),pin('Y',['digital'],['output'])]},
 {name:'R',category:'passive.resistor',pins:[pin('1',[]),pin('2',[])]},
 {name:'C',category:'passive.capacitor',pins:[pin('1',[]),pin('2',[])]},
 {name:'TVS',category:'protection.esd',pins:[pin('IO',[]),pin('K',[])]},
 {name:'HDR',category:'connector.header',pins:[pin('1',['analog','digital','ground','power']),pin('2',['analog','digital','ground','power'])]},
];
const component=(ref,part,extra={})=>({ref,part,footprint:null,modes:{},properties:{},value:null,...extra});
function board(){return {schema:'copperscript-ir/v0.1',kind:'board',name:'Schematic',parts,devices:[],interfaces:[],peripheral_selections:[],module_instances:[],module_definitions:[],power_states:[],
 components:[component('U1','MCU'),component('U2','BUF'),component('C1','C',{value:{base_value:'1e-7',unit:'F',value:'100n'},properties:{role:'decoupling',decouples:'U1.VDD'}}),
  component('R_PU','R',{value:ohms(10000)}),component('R_SER','R',{value:ohms(33)}),component('R_SHUNT','R',{value:ohms(0.05)}),component('D1','TVS'),component('J1','HDR')],
 nets:[{name:'3V3',endpoints:['U1.VDD','U2.VCC','C1.1','R_PU.1']},{name:'GND',endpoints:['U1.VSS','U2.GND','C1.2','J1.2','D1.K']},
  {name:'TX',endpoints:['U1.TX','R_SER.1']},{name:'TX_R',endpoints:['R_SER.2','U2.A']},{name:'IRQ',endpoints:['U1.IRQ','R_PU.2']},
  {name:'OUT',endpoints:['U2.Y','R_SHUNT.1']},{name:'PORT',endpoints:['R_SHUNT.2','J1.1','D1.IO']}],
 supplies:[{name:'3V3',net:'3V3',voltage:volts(3.3)},{name:'GND',net:'GND',voltage:volts(0)}]};}

test('net roles trust declared supplies and ignore pins that claim both power and ground',()=>{
 const model=electricalModel(board());
 assert.equal(netRole(model,'3V3'),'power');assert.equal(netRole(model,'GND'),'ground');
 assert.equal(netRole(model,'PORT'),'signal','a generic header pin must not turn its net into ground or a rail');
});
test('compact values read like a schematic',()=>{
 assert.equal(compactQuantity({value:'4.7',unit:'kohm'}),'4.7k');assert.equal(compactQuantity({value:'33',unit:'ohm'}),'33Ω');
 assert.equal(compactQuantity({value:'100',unit:'nF'}),'100nF');assert.equal(compactQuantity({value:'10',unit:'uH'}),'10µH');assert.equal(compactQuantity(null),'');
});
test('decoupling, pull, series and ESD parts fold; shunts and path passives stay drawn',()=>{
 const model=electricalModel(board()),{sheets,folded,sheetOf,merged}=schematicSheets(model);
 assert.deepEqual([...folded.keys()].sort(),['C1','D1','R_PU','R_SER']);
 assert.equal(folded.get('R_SER').kind,'series');assert.deepEqual(merged.get('TX'),['TX','TX_R'],'a folded series link draws its two nets as one');
 assert.deepEqual(folded.get('D1'),{kind:'protect',ref:'D1',net:'PORT',nets:['PORT']});
 assert.equal(folded.get('C1').pin,'U1.VDD');assert.equal(folded.get('R_PU').kind,'pullup');assert.equal(folded.get('R_PU').rail,'3V3');
 const drawn=sheets.flatMap(s=>s.refs);assert.deepEqual(drawn.sort(),['J1','R_SHUNT','U1','U2']);
 for(const ref of folded.keys())assert(sheetOf.has(ref),`${ref} is listed on a sheet`);
 assert.equal(schematicSheets(model,{showPassives:true}).folded.size,0);
});
test('layout follows signal direction, draws rails as flags and folded parts as notes',()=>{
 const model=electricalModel(board()),ctx=schematicSheets(model),layout=layoutSheet(model,ctx.sheets[0],ctx);
 const at=ref=>layout.symbols.find(s=>s.ref===ref);
 assert(at('U1').x<at('U2').x,'driver and receiver run left to right across the folded series resistor');
 const shownAs=id=>layout.wires.find(w=>w.pins.includes(id))?.net||layout.labels.find(l=>l.pin===id)?.net;
 assert.equal(shownAs('U1.TX'),'TX');assert.equal(shownAs('U2.A'),'TX','both sides of R_SER are drawn as one net');
 assert.equal(at('U2').pins.find(p=>p.id==='U2.A').raw,'TX_R');
 assert(layout.notes.some(n=>n.net==='TX'&&n.refs[0]==='R_SER'&&n.text==='⟷33Ω'&&n.title.includes('TX and TX_R')),'series note on the far side');
 assert(layout.notes.some(n=>n.net==='PORT'&&n.refs[0]==='D1'&&n.text==='ESD'));
 assert.deepEqual(at('U1').top.map(f=>f.net),['3V3']);assert.deepEqual(at('U1').top[0].badges,['C1']);assert.deepEqual(at('U1').bottom.map(f=>f.net),['GND']);
 assert.equal(at('U1').nc,1);assert(!at('U1').pins.some(p=>p.name==='VDD'||p.name==='VSS'||p.name==='NC1'));
 assert(layout.notes.some(n=>n.net==='IRQ'&&n.refs[0]==='R_PU'&&n.text==='↑10k'));
});
function invariants(model,ctx){
 for(const sheet of ctx.sheets){
  const layout=layoutSheet(model,sheet,ctx),boxes=layout.symbols.map(s=>[s.x,s.y,s.x+s.w,s.y+s.h,s.ref]);
  for(const [i,a]of boxes.entries())for(const b of boxes.slice(i+1))assert(a[2]<=b[0]||b[2]<=a[0]||a[3]<=b[1]||b[3]<=a[1],`${a[4]} overlaps ${b[4]} on ${sheet.title}`);
  for(const w of layout.wires)for(const [x1,y1,x2,y2]of w.segments)for(const [l,t,r,b,ref]of boxes){
   const crosses=y1===y2?y1>t&&y1<b&&Math.max(x1,x2)>l+0.5&&Math.min(x1,x2)<r-0.5:x1>l&&x1<r&&Math.max(y1,y2)>t&&Math.min(y1,y2)<b;
   assert(!crosses,`${w.net} crosses ${ref} on ${sheet.title}`);
  }
  const shown=new Set([...layout.wires.flatMap(w=>w.segments.map(()=>w.net)),...layout.labels.map(l=>l.net)]);
  for(const s of layout.symbols)for(const p of s.pins)assert(shown.has(p.net),`${p.id} is wired or labelled`);
 }
}
test('generated sheets keep symbols apart and never route a wire through a symbol',()=>{
 for(const ir of [board(),JSON.parse(readFileSync(new URL('./fixtures/electrical-ir.json',import.meta.url)))]){
  const model=electricalModel(ir);for(const showPassives of [false,true])invariants(model,schematicSheets(model,{showPassives}));
 }
});
test('a hub with many signal nets gets its own sheet and large boards split by connectivity',()=>{
 const ir=board(),hub={name:'HUB',category:'semiconductor.mcu',pins:[pin('VDD',['power'],['input']),...Array.from({length:40},(_,i)=>pin(`P${i}`,['digital'],['output']))]};
 ir.parts.push(hub);ir.components.push(component('U_HUB','HUB'));ir.nets[0].endpoints.push('U_HUB.VDD');
 for(let i=0;i<40;i++){ir.components.push(component(`U_RX${i}`,'BUF'),component(`R_RX${i}`,'R',{value:ohms(22)}));ir.nets[0].endpoints.push(`U_RX${i}.VCC`);ir.nets[1].endpoints.push(`U_RX${i}.GND`);ir.nets.push({name:`HUB${i}`,endpoints:[`U_HUB.P${i}`,`R_RX${i}.1`]},{name:`RX${i}`,endpoints:[`R_RX${i}.2`,`U_RX${i}.A`]});}
 const model=electricalModel(ir),ctx=schematicSheets(model);
 assert(ctx.sheets.some(s=>s.refs[0]==='U_HUB'&&s.title==='U_HUB'),'hub sheet');
 assert(ctx.sheets.every(s=>s.refs.length<=36));
 const drawn=ctx.sheets.flatMap(s=>s.refs);assert.equal(new Set(drawn).size,drawn.length,'each part is drawn once');
 invariants(model,ctx);
});
test('a tall column of undirected parts wraps into columns around its hub',()=>{
 const ir=board(),hub={name:'HUBP',category:'semiconductor.mcu',pins:Array.from({length:30},(_,i)=>pin(`P${i}`,['digital']))};
 ir.parts.push(hub);ir.components.push(component('U_HUBP','HUBP'));
 for(let i=0;i<30;i++){ir.components.push(component(`J_W${i}`,'HDR'));ir.nets.push({name:`W${i}`,endpoints:[`U_HUBP.P${i}`,`J_W${i}.1`]});}
 const model=electricalModel(ir),ctx=schematicSheets(model),sheet=ctx.sheets.find(s=>s.refs.includes('U_HUBP')),layout=layoutSheet(model,sheet,ctx);
 assert(layout.height<=1700,`sheet stays wide, not tall (${Math.round(layout.height)})`);
 const hubX=layout.symbols.find(s=>s.ref==='U_HUBP').x;
 assert.deepEqual(layout.symbols.filter(s=>s.x===hubX).map(s=>s.ref),['U_HUBP'],'the hub keeps its own column');
 assert(layout.symbols.some(s=>s.x<hubX)&&layout.symbols.some(s=>s.x>hubX),'neighbours sit on both sides');
 invariants(model,ctx);
});
