/* One-click choice chips shared by the PCB and electrical note forms. */
export function chips(options,value,onChange,label){
  const group=document.createElement('div');group.className='chips';group.setAttribute('role','group');if(label)group.setAttribute('aria-label',label);
  const update=v=>{for(const b of group.children)b.setAttribute('aria-pressed',String(b.dataset.value===v));};
  for(const [key,text]of options){const b=document.createElement('button');b.type='button';b.className='chip';b.dataset.value=key;b.textContent=text;b.onclick=()=>{update(key);onChange(key);};group.append(b);}
  update(value);group.update=update;return group;
}
/** Show a <select> as chips. The select stays the source of truth, including programmatic `.value` writes. */
export function chipify(select){
  const property=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
  const group=chips([...select.options].map(o=>[o.value,o.textContent]),select.value,v=>{property.set.call(select,v);select.dispatchEvent(new Event('change',{bubbles:true}));},select.getAttribute('aria-label')||select.closest('label')?.firstChild?.textContent?.trim());
  Object.defineProperty(select,'value',{configurable:true,get(){return property.get.call(select);},set(v){property.set.call(select,v);group.update(property.get.call(select));}});
  select.addEventListener('change',()=>group.update(property.get.call(select)));
  select.hidden=true;select.after(group);return group;
}
