/* The EMI panel: converter cells, their findings, one finding's numbers and assumptions, and the
 * conducted spectrum. DOM only; the data and wording come from emi.js. */
import {EMI_SCREENING_LINE,groupByCell,findingById,findingFacts,findingHeadline,assumptionSentences,assumptionDetails,notModelled,codeText,antiResonances,capacitorBranches,conductedOf,spectrumModel,spectrumSvg,spectrumCaption,frequencyText,n} from './emi.js';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const MAX_ASSUMPTIONS=4;
export function createEmiPanel(els,{onSelect,onCite}){
  let model=null,selected=null,overlays=null;
  const cellLine=c=>[c.topology,c.frequency_hz?frequencyText(c.frequency_hz):null,c.magnetic?`L ${c.magnetic}`:null,c.catch_diode?`D ${c.catch_diode}`:null].filter(Boolean).join(' · ');
  function renderList(){
    els.list.replaceChildren();
    for(const g of groupByCell(model)){
      const head=el('div','emi-cell');head.append(el('strong',null,g.name||'(no cell)'),el('span','quiet',g.cell?cellLine(g.cell):'cell not described in the report'));els.list.append(head);
      for(const f of g.findings){
        const b=el('button','emi-item');b.type='button';b.dataset.id=f.id;b.setAttribute('aria-pressed',String(f.id===selected));
        const dot=el('span',`emi-dot ${f.severity}`);dot.title=f.severity;
        const text=el('span','emi-item-text');text.append(el('span','emi-item-title',`${f.id} · ${codeText(f.code)}`),el('span','emi-item-note',findingHeadline(f,model)));
        b.append(dot,text);b.onclick=e=>onSelect(f.id,{add:e.shiftKey,zoom:true});els.list.append(b);
      }
      if(!g.findings.length)els.list.append(el('p','quiet','No findings.'));
    }
  }
  function table(rows,cls){const t=el('table',cls),body=el('tbody');for(const row of rows){const r=el('tr');for(const [i,c] of row.entries())r.append(el(i?'td':'th',null,c));body.append(r);}t.append(body);return t;}
  function folded(summary,items,render){const d=el('details','emi-folded');d.append(el('summary',null,summary));const ul=el('ul');for(const i of items){const li=el('li');if(render)render(li,i);else li.textContent=i;ul.append(li);}d.append(ul);return d;}
  function renderDetail(){
    els.detail.replaceChildren();
    const f=findingById(model,selected);
    if(!f){els.detail.append(el('p','quiet',model.findings.length?'Choose a finding on the left, or click the loop, a switch-node track or a victim line on the board.':'The report holds no findings.'));return;}
    const head=el('div','emi-detail-head');head.append(el('h3',null,`${f.id} · ${codeText(f.code)}${f.cell?` · ${f.cell}`:''}`));
    const chips=el('span','emi-chips');chips.append(el('span',`emi-sev ${f.severity}`,f.severity),el('span','emi-sev',f.estimate?.kind==='ranking_score'?'ranking only':'screening estimate'));head.append(chips);els.detail.append(head);
    if(f.message)els.detail.append(el('p','emi-message',f.message));
    const rows=findingFacts(f,model);if(rows.length)els.detail.append(table(rows,'emi-facts'));
    if(f.code==='EMI-HOT-LOOP'&&Array.isArray(f.measures.pad_sequence)&&f.measures.pad_sequence.length)els.detail.append(el('p','emi-pads',`Loop pads: ${f.measures.pad_sequence.join(' → ')}`));
    const ov=overlays?.get(f.id);for(const note of ov?.notes||[])els.detail.append(el('p','emi-note',note));
    if(f.nets.length||f.objects.length)els.detail.append(el('p','quiet',`Nets: ${f.nets.join(', ')||'none'} · Parts: ${f.objects.filter(o=>!f.nets.includes(o)).join(', ')||'none'}`));
    const ar=antiResonances(f);
    if(f.code==='EMI-CONDUCTED'&&ar.length)els.detail.append(folded(`Anti-resonances (${ar.length})`,ar,(li,a)=>{li.textContent=a.text||`${frequencyText(a.frequency_hz||0)}${a.impedance_ohm!==null?`, |Z| ${n(a.impedance_ohm*1000)} mohm`:''}${a.rise_db!==null?`, ${n(a.rise_db)} dB over the best single capacitor`:''}${a.significant?' (significant)':''}`;}));
    const caps=capacitorBranches(f);
    if(f.code==='EMI-CONDUCTED'&&caps.length){const d=el('details','emi-folded');d.append(el('summary',null,`Capacitor branches (${caps.length})`));
      d.append(table([['Part','C used','ESR','ESL','Current share'],...caps.map(c=>[`${c.component}${c.role?` (${c.role})`:''}`,c.c_uf!==null?`${n(c.c_uf)} uF`:'-',c.esr_mohm!==null?`${n(c.esr_mohm)} mohm`:'-',c.esl_nh!==null?`${n(c.esl_nh)} nH`:'-',c.share!==null?`${n(c.share*100)} %`:'-'])],'emi-caps'));
      d.append(el('p','quiet','Current share is the branch current over the source current at the worst harmonic, a ratio of magnitudes, not a partition: branches can circulate current between themselves.'));els.detail.append(d);}
    const sentences=assumptionSentences(f.tags);
    const box=el('div','emi-assumptions');box.append(el('h4',null,'Assumptions'));
    const ul=el('ul');for(const s of (sentences.length?sentences:['No assumptions are tagged.']))ul.append(el('li',null,s));box.append(ul);els.detail.append(box);
    const details=assumptionDetails(f);if(details.length)els.detail.append(folded(`Solver assumptions in the report (${details.length})`,details));
    const nm=notModelled(f);if(nm.length)els.detail.append(folded(`Not modelled (${nm.length})`,nm));
    const row=el('div','emi-actions');
    const zoom=el('button',null,'Zoom to it');zoom.type='button';zoom.onclick=()=>onSelect(f.id,{zoom:true});
    const cite=el('button',null,'Cite in layout note');cite.type='button';cite.onclick=()=>onCite(f.id);
    row.append(zoom,cite);els.detail.append(row);
  }
  function renderChart(){
    els.chart.replaceChildren();
    const f=findingById(model,selected),cell=f?f.cell:model.findings[0]?.cell,cond=cell!==undefined?conductedOf(model,cell):null;
    const spec=cond&&spectrumModel(cond,model);
    if(!spec){els.chart.append(el('p','quiet',`No conducted spectrum for ${cell||'this cell'} in the report${model.findings.some(x=>x.code==='EMI-CONDUCTED')?' (its conducted finding lists no harmonics).':' (no EMI-CONDUCTED finding).'}`));return;}
    const cap=spectrumCaption(spec),title=el('h4',null,cap.title),sub=el('p','quiet',cap.subtitle);
    const wrap=el('div','emi-svg');wrap.innerHTML=spectrumSvg(spec);// built from numbers and escaped text only
    const as=assumptionSentences(spec.tags),shown=as.slice(0,MAX_ASSUMPTIONS);
    const list=el('ul','emi-chart-assumptions');for(const s of shown)list.append(el('li',null,s));if(as.length>MAX_ASSUMPTIONS)list.append(el('li',null,`+${as.length-MAX_ASSUMPTIONS} more in the assumptions list`));
    els.chart.append(title,sub,wrap,list);
  }
  function renderHead(){
    els.disclaimer.textContent=EMI_SCREENING_LINE;
    const s=model.source;els.source.textContent=`${s.file||'report'}${s.board_name?` · ${s.board_name}`:''} · ${s.emi_schema||'unknown schema'} · evidence grade ${s.evidence_grade}`;
    els.notes.replaceChildren();for(const note of model.notes)els.notes.append(el('li',null,note));
  }
  function render(){if(!model)return;renderHead();renderList();renderDetail();renderChart();}
  return {
    set(m,o){model=m;overlays=o||null;selected=null;if(m)render();},
    select(id){selected=id;if(!model)return;renderList();renderDetail();renderChart();els.list.querySelector('.emi-item[aria-pressed=true]')?.scrollIntoView?.({block:'nearest'});},
    selected:()=>selected,
  };
}
