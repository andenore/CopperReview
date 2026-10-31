/* Presentation graphs: one device node per exact IR instance, shared net/bus hubs. */
import {powerTopology,isPassive,quantity} from './electrical-model.js';
const distinct=a=>[...new Set(a)];
const device=(model,ref)=>({id:`device:${ref}`,kind:'component',entity:ref,label:ref,subtitle:model.components.get(ref).part.split('.').pop(),device:true});
// Classify declared types/peripheral identifiers, never guess from signal names.
export function busProtocol(type=''){
  const name=type.split('.').at(-1).toUpperCase();
  for(const [pattern,key,label]of [[/^I2C(?:\d|_|$)/,'i2c','I²C'],[/^(?:LPUART|USART|UART)(?:E?\d|_|$)/,'uart','UART'],[/^USB(?:\d|_|$)/,'usb','USB'],[/^(?:QSPI|OSPI|SPI)(?:\d|_|$)/,'spi','SPI'],[/^CAN(?:FD|\d|_|$)/,'can','CAN'],[/^(?:SWD|JTAG)(?:\d|_|$)/,'debug',name]])if(pattern.test(name))return {key,label};
  return {key:'other',label:type||'Unspecified'};
}
export function powerGraph(model,{showPassives=false}={}){
  const nodes=new Map(),edges=[];
  for(const {rail,sources,receivers,passives}of powerTopology(model,{showPassives})){
    const hub={id:`rail:${rail.net}`,kind:'net',entity:rail.net,label:rail.net,subtitle:distinct(rail.supplies.map(s=>quantity(s.voltage))).join(' / ')||'Voltage unspecified',passives:showPassives?0:passives.length};nodes.set(hub.id,hub);
    for(const [refs,source]of [[sources,true],[receivers,false]])for(const ref of refs){const d=device(model,ref);nodes.set(d.id,d);edges.push({from:source?d.id:hub.id,to:source?hub.id:d.id,kind:'net',entity:rail.net,pins:model.nets.get(rail.net).pins.filter(p=>p.component===ref).map(p=>p.id)});}
  }
  return {nodes:[...nodes.values()],edges,type:'power'};
}
export function busGraph(model,{showPassives=false}={}){
  const nodes=new Map(),groups=new Map();
  const buses=model.buses.filter(b=>b.provenance!=='Net membership');
  for(const b of buses)for(const name of b.pathNets){
    const n=model.nets.get(name),refs=distinct(n.pins.map(p=>p.component)).filter(r=>showPassives||!isPassive(model.components.get(r))).sort();
    if(refs.length<2)continue;
    const key=JSON.stringify([refs,[...b.pathNets].sort()]);if(!groups.has(key))groups.set(key,{refs,nets:new Set(),buses:new Set()});const group=groups.get(key);group.nets.add(name);group.buses.add(b.id);
  }
  const edges=[];
  for(const [key,group]of groups){
    const candidates=[...group.buses].map(id=>model.buses.find(b=>b.id===id));candidates.sort((a,b)=>(a.provenance==='Declared interface'?0:1)-(b.provenance==='Declared interface'?0:1));
    const primary=candidates[0],names=distinct(candidates.map(b=>b.name)),types=distinct(candidates.map(b=>b.type)),protocols=distinct(types.map(t=>busProtocol(t).label)),protocolKeys=distinct(types.map(t=>busProtocol(t).key));
    const protocol={key:protocolKeys.length===1?protocolKeys[0]:'other',label:protocols.join(' / ')};
    const hub={id:`bus:${key}`,kind:'bus',entity:primary.id,label:primary.name,subtitle:`${protocol.label} · ${group.nets.size} signal net${group.nets.size===1?'':'s'}`,protocol,types,aliases:names,nets:[...group.nets],busIds:[...group.buses]};nodes.set(hub.id,hub);
    for(const ref of group.refs){const d=device(model,ref);nodes.set(d.id,d);edges.push({from:d.id,to:hub.id,kind:'bus',entity:primary.id,bundle:hub.id,protocol,pins:hub.nets.flatMap(n=>model.nets.get(n).pins.filter(p=>p.component===ref).map(p=>p.id))});}
  }
  return {nodes:[...nodes.values()],edges,type:'bus',otherSignals:model.buses.filter(b=>b.provenance==='Net membership').length};
}
export function layoutGraph(graph,{directed=true}={}){
  if(graph.type==='power')return layoutPowerGraph(graph);
  if(graph.type==='bus')return layoutBusGraph(graph);
  const nodes=graph.nodes.map(n=>({...n})),byId=new Map(nodes.map(n=>[n.id,n])),neighbors=new Map(nodes.map(n=>[n.id,[]])),out=new Map(nodes.map(n=>[n.id,[]])),indegree=new Map(nodes.map(n=>[n.id,0]));
  for(const e of graph.edges){if(!byId.has(e.from)||!byId.has(e.to))throw Error('Topology edge references a missing node');neighbors.get(e.from).push(e.to);neighbors.get(e.to).push(e.from);out.get(e.from).push(e.to);indegree.set(e.to,indegree.get(e.to)+1);}
  const ranks=new Map();
  if(directed){
    const queue=nodes.filter(n=>indegree.get(n.id)===0).map(n=>n.id);for(const id of queue)ranks.set(id,0);
    for(let i=0;i<queue.length;i++)for(const id of out.get(queue[i])){ranks.set(id,Math.max(ranks.get(id)||0,ranks.get(queue[i])+1));indegree.set(id,indegree.get(id)-1);if(!indegree.get(id))queue.push(id);}
    // Cyclic domains remain in the same figure, with their actual links intact.
    const remaining=nodes.filter(n=>indegree.get(n.id)>0),last=Math.max(0,...ranks.values())+1;for(const n of remaining)ranks.set(n.id,last);
  }else{
    const roots=[...nodes].sort((a,b)=>Number(b.device)-Number(a.device)||neighbors.get(b.id).length-neighbors.get(a.id).length||a.id.localeCompare(b.id));
    for(const root of roots)if(!ranks.has(root.id)){const queue=[root.id];ranks.set(root.id,0);for(let i=0;i<queue.length;i++)for(const id of neighbors.get(queue[i]))if(!ranks.has(id)){ranks.set(id,ranks.get(queue[i])+1);queue.push(id);}}
  }
  const layers=[];for(const n of nodes){const rank=ranks.get(n.id)||0;if(!layers[rank])layers[rank]=[];layers[rank].push(n);}
  const order=new Map();const index=()=>{for(const layer of layers)for(const [i,n]of (layer||[]).entries())order.set(n.id,i);};index();
  for(let pass=0;pass<6;pass++){for(const layer of pass%2?[...layers].reverse():layers){if(!layer)continue;const score=n=>{const ns=neighbors.get(n.id);return ns.length?ns.reduce((s,id)=>s+order.get(id),0)/ns.length:order.get(n.id);};layer.sort((a,b)=>score(a)-score(b)||a.id.localeCompare(b.id));}index();}
  const maxRows=Math.max(1,...Array.from(layers,l=>l?.length||0)),height=maxRows*104+60;
  for(const [rank,layer]of layers.entries()){if(!layer)continue;const start=(height-layer.length*104)/2;for(const [i,n]of layer.entries()){n.x=24+rank*278;n.y=start+i*104;n.width=178;n.height=72;}}
  return {...graph,nodes,width:Math.max(300,layers.length*278-52),height};
}
function layoutBusGraph(graph){
  const hints=new Map(layoutGraph({nodes:graph.nodes,edges:graph.edges},{directed:false}).nodes.map(n=>[n.id,n.y]));
  const byId=new Map(graph.nodes.map(n=>[n.id,n])),neighbors=new Map(graph.nodes.map(n=>[n.id,[]])),children=new Map(graph.nodes.map(n=>[n.id,[]])),parent=new Map();
  for(const e of graph.edges){neighbors.get(e.from).push(e.to);neighbors.get(e.to).push(e.from);}
  const roots=[],seen=new Set();
  for(const n of [...graph.nodes].sort((a,b)=>Number(b.device)-Number(a.device)||neighbors.get(b.id).length-neighbors.get(a.id).length||a.id.localeCompare(b.id))){
    if(seen.has(n.id))continue;roots.push(n.id);seen.add(n.id);const queue=[n.id];
    for(let i=0;i<queue.length;i++)for(const id of neighbors.get(queue[i]))if(!seen.has(id)){seen.add(id);parent.set(id,queue[i]);children.get(queue[i]).push(id);queue.push(id);}
  }
  const heights=new Map(),positions=new Map();
  function height(id){if(heights.has(id))return heights.get(id);const kids=children.get(id);kids.sort((a,b)=>hints.get(a)-hints.get(b)||a.localeCompare(b));const h=Math.max(72,kids.reduce((sum,k)=>sum+height(k),0)+Math.max(0,kids.length-1)*24);heights.set(id,h);return h;}
  function place(id,x,top){const n=byId.get(id),p={...n,x,y:top+(height(id)-72)/2,width:n.device?178:196,height:72};positions.set(id,p);let y=top;for(const child of children.get(id)){place(child,x+p.width+60,y);y+=height(child)+24;}}
  let y=30;for(const root of roots){place(root,24,y);y+=height(root)+48;}
  const nodes=graph.nodes.map(n=>positions.get(n.id));
  return {...graph,nodes,edges:graph.edges.map(e=>({...e,primary:parent.get(e.to)===e.from||parent.get(e.from)===e.to})),width:Math.max(300,...nodes.map(n=>n.x+n.width+60)),height:Math.max(160,...nodes.map(n=>n.y+n.height+60))};
}
function layoutPowerGraph(graph){
  const hints=new Map(layoutGraph({nodes:graph.nodes,edges:graph.edges}).nodes.map(n=>[n.id,n.x])),parent=new Map(),children=new Map(graph.nodes.map(n=>[n.id,[]])),byId=new Map(graph.nodes.map(n=>[n.id,n]));
  // Choose a drawing tree only. Every other electrical connection is retained.
  const score=e=>{const names=e.pins.map(p=>p.slice(p.lastIndexOf('.')+1));const backup=names.length&&names.every(n=>/BCKP|VBKP|BACKUP/i.test(n));const input=names.some(n=>/^IN(?:_\d+)?$|^VIN/.test(n))?4000:names.some(n=>/^VBAT/.test(n))?3000:names.some(n=>/^VDD|^VCC/.test(n))?2000:1000;return (backup?-10000:input)+(hints.get(e.from)||0);};
  for(const n of [...graph.nodes].sort((a,b)=>hints.get(a.id)-hints.get(b.id)||a.id.localeCompare(b.id))){
    const candidates=graph.edges.filter(e=>e.to===n.id).sort((a,b)=>score(b)-score(a)||a.from.localeCompare(b.from));
    for(const e of candidates){let ancestor=e.from,cycle=false;while(ancestor){if(ancestor===n.id){cycle=true;break;}ancestor=parent.get(ancestor);}if(!cycle){parent.set(n.id,e.from);children.get(e.from).push(n.id);break;}}
  }
  const heights=new Map(),positions=new Map();
  function height(id){if(heights.has(id))return heights.get(id);const kids=children.get(id);kids.sort((a,b)=>a.localeCompare(b));const h=Math.max(byId.get(id).device?72:82,kids.reduce((s,k)=>s+height(k),0)+Math.max(0,kids.length-1)*18);heights.set(id,h);return h;}
  function place(id,x,top){const n=byId.get(id),h=n.device?72:82,p={...n,x,y:top+(height(id)-h)/2,width:n.device?178:120,height:h};positions.set(id,p);let y=top;for(const child of children.get(id)){place(child,x+p.width+(n.device?30:42),y);y+=height(child)+18;}}
  const roots=graph.nodes.filter(n=>!parent.has(n.id)).sort((a,b)=>height(b.id)-height(a.id)||a.id.localeCompare(b.id));let y=30;
  for(const root of roots){place(root.id,24,y);y+=height(root.id)+40;}
  // Put secondary input sources beside their receiving circuit, not below the entire tree.
  for(const root of roots.slice(1)){
    const subtree=new Set();function collect(id){subtree.add(id);children.get(id).forEach(collect);}collect(root.id);
    const links=graph.edges.filter(e=>subtree.has(e.from)&&!subtree.has(e.to));if(!links.length)continue;
    const link=links[0],a=positions.get(link.from),b=positions.get(link.to),base=b.y+b.height/2-a.y-a.height/2;
    for(const offset of [0,110,-110,220,-220,330,-330]){const delta=base+offset;const collision=[...subtree].some(id=>{const p=positions.get(id);return [...positions.values()].some(q=>!subtree.has(q.id)&&p.x<q.x+q.width+16&&p.x+p.width+16>q.x&&p.y+delta<q.y+q.height+16&&p.y+delta+p.height+16>q.y);});if(!collision){for(const id of subtree)positions.get(id).y+=delta;break;}}
  }
  const nodes=graph.nodes.map(n=>positions.get(n.id)),shift=Math.max(0,30-Math.min(...nodes.map(n=>n.y)));for(const n of nodes)n.y+=shift;
  return {...graph,nodes,edges:graph.edges.map(e=>({...e,primary:parent.get(e.to)===e.from})),width:Math.max(300,...nodes.map(n=>n.x+n.width+60)),height:Math.max(160,...nodes.map(n=>n.y+n.height+60))};
}

/** Orthogonal diagram paths, unrelated to PCB routing. Boxes are obstacles;
 * Only the same physical net/bus segment may share a trunk. Translator sides
 * may select the same interface but must use different bundles. */
export function routeGraph(layout,{crossingPenalty=6000}={}){
  const nodes=new Map(layout.nodes.map(n=>[n.id,n])),ports=new Map(layout.nodes.map(n=>[n.id,{left:[],right:[]}])) ,ends=[];
  for(const [index,e]of layout.edges.entries()){const a=nodes.get(e.from),b=nodes.get(e.to),sides=a.x===b.x?['right','right']:a.x<b.x?['right','left']:['left','right'];const pair=[{node:a,side:sides[0],other:b,index},{node:b,side:sides[1],other:a,index}];ends.push(pair);for(const end of pair)ports.get(end.node.id)[end.side].push(end);}
  for(const sides of ports.values())for(const list of Object.values(sides)){list.sort((a,b)=>a.other.y-b.other.y||a.other.id.localeCompare(b.other.id));for(const [i,p]of list.entries()){p.y=p.node.y+(p.node.device?(i+1)*p.node.height/(list.length+1):p.node.height/2);p.x=p.node.x+(p.side==='right'?p.node.width:0);p.stub=p.x+(p.side==='right'?12:-12);}}
  const xs=[12,layout.width-12],ys=[12,layout.height-12];for(const n of layout.nodes){xs.push(n.x-12,n.x+n.width+12);ys.push(n.y-12,n.y+n.height+12);}for(const pair of ends)for(const p of pair){xs.push(p.stub);ys.push(p.y);}
  if(layout.type==='bus'){
    // Reserve enough parallel channels for the busiest device's fan-out.
    const columns=[...new Set(layout.nodes.map(n=>n.x))].sort((a,b)=>a-b),lanes=Math.max(2,...layout.nodes.map(n=>ports.get(n.id).left.length+ports.get(n.id).right.length));
    for(let i=1;i<columns.length;i++){const left=Math.max(...layout.nodes.filter(n=>n.x===columns[i-1]).map(n=>n.x+n.width))+12,right=columns[i]-12;for(let j=1;j<lanes;j++)xs.push(left+(right-left)*j/lanes);}
    for(const sides of ports.values())for(const [side,list]of Object.entries(sides))for(const [i,p]of list.entries())if(p.node.device&&list.length>1){
      const column=columns.indexOf(p.node.x),next=columns[column+(side==='right'?1:-1)];if(next===undefined)continue;
      const far=side==='right'?next-12:Math.max(...layout.nodes.filter(n=>n.x===next).map(n=>n.x+n.width))+12;
      const lane=p.other.y+p.other.height/2<p.y?i:list.length-1-i;
      p.preferred=p.stub+(far-p.stub)*lane/Math.ceil(list.length/2);xs.push(p.preferred);
    }
  }
  const sorted=a=>[...new Set(a)].sort((a,b)=>a-b),xx=sorted(xs),yy=sorted(ys),nx=xx.length,count=nx*yy.length,xi=new Map(xx.map((v,i)=>[v,i])),yi=new Map(yy.map((v,i)=>[v,i]));
  const point=id=>[xx[id%nx],yy[Math.floor(id/nx)]],cell=p=>yi.get(p.y)*nx+xi.get(p.stub),blocked=new Uint8Array(count),obstacles=layout.nodes.map(n=>[n.x-6,n.y-6,n.x+n.width+6,n.y+n.height+6]);
  for(let id=0;id<count;id++){const [x,y]=point(id);blocked[id]=Number(obstacles.some(b=>x>b[0]&&x<b[2]&&y>b[1]&&y<b[3]));}
  const neighborCache=new Map(),edgeKey=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`,occupied=new Map(),horizontal=new Map(),vertical=new Map(),directions=new Map();
  function neighbors(id){if(neighborCache.has(id))return neighborCache.get(id);const col=id%nx,row=Math.floor(id/nx),a=point(id),result=[];for(const next of [col? id-1:-1,col<nx-1?id+1:-1,row?id-nx:-1,row<yy.length-1?id+nx:-1]){if(next<0||blocked[next])continue;const b=point(next),axis=a[1]===b[1]?0:1;const hit=obstacles.some(o=>axis===0?a[1]>o[1]&&a[1]<o[3]&&Math.max(a[0],b[0])>o[0]&&Math.min(a[0],b[0])<o[2]:a[0]>o[0]&&a[0]<o[2]&&Math.max(a[1],b[1])>o[1]&&Math.min(a[1],b[1])<o[3]);if(!hit)result.push({id:next,axis,length:Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]),key:edgeKey(id,next)});}neighborCache.set(id,result);return result;}
  class Heap{items=[];push(item){const a=this.items;let i=a.length;a.push(item);while(i){const p=(i-1)>>1;if(a[p].f<=item.f)break;a[i]=a[p];i=p;}a[i]=item;}pop(){const a=this.items,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].f<a[c].f)c++;if(a[c].f>=last.f)break;a[i]=a[c];i=c;}a[i]=last;}return first;}}
  const different=(set,net)=>set&&[...set].some(n=>n!==net);
  function path(start,end,net,preferred){const distance=new Float64Array(count*2);distance.fill(Infinity);const previous=new Int32Array(count*2);previous.fill(-1);const heap=new Heap(),target=point(end),estimate=id=>{const p=point(id);return .25*(Math.abs(p[0]-target[0])+Math.abs(p[1]-target[1]));};distance[start*2]=0;heap.push({state:start*2,g:0,f:estimate(start)});let finish=-1;
    while(heap.items.length){const item=heap.pop();if(item.g!==distance[item.state])continue;const id=Math.floor(item.state/2),axis=item.state%2;if(id===end){finish=item.state;break;}for(const step of neighbors(id)){const used=occupied.get(step.key);if(different(used,net))continue;const perpendicular=step.axis===0?vertical:horizontal;const crossing=(different(perpendicular.get(id),net)?1:0)+(different(perpendicular.get(step.id),net)?1:0);const laneCost=step.axis===1&&preferred!==undefined?step.length*.002*Math.abs(point(id)[0]-preferred):0;const cost=item.g+step.length*(used?.has(net)?.25:1)+(axis!==step.axis?24:0)+crossing*crossingPenalty+laneCost+(layout.type==='bus'&&step.id===end&&step.axis!==0?24:0);const next=step.id*2+step.axis;if(cost<distance[next]){distance[next]=cost;previous[next]=item.state;heap.push({state:next,g:cost,f:cost+estimate(step.id)});}}}
    if(finish<0)throw Error('Could not draw a connection without crossing a device box. See Connections.');const cells=[];for(let s=finish;s!==-1;s=previous[s])cells.push(Math.floor(s/2));return cells.reverse();
  }
  function add(map,key,net){if(!map.has(key))map.set(key,new Set());map.get(key).add(net);}
  function direction(net,id,bit){if(!directions.has(net))directions.set(net,new Map());const map=directions.get(net);map.set(id,(map.get(id)||0)|bit);}
  const channel=e=>e.bundle||e.entity;
  const routes=[],order=layout.edges.map((e,index)=>({e,index})).sort((a,b)=>Number(!!b.e.primary)-Number(!!a.e.primary)||nodes.get(a.e.from).x-nodes.get(b.e.from).x||channel(a.e).localeCompare(channel(b.e))||nodes.get(a.e.to).y-nodes.get(b.e.to).y);
  for(const {e,index}of order){const [a,b]=ends[index],net=channel(e),cells=path(cell(a),cell(b),net,a.preferred??b.preferred);for(let i=1;i<cells.length;i++){const p=cells[i-1],q=cells[i],pa=point(p),pb=point(q),axis=pa[1]===pb[1]?0:1;add(occupied,edgeKey(p,q),net);add(axis===0?horizontal:vertical,p,net);add(axis===0?horizontal:vertical,q,net);const bit=axis===0?(pb[0]>pa[0]?8:4):(pb[1]>pa[1]?2:1);direction(net,p,bit);direction(net,q,bit===8?4:bit===4?8:bit===2?1:2);}
    const all=[[a.x,a.y],...cells.map(point),[b.x,b.y]],points=[];for(const p of all){if(points.length&&p[0]===points.at(-1)[0]&&p[1]===points.at(-1)[1])continue;while(points.length>1){const x=points.at(-2),y=points.at(-1);if(x[0]===y[0]&&y[0]===p[0]||x[1]===y[1]&&y[1]===p[1])points.pop();else break;}points.push(p);}routes.push({...e,points});
  }
  const junctions=[];for(const [bundle,map]of directions)for(const [id,bits]of map){if(bits.toString(2).replaceAll('0','').length>=3)junctions.push({entity:layout.edges.find(e=>channel(e)===bundle).entity,bundle,point:point(id)});}
  return {routes,junctions};
}
export const routePowerGraph=routeGraph;
