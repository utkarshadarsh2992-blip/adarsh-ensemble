import type {Feed, NewsItem, Source, Tag, FetchLike, Store} from './types.ts';

const clean = (s:string) => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
export function decodeEntities(s:string):string { return s.replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'").replace(/&#39;/g,"'").replace(/&#x27;/gi,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))); }
function tag(xml:string, name:string):string { const m=xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,'i')); return m?clean(m[1]):''; }
function attr(xml:string, name:string):string { const m=xml.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)`, 'i')); return m?decodeEntities(m[1]):''; }
export interface Parsed { title:string; url:string; summary:string; published_at:string|null; publisher:string; source_url:string; }
export function parseFeed(xml:string, cap=30):Parsed[] {
  const body=xml.slice(0, Math.min(xml.length, 2_000_000));
  const atom=/<feed\b/i.test(body) || /<entry\b/i.test(body) && !/<item\b/i.test(body);
  const blocks=[...body.matchAll(new RegExp(atom?'(?:<entry\\b[\\s\\S]*?<\\/entry>)':'(?:<item\\b[\\s\\S]*?<\\/item>)','gi'))].slice(0,cap).map(x=>x[0]);
  return blocks.map(b=>{
    const title=tag(b,'title'); const summary=tag(b,atom?'summary':'description')||tag(b,'content:encoded');
    let url=tag(b,'link')||attr(b,'link'); if(atom && !url){ const lm=b.match(/<link\b[^>]*href=["']([^"']+)/i); url=lm?lm[1]:''; }
    const published=tag(b,'pubDate')||tag(b,'published')||tag(b,'updated')||tag(b,'dc:date');
    const source=tag(b,'source')||tag(b,'author')||''; const sm=b.match(/<source\b[^>]*>/i); const sourceUrl=sm?attr(sm[0],'url'):'';
    return {title,url:normalizeUrl(url),summary,published_at:published?parseDate(published):null,publisher:clean(source),source_url:normalizeUrl(sourceUrl)};
  }).filter(x=>x.title && x.url);
}
export function parseDate(s:string):string|null { const d=new Date(s); return Number.isNaN(d.getTime())?null:d.toISOString(); }
export function normalizeUrl(raw:string):string { try { const u=new URL(raw.trim()); for(const k of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid']) u.searchParams.delete(k); u.hash=''; return u.toString(); } catch { return raw.trim(); } }
export async function sha256(s:string):Promise<string> { const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export function titleNorm(title:string):string { return clean(title).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(); }
const stop=new Set('the a an and or to of in on for from with after before is are was were this that news says report reports latest as at by into its their his her'.split(' '));
export function tokens(title:string):Set<string> { return new Set(titleNorm(title).split(' ').filter(x=>x.length>2&&!stop.has(x))); }
export function jaccard(a:string,b:string):number { const x=tokens(a),y=tokens(b); let n=0; for(const z of x) if(y.has(z)) n++; return n/Math.max(1,x.size+y.size-n); }
export async function findCluster(title:string, store:Store, now=Date.now()):Promise<string|null> { const recent=await store.listItems({since:new Date(now-48*3600e3).toISOString(),limit:500}); const hit=recent.find(x=>jaccard(title,x.title)>=0.55); return hit?.cluster_key||hit?.id||null; }
const mission=/\b(ai|model|llm|chip|gpu|compute|data cent(?:er|re)|rocket|launch|spacecraft|propulsion|orbit|robot|humanoid|physics|quantum|biology|chemistry|mathematics|science|acquisition|merger|funding|ipo|layoffs|policy|research|satellite|deepmind|openai|anthropic|nvidia|isro|spacex|skyroot|agnikul)\b/i;
const fluff=/\b(celebrity|sports|football|cricket|recipe|horoscope|fashion|reality tv|movie review)\b/i;
export function relevant(title:string, summary:string, feed:Feed, watches:string[]):boolean { const text=`${title} ${summary}`; if(fluff.test(text)&&!mission.test(text)) return false; return Boolean(feed.tag_hint||mission.test(text)||watches.some(w=>text.toLowerCase().includes(w.toLowerCase()))); }
export function isStateMedia(url:string, feedFlag:boolean):boolean { const domains=['tass.com','tass.ru','xinhuanet.com','news.cn','cgtn.com','globaltimes.cn','chinadaily.com.cn','people.cn','ria.ru','sputniknews.com','rt.com','pib.gov.in','ddnews.gov.in','airnews.gov.in','presstv.ir','voanews.com']; try { return feedFlag||domains.some(d=>new URL(url).hostname.endsWith(d)); } catch { return feedFlag; } }
function safeFeedUrl(raw:string): URL | null {
  try {
    const u=new URL(raw.trim());
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash)return null;
    const h=u.hostname.toLowerCase();
    if(h==='localhost'||h.endsWith('.localhost')||h==='metadata.google.internal'||h==='metadata'||h.endsWith('.local'))return null;
    if(/^\d+$/.test(h)||/^0x[0-9a-f]+$/i.test(h)||h.includes(':'))return null;
    const parts=h.split('.').map(Number);
    if(parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255))return null;
    return u;
  }catch{return null}
}
export async function fetchFeed(feed:Feed, fetcher:FetchLike=fetch, cap=30):Promise<{items:Parsed[];status:number;bytes:number;error?:string}> {
  const url=safeFeedUrl(feed.url); if(!url)return {items:[],status:0,bytes:0,error:'Feed URL rejected'};
  const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),8000);
  try {
    const r=await fetcher(feed.url,{redirect:'error',headers:{'user-agent':'AdarshNews/1.0','accept':'application/rss+xml, application/atom+xml, application/json'},signal:ctl.signal});
    const contentType=(r.headers.get('content-type')||'').toLowerCase();
    if(!r.ok)return {items:[],status:r.status,bytes:0,error:`HTTP ${r.status}`};
    if(contentType&&!/(xml|rss|atom|json|text\/plain)/i.test(contentType))return {items:[],status:415,bytes:0,error:'Unsupported feed content type'};
    const text=await r.text(); if(new TextEncoder().encode(text).byteLength>2_000_000)return {items:[],status:413,bytes:2_000_001,error:'Feed too large'};
    if(feed.kind==='json'||feed.kind==='hf_papers')return {items:parseJsonFeed(text,cap),status:r.status,bytes:text.length};
    return {items:parseFeed(text,cap),status:r.status,bytes:text.length};
  }catch(e){return {items:[],status:0,bytes:0,error:String(e).slice(0,180)}} finally{clearTimeout(timer)}
}
function parseJsonFeed(text:string,cap:number):Parsed[] { try { const j=JSON.parse(text); const rows=Array.isArray(j)?j:(j.articles||j.data||j.items||j.papers||[]); return rows.slice(0,cap).map((x:any)=>({title:clean(x.title||x.paper?.title||''),url:normalizeUrl(x.url||x.link||x.paper?.url||x.paper?.arxiv_id||''),summary:clean(x.description||x.summary||x.abstract||x.paper?.summary||''),published_at:parseDate(x.published||x.published_at||x.created_at||''),publisher:clean(x.source||x.publisher||x.paper?.authors?.[0]||''),source_url:''})).filter((x:Parsed)=>x.title&&x.url); } catch { return []; } }
export function sourceFor(parsed:Parsed, originalUrl:string, state:boolean):Source { let publisher=parsed.publisher; try { if(!publisher) publisher=new URL(parsed.url).hostname.replace(/^www\./,''); } catch {} return {title:parsed.title,url:parsed.source_url||parsed.url,publisher,state_media:isStateMedia(parsed.source_url||parsed.url,state)}; }
export function feedTag(feed:Feed):Tag { return (feed.tag_hint||'WORLD') as Tag; }
