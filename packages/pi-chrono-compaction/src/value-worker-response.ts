import type { ParsedValueAdvice, ValueAdvice } from "./value-worker-types.js";
import { estimateTokensFromText } from "./utils.js";
const classes=new Set(["instruction","goal","decision","plan","blocker","failure","result","evidence","resource","status","routine","duplicate","unknown"]);
const importance=new Set(["critical","high","normal","low"]); const bands=new Set(["high","medium","low"]); const actions=new Set(["keep","compress","neutral"]);
function json(text:string):unknown { const t=text.trim(); return JSON.parse(t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]??t); }
export function parseValueAdviceResponse(text:string, knownIds:ReadonlySet<string>, maxOutputTokens:number):ParsedValueAdvice {
  if(estimateTokensFromText(text)>maxOutputTokens) return {advice:[],rejected:0,unknown:0,duplicates:0,needsRepair:true,status:"invalid-top-level"};
  let value:unknown; try { value=json(text); } catch { return {advice:[],rejected:0,unknown:0,duplicates:0,needsRepair:true,status:"invalid-top-level"}; }
  if(!value||typeof value!=="object"||Array.isArray(value)||(value as any).version!==1||!Array.isArray((value as any).items)) return {advice:[],rejected:0,unknown:0,duplicates:0,needsRepair:true,status:"invalid-top-level"};
  const advice:ValueAdvice[]=[]; const seen=new Set<string>(); let rejected=0,unknown=0,duplicates=0;
  for(const raw of (value as any).items) { if(advice.length>=knownIds.size) break; if(!raw||typeof raw!=="object"||Array.isArray(raw)||typeof raw.itemId!=="string"){rejected++;continue;} if(!knownIds.has(raw.itemId)){unknown++;continue;} if(seen.has(raw.itemId)){duplicates++;continue;}
    if(!classes.has(raw.semanticClass)||!importance.has(raw.importance)||!bands.has(raw.compressionRisk)||!bands.has(raw.reuseLikelihood)||!bands.has(raw.uniqueness)||!actions.has(raw.action)||typeof raw.confidence!=="number"||!Number.isFinite(raw.confidence)||raw.confidence<0||raw.confidence>1){rejected++;continue;}
    seen.add(raw.itemId); advice.push({itemId:raw.itemId,semanticClass:raw.semanticClass,importance:raw.importance,compressionRisk:raw.compressionRisk,reuseLikelihood:raw.reuseLikelihood,uniqueness:raw.uniqueness,action:raw.action,confidence:raw.confidence}); }
  return {advice,rejected,unknown,duplicates,needsRepair:false,status:"valid"};
}
export function valueAdviceRepairPrompt(invalid:string):string { const ids=[...new Set(invalid.match(/\bi\d{4}\b/g)??[])].slice(0,40); return ["Return JSON only. Repair the response shape to schema version 1.",'{"version":1,"items":[{"itemId":"opaque-id","semanticClass":"instruction|goal|decision|plan|blocker|failure|result|evidence|resource|status|routine|duplicate|unknown","importance":"critical|high|normal|low","compressionRisk":"high|medium|low","reuseLikelihood":"high|medium|low","uniqueness":"high|medium|low","action":"keep|compress|neutral","confidence":0.0}]}',`Allowed opaque item IDs: ${ids.join(",")||"none"}. An empty items array is valid.`,"Do not add source text, source identifiers, paths, excerpts, or explanations."].join("\n"); }
