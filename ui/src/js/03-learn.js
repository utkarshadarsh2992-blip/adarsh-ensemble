'use strict';
/* 03-learn.js : how sir learns (change 1.2).
   - Check questions (reply.learn.checks): MCQ when the question has options, otherwise fill-in. Checked here on the
     phone, so checking costs no tokens. Result is kept on the reply (q.res) and in S.learnLog.
   - Seekhe shabd (S.vocab): every new word an answer explained is saved at once (a word counts as learned when it
     has been explained) and sent back with each request as learn.known, so no mode explains it again.
     Settings > Seekhna > Seekhe shabd lists, searches, adds and deletes them.
   - Standard 2.9 replies carry reply.deeper: "Gehrai mein jao" asks the same question again in 9.2 style.
   Reply shape: learn = { concept, heavy, checks: [{kind:'mcq', q, options, answer:index, why} | {kind:'fill', q,
   answer, accept, why}], words: [{w, m}] }, deeper = { q }. */
const Learn = (() => {
  const MAX_VOCAB = 5000, MAX_LOG = 3000, SEND = 150;
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const vocab = () => (Array.isArray(S.vocab) ? S.vocab : (S.vocab = []));
  const log = () => (Array.isArray(S.learnLog) ? S.learnLog : (S.learnLog = []));
  const has = (w) => { const k = w.toLowerCase(); return vocab().some(x => x.w.toLowerCase() === k); };
  const LETTERS = 'ABCDEF';

  /* ---------- learned words ---------- */
  function known(n = SEND) { return vocab().slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, n).map(x => x.w); }
  function addWord(w, m, src) {
    w = clean(w, 40); m = clean(m, 160);
    if (!w || has(w)) return false;
    vocab().unshift({ id: uid('w'), w, m, src: clean(src, 80), ts: Date.now() });
    if (vocab().length > MAX_VOCAB) vocab().length = MAX_VOCAB;
    return true;
  }
  function absorb(r) {
    const L = r && r.learn;
    if (!L || !Array.isArray(L.words)) return 0;
    let n = 0;
    L.words.forEach(x => { if (x && addWord(x.w, x.m, L.concept)) n++; });
    if (n) { save(); Bus.emit('vocab:changed'); }
    return n;
  }
  const request = () => ({ known: known(), checks: S.settings.checks !== false });
  /* import: same caps and types as everything else (audit M8) */
  function cleanImport(d) {
    const out = {};
    if (Array.isArray(d.vocab)) {
      const seen = new Set();
      out.vocab = d.vocab.slice(0, MAX_VOCAB).filter(x => x && typeof x === 'object').map(x => ({ id: clean(x.id, 40) || uid('w'), w: clean(x.w, 40), m: clean(x.m, 160), src: clean(x.src, 80), ts: +x.ts || Date.now() }))
        .filter(x => x.w && !seen.has(x.w.toLowerCase()) && seen.add(x.w.toLowerCase()));
    }
    if (Array.isArray(d.learnLog)) out.learnLog = d.learnLog.slice(0, MAX_LOG).filter(x => x && typeof x === 'object').map(x => ({ ts: +x.ts || 0, concept: clean(x.concept, 80), q: clean(x.q, 300), ok: x.ok === true, mode: clean(x.mode, 20) }));
    return out;
  }

  /* ---------- checking an answer (no model call) ---------- */
  const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}.+\-/]+/gu, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, '').trim();
  const num = (s) => { const m = /^\s*([-+]?\d+(?:\.\d+)?)/.exec(String(s == null ? '' : s).replace(/,/g, '')); return m ? parseFloat(m[1]) : NaN; };
  function same(given, ans) {
    const g = norm(given), a = norm(ans);
    if (!g || !a) return false;
    if (g === a) return true;
    const gn = num(given), an = num(ans);
    if (!Number.isNaN(gn) && !Number.isNaN(an) && /^[-+]?\d/.test(String(given).trim()) && /^[-+]?\d/.test(String(ans).trim()))
      return Math.abs(gn - an) <= 1e-9 + Math.abs(an) * 0.01;
    return a.length >= 4 && g.includes(a) && g.length <= a.length * 3;    /* "inertia hai" still counts */
  }
  function isRight(q, given) {
    if (q.kind === 'mcq') return given === q.answer;
    return [q.answer, ...(Array.isArray(q.accept) ? q.accept : [])].some(a => same(given, a));
  }
  function record(r, q, given) {
    q.res = { given, ok: isRight(q, given), ts: Date.now() };
    log().unshift({ ts: q.res.ts, concept: clean(r.learn.concept, 80), q: clean(q.q, 300), ok: q.res.ok, mode: clean(r.uiMode || 'standard', 20) });
    if (log().length > MAX_LOG) log().length = MAX_LOG;
    vibe(q.res.ok ? 10 : 30); save(); Bus.emit('learn:answered', { ok: q.res.ok });
  }
  function stats(days = 7) {
    const since = Date.now() - days * 864e5, rows = log().filter(x => x.ts >= since);
    return { total: rows.length, ok: rows.filter(x => x.ok).length };
  }

  /* ---------- check card ---------- */
  function card(r, ctx) {
    const L = r.learn, qs = (L && Array.isArray(L.checks) ? L.checks : []).filter(q => q && q.q);
    if (!qs.length) return null;
    const done = qs.filter(q => q.res).length, right = qs.filter(q => q.res && q.res.ok).length;
    const el = h('div', { class: 'card lcheck', role: 'group', 'aria-label': 'Check questions' },
      h('div', { class: 'lc-h' }, h('span', { class: 'lc-k' }, 'CHECK'), h('span', { class: 'lc-c' }, L.concept || 'Concept'),
        L.heavy ? h('span', { class: 'lc-tag' }, 'REASONING') : null, h('span', { class: 'sp' }),
        h('span', { class: 'lc-s', 'aria-label': 'Score' }, done ? right + '/' + qs.length : '0/' + qs.length)));
    qs.forEach((q, i) => el.append(questionEl(r, q, i, ctx)));
    el.append(h('div', { class: 'lc-f' }, done === qs.length
      ? (right === qs.length ? 'Sab sahi. Concept pakka.' : 'Galat wale dobara padho: neeche "kyun" likha hai.')
      : 'Phone par check hota hai · 0 token'));
    return el;
  }
  function questionEl(r, q, i, ctx) {
    const head = h('div', { class: 'lc-q' }, h('span', { class: 'lc-n' }, 'Q' + (i + 1)), h('span', { class: 'lc-kind' }, q.kind === 'mcq' ? 'MCQ' : 'FILL'), h('p', {}, q.q));
    const box = h('div', { class: 'lc-item' + (q.res ? (q.res.ok ? ' ok' : ' bad') : '') }, head);
    if (q.kind === 'mcq') {
      const opts = h('div', { class: 'lc-opts', role: 'radiogroup', 'aria-label': 'Q' + (i + 1) + ' options' });
      (q.options || []).forEach((o, k) => {
        const st = q.res ? (k === q.answer ? ' right' : k === q.res.given ? ' wrong' : ' dim') : '';
        opts.append(h('button', { class: 'lc-opt' + st, role: 'radio', 'aria-checked': String(!!q.res && q.res.given === k), disabled: !!q.res,
          on: { click: () => { if (q.res) return; record(r, q, k); ctx.redraw(); } } }, h('span', { class: 'lc-l' }, LETTERS[k] || String(k + 1)), h('span', {}, o)));
      });
      box.append(opts);
    } else if (!q.res) {
      const inp = h('input', { type: 'text', class: 'lc-in', placeholder: 'Jawab likho…', 'aria-label': 'Q' + (i + 1) + ' answer', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: q.draft || '',
        on: { input: () => { q.draft = inp.value; go.disabled = !inp.value.trim(); }, keydown: (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); submit(); } } } });
      const submit = () => { const v = inp.value.trim(); if (!v) return; delete q.draft; record(r, q, v.slice(0, 120)); ctx.redraw(); };
      const go = h('button', { class: 'btn pri lc-go', disabled: !(q.draft || '').trim(), on: { click: submit } }, 'Check');
      box.append(h('div', { class: 'lc-fill' }, inp, go),
        h('button', { class: 'link lc-skip', on: { click: () => { delete q.draft; record(r, q, ''); ctx.redraw(); } } }, 'Pata nahi · jawab dikhao'));
    } else {
      box.append(h('div', { class: 'lc-res' }, h('span', {}, 'Tumhara: ', h('b', {}, q.res.given || '—')), q.res.ok ? null : h('span', {}, 'Sahi: ', h('b', {}, q.answer))));
    }
    if (q.res) box.append(h('div', { class: 'lc-why' }, h('b', {}, q.res.ok ? 'Sahi. ' : 'Galat. '), q.why ? 'Kyun: ' + q.why : ''));
    return box;
  }

  /* ---------- under the answer: new words + "Gehrai mein jao" ---------- */
  function extras(m, ctx) {
    const r = m.reply, out = [];
    const L = r.learn;
    if (L && Array.isArray(L.words) && L.words.length) {
      out.push(h('button', { class: 'lwords', 'aria-label': 'Naye shabd, Seekhe shabd kholo', on: { click: vocabSheet } }, icon('book', 's'),
        h('span', { class: 'lw-k' }, 'NAYE SHABD'), h('span', { class: 'lw-t' }, L.words.map(w => w.w).join(' · ')), h('span', { class: 'lw-s' }, 'saved')));
    }
    const c = card(r, ctx); if (c) out.push(c);
    if (r.deeper && r.deeper.q) {
      out.push(h('div', { class: 'ldeep' },
        h('button', { class: 'btn ' + (r.deeper.used ? 'ghost' : 'pri'), disabled: !!r.deeper.used, on: { click: () => {
          if (Chat.isBusy()) return toast('Pehle current jawab aane do.');
          r.deeper.used = true; save(); ctx.redraw();
          Chat.submit('Gehrai mein samjhao: ' + r.deeper.q, { deeper: true });
        } } }, icon('arrowdown', 's'), r.deeper.used ? 'Gehrai wala jawab maanga' : 'Gehrai mein jao · 9.2'),
        r.deeper.used ? null : h('button', { class: 'link', on: { click: () => { r.deeper.used = true; save(); ctx.redraw(); toast('Theek hai, agla concept.'); } } }, 'Samajh gaya')));
    }
    return out;
  }

  /* ---------- Settings sheets ---------- */
  const STYLES = [['2.9', 'Standard 2.9', 'Pehle chhota jawab (1 concept), phir "Gehrai mein jao" button'], ['9.2', 'Standard 9.2', 'Seedha poora gehra jawab, discoverer ke tareeke se (1 concept)']];
  const styleName = () => (STYLES.find(s => s[0] === (S.settings.stdStyle || '2.9')) || STYLES[0])[1];
  function styleSheet(onDone) {
    sheet({ title: 'Standard style', build(b, close) {
      b.append(h('div', { class: 'opts', role: 'radiogroup' }, STYLES.map(([v, name, sub]) => {
        const on = (S.settings.stdStyle || '2.9') === v;
        return h('button', { class: 'opt' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on), on: { click: () => {
          S.settings.stdStyle = v; save(); Bus.emit('std:changed', v); close(); toast(name + ' on'); if (onDone) onDone();
        } } }, h('span', { class: 'mk' }, on ? icon('check') : null), h('span', { class: 'ot' }, h('b', {}, name), h('small', {}, sub)));
      })), h('p', { class: 'muted' }, 'Dono mein ek jawab = ek concept. Formula/derivation ke liye Physics ya Math mode khud chuno.'));
    } });
  }
  function vocabSheet() {
    sheet({ title: 'Seekhe shabd', tall: true, build(b) {
      const q = h('input', { class: 'search', type: 'search', placeholder: 'Shabd dhundho…', 'aria-label': 'Search words', on: { input: () => draw() } });
      const w = h('input', { type: 'text', placeholder: 'Naya shabd', 'aria-label': 'New word', maxlength: '40' });
      const m = h('input', { type: 'text', placeholder: 'Matlab (optional)', 'aria-label': 'Meaning', maxlength: '160' });
      const add = () => { if (!w.value.trim()) return; if (!addWord(w.value, m.value || 'manually added', 'manual')) return toast('Ye shabd pehle se hai'); save(); w.value = ''; m.value = ''; draw(); Bus.emit('vocab:changed'); };
      const st = stats(7), list = h('div', { class: 'grp lvocab' }), count = h('p', { class: 'muted' });
      b.append(h('p', { class: 'muted' }, 'Jo shabd ek baar samjhaya gaya, wo seekha hua maana jata hai. Latest ' + SEND + ' shabd har sawaal ke saath AI ko jaate hain, taaki dobara na samjhaye. Galti se save hua ho to delete karo.'),
        st.total ? h('div', { class: 'lstat' }, h('b', {}, st.ok + '/' + st.total), ' check questions sahi (pichhle 7 din)') : null,
        q, count, list, h('label', { class: 'l' }, 'Khud jodo'), h('div', { class: 'frow' }, w, m), h('button', { class: 'btn pri', on: { click: add } }, 'Save word'));
      function draw() {
        const term = q.value.trim().toLowerCase();
        const rows = vocab().filter(x => !term || x.w.toLowerCase().includes(term) || (x.m || '').toLowerCase().includes(term));
        count.textContent = vocab().length + ' shabd' + (term ? ' · ' + rows.length + ' mile' : '');
        list.textContent = '';
        if (!rows.length) { list.append(h('div', { class: 'item' }, h('span', { class: 't', style: 'color:var(--muted)' }, vocab().length ? 'Kuch nahi mila.' : 'Abhi koi shabd nahi. Jawabon mein naye shabd aate hi yahan save honge.'))); return; }
        rows.slice(0, 300).forEach(x => list.append(h('div', { class: 'item' }, h('span', { class: 't' }, h('b', {}, x.w), h('small', {}, (x.m || '') + (x.src && x.src !== 'manual' ? ' · ' + x.src : ''))),
          h('button', { class: 'ib', 'aria-label': 'Delete ' + x.w, on: { click: () => { const k = vocab().indexOf(x); if (k < 0) return; vocab().splice(k, 1); save(); draw(); Bus.emit('vocab:changed'); toast('Deleted: ' + x.w, { action: () => { vocab().splice(k, 0, x); save(); draw(); } }); } } }, icon('trash', 's')))));
      }
      draw();
    } });
  }

  return { known, addWord, absorb, request, cleanImport, isRight, same, record, stats, card, extras, styleSheet, styleName, vocabSheet };
})();
