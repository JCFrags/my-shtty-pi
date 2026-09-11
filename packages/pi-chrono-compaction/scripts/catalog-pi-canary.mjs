import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pkg=resolve(process.argv[2]);
const cli=resolve(process.argv[3]??join(pkg,'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'));
const base=mkdtempSync('/tmp/chrono-m04-pi-canary-');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const enabled of [false,true]){
 const dir=join(base,String(enabled));mkdirSync(dir,{mode:0o700});
 const agent=join(dir,'agent');mkdirSync(agent,{mode:0o700});
 const file=join(dir,'synthetic.jsonl'),runtime=join(dir,'runtime');
 const usage={input:500,output:500,cacheRead:0,cacheWrite:0,totalTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const lines=[JSON.stringify({type:'session',version:3,id:'00000000-0000-4000-8000-000000000001',timestamp:new Date().toISOString(),cwd:dir})];let parentId=null;
 for(let i=1;i<=160;i++){
  const id=i.toString(16).padStart(8,'0'),role=i%2?'user':'assistant',text=`Synthetic acceptance turn ${i}. `+'bounded acceptance state '.repeat(100);
  const message=role==='user'?{role,content:text,timestamp:Date.now()+i}:{role,content:[{type:'text',text}],api:'chrono-canary-api',provider:'chrono-canary',model:'synthetic',usage,stopReason:'stop',timestamp:Date.now()+i};
  lines.push(JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message}));parentId=id;
 }
 const original=Buffer.from(lines.join('\n')+'\n');writeFileSync(file,original,{mode:0o600});
 const wrapper=join(dir,'extension.mjs');
 writeFileSync(wrapper,`import chrono from ${JSON.stringify(pathToFileURL(join(pkg,'dist/src/pi-extension.js')).href)};
 export default function(pi){
  globalThis.fetch=()=>{throw new Error('canary-network-forbidden')};
  pi.registerProvider('chrono-canary',{baseUrl:'http://127.0.0.1:1',apiKey:'synthetic',api:'chrono-canary-api',models:[{id:'synthetic',name:'Synthetic canary',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4096}],streamSimple(){throw new Error('canary-provider-call-forbidden')}});
  const tools=new Map();const proxy=new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>{tools.set(tool.name,tool);return target.registerTool(tool)};return Reflect.get(target,key)}});
  chrono(proxy,{schedulerDirectory:${JSON.stringify(runtime)}});
  pi.registerCommand('canary-history',{description:'Synthetic bounded history check',handler:async(_args,ctx)=>{const result=await tools.get('history_search').execute('synthetic-call',{query:'Synthetic',limit:2},undefined,undefined,ctx);if(result.isError||!JSON.stringify(result).includes('Synthetic'))throw new Error('canary-history-failed');ctx.ui.notify('CANARY_HISTORY_OK','info')}});
 }
 `,{mode:0o600});
 const env={...process.env,PI_OFFLINE:'1',PI_CODING_AGENT_DIR:agent,PI_CHRONO_CONFIG_PATH:join(dir,'chrono.json'),PI_CHRONO_CATALOG_SHADOW:String(enabled),PI_CHRONO_ISOLATED_WORKER:'true'};
 // Never inherit credentials into this disposable process.
 for(const key of Object.keys(env))if(/API_KEY|TOKEN|PASSWORD|SECRET/.test(key))delete env[key];
 const child=spawn(process.execPath,[cli,'--mode','rpc','--offline','--session',file,'--session-dir',join(dir,'sessions'),'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--extension',wrapper,'--provider','chrono-canary','--model','synthetic'],{cwd:dir,env,stdio:['pipe','pipe','pipe']});
 let buffer='',stderr='',seq=0;const pending=new Map(),notifications=[],errors=[];
 child.stderr.setEncoding('utf8');child.stderr.on('data',s=>stderr=(stderr+s).slice(-4096));
 child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{buffer+=s;assert(buffer.length<2*1024*1024);let nl;while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let e;try{e=JSON.parse(line)}catch{continue}if(e.type==='extension_error')errors.push(e.error);if(e.type==='extension_ui_request'&&e.method==='notify')notifications.push(e.message);if(e.type==='response'&&pending.has(e.id)){pending.get(e.id)(e);pending.delete(e.id)}}});
 const send=(type,extra={})=>new Promise((res,rej)=>{const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);rej(new Error('canary-timeout:'+type+':'+stderr))},45000);pending.set(id,e=>{clearTimeout(timer);e.success?res(e.data):rej(new Error(e.error??'canary-response-failed'))});child.stdin.write(JSON.stringify({id,type,...extra})+'\n')});
 try{
  const commands=await send('get_commands');for(const name of ['chrono-doctor','chrono-worker-status','chrono-catalog-status'])assert(commands.commands.some(c=>c.name===name));
  for(const name of ['chrono-doctor','chrono-worker-status','chrono-catalog-status'])await send('prompt',{message:'/'+name});
  if(enabled){let ready=false;for(let i=0;i<100;i++){await send('prompt',{message:'/chrono-catalog-status'});if(notifications.at(-1)?.includes('ready')){ready=true;break}await sleep(100)}assert(ready,'catalog readiness:'+notifications.at(-1));}
  else{assert(notifications.some(s=>s.includes('disabled')));assert(!existsSync(join(dir,'.chrono-catalog')));}
  await send('prompt',{message:'/canary-history'});assert(notifications.includes('CANARY_HISTORY_OK'));
  const compact=await send('compact',{customInstructions:'Preserve synthetic acceptance and chronological order.'});
  assert(compact.summary?.length);assert.equal(compact.details?.isolatedWorker?.used,true);
  assert(readFileSync(file).subarray(0,original.length).equals(original),'source prefix rewritten');
  assert(!notifications.some(s=>s.includes(dir)||s.includes(pkg)||s.includes('.jsonl')),'status path leak');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({piVersion:JSON.parse(readFileSync(resolve(cli,'../../package.json'),'utf8')).version,catalogEnabled:enabled,loader:true,doctor:true,workerStatus:true,catalogStatus:true,history:true,containedCompaction:true,summaryBytes:Buffer.byteLength(compact.summary),sourcePrefixUnchanged:true,extensionErrors:0,externalProviderCalls:0}));
 }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
}
// Retain task-owned synthetic namespace: no deletion of possibly unconfirmed worker admissions.
