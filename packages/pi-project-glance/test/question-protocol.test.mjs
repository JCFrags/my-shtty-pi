import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateClientFrame, validateSnapshot } from '../dist/protocol/validation.js';
import { ProjectGlanceClient } from '../dist/protocol/client.js';
import { ProjectGlanceRelayRuntime } from '../dist/pi/lifecycle.js';

const question = () => ({ id: 'qst_11111111-1111-4111-8111-111111111111', displayId: 'Q-1', revision: 1, state: 'pending', question: 'Choose a test color', reason: 'Synthetic protocol test', response: {kind:'single',options:[{id:'blue',label:'Blue'},{id:'green',label:'Green'}]} });
const action = () => ({type:'question_answer',questionId:question().id,expectedRevision:1,answer:{optionIds:['blue']}});
const frame = () => ({version:1,type:'action',requestId:'test',actionId:'test-action',sessionKey:'a'.repeat(32),generation:'b'.repeat(32),branchId:'A',baseRevision:1,action:action()});
const snapshot = () => ({protocolVersion:1,sessionKey:'a'.repeat(32),revision:1,generatedAt:new Date().toISOString(),branchId:'A',current:{},feed:[],questions:[question()]});
const waitFor = async (predicate) => { const end=Date.now()+3000; while(!predicate()){ if(Date.now()>end)throw Error('TEST_TIMEOUT'); await new Promise(r=>setTimeout(r,5)); } };

test('question protocol strictly validates bounded shapes and preserves V1', () => {
  assert.deepEqual(validateClientFrame(frame()),frame());
  assert.equal(validateSnapshot(snapshot()).questions.length,1);
  for(const mutate of [f=>f.action.expectedRevision=0,f=>f.action.questionId='other',f=>f.action.extra=true,f=>f.action.answer.optionIds=['blue','blue'],f=>f.action.answer.text='x'.repeat(4097),f=>f.action.answer.text='\x1b[31munsafe',f=>f.action.type='question_authorize']){
    const f=frame();mutate(f);assert.throws(()=>validateClientFrame(f));
  }
  for(const mutate of [s=>s.questions.push(question()),s=>s.questions=Array.from({length:5},question),s=>s.questions[0].state='authorized',s=>s.questions[0].extra=true,s=>s.questions[0].question='\x1bunsafe']){
    const s=snapshot();mutate(s);assert.throws(()=>validateSnapshot(s));
  }
  const old=snapshot();delete old.questions;assert.deepEqual(validateSnapshot(old),old);
  const oldAction=frame();oldAction.action={type:'focus'};assert.deepEqual(validateClientFrame(oldAction),oldAction);
});

test('real authenticated client resolves only after accepted question action, rejects stale and refused actions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'glance-question-protocol-'));
  let current=[question()], applyCount=0, allow=true, release;
  const gate=new Promise(resolve=>release=resolve);
  const ctx={sessionManager:{getSessionId:()=> 'question-protocol-test',getLeafId:()=> 'A',getBranch:()=>[]}};
  const runtime=new ProjectGlanceRelayRuntime({...process.env,XDG_RUNTIME_DIR:root},undefined,()=>{},undefined,{
    questions:()=>current,
    applyAction:async(a)=>{applyCount++;await gate;if(!allow)return false;current=[{...question(),revision:2,state:'submitted',answer:a.answer}];return true;},
  });
  let latest,client;
  try{
    await runtime.ensureForContext(ctx);
    client=new ProjectGlanceClient({descriptorPath:runtime.descriptorPath,onSnapshot:s=>latest=s});client.start();
    await waitFor(()=>latest?.questions?.length===1);
    let resolved=false;
    const pending=client.sendQuestionAction('A',latest.revision,action()).then(()=>resolved=true);
    await waitFor(()=>applyCount===1);assert.equal(resolved,false);
    release();await pending;assert.equal(resolved,true);
    await waitFor(()=>latest.questions[0].revision===2);
    await assert.rejects(client.sendQuestionAction('B',latest.revision,action()),/changed/);
    await assert.rejects(client.sendQuestionAction('A',latest.revision,action()),/changed/);
    allow=false;
    await assert.rejects(client.sendQuestionAction('A',latest.revision,{type:'question_retry',questionId:question().id,expectedRevision:2}),/not accepted/);
    assert.equal(applyCount,2);
    client.stop();await assert.rejects(client.sendQuestionAction('A',latest.revision,action()),/Disconnected/);
  }finally{client?.stop();await runtime.stop();await rm(root,{recursive:true,force:true});}
});
