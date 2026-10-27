import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';import {resolveBrowserRuntime,browserCapabilities} from '../v3/browser.js';
async function fixture(t,{binary=true}={}){
 const directory=await fs.mkdtemp(path.join(tmpdir(),'gvs-capabilities-test-')),file=path.join(directory,'index.mjs'),executable=path.join(directory,'fixture-browser');
 t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('gvs-capabilities-test-'));await fs.rm(directory,{recursive:true,force:true});});
 await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'explicit-test-runtime',version:'0.0.0-test',type:'module'}));if(binary)await fs.writeFile(executable,'Fixture file only, never an executable/browser.');
 await fs.writeFile(file,`export let launches=0;const type={executablePath:()=>${JSON.stringify(executable)},launch:async()=>{launches++;throw new Error('Explicit fixture launch failure');}};export {type as chromium,type as firefox,type as webkit};`);return {file,executable,module:await import(pathToFileURL(file).href)};
}
test('browser diagnostics report the actual selected module, version and executable; executable presence alone cannot prove availability',async t=>{
 const f=await fixture(t),config={browserModule:f.file,browserExecutable:f.executable},rows=await browserCapabilities(config);
 assert.equal(rows.length,3);for(const row of rows){assert.equal(row.available,false);assert.match(row.reason,/fixture launch failure/);assert.equal(row.runtime.modulePath,f.file);assert.equal(row.runtime.source,'configured');assert.equal(row.runtime.packageVersion,'0.0.0-test');assert.equal(row.runtime.executablePath,f.executable);}assert.equal(f.module.launches,3);
 await browserCapabilities(config);assert.equal(f.module.launches,3,'Repeated capability discovery reuses a bounded launch probe rather than launching the same failing browser repeatedly.');
});
test('missing engine executables retain actual runtime provenance and never claim a launch',async t=>{
 const f=await fixture(t,{binary:false}),rows=await browserCapabilities({browserModule:f.file});
 for(const row of rows.filter(r=>r.engine!=='chromium')){assert.equal(row.available,false);assert.equal(row.reason,'ENOENT');assert.equal(row.runtime.modulePath,f.file);assert.equal(row.runtime.executablePath,f.executable);assert.equal(row.failure.stage,'stat-executable');assert.equal(row.failure.syscall,'stat');assert.equal(row.failure.path,f.executable);}assert.ok(f.module.launches<=1);
});
test('an invalid configured module reports the real fallback instead of pretending the requested path was used',async()=>{
 const configured=path.resolve('nonexistent-runtime/index.mjs'),resolved=await resolveBrowserRuntime({browserModule:configured});assert.notEqual(resolved.modulePath,configured);assert.equal(resolved.source,'package');assert.equal(typeof resolved.type.launch,'function');await assert.rejects(resolveBrowserRuntime({browserEngine:'unity'}),/actual Playwright engine/);
});
