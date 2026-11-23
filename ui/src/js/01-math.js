'use strict';
/* 01-math.js : a small TeX-to-DOM renderer for physics / math answers.
   Not a full TeX engine. It understands fractions, roots, super/subscripts, Greek letters, accents and the usual
   operators. Anything it does not know is shown as plain text instead of failing. Used by md() in 01-core.js
   for $…$, $$…$$, \(…\) and \[…\]. Builds DOM nodes only, never innerHTML. */

const Tex = (() => {
  const GREEK_LOWER = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', ell: 'ℓ', hbar: 'ℏ' };
  const REL = { cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡', propto: '∝', ll: '≪', gg: '≫',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔', mapsto: '↦', longrightarrow: '⟶',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', oplus: '⊕', otimes: '⊗', land: '∧', lor: '∨', parallel: '∥', perp: '⊥' };
  const BIG = { sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮' };
  const SYM = { Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    infty: '∞', partial: '∂', nabla: '∇', degree: '°', circ: '∘', prime: '′', uparrow: '↑', downarrow: '↓', forall: '∀', exists: '∃', emptyset: '∅', varnothing: '∅', neg: '¬',
    ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱', angle: '∠', langle: '⟨', rangle: '⟩', star: '⋆', dagger: '†', ast: '∗', bullet: '•', lbrace: '{', rbrace: '}', lvert: '|', rvert: '|', lVert: '‖', rVert: '‖',
    Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', top: '⊤', checkmark: '✓' };
  const FN = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'gcd', 'mod', 'Pr', 'arg', 'deg']);
  const SPACE = { ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: ' ', qquad: '  ' };
  const ACC = { vec: '⃗', hat: '̂', bar: '̄', overline: '̄', dot: '̇', ddot: '̈', tilde: '̃', widehat: '̂', widetilde: '̃', underline: '̲' };
  const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ' };
  const TEXTCMD = new Set(['text', 'mathrm', 'textrm', 'mbox', 'operatorname', 'textit', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathscr', 'mathfrak', 'textsf']);
  const BOLDCMD = new Set(['mathbf', 'textbf', 'boldsymbol', 'bm', 'bf']);
  const SIZECMD = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'middle']);

  function parse(src) {
    let i = 0;
    const eat = () => { while (src[i] === ' ' || src[i] === '\n') i++; };

    function seq(stop, raw) {                       /* nodes until `stop` (not consumed) or the end */
      const out = [];
      const add = (x) => {
        if (x == null || x === '') return;
        if (Array.isArray(x)) return x.forEach(add);
        if (typeof x === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += x; else out.push(x);
      };
      while (i < src.length && src[i] !== stop) {
        const a = atom(raw);
        let sup = null, sub = null;
        for (;;) {                                   /* x^2, x_i, x_i^2 */
          let j = i; while (src[j] === ' ') j++;
          if (!raw && src[j] === '^' && sup === null) { i = j + 1; sup = script(); }
          else if (!raw && src[j] === '_' && sub === null) { i = j + 1; sub = script(); }
          else break;
        }
        add(a);
        if (sup && sub) add(h('span', { class: 'ss' }, h('sup', {}, sup), h('sub', {}, sub)));
        else if (sup) add(h('sup', {}, sup));
        else if (sub) add(h('sub', {}, sub));
      }
      return out;
    }
    function script() { eat(); return atom(false); }
    function group(raw) { eat(); return atom(raw); }  /* one {group} or one token */
    function rawText() { eat(); if (src[i] === '{') { i++; const g = seq('}', true); i++; return g; } return atom(true); }

    function atom(raw) {
      const c = src[i];
      if (c === undefined) return [];
      if (c === '{') { i++; const g = seq('}', raw); i++; return g; }
      if (c === '\\') return command(raw);
      i++;
      if (raw) return [c];
      if (c === ' ' || c === '\n' || c === '\t' || c === '}') return [];
      if (/[A-Za-z]/.test(c)) return [h('i', {}, c)];
      if (c === '-') return [h('span', { class: 'op' }, '−')];
      if (c === '=' || c === '+' || c === '<' || c === '>') return [h('span', { class: 'op' }, c)];
      if (c === '*') return ['∗'];
      if (c === ',' || c === ';') return [c + ' '];
      if (c === '&' || c === '~') return [' '];
      if (c === "'") return ['′'];
      return [c];
    }

    function command(raw) {
      i++;                                           /* the backslash */
      let name = '';
      if (/[A-Za-z]/.test(src[i] || '')) { while (/[A-Za-z]/.test(src[i] || '')) name += src[i++]; }
      else { name = src[i] || ''; i++; }
      if (name === '\\') return [h('br')];
      if ('{}%&_#$|'.includes(name) && name) return [name === '|' ? '‖' : name];
      if (name in SPACE) return [SPACE[name]];
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = group(raw), b = group(raw);
        return [h('span', { class: 'frac' }, h('span', { class: 'n' }, a), h('span', { class: 'd' }, b))];
      }
      if (name === 'sqrt') {
        let idx = null;
        if (src[i] === '[') { const k = src.indexOf(']', i); if (k > 0) { idx = src.slice(i + 1, k); i = k + 1; } }
        return [h('span', { class: 'sqrt' }, idx ? h('sup', { class: 'ri' }, idx) : null, '√', h('span', { class: 'rad' }, group(raw)))];
      }
      if (name === 'mathbb') { const t = rawText().join(''); return [BB[t] || t]; }
      if (TEXTCMD.has(name)) return [h('span', { class: 'rm' }, rawText())];
      if (BOLDCMD.has(name)) return [h('b', { class: 'rm' }, rawText())];
      if (name in ACC) {
        const a = group(raw), last = a[a.length - 1];
        if (a.length === 1 && last && last.nodeType === 1 && last.tagName === 'I' && last.textContent.length === 1) { last.textContent += ACC[name]; return a; }
        if (a.length === 1 && typeof last === 'string' && last.length === 1) return [last + ACC[name]];
        return [h('span', { class: 'ov' }, a)];
      }
      if (SIZECMD.has(name)) { eat(); if (src[i] === '.') { i++; return []; } return atom(raw); }
      if (name === 'begin' || name === 'end') { rawText(); return []; }
      if (name === 'limits' || name === 'nolimits' || name === 'displaystyle' || name === 'textstyle' || name === 'scriptstyle') return [];
      if (name in GREEK_LOWER) return [h('i', {}, GREEK_LOWER[name])];
      if (name in REL) return [h('span', { class: 'op' }, REL[name])];
      if (name in BIG) return [h('span', { class: 'big' }, BIG[name])];
      if (name in SYM) return [SYM[name]];
      if (FN.has(name)) return [h('span', { class: 'rm fn' }, name)];
      return [h('span', { class: 'rm' }, name)];     /* unknown command: show its name rather than a stray backslash */
    }
    return seq(undefined, false);
  }

  const nodes = (src) => { try { return parse(String(src == null ? '' : src)); } catch (e) { return [String(src)]; } };
  return {
    nodes,
    span: (src) => h('span', { class: 'math' }, nodes(src)),
    block: (src) => h('div', { class: 'mathblock' }, nodes(src))
  };
})();
