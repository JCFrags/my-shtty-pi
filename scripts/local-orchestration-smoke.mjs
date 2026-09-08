#!/usr/bin/env node
// Private real-Herdr validation; no model calls or production state.
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const candidate=resolve(process.argv[2]??fileURLToPath(new URL('../',import.meta.url)));
const pkg=join(candidate,'packages/pi-herdr-orchestrator');
const {brokerRequest}=await import(pathToFileURL(join(pkg,'dist/src/cli/client.js')));
const {sessionKey}=await import(pathToFileURL(join(pkg,'dist/src/shared/paths.js')));
const root=await mkdtemp(join(tmpdir(),'pi-real-orchestration-'));
await chmod(root,0o700);
const herdr=process.env.HERDR_BIN_PATH??execFileSync('which',['herdr'],{encoding:'utf8'}).trim();
const piCLI=join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent/dist/cli.js');
const env={PATH:`${join(root,'bin')}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_RUNTIME_DIR:join(root,'runtime'),PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_TELEMETRY:'0',HERDR_ENV:'1',HERDR_BIN_PATH:herdr,HERDR_CONFIG_PATH:join(root,'config.toml'),PI_HERDR_ORCH_RUNTIME_ROOT:join(root,'runtime'),PI_HERDR_ORCH_STATE_ROOT:join(root,'state'),PI_HERDR_ORCH_CONFIG_PATH:join(root,'config/broker.json'),PI_BIN_PATH:join(root,'bin/pi'),LANG:'C.UTF-8',TERM:'xterm-256color'};
const checks=[];const cleanup=[];let server,serverClosed,brokerAttempted=false,linked=false,failure;
async function run(file,args){try{return await exec(file,args,{cwd:root,env,timeout:30000,maxBuffer:2*1024*1024});}catch(e){throw new Error(`Command failed: ${file===herdr?'herdr':file===process.execPath?'node':file} ${args[0]??''} ${args[1]??''} (code ${e.code??'unknown'}); diagnostics suppressed`);}}
const h=async(...args)=>JSON.parse((await run(herdr,args)).stdout);
const cli=async(...args)=>(await run(process.execPath,[join(pkg,'bin/pi-herdr-orchestrator'),...args])).stdout.trim();
try{
 for(const d of ['home','config','data','state','cache','runtime','agent','bin'])await mkdir(join(root,d),{mode:0o700});
 await writeFile(env.HERDR_CONFIG_PATH,'onboarding = false\n',{mode:0o600});
 await writeFile(join(env.PI_CODING_AGENT_DIR,'settings.json'),'{}\n',{mode:0o600});
 await writeFile(env.PI_HERDR_ORCH_CONFIG_PATH,'{"version":1}\n',{mode:0o600});
 // Guard wrapper delegates only metadata operations to installed REAL Pi.
 await writeFile(env.PI_BIN_PATH,`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);if(a.length!==1||!['--help','--version','--list-models'].includes(a[0]))process.exit(97);const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(piCLI)},...a],{env:process.env,stdio:'inherit'});process.exit(r.status??98);\n`,{mode:0o700});
 assert.equal((await run(herdr,['--version'])).stdout.trim(),'herdr 0.8.2');checks.push('real Herdr 0.8.2');
 const manifest=await readFile(join(pkg,'herdr-plugin.toml'),'utf8');
 assert.match(manifest,/\[\[startup\]\][\s\S]*command = \["\.\/bin\/pi-herdr-orchestrator", "broker", "startup"\]/);
 assert(!/^\s*\[\[?(?:pane|panes)(?:\.|\])/m.test(manifest));checks.push('candidate manifest retains broker startup and no pane entries');
 server=spawn(herdr,['--session','command6-validation','server'],{cwd:root,env,stdio:'ignore'});serverClosed=once(server,'close');
 env.HERDR_SOCKET_PATH=join(env.XDG_CONFIG_HOME,'herdr/sessions/command6-validation/herdr.sock');
 let ready=false;for(let i=0;i<100;i++){try{assert.deepEqual((await h('plugin','list','--json')).result.plugins,[]);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert(ready,'private server readiness');checks.push('isolated real server startup and empty registrations');
 const schema=await h('api','schema','--json');assert(schema&&typeof schema==='object');
 const snapshotResponse=(await h('api','snapshot')).result;const snapshot=snapshotResponse.snapshot??snapshotResponse;assert(snapshot&&Array.isArray(snapshot.panes));assert.equal(snapshot.panes.length,0);assert.equal(snapshot.agents.length,0);checks.push('real Herdr schema and live empty snapshot');
 assert.equal(JSON.parse(await cli('broker','status')).status,'stopped');
 brokerAttempted=true;await cli('broker','startup');assert.equal(JSON.parse(await cli('broker','status')).status,'running');checks.push('candidate CLI broker startup and running status');
 const doctor=JSON.parse(await cli('doctor','--json'));assert.equal(doctor.ok,true);checks.push('candidate CLI doctor all mandatory checks pass');
 const key=sessionKey(env.HERDR_SOCKET_PATH);const sock=join(root,'runtime',key,'broker.sock');const secret=join(root,'runtime',key,'client.secret');
 const request=(method)=>brokerRequest(sock,secret,method,{},key,{timeoutMs:10000});
 assert.equal((await request('system.status')).status,'healthy');checks.push('authenticated system.status healthy');
 const policy=await request('model.policy.get');assert(policy.policy&&typeof policy.policy==='object');checks.push('authenticated model.policy.get');
 await h('plugin','link',pkg,'--enabled');linked=true;
 const plugins=(await h('plugin','list','--json')).result.plugins;assert.equal(plugins.length,1);
 // Shape is deliberately asserted without printing registration paths/descriptors.
 const linkedPlugin=plugins[0];assert.equal(linkedPlugin.plugin_id,'pi.herdr.orchestrator');assert.equal(linkedPlugin.plugin_root,pkg);assert.equal(linkedPlugin.enabled,true);
 checks.push('isolated enabled candidate plugin link');
 const afterResponse=(await h('api','snapshot')).result;const after=afterResponse.snapshot??afterResponse;assert.equal(after.panes.length,0);assert.equal(after.agents.length,0);
 assert.equal(JSON.parse(await cli('broker','status')).status,'running');assert.equal((await request('system.status')).status,'healthy');checks.push('linked plugin preserves healthy broker and creates no panes or agents');
 const wrong=join(root,'wrong-secret');await writeFile(wrong,'invalid-test-credential',{mode:0o600});
 await assert.rejects(brokerRequest(sock,wrong,'model.policy.get',{},key,{timeoutMs:250}),/failed|timed out|authentication/i);checks.push('invalid authentication rejected');
}catch(e){failure=e instanceof assert.AssertionError?`Assertion failed: ${e.message}`:String(e.message??e);}
finally{
 if(linked){try{await h('plugin','unlink','pi.herdr.orchestrator');assert.deepEqual((await h('plugin','list','--json')).result.plugins,[]);cleanup.push('own plugin unlinked; registrations empty');}catch{cleanup.push('plugin unlink failed');failure??='cleanup failed';}}
 if(brokerAttempted){try{await cli('broker','stop');assert.equal(JSON.parse(await cli('broker','status')).status,'stopped');cleanup.push('own broker stopped and status verified');}catch{cleanup.push('broker stop failed; sandbox retained');failure??='cleanup failed';}}
 if(server){try{if(server.exitCode===null&&server.signalCode===null){try{await run(herdr,['server','stop']);}catch{server.kill('SIGTERM');}await Promise.race([serverClosed,new Promise(r=>setTimeout(r,5000))]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await serverClosed;}}cleanup.push('own real Herdr server exited');}catch{failure??='server cleanup failed';}}
 if(!cleanup.some(x=>x.includes('failed'))){await rm(root,{recursive:true,force:true});await assert.rejects(access(root));cleanup.push('own sandbox removed');}
 console.log(JSON.stringify({status:failure?'fail':'pass',checks,cleanup,...(failure?{failure}:{}),realHerdr:true,syntheticPi:false,piMetadataOnly:true,modelCalls:false,productionMutations:false,limitations:['No model-backed child or live activation tested.','Fresh empty isolated broker state only.']},null,2));
 if(failure)process.exitCode=1;
}
