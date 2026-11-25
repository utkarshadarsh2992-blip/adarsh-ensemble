import {assert,assertEquals,assertFalse} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {MemoryStore} from '../functions/_shared/store.ts';
import {alertsSentToday,budget,noteTavily,tavilyAllowed} from '../functions/_shared/budget.ts';
import {canAlert} from '../functions/_shared/alerts.ts';
import {NEWS_LIMITS} from '../functions/_shared/newsadmin.ts';
import type {NewsItem} from '../functions/_shared/types.ts';

const item=(score=9)=>({score,verified:'confirmed',state_media:false} as unknown as NewsItem);
const now=new Date('2026-11-26T10:00:00Z');

Deno.test('alert cap per day is enforced, 0 turns push alerts off',()=>{
  const s=new MemoryStore().settings;
  assert(canAlert(item(),{...s,alerts_per_day:3},2));
  assertFalse(canAlert(item(),{...s,alerts_per_day:3},3));
  assertFalse(canAlert(item(),{...s,alerts_per_day:0},0));
});

Deno.test('one alert sent to Telegram and FCM counts once',async()=>{
  const st=new MemoryStore();
  for(const ch of ['telegram','fcm'] as const)await st.addAlert({news_id:'a',channel:ch,kind:'alert',ok:true,error:'',sent_at:'',day_local:'2026-11-26'});
  await st.addAlert({news_id:'b',channel:'telegram',kind:'alert',ok:true,error:'',sent_at:'',day_local:'2026-11-26'});
  await st.addAlert({news_id:'c',channel:'telegram',kind:'alert',ok:false,error:'x',sent_at:'',day_local:'2026-11-26'});
  assertEquals(await alertsSentToday(st,'2026-11-26'),2);
});

Deno.test('Tavily daily cap gates calls and usage is recorded per day',async()=>{
  const st=new MemoryStore();
  const s={...st.settings,tavily_day_cap:4,tavily_month_cap:700};
  assert(await tavilyAllowed(st,s,now));
  await noteTavily(st,now);await noteTavily(st,now);
  assertFalse(await tavilyAllowed(st,s,now),'4 of 4 credits used');
  assert(await tavilyAllowed(st,s,new Date('2026-11-27T01:00:00Z')),'new UTC day resets');
  const b=await budget(st,now);
  assertEquals(b.tavily.day_used,4);assertEquals(b.tavily.day_cap,20);
  const u=await st.getUsage('2026-11-26','tavily','search-advanced','verify');
  assertEquals(u.calls,2);assertEquals(u.tokens_in,4);
});

Deno.test('Tavily monthly cap also gates and cap 0 never calls Tavily',async()=>{
  const st=new MemoryStore();
  await st.setKV('tavily:2026-11',698);
  assertFalse(await tavilyAllowed(st,{...st.settings,tavily_day_cap:50,tavily_month_cap:699},now));
  assertFalse(await tavilyAllowed(st,{...st.settings,tavily_day_cap:0},now));
});

Deno.test('controller limits are bounded',()=>{
  assertEquals(NEWS_LIMITS.alerts_per_day,{min:0,max:10});
  assert(NEWS_LIMITS.tavily_day_cap.max<=1000&&NEWS_LIMITS.tavily_day_cap.min===0);
});
