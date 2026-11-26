'use strict';
/* 01-motion.js : the two motions the app uses for text that arrives while someone is talking.
   Motion.reveal(host)  types an answer out one word at a time, so a spoken reply appears with the voice
                        instead of landing as a finished block. The text can keep growing while the model
                        streams; the revealer only ever moves forward, and it speeds up when it falls behind.
   Motion.glide(el)     scrolls a container to its end with easing instead of a jump, and keeps following
                        while new text is still arriving.
   prefers-reduced-motion: both become instant. */

const Motion = (() => {
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
  /* requestAnimationFrame that never re-enters: a synchronous rAF (jsdom in tests) falls back to a timer */
  const next = (fn) => { let sync = true; requestAnimationFrame(() => { if (sync) setTimeout(fn, 16); else fn(); }); sync = false; };

  /* ---------- glide: chase the end of a scroller ---------- */
  const chases = new WeakMap();
  function glide(el, opts = {}) {
    if (!el) return;
    const st = chases.get(el) || { token: 0, running: false };
    chases.set(el, st);
    st.until = Date.now() + (opts.hold || 1400);     // keep following while text is still arriving
    st.to = typeof opts.to === 'function' ? opts.to : null;
    const destination = () => {
      const end = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = st.to ? Number(st.to()) : end;
      return Number.isFinite(target) ? Math.max(0, Math.min(end, target)) : end;
    };
    if (reduced()) { el.scrollTop = destination(); return; }
    if (st.running) return;                          // the running chase re-reads the height every frame
    st.running = true;
    const token = ++st.token;
    let guard = 0;
    const step = () => {
      if (token !== st.token) { st.running = false; return; }
      if (Date.now() > st.until || ++guard > 400) { st.running = false; return; }
      const dest = destination();
      const dist = dest - el.scrollTop;
      if (Math.abs(dist) < 1.5) { st.running = false; return; }
      /* ease out: big steps far away, a few pixels at the end, capped so a long jump never snaps */
      const move = Math.min(Math.abs(dist), Math.max(1.5, Math.abs(dist) * 0.22), 150);
      el.scrollTop = el.scrollTop + (dist > 0 ? move : -move);
      next(step);
    };
    next(step);
  }
  /* the user grabbed the scroller: stop following until the next glide call */
  function release(el) { const st = chases.get(el); if (st) { st.token++; st.running = false; } }

  /* ---------- reveal: one word at a time ---------- */
  function reveal(host, opts = {}) {
    const onText = typeof opts.onText === 'function' ? opts.onText : null;
    const node = onText ? null : document.createTextNode('');
    if (node) host.append(node);
    const pace = opts.pace || 230;      // ms per word while audio is playing
    const quick = opts.quick || 70;     // ms per word for ordinary written replies
    const fast = opts.fast || 14;       // ms per word after speech ends, or on flush
    const onTick = opts.onTick || null;
    /* hold is used for speech: model text waits until the first audio callback arrives */
    let target = '', shown = 0, visible = '', mode = opts.mode === 'hold' ? 'hold' : 'quick', timer = 0, alive = true;

    const stopTimer = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    const paint = (text) => {
      visible = text;
      if (onText) { try { onText(text); } catch (e) {} }
      else node.data = text;
    };
    /* end index of the next word, including the spaces that follow it */
    function boundary() {
      let i = shown;
      while (i < target.length && /\s/.test(target[i])) i++;
      while (i < target.length && !/\s/.test(target[i])) i++;
      while (i < target.length && /\s/.test(target[i])) i++;
      return i;
    }
    function wait() {
      if (mode === 'fast') return fast;
      if (mode === 'quick') return quick;
      return pace;       // a fixed speaking cadence; a long transcript must not make captions race ahead
    }
    function step() {
      timer = 0;
      if (!alive || mode === 'hold') return;
      const end = boundary();
      if (end <= shown) return;
      shown = Math.min(end, target.length);
      paint(target.slice(0, shown));
      if (onTick) { try { onTick(); } catch (e) {} }
      if (shown < target.length) timer = setTimeout(step, wait());
    }
    function kick() {
      if (!alive || mode === 'hold' || timer || shown >= target.length) return;
      if (shown === 0) step(); else timer = setTimeout(step, wait());
    }

    return {
      /* new full text (may grow); a different answer resets the reveal */
      set(t) {
        if (!alive) return;
        t = String(t == null ? '' : t);
        if (!t.startsWith(target.slice(0, Math.min(shown, target.length)))) { stopTimer(); shown = 0; paint(''); }
        target = t;
        if (shown > target.length) { shown = target.length; paint(target); }
        kick();
      },
      hold() { mode = 'hold'; stopTimer(); },
      pace() { mode = 'pace'; kick(); },
      quick() { mode = 'quick'; kick(); },
      /* the voice has stopped: finish the rest quickly, still word by word */
      flush() { mode = 'fast'; kick(); },
      /* reveal everything now (screen closing, or the user interrupted) */
      finish() { stopTimer(); shown = target.length; paint(target); if (onTick) { try { onTick(); } catch (e) {} } },
      stop() { alive = false; stopTimer(); if (node && node.parentNode) node.remove(); },
      get busy() { return shown < target.length; },
      get text() { return visible; },
      get full() { return target; }
    };
  }

  return { glide, release, reveal, reduced };
})();
