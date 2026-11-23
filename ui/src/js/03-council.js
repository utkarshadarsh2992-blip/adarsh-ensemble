'use strict';
/* 03-council.js : "Kisne kya socha".
   1) the Thinking block in the chat (live lines while the engine works, "Thought for 38s" afterwards)
   2) the full page behind it: every role's prompt, model, answer, what was dropped, the audit, before/after.
   The data is reply.council (built by council.py). Without it (demo mode, quick replies) only the block is shown. */
const Council = (() => {
  let page = null, sink = null;          // sink: called with each new live step while the page is open in live mode
  const KEEP = 10;                       // full records kept on the phone; older ones are dropped (they are big)
  const MAX_RECORD_BYTES = 512 * 1024;
  const IDX = 'adarsh.cn.idx', PRE = 'adarsh.cn.';
  const mem = new Map();                 // records of this session, even when storage is full or unavailable
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
  const index = () => { try { return JSON.parse(lsGet(IDX) || '[]'); } catch (e) { return []; } };
  const bytes = (v) => { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (e) { return Infinity; } };
  function capRecord(rec) {
    let omitted = false;
    const copy = (v) => {
      if (typeof v === 'string') return v.length > 12000 ? (omitted = true, v.slice(0, 12000) + '…') : v;
      if (Array.isArray(v)) return v.length > 100 ? (omitted = true, v.slice(0, 100).map(copy)) : v.map(copy);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
      return v;
    };
    let out = copy(rec);
    const detailKeys = ['prompt', 'output', 'judge_raw', 'final', 'before', 'after', 'discarded', 'calls', 'drafts', 'steps', 'thinkLines', 'repairs', 'falsifiers', 'proofs', 'claims_map', 'provenance'];
    for (const k of detailKeys) if (bytes(out) > MAX_RECORD_BYTES && out && Object.prototype.hasOwnProperty.call(out, k)) { delete out[k]; omitted = true; }
    const shrink = (v) => {
      if (typeof v === 'string') return v.length > 512 ? (omitted = true, v.slice(0, Math.max(256, Math.floor(v.length / 2))) + '…') : v;
      if (Array.isArray(v)) return v.length > 8 ? (omitted = true, v.slice(0, Math.max(1, Math.floor(v.length / 2))).map(shrink)) : v.map(shrink);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
      return v;
    };
    for (let i = 0; bytes(out) > MAX_RECORD_BYTES && i < 8; i++) out = shrink(out);
    if (bytes(out) > MAX_RECORD_BYTES) { out = { question: String(rec && rec.question || '').slice(0, 1000), _detailsOmitted: true }; omitted = true; }
    if (omitted && out && typeof out === 'object') out._detailsOmitted = true;
    return out;
  }
  /* Records live under their own keys, NOT inside the chat state: one big record must never make saving chats fail. */
  function put(id, rec) {
    rec = capRecord(rec);
    mem.set(id, rec);
    let idx = index().filter(x => x !== id); idx.push(id);
    const text = JSON.stringify(rec);
    while (!lsSet(PRE + id, text) && idx.length > 1) { const old = idx.shift(); lsDel(PRE + old); if (old === id) break; }  // quota: drop the oldest
    while (idx.length > KEEP) lsDel(PRE + idx.shift());
    lsSet(IDX, JSON.stringify(idx));
    if (mem.size > KEEP) mem.delete(mem.keys().next().value);
  }
  function get(id) {
    if (mem.has(id)) return mem.get(id);
    const t = lsGet(PRE + id); if (!t) return null;
    try { const r = capRecord(JSON.parse(t)); mem.set(id, r); return r; } catch (e) { return null; }
  }

  const fmtS = (s) => (s == null ? '' : s >= 60 ? Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's' : (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + 's');
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const pre = (t) => h('pre', { class: 'raw' }, String(t == null ? '' : t));
  const fold = (title, content, open) => { const d = h('details', { class: 'fold' }, h('summary', {}, icon('chev', 'chev'), title), h('div', { class: 'fb' }, content)); if (open) d.open = true; return d; };
  const pill = (t, cls) => h('span', { class: 'pill ' + (cls || 'mute') }, t);
  const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', {}, v));

  /* ---------------------------------------------------------------- inline block */
  function shell(label, onOpen, running) {
    const lines = h('div', { class: 'tl' });
    const chv = h('button', { class: 'chv', 'aria-label': 'Lines dikhao/chhupao', on: { click: (e) => { e.stopPropagation(); el.classList.toggle('open'); lines.scrollTop = lines.scrollHeight; } } }, icon('chev', 'chev'));
    const lab = h('span', { class: 'lab' }, label);
    const head = h('div', { class: 'th' }, running ? h('span', { class: 'dots' }, h('i'), h('i'), h('i')) : null, lab, h('span', { style: 'flex:1' }), chv);
    const el = h('div', { class: 'think2' + (running ? ' run' : ''), role: 'button', tabindex: '0', 'aria-label': 'Poora detail page kholo',
      on: { click: onOpen, keydown: (e) => { if (e.key === 'Enter') onOpen(); } } }, head, lines);
    return { el, lines, lab };
  }
  /* live: returned to runBackend, which pushes each progress line into it */
  function live() {
    const steps = [];
    const s = shell('Thinking', () => open(null, steps), true);
    const api = {
      el: s.el, steps,
      push(t) { steps.push(t); s.lines.append(h('div', { class: 'tline' }, t)); s.lines.scrollTop = s.lines.scrollHeight; if (sink) sink(t); }
    };
    return api;
  }
  /* done: the folded block under a finished reply */
  function done(r) {
    if (!r || !r.councilId) return null;
    const rec0 = get(r.councilId);
    const took = r.took != null ? r.took : (rec0 && rec0.setup && rec0.setup.latency_s);
    const s = shell('Thought for ' + fmtS(took), () => open(get(r.councilId), r.thinkLines || r.steps || [], true), false);
    (r.thinkLines || r.steps || []).forEach(t => s.lines.append(h('div', { class: 'tline' }, t)));
    return s.el;
  }

  /* ---------------------------------------------------------------- page shell */
  function close() { if (page) { page.remove(); page = null; sink = null; } }
  function open(rec, steps, wasRecorded) {
    close();
    const stack = h('div', { class: 'stack cn' });
    const title = h('h1', {}, 'Kisne kya socha');
    page = h('section', { class: 'view on council', role: 'dialog', 'aria-label': 'Kisne kya socha' },
      h('header', { class: 'hdr pad' }, ibtn('back', 'Wapas', close), title, h('span')),
      h('div', { class: 'scroll pad' }, stack));
    $('#phone').append(page);
    if (rec) render(stack, rec);
    else if (wasRecorded) stack.append(h('p', { class: 'muted' }, 'Is jawab ka poora record ab nahi hai: phone par sirf pichhle ' + KEEP + ' jawab ka detail rakha jaata hai (ya storage bhar gaya tha). Neeche jawab ke waqt ki lines hain.'),
      h('div', { class: 'tl big' }, (steps || []).map(t => h('div', { class: 'tline' }, t))));
    else renderLive(stack, steps || []);
  }
  window.__adarshBack = () => { if (page) { close(); return true; } return false; };

  function renderLive(stack, steps) {
    const box = h('div', { class: 'tl big' }, steps.map(t => h('div', { class: 'tline' }, t)));
    stack.append(h('p', { class: 'muted' }, 'Engine abhi kaam kar raha hai. Jawab aate hi yahan har role ka poora detail (prompt, draft, kya hataya gaya) milega. Tab tak lines live dikh rahi hain.'), box);
    sink = (t) => { box.append(h('div', { class: 'tline' }, t)); box.scrollTop = box.scrollHeight; };
  }

  /* ---------------------------------------------------------------- full record */
  const sec = (id, title, sub, ...kids) => h('section', { class: 'csec', id: 'cn-' + id }, h('h2', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, ...kids);

  function render(stack, rec) {
    const calls = rec.calls || [], drafts = rec.drafts || [], su = rec.setup || {};
    const master = su.engine === 'master', ls = rec.lessons || {};
    const byStage = (p) => calls.filter(c => (c.stage || '').startsWith(p));
    const one = (s) => calls.find(c => c.stage === s);
    const letterName = (l) => { const d = drafts.find(x => x.letter === l); return d ? l + ' · ' + d.title : l; };

    const modelLine = (c) => {
      const bits = [];
      if (c.ok === false) bits.push('Fail: koi model jawab nahi de paya');
      else if (c.used) bits.push('Chala: ' + c.used + (c.asked && c.asked !== c.used ? ' (pehle ' + c.asked + ' tha, fallback hua)' : ''));
      if (c.secs != null) bits.push(fmtS(c.secs));
      return bits.join(' · ');
    };
    const skipsEl = (c) => { const e = Object.entries(c.skips || {}); return e.length ? h('div', { class: 'skips' }, e.map(([m, r]) => h('div', {}, '↳ ' + m + ' skip: ' + r))) : null; };
    const promptEl = (c) => (c.prompt && c.prompt.length)
      ? fold('Ise kya mila (poora prompt)', c.prompt.map(m => h('div', {}, h('span', { class: 'k' }, m.role), pre(m.content)))) : null;
    const outputEl = (c, openIt) => c.output ? fold('Poora jawab · ' + String(c.output).split(/\s+/).length + ' shabd', md(c.output), openIt) : null;
    const callCard = (c, extra, openOut) => h('div', { class: 'ccard' + (c.ok === false ? ' bad' : '') },
      h('div', { class: 'ch' }, h('b', {}, c.title || c.stage), pill(c.ok === false ? 'fail' : 'ok', c.ok === false ? 'bad' : 'good')),
      c.brief ? h('p', { class: 'muted' }, c.brief) : null,
      h('div', { class: 'ml' }, modelLine(c)), skipsEl(c), extra, promptEl(c), outputEl(c, openOut));

    /* ---- scorecard */
    const used = {};
    calls.forEach(c => { if (c.ok !== false && c.used) used[c.used] = (used[c.used] || 0) + 1; });
    const failed = calls.filter(c => c.ok === false).length;
    const fallbacks = calls.filter(c => c.ok !== false && c.asked && c.used && c.asked !== c.used).length;
    const pv = rec.provenance, p = rec.patterns || {};
    const cm = rec.claims_map, nClaims = cm ? Object.values(cm.claims || {}).reduce((a, v) => a + v.length, 0) : 0;
    const au = rec.audit || {}, proofs = rec.proofs || [];
    const stat = (k, v, sub) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('b', {}, v), sub ? h('small', {}, sub) : null);
    const panelCalls = byStage('panel:');
    const score = h('div', { class: 'stats' },
      stat('Time', fmtS(su.latency_s) || '—'),
      stat('Drafts', String(drafts.length), (su.user_answers ? su.user_answers + ' tumhare + ' : '') + (su.panel_answers || 0) + ' panel'),
      stat('Fail / fallback', failed + ' / ' + fallbacks, 'model calls'),
      stat('Claims', cm ? String(nClaims) : '—', cm ? (cm.consensus || []).length + ' sahmati, ' + (cm.conflicts || []).length + ' takraav' : 'map nahi bana'),
      master ? stat('Lessons', String((ls.lessons_used || []).length), (ls.repeated || []).length + ' dohraye gaye') : stat('Falsifier', String(Object.keys(rec.falsifiers || {}).length), 'reports'),
      stat(master ? 'Grounding' : (au.label || 'Audit'), au.enabled ? (au.ran ? (au.applied || []).length + ' sudhar' : 'chala nahi') : 'band', au.ran ? (au.unsure || []).length + ' shak' : ''));
    const modelsEl = h('div', { class: 'chips' }, Object.entries(used).map(([m, n]) => h('span', { class: 'chip' }, m + ' ×' + n)));

    /* ---- timeline (tap = jump) */
    const go = (id) => { const t = page && page.querySelector('#cn-' + id); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    const tl = (id, ic, title, note) => h('button', { class: 'tlrow', on: { click: () => go(id) } }, icon(ic, 's'), h('b', {}, title), h('span', { class: 'muted' }, note), icon('chev', 'chev'));
    const nPanelOk = panelCalls.filter(c => c.ok !== false).length;
    const timeline = h('div', { class: 'tlist' },
      tl('setup', 'check', 'Sawaal samjha', (su.task || '') + ' · ' + (su.style || '')),
      rec.roles ? tl('roles', 'check', '11-role council', (rec.roles.mode || '') + ' mode · ' + (rec.roles.sources || []).length + ' sources · confidence ' + (rec.roles.confidence || '—')) : null,
      tl('panel', 'check', master ? 'Tumhare paste kiye answers' : 'Panel ke drafts', master ? drafts.length + ' answers (panel nahi chala)' : nPanelOk + '/' + (panelCalls.length || drafts.length) + ' roles ne diye'),
      master ? null : tl('patterns', 'check', 'Patterns', (rec.patterns && rec.patterns.named) ? rec.patterns.named : 'koi naam nahi mila'),
      tl('claims', 'check', 'Claims map', cm ? nClaims + ' claims' : 'nahi bana'),
      master ? null : tl('fals', 'check', 'Falsifiers', Object.keys(rec.falsifiers || {}).length + ' reports'),
      master ? null : tl('proofs', 'check', 'Code proofs', proofs.length ? proofs.length + ' checks' : (su.style === 'solve' ? 'Android par band' : 'is jawab me nahi')),
      tl('judge', 'check', master ? 'Master answer likha' : 'Judge', (one('judge') || {}).used || '—'),
      tl('repair', 'check', 'Format repair', (rec.repairs || []).length ? (rec.repairs || []).length + ' baar' : 'zaroorat nahi padi'),
      tl('audit', 'check', master ? 'Grounding check' : (au.label || 'Audit'), au.ran ? (au.applied || []).length + ' sudhar, ' + (au.unsure || []).length + ' shak' : (au.enabled ? 'chala nahi' : 'band')),
      master ? tl('lessons', 'check', 'Lessons', (ls.lessons_used || []).length + ' lage, ' + (ls.learned || []).length + ' naye/majboot') : null,
      tl('prov', 'check', 'Kya aaya, kya gaya', 'draft se final tak'));

    if (rec.trimmed || rec._detailsOmitted) stack.append(h('p', { class: 'warn' }, rec._detailsOmitted ? 'Details omitted: council record bahut bada tha, isliye kuch detail phone par nahi rakhi gayi.' : 'Record bada tha, isliye kuch prompts chhote karke dikhaye gaye hain (model ko poore gaye the).'));
    stack.append(
      h('p', { class: 'muted qline' }, '“' + clip(rec.question, 160) + '”'),
      score, modelsEl,
      timeline);

    /* ---- roles (11-role engine) */
    if (rec.roles) {
      const R = rec.roles, src = R.sources || [];
      const linkEl = (x) => { const href = safeExternalUrl(x && x.url), raw = x && typeof x.url === 'string' ? x.url : ''; return href ? h('a', { href, target: '_blank', rel: 'noopener' }, x.title || href) : h('span', {}, x && x.title ? x.title + (raw ? ' (' + raw + ')' : '') : raw); };
      const deb = R.debate || [], rf = R.refiner || {}, rv = R.reviews || {};
      const revLine = (k, n) => { const r = rv[k]; return r ? row(n, r.ran ? (r.issues || []).length + ' galti/shak' : 'output padha nahi gaya') : row(n, 'is mode me nahi chala'); };
      stack.append(sec('roles', '11-role council', 'Architect ne plan banaya, web se sources padhe, drafters ne likha, Skeptic/Falsifier/Debater ne todne ki koshish ki, Judge ne likha, Reviewers ne jaancha, Refiner ne sudhara.',
        h('div', { class: 'ccard' }, row('Mode', R.mode || '—'), row('Format', R.format || '—'),
          row('Confidence', R.confidence || '—'),
          R.quota ? row('Quota', (R.quota.level === 'ok' ? 'theek' : R.quota.level === 'tight' ? 'kam' : 'bahut kam') + ' · ~' + Math.round((R.quota.left || 0) * 100) + '% bacha') : null,
          R.quota && (R.quota.saved || []).length ? h('p', { class: 'warn' }, 'Quota bachane ke liye: ' + R.quota.saved.join(', ')) : null),
        R.combo ? fold((R.combo.title || R.mode) + ' mode ka model combo', h('div', {},
          R.combo.why ? h('p', { class: 'muted' }, R.combo.why) : null,
          h('table', { class: 'combo-t' }, h('tbody', {},
            Object.entries(R.combo.models || {}).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))),
            h('tr', {}, h('td', {}, 'falsifiers'), h('td', {}, (R.combo.falsifiers || []).join(', '))))),
          R.combo.policy ? h('p', { class: 'muted' }, 'Policy: depth ' + R.combo.policy.depth + ' · falsifiers ' + (R.combo.policy.falsifiers || []).join('/') +
            ' · debate ' + R.combo.policy.debate + ' · reviewers fast ' + (R.combo.policy.reviewers_fast || []).join('+') + ', deep ' + (R.combo.policy.reviewers_deep || []).join('+') +
            ' · research ' + R.combo.policy.research + ' (max ' + R.combo.policy.max_sources + ') · code proofs ' + R.combo.policy.code_proofs) : null)) : null,
        R.plan ? fold('Architect ka plan', md(R.plan), true) : null,
        one('architect') ? callCard(one('architect')) : null,
        h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, 'Research'), pill(src.length + ' sources', src.length ? 'good' : 'mute')),
          (R.queries || []).length ? row('Search', (R.queries || []).join(' · ')) : h('p', { class: 'muted' }, 'Architect ne search ki zaroorat nahi samjhi (ya research band hai).'),
          src.length ? h('ol', {}, src.map(x => h('li', {}, '[S' + x.n + '] ', linkEl(x), x.via ? h('span', { class: 'muted' }, ' · ' + x.via) : null))) : null),
        R.skeptic ? fold('Skeptic ke shak', md(R.skeptic)) : null,
        one('skeptic') ? callCard(one('skeptic')) : null,
        R.pattern ? fold('Pattern Finder', md(R.pattern)) : null,
        h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, 'Debate'), pill(deb.length ? deb.length + ' round' : 'skip', deb.length ? 'info' : 'mute')),
          deb.length ? deb.map((t, i) => fold('Round ' + (i + 1), md(t))) : h('p', { class: 'muted' }, R.debate_skipped || 'Debate nahi chala.')),
        byStage('debate:').map(c => callCard(c)),
        h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, 'Reviewers & Refiner')),
          revLine('method', 'Methodology'), revLine('evidence', 'Evidence'),
          row('Refiner', rf.changes ? (rf.changes.length + ' badlav' + ((rf.skipped || []).length ? ', ' + rf.skipped.length + ' chhode' : '')) : 'zaroorat nahi padi'),
          (rf.changes || []).length ? h('ul', {}, rf.changes.map(x => h('li', {}, x))) : null,
          (rf.skipped || []).length ? fold('Refiner ne ye nahi badla', h('ul', {}, rf.skipped.map(x => h('li', {}, x)))) : null)));
    }
    /* ---- setup */
    stack.append(sec('setup', 'Sawaal ka setup', null,
      row('Task', su.task), row('Style', su.style === 'explain' ? 'explain (samjhana)' : 'solve (hal karna)'),
      row('Source', su.source), row('Mode', su.mode + (su.engine ? ' · ' + su.engine + ' engine' : '')),
      row('Depth / language', (su.depth || '') + ' · ' + (su.reply_lang || '')),
      one('classify') ? callCard(one('classify')) : null,
      su.fallback ? h('p', { class: 'warn' }, 'Panel ke kaafi drafts nahi mile, isliye ek akele model ne jawab diya.') : null));

    /* ---- panel + pasted answers */
    const panelKids = [];
    drafts.filter(d => d.kind === 'user').forEach(d => panelKids.push(h('div', { class: 'ccard' },
      h('div', { class: 'ch' }, h('b', {}, 'Tumhara paste kiya: ' + d.title), pill('letter ' + (d.letter || '?'))),
      fold('Poora jawab', md(d.text)),
      (rec.guard && rec.guard[d.name]) ? h('p', { class: 'muted' }, 'Guard: ' + (rec.guard[d.name].flagged ? 'FLAG hua (score ' + Number(rec.guard[d.name].max_score).toFixed(2) + ')' : 'saaf')) : null)));
    panelCalls.forEach(c => {
      const d = drafts.find(x => 'panel:' + x.name === c.stage);
      const bits = [];
      if (d && d.letter) bits.push('Judge ko letter ' + d.letter + ' ke naam se dikha (brand chhupa kar)');
      if (d && cm && cm.claims && cm.claims[d.letter]) bits.push('Claims map me ' + cm.claims[d.letter].length + ' claims');
      if (d && pv && pv.share) bits.push('final ke ' + (pv.share[d.name] || 0) + ' vaakya isse milte hain');
      if (c.stage === 'panel:pattern_finder' && p.named) bits.push('Pattern: ' + p.named);
      panelKids.push(callCard(c, bits.length ? h('div', { class: 'ml' }, bits.join(' · ')) : null));
    });
    if (master) panelKids.push(h('p', { class: 'muted' }, 'Manual mode me panel ke models nahi chalte. Master answer sirf upar ke paste kiye answers se bana.'));
    stack.append(sec('panel', master ? 'Tumhare paste kiye answers' : 'Panel: har role ne kya kiya', 'Har role ko alag soch ka brief mila. Neeche uska prompt, kaun sa model chala, aur poora jawab hai.', panelKids));

    /* ---- patterns */
    if (!master) stack.append(sec('patterns', 'Patterns', 'Pattern finder ne jo naam diya, aur drafts me kya common/alag nikla.',
      row('Pattern finder ka naam', p.named || 'koi pakka pattern nahi mila'),
      (p.shared && p.shared.length) ? h('div', {}, h('span', { class: 'k' }, 'Sab drafts me common'), h('ul', {}, p.shared.map(x => h('li', {}, x)))) : null,
      (p.split && p.split.length) ? h('div', {}, h('span', { class: 'k' }, 'Jahan drafts alag gaye'), h('ul', {}, p.split.map(x => h('li', {}, x)))) : null,
      p.warning ? h('p', { class: 'warn' }, p.warning) : null));

    /* ---- claims map */
    const claimKids = [];
    if (cm) {
      claimKids.push(h('span', { class: 'k' }, 'Sahmati'), h('ul', {}, (cm.consensus || []).map(x => h('li', {}, x))));
      if ((cm.conflicts || []).length) {
        claimKids.push(h('span', { class: 'k' }, 'Takraav'));
        cm.conflicts.forEach(c => claimKids.push(h('div', { class: 'conf' }, h('b', {}, c.issue + ' '), pill(c.kind === 'factual' ? 'factual: sach-jhooth' : 'choice: galti nahi', c.kind === 'factual' ? 'bad' : 'mute'),
          Object.entries(c.positions || {}).map(([l, v]) => h('div', {}, h('span', { class: 'k' }, letterName(l)), ' ' + v)))));
      }
      Object.entries(cm.claims || {}).forEach(([l, list]) => claimKids.push(fold(letterName(l) + ' ke ' + list.length + ' claims', h('ol', {}, list.map(x => h('li', {}, x))))));
    } else claimKids.push(h('p', { class: 'warn' }, 'Tone-stripper claims map nahi bana paya, judge ne seedhe drafts dekhe.'));
    const strip = one('stripper');
    stack.append(sec('claims', 'Claims map (tone-stripper)', 'Drafts se lehja, jazba aur confidence hata kar sirf sidhe claims nikale gaye.',
      claimKids, strip ? callCard(strip) : null));

    /* ---- falsifiers */
    const fk = Object.entries(rec.falsifiers || {});
    if (!master) stack.append(sec('fals', 'Falsifiers', 'Inka kaam sahmati ko todna hai. Model aksar ek jaisi galti saath me karte hain.',
      byStage('falsifier:').map(c => {
        const rep = (rec.falsifiers || {})['Falsifier ' + c.stage.split(':')[1]];  // only when the call itself left no output
        return callCard(c, (!c.output && rep) ? fold('Report', md(rep), true) : null, true);
      }),
      fk.length ? null : h('p', { class: 'warn' }, 'Koi falsifier report nahi mili.')));

    /* ---- proofs */
    if (!master) stack.append(sec('proofs', 'Code proofs', null,
      proofs.length ? proofs.map(x => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, clip(x.claim, 120)), pill(x.status, x.status === 'PASS' ? 'good' : 'bad')),
        fold('Code', pre(x.code)), x.output ? fold('Output', pre(x.output)) : null))
        : h('p', { class: 'muted' }, su.style === 'solve' ? 'Is phone par Python code chalane ki suvidha nahi hai, isliye steps [REASONED] hain, [PROVEN by code] nahi.' : 'Samjhane wale jawab me code-proof nahi chalta.'),
      one('verifier') ? callCard(one('verifier')) : null));

    /* ---- judge */
    const jc = one('judge');
    stack.append(sec('judge', master ? 'Master answer kaise bana' : 'Judge: final jawab kaise bana', master ? 'Ek model ne sirf paste kiye answers ke claims se 7 section wala jawab likha. Har baat par source tag [A], [B] lagta hai.' : 'Judge ne claims map, falsifier reports aur proofs dekh kar jawab likha.',
      jc ? callCard(jc) : h('p', { class: 'warn' }, 'Judge fail hua, sabse lamba draft diya gaya.'),
      rec.judge_raw ? fold('Judge ka pehla jawab (repair/audit se pehle)', md(rec.judge_raw)) : null));

    /* ---- repairs */
    const rp = rec.repairs || [];
    stack.append(sec('repair', 'Format repair', 'Judge ne zaroori section chhod diya to jawab dikhane se pehle dobara likhwaya gaya.',
      rp.length ? rp.map(r => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, 'Koshish ' + r.attempt), pill('gayab: ' + (r.missing || []).join(', '), 'bad')),
        fold('Pehle (adhoora)', md(r.before)), r.after ? fold('Baad me (dobara likha)', md(r.after)) : h('p', { class: 'warn' }, 'Dobara likhwane par bhi jawab nahi aaya.')))
        : h('p', { class: 'muted' }, 'Zaroorat nahi padi, judge ka jawab pehli baar me sahi format me tha.'),
      byStage('repair').map(c => callCard(c))));

    /* ---- audit */
    const key = (i) => (i.quote || '') + '|' + (i.fix || '');
    const applied = new Set((au.applied || []).map(key));
    const auc = one('audit'), rev = one('revise') || one('refine');
    const issueEl = (i) => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, pill(i.confidence || 'low', i.confidence === 'high' ? 'bad' : i.confidence === 'medium' ? 'warn' : 'mute'),
      pill(applied.has(key(i)) ? 'sudhara gaya' : 'sirf shak, badla nahi', applied.has(key(i)) ? 'good' : 'mute')),
      i.quote ? row('Jawab me', '“' + i.quote + '”') : null, row('Galti', i.problem), row('Sahi', i.fix));
    stack.append(sec('audit', master ? 'Grounding check: kya ye answers me hai?' : (au.label === 'Reviewers' ? 'Reviewers + Refiner: final jawab ki jaanch' : 'Audit: doosre model ne fact check kiya'), master ? 'Doosre model ne sirf ye dekha ki har baat kisi paste kiye answer se milti hai ya nahi. Sach-jhooth nahi, sirf "source hai ya nahi".' : 'Judge se alag family ka model. High/medium confidence wali galtiyan rewrite se sudhaari gayin, low sirf shak ke roop me dikhi.',
      !au.enabled ? h('p', { class: 'muted' }, 'Audit band hai.') : null,
      auc ? callCard(auc) : null,
      byStage('review:').map(c => callCard(c)),
      au.ran ? ((au.issues || []).length ? (au.issues || []).map(issueEl) : h('p', { class: 'muted' }, 'Koi galti nahi mili.')) : (au.enabled ? h('p', { class: 'warn' }, 'Audit chala nahi ya uska output padha nahi gaya.') : null),
      rev ? callCard(rev) : null,
      au.before ? fold('Sudhaar se pehle ka jawab', md(au.before)) : null,
      au.after ? fold('Sudhaar ke baad ka jawab', md(au.after), true) : null,
      au.discarded ? h('div', {}, h('p', { class: 'warn' }, 'Rewrite me zaroori section kho gaye the, isliye wo jawab fenk diya gaya.'), fold('Fenka hua rewrite', md(au.discarded))) : null));

    /* ---- lessons (manual master only) */
    if (master) {
      const used = ls.lessons_used || [], rep = new Set(ls.repeated || []);
      stack.append(sec('lessons', 'Lessons: pichhli galtiyon se seekha', 'Model ke weights nahi badalte. Rules ki ek chhoti list har master prompt me jaati hai. Jo rule tootta hai uska wazan badhta hai.',
        used.length ? used.map(x => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, x.title || 'Tumhara rule'), pill(x.origin === 'user' ? 'tumhara' : 'auto', x.origin === 'user' ? 'info' : 'mute'),
          pill(rep.has(x.id) ? 'phir toota' : 'nibhaya', rep.has(x.id) ? 'bad' : 'good')), h('p', {}, x.text)))
          : h('p', { class: 'muted' }, 'Abhi koi lesson nahi tha. Galti pakdi gayi to yahan judega.'),
        (ls.learned || []).length ? h('div', {}, h('span', { class: 'k' }, 'Is baar naya seekha'), h('ul', {}, ls.learned.map(x => h('li', {}, x.kind + (x.new ? ' (naya rule)' : ' (rule majboot)'))))) : null));
    }

    /* ---- provenance */
    if (pv) {
      const total = Object.values(pv.share || {}).reduce((a, b) => a + b, 0) || 1;
      const nm = (n) => { const d = drafts.find(x => x.name === n); return d ? d.title : n; };
      const dropped = Object.entries(pv.dropped || {});
      stack.append(sec('prov', 'Kya aaya, kya gaya', pv.note,
        Object.keys(pv.share || {}).length ? h('div', { class: 'bars' }, Object.entries(pv.share || {}).sort((a, b) => b[1] - a[1]).map(([n, c]) =>
          h('div', { class: 'bar' }, h('span', {}, nm(n)), h('i', { style: 'width:' + Math.round(100 * c / total) + '%' }), h('b', {}, c + ' vaakya')))) : null,
        fold('Final jawab ke vaakya aur unka source', pv.final_sentences.map(s => h('div', { class: 'ps' }, h('span', { class: 'k' }, s.from ? nm(s.from) + ' · ' + s.score : 'naya (kisi draft se nahi mila)'), s.text))),
        dropped.length ? h('div', {}, h('span', { class: 'k' }, 'Drafts ki ye baatein final me nahi aayin'), dropped.map(([n, list]) =>
          fold(nm(n) + ' · ' + list.length, h('ul', {}, list.map(x => h('li', {}, x)))))) : h('p', { class: 'muted' }, 'Drafts ki koi bada hissa chhoota nahi mila.')));
    }

    /* ---- problems + final */
    const errs = Object.entries(rec.errors || {}), ws = rec.warnings || [];
    if (errs.length || ws.length) stack.append(sec('errs', 'Dikkatein', null,
      errs.map(([k, v]) => row(k, clip(v, 400))), ws.map(w => h('p', { class: 'warn' }, w))));
    stack.append(sec('final', 'Final jawab', null, md(rec.final || '')));
  }

  return { live, done, open, close, put, get, KEEP };
})();
