import type {FetchLike,Store,NewsItem} from './types.ts';
import {scoringPrompt} from './scoring.ts';

export type GroqStage = 'scoring'|'review'|'patterns';
export interface GroqOptions { model?: string; maxTokens?: number; fallbackModel?: string; }

export async function groq(
  store:Store,
  fetcher:FetchLike,
  prompt:string,
  stage:GroqStage,
  now=new Date(),
  options:GroqOptions = {},
):Promise<{text:string;usage:any;model:string;finish?:string}>{
  const cooldown=Number(await store.getKV('groq:cooldown')||0);
  if(cooldown>Date.now())throw new Error('Groq cooldown');
  const keys=[1,2,3].map(i=>Deno.env.get(`GROQ_API_KEY_${i}`)).filter(Boolean) as string[];
  if(!keys.length)throw new Error('Groq key missing');
  const primary=options.model||'openai/gpt-oss-20b';
  const maxTokens=options.maxTokens||700;
  let last='';
  let retryable=false;
  const models=[primary, ...(options.fallbackModel && options.fallbackModel!==primary ? [options.fallbackModel] : [])];
  for(let modelIndex=0;modelIndex<models.length;modelIndex++){
    const model=models[modelIndex];
    retryable=false;
    const requestKeys = modelIndex === 0 ? keys : keys.slice(0, 1);
    for(let i=0;i<requestKeys.length;i++){
      try {
        const r=await fetcher('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${requestKeys[i]}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],reasoning_effort:'low',max_completion_tokens:maxTokens,temperature:.2})});
        if(r.status===429){const wait=Number(r.headers.get('retry-after')||15);await store.setKV('groq:cooldown',Date.now()+wait*1000);last='429';retryable=true;continue}
        if(!r.ok){last=`HTTP ${r.status}`;retryable=r.status>=500;continue}
        const j=await r.json(),u=j.usage||{};
        await store.bumpUsage({day:now.toISOString().slice(0,10),provider:'groq',model,stage,calls:1,tokens_in:u.prompt_tokens||0,tokens_out:u.completion_tokens||0});
        return {text:String(j.choices?.[0]?.message?.content||''),usage:u,model,finish:String(j.choices?.[0]?.finish_reason||'')};
      } catch(error) {
        last='timeout';
        retryable=true;
      }
    }
    if(modelIndex+1>=models.length || !retryable) break;
  }
  throw new Error(`Groq ${last||'failed'}`);
}
export async function tavily(fetcher:FetchLike,query:string):Promise<any>{const key=Deno.env.get('TAVILY_API_KEY');if(!key)throw new Error('Tavily key missing');const r=await fetcher('https://api.tavily.com/search',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({api_key:key,query,search_depth:'advanced',max_results:8})});if(!r.ok)throw new Error(`Tavily HTTP ${r.status}`);return r.json()}
export function independentSources(results:any[],original:string,stateDomains:string[]):number{let domain='';try{domain=new URL(original).hostname} catch{}const seen=new Set<string>();for(const x of results||[]){try{const d=new URL(x.url).hostname;if(d!==domain&&!stateDomains.some(s=>d.endsWith(s)))seen.add(d)}catch{}}return seen.size}
export {scoringPrompt};
