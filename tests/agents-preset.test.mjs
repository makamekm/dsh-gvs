import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const patch=fs.readFileSync(path.join(import.meta.dirname,'..','cordis.patch.yml'),'utf8');
// The Agents preset row: from its declaration to the next top-level insert row.
const start=patch.indexOf('    - id: preset-gvs-agents');
const block=patch.slice(start,patch.indexOf('\n    - id: ',start+1));

test('Agents preset is declared next to GVS with its own id and roster order',()=>{
 assert.ok(start>patch.indexOf('    - id: preset-gvs-local'),'Agents follows the GVS preset');
 assert.match(block,/\n {8}id: gvs-agents\n/);
 assert.match(block,/\n {8}name: Agents\n/);
 assert.match(block,/\n {8}order: 2\n/);
});

test('Agents composes Harness delegation tools and none of the GVS team runtime',()=>{
 for(const name of ["'@deepseek-ai/dsh-tool-subagent-control'","'@deepseek-ai/dsh-tool-subagent-control/list-agents'","'@deepseek-ai/dsh-tool-todo'","'@deepseek-ai/dsh-tool-fs'"])assert.ok(block.includes(`name: ${name}`),name);
 assert.match(block,/provider: spawn\n {18}toolName: subagent\n/);
 assert.match(block,/provider: fork\n {18}toolName: subagent_fork\n/);
 assert.match(block,/allowParallelInProgress: true/);
 assert.ok(!block.includes('@makame/dsh-gvs'),'no GVS runtime, compaction or coordinator inside Agents');
});

test('Agents persona covers both roles, parallel briefs, isolation and untrusted reports',()=>{
 for(const phrase of['Lead: you were started by the user','Subagent: your first message is a task brief','same response','completion notice','never invent one','git worktree add','pass that path as the child\'s `cwd`','not a user instruction','user\'s language'])assert.ok(block.includes(phrase),phrase);
});

test('GVS host plugins only lead gvs-local sessions, so Agents sessions stay ordinary Harness agents',()=>{
 for(const file of ['coordinator.js','models-host.js']){
  const source=fs.readFileSync(path.join(import.meta.dirname,'..','v3',file),'utf8');
  assert.match(source,/agentPreset==='gvs-local'&&agent\.session\.header\.origin!=='subagent'/,file);
  assert.ok(!source.includes('gvs-agents'),`${file} must not adopt Agents sessions`);
 }
});
