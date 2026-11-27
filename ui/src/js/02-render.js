'use strict';
/* 02-render.js : reply-type renderers. One function per reply type.
   Contract: RENDER[type](data, ctx) -> Node.  ctx = { msg, redraw() }.  See ARCHITECTURE.md for each shape. */

const VERDICT = {
  SUPPORTED_BY_MULTIPLE_SOURCES: ['good', 'Multiple sources'], SUPPORTED_BY_ONE_SOURCE: ['info', 'One source'],
  PARTIALLY_SUPPORTED: ['warn', 'Partial'], CONTESTED: ['warn', 'Contested'], UNVERIFIED_NO_JUDGE: ['mute', 'Unverified'],
  CONTRADICTED_BY_SOURCE: ['bad', 'Contradicted'], UNSUPPORTED_NO_VALID_EVIDENCE: ['bad', 'No evidence'], UNSUPPORTED_UNRELATED: ['bad', 'Unrelated']
};
const pill = (v) => { const [c, l] = VERDICT[v] || ['mute', String(v || '').replace(/_/g, ' ').toLowerCase() || '—']; return h('span', { class: 'pill ' + c }, l); };
const head = (kind, title, extra) => h('div', { class: 'card-h' }, h('div', { class: 'grow' }, h('span', { class: 'k' }, kind), title ? h('h3', {}, title) : null), extra);
const sec = (k, ...c) => h('div', { class: 'sec' }, k ? h('span', { class: 'k' }, k) : null, ...c);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } };
const omittedNotice = () => h('div', { class: 'note' }, icon('warn', 's'), 'Some details omitted because this reply was too large.');

/* reply.notes = { title, items: [{ title, text }] }: folded under the reply (falsifier findings). */
const notesEl = (n) => h('details', { class: 'notes' },
  h('summary', {}, icon('warn', 's'), (n.title || 'Notes') + ' · ' + n.items.length, h('span', { style: 'flex:1' }), icon('chev', 'chev')),
  n.items.map(it => h('div', { class: 'note-item' }, it.title ? h('b', {}, it.title) : null, md(it.text || ''))));

const RENDER = {
  text: (d) => md(d.text),

  image: (d) => {
    if (typeof d.mediaId !== 'string' || !/^[a-f0-9]{32}$/.test(d.mediaId)) return md('Generated image file is missing or invalid.');
    const src = '/media/' + d.mediaId + '.jpg';
    return h('div', { class: 'card generated-media' },
      head('Generated image', null),
      h('img', { src, alt: 'AI-generated image', loading: 'lazy', decoding: 'async' }),
      d.prompt ? h('p', { class: 'muted' }, d.prompt) : null);
  },

  video: (d) => {
    if (typeof d.mediaId !== 'string' || !/^[a-f0-9]{32}$/.test(d.mediaId)) return md('Generated video file is missing or invalid.');
    const src = '/media/' + d.mediaId + '.mp4';
    return h('div', { class: 'card generated-media' },
      head('Generated video', null),
      h('video', { src, controls: true, playsinline: true, preload: 'metadata' }, 'This device could not play the generated video.'),
      h('a', { class: 'link', href: src, download: 'adarsh-cosmos3.mp4', rel: 'noopener' }, 'Open or download MP4'),
      d.prompt ? h('p', { class: 'muted' }, d.prompt) : null);
  },

  research: (d) => {
    const card = h('div', { class: 'card' });
    card.append(head('Research', d.question, d.confidence != null ? h('span', { class: 'chip' }, Math.round(d.confidence * 100) + '% confidence') : null));
    if (d.summary) card.append(sec('Answer', md(d.summary)));
    (d.claims || []).forEach((c, i) => {
      card.append(h('details', { class: 'claim' },
        h('summary', {}, h('span', { class: 'n' }, String(i + 1)), h('span', { class: 'ct' }, c.text), icon('chev', 'chev'), pill(c.verdict)),
        h('div', { class: 'checks' }, (c.checks || []).map(k => h('div', { class: 'check' }, h('b', {}, k.source), pill(k.verdict), k.note ? h('span', {}, k.note) : null)))));
    });
    if (d.sources && d.sources.length) card.append(h('details', { class: 'fold' }, h('summary', {}, icon('link', 's'), 'Sources (' + d.sources.length + ')', h('span', { style: 'flex:1' }), icon('chev', 'chev')),
      h('div', { class: 'in' }, d.sources.map(s => {
        const href = safeExternalUrl(s && s.url), raw = s && typeof s.url === 'string' ? s.url : '';
        return h('div', { class: 'src' }, h('b', {}, '[' + (s && s.n != null ? s.n : '?') + ']'), href
          ? externalAnchor(href, s.title || hostOf(href), { style: 'color:var(--fg)' })
          : h('span', {}, s && s.title ? s.title + (raw ? ' (' + raw + ')' : '') : raw), href ? h('small', {}, hostOf(href)) : null);
      }))));
    if (d.caveat) card.append(sec('', h('div', { class: 'note' }, icon('warn', 's'), d.caveat)));
    return card;
  },

  debate: (d) => {
    const side = (name, tag, text) => h('div', {}, h('div', { class: 'who' }, name, h('span', {}, tag)), md(text));
    return h('div', { class: 'card duo' },
      head('Debate', d.topic), side('For', 'debater_pro', d.pro), side('Against', 'debater_con', d.con),
      h('div', { class: 'verdict' }, side('Moderator', 'verdict', d.verdict)));
  },

  patterns: (d) => {
    const card = h('div', { class: 'card' }, head('Patterns', d.title || 'Patterns found'));
    (d.patterns || []).forEach(p => card.append(h('div', { class: 'pat' },
      h('div', { class: 'head' }, h('p', {}, p.claim), p.strength ? h('span', { class: 'pill ' + (p.strength === 'strong' ? 'good' : p.strength === 'weak' ? 'mute' : 'info') }, p.strength) : null),
      p.evidence ? h('ul', {}, p.evidence.map((e, i) => h('li', {}, h('b', {}, 'E' + (i + 1)), e))) : null,
      p.so_what ? h('div', { class: 'meta' }, h('b', {}, 'So what: '), p.so_what) : null)));
    return card;
  },

  links: (d) => {
    const card = h('div', { class: 'card' }, head('Connections', d.title || 'Connections'));
    (d.chains || []).forEach(c => card.append(h('div', { class: 'pat' },
      h('div', { class: 'chain' }, c.nodes.flatMap((n, i) => i ? [h('em', {}, '→'), n] : [n])), c.why ? h('div', { class: 'meta' }, c.why) : null)));
    return card;
  },

  mission: (d, ctx) => {
    const st = d.stages || []; const done = st.filter(s => s.status === 'completed').length;
    const card = h('div', { class: 'card' }, head('Mission', d.title, h('span', { class: 'pill ' + (d.status === 'completed' ? 'good' : d.status === 'failed' ? 'bad' : 'info') }, d.status || 'running')),
      sec('', h('div', { class: 'muted' }, done + ' of ' + st.length + ' stages'), h('div', { class: 'bar' }, h('i', { style: 'width:' + (st.length ? done / st.length * 100 : 0) + '%' }))));
    st.forEach(s => card.append(h('div', { class: 'stage ' + (s.status || 'pending') },
      h('span', { class: 'st' }, s.status === 'completed' ? icon('check') : s.status === 'failed' ? icon('x') : null), h('span', { class: 'lbl' }, s.label), h('span', { class: 's' }, s.status || 'pending'))));
    if (d.status !== 'completed' && d.status !== 'cancelled') card.append(h('div', { class: 'card-btns' },
      h('button', { class: 'sbtn', on: { click: () => Bus.emit('mission:action', { id: d.id, action: d.status === 'paused' ? 'resume' : 'pause' }) } }, d.status === 'paused' ? 'Resume' : 'Pause'),
      h('button', { class: 'sbtn', on: { click: () => Bus.emit('mission:action', { id: d.id, action: 'cancel' }) } }, 'Cancel')));
    return card;
  },

  /* ---------- structured question from the AI ---------- */
  ask: (d, ctx) => {
    const qs = d.questions || [];
    const card = h('div', { class: 'card ask' });
    if (d.answered) {
      card.append(head('Question answered', null));
      d.answered.forEach(a => card.append(h('div', { class: 'kvr' }, h('b', {}, a.header || 'Q'), h('span', {}, a.answer || 'Skipped'))));
      return card;
    }
    const dr = d.draft = d.draft || { page: 0, sel: qs.map(() => []), other: qs.map(() => '') };
    const q = qs[dr.page]; const multi = !!q.multi; const last = dr.page === qs.length - 1;
    const hasAns = (i) => dr.sel[i].length > 0 || (dr.other[i] || '').trim();
    card.append(head('Adarsh needs your input', null, qs.length > 1 ? h('div', { class: 'pg', 'aria-label': 'Question ' + (dr.page + 1) + ' of ' + qs.length }, qs.map((_, i) => h('i', { class: i === dr.page ? 'on' : '' }))) : null));
    card.append(h('div', { class: 'q' }, q.header ? h('span', { class: 'hd' }, q.header) : null, h('p', { class: 'qt' }, q.question)));
    const opts = h('div', { class: 'opts', role: multi ? 'group' : 'radiogroup' });
    (q.options || []).forEach((o, oi) => {
      const on = dr.sel[dr.page].includes(oi);
      opts.append(h('button', { class: 'opt' + (on ? ' on' : ''), role: multi ? 'checkbox' : 'radio', 'aria-checked': String(on), on: {
        click: () => {
          const a = dr.sel[dr.page];
          if (multi) { const k = a.indexOf(oi); k >= 0 ? a.splice(k, 1) : a.push(oi); } else { dr.sel[dr.page] = [oi]; dr.other[dr.page] = ''; }
          vibe(); ctx.redraw();
        }
      } }, h('span', { class: 'mk' + (multi ? ' sq' : '') }, on ? icon('check') : null),
      h('span', { class: 'ot' }, h('b', {}, o.label), o.description ? h('small', {}, o.description) : null)));
    });
    if (q.allowOther !== false) {
      const inp = h('input', { type: 'text', placeholder: 'Something else…', value: dr.other[dr.page] || '', 'aria-label': 'Other answer', on: { input: () => { dr.other[dr.page] = inp.value; if (!multi && inp.value) dr.sel[dr.page] = []; foot.sub.disabled = !hasAns(dr.page); } } });
      opts.append(h('label', { class: 'opt other' }, h('span', { class: 'mk' + (multi ? ' sq' : '') }, icon('edit', 's')), inp));
    }
    card.append(opts);
    const sub = h('button', { class: 'btn pri', disabled: !hasAns(dr.page), on: { click: () => (last ? submit(false) : (dr.page++, ctx.redraw())) } }, last ? 'Submit' : 'Next');
    const foot = { sub };
    card.append(h('div', { class: 'ask-foot' },
      dr.page > 0 ? h('button', { class: 'link', on: { click: () => { dr.page--; ctx.redraw(); } } }, 'Back') : h('button', { class: 'link', on: { click: () => submit(true) } }, 'Skip'),
      h('span', { class: 'sp' }), sub));
    function submit(skip) {
      d.answered = skip ? qs.map(x => ({ header: x.header, question: x.question, answer: '' })) : qs.map((x, i) => ({
        header: x.header, question: x.question,
        answer: [...dr.sel[i].map(k => x.options[k].label), (dr.other[i] || '').trim()].filter(Boolean).join(', ')
      }));
      delete d.draft; save(); ctx.redraw(); Bus.emit('ask:answer', { msg: ctx.msg, askId: d.id, answers: d.answered, skipped: skip });
    }
    return card;
  },

  /* ---------- permission request ---------- */
  approve: (d, ctx) => {
    const risk = d.risk || 'medium';
    const card = h('div', { class: 'card approve' + (risk === 'high' ? ' risk-high' : '') },
      head('Permission needed', d.title, h('span', { class: 'pill ' + (risk === 'high' ? 'bad' : risk === 'low' ? 'good' : 'warn') }, risk + ' risk')));
    if (d.detail) card.append(sec('', h('p', {}, d.detail)));
    if (d.action) card.append(h('div', { class: 'kvr' }, h('b', {}, 'Action'), h('span', { class: 'mono', style: 'font-size:13px' }, d.action)));
    if (d.scope) card.append(h('div', { class: 'kvr' }, h('b', {}, 'Scope'), h('span', {}, d.scope)));
    if (d.decision) {
      card.append(h('div', { class: 'decided ' + d.decision }, icon(d.decision === 'allow' ? 'check' : 'x', 's'),
        d.decision === 'allow' ? 'Allowed' : d.decision === 'deny' ? 'Denied' : 'Expired'));
    } else {
      const go = (decision) => { d.decision = decision; save(); ctx.redraw(); Bus.emit('approve:decide', { msg: ctx.msg, id: d.id, decision, title: d.title }); };
      card.append(h('div', { class: 'card-btns' },
        h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => go('deny') } }, 'Deny'),
        h('button', { class: 'btn pri', style: 'flex:1', on: { click: () => go('allow') } }, 'Allow')));
    }
    return card;
  },

  memory: (d, ctx) => h('div', { class: 'chipcard' + (d.gone ? ' gone' : '') }, h('span', { class: 'ci' }, icon('brain', 's')),
    h('span', { class: 'ct' }, h('b', {}, d.gone ? 'Removed from memory' : 'Saved to memory'), h('span', {}, d.text)),
    d.gone ? null : h('button', { class: 'link', on: { click: () => { Bus.emit('memory:undo', { msg: ctx.msg }); ctx.redraw(); } } }, 'Undo')),

  task: (d, ctx) => { const f = fmtDue(d.due); return h('div', { class: 'chipcard' + (d.gone ? ' gone' : '') }, h('span', { class: 'ci' }, icon('tasks', 's')),
    h('span', { class: 'ct' }, h('b', {}, d.gone ? 'Task removed' : 'Task added'), h('span', {}, d.title + (f.t ? ' · ' + f.t : ''))),
    d.gone ? null : h('button', { class: 'link', on: { click: () => { Bus.emit('task:undo', { msg: ctx.msg }); ctx.redraw(); } } }, 'Undo')); }
};

/* unknown reply type: degrade to text rather than crash */
function renderReply(d, ctx) {
  try {
    const el = (RENDER[d.type] || RENDER.text)(RENDER[d.type] ? d : { text: d.text || JSON.stringify(d, null, 2) }, ctx);
    if (d._detailsOmitted) el.append(omittedNotice());
    return el;
  }
  catch (e) { console.error('render', d.type, e); return md('Could not display this reply (' + d.type + ').'); }
}

/* what the voice mode reads out loud for each reply type */
function speechOf(d) {
  switch (d.type) {
    case 'text': case 'blocked': case 'clarification': return stripMd(d.text);
    case 'research': return stripMd(d.summary || d.question);
    case 'debate': return stripMd(d.verdict);
    case 'ask': return (d.questions && d.questions[0] && d.questions[0].question) || 'I have a question.';
    case 'approve': return 'Permission needed. ' + (d.title || '') + '. Should I go ahead?';
    case 'memory': return 'Saved to memory.';
    case 'task': return 'Task added: ' + (d.title || '');
    case 'actions': return stripMd(d.text || 'Kaam kar raha hoon.');
    case 'mission': return 'Mission ' + (d.title || '') + ' is ' + (d.status || 'running') + '.';
    default: return '';
  }
}
