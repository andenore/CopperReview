import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {electricalModel} from '../copper_review/web/electrical-model.js';
import {schematicSheets,layoutSheet,netRole,compactQuantity,orderLanes,symbolKind,isCathode,glyph} from '../copper_review/web/schematic.js';
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
test('an LED and its resistor, or a crystal and its capacitors, stay together beside their IC',()=>{
 const ir=board();
 ir.parts.push({name:'LED',category:'optoelectronics.led',pins:[pin('A',[]),pin('K',[])]},{name:'XTAL',category:'passive.crystal',pins:[pin('1',[]),pin('2',[])]},
  {name:'IC',category:'semiconductor.mcu',pins:[pin('VDD',['power'],['input']),pin('GND',['ground'],['input']),...['L1','L2','X1','X2','A','B','C','D'].map(n=>pin(n,['digital']))]});
 ir.components.push(component('U_IC','IC'),component('R_L1','R',{value:ohms(1000)}),component('R_L2','R',{value:ohms(1000)}),component('D_L1','LED'),component('D_L2','LED'),component('Y1','XTAL'),component('C_X1','C',{value:{base_value:'1.2e-11',unit:'pF',value:'12'}}),component('C_X2','C',{value:{base_value:'1.2e-11',unit:'pF',value:'12'}}));
 for(const n of ['A','B','C','D'])ir.components.push(component(`J_${n}`,'HDR'));
 ir.nets[0].endpoints.push('U_IC.VDD');ir.nets[1].endpoints.push('U_IC.GND','D_L1.K','D_L2.K','C_X1.2','C_X2.2');
 ir.nets.push({name:'L1',endpoints:['U_IC.L1','R_L1.1']},{name:'L1_A',endpoints:['R_L1.2','D_L1.A']},{name:'L2',endpoints:['U_IC.L2','R_L2.1']},{name:'L2_A',endpoints:['R_L2.2','D_L2.A']},
  {name:'X1',endpoints:['U_IC.X1','Y1.1','C_X1.1']},{name:'X2',endpoints:['U_IC.X2','Y1.2','C_X2.1']},...['A','B','C','D'].map(n=>({name:`P_${n}`,endpoints:[`U_IC.${n}`,`J_${n}.1`]})));
 const model=electricalModel(ir),ctx=schematicSheets(model),sheet=ctx.sheets.find(s=>s.refs.includes('U_IC')),layout=layoutSheet(model,sheet,ctx);
 const at=ref=>layout.symbols.find(s=>s.ref===ref),cols=[...new Set(layout.symbols.map(s=>s.x))].sort((a,b)=>a-b),col=ref=>cols.indexOf(at(ref).x),mid=ref=>at(ref).y+at(ref).h/2;
 for(const [r,d]of [['R_L1','D_L1'],['R_L2','D_L2']]){
  assert.equal(Math.abs(col(d)-col(r)),1,`${d} sits in the column next to ${r}`);
  assert.equal(Math.sign(col(d)-col(r)),Math.sign(col(r)-col('U_IC')),`${d} is on the far side of ${r} from the IC`);
  assert.equal(mid(d),mid(r),`${d} is level with ${r}`);
 }
 assert.equal(new Set(['Y1','C_X1','C_X2'].map(col)).size,1,'crystal and load capacitors share a column');
 assert.equal(Math.abs(col('Y1')-col('U_IC')),1,'the crystal sits beside its IC');
 invariants(model,ctx);
});
test('logic pins strapped to a rail stay on the symbol; supply pins become flags',()=>{
 const ir=board();ir.parts.push({name:'LVL',category:'logic.translator',pins:[pin('VCC',['power'],['input']),pin('GND',['ground'],['input']),pin('OE_N',['digital'],['input']),pin('DIR',['digital'],['input']),pin('A',['digital'],['input']),pin('B',['digital'],['output'])]});
 ir.components.push(component('U_LVL','LVL'));ir.nets[0].endpoints.push('U_LVL.VCC','U_LVL.DIR');ir.nets[1].endpoints.push('U_LVL.GND','U_LVL.OE_N');ir.nets.find(n=>n.name==='OUT').endpoints.push('U_LVL.A');
 const model=electricalModel(ir),ctx=schematicSheets(model),sheet=ctx.sheets.find(s=>s.refs.includes('U_LVL')),layout=layoutSheet(model,sheet,ctx),sym=layout.symbols.find(s=>s.ref==='U_LVL');
 assert.deepEqual(sym.pins.map(p=>p.name).filter(n=>n==='OE_N'||n==='DIR').sort(),['DIR','OE_N'],'strapped logic pins are drawn on the symbol');
 assert.deepEqual(sym.top.map(f=>f.names.join()),['VCC']);assert.deepEqual(sym.bottom.map(f=>f.names.join()),['GND']);
 assert.equal(layout.labels.find(l=>l.pin==='U_LVL.OE_N').tie,'ground');assert.equal(layout.labels.find(l=>l.pin==='U_LVL.DIR').tie,'power');
 invariants(model,ctx);
});
test('wire lanes in a gap are ordered to avoid crossings',()=>{
 // A runs from y 0 (west) to 100 (east), B from 50 (west) to 150 (east): B's lane left of A's crosses nothing.
 const a={lo:0,hi:100,west:[0],east:[100]},b={lo:50,hi:150,west:[50],east:[150]};orderLanes([a,b]);
 assert(b.lane<a.lane,'B takes the left lane');
 // Nets that do not overlap share a lane.
 const c={lo:0,hi:40,west:[0],east:[40]},d={lo:60,hi:90,west:[60],east:[90]};assert.equal(orderLanes([c,d]),1);assert.equal(c.lane,d.lane);
});
test('passive pins that claim power do not make a signal net a rail',()=>{
 const pin=(name,domains,directions)=>({name,profile:{domains,directions},bonds:[]});
 const ir={schema:'copperscript-ir/v0.1',kind:'board',name:'gate',
  parts:[{name:'drv',category:'semiconductor.ic',pins:[pin('Y',['digital'],['output']),pin('VCC',['power'],['input'])]},{name:'res',category:'component.generic',pins:[pin('P1',['analog','power'],['passive']),pin('P2',['analog','power'],['passive'])]},{name:'fet',category:'component.generic',pins:[pin('G',['digital'],['input']),pin('D',['analog','power'],['passive'])]}],
  components:[{ref:'U',part:'drv'},{ref:'R',part:'res',value:{value:'1',unit:'kohm',base_value:'1000'}},{ref:'Q',part:'fet'}],
  nets:[{name:'DRV',endpoints:['U.Y','R.P1']},{name:'GATE',endpoints:['R.P2','Q.G']},{name:'RAIL',endpoints:['U.VCC']}],supplies:[]};
 const m=electricalModel(ir);
 assert.deepEqual(['DRV','GATE','RAIL'].map(n=>netRole(m,n)),['signal','signal','power']);
});

test('two-pin parts get symbols by category, then reference, then pin names',()=>{
  const part=(ref,category,names=['1','2'])=>({ref,partDefinition:{category},pins:names.map((name,i)=>({name,number:String(i+1)}))});
  assert.deepEqual([part('R1','passive.resistor'),part('PWR/C3','passive.capacitor'),part('L1','passive.inductor.power'),part('LED2','optoelectronics.led'),
    part('D_BUCK','component.generic'),part('X','component.generic',['A','K']),part('F_MAIN','component.generic'),part('U1','component.generic'),
    part('D1','protection.esd'),part('Y1','passive.crystal')].map(symbolKind),
    ['resistor','capacitor','inductor','led','diode','diode','fuse',null,'tvs','crystal']);
  assert.equal(symbolKind({...part('R1','passive.resistor'),pins:[{name:'1'},{name:'2'},{name:'3'}]}),null);
  const named=part('D','x',['A','K']),numbered=part('D','x');
  assert.deepEqual([isCathode(named,named.pins[1]),isCathode(named,named.pins[0]),isCathode(numbered,numbered.pins[0])],[true,false,true]);
  // Every glyph spans its box so the pin stubs meet its leads.
  for(const kind of ['resistor','capacitor','inductor','ferrite','diode','tvs','led','fuse','crystal','switch']){const d=glyph(kind,10,20,48,16).map(s=>s.d).join('');assert.match(d,/M10 28/,kind);assert.match(d,/H58|L58 28/,kind);}
});
