import {assert,assertEquals,assertFalse,assertMatch} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {parseFeed,decodeEntities,normalizeUrl,sha256,jaccard,relevant,isStateMedia,fetchFeed} from '../functions/_shared/parser.ts';
import {extractJson,parseScores,reviewerResult} from '../functions/_shared/scoring.ts';
import {MemoryStore} from '../functions/_shared/store.ts';
import {budgetState, digestDue, localDay} from '../functions/_shared/budget.ts';
import {alertThreshold,canAlert,htmlEscape,splitTelegram} from '../functions/_shared/alerts.ts';
import {fcmPayload,serviceToken} from '../functions/_shared/fcm.ts';
import {constantTime,handleApi} from '../functions/_shared/api.ts';
import {run as ingest,selectDueFeeds} from '../functions/news-ingest/index.ts';
import {run as score} from '../functions/news-score/index.ts';
import {run as digest} from '../functions/news-digest/index.ts';

Deno.test('RSS 2.0 CDATA/entities and Atom parse',async()=>{const rss=`<rss><channel><item><title><![CDATA[Nvidia &amp; chips]]></title><link>https://x.test/a?utm_source=z</link><description>Hi &amp; bye</description><pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate><source url="https://publisher.test">Pub</source></item></channel></rss>`;const atom=`<feed><entry><title>Rocket &amp; launch</title><link href="https://a.test/r"/><summary><![CDATA[Summary]]></summary><updated>2026-11-25T10:00:00Z</updated></entry></feed>`;const a=parseFeed(rss),b=parseFeed(atom);assertEquals(a[0].title,'Nvidia & chips');assertEquals(a[0].publisher,'Pub');assertEquals(b[0].url,'https://a.test/r');assertEquals(decodeEntities('a&nbsp;&amp;&#39;'),"a &'");assert((await sha256('x')).length===64)});
Deno.test('normalization, fuzzy clustering, state media, relevance',()=>{assertEquals(normalizeUrl('https://x.test/a?utm_source=x&ok=1'),'https://x.test/a?ok=1');assert(jaccard('OpenAI launches new model','New OpenAI model launched')>.5);assert(isStateMedia('https://english.news.cn/business/a',false));assertFalse(relevant('Celebrity football scores','match result',{id:'x',url:'',kind:'rss',grp:'x',region:'WORLD',state_media:false,every_min:5,active:true,fail_count:0,name:'x'},[]));assert(relevant('Rocket launch succeeds','spacecraft propulsion',{id:'x',url:'',kind:'rss',grp:'x',region:'WORLD',tag_hint:'SPACE',state_media:false,every_min:5,active:true,fail_count:0,name:'x'},[]))});
Deno.test('dedupe and scoring response tolerant parsing',()=>{const a=extractJson('noise ```json [{"score":9}]``` trailing');assertEquals((a as any[])[0].score,9);const item={id:'1',title:'OpenAI model',points:[],tag:'AI',tags:['AI'],region:'US',company:'',activity:'other',score:null,breaking:false,verified:'none',n_sources:1,source:'',url:'x',published_at:null,created_at:new Date().toISOString(),read_at:null,saved:false,upvotes:0,kind:'news',status:'new',cluster_key:null,title_norm:null,feed_id:null,raw_summary:'',sources:[],why:'',alerted_at:null,state_media:false,claim_tag:'',scored_at:null,tokens:0} as any;const r=parseScores('garbage {"items":[{"id":"1","tag":"AI","score":11,"points":["a","b"]}]}', [item]);assertEquals(r[0].score,10);assertEquals(reviewerResult('prefix {"verified":"confirmed","why":"ok","points":["p1"]}').verified,'confirmed')});
Deno.test('budget math and one notice per day markers',async()=>{assertEquals(budgetState(10,100),'ok');assertEquals(budgetState(80,100),'warn');assertEquals(budgetState(100,100),'stopped');const s=new MemoryStore();s.bumpUsage({day:'2026-11-25',provider:'groq',model:'openai/gpt-oss-20b',stage:'scoring',tokens_out:120000,calls:1});const b=await import('../functions/_shared/budget.ts');const n=await b.markBudgetNotices(s,new Date('2026-11-25T12:00:00Z'));assert(n.warn);const n2=await b.markBudgetNotices(s,new Date('2026-11-25T12:01:00Z'));assertFalse(n2.warn)});
Deno.test('alert cap threshold, state-only never alerts',async()=>{const s=new MemoryStore(), base:any={id:'1',title:'x',points:['p'],tag:'AI',score:8,verified:'confirmed',state_media:false};assertEquals(alertThreshold(s.settings,2),8);assertEquals(alertThreshold(s.settings,3),9);assert(canAlert(base,s.settings,2));assertFalse(canAlert({...base,state_media:true},s.settings,0));assertFalse(canAlert({...base,score:8},s.settings,3))});
Deno.test('Telegram escaping and safe splitting',()=>{assertEquals(htmlEscape('<a&"'), '&lt;a&amp;&quot;');const x=splitTelegram('a'.repeat(8000));assertEquals(x.length,3);assert(x.every(y=>y.length<=3800))});
Deno.test('FCM payload shape and JWT structure',async()=>{const p=fcmPayload({id:'7',title:'T',points:['P'],tag:'AI',score:9,state_media:false},'news_alert','OPEN_DEBATE');assertEquals(p.message.android.priority,'HIGH');assertEquals(p.message.data.news_id,'7');assertEquals(p.message.data.state_media,'0');const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const der=await crypto.subtle.exportKey('pkcs8',(kp as CryptoKeyPair).privateKey);const pem='-----BEGIN '+ 'PRIVATE KEY' +'-----\n'+btoa(String.fromCharCode(...new Uint8Array(der)))+'\n-----END '+ 'PRIVATE KEY' +'-----';const jwt=await serviceToken(JSON.stringify({client_email:'a@b.test',private_key:pem}),1000);assertEquals(jwt.split('.').length,3);assertMatch(jwt,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)});
Deno.test('news-api auth, CORS, ping, settings clamping',async()=>{Deno.env.set('APP_SECRET','test-app-secret-123');const s=new MemoryStore();let r=await handleApi(new Request('http://x',{method:'OPTIONS'}),s);assertEquals(r.status,204);r=await handleApi(new Request('http://x',{method:'POST',headers:{'content-type':'application/json','x-app-secret':'bad'},body:'{"action":"ping"}'}),s);assertEquals(r.status,401);assert(constantTime('x','x'));r=await handleApi(new Request('http://x',{method:'POST',headers:{'content-type':'application/json','x-app-secret':'test-app-secret-123'},body:'{"action":"settings_set","alerts_per_day":99,"alert_min_score":2}'}),s);assertEquals(r.status,400);r=await handleApi(new Request('http://x',{method:'POST',headers:{'content-type':'application/json','x-app-secret':'test-app-secret-123'},body:'{"action":"settings_set","alerts_per_day":0,"alert_min_score":2}'}),s);const j=await r.json();assertEquals(j.settings.alerts_per_day,0);assertEquals(j.settings.alert_min_score,2)});
Deno.test('digest timezone due logic',()=>{const d=new Date('2026-11-25T16:05:00Z');assertEquals(localDay(d,'Asia/Kolkata'),'2026-11-25');assert(digestDue(d,'21:30','Asia/Kolkata',null));assertFalse(digestDue(d,'21:30','Asia/Kolkata','2026-11-25'))});
Deno.test('end-to-end ingest -> score -> Tavily -> review -> alert decision',async()=>{Deno.env.set('GROQ_API_KEY_1','placeholder');Deno.env.set('TAVILY_API_KEY','placeholder');const s=new MemoryStore();s.feeds=[{id:'f',url:'https://feed.test',kind:'rss',grp:'x',region:'US',tag_hint:'AI',state_media:false,every_min:5,active:true,fail_count:0,name:'x'}];const rss='<rss><channel><item><title>OpenAI launches frontier model</title><link>https://publisher.test/a</link><description>AI model release</description></item></channel></rss>';let groqCalls=0;const fake=async (u:any,init?:RequestInit)=>{if(String(u)==='https://feed.test')return new Response(rss,{status:200});if(String(u).includes('groq')){groqCalls++;const content=groqCalls===1?'[{"tag":"AI","tags":["AI"],"region":"US","company":"OpenAI","activity":"model","score":9,"points":["p1","p2"]}]':'{"verified":"confirmed","points":["p1","p2"],"why":"ok"}';return new Response(JSON.stringify({choices:[{message:{content}}],usage:{completion_tokens:20,prompt_tokens:10}}),{status:200});}if(String(u).includes('tavily'))return new Response(JSON.stringify({results:[{url:'https://one.test/a'},{url:'https://two.test/a'}]}),{status:200});return new Response('{}',{status:200})};const ir=await ingest(s,fake);assertEquals(ir.items,1);const sr=await score(s,fake,new Date('2026-11-25T12:00:00Z'));assertEquals(sr.scored,1);const item=s.items[0];assertEquals(item.verified,'confirmed');assert(item.breaking||sr.alerts===0)});

Deno.test('ingest rotates due feeds oldest-first and honors polling intervals',async()=>{
  const now=new Date('2026-11-25T12:00:00Z');
  const makeFeed=(id:string,last_fetch:string|null,every_min:number):any=>({id,url:`https://${id}.test/rss`,kind:'rss',grp:'test',region:'US',tag_hint:'AI',state_media:false,every_min,active:true,fail_count:0,name:id,last_fetch});
  const s=new MemoryStore();
  s.feeds=[
    makeFeed('recent','2026-11-25T11:55:00Z',15),
    makeFeed('due-newer','2026-11-25T11:30:00Z',15),
    makeFeed('long-interval','2026-11-25T11:20:00Z',60),
    makeFeed('never',null,1440),
    makeFeed('due-old','2026-11-25T11:00:00Z',30),
  ];
  const requested:string[]=[];
  const fake:typeof fetch=async(input)=>{
    requested.push(String(input));
    return new Response('<rss><channel></channel></rss>',{status:200});
  };
  const summary=await ingest(s,fake,now);
  assertEquals(summary.feeds,3);
  assertEquals(requested,['https://never.test/rss','https://due-old.test/rss','https://due-newer.test/rss']);
  assertEquals(selectDueFeeds(s.feeds,now).length,0);
});


Deno.test('digest claims the local day before sending and does not repeat after FCM failure',async()=>{
  const s=new MemoryStore();
  s.kv.set('telegram:chat_id','test-chat');
  await s.insertItem({title:'Test daily digest item',points:['Verified point'],score:9,status:'scored',created_at:'2026-11-25T15:00:00.000Z'} as any);
  const oldToken=Deno.env.get('TELEGRAM_BOT_TOKEN');
  const oldFcm=Deno.env.get('FCM_SERVICE_ACCOUNT');
  Deno.env.set('TELEGRAM_BOT_TOKEN','test-only-token');
  Deno.env.set('FCM_SERVICE_ACCOUNT','not-json');
  let telegramCalls=0;
  const fake:typeof fetch=async(input)=>{
    if(String(input).includes('api.telegram.org')) telegramCalls++;
    return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const first=await digest(s,fake,new Date('2026-11-25T16:05:00.000Z'));
    const second=await digest(s,fake,new Date('2026-11-25T16:15:00.000Z'));
    assertEquals(first.sent,true);
    assertEquals(second.sent,false);
    assertEquals(telegramCalls,1);
    assertEquals(await s.getKV('digest:last_day'),'2026-11-25');
  } finally {
    if(oldToken===undefined) Deno.env.delete('TELEGRAM_BOT_TOKEN'); else Deno.env.set('TELEGRAM_BOT_TOKEN',oldToken);
    if(oldFcm===undefined) Deno.env.delete('FCM_SERVICE_ACCOUNT'); else Deno.env.set('FCM_SERVICE_ACCOUNT',oldFcm);
  }
});

Deno.test('fetchFeed accepts Google News query URLs but rejects unsafe feed URLs',async()=>{
  const feed:any={id:'f',url:'https://news.google.com/rss/search?q=(Nvidia+OR+ISRO)+when:1h&hl=en-IN&gl=IN&ceid=IN:en',kind:'rss',grp:'x',region:'IN',tag_hint:'AI',state_media:false,every_min:5,active:true};
  const rss='<?xml version="1.0"?><rss><channel><item><title>Nvidia ships chip</title><link>https://example.com/a</link><description>AI chip</description></item></channel></rss>';
  let r=await fetchFeed(feed,async()=>new Response(rss,{status:200,headers:{'content-type':'application/rss+xml'}}));
  assertEquals(r.error,undefined);assertEquals(r.items.length,1);
  for(const bad of ['http://news.google.com/rss','https://user:pw@news.google.com/rss','https://news.google.com:8443/rss','https://127.0.0.1/rss','https://localhost/rss','https://169.254.169.254/latest']){
    r=await fetchFeed({...feed,url:bad},async()=>new Response(rss,{status:200}));assertEquals(r.error,'Feed URL rejected');
  }
});

Deno.test('fetchFeed follows validated redirects only',async()=>{
  const feed:any={id:'f',url:'https://example.com/rss',kind:'rss',grp:'x',region:'US',tag_hint:'AI',state_media:false,every_min:5,active:true};
  const rss='<?xml version="1.0"?><rss><channel><item><title>AI chip</title><link>https://example.com/a</link><description>AI</description></item></channel></rss>';
  const seen:string[]=[];
  let r=await fetchFeed(feed,async(u:any,i:any)=>{seen.push(String(u));assertEquals(i.redirect,'manual');return String(u)==='https://example.com/rss'?new Response(null,{status:301,headers:{location:'/feed.xml'}}):new Response(rss,{status:200,headers:{'content-type':'text/html'}})});
  assertEquals(r.error,undefined);assertEquals(r.items.length,1);assertEquals(seen,['https://example.com/rss','https://example.com/feed.xml']);
  for(const loc of ['http://example.com/x','https://127.0.0.1/x','https://example.com:8443/x','https://u:p@example.com/x']){
    r=await fetchFeed(feed,async()=>new Response(null,{status:302,headers:{location:loc}}));assertEquals(r.error,'Feed redirect rejected');
  }
  r=await fetchFeed(feed,async()=>new Response(null,{status:302,headers:{location:'/again'}}));assertEquals(r.error,'Too many or invalid redirects');
});


import {validatePatterns,getPatterns} from '../functions/_shared/patterns.ts';

const patternItem=(id:string,region:'IN'|'CN'|'US'|'RU'|'EU'|'WORLD',n=0):any=>({
  id,title:`News ${id}`,points:[`Point ${id}`],tag:'AI',tags:['AI'],region,company:'Company',activity:'model',score:8,
  breaking:false,verified:'confirmed',n_sources:1,source:`Source ${id}`,url:`https://db.example/${id}`,published_at:null,
  created_at:`2026-11-27T0${n}:00:00.000Z`,read_at:null,saved:false,upvotes:0,kind:'news',status:'scored',cluster_key:null,
  title_norm:null,feed_id:null,raw_summary:'',sources:[],why:'',alerted_at:null,state_media:false,claim_tag:'',scored_at:null,tokens:0,
});

Deno.test('patterns validation drops unknown ids and single-region claims, caps six, and takes URLs from DB',()=>{
  const items=[patternItem('in','IN',1),patternItem('cn','CN',2),patternItem('us','US',3),patternItem('eu','EU',4)];
  const valid=(i:number)=>({title:`Pattern ${i}`,pattern:'Events point to one move.',type:'ai-race',signal:'strong',regions:[{region:'IN',what:'India move',item_ids:['in']},{region:'CN',what:'China move',item_ids:['cn']}],why_it_matters:'AI signal',watch_next:'Next launch',assumption:'May be correlation.'});
  const raw=[{...valid(0),regions:[{region:'IN',what:'bad',item_ids:['in','ghost']},{region:'CN',what:'good',item_ids:['cn']}]},{...valid(1),regions:[{region:'IN',what:'only',item_ids:['in']}]},...Array.from({length:8},(_,i)=>valid(i+2))];
  const out=validatePatterns(raw,items);
  assertEquals(out.length,6);assertEquals(out[0].items[0].url,'https://db.example/in');assertEquals(out[0].items.some(x=>x.id==='ghost'),false);assertEquals(out.some(x=>x.title==='Pattern 1'),false);
});

Deno.test('patterns API rejects unknown fields and invalid refresh without calling Groq',async()=>{
  Deno.env.set('APP_SECRET','test-app-secret-123');const s=new MemoryStore();
  const mk=(body:any)=>new Request('http://x',{method:'POST',headers:{'content-type':'application/json','x-app-secret':'test-app-secret-123'},body:JSON.stringify(body)});
  let r=await handleApi(mk({action:'patterns',oops:true}),s);assertEquals(r.status,400);
  r=await handleApi(mk({action:'patterns',refresh:'yes'}),s);assertEquals(r.status,400);
});

Deno.test('patterns throttle and failed regeneration preserve a good cache',async()=>{
  const oldKey=Deno.env.get('GROQ_API_KEY_1'),oldKey2=Deno.env.get('GROQ_API_KEY_2'),oldKey3=Deno.env.get('GROQ_API_KEY_3');Deno.env.set('GROQ_API_KEY_1','test-pattern-key');Deno.env.delete('GROQ_API_KEY_2');Deno.env.delete('GROQ_API_KEY_3');
  const now=new Date('2026-11-27T12:00:00.000Z'),s=new MemoryStore();
  s.items=[patternItem('in','IN',1),patternItem('cn','CN',2)];let calls=0;
  const good=JSON.stringify({choices:[{message:{content:JSON.stringify({patterns:[{title:'AI race',pattern:'Dono taraf model build kar rahe hain.',type:'ai-race',regions:[{region:'IN',what:'India model',item_ids:['in']},{region:'CN',what:'China model',item_ids:['cn']}],signal:'strong',why_it_matters:'Compute aur AGI race',watch_next:'Next releases',assumption:'Coverage complete nahi ho sakti.'}]})}}],usage:{prompt_tokens:100,completion_tokens:50}});
  const fetcher=async()=>{calls++;return calls===1?new Response(good,{status:200}):new Response('upstream',{status:503});};
  try {
    const first=await getPatterns(s,fetcher,now,true);assertEquals(first.ok,true);if(!first.ok)throw new Error('expected generated patterns');assertEquals(first.patterns.length,1);assertEquals(calls,1);
    const throttled=await getPatterns(s,fetcher,new Date(now.getTime()+5*60e3),true);assertEquals(throttled.ok,true);assertEquals(throttled.reason,'throttled');assertEquals(calls,1);
    const failed=await getPatterns(s,fetcher,new Date(now.getTime()+31*60e3),true);assertEquals(failed.ok,true);if(!failed.ok)throw new Error('expected cached patterns');assertEquals(failed.reason,'generation-failed');assertEquals(failed.patterns[0].items[0].url,'https://db.example/in');assertEquals(calls,3);
  } finally { if(oldKey===undefined)Deno.env.delete('GROQ_API_KEY_1');else Deno.env.set('GROQ_API_KEY_1',oldKey); if(oldKey2===undefined)Deno.env.delete('GROQ_API_KEY_2');else Deno.env.set('GROQ_API_KEY_2',oldKey2); if(oldKey3===undefined)Deno.env.delete('GROQ_API_KEY_3');else Deno.env.set('GROQ_API_KEY_3',oldKey3); }
});

Deno.test('patterns obey the existing stopped budget and do not call Groq',async()=>{
  const oldKey=Deno.env.get('GROQ_API_KEY_1');Deno.env.set('GROQ_API_KEY_1','test-pattern-key');
  const s=new MemoryStore();s.settings.groq_tokens_cap=1;s.items=[patternItem('in','IN',1),patternItem('cn','CN',2)];await s.bumpUsage({day:'2026-11-27',provider:'groq',model:'openai/gpt-oss-20b',stage:'scoring',tokens_out:1,calls:1});let calls=0;
  try { const r=await getPatterns(s,async()=>{calls++;return new Response('{}');},new Date('2026-11-27T12:00:00.000Z'),true);assertEquals(r.ok,false);assertEquals(r.reason,'budget-stopped');assertEquals(calls,0); }
  finally { if(oldKey===undefined)Deno.env.delete('GROQ_API_KEY_1');else Deno.env.set('GROQ_API_KEY_1',oldKey); }
});
import {PATTERN_CACHE_KEY} from '../functions/_shared/patterns.ts';
import {warmPatterns} from '../functions/news-score/warm.ts';
Deno.test('patterns API answers from cache at once and regenerates a stale cache (phone 10 s timeout)',async()=>{
  Deno.env.set('APP_SECRET','test-app-secret-123');
  const oldKey=Deno.env.get('GROQ_API_KEY_1');Deno.env.set('GROQ_API_KEY_1','test-pattern-key');
  const now=new Date('2026-11-27T12:00:00.000Z'),s=new MemoryStore();
  s.items=[patternItem('in','IN',1),patternItem('cn','CN',2)];let calls=0;
  const good=JSON.stringify({choices:[{message:{content:JSON.stringify({patterns:[{title:'New race',pattern:'Naya link.',type:'ai-race',regions:[{region:'IN',what:'India',item_ids:['in']},{region:'CN',what:'China',item_ids:['cn']}],signal:'medium',why_it_matters:'x',watch_next:'y',assumption:'z'}]})}}],usage:{prompt_tokens:10,completion_tokens:5}});
  const fetcher=async()=>{calls++;return new Response(good,{status:200});};
  const mk=(body:any)=>new Request('http://x',{method:'POST',headers:{'content-type':'application/json','x-app-secret':'test-app-secret-123'},body:JSON.stringify(body)});
  try {
    await s.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-3600e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[{title:'Old'}]});
    let j=await (await handleApi(mk({action:'patterns'}),s,fetcher,now)).json();
    assertEquals(j.reason,'fresh-cache');assertEquals(j.patterns[0].title,'Old');assertEquals(calls,0);assertEquals('stale' in j,false);
    await s.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-7*3600e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[{title:'Old'}]});
    j=await (await handleApi(mk({action:'patterns'}),s,fetcher,now)).json();
    assertEquals(j.ok,true);assertEquals(j.patterns[0].title,'Old');assertEquals(j.reason,'stale-cache');assertEquals(calls,1);
    const after:any=await s.getKV(PATTERN_CACHE_KEY);assertEquals(after.patterns[0].title,'New race');
  } finally { if(oldKey===undefined)Deno.env.delete('GROQ_API_KEY_1');else Deno.env.set('GROQ_API_KEY_1',oldKey); }
});
Deno.test('news-score pattern pre-warm runs only with ?patterns=1',async()=>{
  const s=new MemoryStore();let calls=0;const fetcher=async()=>{calls++;return new Response('{}',{status:503});};
  assertEquals(await warmPatterns(new Request('http://x/news-score'),s,fetcher),null);assertEquals(calls,0);
  assertEquals(await warmPatterns(new Request('http://x/news-score?patterns=1'),s,fetcher),'done');
});
import {resolvePatternAliases,patternPrompt} from '../functions/_shared/patterns.ts';
Deno.test('patterns prompt uses short aliases and maps them back to real ids',()=>{
  const items=[patternItem('uuid-in','IN',1),patternItem('uuid-cn','CN',2)];
  const p=patternPrompt(items);assert(p.includes('n1|IN'));assert(p.includes('n2|CN'));assertEquals(p.includes('uuid-in|IN'),false);
  const raw={patterns:[{title:'T',pattern:'P',type:'ai-race',signal:'strong',regions:[{region:'IN',what:'a',item_ids:['n1']},{region:'CN',what:'b',item_ids:['N2']}]}]};
  const out=validatePatterns(resolvePatternAliases(raw,items),items);
  assertEquals(out.length,1);assertEquals(out[0].items.map(x=>x.id).sort(),['uuid-cn','uuid-in']);
});
Deno.test('patterns: truncated (finish_reason=length) output is a failure and keeps the good cache',async()=>{
  const oldKey=Deno.env.get('GROQ_API_KEY_1');Deno.env.set('GROQ_API_KEY_1','test-pattern-key');
  const now=new Date('2026-11-27T12:00:00.000Z'),s=new MemoryStore();s.items=[patternItem('in','IN',1),patternItem('cn','CN',2)];
  await s.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-7*3600e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[{title:'Good old'}]});
  const cut=JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"patterns":[{"title":"half'}}],usage:{prompt_tokens:10,completion_tokens:3200}});
  try { const r=await getPatterns(s,async()=>new Response(cut,{status:200}),now,true);assertEquals(r.ok,true);assertEquals(r.reason,'generation-failed');
    const kept:any=await s.getKV(PATTERN_CACHE_KEY);assertEquals(kept.patterns[0].title,'Good old'); }
  finally { if(oldKey===undefined)Deno.env.delete('GROQ_API_KEY_1');else Deno.env.set('GROQ_API_KEY_1',oldKey); }
});
import {stripAliases} from '../functions/_shared/patterns.ts';
Deno.test('patterns: alias leaks are stripped and weak links are dropped, strong first',()=>{
  assertEquals(stripAliases('US: Nvidia pause (n2) | RU: Putin plan (n36, n40)'),'US: Nvidia pause | RU: Putin plan');
  assertEquals(stripAliases('n12: Chip curbs [n3]'),'Chip curbs');
  assertEquals(stripAliases('N95 masks stay'),'N95 masks stay');
  const items=[patternItem('in','IN',1),patternItem('cn','CN',2),patternItem('us','US',3),patternItem('eu','EU',4)];
  const row=(t:string,signal:string,a:string,b:string)=>({title:t,pattern:'Same move (n1)',type:'ai-race',signal,regions:[{region:a==='in'?'IN':'US',what:'x',item_ids:[a]},{region:b==='cn'?'CN':'EU',what:'y',item_ids:[b]}]});
  const out=validatePatterns({patterns:[row('M','medium','in','cn'),row('W','weak','us','eu'),row('S','strong','us','eu')]},items);
  assertEquals(out.map(p=>p.title),['S','M']);assertEquals(out[1].pattern,'Same move');
});
import {selectPatternItems} from '../functions/_shared/patterns.ts';
Deno.test('patterns: item selection is region-balanced so busy regions cannot crowd out others',()=>{
  const now=new Date('2026-11-27T12:00:00.000Z');
  const mk=(id:string,region:any,score:number)=>({...patternItem(id,region,5),score,cluster_key:id});
  const items=[...Array.from({length:10},(_,i)=>mk('us'+i,'US',9)),mk('in0','IN',2),mk('cn0','CN',1),mk('ru0','RU',1)];
  const out=selectPatternItems(items as any,now,6);
  assertEquals(out.map(x=>x.region).sort(),['CN','IN','RU','US','US','US']);
  assertEquals(out[0].id,'us0');
});
import {peekPatterns} from '../functions/_shared/patterns.ts';
Deno.test('patterns: an empty model result keeps a recent good cache; an empty cache goes stale after 1 h',async()=>{
  const oldKey=Deno.env.get('GROQ_API_KEY_1');Deno.env.set('GROQ_API_KEY_1','test-pattern-key');
  const now=new Date('2026-11-27T12:00:00.000Z'),s=new MemoryStore();s.items=[patternItem('in','IN',1),patternItem('cn','CN',2)];
  await s.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-7*3600e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[{title:'Good old'}]});
  const empty=JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"patterns":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
  try {
    const r:any=await getPatterns(s,async()=>new Response(empty,{status:200}),now,true);
    assertEquals(r.reason,'no-new-patterns');assertEquals(r.patterns[0].title,'Good old');
    const e=new MemoryStore();await e.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-61*60e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[]});
    assertEquals((await peekPatterns(e,now))!.stale,true);
    await e.setKV(PATTERN_CACHE_KEY,{generated_at:new Date(now.getTime()-30*60e3).toISOString(),window_h:72,n_items:2,model:'m',patterns:[]});
    assertEquals((await peekPatterns(e,now))!.stale,false);
  } finally { if(oldKey===undefined)Deno.env.delete('GROQ_API_KEY_1');else Deno.env.set('GROQ_API_KEY_1',oldKey); }
});
