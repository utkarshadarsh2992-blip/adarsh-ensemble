export const TAGS = ['AI','BIG-TECH','SPACE','ROBOTICS','PHYSICS','MATH','BIO-CHEM','ECON','WORLD','PAPER'] as const;
export const REGIONS = ['IN','CN','US','RU','EU','WORLD'] as const;
export const ACTIVITIES = ['launch','model','datacentre','funding','acquisition','partnership','ipo','layoffs','policy','research','incident','other'] as const;
export const VERIFIED = ['confirmed','partly','single','state-only','unconfirmed','none'] as const;
export type Tag = typeof TAGS[number];
export type Region = typeof REGIONS[number];
export type Activity = typeof ACTIVITIES[number];
export type Verified = typeof VERIFIED[number];
export type FeedKind = 'rss'|'atom'|'json'|'currents'|'newsdata'|'hf_papers';
export type ItemKind = 'news'|'paper';
export type NewsStatus = 'new'|'scoring'|'scored'|'skipped'|'dropped';

export interface Feed { id:string; url:string; kind:FeedKind; grp:string; region:Region; tag_hint?:Tag|null; state_media:boolean; every_min:number; active:boolean; last_fetch?:string|null; last_status?:number|null; fail_count:number; name:string; }
export interface Source { title:string; url:string; publisher:string; state_media:boolean; }
export interface NewsItem {
  id:string; title:string; points:string[]; tag:Tag; tags:Tag[]; region:Region; company:string; activity:Activity;
  score:number|null; breaking:boolean; verified:Verified; n_sources:number; source:string; url:string;
  published_at:string|null; created_at:string; read_at:string|null; saved:boolean; upvotes:number; kind:ItemKind;
  status:NewsStatus; cluster_key:string|null; title_norm:string|null; feed_id:string|null; raw_summary:string;
  sources:Source[]; why:string; alerted_at:string|null; state_media:boolean; claim_tag:string; scored_at:string|null; tokens:number;
}
export interface Watch { keyword:string; kind:'company'|'topic'|'query'; region:Region; tag_hint?:Tag|null; active:boolean; }
export interface Settings { digest_time:string; tz:string; alerts_per_day:number; alert_min_score:number; list_min_score:number; groq_tokens_cap:number; groq_calls_cap:number; tavily_month_cap:number; tavily_day_cap:number; require_verify:boolean; }
export const DEFAULT_SETTINGS:Settings = { digest_time:'21:30', tz:'Asia/Kolkata', alerts_per_day:5, alert_min_score:8, list_min_score:5, groq_tokens_cap:150000, groq_calls_cap:400, tavily_month_cap:700, tavily_day_cap:20, require_verify:true };
export interface Usage { day:string; provider:string; model:string; stage:string; calls:number; tokens_in:number; tokens_out:number; }
export interface AlertLog { id?:number; news_id?:string|null; channel:'telegram'|'fcm'; kind:'alert'|'digest'|'budget'|'test'|'copy'; ok:boolean; error:string; sent_at:string; day_local:string; }
export interface Device { device_id:string; fcm_token:string; platform:'android'; app_version:string; updated_at:string; }
export type NewsProvider = 'groq'|'tavily';
export interface ProviderKey { slot:number; key:string; generation:string; }
export interface Store {
  listFeeds():Promise<Feed[]>; updateFeed(id:string, patch:Partial<Feed>):Promise<void>; seen(hash:string):Promise<boolean>; markSeen(hash:string):Promise<void>; claimSeen(hash:string):Promise<boolean>;
  insertItem(item:Partial<NewsItem>):Promise<NewsItem>; updateItem(id:string, patch:Partial<NewsItem>):Promise<void>; getItem(id:string):Promise<NewsItem|null>;
  listItems(filter?:Partial<{status:NewsStatus; since:string; limit:number}>):Promise<NewsItem[]>; claimBatch(limit:number):Promise<NewsItem[]>;
  listWatch():Promise<Watch[]>; getSettings():Promise<Settings>; setSettings(patch:Partial<Settings>):Promise<Settings>;
  bumpUsage(u:Omit<Usage,'calls'|'tokens_in'|'tokens_out'> & Partial<Pick<Usage,'calls'|'tokens_in'|'tokens_out'>>):Promise<Usage>;
  getUsage(day:string, provider:string, model:string, stage:string):Promise<Usage>;
  getDevices():Promise<Device[]>; upsertDevice(d:Device):Promise<void>; removeDevice(id:string):Promise<void>;
  addAlert(a:AlertLog):Promise<void>; countAlerts(day:string, kind?:AlertLog['kind']):Promise<number>; listAlerts(day:string, kind?:AlertLog['kind']):Promise<AlertLog[]>;
  getKV(key:string):Promise<unknown>; claimDigest(day:string):Promise<boolean>; claimTavily(day:string,month:string,credits:number,dayCap:number,monthCap:number):Promise<boolean>; claimAlert(newsId:string,day:string):Promise<boolean>; releaseAlert(newsId:string,day:string):Promise<void>; setKV(key:string,value:unknown):Promise<void>; deleteKV(key:string):Promise<void>; clean():Promise<number>;
  /** News-only provider credentials; absent on older Store implementations. */
  getProviderKeys?(provider:NewsProvider):Promise<ProviderKey[]>;
}
export type FetchLike = (input:RequestInfo|URL, init?:RequestInit)=>Promise<Response>;
export const json = (body:unknown, status=200, headers:Record<string,string>={}) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json', ...headers}});
