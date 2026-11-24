'use strict';
/* 04-productivity-views.js : manual productivity pages for the parent shell. */

const productivityApi = () => {
  if (typeof Productivity !== 'undefined') return Productivity;
  if (typeof window !== 'undefined' && window.Productivity) return window.Productivity;
  return null;
};

const nativeBridge = () => (typeof window !== 'undefined' ? window.AdarshNative : null);
const hasNativeRecords = () => {
  const n = nativeBridge();
  return !!(n && typeof n.recordsList === 'function');
};

function productivityList(kind) {
  const p = productivityApi();
  if (p && typeof p.list === 'function') {
    try {
      const value = p.list(kind);
      return Array.isArray(value) ? value : [];
    } catch (e) { return []; }
  }
  const n = nativeBridge();
  if (n && typeof n.recordsList === 'function') {
    try {
      const value = JSON.parse(n.recordsList(kind));
      return Array.isArray(value) ? value : (value && Array.isArray(value.records) ? value.records : []);
    } catch (e) { return []; }
  }
  return [];
}

async function productivityManual(action, args) {
  const p = productivityApi();
  if (!p || typeof p.manual !== 'function') return { ok: false, message: 'Productivity abhi available nahi.' };
  try { return await p.manual(action, args); }
  catch (e) { return { ok: false, message: e && e.message ? e.message : 'Could not save that.' }; }
}

async function productivitySync() {
  const p = productivityApi();
  if (!p || typeof p.sync !== 'function') return { ok: true };
  try { return await p.sync(); }
  catch (e) { return { ok: false, message: e && e.message ? e.message : 'Records refresh nahi hue.' }; }
}

function nativeOrBrowserNotice() {
  if (hasNativeRecords()) {
    return 'Android notifications can arrive even when this screen is closed. Force-stopping the app pauses them.';
  }
  return 'Browser fallback runs only while this tab is open. Keep this tab open for scheduled alerts.';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateTimeValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function localDateValue(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function localDateTimeMs(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function displayDateTime(value) {
  if (value == null || value === '') return 'No time set';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Invalid time' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function displayDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function recordText(record) { return String((record && (['task', 'work'].includes(record.kind) ? record.title || record.text : record.text || record.title)) || ''); }
function recordTime(record) { return record && (record.at || record.created || record.updated); }
function sortNewest(a, b) { return (Number(recordTime(b)) || 0) - (Number(recordTime(a)) || 0); }
function positiveNumber(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}
function progressNumber(value, optional) {
  if (optional && (value === '' || value == null)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
function field(label, control, hint) {
  return h('label', { class: 'pv-field' }, h('span', { class: 'pv-label' }, label), control, hint ? h('small', { class: 'pv-hint' }, hint) : null);
}
function textInput(label, value, placeholder, type) {
  return field(label, h('input', { class: 'pv-input', type: type || 'text', value: value || '', placeholder: placeholder || '', autocomplete: 'off' }));
}
function actionButtons(saveLabel, onSave, onCancel) {
  return h('div', { class: 'pv-actions' }, h('button', { class: 'btn pri', type: 'button', on: { click: onSave } }, saveLabel), onCancel ? h('button', { class: 'btn ghost', type: 'button', on: { click: onCancel } }, 'Cancel') : null);
}
function emptyState(ic, title, text, example) {
  return h('div', { class: 'pv-empty' }, icon(ic), h('b', {}, title), text ? h('span', {}, text) : null);
}
function searchControl(placeholder, onInput) {
  const input = h('input', { class: 'search pv-search', type: 'search', placeholder, 'aria-label': placeholder });
  input.addEventListener('input', () => onInput(input.value.trim().toLowerCase()));
  return input;
}
function recordMatches(record, query) {
  return !query || recordText(record).toLowerCase().includes(query) || String(record.category || '').toLowerCase().includes(query) || String(record.goal || '').toLowerCase().includes(query);
}
function warningToast(result) {
  if (result && result.warning) toast(String(result.warning), { ms: 6500 });
}
async function finishMutation(action, args, redraw, fallbackMessage) {
  const result = await productivityManual(action, args);
  if (!result || !result.ok) { toast((result && result.message) || 'Could not save that.'); return false; }
  await productivitySync();
  redraw();
  toast(result.message || fallbackMessage);
  warningToast(result);
  return true;
}
async function finishDelete(id, redraw) {
  const p = productivityApi();
  let result;
  try { result = p && typeof p.removeManual === 'function' ? await p.removeManual(id) : { ok: false, message: 'Delete abhi available nahi.' }; }
  catch (e) { result = { ok: false, message: e && e.message ? e.message : 'Delete nahi hua.' }; }
  if (!result || !result.ok) { toast((result && result.message) || 'Delete nahi hua.'); return; }
  await productivitySync();
  redraw();
  toast(result.message || 'Deleted');
  warningToast(result);
}
function askDelete(record, redraw) {
  confirmSheet({
    title: 'Delete this record?',
    text: 'This deletes the record and cancels its scheduled alert. Only your manual confirmation can do this; the AI cannot delete records.',
    label: 'Delete',
    danger: true,
    onYes: () => { finishDelete(record.id, redraw); }
  });
}
function editSheet(title, build) { sheet({ title, tall: true, build }); }
function editSchedule(kind, record, redraw) {
  const title = h('input', { class: 'pv-input', type: 'text', value: recordText(record), 'aria-label': 'Title' });
  const at = h('input', { class: 'pv-input', type: 'datetime-local', value: localDateTimeValue(record.at), 'aria-label': 'Date and time' });
  editSheet(kind === 'task' ? 'Edit task' : 'Edit ' + kind, (body, close) => {
    body.append(field('Title', title), field('When', at), actionButtons('Save changes', async () => {
      const text = title.value.trim();
      if (!text) return toast('Pehle title likho.');
      const time = localDateTimeMs(at.value);
      if (at.value && time == null) return toast('Sahi date aur time chuno.');
      const action = kind === 'task' ? 'task.edit' : kind + '.edit';
      const args = kind === 'task' ? { id: record.id, title: text } : { id: record.id, text };
      if (time && localDateTimeValue(record.at) !== at.value) args.at = time;
      if (!time && record.at) return toast('Alert time clear nahi kiya. Naya time select karo, ya record manually delete karo.');
      const ok = await finishMutation(action, args, redraw, 'Updated');
      if (ok) close();
    }, close));
  });
}
function scheduleRow(kind, record, redraw) {
  const fired = !!record.firedAt;
  const completed = !!record.done;
  const status = fired ? 'Fired · ' + displayDateTime(record.firedAt) : completed ? 'Completed' : 'Scheduled';
  const edit = h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit', on: {
    click: () => editSheet(kind === 'task' ? 'Edit task' : 'Edit ' + kind, (body, close) => scheduleEditBody(kind, record, redraw, body, close))
  } }, icon('edit', 's'));
  const remove = h('button', { class: 'pv-icon-btn is-danger', type: 'button', 'aria-label': 'Delete', on: {
    click: () => askDelete(record, redraw)
  } }, icon('trash', 's'));
  return h('article', { class: 'pv-record' },
    h('div', { class: 'pv-record-main' },
      h('div', { class: 'pv-record-title' }, icon(kind === 'alarm' ? 'bell' : kind === 'task' ? 'tasks' : 'bell', 's'), h('b', {}, recordText(record))),
      h('small', {}, displayDateTime(record.at))),
    h('div', { class: 'pv-record-meta' },
      h('span', { class: 'pv-status ' + (fired ? 'is-fired' : completed ? 'is-done' : '') }, status),
      h('div', { class: 'pv-record-actions' }, edit, remove)));
}
function scheduleEditBody(kind, record, redraw, body, close) {
  const text = h('input', { class: 'pv-input', type: 'text', value: recordText(record), 'aria-label': 'Title' });
  const at = h('input', { class: 'pv-input', type: 'datetime-local', value: localDateTimeValue(record.at), 'aria-label': 'Date and time' });
  body.append(field('Title', text), field('When', at), actionButtons('Save changes', async () => {
    const value = text.value.trim();
    if (!value) return toast('Pehle title likho.');
    const time = localDateTimeMs(at.value);
    if (at.value && time == null) return toast('Sahi date aur time chuno.');
    const action = kind === 'task' ? 'task.edit' : kind + '.edit';
    const args = kind === 'task' ? { id: record.id, title: value } : { id: record.id, text: value };
    if (time && localDateTimeValue(record.at) !== at.value) args.at = time;
    if (!time && record.at) return toast('Alert time clear nahi kiya. Naya time select karo, ya record manually delete karo.');
    const ok = await finishMutation(action, args, redraw, 'Updated');
    if (ok) close();
  }, close));
}

function tasksView(st, redraw) {
  const title = h('input', { class: 'pv-input', type: 'text', placeholder: 'What needs doing?', 'aria-label': 'New task title' });
  const at = h('input', { class: 'pv-input', type: 'datetime-local', 'aria-label': 'Due date and time' });
  const add = async () => {
    const value = title.value.trim();
    if (!value) return toast('Pehle task title likho.');
    const time = localDateTimeMs(at.value);
    if (at.value && time == null) return toast('Sahi date aur time chuno.');
    const ok = await finishMutation('task.add', { title: value, at: time }, redraw, 'Task added');
    if (ok) { title.value = ''; at.value = ''; }
  };
  st.append(h('div', { class: 'pv-intro' }, h('b', {}, 'Tasks'), h('span', {}, '')), h('div', { class: 'pv-form pv-form-card' }, field('Task', title), field('Due (optional)', at), actionButtons('Add task', add)));
  const list = h('div', { class: 'pv-list-wrap' });
  const render = (query) => {
    list.textContent = '';
    const all = productivityList('task').slice().sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || sortNewest(a, b));
    const rows = all.filter(r => recordMatches(r, query));
    if (!all.length) return list.append(emptyState('tasks', 'Abhi koi task nahi', '', 'Submit expense report · tomorrow 10:00'));
    if (!rows.length) return list.append(emptyState('search', 'Kuch nahi mila', ''));
    rows.forEach(record => {
      const done = !!record.done;
      const check = h('button', { class: 'pv-check', type: 'button', role: 'checkbox', 'aria-checked': String(done), 'aria-label': done ? 'Mark task open' : 'Mark task complete', on: {
        click: () => finishMutation('task.done', { id: record.id, done: !done }, redraw, done ? 'Task reopened' : 'Task completed')
      } }, done ? icon('check', 's') : null);
      const edit = h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit task', on: {
        click: () => editSchedule('task', record, redraw)
      } }, icon('edit', 's'));
      const remove = h('button', { class: 'pv-icon-btn is-danger', type: 'button', 'aria-label': 'Delete task', on: {
        click: () => askDelete(record, redraw)
      } }, icon('trash', 's'));
      list.append(h('article', { class: 'pv-record' + (done ? ' is-complete' : '') }, check,
        h('div', { class: 'pv-record-main' },
          h('div', { class: 'pv-record-title' }, h('b', {}, recordText(record))),
          h('small', {}, record.at ? displayDateTime(record.at) : 'No due time')),
        h('div', { class: 'pv-record-actions' }, edit, remove)));
    });
  };
  st.append(h('div', { class: 'pv-search-row' }, searchControl('Search tasks', render)), list);
  render('');
}

function scheduleView(kind, st, redraw) {
  const label = kind === 'reminder' ? 'Reminder' : 'Alarm';
  const text = h('input', { class: 'pv-input', type: 'text', placeholder: kind === 'reminder' ? 'Take a break' : 'Team stand-up', 'aria-label': 'New ' + label.toLowerCase() });
  const at = h('input', { class: 'pv-input', type: 'datetime-local', 'aria-label': label + ' date and time' });
  const add = async () => {
    const value = text.value.trim();
    if (!value) return toast('Add some text first.');
    const time = localDateTimeMs(at.value);
    if (time == null) return toast('Sahi date aur time chuno.');
    const ok = await finishMutation(kind + '.add', { text: value, at: time }, redraw, label + ' scheduled');
    if (ok) { text.value = ''; at.value = ''; }
  };
  st.append(h('div', { class: 'pv-intro' }, h('b', {}, label + 's'), h('span', {}, 'Set schedules yourself; nothing changes mode or runs automatically.')), h('p', { class: 'pv-platform-note' }, nativeOrBrowserNotice()), h('div', { class: 'pv-form pv-form-card' }, field(label, text), field('When', at), actionButtons('Schedule ' + label.toLowerCase(), add)));
  const list = h('div', { class: 'pv-list-wrap' });
  const render = (query) => {
    list.textContent = '';
    const all = productivityList(kind).slice().sort(sortNewest);
    const rows = all.filter(r => recordMatches(r, query));
    if (!all.length) return list.append(emptyState('bell', 'Abhi koi ' + label.toLowerCase() + ' nahi', '', kind === 'reminder' ? 'Water the plants · Friday 18:00' : 'Call home · Saturday 09:00'));
    if (!rows.length) return list.append(emptyState('search', 'Kuch nahi mila', ''));
    rows.forEach(r => list.append(scheduleRow(kind, r, redraw)));
  };
  st.append(h('div', { class: 'pv-search-row' }, searchControl('Search ' + label.toLowerCase() + 's', render)), list);
  render('');
}

function timerRow(record, redraw) {
  return h('article', { class: 'pv-record' }, h('div', { class: 'pv-record-main' }, h('div', { class: 'pv-record-title' }, icon('target', 's'), h('b', {}, recordText(record) || 'Timer')), h('small', {}, record.at ? displayDateTime(record.at) : 'Timer started')), h('div', { class: 'pv-record-meta' }, h('span', { class: 'pv-status ' + (record.firedAt ? 'is-fired' : '') }, record.firedAt ? 'Fired' : 'Running / scheduled'), h('button', { class: 'pv-icon-btn is-danger', type: 'button', 'aria-label': 'Delete timer record', on: { click: () => askDelete(record, redraw) } }, icon('trash', 's'))));
}
function alarmsView(st, redraw) {
  scheduleView('alarm', st, redraw);
  const timerRoot = h('section', { class: 'pv-section pv-timers' });
  const seconds = h('input', { class: 'pv-input', type: 'number', min: '1', max: '1440', step: '1', placeholder: 'Minutes', 'aria-label': 'Timer minutes' });
  const timerText = h('input', { class: 'pv-input', type: 'text', placeholder: 'Focus session', 'aria-label': 'Timer label' });
  const start = async () => {
    const mins = positiveNumber(seconds.value, 1440);
    if (mins == null) return toast('Timer minutes must be positive and at most 1440.');
    const value = timerText.value.trim() || 'Timer';
    const ok = await finishMutation('timer.start', { seconds: Math.round(mins * 60), text: value }, redraw, 'Timer started');
    if (ok) { seconds.value = ''; timerText.value = ''; }
  };
  timerRoot.append(h('div', { class: 'pv-section-head' }, h('div', {}, h('b', {}, 'Timers'), h('small', {}, 'A timer is a manual alarm, not a work-project entry.'))), h('div', { class: 'pv-form pv-form-card' }, field('Minutes', seconds, 'Positive whole or decimal minutes, up to 1440.'), field('Label', timerText), actionButtons('Start timer', start)));
  const timerList = h('div', { class: 'pv-list-wrap' });
  const renderTimers = () => {
    timerList.textContent = '';
    const timers = productivityList('timer').slice().sort(sortNewest);
    if (!timers.length) timerList.append(emptyState('target', 'Abhi koi timer nahi', '', '25 minutes · Deep work'));
    else timers.forEach(r => timerList.append(timerRow(r, redraw)));
  };
  timerRoot.append(timerList);
  st.append(timerRoot);
  renderTimers();
}

function noteEdit(record, redraw) {
  editSheet('Edit note', (body, close) => {
    const text = h('textarea', { class: 'pv-textarea', placeholder: 'Write a note', 'aria-label': 'Note text' });
    text.value = recordText(record);
    body.append(field('Note', text), actionButtons('Save note', async () => {
      const value = text.value.trim();
      if (!value) return toast('Write something first.');
      const ok = await finishMutation('note.edit', { id: record.id, text: value }, redraw, 'Note updated');
      if (ok) close();
    }, close));
  });
}
function notesView(st, redraw) {
  const text = h('textarea', { class: 'pv-textarea', placeholder: 'Capture a thought, instruction, or idea…', 'aria-label': 'New note' });
  const add = async () => {
    const value = text.value.trim();
    if (!value) return toast('Write something first.');
    const ok = await finishMutation('note.add', { text: value }, redraw, 'Note saved');
    if (ok) text.value = '';
  };
  st.append(h('div', { class: 'pv-intro' }, h('b', {}, 'Notes'), h('span', {}, '')), h('div', { class: 'pv-form pv-form-card' }, field('New note', text), actionButtons('Save note', add)));
  const list = h('div', { class: 'pv-list-wrap' });
  const render = (query) => {
    list.textContent = '';
    const all = productivityList('note').slice().sort(sortNewest);
    const rows = all.filter(r => recordMatches(r, query));
    if (!all.length) return list.append(emptyState('file', 'Abhi koi note nahi', '', 'Prepare questions for Monday’s meeting'));
    if (!rows.length) return list.append(emptyState('search', 'Kuch nahi mila', ''));
    rows.forEach(r => {
      const edit = h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit note', on: {
        click: () => noteEdit(r, redraw)
      } }, icon('edit', 's'));
      const remove = h('button', { class: 'pv-icon-btn is-danger', type: 'button', 'aria-label': 'Delete note', on: {
        click: () => askDelete(r, redraw)
      } }, icon('trash', 's'));
      list.append(h('article', { class: 'pv-note' }, h('p', {}, recordText(r)),
        h('div', { class: 'pv-note-foot' },
          h('small', {}, displayDateTime(r.updated || r.created)),
          h('div', { class: 'pv-record-actions' }, edit, remove))));
    });
  };
  st.append(h('div', { class: 'pv-search-row' }, searchControl('Search notes', render)), list);
  render('');
}

function workEdit(record, redraw) {
  editSheet('Edit project', (body, close) => {
    const title = h('input', { class: 'pv-input', type: 'text', value: record.title || '', 'aria-label': 'Project title' });
    const category = h('input', { class: 'pv-input', type: 'text', value: record.category || '', 'aria-label': 'Category' });
    const goal = h('textarea', { class: 'pv-textarea', 'aria-label': 'Goal' }); goal.value = record.goal || '';
    const progress = h('input', { class: 'pv-input', type: 'number', min: '0', max: '100', step: '1', value: String(record.progress == null ? 0 : record.progress), 'aria-label': 'Progress percent' });
    const outcome = h('textarea', { class: 'pv-textarea', placeholder: 'What did this produce?', 'aria-label': 'Outcome' }); outcome.value = record.outcome || '';
    body.append(field('Title', title), field('Category', category), field('Goal', goal), field('Progress %', progress, '0 to 100.'), field('Outcome', outcome), actionButtons('Save changes', async () => {
      const name = title.value.trim();
      const pct = progressNumber(progress.value, false);
      if (!name) return toast('Pehle project title likho.');
      if (pct == null) return toast('Progress must be between 0 and 100.');
      const ok = await finishMutation('work.edit', { id: record.id, title: name, category: category.value.trim(), goal: goal.value.trim(), progress: pct, outcome: outcome.value.trim() }, redraw, 'Project updated');
      if (ok) close();
    }, close));
  });
}
function workLog(record, redraw) {
  editSheet('Log project activity', (body, close) => {
    const date = h('input', { class: 'pv-input', type: 'date', value: localDateValue(), 'aria-label': 'Activity date' });
    const minutes = h('input', { class: 'pv-input', type: 'number', min: '1', max: '1440', step: '1', placeholder: 'Minutes', 'aria-label': 'Minutes worked' });
    const text = h('textarea', { class: 'pv-textarea', placeholder: 'What happened?', 'aria-label': 'Activity text' });
    const progress = h('input', { class: 'pv-input', type: 'number', min: '0', max: '100', step: '1', placeholder: 'Optional', 'aria-label': 'Progress percent' });
    const outcome = h('textarea', { class: 'pv-textarea', placeholder: 'Result or next outcome', 'aria-label': 'Activity result' });
    body.append(field('Date', date), field('Minutes', minutes, 'Positive, up to 1440.'), field('Activity', text), field('Progress % (optional)', progress, 'Khaali chhodo to progress wahi rahega.'), field('Result', outcome), actionButtons('Log activity', async () => {
      const mins = positiveNumber(minutes.value, 1440);
      const pct = progressNumber(progress.value, true);
      if (mins == null || !Number.isInteger(mins)) return toast('Minutes must be whole, positive and at most 1440.');
      if (pct === null) return toast('Progress must be between 0 and 100.');
      if (!date.value) return toast('Activity date chuno.');
      if (!text.value.trim()) return toast('Pehle activity likho.');
      const args = { id: record.id, text: text.value.trim(), date: date.value, minutes: mins, outcome: outcome.value.trim() };
      if (pct !== undefined) args.progress = pct;
      const ok = await finishMutation('work.log', args, redraw, 'Activity logged');
      if (ok) close();
    }, close));
  });
}
function projectCard(record, redraw) {
  const entries = Array.isArray(record.entries) ? record.entries.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))) : [];
  const total = Number(record.minutes) || entries.reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0);
  const pct = Math.max(0, Math.min(100, Number(record.progress) || 0));
  const entryList = entries.length ? h('div', { class: 'pv-entries' }, entries.map(entry => h('div', { class: 'pv-entry' }, h('div', { class: 'pv-entry-head' }, h('b', {}, entry.date || 'Undated'), h('span', {}, (Number(entry.minutes) || 0) + ' min')), h('p', {}, entry.text || ''), entry.progress == null && !entry.outcome ? null : h('small', {}, (entry.progress == null ? '' : 'Progress ' + entry.progress + '%') + (entry.progress == null || !entry.outcome ? '' : ' · ') + (entry.outcome || ''))))) : h('p', { class: 'pv-muted' }, 'No activity logged yet. Use “Log activity” for deliberate project work.');
  return h('article', { class: 'pv-project' }, h('div', { class: 'pv-project-head' }, h('div', { class: 'pv-project-title' }, h('b', {}, record.title || 'Untitled project'), record.category ? h('span', { class: 'pv-chip' }, record.category) : null), h('div', { class: 'pv-record-actions' }, h('button', { class: 'pv-icon-btn', type: 'button', 'aria-label': 'Edit project', on: { click: () => workEdit(record, redraw) } }, icon('edit', 's')), h('button', { class: 'pv-icon-btn is-danger', type: 'button', 'aria-label': 'Delete project', on: { click: () => askDelete(record, redraw) } }, icon('trash', 's')))), record.goal ? h('p', { class: 'pv-project-goal' }, record.goal) : null, h('div', { class: 'pv-progress-line' }, h('div', { class: 'pv-progress-bar' }, h('i', { style: 'width:' + pct + '%' })), h('span', {}, pct + '%')), h('div', { class: 'pv-project-stats' }, h('span', {}, 'Total minutes ', h('b', {}, String(total))), h('span', {}, 'Entries ', h('b', {}, String(entries.length)))), record.outcome ? h('div', { class: 'pv-outcome' }, h('b', {}, 'Outcome'), h('span', {}, record.outcome)) : null, h('details', { class: 'pv-entry-details' }, h('summary', {}, 'Activity log', h('span', {}, entries.length ? String(entries.length) : 'empty')), entryList), h('button', { class: 'btn ghost pv-log-btn', type: 'button', on: { click: () => workLog(record, redraw) } }, icon('plus', 's'), 'Log activity'));
}
function workView(st, redraw) {
  const title = h('input', { class: 'pv-input', type: 'text', placeholder: 'Launch the community workshop', 'aria-label': 'Project title' });
  const category = h('input', { class: 'pv-input', type: 'text', placeholder: 'Work, study, personal', 'aria-label': 'Project category' });
  const goal = h('textarea', { class: 'pv-textarea', placeholder: 'What does done look like?', 'aria-label': 'Project goal' });
  const add = async () => {
    const name = title.value.trim();
    if (!name) return toast('Pehle project title likho.');
    if (!goal.value.trim()) return toast('Pehle project goal likho.');
    const ok = await finishMutation('work.add', { title: name, category: category.value.trim(), goal: goal.value.trim() }, redraw, 'Project added');
    if (ok) { title.value = ''; category.value = ''; goal.value = ''; }
  };
  st.append(h('div', { class: 'pv-intro' }, h('b', {}, 'Work projects'), h('span', {}, 'For large, explicit projects only. Completing a task never creates a project entry automatically.')), h('div', { class: 'pv-form pv-form-card' }, field('Project title', title), field('Category', category), field('Goal', goal), actionButtons('Add project', add)));
  const list = h('div', { class: 'pv-list-wrap' });
  const render = (query) => {
    list.textContent = '';
    const all = productivityList('work').slice().sort(sortNewest);
    const rows = all.filter(r => recordMatches(r, query));
    if (!all.length) return list.append(emptyState('flag', 'Abhi koi work project nahi', 'Sirf bade kaam ke liye.', 'Ship the Q4 onboarding refresh'));
    if (!rows.length) return list.append(emptyState('search', 'Kuch nahi mila', ''));
    rows.forEach(r => list.append(projectCard(r, redraw)));
  };
  st.append(h('div', { class: 'pv-search-row' }, searchControl('Search projects', render)), list);
  render('');
}

const ProductivityViews = {
  tasks: tasksView,
  reminders: (st, redraw) => scheduleView('reminder', st, redraw),
  alarms: alarmsView,
  notes: notesView,
  work: workView
};

if (typeof window !== 'undefined') window.ProductivityViews = ProductivityViews;
