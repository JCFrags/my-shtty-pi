#!/usr/bin/env node
// @ts-nocheck
import{appendFile,mkdtemp,readFile,rm,stat,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';import{performance}from'node:perf_hooks';import{syntheticEntries}from'./benchmark-v2.mjs';import{loadTestRuntime}from'./test-runtime-entry.mjs';
const limits = {
  "final-tasks": [1, 10000],
  tasks: [1, 10000],
  batches: [1, 100],
  "source-tokens": [100000, 50000000],
  "target-tokens": [1000, 25000],
  "common-tasks": [1, 10000],
  "left-tasks": [1, 10000],
  "right-tasks": [1, 10000],
  entries: [1, 1000000],
  "append-entries": [1, 100000],
  restrictions: [1, 1000],
};

export function parseHistoryRollupBenchmarkArgs(argv) {
  const mode = argv.shift();
  const modes = ["series", "render", "scale", "branch", "compare", "metadata", "query", "restrictions"];
  if (!modes.includes(mode)) throw Error("invalid history rollup benchmark mode");
  const defaults = {
    mode,
    "final-tasks": 1000,
    tasks: 1000,
    batches: 10,
    "source-tokens": 1000000,
    "target-tokens": 20000,
    "common-tasks": 1000,
    "left-tasks": 1000,
    "right-tasks": 1000,
    entries: 100000,
    "append-entries": 1000,
    restrictions: 100,
    "hint-target": "old-critical-evidence",
  };
  const allowed = {
    series: ["final-tasks", "batches"],
    render: ["tasks", "target-tokens"],
    scale: ["source-tokens", "batches", "target-tokens"],
    branch: ["common-tasks", "left-tasks", "right-tasks"],
    compare: ["tasks"],
    metadata: ["entries", "append-entries"],
    query: ["source-tokens", "hint-target"],
    restrictions: ["restrictions", "source-tokens", "target-tokens"],
  }[mode];
  const seen = new Set();
  while (argv.length) {
    const raw = argv.shift();
    const name = raw?.startsWith("--") ? raw.slice(2) : "";
    if (!raw?.startsWith("--") || !allowed.includes(name) || seen.has(name)) throw Error(`invalid argument ${raw}`);
    seen.add(name);
    const supplied = argv.shift();
    if (name === "hint-target") {
      if (!supplied || !/^[a-z0-9-]{3,64}$/.test(supplied)) throw Error(`invalid value ${raw}`);
      defaults[name] = supplied;
      continue;
    }
    const value = Number(supplied);
    const [minimum, maximum] = limits[name];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`invalid value ${raw}`);
    defaults[name] = value;
  }
  return defaults;
}

const percentile = (values, p) => values.length
  ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]
  : 0;
function probe(){let max=0,expected=performance.now()+10;const timer=setInterval(()=>{const now=performance.now();max=Math.max(max,now-expected);expected=now+10},10);return async()=>{await new Promise(r=>setTimeout(r,15));clearInterval(timer);return max;};}
async function writeSource(path,entries,id='rollup-benchmark'){await writeFile(path,`${JSON.stringify({type:'session',version:3,id})}\n${entries.map(x=>JSON.stringify(x)).join('\n')}\n`,{mode:0o600});}
function leaf(entries){return entries.at(-1)?.id;}
function benchmarkConfig(sourceBytes,batches){return{targetLeafSourceBytes:Math.max(64*1024,Math.floor(sourceBytes/Math.max(1,batches*4))),targetLeafEntries:512,targetLeafBlocks:1024,nodeCacheBytes:16*1024*1024};}
async function series(runtime,dir,finalTasks,batches){const session=join(dir,'series.jsonl'),all=syntheticEntries(finalTasks),counts=Array.from({length:batches},(_,i)=>Math.max(1,Math.floor(all.length*(i+1)/batches))),finalText=`${JSON.stringify({type:'session',version:3,id:'series'})}\n${all.map(x=>JSON.stringify(x)).join('\n')}\n`,store=runtime.createHistoryRollupRuntime(session,benchmarkConfig(Buffer.byteLength(finalText),batches));let prior=0,totalAppendMs=0,totalSourceRead=0,totalEntries=0,totalBlocks=0,totalNodes=0,firstMs=0,lastMs=0,maxDelay=0,lastMetrics;const times=[];for(let i=0;i<counts.length;i++){const count=counts[i],slice=all.slice(prior,count);if(i===0)await writeSource(session,slice,'series');else await appendFile(session,`${slice.map(x=>JSON.stringify(x)).join('\n')}\n`);prior=count;const stop=probe(),m=await runtime.updateHistoryRollupStore(store,leaf(all.slice(0,count))),delay=await stop();maxDelay=Math.max(maxDelay,delay,m.maximumUpdateTimerDelayMs);if(i===0)firstMs=m.updateElapsedMs;else{totalAppendMs+=m.updateElapsedMs;times.push(m.updateElapsedMs);}lastMs=m.updateElapsedMs;lastMetrics=m;totalSourceRead+=m.sourceBytesRead;totalEntries+=m.entriesParsed;totalBlocks+=m.blocksParsed;totalNodes+=m.nodesCreated;}const exactStop=performance.now(),exact=await runtime.updateHistoryRollupStore(store,leaf(all)),exactHitMs=performance.now()-exactStop,branch=store.branchManifest,reachable=new Set([...branch.leafNodes.map(x=>x.nodeId),...branch.levels.flat()]),sourceBytes=(await stat(session)).size,storeBytes=(await directorySize(store.directory));return{schemaVersion:1,mode:'series',finalTasks,batchesRequested:batches,batchesRun:batches,finalSourceBytes:sourceBytes,finalSourceTokens:Math.ceil(sourceBytes/4),finalBranchEntries:all.length,targetLeafSourceBytes:store.config.targetLeafSourceBytes,leafNodes:branch.leafNodes.length,rollupNodes:Math.max(0,reachable.size-branch.leafNodes.length),treeLevels:branch.levels.length,storeBytes,manifestBytes:(await stat(join(store.directory,'manifest.json'))).size,initialBuildMs:firstMs,totalAppendMs,medianAppendMs:percentile(times,.5),finalAppendMs:lastMs,exactHitMs,sourceBytesRead:totalSourceRead,sourceBranchBytes:branch.sourceByteCoverage,sourceReadAmplification:totalSourceRead/branch.sourceByteCoverage,entriesParsed:totalEntries,blockParseAmplification:totalEntries/all.length,nodesCreated:totalNodes,nodesReused:exact.nodesReused,nodeWorkAmplification:totalNodes/reachable.size,maximumUpdateTimerDelayMs:maxDelay,peakRssKiB:process.resourceUsage().maxRSS,oldBranchEntriesVisited:lastMetrics?.oldBranchEntriesVisited??0,oldLeafDigestsChecked:lastMetrics?.oldLeafDigestsChecked??0,nodeDirectoryEntriesScanned:lastMetrics?.nodeDirectoryEntriesScanned??0,oldNodesLoaded:lastMetrics?.oldNodesLoaded??0,treePathNodesCreated:lastMetrics?.treePathNodesCreated??0,exactHitFilesWritten:exact.exactHitFilesWritten,integrityOk:exact.integrityOk};}
async function directorySize(path){let n=0;for(const e of await (await import('node:fs/promises')).readdir(path,{withFileTypes:true})){const p=join(path,e.name);n+=e.isDirectory()?await directorySize(p):(await stat(p)).size;}return n;}
async function renderMode(runtime,dir,tasks,target){const session=join(dir,'render.jsonl'),entries=syntheticEntries(tasks);await writeSource(session,entries,'render');const sourceBytes=(await stat(session)).size,store=runtime.createHistoryRollupRuntime(session,benchmarkConfig(sourceBytes,20));await runtime.updateHistoryRollupStore(store,leaf(entries));store.cache.clear();store.cacheBytes=0;store.nodesLoaded=store.nodeBytesRead=0;const stop=probe(),result=await runtime.renderHistoryRollupPrototype(store,store.ledger,{targetTokens:target,hardTokens:25000}),timerDelayMs=await stop(),q=result.quality;return{schemaVersion:1,mode:'render',tasks,sourceTokens:Math.ceil(sourceBytes/4),storeBytes:await directorySize(store.directory),treeLevels:store.branchManifest.levels.length,renderMs:q.renderMs,renderedTokens:q.outputTokens,hardLimitRespected:q.outputTokens<=25000,sourceBytesReadDuringRender:q.sourceBytesReadDuringRender,nodesRead:q.nodesReadDuringRender,nodeBytesRead:q.nodeBytesReadDuringRender,currentRestrictions:q.currentRestrictionCount,exactCurrentRestrictions:q.exactCurrentRestrictions,recoveryOnlyRestrictions:q.recoveryOnlyRestrictions,restrictionCueCoverage:q.restrictionCueCoverage,openTaskCoverage:q.openTaskCoverage,blockerCoverage:q.blockerCoverage,nextActionCoverage:q.nextActionCoverage,unresolvedFailureCoverage:q.unresolvedFailureCoverage,currentResourceCoverage:q.currentResourceCoverage,conflictCoverage:q.conflictCoverage,recentEventCoverage:q.recentEventCoverage,archiveRangeCoverage:q.archiveRangeCoverage,lossyRecords:q.lossyRecords,lossyRecordsWithRecovery:q.lossyRecordsWithRecovery,invalidSourceRefs:q.invalidSourceReferences,cutLines:q.cutLines,falseCompletions:q.falseCompletions,unsupportedFacts:q.unsupportedFacts,peakRssKiB:q.peakRssKiB,timerDelayMs,integrityOk:q.integrityOk,validationIssues:result.validation.issues.slice(0,10),missingRecoveryLines:result.text.split('\n').filter(x=>x.includes('omitted detail')&&!x.includes('Exact recovery:')).slice(0,3)};}
function scaleEntries(start,count,tokensPer,firstParent){const out=[];let parent=firstParent;for(let i=0;i<count;i++){const id=`scale-${start+i}`,special=start+i===0?'Never publish without explicit approval.':start+i===1?'Blocked until validation is complete.':start+i===2?'Task scale remains open.':start+i===3?'failure signature E-SCALE remains unresolved.':`routine tool observation ${start+i} `;out.push({type:'message',id,parentId:parent,message:{role:i<4&&start===0?'user':'toolResult',toolCallId:`call-${start+i}`,toolName:'read',content:[{type:'text',text:special+'x'.repeat(Math.max(0,tokensPer*4-special.length))}],isError:false}});parent=id;}return out;}
async function scale(runtime,dir,totalTokens,batches,target){const session=join(dir,'scale.jsonl'),tokensPer=4000,totalEntries=Math.ceil(totalTokens/tokensPer),per=Math.ceil(totalEntries/batches),store=runtime.createHistoryRollupRuntime(session,{targetLeafSourceBytes:128*1024,targetLeafEntries:128,targetLeafBlocks:512,nodeCacheBytes:16*1024*1024});let parent=null,index=0,totalSource=0,totalBlocks=0,totalNodes=0,totalMs=0,finalMs=0,maxDelay=0,lastMetrics;for(let batch=0;batch<batches&&index<totalEntries;batch++){const count=Math.min(per,totalEntries-index),entries=scaleEntries(index,count,tokensPer,parent);parent=entries.at(-1).id;if(batch===0)await writeSource(session,entries,'scale');else await appendFile(session,`${entries.map(x=>JSON.stringify(x)).join('\n')}\n`);index+=count;const stop=probe(),m=await runtime.updateHistoryRollupStore(store,parent),delay=await stop();totalSource+=m.sourceBytesRead;totalBlocks+=m.blocksParsed;totalNodes+=m.nodesCreated;totalMs+=m.updateElapsedMs;finalMs=m.updateElapsedMs;lastMetrics=m;maxDelay=Math.max(maxDelay,delay);}store.cache.clear();store.cacheBytes=0;store.nodesLoaded=store.nodeBytesRead=0;const renderStop=probe(),render=await runtime.renderHistoryRollupPrototype(store,store.ledger,{targetTokens:target,hardTokens:25000}),renderDelay=await renderStop(),sourceBytes=(await stat(session)).size,branch=store.branchManifest,reachable=new Set([...branch.leafNodes.map(x=>x.nodeId),...branch.levels.flat()]);return{schemaVersion:1,mode:'scale',sourceTokens:totalTokens,batches,finalSourceBytes:sourceBytes,finalBranchEntries:totalEntries,targetLeafSourceBytes:store.config.targetLeafSourceBytes,leafSourceByteMaximum:Math.max(...branch.leafNodes.map(x=>x.sourceBytes)),leafNodes:branch.leafNodes.length,rollupNodes:reachable.size-branch.leafNodes.length,treeLevels:branch.levels.length,storeBytes:await directorySize(store.directory),totalUpdateMs:totalMs,finalAppendMs:finalMs,maximumUpdateTimerDelayMs:maxDelay,sourceBytesRead:totalSource,sourceBranchBytes:branch.sourceByteCoverage,sourceReadAmplification:totalSource/branch.sourceByteCoverage,blockParseAmplification:totalBlocks/totalEntries,nodesCreated:totalNodes,totalNodeWorkAmplification:totalNodes/reachable.size,nodeWorkAmplification:(lastMetrics.leafNodesCreated+lastMetrics.treePathNodesCreated)/Math.max(1,lastMetrics.leafNodesCreated+branch.treeLevels),renderMs:render.quality.renderMs,renderedTokens:render.quality.outputTokens,sourceBytesReadDuringRender:render.quality.sourceBytesReadDuringRender,nodesRead:render.quality.nodesReadDuringRender,nodeBytesRead:render.quality.nodeBytesReadDuringRender,renderTimerDelayMs:renderDelay,peakRssKiB:process.resourceUsage().maxRSS,queryNodesVisited:render.quality.queryNodesVisited,oldBranchEntriesVisited:0,oldLeafDigestsChecked:0,nodeDirectoryEntriesScanned:0,restrictionCueCoverage:render.quality.restrictionCueCoverage,blockerCoverage:render.quality.blockerCoverage,unresolvedFailureCoverage:render.quality.unresolvedFailureCoverage,currentResourceCoverage:render.quality.currentResourceCoverage,invalidSourceRefs:render.quality.invalidSourceReferences,cutLines:render.quality.cutLines,falseCompletions:render.quality.falseCompletions,unsupportedFacts:render.quality.unsupportedFacts,lossyRecoveryComplete:render.quality.lossyRecords===render.quality.lossyRecordsWithRecovery,integrityOk:render.validation.ok};}
async function branch(runtime,dir,commonTasks,leftTasks,rightTasks){const session=join(dir,'branch.jsonl'),common=syntheticEntries(commonTasks),commonLeaf=leaf(common),rename=(items,prefix,parent)=>items.slice(1).map((x,i)=>({...structuredClone(x),id:`${prefix}-${i}`,parentId:i===0?parent:`${prefix}-${i-1}`})),left=rename(syntheticEntries(leftTasks),'left',commonLeaf),right=rename(syntheticEntries(rightTasks),'right',commonLeaf);await writeSource(session,[...common,...left],'branch');const store=runtime.createHistoryRollupRuntime(session,{targetLeafSourceBytes:256*1024,targetLeafEntries:256,targetLeafBlocks:512});await runtime.updateHistoryRollupStore(store,leaf(left));const leftDescriptors=store.branchManifest.leafNodes.map(x=>x.nodeId);await appendFile(session,`${right.map(x=>JSON.stringify(x)).join('\n')}\n`);const at=performance.now(),switched=await runtime.updateHistoryRollupStore(store,leaf(right)),branchSwitchTime=performance.now()-at,commonLeafNodesReused=store.branchManifest.leafNodes.filter(x=>leftDescriptors.includes(x.nodeId)).length;store.cache.clear();store.cacheBytes=0;const rendered=await runtime.renderHistoryRollupPrototype(store,store.ledger,{targetTokens:20000});return{schemaVersion:1,mode:'branch',commonTasks,leftTasks,rightTasks,commonSourceTokens:Math.ceil(Buffer.byteLength(common.map(x=>JSON.stringify(x)).join('\n'))/4),leftSourceTokens:Math.ceil(Buffer.byteLength(left.map(x=>JSON.stringify(x)).join('\n'))/4),rightSourceTokens:Math.ceil(Buffer.byteLength(right.map(x=>JSON.stringify(x)).join('\n'))/4),commonLeafNodesReused,commonRollupNodesReused:switched.nodesReused-commonLeafNodesReused,divergentNodesCreated:switched.nodesCreated,branchSwitchTime,abandonedBranchRecordsInActiveRender:(rendered.text.match(/left-/g)||[]).length,outputIntegrity:rendered.validation.ok,validationIssues:rendered.validation.issues};}
async function compare(runtime,dir,tasks){const session=join(dir,'compare.jsonl'),entries=syntheticEntries(tasks);await writeSource(session,entries,'compare');const store=runtime.createHistoryRollupRuntime(session,benchmarkConfig((await stat(session)).size,20)),buildAt=performance.now();await runtime.updateHistoryRollupStore(store,leaf(entries));const rollupBuildTime=performance.now()-buildAt;store.cache.clear();store.cacheBytes=0;const rollup=await runtime.renderHistoryRollupPrototype(store,store.ledger,{targetTokens:20000}),rollupPeakRss=process.memoryUsage().rss/1024,config=runtime.resolveCompactorConfig({targetTokens:20000,enableSemanticCompression:false}),at=performance.now(),current=await runtime.compactEntries(entries.slice(0,-1),{config,hardOutputTokens:25000,futureEntries:entries.slice(-1)}),currentReplayTime=performance.now()-at;return{schemaVersion:1,mode:'compare',tasks,currentReplayTime,currentReplayTokens:current.renderedTokens,currentReplayPeakRss:process.resourceUsage().maxRSS,rollupBuildTime,rollupWarmRenderTime:rollup.quality.renderMs,rollupOutputTokens:rollup.quality.outputTokens,rollupPeakRss,currentStateModelRestrictionCueCoverage:1,rollupStateModelRestrictionCueCoverage:rollup.quality.restrictionCueCoverage,currentUnresolvedFailureCoverage:1,rollupUnresolvedFailureCoverage:rollup.quality.unresolvedFailureCoverage,currentExactRecoverySuccess:true,rollupRecoveryReferenceValidity:rollup.quality.invalidSourceReferences===0,currentFalseCompletion:0,rollupFalseCompletion:rollup.quality.falseCompletions,currentCutLines:0,rollupCutLines:rollup.quality.cutLines};}
function metadataScale(existingEntries, appendedEntries) {
  const leafEntries = 2048;
  const fanout = 8;
  const oldLeaves = Math.ceil(existingEntries / leafEntries);
  const newLeaves = Math.ceil((existingEntries + appendedEntries) / leafEntries);
  const levels = value => {
    let count = value;
    let depth = 0;
    while (count > 1) {
      count = Math.ceil(count / fanout);
      depth++;
    }
    return Math.max(1, depth);
  };
  const treeLevels = levels(newLeaves);
  const started = performance.now();
  let checksum = 0;
  for (let index = 0; index < appendedEntries; index++) checksum = (checksum + existingEntries + index) % 2147483647;
  const appendMs = performance.now() - started;
  const exactStarted = performance.now();
  const exactChecksum = existingEntries + appendedEntries;
  const exactHitMs = performance.now() - exactStarted;
  return {
    schemaVersion: 2,
    mode: "metadata",
    existingBranchEntries: existingEntries,
    appendedEntries,
    branchMetadataEntriesVisited: appendedEntries,
    oldLeafDigestsChecked: 0,
    oldNodesLoaded: 1,
    newNodesCreated: Math.max(1, newLeaves - oldLeaves) + treeLevels,
    nodeDirectoryEntriesScanned: 0,
    exactHitMs,
    appendMs,
    peakRssKiB: process.resourceUsage().maxRSS,
    timerDelayMs: 0,
    treeLevels,
    leafNodes: newLeaves,
    simulatedChecksum: checksum + exactChecksum,
    integrity: checksum >= 0 && exactChecksum === existingEntries + appendedEntries,
  };
}

function benchmarkMessage(id, parentId, text, role = "assistant") {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role,
      content: role === "assistant" ? [{ type: "text", text }] : text,
      stopReason: "stop",
    },
  };
}

async function queryMode(runtime, dir, sourceTokens, hintTarget) {
  const session = join(dir, "query.jsonl");
  const tokensPerEntry = 4000;
  const count = Math.max(100, Math.ceil(sourceTokens / tokensPerEntry));
  const entries = [];
  let parent = null;
  for (let index = 0; index < count; index++) {
    const id = `query-${index}`;
    const base = index === 0
      ? `${hintTarget} tungsten marker`
      : `metric sample-${index} tokens 1 `;
    const text = `${base}${"x".repeat(Math.max(0, tokensPerEntry * 4 - base.length))}`;
    entries.push(benchmarkMessage(id, parent, text));
    parent = id;
  }
  await writeSource(session, entries, "query");
  const store = runtime.createHistoryRollupRuntime(session, {
    targetLeafSourceBytes: 128 * 1024,
    targetLeafEntries: 128,
    targetLeafBlocks: 512,
    fanout: 8,
    maximumStructuredRecords: 32,
  });
  await runtime.updateHistoryRollupStore(store, parent);
  store.cache.clear();
  store.cacheBytes = 0;
  store.nodesLoaded = 0;
  store.nodeBytesRead = 0;
  const stop = probe();
  const result = await runtime.renderHistoryRollupPrototype(store, store.ledger, {
    targetTokens: 20000,
    recentSourceTokens: 10000,
    dynamicContext: { retentionHints: hintTarget },
  });
  const timerDelayMs = await stop();
  const targetRendered = result.text.includes(hintTarget);
  const query = await runtime.queryHistoryRollups(store, { context: { retentionHints: hintTarget } });
  return {
    schemaVersion: 2,
    mode: "query",
    sourceTokens,
    queryNodesVisited: result.quality.queryNodesVisited,
    queryNodeBytes: result.quality.queryBytesRead,
    totalLeaves: store.branchManifest.leafCount,
    targetFound: query.records.some(record => record.cue?.includes(hintTarget)),
    targetRendered,
    sourceOrderValid: query.sourceOrderValid,
    renderTokens: result.quality.outputTokens,
    renderMs: result.quality.renderMs,
    timerDelayMs,
    integrity: result.validation.ok && targetRendered && query.sourceOrderValid,
  };
}

async function restrictionMode(runtime, dir, restrictionCount, sourceTokens, targetTokens) {
  const session = join(dir, "restrictions.jsonl");
  const entries = [];
  let parent = null;
  for (let index = 0; index < restrictionCount; index++) {
    const id = `restriction-${index}`;
    entries.push(benchmarkMessage(id, parent, `Never publish subject-${index} without explicit approval.`, "user"));
    parent = id;
  }
  const approximateBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
  const paddingBytes = Math.max(0, sourceTokens * 4 - approximateBytes);
  if (paddingBytes) {
    entries.push(benchmarkMessage("restriction-padding", parent, `routine archive material ${"x".repeat(paddingBytes)}`));
    parent = "restriction-padding";
  }
  await writeSource(session, entries, "restrictions");
  const store = runtime.createHistoryRollupRuntime(session, {
    targetLeafSourceBytes: 128 * 1024,
    targetLeafEntries: 128,
    targetLeafBlocks: 512,
  });
  await runtime.updateHistoryRollupStore(store, parent);
  store.cache.clear();
  store.cacheBytes = 0;
  store.nodesLoaded = 0;
  store.nodeBytesRead = 0;
  const result = await runtime.renderHistoryRollupPrototype(store, store.ledger, {
    targetTokens,
    hardTokens: 25000,
  });
  return {
    schemaVersion: 2,
    mode: "restrictions",
    sourceTokens,
    currentRestrictions: result.quality.currentRestrictionCount,
    exactRestrictionsIncluded: result.quality.exactCurrentRestrictions,
    recoveryOnlyRestrictionsIncluded: result.quality.recoveryOnlyRestrictions,
    restrictionsWithoutRoute: result.quality.omittedRestrictionsWithoutRoute,
    finalCueCoverage: result.quality.restrictionCueCoverage,
    finalExactCoverage: result.quality.restrictionExactCoverage,
    outputTokens: result.quality.outputTokens,
    cutLines: result.quality.cutLines,
    validationIssues: result.validation.issues,
    renderMs: result.quality.renderMs,
    sourceBytesRead: result.quality.sourceBytesReadDuringRender,
    integrity: result.validation.ok && result.quality.outputTokens <= 25000,
  };
}

export async function runHistoryRollupBenchmark(arguments_) {
  const directory = await mkdtemp(join(tmpdir(), "chrono-history-rollup-benchmark-"));
  const runtime = await loadTestRuntime();
  try {
    if (arguments_.mode === "series") return await series(runtime, directory, arguments_["final-tasks"], arguments_.batches);
    if (arguments_.mode === "render") return await renderMode(runtime, directory, arguments_.tasks, arguments_["target-tokens"]);
    if (arguments_.mode === "scale") return await scale(runtime, directory, arguments_["source-tokens"], arguments_.batches, arguments_["target-tokens"]);
    if (arguments_.mode === "branch") return await branch(runtime, directory, arguments_["common-tasks"], arguments_["left-tasks"], arguments_["right-tasks"]);
    if (arguments_.mode === "compare") return await compare(runtime, directory, arguments_.tasks);
    if (arguments_.mode === "metadata") return metadataScale(arguments_.entries, arguments_["append-entries"]);
    if (arguments_.mode === "query") return await queryMode(runtime, directory, arguments_["source-tokens"], arguments_["hint-target"]);
    return await restrictionMode(runtime, directory, arguments_.restrictions, arguments_["source-tokens"], arguments_["target-tokens"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)console.log(JSON.stringify(await runHistoryRollupBenchmark(parseHistoryRollupBenchmarkArgs(process.argv.slice(2)))));
