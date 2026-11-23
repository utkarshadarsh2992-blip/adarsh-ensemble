'use strict';
/* 07-backend.js : the adapter seam.
   The UI only ever calls Backend.send(). Plug in your architecture by either
     (a) defining  window.ADARSH_BACKEND = { send(req,{onProgress,signal}), missionAction?, ping?, suggestions? }  before this script, or
     (b) filling Settings > Connection with an HTTP endpoint (JSON in / JSON out, see ARCHITECTURE.md).
   With neither, a clearly-labelled demo backend runs so every screen can be tried. */

const DemoBackend = (() => {
  const wait = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
  });
  function parseDue(t) {
    const d = new Date(); let hit = false;
    if (/\b(tomorrow|kal)\b/i.test(t)) { d.setDate(d.getDate() + 1); hit = true; } else if (/\b(today|aaj)\b/i.test(t)) hit = true;
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(t);
    if (m) { let hr = +m[1] % 12; if (/pm/i.test(m[3])) hr += 12; d.setHours(hr, +(m[2] || 0), 0, 0); hit = true; } else d.setHours(9, 0, 0, 0);
    return hit ? d.getTime() : null;
  }

  /* DEMO ONLY: one sample answer per mode so the layout of maths, tables and code can be previewed without a server. */
  const MODE_DEMO = {
    v: ['**Short answer** *(demo reply)*', '', 'The claim holds in the usual case, with one limit.', '', '**What was checked**', '',
      '- The definition and the exact figure were compared against two independent derivations.', '- One edge case changes the result, so the answer is conditional.', '',
      '> In V mode your backend decides how answers are double-checked.'].join('\n'),
    physics: ['**Escape velocity of Earth** *(demo reply)*', '', 'Set the kinetic energy at the surface equal to the work needed to reach infinity:', '',
      '$$\\frac{1}{2} m v_e^2 = \\frac{G M m}{R}$$', '', 'so', '', '$$v_e = \\sqrt{\\frac{2GM}{R}} \\approx 11.2\\ \\text{km/s}$$', '',
      '**Sanity check.** $GM/R$ has units $\\text{m}^2\\text{s}^{-2}$, so $v_e$ comes out in m/s. ✓', '',
      '| Quantity | Value |', '|---|---|', '| $G$ | $6.67\\times10^{-11}\\ \\text{N m}^2\\text{kg}^{-2}$ |', '| $M$ | $5.97\\times10^{24}\\ \\text{kg}$ |', '| $R$ | $6.37\\times10^{6}\\ \\text{m}$ |'].join('\n'),
    math: ['**Solve** $x^2 - 5x + 6 = 0$ *(demo reply)*', '', '1. Find two numbers with product $6$ and sum $-5$: they are $-2$ and $-3$.', '2. Write $(x-2)(x-3)=0$.',
      '3. A product is zero when a factor is zero, so $x = 2$ or $x = 3$.', '', 'Check with the quadratic formula:', '',
      '$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a} = \\frac{5 \\pm 1}{2}$$'].join('\n'),
    business: ['**Pricing comparison** *(demo reply)*', '', '| Plan | Price | Margin | Best for |', '|---|---:|---:|---|', '| Basic | $9 | 62% | Individuals |', '| Pro | $29 | 71% | Small teams |', '| Scale | $99 | 78% | Larger accounts |', '',
      '**Read-out.** Margin rises with price, but only Pro has both a healthy margin and a low barrier to buy.', '', '- Test Pro at $24 and $34 before changing the list price.', '- Watch churn on Scale for two quarters.'].join('\n'),
    coding: ['**Debounce a function** *(demo reply)*', '', '```js', 'function debounce(fn, wait = 300) {', '  let timer;', '  return (...args) => {', '    clearTimeout(timer);', '    timer = setTimeout(() => fn(...args), wait);', '  };', '}', '```', '',
      'Call it from an input handler, for example `input.oninput = debounce(search, 250)`.', '', '**Edge case.** Each call resets the timer, so a user who keeps typing never triggers `search` until they pause.'].join('\n')
  };
  async function steps(list, o) { for (const s of list) { o.onProgress(s); await wait(420, o.signal); } }

  async function send(req, o) {
    const t = (req.text || '').trim(), m = req.meta || {};
    if (m.answer) {
      await steps(['Reading your answers', 'Building the plan'], o);
      const a = m.answer.answers || []; const get = (k) => (a.find(x => x.header === k) || {}).answer || 'anything';
      const open = S.tasks.filter(x => !x.done).slice(0, 3).map(x => '- ' + x.title);
      return { type: 'text', text: '**Plan for today** (' + get('Focus') + ', ' + get('Time') + ')\n\n1. Start with the one thing that matters most.\n2. Block the first slot for deep work, no phone.\n3. Review open tasks.\n\n' + (open.length ? open.join('\n') : '- nothing open yet') + '\n\n*Demo reply: your real backend writes this.*' };
    }
    if (m.approval) {
      await steps(['Applying your decision'], o);
      return m.approval.decision === 'allow'
        ? { type: 'text', text: 'Done. I staged the change in a copy, ran the checks and nothing live was touched. *(demo)*' }
        : { type: 'text', text: 'Okay, I won’t do that. Tell me if you want a different approach.' };
    }
    if (/brief|briefing|aaj ka din|good morning/i.test(t)) {
      await steps(['Checking tasks', 'Checking memory'], o);
      const due = S.tasks.filter(x => !x.done).sort((a, b) => (a.due || 9e15) - (b.due || 9e15)).slice(0, 4);
      return { type: 'text', text: '**' + greeting() + ', ' + (S.settings.name || 'Adarsh') + '.**\n\n' + (due.length ? 'Open tasks:\n' + due.map(x => '- ' + x.title + (x.due ? ' (' + fmtDue(x.due).t + ')' : '')).join('\n') : 'No open tasks. A clear day.') + '\n\n' + (S.memories.length ? 'I’m keeping ' + S.memories.length + ' things in memory.' : 'Nothing in memory yet. Say “remember that…”.') + '\n\n*Demo briefing built from this device’s data.*' };
    }
    if (/plan (my )?day|plan karo|schedule my/i.test(t)) {
      await steps(['Looking at your open tasks'], o);
      return { type: 'ask', id: uid('ask'), questions: [
        { header: 'Focus', question: 'What should today be about?', options: [{ label: 'Deep work', description: 'One big thing, no meetings' }, { label: 'Catch-up', description: 'Clear small pending items' }, { label: 'Balanced' }] },
        { header: 'Time', question: 'How much time do you have?', multi: false, options: [{ label: '2 hours' }, { label: 'Half a day' }, { label: 'Full day' }] }
      ] };
    }
    if (/\b(remind|yaad dila|reminder)\b/i.test(t)) {
      const title = t.replace(/^(please\s+)?(remind me|yaad dila(na)?)( to)?/i, '').replace(/\b(tomorrow|today|kal|aaj)\b/ig, '').replace(/\d{1,2}(:\d{2})?\s*(am|pm)/ig, '').replace(/\s+/g, ' ').trim() || 'Reminder';
      await steps(['Understanding the time'], o);
      return [{ type: 'task', title: title.charAt(0).toUpperCase() + title.slice(1), due: parseDue(t) }, { type: 'text', text: 'Added. I’ll nudge you when it’s due.' }];
    }
    if (/\b(remember|yaad rakh)\b/i.test(t)) {
      const mem = t.replace(/^.*?\b(remember( that)?|yaad rakh(na)?)\b\s*/i, '').trim() || t;
      return [{ type: 'memory', text: mem }, { type: 'text', text: 'Got it. I’ll use that from now on.' }];
    }
    if (/self|audit your|your own code|improve yourself|deploy|architecture/i.test(t)) return { type: 'text', text: 'Architecture read-only hai. Demo mein actual reference nahi hai; Android/backend connect karo. Code editing/deploy disabled hai.' };
    if (/delete|send (an )?email|post |purchase|buy /i.test(t)) {
      await steps(['Checking what this touches'], o);
      return { type: 'approve', id: uid('ap'), title: 'Do this on your behalf?', detail: 'This action changes something outside the chat: “' + t.slice(0, 90) + '”.', action: 'external_action()', scope: 'One time only', risk: 'high' };
    }
    if (/debate/i.test(t)) {
      await steps(['Pro side', 'Con side', 'Moderator'], o);
      return { type: 'debate', topic: t.replace(/^debate:?\s*/i, ''), pro: 'Start with **Rust**: it forces you to understand memory and ownership, and that knowledge transfers to every language afterwards.', con: 'Start with **Go**: you ship something useful in a weekend, and motivation matters more than depth in the first month.', verdict: 'If your goal is shipping tools quickly, Go first. If your goal is systems depth, Rust first. For most people, Go then Rust works best. *(demo)*' };
    }
    if (/pattern/i.test(t)) {
      await steps(['Reading recent notes', 'Looking for repeats'], o);
      return { type: 'patterns', title: 'Patterns in your week', patterns: [{ claim: 'You plan late at night and slip the next morning.', strength: 'strong', evidence: ['3 tasks created after 11 pm', '2 of them missed their due time'], so_what: 'Plan before 9 pm or set a morning checkpoint.' }, { claim: 'Research tasks outlive everything else.', strength: 'moderate', evidence: ['Oldest open task is a research item'], so_what: 'Time-box research to 45 minutes.' }] };
    }
    if (/connect|link the dots|related/i.test(t)) {
      await steps(['Mapping ideas'], o);
      return { type: 'links', title: 'How these connect', chains: [{ nodes: ['Sleep', 'Focus', 'Output'], why: 'Poor sleep lowers focus, which shows up as less output.' }, { nodes: ['Notes', 'Memory', 'Briefing'], why: 'What you note becomes what I remember and surface in the briefing.' }] };
    }
    if (/mission/i.test(t)) {
      await steps(['Splitting into stages'], o);
      return { type: 'mission', id: uid('ms'), title: t.replace(/^start a mission:?\s*/i, '') || 'Mission', status: 'running', stages: [{ label: 'Understand the goal', status: 'completed' }, { label: 'Gather sources', status: 'completed' }, { label: 'Analyse and compare', status: 'running' }, { label: 'Verify claims', status: 'pending' }, { label: 'Write the report', status: 'pending' }, { label: 'Final check', status: 'pending' }] };
    }
    if (/research|verify|fact|sach|true/i.test(t)) {
      await steps(['Planning searches', 'Reading sources', 'Checking each claim', 'Judging the evidence'], o);
      return { type: 'research', question: t.replace(/^research( whether)?\s*/i, '') || t, confidence: 0.72, summary: 'Short-term studies show a small benefit for alertness, but results on lasting focus are mixed.',
        claims: [{ text: 'Fasting can improve alertness in the short term.', verdict: 'SUPPORTED_BY_MULTIPLE_SOURCES', checks: [{ source: 'Source 1', verdict: 'SUPPORTED_BY_ONE_SOURCE', note: 'Small trial, 40 adults' }, { source: 'Source 2', verdict: 'SUPPORTED_BY_ONE_SOURCE' }] },
          { text: 'It improves long-term concentration.', verdict: 'CONTESTED', checks: [{ source: 'Source 3', verdict: 'CONTRADICTED_BY_SOURCE', note: 'No effect after 8 weeks' }] },
          { text: 'It works for everyone.', verdict: 'UNSUPPORTED_NO_VALID_EVIDENCE', checks: [] }],
        sources: [{ n: 1, title: 'Example journal article', url: 'https://example.org/a' }, { n: 2, title: 'Example review', url: 'https://example.org/b' }, { n: 3, title: 'Example trial', url: 'https://example.org/c' }], caveat: 'Demo data: nothing here was actually searched.' };
    }
    if (MODE_DEMO[req.mode]) { await steps(['Reading the question', 'Working it out'], o); return { type: 'text', text: MODE_DEMO[req.mode] }; }
    await steps(['Thinking'], o);
    return { type: 'text', text: 'You said: “' + t + '”.\n\nThis is the **demo backend**, so I can only show how replies look. Try: *research…*, *debate…*, *remind me to… tomorrow 5pm*, *remember that…*, *plan my day*, *start a mission…*, *delete…* (permission card).' };
  }
  const missionAction = async (id, action) => ({ status: action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'running' });
  const suggestions = () => [
    { ic: 'sun', title: 'Morning briefing', sub: 'Tasks, memory and what needs you', prompt: 'Brief me on today' },
    { ic: 'cal', title: 'Plan my day', sub: 'Adarsh will ask two quick questions', prompt: 'Plan my day around my open tasks' }
  ];
  return { send, missionAction, suggestions, ping: async () => ({ ok: true, label: 'Demo backend (no server)' }) };
})();

const connUrl = () => S.conn.url || (window.ADARSH_SAME_ORIGIN ? '/api/chat' : '');

const HttpBackend = {
  async send(req, o) {
    const headers = { 'Content-Type': 'application/json' }; if (S.conn.token) headers.Authorization = 'Bearer ' + S.conn.token;
    o.onProgress('Contacting Adarsh');
    const r = await fetch(connUrl(), { method: 'POST', headers, signal: o.signal, body: JSON.stringify({ chat_id: req.chatId, text: req.text, attachments: req.attachments, history: req.history, access: req.access, app_context: req.app_context, architecture: req.architecture, meta: req.meta || null, source: req.source || 'auto', answers: req.answers || [], reply: req.reply || null, abilities: req.abilities, lang: req.lang, mode: req.mode || 'standard' }) });
    if (r.status === 401 || r.status === 403) throw new Error('The backend rejected the token (HTTP ' + r.status + '). Check Settings > Connection.');
    if (!r.ok) throw new Error('Backend error: HTTP ' + r.status);
    const ct = r.headers.get('content-type') || ''; if (!ct.includes('json')) return { type: 'text', text: await r.text() };
    const j = await r.json(); return Array.isArray(j) ? j : j.replies || j.reply || j;
  },
  async lessons(op) {
    try {
      const headers = { 'Content-Type': 'application/json' }; if (S.conn.token) headers.Authorization = 'Bearer ' + S.conn.token;
      const r = await fetch(connUrl(), { method: 'POST', headers, body: JSON.stringify({ lesson: op }) });
      const j = await r.json(); const x = Array.isArray(j) ? j[0] : (j.replies ? j.replies[0] : j);
      return (x && x.lessonsResult) || (x && x.ok !== undefined ? x : { ok: false, error: 'Backend ne lessons nahi diye.' });
    } catch (e) { return { ok: false, error: 'Lessons server tak nahi pahunche.' }; }
  },
  async tts(req, ms) {
    const headers = { 'Content-Type': 'application/json' }; if (S.conn.token) headers.Authorization = 'Bearer ' + S.conn.token;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 30000);
    try {
      const r = await fetch(connUrl(), { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify({ tts: req }) });
      if (!r.ok) return { type: 'error', error: 'HTTP ' + r.status };
      const j = await r.json(); return Array.isArray(j) ? j[0] : j;
    } finally { clearTimeout(t); }
  },
  async ping() {
    try {
      const headers = { 'Content-Type': 'application/json' }; if (S.conn.token) headers.Authorization = 'Bearer ' + S.conn.token;
      const r = await fetch(connUrl(), { method: 'POST', headers, body: JSON.stringify({ ping: true }) });
      return r.ok ? { ok: true, label: 'Connected (' + new URL(connUrl(), location.href).hostname + ')' } : { ok: false, label: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, label: 'Cannot reach the server (' + (e && e.message ? e.message : 'network') + ')' }; }
  }
};

const Backend = (() => {
  const custom = () => window.ADARSH_BACKEND;
  const impl = () => custom() || (connUrl() ? HttpBackend : DemoBackend);
  return {
    isDemo: () => !custom() && !connUrl(),
    isNative: () => !!(custom() && custom().native),
    /* natural voice from the engine; null when this backend has none (demo, custom without tts) */
    canTts() { const b = impl(); return !!(b && b.tts); },
    tts(req, ms) { const b = impl(); return b && b.tts ? b.tts(req, ms) : Promise.resolve(null); },
    send(req, o) { req.abilities = enabledAbilities(); req.lang = S.settings.lang; return impl().send(req, o); },
    async lessons(op) { const b = impl(); return b.lessons ? b.lessons(op) : { ok: false, error: 'Demo mode me lessons nahi hote.' }; },
    missionAction(id, a) { const b = impl(); return b.missionAction ? b.missionAction(id, a) : Promise.resolve(null); },
    suggestions() { const b = impl(); return b.suggestions ? b.suggestions() : []; },
    async ping() { const b = impl(); return b.ping ? b.ping() : { ok: true, label: 'Custom backend' }; },
    async refresh() {
      if (this.isDemo()) return Bus.emit('backend:status', { label: 'Demo mode', demo: true });
      const tok = (this._tok = (this._tok || 0) + 1);  /* a newer refresh() cancels this loop */
      Bus.emit('backend:status', { label: 'Connecting…' });
      let r = await this.ping();
      /* the on-device engine boots in the background: keep asking for up to ~2 minutes instead of giving up */
      for (let i = 0; r && r.starting && i < 80 && tok === this._tok; i++) {
        Bus.emit('backend:status', { label: 'Starting…' });
        await new Promise(ok => setTimeout(ok, 1500));
        r = await this.ping();
      }
      if (tok !== this._tok) return;
      const label = r.ok ? 'Connected' : r.starting ? 'Offline' : (r.label && r.label !== 'Engine not reachable' ? r.label : 'Offline');
      Bus.emit('backend:status', { label, ok: r.ok, hint: r.hint || r.error || '' });
    },
    /* a reply that came back from the engine proves it is up, whatever the last ping said */
    markUp() { Bus.emit('backend:status', { label: 'Connected', ok: true }); }
  };
})();
