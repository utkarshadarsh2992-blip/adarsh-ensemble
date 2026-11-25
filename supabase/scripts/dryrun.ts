import {MemoryStore} from '../functions/_shared/store.ts';import {run} from '../functions/news-ingest/index.ts';
const store=new MemoryStore();
const seed=await (await fetch(new URL('../seed.sql',import.meta.url))).text().catch(()=> '');
const urls=[
 ['gn-world-us','https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en'],['gn-tech-us','https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en'],['techcrunch','https://techcrunch.com/feed/'],['the-verge','https://www.theverge.com/rss/index.xml'],['ars-technica','https://feeds.arstechnica.com/arstechnica/index'],['nasa-news','https://www.nasa.gov/news-release/feed/'],['scmp-tech','https://www.scmp.com/rss/36/feed'],['arxiv-space-ph','https://rss.arxiv.org/rss/physics.space-ph']];
for(const [id,url] of urls)store.feeds.push({id,url,kind:'rss',grp:'dryrun',region:'WORLD',tag_hint:'WORLD',state_media:false,every_min:60,active:true,fail_count:0,name:id});
const t=performance.now(),result=await run(store,fetch);console.log(JSON.stringify({summary:result,total_ms:Math.round(performance.now()-t),items:store.items.length,parse_errors:result.errors,per_feed:result.per_feed},null,2));
