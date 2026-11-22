'use strict';
/* 03-council.js : "Kisne kya socha".
   1) the Thinking block in the chat (live lines while the engine works, "Thought for 38s" afterwards)
   2) the full page behind it: every role's prompt, model, answer, what was dropped, the audit, before/after.
   The data is reply.council (built by council.py). Without it (demo mode, quick replies) only the block is shown. */
const Council = (() => {
  let page = null, sink = null;          // sink: called with each new live step while the page is open in live mode
  const KEEP = 10;                       // full records kept on the phone; older ones are dropped (they are big)
  const IDX = 'adarsh.cn.idx', PRE = 'adarsh.cn.';
  const mem = new Map();                 // records of this session, even when storage is full or unavailable
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
  const index = () => { try { return JSON.parse(lsGet(IDX) || '[]'); } catch (e) { return []; } };
  /* Records live under their own keys, NOT inside the chat state: one big record must never make saving chats fail. */
  function put(id, rec) {
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
    try { const r = JSON.parse(t); mem.set(id, r); return r; } catch (e) { return null; }
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
      stat('Falsifier', String(Object.keys(rec.falsifiers || {}).length), 'reports'),
      stat('Audit', au.enabled ? (au.ran ? (au.applied || []).length + ' sudhar' : 'chala nahi') : 'band', au.ran ? (au.unsure || []).length + ' shak' : ''));
    const modelsEl = h('div', { class: 'chips' }, Object.entries(used).map(([m, n]) => h('span', { class: 'chip' }, m + ' ×' + n)));

    /* ---- timeline (tap = jump) */
    const go = (id) => { const t = page && page.querySelector('#cn-' + id); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    const tl = (id, ic, title, note) => h('button', { class: 'tlrow', on: { click: () => go(id) } }, icon(ic, 's'), h('b', {}, title), h('span', { class: 'muted' }, note), icon('chev', 'chev'));
    const nPanelOk = panelCalls.filter(c => c.ok !== false).length;
    const timeline = h('div', { class: 'tlist' },
      tl('setup', 'check', 'Sawaal samjha', (su.task || '') + ' · ' + (su.style || '')),
      tl('panel', 'check', 'Panel ke drafts', nPanelOk + '/' + (panelCalls.length || drafts.length) + ' roles ne diye'),
      tl('patterns', 'check', 'Patterns', (rec.patterns && rec.patterns.named) ? rec.patterns.named : 'koi naam nahi mila'),
      tl('claims', 'check', 'Claims map', cm ? nClaims + ' claims' : 'nahi bana'),
      tl('fals', 'check', 'Falsifiers', Object.keys(rec.falsifiers || {}).length + ' reports'),
      tl('proofs', 'check', 'Code proofs', proofs.length ? proofs.length + ' checks' : (su.style === 'solve' ? 'Android par band' : 'is jawab me nahi')),
      tl('judge', 'check', 'Judge', (one('judge') || {}).used || '—'),
      tl('repair', 'check', 'Format repair', (rec.repairs || []).length ? (rec.repairs || []).length + ' baar' : 'zaroorat nahi padi'),
      tl('audit', 'check', 'Audit', au.ran ? (au.applied || []).length + ' sudhar, ' + (au.unsure || []).length + ' shak' : (au.enabled ? 'chala nahi' : 'band')),
      tl('prov', 'check', 'Kya aaya, kya gaya', 'draft se final tak'));

    if (rec.trimmed) stack.append(h('p', { class: 'warn' }, 'Record bada tha, isliye kuch prompts chhote karke dikhaye gaye hain (model ko poore gaye the).'));
    stack.append(
      h('p', { class: 'muted qline' }, '“' + clip(rec.question, 160) + '”'),
      score, modelsEl,
      timeline);

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
    stack.append(sec('panel', 'Panel: har role ne kya kiya', 'Har role ko alag soch ka brief mila. Neeche uska prompt, kaun sa model chala, aur poora jawab hai.', panelKids));

    /* ---- patterns */
    stack.append(sec('patterns', 'Patterns', 'Pattern finder ne jo naam diya, aur drafts me kya common/alag nikla.',
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
        cm.conflicts.forEach(c => claimKids.push(h('div', { class: 'conf' }, h('b', {}, c.issue),
          Object.entries(c.positions || {}).map(([l, v]) => h('div', {}, h('span', { class: 'k' }, letterName(l)), ' ' + v)))));
      }
      Object.entries(cm.claims || {}).forEach(([l, list]) => claimKids.push(fold(letterName(l) + ' ke ' + list.length + ' claims', h('ol', {}, list.map(x => h('li', {}, x))))));
    } else claimKids.push(h('p', { class: 'warn' }, 'Tone-stripper claims map nahi bana paya, judge ne seedhe drafts dekhe.'));
    const strip = one('stripper');
    stack.append(sec('claims', 'Claims map (tone-stripper)', 'Drafts se lehja, jazba aur confidence hata kar sirf sidhe claims nikale gaye.',
      claimKids, strip ? callCard(strip) : null));

    /* ---- falsifiers */
    const fk = Object.entries(rec.falsifiers || {});
    stack.append(sec('fals', 'Falsifiers', 'Inka kaam sahmati ko todna hai. Model aksar ek jaisi galti saath me karte hain.',
      byStage('falsifier:').map(c => {
        const rep = (rec.falsifiers || {})['Falsifier ' + c.stage.split(':')[1]];  // only when the call itself left no output
        return callCard(c, (!c.output && rep) ? fold('Report', md(rep), true) : null, true);
      }),
      fk.length ? null : h('p', { class: 'warn' }, 'Koi falsifier report nahi mili.')));

    /* ---- proofs */
    stack.append(sec('proofs', 'Code proofs', null,
      proofs.length ? proofs.map(x => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, h('b', {}, clip(x.claim, 120)), pill(x.status, x.status === 'PASS' ? 'good' : 'bad')),
        fold('Code', pre(x.code)), x.output ? fold('Output', pre(x.output)) : null))
        : h('p', { class: 'muted' }, su.style === 'solve' ? 'Is phone par Python code chalane ki suvidha nahi hai, isliye steps [REASONED] hain, [PROVEN by code] nahi.' : 'Samjhane wale jawab me code-proof nahi chalta.'),
      one('verifier') ? callCard(one('verifier')) : null));

    /* ---- judge */
    const jc = one('judge');
    stack.append(sec('judge', 'Judge: final jawab kaise bana', 'Judge ne claims map, falsifier reports aur proofs dekh kar jawab likha.',
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
    const auc = one('audit'), rev = one('revise');
    const issueEl = (i) => h('div', { class: 'ccard' }, h('div', { class: 'ch' }, pill(i.confidence || 'low', i.confidence === 'high' ? 'bad' : i.confidence === 'medium' ? 'warn' : 'mute'),
      pill(applied.has(key(i)) ? 'sudhara gaya' : 'sirf shak, badla nahi', applied.has(key(i)) ? 'good' : 'mute')),
      i.quote ? row('Jawab me', '“' + i.quote + '”') : null, row('Galti', i.problem), row('Sahi', i.fix));
    stack.append(sec('audit', 'Audit: doosre model ne fact check kiya', 'Judge se alag family ka model. High/medium confidence wali galtiyan rewrite se sudhaari gayin, low sirf shak ke roop me dikhi.',
      !au.enabled ? h('p', { class: 'muted' }, 'Audit band hai.') : null,
      auc ? callCard(auc) : null,
      au.ran ? ((au.issues || []).length ? (au.issues || []).map(issueEl) : h('p', { class: 'muted' }, 'Koi galti nahi mili.')) : (au.enabled ? h('p', { class: 'warn' }, 'Audit chala nahi ya uska output padha nahi gaya.') : null),
      rev ? callCard(rev) : null,
      au.before ? fold('Sudhaar se pehle ka jawab', md(au.before)) : null,
      au.after ? fold('Sudhaar ke baad ka jawab', md(au.after), true) : null,
      au.discarded ? h('div', {}, h('p', { class: 'warn' }, 'Rewrite me zaroori section kho gaye the, isliye wo jawab fenk diya gaya.'), fold('Fenka hua rewrite', md(au.discarded))) : null));

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
