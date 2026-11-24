'use strict';
/* 03-modes.js : chat modes and the picker in the composer (Claude-style menu above the input box).

   HOW TO EDIT
   - Rename a mode, change its description, placeholder or starter prompts in MODES below. Nothing else needs to change.
   - The chosen mode id goes to the backend as `mode` on every request (07-backend.js). The UI never rewrites the question,
     so what a mode actually does is decided on your side, in your backend or adapter.
   - ids used today: standard, v, physics, math, business, coding. Each id has its OWN model combination and checks on the
     backend (mode_plans.py); `how` is only the one-line summary shown in the menu.

   Starter = { t: text on the card, p: text put in the box, send: true to send it straight away, ic: icon name }. */

const Modes = (() => {
  const MODES = [
    { id: 'standard', how: 'Instant: ONE fast model answers straight away. No council, no falsifiers. Use a mode below for deep checking', name: 'Standard', ic: 'sparkle', desc: 'Everyday questions, writing and quick help.',
      /* change 1.2: two Standard styles, both one concept per answer (learning.py on the backend) */
      variants: [
        { std: '2.9', name: 'Standard 2.9', desc: 'Pehle chhota jawab, phir "Gehrai mein jao"', how: '1 concept · short core + imagine-this · check question · Groq only' },
        { std: '9.2', name: 'Standard 9.2', desc: 'Seedha poora gehra jawab, discoverer ke tareeke se', how: '1 concept · problem → trigger → mechanism → limits · check questions · Groq only' }
      ],
      placeholder: 'Message Adarsh', hello: 'What are we working on?',
      starters: [
        { ic: 'sun', t: 'Brief me on today', p: 'Brief me on today', send: true },
        { ic: 'globe', t: 'Research something', p: 'Research ' },
        { ic: 'tasks', t: 'Add a task or reminder', p: 'Remind me to ' }
      ] },
    { id: 'v', how: 'Always deep · 3 falsifiers · always debates · both reviewers · must research', name: 'V', ic: 'vee', desc: 'Double-checked answers for facts that matter.',
      placeholder: 'Ask something that must be right…',
      starters: [
        { t: 'Fact-check a claim', p: 'Fact-check this claim: ' },
        { t: 'Verify a calculation', p: 'Verify this calculation step by step: ' },
        { t: 'Is this statistic reliable?', p: 'Is this statistic reliable? ' }
      ] },
    { id: 'physics', how: 'gpt-oss + nemotron + gemini · units & limits checks · method review', name: 'Physics', ic: 'atom', desc: 'Derivations, units and sanity checks.',
      placeholder: 'Ask a physics question…',
      starters: [
        { t: 'Derive the escape velocity of Earth', p: 'Derive the escape velocity of Earth' },
        { t: 'Why is the sky blue?', p: 'Why is the sky blue?' },
        { t: 'Check the units of an equation', p: 'Check the units of this equation: ' },
        { t: 'Solve a projectile motion problem', p: 'A ball is thrown at 20 m/s at 30° above the horizontal. Find the range.' }
      ] },
    { id: 'math', how: 'Strongest reasoners · counter-examples · every step re-derived', name: 'Math', ic: 'sigma', desc: 'Step-by-step working with exact results.',
      placeholder: 'Enter a problem to solve…',
      starters: [
        { t: 'Solve x² − 5x + 6 = 0', p: 'Solve x^2 - 5x + 6 = 0 step by step' },
        { t: 'Prove that √2 is irrational', p: 'Prove that sqrt(2) is irrational' },
        { t: 'Differentiate x·ln x', p: 'Find the derivative of x ln x' },
        { t: 'Explain eigenvalues intuitively', p: 'Explain eigenvalues and eigenvectors intuitively' }
      ] },
    { id: 'business', how: 'mistral specialist · always researches · every number checked', name: 'Business', ic: 'trend', desc: 'Strategy, finance and market analysis.',
      placeholder: 'Describe your business question…',
      starters: [
        { t: 'Compare two pricing strategies', p: 'Compare these two pricing strategies: ' },
        { t: 'Work out unit economics', p: 'Work out the unit economics for ' },
        { t: 'SWOT analysis', p: 'Do a SWOT analysis for ' },
        { t: 'Outline a go-to-market plan', p: 'Outline a go-to-market plan for ' }
      ] },
    { id: 'coding', how: 'qwen + glm + laguna · edge-case attacks · code review', name: 'Coding', ic: 'code', desc: 'Write, debug and review code.',
      placeholder: 'Paste code or describe what to build…',
      starters: [
        { t: 'Explain this error message', p: 'Explain this error and how to fix it:\n' },
        { t: 'Review a function for bugs', p: 'Review this function for bugs and edge cases:\n' },
        { t: 'Write a Python script', p: 'Write a Python script that ' },
        { t: 'Optimise a slow SQL query', p: 'Optimise this SQL query:\n' }
      ] }
  ];

  const get = (id) => MODES.find(m => m.id === id) || MODES[0];
  const current = () => get(S.settings.mode);
  const variant = (m = current()) => (m.variants ? m.variants.find(v => v.std === (S.settings.stdStyle || '2.9')) || m.variants[0] : null);
  const label = (m = current()) => { const v = variant(m); return v ? v.name : m.name; };
  function set(id) {
    const m = get(id); if (S.settings.mode === m.id) return;
    S.settings.mode = m.id; save(); vibe(); Bus.emit('mode:changed', m);
  }

  /* ---------- picker ---------- */
  let layer = null, anchorBtn = null;
  function close() {
    if (!layer) return;
    layer.remove(); layer = null;
    document.removeEventListener('keydown', onKey, true);
    if (anchorBtn) { anchorBtn.setAttribute('aria-expanded', 'false'); anchorBtn.focus({ preventScroll: true }); }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = $$('.pop-item', layer); if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
  }
  function open(btn) {
    if (layer) return close();
    anchorBtn = btn;
    const phone = $('#phone'), box = btn.closest('.box') || btn;
    const bottom = Math.max(8, Math.round(phone.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 8));
    const now = current().id, nowStd = S.settings.stdStyle || '2.9';
    const item = (m, v) => {
      const on = m.id === now && (!v || v.std === nowStd);
      return h('button', { class: 'pop-item', role: 'menuitemradio', 'aria-checked': String(on), on: { click: () => {
        if (v && S.settings.stdStyle !== v.std) { S.settings.stdStyle = v.std; save(); vibe(); Bus.emit('std:changed', v.std); }   /* style only: background voice keeps running */
        set(m.id); close();
      } } },
        h('span', { class: 'pi-ic' }, v ? h('span', { class: 'pi-v' }, v.std) : icon(m.ic)),
        h('span', { class: 'pi-t' }, h('b', {}, v ? v.name : m.name), h('small', {}, v ? v.desc : m.desc), (v ? v.how : m.how) ? h('small', { class: 'pi-how' }, v ? v.how : m.how) : null),
        h('span', { class: 'pi-ck' }, on ? icon('check', 's') : null));
    };
    const menu = h('div', { class: 'pop', role: 'menu', 'aria-label': 'Choose a mode', style: 'bottom:' + bottom + 'px' },
      h('div', { class: 'pop-h' }, 'Mode'),
      MODES.flatMap(m => (m.variants ? m.variants.map(v => item(m, v)) : [item(m, null)])));
    layer = h('div', { class: 'pop-scrim', on: { click: (e) => { if (e.target === layer) close(); } } }, menu);
    phone.appendChild(layer);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey, true);
    const first = $('.pop-item[aria-checked="true"]', menu) || $('.pop-item', menu); if (first) first.focus({ preventScroll: true });
  }

  return { list: () => MODES, get, current, variant, label, set, open, close, isOpen: () => !!layer };
})();
