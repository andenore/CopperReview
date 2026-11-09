/* Connection setup never changes host configuration or launches a model. */
export function connectionSummary(connections=[],synchronized=true){
  const live=connections.filter(c=>c.connected),current=live.filter(c=>c.read_current&&synchronized);
  if(current.length)return {state:'read',label:'Selection read',detail:`${current.map(c=>c.name).join(', ')} read this selection. This confirms context delivery, not that a model has answered.`};
  if(live.length)return {state:'connected',label:'Agent connected',detail:`${live.map(c=>c.name).join(', ')} connected. ${live.some(c=>c.read_at)?'The selection has changed since its last read.':'Ask in your chat to read the selected design.'}`};
  return {state:'offline',label:'Connect agent',detail:connections.length?'The host has stopped responding. Reopen your chat or restart its MCP connection.':'No host connection detected yet.'};
}

export function createAgentSetup({api,downloadExtension,sync,sessionId}){
  const $=id=>document.getElementById(id),dialog=$('agent-setup');
  let config=null;
  const set=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
  function renderConfig(){
    if(!config)return;
    const client=$('agent-setup-client').value,isClaude=client==='claude',isCode=client==='claude-code';
    $('agent-extension-controls').hidden=!isClaude;
    $('agent-manual-fields').hidden=isCode||isClaude;
    $('agent-config-block').hidden=false;
    set('agent-runtime',config.runtime_available?'Using the Python installation that is running this viewer.':'The Python launcher is missing. Restart the viewer from a valid installation.');
    set('agent-setup-instructions',isClaude?'Download the extension and open it with Claude Desktop, or use Settings → Desktop app → Extensions → Advanced settings → Install Extension. Keep the prefilled Python executable. If CopperReview is already configured manually, disable that entry to avoid duplicate connections.':
      isCode?`Run this once in ${config.shell}, then open Claude Code and check /mcp. An existing copper-review entry must be updated instead of added again.`:
      client==='chatgpt'?'In ChatGPT desktop with local Codex support, open Settings → MCP servers → Add server. Name it copper-review, choose STDIO, and enter the command and arguments below. Save and restart the connection. If those settings are absent, use the Codex TOML configuration below with Codex CLI or its IDE extension. This does not configure ChatGPT web.':
      'Add a local STDIO MCP server named copper-review in your host using these command, arguments and environment values.');
    $('agent-command').value=config.config.command;
    $('agent-arguments').value=JSON.stringify(config.config.args);
    $('agent-environment').value=JSON.stringify(config.config.env);
    set('agent-config-label',isCode?'Setup command':client==='chatgpt'?'Alternative: add to your Codex config.toml':'Manual configuration (merge with existing servers)');
    $('agent-config').value=isCode?config.claude_command:client==='chatgpt'?config.codex_toml:config.claude_json;
  }
  async function copy(value){
    try{await navigator.clipboard.writeText(value);set('agent-setup-message','Copied.');}
    catch{set('agent-setup-message','Clipboard access is unavailable. Select and copy the text directly.');}
  }
  $('agent-connect').onclick=async()=>{
    dialog.showModal();set('agent-setup-message','');
    try{config=await api('/setup');renderConfig();}catch(error){set('agent-setup-message',error.message);}
  };
  $('agent-setup-close').onclick=()=>dialog.close();
  $('agent-setup-client').onchange=renderConfig;
  for(const button of dialog.querySelectorAll('[data-copy-field]'))button.onclick=()=>copy($(button.dataset.copyField).value);
  $('agent-extension-download').onclick=async()=>{
    try{await downloadExtension();set('agent-setup-message','Extension downloaded. Open it with Claude Desktop to install.');}
    catch(error){set('agent-setup-message',error.message);}
  };
  $('agent-test').onclick=async()=>{
    $('agent-test').disabled=true;
    try{
      await sync();const test=await api('/connection-test',{session_id:sessionId});
      $('agent-test-prompt').value=test.prompt;$('agent-test-instructions').hidden=false;
      set('agent-test-result','Waiting for a fresh selection read. Copy the test prompt into your connected chat.');
    }catch(error){set('agent-test-result',error.message);}
    finally{$('agent-test').disabled=false;}
  };
  function update(value,state,synchronized){
    const summary=connectionSummary(value.connections||[],synchronized);
    $('agent-connect').dataset.state=summary.state;set('agent-connect',summary.label);$('agent-connect').title=summary.detail;
    const warnings=[...new Set((value.connections||[]).filter(c=>c.connected).flatMap(c=>c.warnings||[]))];
    set('agent-connection-detail',[summary.detail,...warnings].join(' '));
    const names=Object.entries(state.documents).map(([kind,d])=>`${d.name||kind} · ${d.sha256.slice(0,12)}`);
    set('agent-shared-design',names.join(' / ')||'No design open');
    set('agent-shared-selection',state.selection?.kind?`${state.selection.kind}: ${state.selection.id}`:
      [...(state.selection?.components||[]),...(state.selection?.nets||[]),state.selection?.region?'Selected region':''].filter(Boolean).join(', ')||'Whole design');
    set('agent-shared-tab',sessionId);
    const test=value.connection_test||{};
    if(test.status==='passed')set('agent-test-result',`Passed: ${test.host} fetched the selected context from this tab.`);
    else if(test.status==='expired')set('agent-test-result','No fresh read arrived within two minutes. Check the host connection and run the test again.');
    else if(test.status==='selection_changed')set('agent-test-result','The selection changed. Run the test again for the current selection.');
  }
  return {update,unavailable(message){$('agent-connect').dataset.state='offline';set('agent-connect','Connection issue');set('agent-connection-detail',message);}};
}
