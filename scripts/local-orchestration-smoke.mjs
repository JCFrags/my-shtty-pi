#!/usr/bin/env node
// Private real-Herdr registration check. No model calls or production state.
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const candidate=resolve(process.argv[2]??fileURLToPath(new URL('../',import.meta.url)));
const pkg=join(candidate,'packages/pi-herdr-orchestrator');
const root=await mkdtemp(join(tmpdir(),'pi-real-orchestration-'));
await chmod(root,0o700);
const herdr=process.env.HERDR_BIN_PATH??execFileSync('which',['herdr'],{encoding:'utf8'}).trim();
const env={PATH:`${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_RUNTIME_DIR:join(root,'runtime'),PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_TELEMETRY:'0',HERDR_ENV:'1',HERDR_BIN_PATH:herdr,HERDR_CONFIG_PATH:join(root,'config.toml'),LANG:'C.UTF-8',TERM:'xterm-256color'};
const checks=[];const cleanup=[];let server,serverClosed,linked=false,failure;
async function run(args){try{return await exec(herdr,args,{cwd:root,env,timeout:30000,maxBuffer:2*1024*1024});}catch(e){throw new Error(`Herdr ${args[0]??''} ${args[1]??''} failed (code ${e.code??'unknown'}); diagnostics suppressed`);}}
const h=async(...args)=>JSON.parse((await run(args)).stdout);
const snapshot=async()=>{const result=(await h('api','snapshot')).result;return result.snapshot??result;};
try{
 for(const d of ['home','config','data','state','cache','runtime','agent'])await mkdir(join(root,d),{mode:0o700});
 await writeFile(env.HERDR_CONFIG_PATH,'onboarding = false\n',{mode:0o600});
 await writeFile(join(env.PI_CODING_AGENT_DIR,'settings.json'),'{}\n',{mode:0o600});
 const version=(await run(['--version'])).stdout.trim();
 assert.match(version,/^herdr \d+\.\d+\.\d+/);checks.push(version);
 const manifest=await readFile(join(pkg,'herdr-plugin.toml'),'utf8');
 assert.match(manifest,/^id = "pi\.herdr\.orchestrator"$/m);
 assert(!/^\s*\[\[?(?:startup|pane|panes)(?:\.|\])/m.test(manifest));
 const metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));
 assert.equal(metadata.bin,undefined);
 assert.deepEqual(metadata.pi.extensions,['./dist/extensions/pi-herdr-orchestrator.js']);
 await readFile(join(pkg,metadata.pi.extensions[0]));
 checks.push('built direct-only package; no CLI, startup hook, or managed pane');
 server=spawn(herdr,['--session','direct-orchestration-check','server'],{cwd:root,env,stdio:'ignore'});serverClosed=once(server,'close');
 env.HERDR_SOCKET_PATH=join(env.XDG_CONFIG_HOME,'herdr/sessions/direct-orchestration-check/herdr.sock');
 let ready=false;for(let i=0;i<100;i++){try{assert.deepEqual((await h('plugin','list','--json')).result.plugins,[]);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert(ready,'private server readiness');
 const before=await snapshot();assert.equal(before.panes.length,0);assert.equal(before.agents.length,0);
 checks.push('private real server; empty topology and registrations');
 await h('plugin','link',pkg,'--enabled');linked=true;
 const plugins=(await h('plugin','list','--json')).result.plugins;assert.equal(plugins.length,1);
 assert.equal(plugins[0].plugin_id,'pi.herdr.orchestrator');assert.equal(plugins[0].plugin_root,pkg);assert.equal(plugins[0].enabled,true);
 assert.equal((plugins[0].startup??[]).length,0);assert.equal((plugins[0].panes??[]).length,0);
 const after=await snapshot();assert.equal(after.panes.length,0);assert.equal(after.agents.length,0);
 checks.push('enabled same-ID direct-only plugin creates no processes or panes');
}catch(e){failure=e instanceof assert.AssertionError?`Assertion failed: ${e.message}`:String(e.message??e);}
finally{
 if(linked){try{await h('plugin','unlink','pi.herdr.orchestrator');assert.deepEqual((await h('plugin','list','--json')).result.plugins,[]);cleanup.push('own plugin unlinked; registrations empty');}catch{cleanup.push('plugin unlink failed');failure??='cleanup failed';}}
 if(server){try{if(server.exitCode===null&&server.signalCode===null){try{await run(['server','stop']);}catch{server.kill('SIGTERM');}await Promise.race([serverClosed,new Promise(r=>setTimeout(r,5000))]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await serverClosed;}}cleanup.push('own real Herdr server exited');}catch{cleanup.push('server cleanup failed');failure??='server cleanup failed';}}
 if(!cleanup.some(x=>x.includes('failed'))){await rm(root,{recursive:true,force:true});cleanup.push('own sandbox removed');}
 console.log(JSON.stringify({status:failure?'fail':'pass',checks,cleanup,...(failure?{failure}:{}),realHerdr:true,modelCalls:false,productionMutations:false,limitations:['Registration only. No model-backed child or existing-session activation tested.']},null,2));
 if(failure)process.exitCode=1;
}
