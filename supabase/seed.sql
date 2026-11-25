-- Idempotent seed. URLs are public feed endpoints; keys are deliberately not included.
insert into public.feeds(id,url,kind,grp,region,tag_hint,state_media,every_min,name) values
('gn-world-us','https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en','rss','google-world','WORLD','WORLD',false,60,'Google News World US'),
('gn-world-in','https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en','rss','google-world','IN','WORLD',false,60,'Google News India'),
('gn-world-ru','https://news.google.com/rss?hl=en&gl=RU&ceid=RU:en','rss','google-world','RU','WORLD',false,60,'Google News Russia'),
('gn-business-us','https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en','rss','google-topic','US','ECON',false,60,'Google News Business US'),
('gn-business-in','https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en','rss','google-topic','IN','ECON',false,60,'Google News Business India'),
('gn-tech-us','https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en','rss','google-topic','US','BIG-TECH',false,60,'Google News Technology US'),
('gn-tech-in','https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?gl=IN&hl=en-IN&ceid=IN:en','rss','google-topic','IN','BIG-TECH',false,60,'Google News Technology India'),
('gn-science-us','https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en','rss','google-topic','US','PHYSICS',false,60,'Google News Science US'),
('gn-science-in','https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-IN&gl=IN&ceid=IN:en','rss','google-topic','IN','PHYSICS',false,60,'Google News Science India'),
('gn-bigtech','https://news.google.com/rss/search?q=(Nvidia+OR+Apple+OR+Google+OR+Microsoft+OR+OpenAI+OR+Meta+OR+Tesla+OR+TSMC)+when:1h&hl=en-US&gl=US&ceid=US:en','rss','watchlist-bigtech','WORLD','BIG-TECH',false,15,'Google News Big Tech hourly'),
('gn-rocket','https://news.google.com/rss/search?q=(SpaceX+OR+ISRO+OR+NASA+OR+%22rocket+launch%22+OR+astronomy+OR+%22black+hole%22)+when:1h&hl=en-US&gl=US&ceid=US:en','rss','watchlist-space','WORLD','SPACE',false,15,'Google News rockets hourly'),
('gn-bizmoves','https://news.google.com/rss/search?q=(acquisition+OR+merger+OR+IPO+OR+raises+OR+funding+OR+layoffs)+when:1d&hl=en-US&gl=US&ceid=US:en','rss','watchlist-moves','WORLD','ECON',false,30,'Google News business moves'),
('gn-datacentre','https://news.google.com/rss/search?q=(%22data+center%22+OR+%22data+centre%22+OR+compute)+when:1d&hl=en-US&gl=US&ceid=US:en','rss','watchlist-compute','WORLD','AI',false,30,'Google News compute tracker'),
('gn-ai-us','https://news.google.com/rss/search?q=(Anthropic+OR+OpenAI+OR+%22Google+DeepMind%22+OR+%22Meta+AI%22)+(%22launch%22+OR+release+OR+funding+OR+partnership)&when:1d&hl=en-US&gl=US&ceid=US:en','rss','watchlist-ai','US','AI',false,30,'Google News US AI labs'),
('gn-ai-in','https://news.google.com/rss/search?q=(Sarvam+OR+%22Reliance+Jio%22+OR+Tata+OR+%22Skyroot%22+OR+Agnikul)+(launch+OR+funding+OR+model+OR+partnership)&when:1d&hl=en-IN&gl=IN&ceid=IN:en','rss','watchlist-ai','IN','AI',false,30,'Google News India AI and space'),
('gn-ai-cn','https://news.google.com/rss/search?q=(DeepSeek+OR+Alibaba+OR+Qwen+OR+Baidu+OR+Tencent+OR+Huawei)+(launch+OR+funding+OR+model+OR+partnership)&when:1d&hl=en-US&gl=CN&ceid=CN:en','rss','watchlist-ai','CN','AI',false,30,'Google News China AI'),
('gn-ai-ru','https://news.google.com/rss/search?q=(Yandex+OR+Sber+OR+Roscosmos)+(launch+OR+funding+OR+model+OR+partnership)&when:1d&hl=en&gl=RU&ceid=RU:en','rss','watchlist-ai','RU','AI',false,30,'Google News Russia AI'),
('techcrunch','https://techcrunch.com/feed/','rss','publisher-tech','US','BIG-TECH',false,30,'TechCrunch'),
('the-verge','https://www.theverge.com/rss/index.xml','atom','publisher-tech','US','BIG-TECH',false,30,'The Verge'),
('ars-technica','https://feeds.arstechnica.com/arstechnica/index','rss','publisher-tech','US','BIG-TECH',false,30,'Ars Technica'),
('et-default','https://economictimes.indiatimes.com/rssfeedsdefault.cms','rss','publisher-business','IN','ECON',false,30,'Economic Times'),
('et-tech','https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms','rss','publisher-business','IN','BIG-TECH',false,30,'Economic Times Tech'),
('mint-markets','https://www.livemint.com/rss/markets','rss','publisher-business','IN','ECON',false,30,'Mint Markets'),
('scmp-business','https://www.scmp.com/rss/92/feed','rss','publisher-china','CN','ECON',false,30,'SCMP Business'),
('scmp-tech','https://www.scmp.com/rss/36/feed','rss','publisher-china','CN','BIG-TECH',false,30,'SCMP Tech'),
('nasa-news','https://www.nasa.gov/news-release/feed/','rss','publisher-space','US','SPACE',false,30,'NASA News Release'),
('spacenews','https://spacenews.com/feed/','rss','publisher-space','US','SPACE',false,60,'SpaceNews'),
('quanta','https://www.quantamagazine.org/feed/','rss','publisher-science','US','PHYSICS',false,60,'Quanta Magazine'),
('sciencedaily','https://www.sciencedaily.com/rss/all.xml','rss','publisher-science','US','PHYSICS',false,60,'ScienceDaily'),
('nature','https://www.nature.com/nature.rss','rss','publisher-science','EU','PHYSICS',false,60,'Nature'),
('tass-en','https://tass.com/rss/v2.xml','rss','state-media','RU','WORLD',true,30,'TASS English'),
('xinhua-business','https://news.google.com/rss/search?q=site%3Aenglish.news.cn+business&hl=en-US&gl=US&ceid=US:en','rss','state-media','CN','ECON',true,30,'Xinhua Business via Google News'),
('cgtn-business','https://www.cgtn.com/subscribe/rss/section/business.xml','rss','state-media','CN','ECON',true,30,'CGTN Business'),
('arxiv-astro-im','https://rss.arxiv.org/rss/astro-ph.IM','atom','papers-space','WORLD','PAPER',false,1440,'arXiv astro-ph.IM'),
('arxiv-space-ph','https://rss.arxiv.org/rss/physics.space-ph','atom','papers-space','WORLD','PAPER',false,1440,'arXiv physics.space-ph'),
('hf-daily-papers','https://huggingface.co/api/daily_papers?limit=50','hf_papers','papers-ai','WORLD','PAPER',false,1440,'Hugging Face Daily Papers'),
('currents-backup','https://api.currentsapi.services/v1/latest-news','currents','backup-api','WORLD','WORLD',false,480,'Currents optional backup'),
('newsdata-backup','https://newsdata.io/api/1/latest','newsdata','backup-api','WORLD','WORLD',false,480,'NewsData optional backup')
on conflict (id) do nothing;

insert into public.watchlist(keyword,kind,region,tag_hint) values
('OpenAI','company','US','AI'),('Anthropic','company','US','AI'),('Google DeepMind','company','US','AI'),('Meta AI','company','US','AI'),('xAI','company','US','AI'),('Microsoft','company','US','BIG-TECH'),('Nvidia','company','US','BIG-TECH'),('Mistral','company','EU','AI'),('DeepSeek','company','CN','AI'),('Alibaba Qwen','company','CN','AI'),('Baidu','company','CN','AI'),('Tencent','company','CN','BIG-TECH'),('Huawei','company','CN','BIG-TECH'),('ByteDance','company','CN','BIG-TECH'),('Moonshot AI','company','CN','AI'),('Unitree','company','CN','ROBOTICS'),('Figure','company','US','ROBOTICS'),('Boston Dynamics','company','US','ROBOTICS'),('Tesla Optimus','company','US','ROBOTICS'),('SpaceX','company','US','SPACE'),('Blue Origin','company','US','SPACE'),('Rocket Lab','company','US','SPACE'),('ISRO','company','IN','SPACE'),('Skyroot','company','IN','SPACE'),('Agnikul','company','IN','SPACE'),('Roscosmos','company','RU','SPACE'),('CNSA','company','CN','SPACE'),('ESA','company','EU','SPACE'),('Sarvam','company','IN','AI'),('Reliance Jio','company','IN','BIG-TECH'),('Tata','company','IN','ECON'),('Yandex','company','RU','AI'),('Sber','company','RU','AI'),('rocket launch','topic','WORLD','SPACE'),('propulsion','topic','WORLD','SPACE'),('data center','topic','WORLD','AI'),('data centre','topic','WORLD','AI'),('funding','topic','WORLD','ECON'),('acquisition','topic','WORLD','ECON'),('partnership','topic','WORLD','ECON'),('layoffs','topic','WORLD','ECON'),('model release','topic','WORLD','AI'),('robotics breakthrough','topic','WORLD','ROBOTICS'),('business moves','query','WORLD','ECON'),('AI labs launch','query','WORLD','AI')
on conflict (keyword) do nothing;

update public.feeds set active=false where id in ('currents-backup','newsdata-backup');
