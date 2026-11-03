import test from 'node:test';
import assert from 'node:assert/strict';
import {findDeclaration,displayPath,githubLink} from '../copper_review/web/source-links.js';
const ir={module_instances:[{ref:'PWR',module:'tracker.PowerTree'}],module_definitions:[{name:'tracker.PowerTree',module_instances:[]}]};
const sources={root:'boards/main/',entry:'board.copper',files:{
  'workspace/board.copper':'board B {\n  component U1: mcu.X;\n  module PWR: tracker.PowerTree;\n  net SDA { U1.SDA; }\n}\n',
  'workspace/src/power.copper':'module Other {\n  component U_CHARGE: x.Y;\n}\nmodule PowerTree {\n  component U_CHARGE: charger.BQ;\n  net BAT { U_CHARGE.BAT; }\n}\n',
  'dependency/github.com/acme/lib/parts/r.copper':'module R { }\n'}};
test('declarations are found in the module that owns the scope, at the right line',()=>{
 assert.deepEqual(['component','U1','net','SDA'].length&&[findDeclaration(sources,ir,'component','U1').line,findDeclaration(sources,ir,'net','SDA').line],[2,4]);
 const charge=findDeclaration(sources,ir,'component','PWR/U_CHARGE');
 // The same name in an earlier module of the file must not win.
 assert.deepEqual([charge.id,charge.line,charge.path],['workspace/src/power.copper',5,'boards/main/src/power.copper']);
 assert.equal(findDeclaration(sources,ir,'net','PWR/BAT').line,6);
 assert.equal(findDeclaration(sources,ir,'component','MISSING'),null);
 assert.equal(findDeclaration(sources,ir,'component','NOPE/U1'),null);
 assert.equal(findDeclaration(null,ir,'component','U1'),null);
});
test('GitHub links point at the pinned commit, for the project and for dependencies',()=>{
 const commit='a'.repeat(40),lib='b'.repeat(40),origin={provider:'github',repository:'https://github.com/acme/board',commit,path:'boards/main/board.copper'};
 assert.equal(githubLink(sources,'workspace/src/power.copper',5,origin),`https://github.com/acme/board/blob/${commit}/boards/main/src/power.copper#L5`);
 assert.equal(githubLink(sources,'dependency/github.com/acme/lib/parts/r.copper',1,origin,[{module:'github.com/acme/lib',repository:'https://github.com/acme/lib',commit:lib}]),`https://github.com/acme/lib/blob/${lib}/parts/r.copper#L1`);
 assert.equal(githubLink(sources,'workspace/board.copper',1,{provider:'local',folder:'x',path:'board.copper'}),null);
 assert.equal(displayPath(sources,'dependency/github.com/acme/lib/parts/r.copper'),'github.com/acme/lib/parts/r.copper');
});
