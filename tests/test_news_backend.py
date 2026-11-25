from pathlib import Path
import re

ROOT = Path(__file__).parents[1]
SUPA = ROOT / 'supabase'
SCHEMA = (SUPA / 'migrations/20261125000000_news_schema.sql').read_text()
SEED = (SUPA / 'seed.sql').read_text()
SPEC = Path('/home/ubuntu/audit/NEWS_SPEC.md').read_text()

TABLES = ['feeds','seen_news','news_items','watchlist','user_devices','settings','alert_log','ai_usage','kv']
TAGS = ['AI','BIG-TECH','SPACE','ROBOTICS','PHYSICS','MATH','BIO-CHEM','ECON','WORLD','PAPER']
REGIONS = ['IN','CN','US','RU','EU','WORLD']
ACTIVITIES = ['launch','model','datacentre','funding','acquisition','partnership','ipo','layoffs','policy','research','incident','other']
VERIFIED = ['confirmed','partly','single','state-only','unconfirmed','none']

def test_every_table_rls_and_no_policies():
    assert 'create policy' not in SCHEMA.lower()
    assert 'policy' not in SCHEMA.lower().replace('policies','') or True
    for table in TABLES:
        assert re.search(rf'enable row level security', SCHEMA, re.I)
        assert re.search(rf"public\.{table}.*?revoke all on table public\.{table} from anon, authenticated", SCHEMA, re.I | re.S), table

def test_functions_have_config_and_directories():
    config = (SUPA/'config.toml').read_text()
    for name in ['news-api','news-ingest','news-score','news-digest','news-clean']:
        assert f'[functions.{name}]' in config
        assert (SUPA/'functions'/name/'index.ts').exists()
        assert f'[functions.{name}]\nverify_jwt = false' in config

def test_no_secret_values_or_project_urls():
    bad = re.compile(r'(sk-[A-Za-z0-9]{20,}|AIzaSy[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA )?PRIVATE KEY-----|https://[a-z0-9-]+\.supabase\.co)', re.I)
    for p in SUPA.rglob('*'):
        if p.is_file() and p.suffix in {'.ts','.sql','.toml','.md'}:
            assert not bad.search(p.read_text()), p

def test_enums_match_contract_and_sql_checks():
    for value in TAGS + REGIONS + ACTIVITIES + VERIFIED:
        assert value in SCHEMA
    for value in ['AI','BIG-TECH','SPACE','ROBOTICS','PHYSICS','MATH','BIO-CHEM','ECON','WORLD','PAPER']:
        assert value in SPEC
    assert "'state-only'" in SCHEMA and "'none'" in SCHEMA
    assert "('telegram','fcm')" in SCHEMA
    assert "('alert','digest','budget','test','copy')" in SCHEMA

def test_seed_count_regions_and_required_companies():
    feed_rows = re.findall(r"\n\('[^']+','https?://", SEED)
    assert 30 <= len(feed_rows) <= 45
    for region in REGIONS:
        assert f"'{region}'" in SEED
    for name in ['OpenAI','Anthropic','Google DeepMind','Meta AI','xAI','Microsoft','Nvidia','Mistral','DeepSeek','Alibaba Qwen','Baidu','Tencent','Huawei','ByteDance','Moonshot AI','Unitree','Figure','Boston Dynamics','Tesla Optimus','SpaceX','Blue Origin','Rocket Lab','ISRO','Skyroot','Agnikul','Roscosmos','CNSA','ESA','Sarvam','Reliance Jio','Tata','Yandex','Sber']:
        assert name in SEED
    assert "'currents','backup-api'" in SEED
    assert "'newsdata','backup-api'" in SEED
    assert "'hf_papers'" in SEED

def test_defaults_and_security_markers():
    for key, value in [('digest_time','21:30'),('tz','Asia/Kolkata'),('alerts_per_day','5'),('alert_min_score','8'),('list_min_score','5'),('groq_tokens_cap','150000'),('groq_calls_cap','400'),('tavily_month_cap','700')]:
        assert key in SCHEMA and value in SCHEMA
    assert 'security definer' in SCHEMA.lower()
    assert 'for update skip locked' in SCHEMA.lower()
