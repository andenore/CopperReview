import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {electricalModel} from '../copper_review/web/electrical-model.js';
import {powerGraph,busGraph,busProtocol,layoutGraph,routeGraph,routePowerGraph} from '../copper_review/web/topology.js';
import {pathQuality} from './topology-geometry.js';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/electrical-ir.json',import.meta.url)));
test('one power graph keeps a device with main and backup supplies exactly once',()=>{
 const m=electricalModel(fixture()),g=powerGraph(m);assert.equal(g.nodes.filter(n=>n.id==='device:LOAD').length,1);
 assert.deepEqual(g.edges.filter(e=>e.to==='device:LOAD').map(e=>e.entity).sort(),['BACKUP','RAIL']);
 assert.equal(g.nodes.filter(n=>n.id==='device:P/U').length,1);assert(g.edges.some(e=>e.from==='device:P/U'&&e.to==='rail:RAIL'));
 assert.equal(new Set(g.nodes.map(n=>n.id)).size,g.nodes.length);
 const laid=layoutGraph(g);assert.equal(laid.nodes.length,g.nodes.length);for(const n of laid.nodes)for(const key of ['x','y','width','height'])assert(Number.isFinite(n[key]));
});
test('equivalent bus declarations share one signal junction and one box per device',()=>{
 const b=fixture();b.peripheral_selections.push({...b.peripheral_selections[0],name:'ALIAS'});const g=busGraph(electricalModel(b));
 assert.equal(g.nodes.filter(n=>n.device).length,2);const hub=g.nodes.find(n=>!n.device);assert.equal(hub.busIds.length,2);assert.deepEqual(hub.nets,['DATA']);assert.equal(g.edges.length,2);
});
test('independent interfaces between the same two devices remain distinct',()=>{
 const b=fixture(),pin=name=>({name,number:name,profile:{domains:['digital'],directions:['bidirectional']}});b.parts.find(p=>p.name==='host').pins.push(pin('OTHER'));b.parts.find(p=>p.name==='load').pins.push(pin('OTHER'));b.nets.push({name:'OTHER',endpoints:['HOST.OTHER','LOAD.OTHER']});b.peripheral_selections.push({name:'OTHER_UART',component:'HOST',peripheral:'UART2',signals:{TX:{pin:'OTHER'}}});
 const g=busGraph(electricalModel(b));assert.equal(g.nodes.filter(n=>n.device).length,2);assert.equal(g.nodes.filter(n=>!n.device).length,2);
 assert.deepEqual(g.nodes.filter(n=>!n.device).map(n=>n.entity).sort(),['peripheral:LINK','peripheral:OTHER_UART']);
});
test('bus graph retains both translator sides and shares the translator device',()=>{
 const b=fixture(),pin=name=>({name,number:name,profile:{domains:['digital'],directions:['bidirectional']}});
 b.parts.push({name:'translator',category:'interface.level_translator',pins:['A1','A2','B1','B2'].map(pin)});b.components.push({ref:'X',part:'translator',properties:{}});b.parts.find(p=>p.name==='host').pins.push(pin('RX'));b.parts.find(p=>p.name==='load').pins.push(pin('TX'));
 b.nets[0].endpoints=['HOST.TX','X.A1'];b.nets.push({name:'RX',endpoints:['HOST.RX','X.A2']},{name:'REMOTE_RX',endpoints:['X.B1','LOAD.RX']},{name:'REMOTE_TX',endpoints:['X.B2','LOAD.TX']});b.peripheral_selections[0].signals.RX={pin:'RX'};
 const g=busGraph(electricalModel(b));assert.equal(g.nodes.filter(n=>n.device).length,3);assert.equal(g.nodes.filter(n=>n.id==='device:X').length,1);assert.equal(g.nodes.filter(n=>!n.device).length,2);assert.equal(g.edges.filter(e=>e.from==='device:X').length,2);
 assert.deepEqual(g.nodes.filter(n=>!n.device).flatMap(n=>n.nets).sort(),['DATA','REMOTE_RX','REMOTE_TX','RX']);
 const hubs=g.nodes.filter(n=>!n.device);assert.equal(hubs[0].entity,hubs[1].entity);assert.notEqual(hubs[0].id,hubs[1].id);
 const layout=layoutGraph(g),routed=routeGraph(layout);assert.equal(routed.routes.length,g.edges.length);
 assert.equal(new Set(routed.routes.map(r=>r.bundle)).size,2,'translator sides must never share a drawing bundle');
 assert.equal(pathQuality(layout,routed.routes.map(r=>({...r,entity:r.bundle}))).overlaps,0);
});

test('bus types use declared protocol/peripheral metadata and retain unknown identifiers',()=>{
 for(const [type,key,label]of [['std.i2c','i2c','I²C'],['I2C2','i2c','I²C'],['USART1','uart','UART'],['UARTE0','uart','UART'],['LPUART1','uart','UART'],['USB_FS','usb','USB'],['std.spi','spi','SPI'],['QSPI1','spi','SPI'],['CANFD','can','CAN'],['vendor.custom','other','vendor.custom'],['','other','Unspecified']])assert.deepEqual(busProtocol(type),{key,label});
 const b=fixture();b.peripheral_selections[0].name='MISLEADING_I2C_NAME';b.peripheral_selections[0].peripheral='USART4';
 const hub=busGraph(electricalModel(b)).nodes.find(n=>!n.device);assert.equal(hub.label,'MISLEADING_I2C_NAME');assert.equal(hub.protocol.label,'UART');assert.deepEqual(hub.types,['USART4']);
});

test('shared-device bus map keeps logical names and separate physical segments without crossings',()=>{
 const graph=JSON.parse(readFileSync(new URL('./fixtures/bus-interfaces.json',import.meta.url))),layout=layoutGraph(graph),routed=routeGraph(layout);
 assert.equal(new Set(layout.nodes.map(n=>n.id)).size,graph.nodes.length);assert.equal(routed.routes.length,graph.edges.length);
 for(const e of graph.edges)assert(routed.routes.some(r=>r.from===e.from&&r.to===e.to&&r.entity===e.entity&&r.bundle===e.bundle&&JSON.stringify(r.pins)===JSON.stringify(e.pins)));
 assert.deepEqual(pathQuality(layout,routed.routes.map(r=>({...r,entity:r.bundle}))),{crossings:0,overlaps:0,boxHits:0});
 for(const [i,a]of layout.nodes.entries())for(const b of layout.nodes.slice(i+1))assert(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y),`${a.id} overlaps ${b.id}`);
 for(const r of routed.routes)for(let i=1;i<r.points.length;i++)assert(r.points[i][0]===r.points[i-1][0]||r.points[i][1]===r.points[i-1][1]);
 const motion=layout.nodes.find(n=>n.label==='MOTION_BUS');assert.deepEqual(motion.aliases,['MOTION_BUS','MOTION_I2C']);assert.deepEqual(motion.types,['std.i2c','I2C2']);
 assert.deepEqual(routeGraph(layout),routed,'selection and redraw must not move bus connections');
});
test('layout retains cyclic and disconnected devices without duplicate identities or nonfinite coordinates',()=>{
 const nodes=['a','b','c','d'].map(id=>({id,device:true})),edges=[{from:'a',to:'b'},{from:'b',to:'a'},{from:'c',to:'a'}];
 for(const directed of [true,false]){const g=layoutGraph({nodes,edges},{directed});assert.equal(g.nodes.length,4);for(const n of g.nodes)assert(Number.isFinite(n.x)&&Number.isFinite(n.y));assert(Number.isFinite(g.width)&&Number.isFinite(g.height));}
});
test('multiple power domains use clear channels and preserve every source/load edge',()=>{
 const graph=JSON.parse(readFileSync(new URL('./fixtures/power-domains.json',import.meta.url))),layout=layoutGraph(graph),routed=routePowerGraph(layout);
 assert.equal(new Set(layout.nodes.map(n=>n.id)).size,graph.nodes.length);assert.equal(routed.routes.length,graph.edges.length);
 for(const e of graph.edges)assert(routed.routes.some(r=>r.from===e.from&&r.to===e.to&&r.entity===e.entity&&JSON.stringify(r.pins)===JSON.stringify(e.pins)));
 const quality=pathQuality(layout,routed.routes);assert.equal(quality.boxHits,0);assert.equal(quality.overlaps,0);assert(quality.crossings<=1,JSON.stringify(quality));
 for(const r of routed.routes)for(let i=1;i<r.points.length;i++)assert(r.points[i][0]===r.points[i-1][0]||r.points[i][1]===r.points[i-1][1]);
 for(const [i,a]of layout.nodes.entries())for(const b of layout.nodes.slice(i+1))assert(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y),`${a.id} overlaps ${b.id}`);
 assert.deepEqual(routePowerGraph(layout),routed,'presentation paths must not jump on selection or redraw');
});
test('cyclic power dependencies keep all connections and avoid device interiors',()=>{
 const nodes=[{id:'A',device:true},{id:'B',device:true},{id:'R1',device:false},{id:'R2',device:false}];const edges=[['A','R1','one'],['R1','B','one'],['B','R2','two'],['R2','A','two']].map(([from,to,entity])=>({from,to,entity,kind:'net',pins:[]}));
 const layout=layoutGraph({type:'power',nodes,edges}),routed=routePowerGraph(layout);assert.equal(routed.routes.length,4);assert.equal(pathQuality(layout,routed.routes).boxHits,0);assert.equal(pathQuality(layout,routed.routes).overlaps,0);
});
