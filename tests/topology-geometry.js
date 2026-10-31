/* Independent geometric assertions for presentation paths. */
const eps=1e-6;
export function pathQuality(layout,routes){
 const segments=routes.flatMap(r=>r.points.slice(1).map((b,i)=>({a:r.points[i],b,net:r.entity}))),crossings=new Set(),overlaps=[],boxHits=[];
 for(const s of segments){const horizontal=Math.abs(s.a[1]-s.b[1])<eps;for(const n of layout.nodes){const hit=horizontal?s.a[1]>n.y+eps&&s.a[1]<n.y+n.height-eps&&Math.max(s.a[0],s.b[0])>n.x+eps&&Math.min(s.a[0],s.b[0])<n.x+n.width-eps:s.a[0]>n.x+eps&&s.a[0]<n.x+n.width-eps&&Math.max(s.a[1],s.b[1])>n.y+eps&&Math.min(s.a[1],s.b[1])<n.y+n.height-eps;if(hit)boxHits.push({net:s.net,node:n.id});}}
 for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){const a=segments[i],b=segments[j];if(a.net===b.net)continue;const ah=Math.abs(a.a[1]-a.b[1])<eps,bh=Math.abs(b.a[1]-b.b[1])<eps;
   if(ah===bh){const axis=ah?0:1;if(Math.abs(a.a[1-axis]-b.a[1-axis])<eps&&Math.min(Math.max(a.a[axis],a.b[axis]),Math.max(b.a[axis],b.b[axis]))-Math.max(Math.min(a.a[axis],a.b[axis]),Math.min(b.a[axis],b.b[axis]))>eps)overlaps.push([a.net,b.net]);}
   else{const h=ah?a:b,v=ah?b:a,x=v.a[0],y=h.a[1];if(x>=Math.min(h.a[0],h.b[0])-eps&&x<=Math.max(h.a[0],h.b[0])+eps&&y>=Math.min(v.a[1],v.b[1])-eps&&y<=Math.max(v.a[1],v.b[1])+eps)crossings.add(JSON.stringify([[a.net,b.net].sort(),x,y]));}
 }
 return {crossings:crossings.size,overlaps:overlaps.length,boxHits:boxHits.length};
}
