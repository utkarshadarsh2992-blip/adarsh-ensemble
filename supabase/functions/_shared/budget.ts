import type {Store,Settings} from './types.ts';
export function utcDay(now=new Date()):string{return now.toISOString().slice(0,10)}
export function monthKey(now=new Date()):string{return now.toISOString().slice(0,7)}
export function budgetState(used:number,cap:number):'ok'|'warn'|'stopped'{return cap<=0||used>=cap?'stopped':used>=cap*.8?'warn':'ok'}
export async function budget(store:Store,now=new Date()){
  const s=await store.getSettings(),day=utcDay(now);
  const rows=await Promise.all([
    store.getUsage(day,'groq','openai/gpt-oss-20b','scoring'),
    store.getUsage(day,'groq','openai/gpt-oss-20b','review'),
    store.getUsage(day,'groq','openai/gpt-oss-20b','patterns'),
    store.getUsage(day,'groq','openai/gpt-oss-120b','patterns'),
  ]);
  const tokens=rows.reduce((n,u)=>n+u.tokens_in+u.tokens_out,0),calls=rows.reduce((n,u)=>n+u.calls,0);
  const frac=Math.max(s.groq_tokens_cap>0?tokens/s.groq_tokens_cap:1,s.groq_calls_cap>0?calls/s.groq_calls_cap:1);
  const alerts=await alertsSentToday(store,localDay(now,s.tz));
  const notified={warn:Boolean(await store.getKV(`budget:warn:${day}`)),stop:Boolean(await store.getKV(`budget:stop:${day}`))};
  return {day,groq:{tokens_used:tokens,tokens_cap:s.groq_tokens_cap,calls_used:calls,calls_cap:s.groq_calls_cap,frac,state:budgetState(frac,1)},tavily:{day_used:Number(await store.getKV(`tavily:day:${day}`)||0),day_cap:s.tavily_day_cap,month_used:Number(await store.getKV(`tavily:${monthKey(now)}`)||0),month_cap:s.tavily_month_cap,frac:Number(await store.getKV(`tavily:${monthKey(now)}`)||0)/s.tavily_month_cap},alerts:{today:alerts,cap:s.alerts_per_day,day:localDay(now,s.tz)},notified,cooldown_s:Number(await store.getKV('groq:cooldown')||0)}
}
export async function markBudgetNotices(store:Store,now=new Date()){const d=utcDay(now),b=await budget(store,now),out:{warn:boolean;stop:boolean}={warn:false,stop:false};if(b.groq.state==='warn'&&!b.notified.warn){await store.setKV(`budget:warn:${d}`,true);out.warn=true}if(b.groq.state==='stopped'&&!b.notified.stop){await store.setKV(`budget:stop:${d}`,true);out.stop=true}return out}
export function localDay(now:Date,tz:string):string {try{return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}catch{return utcDay(now)}}
export function digestDue(now:Date,time:string,tz:string,last:string|null):boolean {const day=localDay(now,tz);if(last===day)return false;const [h,m]=time.split(':').map(Number);const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(now);const hh=Number(parts.find(x=>x.type==='hour')?.value||0),mm=Number(parts.find(x=>x.type==='minute')?.value||0);return hh*60+mm>=h*60+m}
export const TAVILY_CREDITS=2;
export async function tavilyAllowed(store:Store,s:Settings,now=new Date()):Promise<boolean>{const day=Number(await store.getKV(`tavily:day:${utcDay(now)}`)||0),month=Number(await store.getKV(`tavily:${monthKey(now)}`)||0);return day+TAVILY_CREDITS<=s.tavily_day_cap&&month+TAVILY_CREDITS<=s.tavily_month_cap}
export async function noteTavily(store:Store,now=new Date()):Promise<void>{const d=utcDay(now),m=monthKey(now);await store.setKV(`tavily:day:${d}`,Number(await store.getKV(`tavily:day:${d}`)||0)+TAVILY_CREDITS);await store.setKV(`tavily:${m}`,Number(await store.getKV(`tavily:${m}`)||0)+TAVILY_CREDITS);await store.bumpUsage({day:d,provider:'tavily',model:'search-advanced',stage:'verify',calls:1,tokens_in:TAVILY_CREDITS})}
export async function alertsSentToday(store:Store,day:string):Promise<number>{const rows=await store.listAlerts(day,'alert');return new Set(rows.filter(r=>r.ok).map((r,i)=>r.news_id||`row-${i}`)).size}
