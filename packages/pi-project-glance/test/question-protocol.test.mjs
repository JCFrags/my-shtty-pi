import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateClientFrame, validateSnapshot } from '../dist/protocol/validation.js';
import { ProjectGlanceClient } from '../dist/protocol/client.js';
import { ProjectGlanceRelayRuntime } from '../dist/pi/lifecycle.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const question = () => ({ id: 'qst_11111111-1111-4111-8111-111111111111', displayId: 'Q-1', revision: 1, state: 'pending', question: 'Choose a test color', reason: 'Synthetic protocol test', response: {kind:'single',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}]} });
const action = () => ({type:'question_answer',questionId:question().id,expectedRevision:1,answer:{optionIds:['blue']}});
const frame = () => ({version:1,type:'action',requestId:'test',actionId:'test-action',sessionKey:'a'.repeat(32),generation:'b'.repeat(32),branchId:'A',baseRevision:1,action:action()});
const attention = () => ({questionId:'qst_22222222-2222-4222-8222-222222222222',displayId:'Q-2',revision:2,state:'delivery_failed',retryAvailable:true,message:'Answer delivery is not confirmed.'});
const snapshot = () => ({protocolVersion:1,sessionKey:'a'.repeat(32),revision:1,generatedAt:new Date().toISOString(),branchId:'A',current:{},feed:[],questions:[question()],questionAttention:[attention()]});
const waitFor = async (predicate) => { const end=Date.now()+3000; while(!predicate()){ if(Date.now()>end)throw Error('TEST_TIMEOUT'); await new Promise(r=>setTimeout(r,5)); } };

test('question protocol strictly validates bounded shapes and preserves V1', () => {
  assert.deepEqual(validateClientFrame(frame()),frame());
  assert.equal(validateSnapshot(snapshot()).questions.length,1);
  assert.deepEqual(validateSnapshot(snapshot()).questionAttention,[attention()]);
  for(const mutate of [f=>f.action.expectedRevision=0,f=>f.action.questionId='other',f=>f.action.extra=true,f=>f.action.answer.optionIds=['blue','blue'],f=>f.action.answer.text='x'.repeat(4097),f=>f.action.answer.text='\x1b[31munsafe',f=>f.action.type='question_authorize']){
    const f=frame();mutate(f);assert.throws(()=>validateClientFrame(f));
  }
  for(const mutate of [s=>s.questions.push(question()),s=>s.questions=Array.from({length:5},question),s=>s.questions[0].state='authorized',s=>s.questions[0].extra=true,s=>s.questions[0].question='\x1bunsafe',s=>s.questionAttention[0].state='pending',s=>s.questionAttention[0].retryAvailable='yes']){
    const s=snapshot();mutate(s);assert.throws(()=>validateSnapshot(s));
  }
  const old=snapshot();delete old.questions;delete old.questionAttention;assert.deepEqual(validateSnapshot(old),old);
  const oldAction=frame();oldAction.action={type:'focus'};assert.deepEqual(validateClientFrame(oldAction),oldAction);
});

test('real authenticated client resolves only after accepted question action, rejects stale and refused actions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'glance-question-protocol-'));
  await mkdir(join(root,'state'),{recursive:true});
  let current=[question()], hidden=[], applyCount=0, allow=true, release;
  const gate=new Promise(resolve=>release=resolve);
  const ctx={sessionManager:SessionManager.create(root,root)};
  const runtime=new ProjectGlanceRelayRuntime({...process.env,XDG_RUNTIME_DIR:root,XDG_STATE_HOME:join(root,'state')},undefined,()=>{},undefined,{
    questions:()=>current,
    hiddenAttention:()=>hidden,
    applyAction:async(a)=>{applyCount++;await gate;if(!allow)return false;current=[];hidden=[{questionId:question().id,displayId:'Q-1',revision:2,state:'delivery_failed',retryAvailable:true,message:'Answer delivery is not confirmed.'}];return true;},
  });
  let latest,client;const clientErrors=[];
  try{
    await runtime.ensureForContext(ctx);
    assert.equal(runtime.started,true);assert.equal(typeof runtime.descriptorPath,'string');
    client=new ProjectGlanceClient({descriptorPath:runtime.descriptorPath,onSnapshot:s=>latest=s,onError:code=>clientErrors.push(code)});client.start();
    await waitFor(()=>latest?.questions?.length===1||clientErrors.length>0);
    assert.deepEqual(clientErrors,[]);
    let resolved=false;
    const pending=client.sendQuestionAction(latest.branchId,latest.revision,action()).then(()=>resolved=true);
    await waitFor(()=>applyCount===1);assert.equal(resolved,false);
    release();await pending;assert.equal(resolved,true);
    await waitFor(()=>latest.questionAttention?.[0]?.revision===2);
    assert.equal(latest.questions?.length??0,0);
    assert.equal(latest.questionAttention[0].retryAvailable,true);
    await assert.rejects(client.sendQuestionAction('synthetic-wrong-branch',latest.revision,action()),/changed/);
    await assert.rejects(client.sendQuestionAction(latest.branchId,latest.revision,action()),/changed/);
    allow=false;
    await assert.rejects(client.sendQuestionAction(latest.branchId,latest.revision,{type:'question_retry',questionId:question().id,expectedRevision:2}),/not accepted/);
    assert.equal(applyCount,2);
    client.stop();await assert.rejects(client.sendQuestionAction(latest.branchId,latest.revision,action()),/Disconnected/);
  }finally{client?.stop();await runtime.stop();await rm(root,{recursive:true,force:true});}
});
