/* Lessons: the one-line "kya galat tha" after a thumbs-down on a MANUAL master answer, and the list of rules.
   No model is called here. The rules are stored on the device (or the server) and put into the next master prompt. */
const Lessons = (() => {
  const call = async (op) => { try { return await Backend.lessons(op); } catch (e) { return { ok: false, error: 'Lessons nahi khule.' }; } };
  const HINTS = [
    ['Source/tag galat', 'Source tag galat laga: baat us answer me nahi thi jiska tag diya.'],
    ['Apni taraf se likha', 'Apni taraf se baat likhi. Sirf paste kiye answers ki baat likho.'],
    ['Section chhoota', 'Koi section chhoot gaya. Saare 7 section hone chahiye.'],
    ['Naam/saal gadha', 'Naam ya saal bina source ke likha. Na ho to likho: Paste kiye answers me nahi hai.'],
    ['Takraav chhupaya', 'Answers me takraav tha, wo dikhana chahiye tha.']
  ];

  /* thumbs-down on a master answer: ask what was wrong (optional) and keep it as the user's own rule */
  function feedbackSheet() {
    sheet({ title: 'Kya galat tha?', build(b, close) {
      const ta = h('textarea', { rows: '3', maxlength: '300', placeholder: 'Ek line me likho, jaise: "Kaise socha me apna andaza mat likho"', 'aria-label': 'Kya galat tha', style: 'width:100%;background:var(--card);border:0;border-radius:14px;padding:12px;color:var(--fg);resize:none' });
      b.append(h('p', {}, 'Ye line ek rule ban kar agle master answer ke prompt me jaayegi. Khali chhodo to bas 👎 darj hoga.'),
        h('div', { class: 'chips' }, HINTS.map(([l, t]) => h('button', { class: 'sbtn', on: { click: () => { ta.value = t; ta.focus(); } } }, l))), ta,
        h('div', { class: 'frow' },
          h('button', { class: 'btn ghost', style: 'flex:1', on: { click: close } }, 'Rehne do'),
          h('button', { class: 'btn pri', style: 'flex:1', on: { click: async () => {
            const t = ta.value.trim(); if (!t) { close(); return; }
            const r = await call({ op: 'add', text: t });
            if (r && r.ok) { toast('Rule yaad rakh liya'); close(); } else toast((r && r.error) || 'Save nahi hua');
          } } }, 'Rule banao')));
    } });
  }

  /* thumbs-up: the rules that were in this answer's prompt worked */
  async function good(m) {
    const ids = (m.reply && m.reply.lessonIds) || [];
    if (!ids.length || m.lessonGood) return;
    m.lessonGood = true;
    await call({ op: 'good', ids });
  }

  function listSheet(onChange) {
    sheet({ title: 'Lessons', tall: true, build(b) {
      const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
      const paint = (r) => {
        wrap.replaceChildren();
        if (!r || !r.ok) { wrap.append(h('p', { class: 'warn' }, (r && r.error) || 'Lessons nahi khule.')); return; }
        const items = r.lessons || [];
        if (onChange) onChange(items.length);
        if (!items.length) { wrap.append(h('p', { class: 'muted' }, 'Abhi koi lesson nahi.')); return; }
        items.forEach(x => wrap.append(h('div', { class: 'ccard' },
          h('div', { class: 'ch' }, h('b', {}, x.title || 'Tumhara rule'), h('span', { class: 'chips' },
            h('span', { class: 'pill ' + (x.origin === 'user' ? 'info' : 'mute') }, x.origin === 'user' ? 'tumhara' : 'auto'),
            h('span', { class: 'pill mute' }, 'wazan ' + x.weight))),
          h('p', {}, x.text),
          h('div', { class: 'ml' }, 'Nibhaya ' + x.held + ' baar'),
          h('div', { class: 'frow' },
            h('button', { class: 'btn ghost', style: 'flex:1', on: { click: () => editSheet(x, paint) } }, 'Badlo'),
            h('button', { class: 'btn ghost', style: 'flex:1', on: { click: async () => paint(await call({ op: 'delete', id: x.id })) } }, 'Hatao')))));
        wrap.append(h('button', { class: 'btn danger', on: { click: () => confirmSheet({ title: 'Saare lessons hatao?', text: 'Master answer phir bina sikhe rules ke shuru hoga.', label: 'Hatao', danger: true, top: true, onYes: async () => paint(await call({ op: 'clear' })) }) } }, 'Sab hatao'));
      };
      /* manual lesson: the user writes a rule directly, no thumbs-down needed */
      const ta = h('textarea', { rows: '3', maxlength: '300', placeholder: 'Apna rule likho, jaise: "Har jawab me pehle seedha answer do, phir detail"', 'aria-label': 'Naya lesson', class: 'lesson-new', style: 'width:100%;background:var(--card);border:0;border-radius:14px;padding:12px;color:var(--fg);resize:none' });
      const addBtn = h('button', { class: 'btn pri', 'data-lesson-add': '1', on: { click: async () => {
        const t = ta.value.trim();
        if (!t) { toast('Pehle lesson likho'); ta.focus(); return; }
        addBtn.disabled = true;
        const r = await call({ op: 'add', text: t });
        addBtn.disabled = false;
        if (r && r.ok) { ta.value = ''; toast('Lesson jud gaya'); paint(r); } else toast((r && r.error) || 'Save nahi hua');
      } } }, 'Lesson jodo');
      b.append(h('p', {}, 'Sirf Manual mode ka master answer inhe padhta hai. Auto aur Hybrid inhe nahi dekhte. Model ke weights nahi badalte: ye rules prompt me jaate hain aur jo tootte hain unka wazan badhta hai.'),
        h('div', { class: 'ccard', style: 'display:flex;flex-direction:column;gap:8px' }, h('b', {}, 'Naya lesson khud likho'), ta, addBtn), wrap);
      wrap.append(h('p', { class: 'muted' }, 'Khul raha hai…'));
      call({ op: 'list' }).then(paint);
    } });
  }
  function editSheet(x, paint) {
    sheet({ title: 'Rule badlo', top: true, build(b, close) {
      const ta = h('textarea', { rows: '4', maxlength: '300', 'aria-label': 'Rule', style: 'width:100%;background:var(--card);border:0;border-radius:14px;padding:12px;color:var(--fg);resize:none' });
      ta.value = x.text;
      b.append(ta, h('button', { class: 'btn pri', on: { click: async () => {
        const r = await call({ op: 'edit', id: x.id, text: ta.value });
        if (r && r.ok) { close(); paint(r); } else toast((r && r.error) || 'Badla nahi');
      } } }, 'Save'));
    } });
  }

  return { feedbackSheet, good, listSheet };
})();
