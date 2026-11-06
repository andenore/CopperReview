// A realistic top-down look at one side of the board: solder mask over raised copper, exposed
// metal pads, white silkscreen, solder paste through the stencil, and lit bodies on fitted parts.
// It is a picture, not a check: mask expansion, paste reduction and body heights are not modelled.
import {drawText} from './silk-text.js';

export const LOOK={mask:'#1d5b3c',maskEdge:'#173f2c',maskCopper:'#2f7a4f',maskShadow:'#123524',opening:'#163322',laminate:'#c9b98a',
  metal:['#f4dc94','#c99d3c'],solder:['#f4f6f7','#a9b0b5'],paste:['#b9bcbe','#85898c'],hole:'#0d0f0e',silk:'#f2f1ea',
  body:['#3b3d40','#16171a'],ceramic:['#c9a46b','#8a6a3c'],shadow:'rgba(0,0,0,.38)',highlight:'rgba(255,255,255,.18)'};

const close=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<0.02;
/**
 * The board's closed outlines from its Edge.Cuts drawings: closed shapes as they are, open runs
 * chained end to end. Returns null when a run does not close, so the caller can fall back.
 */
export function outlineLoops(drawings){
  const loops=[],open=[];
  for(const d of drawings){if(d.layer!=='Edge.Cuts'||d.points.length<2)continue;const pts=d.points.map(p=>[...p]);
    if(pts.length>2&&close(pts[0],pts.at(-1)))loops.push(pts);else open.push(pts);}
  while(open.length){
    let loop=open.shift(),grown=true;
    while(grown&&!close(loop[0],loop.at(-1))){grown=false;
      for(let i=0;i<open.length;i++){const run=open[i];
        if(close(loop.at(-1),run[0]))loop=loop.concat(run.slice(1));
        else if(close(loop.at(-1),run.at(-1)))loop=loop.concat([...run].reverse().slice(1));
        else continue;
        open.splice(i,1);grown=true;break;}}
    if(!close(loop[0],loop.at(-1)))return null;
    loops.push(loop);
  }
  return loops.length?loops:null;
}

const sideCopper=side=>side==='back'?'B.Cu':'F.Cu';
const sidePrefix=side=>side==='back'?'B.':'F.';
/** The sides a pad gets paste on. Scenes from before pads recorded it assume paste on outer SMD pads. */
export function pasteSides(pad){
  if(Array.isArray(pad.paste_layers))return pad.paste_layers.map(l=>l.startsWith('B.')?'back':'front');
  return pad.kind==='smd'?['F.Cu','B.Cu'].filter(l=>pad.layers.includes(l)).map(l=>l==='B.Cu'?'back':'front'):[];
}
export const pasteRecorded=scene=>scene.components.some(c=>c.pads.some(p=>Array.isArray(p.paste_layers)));

/**
 * The body of a fitted part, as a rectangle in the footprint's own frame: the fabrication outline
 * when the footprint has one on its side, else a box over the pad centres.
 */
export function bodyBox(component){
  const a=-(component.rotation_deg||0)*Math.PI/180,[ox,oy]=component.position_mm,c=Math.cos(a),s=Math.sin(a);
  const local=([x,y])=>{const dx=x-ox,dy=y-oy;return [dx*c+dy*s,-dx*s+dy*c];};
  const fab=component.graphics.filter(g=>g.layer===`${sidePrefix(component.side)}Fab`).flatMap(g=>g.points.map(local));
  const angle=component.rotation_deg||0,box=pts=>{const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];};
  if(fab.length>=3){const [x0,y0,x1,y1]=box(fab);return x1-x0<.2||y1-y0<.2?null:{cx:(x0+x1)/2,cy:(y0+y1)/2,w:x1-x0,h:y1-y0,angle};}
  if(!component.pads.length)return null;
  // Without an outline the body sits over the pad centres, inside the pad rows, so the pads show
  // around it as leads and terminations do; a single row gets a body thinner than its pads.
  const [x0,y0,x1,y1]=box(component.pads.map(p=>local(p.position_mm))),small=Math.min(...component.pads.map(p=>Math.min(...p.size_mm)));
  const w=x1-x0>0?(x1-x0)*.8:small*.7,h=y1-y0>0?(y1-y0)*.8:small*.7;
  return w<.2||h<.2?null:{cx:(x0+x1)/2,cy:(y0+y1)/2,w,h,angle};
}

/**
 * Width, height and corner radius of a pad grown by `grow` mm (negative shrinks it), never
 * negative: canvas `roundRect` and `ellipse` throw on a negative radius, which would abort the
 * whole realistic drawing. A shrunk rounded rectangle with a small corner ratio (0.05, say)
 * would otherwise get a negative radius from the paste inset.
 */
export function padOutline(p,grow=0){
  const w=Math.max(0,p.size_mm[0]+grow*2),h=Math.max(0,p.size_mm[1]+grow*2),half=Math.min(w,h)/2;
  const radius=p.shape==='oval'?half:p.shape==='roundrect'?Math.min(half,Math.max(0,Math.min(w,h)*(p.roundrect_ratio??.25)+grow)):0;
  return {w,h,radius};
}

function padShape(ctx,p,grow=0){
  const {w,h,radius}=padOutline(p,grow);ctx.beginPath();
  if(p.shape==='circle')ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);
  else if(p.shape==='oval'||p.shape==='roundrect')ctx.roundRect(-w/2,-h/2,w,h,radius);
  else ctx.rect(-w/2,-h/2,w,h);
}
/** A lit fill: light from the top left, in the shape's own frame. */
function lit(ctx,[light,dark],w,h){const g=ctx.createLinearGradient(-w/2,-h/2,w/2,h/2);g.addColorStop(0,light);g.addColorStop(1,dark);return g;}
function atPad(ctx,p,draw){ctx.save();ctx.translate(...p.position_mm);ctx.rotate(-p.rotation_deg*Math.PI/180);draw();ctx.restore();}

/**
 * Draw one side. `role(ref)` says how assembly sees a part: 'current', 'todo', 'done', 'untracked'
 * or null outside assembly (every part drawn fitted). Parts on the other side are left out; their
 * through-hole pads and drills still show.
 */
export function drawRealistic(ctx,scene,{side='front',zoom=1,trackCopper=[],role=()=>null,outline=null}){
  const copper=sideCopper(side),prefix=sidePrefix(side),px=1/zoom;
  const loops=outline||[[...[[scene.board.bounds_mm[0],scene.board.bounds_mm[1]],[scene.board.bounds_mm[2],scene.board.bounds_mm[1]],[scene.board.bounds_mm[2],scene.board.bounds_mm[3]],[scene.board.bounds_mm[0],scene.board.bounds_mm[3]]]]];
  const board=new Path2D();for(const loop of loops){board.moveTo(...loop[0]);for(const p of loop.slice(1))board.lineTo(...p);board.closePath();}
  ctx.save();ctx.globalAlpha=1;ctx.setLineDash([]);
  // Laminate edge, then the mask over the whole board.
  ctx.lineWidth=Math.max(.25,2*px);ctx.strokeStyle=LOOK.laminate;ctx.stroke(board);
  ctx.fillStyle=LOOK.mask;ctx.fill(board,'evenodd');
  ctx.save();ctx.clip(board,'evenodd');
  // Copper under the mask reads as raised, lighter mask with a soft shadow.
  const underMask=fill=>{
    for(const z of scene.zones)if(['fill','copper'].includes(z.kind)&&z.layers.includes(copper)){ctx.beginPath();ctx.moveTo(...z.points_mm[0]);for(const p of z.points_mm.slice(1))ctx.lineTo(...p);ctx.closePath();fill(()=>ctx.fill('evenodd'));}
    for(const t of trackCopper)if(t.layer===copper)fill(()=>ctx.fill(t.path,'nonzero'));
  };
  ctx.save();ctx.translate(.04,.05);ctx.fillStyle=LOOK.maskShadow;underMask(f=>f());ctx.restore();
  ctx.fillStyle=LOOK.maskCopper;underMask(f=>f());
  // Tented vias: a bump in the mask with the drill showing.
  for(const v of scene.vias){if(!v.layers.includes(copper))continue;ctx.fillStyle=LOOK.maskCopper;ctx.beginPath();ctx.arc(...v.position_mm,v.size_mm/2,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=LOOK.hole;ctx.beginPath();ctx.arc(...v.position_mm,v.drill_mm/2,0,Math.PI*2);ctx.fill();}
  // Silkscreen: board drawings, footprint graphics and text on this side.
  ctx.strokeStyle=LOOK.silk;ctx.fillStyle=LOOK.silk;ctx.lineCap='round';ctx.lineJoin='round';
  const silk=g=>{ctx.lineWidth=Math.max(g.width_mm||.12,.6*px);ctx.beginPath();ctx.moveTo(...g.points[0]);for(const p of g.points.slice(1))ctx.lineTo(...p);if(g.filled){ctx.closePath();ctx.fill();}ctx.stroke();};
  for(const g of scene.drawings)if(g.layer===`${prefix}SilkS`&&g.points.length)silk(g);
  for(const c of scene.components)for(const g of c.graphics)if(g.layer===`${prefix}SilkS`&&g.points.length)silk(g);
  for(const text of scene.texts||[])if(text.layer===`${prefix}SilkS`)drawText(ctx,text);
  // Pads: the mask opening, then bare metal, paste or solder.
  const fitted=[];
  for(const c of scene.components){
    const mine=c.side===side,r=role(c.reference),placed=r===null||r==='done';
    for(const p of c.pads){
      const through=p.drill_mm.length>0;
      if(!(p.layers.includes(copper)||(!p.layers.length&&through&&mine)))continue;
      if(!mine&&!through)continue;
      const paste=pasteSides(p).includes(side);
      atPad(ctx,p,()=>{
        const [w,h]=p.size_mm;
        if(p.layers.length){
          if(!p.mask_layers||p.mask_layers.includes(`${prefix}Mask`)){ctx.fillStyle=LOOK.opening;padShape(ctx,p,.05);ctx.fill();}
          ctx.fillStyle=lit(ctx,placed&&mine&&(paste||through)?LOOK.solder:LOOK.metal,w,h);padShape(ctx,p);ctx.fill();
          if(paste&&!placed&&r!=='untracked'){ctx.fillStyle=lit(ctx,LOOK.paste,w,h);padShape(ctx,p,-Math.min(w,h)*.06);ctx.fill();}
        }
        if(through){ctx.fillStyle=LOOK.hole;ctx.beginPath();ctx.ellipse(0,0,p.drill_mm[0]/2,p.drill_mm[1]/2,0,0,Math.PI*2);ctx.fill();}
      });
    }
    if(mine&&placed&&r!=='untracked')fitted.push(c);
  }
  // Bodies of fitted parts, lit from the top left, with a shadow down and to the right.
  for(const c of fitted){const box=bodyBox(c);if(!box)continue;
    const ceramic=c.pads.length===2&&/^C\d/i.test(c.reference)&&box.w*box.h<12;
    ctx.save();ctx.translate(...c.position_mm);ctx.rotate(-box.angle*Math.PI/180);ctx.translate(box.cx,box.cy);
    const radius=Math.min(box.w,box.h)*.12;
    ctx.save();ctx.rotate(box.angle*Math.PI/180);ctx.translate(.12,.16);ctx.rotate(-box.angle*Math.PI/180);ctx.fillStyle=LOOK.shadow;ctx.beginPath();ctx.roundRect(-box.w/2,-box.h/2,box.w,box.h,radius);ctx.fill();ctx.restore();
    ctx.fillStyle=lit(ctx,ceramic?LOOK.ceramic:LOOK.body,box.w,box.h);ctx.beginPath();ctx.roundRect(-box.w/2,-box.h/2,box.w,box.h,radius);ctx.fill();
    ctx.strokeStyle=LOOK.highlight;ctx.lineWidth=Math.max(.04,px);ctx.stroke();
    ctx.restore();}
  ctx.restore();ctx.restore();
}
