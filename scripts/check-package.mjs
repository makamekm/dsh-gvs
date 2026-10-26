import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
if(manifest.name!=='@makame/dsh-gvs'||manifest.private)throw new Error('Wrong public package identity');
for(const target of Object.values(manifest.exports).filter(target=>!target.includes('*')))if(!fs.existsSync(path.resolve(root,target)))throw new Error(`Missing export ${target}`);
for(const directory of ['v3'])for(const name of fs.readdirSync(path.join(root,directory)).filter(name=>name.endsWith('.js'))){const checked=spawnSync(process.execPath,['--check',path.join(root,directory,name)],{encoding:'utf8'});if(checked.status!==0)throw new Error(checked.stderr);}
for(const name of ['package.json','cordis.patch.yml','v3/host.js','v3/client.js']){const source=fs.readFileSync(path.join(root,name),'utf8');if(/npm_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|C:\\\\Users\\\\|@local\/dsh-gvs-local|hostRoot:/.test(source))throw new Error(`Local-only content in ${name}`);}
console.log('Public identity, exports, syntax and portable configuration passed.');
