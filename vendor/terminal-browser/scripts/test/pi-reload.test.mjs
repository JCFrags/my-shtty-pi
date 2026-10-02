import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileHash, inventory, objectHash, writeJson } from "../dist-manifest.mjs";
import { fixture, root } from "./dist-fixture.mjs";

const piRoot=fs.realpathSync(process.env.TERMINAL_BROWSER_PI_ROOT??path.join(root,"pi-extension/node_modules/@earendil-works/pi-coding-agent"));
test("offline prepared Pi full and command-only A -> B -> A retains identity with one menu lifecycle",t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"browser-pi-reload-"));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_RUNTIME_DIR:path.join(home,'runtime'),TERMINAL_BROWSER_APPDATA:path.join(home,'appdata'),TERMINAL_BROWSER_INTEROP_DIR:path.join(home,'interop'),PI_CODING_AGENT_DIR:path.join(home,'agent'),PI_OFFLINE:'1'};
  for(const directory of Object.values(env).filter(value=>value.startsWith(home)))fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const install=path.join(home,'install');fs.mkdirSync(install,{mode:0o700});
  const receipt=path.join(install,'installation.json');fs.writeFileSync(receipt,JSON.stringify({schemaVersion:1,namespace:'terminal-browser-dev-61753e09',paths:{stateHome:env.XDG_STATE_HOME}}),{mode:0o600});
  const artifacts=[];
  for(const revision of ['a','b']){
    const {dir,manifest}=fixture(t);
    execFileSync(path.join(root,'pi-extension/node_modules/.bin/tsc'),['-p',path.join(root,'pi-extension/tsconfig.json'),'--outDir',path.join(dir,'pi-extension/dist')]);
    fs.writeFileSync(path.join(dir,'pi-extension/dist/launch-mode.js'),'export const launchMode = "bundle";\n');
    manifest.identity.source.commit=revision.repeat(40);
    fs.writeFileSync(path.join(dir,'browser/dist/main.js'),revision);
    fs.unlinkSync(path.join(dir,'build-manifest.json'));manifest.files=inventory(dir);manifest.artifactId=objectHash({identity:manifest.identity,files:manifest.files});writeJson(path.join(dir,'build-manifest.json'),manifest);
    const retained=path.join(install,'releases',manifest.artifactId,'terminal-browser');fs.mkdirSync(path.dirname(retained),{recursive:true,mode:0o700});fs.cpSync(dir,retained,{recursive:true});artifacts.push({root:retained,id:manifest.artifactId});
  }
  const program=path.join(home,'loader.mjs');
  fs.writeFileSync(program,`import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {SettingsManager,DefaultResourceLoader,SessionManager,createEventBus} from ${JSON.stringify(path.join(piRoot,'dist/index.js'))};
import {assertPiResources} from ${JSON.stringify(path.join(root,'scripts/test/packaged-pi.mjs'))};
const [a,b]=${JSON.stringify(artifacts)},agent=process.env.PI_CODING_AGENT_DIR;const settings=SettingsManager.create(process.env.HOME,agent);const bus=createEventBus();let observed;bus.on('terminal-browser:loaded',value=>observed=value);
const loader=new DefaultResourceLoader({cwd:process.env.HOME,agentDir:agent,settingsManager:settings,eventBus:bus,noSkills:true,noPromptTemplates:true,noThemes:true,agentsFilesOverride:()=>({agentsFiles:[]})});
const receipts=path.join(process.env.XDG_STATE_HOME,'terminal-browser-dev-61753e09','pi-loaded');const count=()=>fs.existsSync(receipts)?fs.readdirSync(receipts).length:0;const seen=[];
const ctx={cwd:process.env.HOME,hasUI:false,sessionManager:SessionManager.inMemory(process.env.HOME)};
for(const commandOnly of [false,true]){
 const profile=[];
 for(const artifact of [a,b,a]){
  observed=undefined;
  settings.setPackages([{source:path.join(artifact.root,'pi-extension'),extensions:commandOnly?['dist/menu.js']:['+dist/menu.js','+dist/extension.js'],skills:[],prompts:[]}]);
  await settings.flush();await loader.reload();
  const menu=assertPiResources(loader.getExtensions(),3,commandOnly);
  assert.equal(count(),0,'factory must not write a runtime receipt');
  assert.equal(observed,undefined,'factory must not emit a loaded lifecycle');
  for(const handler of menu.handlers.get('session_start')??[])await handler({type:'session_start',reason:'reload'},ctx);
  assert.equal(observed.artifactId,artifact.id);assert.equal(count(),1);
  assert.equal(observed.receiptEntrypoint,'dist/menu.js');
  assert.deepEqual(observed.loadedResources,commandOnly?['dist/menu.js']:['dist/menu.js','dist/extension.js']);
  assert.equal(observed.toolNames.length,commandOnly?0:5);
  assert.match(observed.menuBuild,/^[a-f0-9]{64}$/);assert.match(observed.closureBuild,/^[a-f0-9]{64}$/);
  profile.push(observed);seen.push(observed);
  for(let repeat=0;repeat<2;repeat++)for(const handler of menu.handlers.get('session_shutdown')??[])await handler({type:'session_shutdown',reason:'reload'},ctx);
  assert.equal(count(),0);
 }
 assert.notEqual(profile[0].instanceId,profile[1].instanceId);
 assert.equal(profile[0].instanceId,profile[2].instanceId,'return to cached exact A retains original module identity');
}
assert.equal(seen[0].instanceId,seen[3].instanceId,'profiles use the same cached menu identity');
console.log(JSON.stringify({passed:true,profiles:['full','command-only'],identities:seen.map(value=>value.artifactId)}));`);
  const output=execFileSync(process.execPath,[program],{env,encoding:'utf8',timeout:30000});assert.equal(JSON.parse(output).passed,true);
  const fresh=execFileSync(process.execPath,[program],{env,encoding:'utf8',timeout:30000});assert.equal(JSON.parse(fresh).passed,true);
});
