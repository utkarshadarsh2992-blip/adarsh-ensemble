'use strict';
/* 04-usage.js : API usage screen + hallucination controls (change 1.4).
   - Usage.view: today's requests/tokens, every provider and API key (3 per provider) with its models, per-minute
     rate-limit window, which feature spent the calls, last days, and the rate-limit rules. The numbers come from the
     engine's own counters (health.report): no model call, no network, works with zero keys.
   - Hallucination controls (S.settings.truthLevel strict|balanced|creative, S.settings.factCheck off|auto|always):
     Usage.request() goes to the engine as body.truth. strict = low temperature + "only what a source backs";
     the fact-check is ONE small Groq call after a Standard answer (see truth.py).
   - Usage.extras draws the FACT-CHECK card under an answer; Usage.absorb warns once a day when Groq's quota runs low. */
const Usage = (() => {
  const LEVELS = [['strict', 'Strict'], ['balanced', 'Balanced'], ['creative', 'Creative']];
  const CHECKS = [['off', 'Off'], ['auto', 'Auto'], ['always', 'Hamesha']];
  const LEVEL_NOTE = {
    strict: 'Sabse kam gadbad: temperature 0.2. Number, date ya naam tabhi jab source ya pakka textbook gyaan ho; baaki [ANDAAZA] ya hata diya. Jawab chhota ho sakta hai.',
    balanced: 'Roz ka default: temperature 0.5. Specifics tabhi jab pakka ho; andaaza [ANDAAZA] likha hota hai.',
    creative: 'Naye idea aur analogies khul ke (temperature 0.8), par fact kabhi banaya nahi jata; kalpana [SPECULATION] likhi hoti hai.'
  };
  const CHECK_NOTE = {
    off: 'Koi extra call nahi. Sirf prompt ke niyam aur temperature kaam karte hain.',
    auto: 'Sirf un jawabon par jinme number, paisa, saal ya bahut naam hon. 1 chhota Groq call (gpt-oss-20b). Groq ka quota 20% se neeche ho to skip.',
    always: 'Har Standard jawab ke baad (voice ko chhodkar) 1 chhota Groq call. Quota zyada lagta hai.'
  };
  const FEATURES = { standard: 'Standard jawab', council: 'Council modes', briefing: 'Raat ki briefing', checks: 'Check questions (council)', factcheck: 'Fact-check', guard: 'Paste guard', voice: 'Voice', news: 'News', other: 'Doosra' };
  const STATE = { ok: ['good', 'OK'], low: ['warn', 'Kam bacha'], out: ['bad', 'Limit khatam'], cool: ['warn', 'Ruka hua'], nokey: ['mute', 'Key nahi'], tight: ['warn', 'Kam bacha'] };
  const VERDICT = { ok: 'PAKKA', shak: 'SHAK', galat: 'GALAT' };
  const pick = (list, v, d) => (list.some(x => x[0] === v) ? v : d);
  const level = () => pick(LEVELS, S.settings.truthLevel, 'balanced');
  const check = () => pick(CHECKS, S.settings.factCheck, 'auto');
  const nameOf = (list, v) => (list.find(x => x[0] === v) || [])[1] || '';
  const request = () => ({ level: level(), check: check() });
  const summary = () => nameOf(LEVELS, level()) + ' · fact-check ' + nameOf(CHECKS, check()).toLowerCase();
  let last = null;

  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const fmt = (n) => { n = num(n); return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)); };
  const dur = (s) => { s = Math.max(0, Math.round(num(s))); if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; if (s >= 60) return Math.ceil(s / 60) + 'm'; return s + 's'; };
  const tone = (f) => (f >= 0.95 ? 'bad' : f >= 0.8 ? 'warn' : 'good');
  const bar = (f) => { const p = Math.max(0, Math.min(1, num(f))); return h('div', { class: 'us-bar ' + tone(p), role: 'img', 'aria-label': Math.round(p * 100) + '% use hua' }, h('i', { style: 'width:' + Math.round(p * 100) + '%' })); };
  const pill = (state) => { const [c, t] = STATE[state] || STATE.nokey; return h('span', { class: 'pill ' + c }, t); };
  const small = (t, cls) => h('small', { class: 'us-s' + (cls ? ' ' + cls : '') }, t);
  const lim = (v, l) => v + (l ? ' / ' + l : '');

  /* ---------- engine call ---------- */
  async function load() {
    const B = window.ADARSH_BACKEND;
    const r = await (B && B.usage ? B.usage() : Backend.send({ usage: true }, {}));
    const d = Array.isArray(r) ? r[0] : r;
    if (!d || d.type !== 'usage' || !d.usage || typeof d.usage !== 'object') throw new Error('Is backend se usage nahi aata (demo mode ya purana backend).');
    last = d.usage;
    return last;
  }
  const brief = () => (last ? 'Aaj ' + fmt(last.totals && last.totals.req) + ' requests · ' + fmt(last.totals && last.totals.tok) + ' tokens' : 'Aaj kitna chala, har key ka hisaab');

  /* ---------- hallucination controls ---------- */
  function controls(onChange) {
    const wrap = h('div', { class: 'us-ctl' });
    const group = (title, opts, get, set, notes) => {
      const seg = h('div', { class: 'seg' });
      const note = h('p', { class: 'muted us-note' }, notes[get()]);
      opts.forEach(([v, l]) => seg.append(h('button', { 'aria-pressed': String(get() === v), on: { click: () => {
        set(v); save(); note.textContent = notes[v];
        [...seg.children].forEach((x, i) => x.setAttribute('aria-pressed', String(opts[i][0] === v)));
        if (onChange) onChange();
      } } }, l)));
      wrap.append(h('label', { class: 'l' }, title), seg, note);
    };
    group('Jawab kitna pakka', LEVELS, level, v => { S.settings.truthLevel = v; }, LEVEL_NOTE);
    group('Fact-check (Standard)', CHECKS, check, v => { S.settings.factCheck = v; }, CHECK_NOTE);
    wrap.append(h('p', { class: 'muted us-note' }, 'Council modes (Physics, Math, Business, Coding, Verified) mein apna audit + revise pehle se chalta hai; wahan sirf ye niyam prompt mein jodte hain. Koi AI 100% sach nahi hota: zaroori cheez source se bhi dekho.'));
    return wrap;
  }
  function truthSheet(onChange) {
    sheet({ title: 'Hallucination control', tall: true, build(b) { b.append(controls(onChange), truthStats(last)); } });
  }
  function truthStats(u) {
    const t = (u && u.truth) || {};
    return h('div', { class: 'us-tstats' }, t.answers
      ? h('p', { class: 'muted' }, 'Aaj ' + t.answers + ' jawab fact-check hue: ' + num(t.ok) + ' pakka, ' + num(t.shak) + ' shak, ' + num(t.galat) + ' galat.')
      : h('p', { class: 'muted' }, 'Aaj abhi koi fact-check nahi hua.'));
  }

  /* ---------- usage screen ---------- */
  function topCard(u) {
    const std = u.standard || {};
    const sp = std.state === 'nokey' ? h('span', { class: 'pill mute' }, 'Groq key nahi')
      : h('span', { class: 'pill ' + (STATE[std.state] || STATE.ok)[0] }, 'Standard: Groq ~' + Math.round(num(std.left) * 100) + '% bacha');
    return h('div', { class: 'card us-top' }, h('div', { class: 'card-h' }, h('div', { class: 'grow' },
      h('span', { class: 'k' }, 'AAJ'),
      h('div', { class: 'us-big' }, fmt(u.totals && u.totals.req), h('small', {}, ' requests')),
      h('div', { class: 'us-big us-big2' }, fmt(u.totals && u.totals.tok), h('small', {}, ' tokens')),
      small('App ka din UTC 00:00 (5:30 AM IST) par badalta hai, ' + dur(u.reset_in_s) + ' baad. Provider ka asli reset thoda alag ho sakta hai.'))),
      h('div', { class: 'card-btns' }, sp));
  }
  function modelRow(m) {
    const per = (m.min_req || m.min_tok) ? small('Pichhle 1 min: ' + lim(m.min_req, m.rpm) + ' req · ' + lim(fmt(m.min_tok), m.tpm ? fmt(m.tpm) : 0) + ' tok') : null;
    return h('div', { class: 'us-model' },
      h('div', { class: 'us-mh' }, h('b', {}, String(m.model || '').split('/').pop()), h('span', { class: 'us-n' }, lim(m.req, m.req_limit) + ' req · ' + lim(fmt(m.tok), m.tok_limit ? fmt(m.tok_limit) : 0) + ' tok')),
      m.req_limit || m.tok_limit || m.out_s ? bar(m.frac) : null,
      m.out_s ? small('Provider ne kaha aaj ka quota khatam; ~' + dur(m.out_s) + ' baad dobara dekhega', 'bad') : null,
      m.cool_s ? small('Abhi ' + dur(m.cool_s) + ' ke liye ruka hua', 'warn') : null, per);
  }
  function keyRow(k) {
    const top = (k.models || []).reduce((a, m) => Math.max(a, num(m.frac)), 0);
    const sum = h('summary', { class: 'us-ksum' }, h('span', { class: 'us-kn' }, 'Key ' + k.slot), pill(k.state), h('span', { class: 'sp' }), h('span', { class: 'us-n' }, fmt(k.req) + ' req · ' + fmt(k.tok) + ' tok'));
    const d = h('details', { class: 'us-key', open: ['out', 'cool', 'low'].includes(k.state) ? '' : null }, sum);
    if (!k.set) { d.append(small('Is slot mein key nahi daali. Settings > API keys.')); return d; }
    if (k.state === 'cool') d.append(small('Is key ko ' + dur(k.cool_s) + ' ke liye rok diya (limit, 402 ya server down). Tab tak agli key chalegi.', 'warn'));
    if (top) d.append(bar(top));
    (k.models || []).forEach(m => d.append(modelRow(m)));
    if (!(k.models || []).length) d.append(small('Aaj is key se koi call nahi hui.'));
    return d;
  }
  function providerCard(p) {
    const box = h('div', { class: 'card us-prov' }, h('div', { class: 'card-h' }, h('div', { class: 'grow' },
      h('span', { class: 'k' }, String(p.name || p.id).toUpperCase() + ' · ' + p.set + '/3 KEYS'),
      small(fmt(p.req) + ' requests · ' + fmt(p.tok) + ' tokens aaj'))));
    (p.keys || []).forEach(k => { if (k.set || k.req) box.append(keyRow(k)); });
    if (p.limits) box.append(h('details', { class: 'us-rules' }, h('summary', {}, 'Rate-limit niyam'), small(p.limits)));
    return box;
  }
  function featuresCard(u) {
    const f = u.features || {}, rows = Object.keys(f).filter(k => num(f[k]) > 0).sort((a, b) => f[b] - f[a]);
    const max = rows.length ? num(f[rows[0]]) : 1;
    return h('div', { class: 'card us-feat' }, h('div', { class: 'card-h' }, h('div', { class: 'grow' }, h('span', { class: 'k' }, 'KISNE KHARCHA KIYA'),
      rows.length ? rows.map(k => h('div', { class: 'us-frow' }, h('span', { class: 'us-fn' }, FEATURES[k] || k), h('span', { class: 'us-fb' }, h('i', { style: 'width:' + Math.max(4, Math.round(num(f[k]) / max * 100)) + '%' })), h('span', { class: 'us-n' }, String(f[k]))))
        : small('Aaj abhi koi model call nahi hui.'))));
  }
  function daysCard(u) {
    const ds = (u.days || []).slice(-7), max = Math.max(1, ...ds.map(d => num(d.req)));
    const wd = (s) => { const t = new Date(String(s) + 'T00:00:00Z'); return Number.isNaN(+t) ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]; };
    return h('div', { class: 'card us-feat' }, h('div', { class: 'card-h' }, h('div', { class: 'grow' }, h('span', { class: 'k' }, 'PICHHLE DIN (REQUESTS)'),
      h('div', { class: 'us-days' }, ds.map((d, i) => h('div', { class: 'us-day' + (i === ds.length - 1 ? ' today' : ''), title: d.day + ': ' + d.req + ' req' },
        h('b', {}, fmt(d.req)), h('i', { style: 'height:' + Math.max(3, Math.round(num(d.req) / max * 64)) + 'px' }), h('span', {}, wd(d.day))))),
      ds.length < 2 ? small('Purane din abhi jama ho rahe hain: kal se yahan dikhenge.') : null)));
  }
  function sections(u) {
    const out = [topCard(u)];
    const used = (u.providers || []).filter(p => p.set || p.req);
    used.forEach(p => out.push(providerCard(p)));
    const none = (u.providers || []).filter(p => !p.set && !p.req).map(p => p.name);
    if (!used.length) out.push(h('div', { class: 'pv-empty' }, icon('lock'), h('b', {}, 'Abhi koi API key nahi'), h('span', {}, 'Settings > API keys mein kam se kam ek key daalo.')));
    else if (none.length) out.push(small('Key nahi: ' + none.join(', ') + '.', 'us-none'));
    out.push(featuresCard(u), daysCard(u));
    return out;
  }
  function view(st, redraw) {
    const box = h('div', { class: 'us-box' });
    const fill = (u) => { box.replaceChildren(...sections(u)); };
    const status = h('p', { class: 'muted us-load' }, 'Padh raha hoon…');
    const refresh = () => { status.textContent = 'Padh raha hoon…'; status.hidden = false; load().then(u => { status.hidden = true; fill(u); }).catch(e => { status.hidden = false; status.textContent = (e && e.message) || 'Usage nahi khula.'; }); };
    st.append(h('div', { class: 'sech' }, 'Kitna chala', h('button', { on: { click: refresh } }, 'Refresh')), status, box);
    if (last) fill(last);
    refresh();
  }

  /* ---------- under an answer ---------- */
  function extras(m) {
    const r = m && m.reply, t = r && r.truth;
    if (!t || !Array.isArray(t.claims) || !t.claims.length) return [];
    const bad = num(t.galat), doubt = num(t.shak), tn = bad ? 'bad' : doubt ? 'warn' : 'good';
    const head = h('summary', { class: 'fc-h' }, h('span', { class: 'fc-k' }, icon('shield', 's'), 'FACT-CHECK'),
      h('span', { class: 'fc-b' }, t.basis === 'sources' ? 'SOURCES SE' : 'BINA SOURCE'), h('span', { class: 'sp' }),
      h('span', { class: 'pill ' + tn }, bad ? bad + ' galat' : doubt ? doubt + ' shak' : 'sab pakka'));
    const rows = t.claims.map(c => h('div', { class: 'fc-row ' + c.v }, h('span', { class: 'fc-v' }, VERDICT[c.v] || c.v),
      h('div', { class: 'fc-t' }, h('b', {}, c.c), c.why ? h('small', {}, c.why) : null, c.fix ? h('small', { class: 'fc-fix' }, '→ ' + c.fix) : null)));
    return [h('details', { class: 'fcheck ' + tn, open: bad || doubt ? '' : null }, head, rows,
      h('div', { class: 'fc-f' }, 'Ye bhi ek chhota model hai (gpt-oss-20b, ' + (t.level || level()) + '): galti ho sakti hai. Zaroori cheez source se bhi dekho.'))];
  }
  /* Groq's daily quota is running low: say so once a day (rate limits matter to sir) */
  function absorb(c, r) {
    const q = r && r.quota;
    if (!q || !Number.isFinite(+q.left)) return;
    const day = new Date().toISOString().slice(0, 10);
    if (S.settings.quotaWarnDay === day) return;
    S.settings.quotaWarnDay = day; save();
    toast('Groq ka aaj ka quota ~' + Math.round(+q.left * 100) + '% bacha. Settings > API usage dekho');
  }
  return { request, summary, brief, load, view, controls, truthSheet, extras, absorb, level, check, fmt, dur, last: () => last };
})();
