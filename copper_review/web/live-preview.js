/* One compilation at a time, immutable inputs, and no page reload or build commands. */
export function createLivePreview({request,prepare,apply,isEditing,onStatus=()=>{}}){
  let paused=false,running=false,busy=false,timer,epoch=0,work=null,disk=null;
  const channels={},attempted=new Map(),pending=new Map();
  const status=()=>({paused,...structuredClone(channels)});
  const publish=()=>onStatus(status(),disk);
  function update(kind,state,message=''){channels[kind]={...(channels[kind]||{revision:'',sha256:''}),state,message:String(message).slice(0,3000)};publish();}
  async function poll(){
    if(busy)return;busy=true;const generation=epoch;
    try{
      disk=await request('/api/preview');if(generation!==epoch)return;publish();
      if(!disk.enabled)return;
      for(const kind of ['source','layout']){
        const target=disk[kind];if(!target)continue;
        if(paused){update(kind,'paused','Live preview paused');continue;}
        if(target.state==='error'){update(kind,'error',target.error);continue;}
        if(target.state!=='ready'){update(kind,'waiting','Files are changing; waiting for a stable snapshot');continue;}
        if(channels[kind]?.revision===target.revision&&channels[kind]?.sha256){
          if(channels[kind].state!=='current')update(kind,'current','Up to date');continue;
        }
        if(isEditing()){update(kind,'deferred','Save or cancel your note to update the preview');continue;}
        if(!pending.has(kind)||pending.get(kind).revision!==target.revision){
          if(attempted.get(kind)===target.revision)continue;
          attempted.set(kind,target.revision);
          work=new AbortController();
          update(kind,kind==='source'?'compiling':'waiting',kind==='source'?'Compiling current sources…':'Reading rebuilt board…');
          let snapshotRead=false;
          try{
            const snapshot=await request('/api/preview/snapshot?kind='+kind+'&revision='+encodeURIComponent(target.revision),{signal:work.signal});
            snapshotRead=true;
            const value=await prepare(kind,snapshot.data,{signal:work.signal});
            if(generation!==epoch)return;
            pending.set(kind,{revision:target.revision,value});
          }catch(error){
            if(generation!==epoch)return;
            if(!snapshotRead)attempted.delete(kind);
            update(kind,'error',error.message);continue;
          }finally{work=null;}
        }
        // A compile may finish after a later save. Never display that older result.
        disk=await request('/api/preview');
        if(generation!==epoch)return;
        if(disk[kind]?.state!=='ready'||disk[kind].revision!==target.revision){
          pending.delete(kind);attempted.delete(kind);update(kind,'waiting','Newer files arrived; preparing the latest revision');continue;
        }
        if(isEditing()){update(kind,'deferred','Save or cancel your note to update the preview');continue;}
        try{
          const result=apply(kind,pending.get(kind).value);
          channels[kind]={state:'current',revision:target.revision,sha256:result.sha256,entry:result.entry||'',message:String(result.message||'Up to date').slice(0,3000)};
          pending.delete(kind);publish();
        }catch(error){pending.delete(kind);update(kind,'error',error.message);}
      }
    }catch(error){if(generation!==epoch)return;for(const kind of Object.keys(channels))update(kind,'error',error.message);if(!Object.keys(channels).length)onStatus(status(),{enabled:true,error:error.message});}
    finally{busy=false;}
  }
  async function loop(){await poll();if(running)timer=setTimeout(loop,750);}
  function setPaused(value){paused=value;epoch++;work?.abort(Error('Live preview paused'));pending.clear();attempted.clear();
    for(const kind of Object.keys(channels)){
      // Another file may have been opened while paused. Resume must restore the watched inputs.
      if(!value){channels[kind].revision='';channels[kind].sha256='';}
      update(kind,value?'paused':'waiting',value?'Live preview paused':'Checking current files');
    }
    publish();}
  return {status,poll,setPaused,start(){if(!running){running=true;loop();}},stop(){running=false;clearTimeout(timer);setPaused(true);}};
}
