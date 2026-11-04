/* Silkscreen text from the scene. KiCad's stroke font is approximated by a sans-serif font sized to the text's
   cap height; the 2D view draws it with the canvas, the 3D view turns the same glyphs into rectangles.
   Layout is in the text's own frame: x along the text, y down, millimetres, origin at the KiCad anchor. */
const CAP=.72; // cap height of Arial and its stand-ins, as a share of the font size
const LINE_PITCH=1.62; // KiCad's interline spacing, as a share of the text height

export const textFont=(t,mmToPx=1)=>`${t.bold||t.thickness_mm>=t.size_mm[1]*.18?'bold ':''}${t.size_mm[1]/CAP*mmToPx}px Arial,Helvetica,sans-serif`;
export const textAlign=t=>t.justify?.includes('left')?'left':t.justify?.includes('right')?'right':'center';

/** Each line's text and baseline y: centred on the anchor by default, or hanging from it (top) or standing on it (bottom). */
export function textLines(t) {
  const lines=String(t.text).split('\n'),h=t.size_mm[1],pitch=h*LINE_PITCH,span=(lines.length-1)*pitch;
  const first=t.justify?.includes('top')?h:t.justify?.includes('bottom')?-span:h/2-span/2;
  return lines.map((text,i)=>({text,baseline:first+i*pitch}));
}

/** The text's frame to board millimetres: width scale, mirror, then the board angle (counterclockwise, y down) like pads. */
export function textTransform(t) {
  const a=(t.rotation_deg||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),sx=(t.mirror?-1:1)*t.size_mm[0]/t.size_mm[1],[px,py]=t.position_mm;
  return ([x,y])=>{x*=sx;return [px+x*c+y*s,py-x*s+y*c];};
}

/** Draws `t` on a 2D context already in board millimetres. */
export function drawText(ctx,t) {
  const [px,py]=t.position_mm;
  ctx.save();ctx.translate(px,py);ctx.rotate(-(t.rotation_deg||0)*Math.PI/180);ctx.scale((t.mirror?-1:1)*t.size_mm[0]/t.size_mm[1],1);
  ctx.font=textFont(t);ctx.textAlign=textAlign(t);ctx.textBaseline='alphabetic';
  for(const line of textLines(t))ctx.fillText(line.text,0,line.baseline);
  ctx.restore();
}

/** The inked area of `t` as rectangles [x0,y0,x1,y1] in its own frame, rasterised at `perMm` pixels per millimetre.
    Runs of ink on each row merge with the identical run on the row below, so straight strokes cost one rectangle. */
export function textRects(t,perMm=14) {
  const lines=textLines(t),font=textFont(t,perMm),pad=4,align=textAlign(t);
  const probe=new OffscreenCanvas(1,1).getContext('2d');probe.font=font;
  const widths=lines.map(l=>probe.measureText(l.text).width),widest=Math.max(1,...widths),size=t.size_mm[1]/CAP*perMm;
  const originX=pad+(align==='left'?0:align==='right'?widest:widest/2),originY=pad+size-lines[0].baseline*perMm;
  const width=Math.ceil(widest+pad*2),height=Math.ceil(originY+lines[lines.length-1].baseline*perMm+size*.35+pad);
  if(width*height>16e6)return [];
  const ctx=new OffscreenCanvas(width,height).getContext('2d',{willReadFrequently:true});
  ctx.font=font;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle='#000';
  for(const line of lines)ctx.fillText(line.text,originX,originY+line.baseline*perMm);
  const ink=ctx.getImageData(0,0,width,height).data,rects=[];let open=new Map();
  const close=run=>rects.push([(run.x0-originX)/perMm,(run.y0-originY)/perMm,(run.x1-originX)/perMm,(run.y1-originY)/perMm]);
  for(let y=0;y<height;y++){
    const next=new Map();
    for(let x=0;x<width;){
      if(ink[(y*width+x)*4+3]<128){x++;continue;}
      const x0=x;while(x<width&&ink[(y*width+x)*4+3]>=128)x++;
      const key=x0*65536+x,run=open.get(key);
      if(run){run.y1=y+1;open.delete(key);next.set(key,run);}else next.set(key,{x0,x1:x,y0:y,y1:y+1});
    }
    for(const run of open.values())close(run);
    open=next;
  }
  for(const run of open.values())close(run);
  return rects;
}
