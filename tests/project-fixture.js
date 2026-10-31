import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function projectFixture(){
  const commit='a'.repeat(40),version='b'.repeat(40),module='github.com/url-test/parts';
  const entry='board RemoteProject { use library "tiny"; import local "./src"; module X: local.Wrapper; }';
  const local='module Wrapper { use library "tiny"; import part "github.com/url-test/parts/pkg"; module Inner: part.Unit; }';
  const unit='module Unit { use library "tiny"; import sibling "../support"; module D: sibling.Passive; }\r\n';
  const support='module Passive { use library "tiny"; component R: RESISTOR; }';
  const sources={'pkg/unit.copper':unit,'support/passive.copper':support},files=Object.entries(sources).map(([path,text])=>({path,size:Buffer.byteLength(text),sha256:sha(text)}));
  const checksum='sha256:'+sha(files.map(f=>`${f.path}\0${f.size}\0${f.sha256}\0`).join(''));
  const manifest=`module github.com/url-test/project\nrequire ${module} ${version}\n`,lock=JSON.stringify({schema:'copperscript.package-lock/v1',modules:[{module,version,source:`git:https://${module}.git`,checksum,files}]});
  const workspace={'boards/main/board.copper':entry,'boards/main/src/wrapper.copper':local,'boards/main/copper.mod':manifest,'boards/main/copper.lock':lock};
  const tree=Object.keys(workspace).map(path=>({path,type:'blob',mode:'100644'}));
  const origin={provider:'github',repository:'https://github.com/url-test/project',commit,path:'boards/main/board.copper',url:`https://github.com/url-test/project/blob/${commit}/boards/main/board.copper`};
  const requests=[{id:'workspace/src/wrapper.copper',path:'src/wrapper.copper'},...files.map(f=>({...f,id:`dependency/${module}/${f.path}`,repository:module,revision:version,version,module}))];
  return {commit,version,module,entry,workspace,sources,tree,manifest,lock,origin,requests};
}
