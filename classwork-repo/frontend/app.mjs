const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#submit-dialog');
const state = { user: null, assignments: [], students: [], classes: [], classId: null, importResult: null, studentQuery: '', calendarData: null, calendarDay: '', calendarBack: null, historyData: null, reviewData: null, practiceOptions: null, assignment: null, dirty: false, busy: false, route: '', loading: false, loadError: '' };
let loadEpoch = 0;
let toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
const assignmentNow = a => a.serverNow && a.receivedAt !== undefined ? Date.parse(a.serverNow) + Math.max(0, performance.now() - a.receivedAt) : Date.now();
const closed = a => a.isClosed || ((a.effectiveDueAt || a.dueAt) && assignmentNow(a) >= Date.parse(a.effectiveDueAt || a.dueAt));
const deadline = a => a.dueAt ? `截止：${date(a.dueAt)}（北京时间）` : '不限截止时间';
const closedMessage = '已截止，不能提交。仍可保存草稿，老师处计为未交。';
function syncDeadlineUI() {
  const a = state.assignment;
  const timer = document.querySelector('#countdown');
  if (timer && a?.effectiveDueAt) {
    const seconds = Math.max(0, Math.ceil((Date.parse(a.effectiveDueAt) - assignmentNow(a)) / 1000));
    timer.textContent = `剩余 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  }
  if (state.user?.role !== 'student' || !a || a.submittedAt || !closed(a)) return;
  const start = document.querySelector('[data-action="start"]');
  if (start) { start.disabled = true; start.textContent = '已截止，不能开始'; }
  const message = document.querySelector('#deadline-state');
  if (message) { message.hidden = false; message.textContent = closedMessage; }
  const button = document.querySelector('[data-submit]');
  if (button) { button.disabled = true; button.textContent = '已截止'; }
  if (dialog.open) dialog.close();
}
function toast(message, error = false) {
  clearTimeout(toastTimer); notice.textContent = message; notice.classList.toggle('error', error); notice.hidden = false;
  toastTimer = setTimeout(() => { notice.hidden = true; }, error ? 8000 : 4000);
}
async function api(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data) });
  } catch { throw new Error('连接失败，请检查网络后重试。未保存的答案仍保留在本页。'); }
  const result = await response.json();
  for (const a of Array.isArray(result) ? result : [result]) if (a.serverNow) a.receivedAt = performance.now();
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      loadEpoch++; state.user = null; state.dirty = false; state.assignment = null; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; render();
    }
    throw Object.assign(new Error(result.error || '操作失败，请重试'), { status: response.status });
  }
  return result;
}
function badge(a) {
  return a.submittedAt ? '<span class="badge done">已批改</span>' : closed(a) ? '<span class="badge overdue">已截止 · 未交</span>' : a.savedAt ? '<span class="badge draft">草稿</span>' : '<span class="badge">待完成</span>';
}
function header() {
  const inCalendar = routePath() === '#/calendar' || !!state.calendarBack;
  const inStudents = routePath().startsWith('#/students') || (state.reviewData && new URLSearchParams(location.hash.split('?')[1]).has('historyClassId'));
  return `<header class="header"><a href="#/" class="brand"><span class="brand-mark">＋</span><span>小小算术<small>班级作业本</small></span></a>
    ${state.user ? `<nav aria-label="主导航"><a href="#/" ${!inStudents && !inCalendar ? 'aria-current="page"' : ''}>${state.user.role === 'teacher' ? '作业与成绩' : '我的作业'}</a>${state.user.role === 'teacher' ? `<a href="#/calendar" ${inCalendar ? 'aria-current="page"' : ''}>练习月历</a><a href="#/students" ${inStudents ? 'aria-current="page"' : ''}>学生名单</a>` : ''}</nav>
    <div class="user"><span>${esc(state.user.name)}<small>${state.user.role === 'teacher' ? '教师' : '学生'} · ${esc(state.user.username)}</small></span><button class="text-button" data-action="logout">退出</button></div>` : '<span class="header-note">每天练一练，一点点进步。</span>'}</header>`;
}
function loginView() {
  return `<main class="login-layout"><section class="login-story"><span class="eyebrow">把计算，练成小本领</span><h1>今天也来<br>算一算<span class="blue">。</span></h1><p>打开自己的作业本，<br>认真思考，再写下答案。</p>
    <div class="math-note" aria-hidden="true"><span>今日小练习</span><div>8 <b>＋</b> 7 <i>＝</i> <strong>?</strong></div><small>加一点思考，多一点收获</small></div></section>
    <section class="login-card"><span class="eyebrow">欢迎回到班级</span><h2>登录作业本</h2><p class="muted">教师和学生使用各自的账号登录。</p><form id="login-form"><label>账号<input name="username" autocomplete="username" required maxlength="32" placeholder="请输入账号"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"></label><p class="form-error" id="login-error" role="alert"></p><button class="button full" type="submit">登录 →</button></form><p class="login-help">学生账号由老师创建。<br>如果忘记密码，请联系老师。</p></section></main>`;
}
function pageTitle(eyebrow, title, detail, extra = '') {
  return `<div class="page-title"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="muted">${detail}</p></div>${extra}</div>`;
}
const classOptions = (selected = state.classId, classes = state.classes) => classes.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const classPicker = (classes = state.classes) => `<label class="class-picker">当前班级<select name="currentClass">${classOptions(state.classId, classes)}</select></label>`;
const targetFields = () => `<fieldset class="target-fields"><legend>发布给哪些班级</legend>${state.classes.map(c => `<label><input type="checkbox" name="classIds" value="${c.id}" ${c.id === state.classId ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</fieldset>`;
const categoryNames = {
  'add-sub-20': '20 以内加减', 'mul-div-20': '20 以内乘除', 'mixed-100': '100 以内混合运算'
};
const routePath = () => location.hash.split('?')[0];
const routeParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const recordFilters = params => Object.fromEntries(['from', 'to', 'topic'].map(key => [key, params.get(key) || '']));
function historyHref(studentId, filters = {}, classId = state.classId) {
  const params = new URLSearchParams({ classId: String(classId) });
  for (const key of ['from', 'to', 'topic']) if (filters[key]) params.set(key, filters[key]);
  return `#/students${studentId ? `/${studentId}` : ''}/history?${params}`;
}
function reviewHref(assignmentId, studentId, context = {}) {
  return `#/assignment/${assignmentId}/student/${studentId}?${new URLSearchParams({ classId: String(state.classId), ...context })}`;
}
function reportHref(assignmentId, classId = state.classId) {
  const params = new URLSearchParams({ classId: String(classId) });
  if (routeParams().has('calendar')) params.set('calendar', routeParams().get('calendar'));
  return `#/assignment/${assignmentId}?${params}`;
}
const recordBadge = a => a.submittedAt ? '<span class="badge done">已交 · 已评分</span>' : `<span class="badge draft">未交、未评分${a.savedAt ? ' · 草稿' : ''}</span>`;
function historyView(h) {
  const heading = `${classPicker()}<a class="back-link" href="#/students?classId=${state.classId}">← 返回学生名单</a>${pageTitle('学生练习记录', h.student ? `${esc(h.student.name)}的练习` : '学生练习记录', h.student ? `学号 / 账号：${esc(h.student.username)} · 按北京时间的发布日期查询。` : '先在当前班级加入学生。', '<button class="button secondary" data-action="refresh">刷新记录 ↻</button>')}`;
  if (!h.student) return `${heading}<section class="empty panel"><h2>本班还没有学生</h2><p>可返回学生名单导入或创建账号，也可切换班级。</p></section>`;
  const f = h.filters;
  return `${heading}<section class="panel history-filters"><label class="history-student">当前学生<select name="historyStudent">${state.students.map(s => `<option value="${s.id}" ${s.id === h.student.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.username)}</option>`).join('')}</select></label><form id="history-filter-form"><label>开始日期（北京时间）<input type="date" name="from" value="${esc(f.from)}"></label><label>结束日期（北京时间）<input type="date" name="to" value="${esc(f.to)}"></label><label>知识点 / 练习内容<select name="topic"><option value="">全部练习</option><optgroup label="练习题型">${Object.entries(categoryNames).map(([id, name]) => `<option value="${id}" ${f.topic === id ? 'selected' : ''}>${name}</option>`).join('')}</optgroup><optgroup label="混合知识点">${state.practiceOptions.topics.map(t => `<option value="${t.id}" ${f.topic === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup></select></label><div class="actions"><button class="button" type="submit">查询记录</button><a class="button secondary" href="${historyHref(h.student.id)}">清空筛选</a></div><p id="history-error" class="form-error" role="alert"></p></form><p class="small muted">起止日期均包含，可留空。旧作业未记录细分知识点时，可按练习题型查询。</p></section><div class="section-heading"><h2>练习记录</h2><span class="badge">共 ${h.assignments.length} 份</span></div><section class="history-list">${h.assignments.map(a => `<a class="history-item" data-history-assignment="${a.id}" href="${esc(reviewHref(a.id, h.student.id, { classId: String(a.reviewClassId), historyClassId: String(h.classId), ...f }))}"><div><h3>${esc(a.title)}</h3><p>${date(a.createdAt)} 发布（北京时间）</p><span class="small muted">${categoryNames[a.category]} · ${a.questionCount} 题${a.knowledgePointNames.length ? ` · ${esc(a.knowledgePointNames.join('、'))}` : a.category === 'mixed-100' ? ' · 未记录细分知识点' : ''}${a.reviewClassId !== h.classId ? ` · ${esc(a.reviewClassName)}历史作业` : ''}</span></div><div class="history-status">${recordBadge(a)}<small>${a.submittedAt ? `${date(a.submittedAt)} 提交` : a.savedAt ? `${date(a.savedAt)} 保存草稿` : '暂无已保存答案'}</small></div><div class="history-score">${a.score === null ? '<span>未评分</span>' : `<strong>${a.score}</strong><small>/ 100 分</small>`}</div><span class="history-open">查看原卷 →</span></a>`).join('') || '<div class="empty panel"><h3>没有符合条件的练习</h3><p>可调整日期、知识点，或清空筛选查看全部记录。</p></div>'}</section>`;
}
function reviewView(a) {
  const params = routeParams(), fromHistory = params.has('historyClassId'), done = !!a.submittedAt;
  const back = fromHistory ? historyHref(a.student.id, recordFilters(params), Number(params.get('historyClassId'))) : reportHref(a.id, a.reviewClassId);
  return `<a class="back-link" href="${esc(back)}">← 返回${fromHistory ? '学生练习记录' : '班级成绩表'}</a>${pageTitle('学生原卷', `${esc(a.student.name)}的作答`, `${esc(state.classes.find(c => c.id === a.reviewClassId)?.name)} · 学号 / 账号：${esc(a.student.username)}`, '<button class="button secondary" data-action="refresh">刷新原卷 ↻</button>')}<section class="panel review-summary"><h2>${esc(a.title)}</h2><p class="muted">${assignmentSummary(a)}<br>${date(a.createdAt)} 发布（北京时间） · ${deadline(a)}</p><div class="review-status ${done ? 'graded' : 'ungraded'}"><div><strong>${done ? '已交 · 已评分' : '未交、未评分'}</strong><p>${done ? `${date(a.submittedAt)} 提交 · 答对 ${a.results.filter(r => r.correct).length} / ${a.questionCount} 题` : a.savedAt ? `上次保存于 ${date(a.savedAt)}（北京时间）。以下为已保存的草稿，不含尚未保存的修改。` : '暂无已保存答案。该学生尚未提交，未评分。'}</p></div>${done ? `<div class="review-total"><strong>${a.score}</strong><span>/ 100 分</span></div>` : ''}</div><div class="actions review-links"><a class="text-button" href="${esc(reportHref(a.id, a.reviewClassId))}">班级成绩表 →</a><a class="text-button" href="${esc(historyHref(a.student.id, fromHistory ? recordFilters(params) : {}, a.student.classId))}">该生练习记录 →</a></div></section><section class="review-questions" aria-label="逐题作答详情">${a.expressions.map((expression, i) => `<article class="review-question ${done ? a.results[i].correct ? 'correct' : 'incorrect' : 'ungraded'}" data-review-question="${i}"><div class="section-heading"><span class="question-number">第 ${i + 1} 题</span><span class="review-verdict">${done ? a.results[i].correct ? '✓ 正确' : '✕ 错误' : '未评分'}</span></div><p class="review-expression">${esc(expression)} ＝ ?</p><dl class="review-answers"><div><dt>学生答案</dt><dd class="review-student-answer">${a.answers[i] == null ? '<span class="muted">未填</span>' : esc(a.answers[i])}</dd></div><div><dt>正确答案</dt><dd class="review-correct-answer">${a.results[i].correctAnswer}</dd></div></dl></article>`).join('')}</section>`;
}
function calendarHref(month, day, classId = state.classId) {
  const params = new URLSearchParams({ classId: String(classId) });
  if (month) params.set('month', month);
  if (day) params.set('day', day);
  return `#/calendar?${params}`;
}
function adjacentMonth(month, offset) {
  const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset);
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return null;
  return d.toISOString().slice(0, 7);
}
const dayLabel = day => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' }).format(new Date(`${day}T12:00:00+08:00`));
function calendarView(c) {
  const previous = adjacentMonth(c.month, -1), next = adjacentMonth(c.month, 1);
  const offset = (new Date(`${c.month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells = [...Array(offset).fill(null), ...c.days];
  while (cells.length % 7) cells.push(null);
  const selected = c.days.find(d => d.date === state.calendarDay);
  const rows = Array.from({ length: cells.length / 7 }, (_, week) => `<tr>${cells.slice(week * 7, week * 7 + 7).map(d => d ? `<td><a class="calendar-day ${d.date === state.calendarDay ? 'selected' : ''}" href="${calendarHref(c.month, d.date)}" aria-label="${dayLabel(d.date)}，${d.assignments.length} 份练习${d.date === state.calendarDay ? '，已选' : ''}" ${d.date === state.calendarDay ? 'aria-current="date"' : ''}><span class="calendar-day-top"><time datetime="${d.date}">${Number(d.date.slice(-2))}</time>${d.date === c.today ? '<span class="calendar-today">今</span>' : ''}</span><span class="calendar-day-count">${d.assignments.length ? `${d.assignments.length} 份` : '—'}</span><span class="calendar-titles">${d.assignments.slice(0, 2).map(a => `<span>${esc(a.title)}</span>`).join('')}${d.assignments.length > 2 ? `<span>另 ${d.assignments.length - 2} 份</span>` : ''}</span></a></td>` : '<td class="calendar-blank"></td>').join('')}</tr>`).join('');
  return `${classPicker()}${pageTitle('班级练习簿', '练习月历', '按北京时间的发布日期查看，截止时间单独标注。', '<button class="button secondary" data-action="refresh">刷新月历 ↻</button>')}
    <section class="panel calendar-panel"><div class="calendar-toolbar"><div class="calendar-month-control">${previous ? `<a class="button secondary" aria-label="上个月" href="${calendarHref(previous)}">‹ 上月</a>` : '<span class="button secondary" aria-disabled="true">‹ 上月</span>'}<label><span class="sr-only">查看月份</span><input type="month" name="calendarMonth" min="0001-01" max="9999-12" value="${c.month}" required></label>${next ? `<a class="button secondary" aria-label="下个月" href="${calendarHref(next)}">下月 ›</a>` : '<span class="button secondary" aria-disabled="true">下月 ›</span>'}</div><a class="text-button" href="${calendarHref()}">回到本月</a><span class="calendar-month-total">${Number(c.month.slice(0, 4))} 年 ${Number(c.month.slice(5))} 月 · 共 ${c.total} 份练习</span></div><p class="small muted calendar-hint">点击日期查看当天练习；日期下方是发布份数。</p>
    <table class="month-calendar" aria-label="${c.month} 练习月历"><thead><tr>${['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => `<th scope="col">${day}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>
    <section class="calendar-daily" aria-labelledby="calendar-daily-title"><div class="section-heading"><h2 id="calendar-daily-title">${esc(c.className)} · ${dayLabel(selected.date)}</h2><div class="actions"><span class="badge">${selected.assignments.length} 份练习</span><button class="text-button" data-action="calendar-grid">返回月历</button></div></div><div class="calendar-papers">${selected.assignments.map(a => `<a class="assignment-card calendar-paper" data-calendar-assignment="${a.id}" href="#/assignment/${a.id}?classId=${c.classId}&calendar=${selected.date}"><div class="card-top"><span class="eyebrow">${assignmentSummary(a)}</span><span class="arrow">↗</span></div><h3>${esc(a.title)}</h3><p class="muted">${date(a.createdAt)} 发布（北京时间）<br><span class="calendar-deadline">${deadline(a)}</span></p><div class="card-stats"><div><strong>${a.submitted}<small> / ${a.total}</small></strong><span>本班已交人数</span></div><div><strong>${a.pending}</strong><span>本班未交人数</span></div><div><strong ${a.average === null ? 'class="calendar-no-average"' : ''}>${a.average === null ? '暂无均分' : a.average}</strong><span>本班平均分</span></div></div><span class="calendar-detail-link">查看成绩明细 →</span></a>`).join('') || '<div class="empty panel"><h3>这一天没有发布练习</h3><p>可点击其他日期，或翻月查看。</p></div>'}</div></section>`;
}
function assignmentSummary(a) {
  return `${categoryNames[a.category]} · ${a.questionCount} 题${a.grade ? ` · ${a.grade} 年级 · ${a.difficulty === 'advanced' ? '提高' : '基础'} · ${esc(a.knowledgePointNames.join('、'))}` : ''}${a.timeLimitMinutes ? ` · 个人限时 ${a.timeLimitMinutes} 分钟` : ''}`;
}
function practiceFields() {
  const p = state.practiceOptions;
  if (!p) return '';
  return `<fieldset id="practice-fields" class="practice-fields" hidden disabled><legend>混合练习内容</legend><label>年级<select name="grade">${p.grades.map(g => `<option value="${g}" ${g === 3 ? 'selected' : ''}>${g} 年级</option>`).join('')}</select></label><div class="topic-options"><span>勾选本班已学知识点</span>${p.topics.map(t => `<label data-min-grade="${t.minGrade}"><input type="checkbox" name="knowledgePoints" value="${t.id}" ${['precedence', 'parentheses'].includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')}</div><label>练习难度<select name="difficulty">${p.difficulties.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label><small>年级用于筛选，按本班实际学习进度勾选。提高题增加实际运算步数，数字仍在 100 以内。</small></fieldset>`;
}
function syncPracticeFields() {
  const fields = document.querySelector('#practice-fields');
  if (!fields) return;
  fields.hidden = fields.disabled = document.querySelector('[name="category"]').value !== 'mixed-100';
  if (fields.disabled) return;
  const grade = Number(fields.querySelector('[name="grade"]').value);
  for (const label of fields.querySelectorAll('[data-min-grade]')) {
    const unavailable = Number(label.dataset.minGrade) > grade;
    label.hidden = unavailable; label.querySelector('input').disabled = unavailable;
    if (unavailable) label.querySelector('input').checked = false;
  }
  if (!fields.querySelector('input:checked:not(:disabled)')) fields.querySelector('input:not(:disabled)').checked = true;
}
function teacherHome() {
  return `${classPicker()}${pageTitle('教师工作台', '每一份练习，都看得见', `${esc(state.classes.find(c => c.id === state.classId)?.name)} · ${state.students.length} 名学生 · 已发布 ${state.assignments.length} 份作业`, '<button class="button secondary" data-action="refresh">刷新成绩 ↻</button>')}
    <div class="teacher-layout"><section><div class="section-heading"><h2>班级作业</h2><span class="muted">最新发布在前</span></div>
    ${state.assignments.length ? `<div class="assignment-list">${state.assignments.map(a => `<a class="assignment-card" href="#/assignment/${a.id}"><div class="card-top"><span class="eyebrow">${assignmentSummary(a)}</span><span class="arrow">↗</span></div><h3>${esc(a.title)}</h3><p class="muted">发布于 ${date(a.createdAt)}<br>${deadline(a)}</p><div class="card-stats"><div><strong>${a.submitted}<small> / ${a.total}</small></strong><span>已交人数</span></div><div><strong>${a.pending}</strong><span>未交人数</span></div><div><strong>${a.average ?? '—'}</strong><span>平均分</span></div></div></a>`).join('')}</div>` : '<div class="empty"><span class="empty-symbol">＋ −</span><h3>从第一份练习开始</h3><p>选择题型和题量，发布全班的计算练习。</p></div>'}</section>
    <aside class="panel publish-panel"><span class="eyebrow">一份小练习</span><h2>发布新作业</h2><p class="muted">选择题型和接收班级，所选班级完成同一套题，满分 100 分。</p><form id="publish-form"><label>作业名称<input name="title" required maxlength="60" placeholder="例如：周三计算小练习"></label><label>练习题型<select name="category">${Object.entries(categoryNames).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>${practiceFields()}${targetFields()}<label>题目数量<select name="questionCount">${[10, 20, 50].map(n => `<option value="${n}">${n} 道</option>`).join('')}</select></label><label>每人作答时间（分钟，可选）<input type="number" name="timeLimitMinutes" min="1" max="1440" step="1" placeholder="例如：20"><small>留空则不限制个人时长，点击开始后连续计时。</small></label><label>截止时间（北京时间，可选）<input type="datetime-local" name="dueAt" step="60"><small>留空则不限时；到点停止提交，仍可保存草稿。</small></label><div class="paper-spec"><span>总分<strong>100 分，按答对比例计分</strong></span><span>面向学生<strong>所选班级学生</strong></span></div><p class="form-error" id="publish-error" role="alert"></p><button type="submit" class="button full">发布作业 ＋</button></form><p class="small muted">发布后，所选班级学生可以开始作答；其他班级看不到这份新作业。</p></aside></div>`;
}
function studentsView() {
  const currentClass = state.classes.find(c => c.id === state.classId);
  return `${classPicker()}${pageTitle('班级管理', '把同学们加进来', '创建账号并选择对应班级，将账号密码告知学生。')}
    <div class="class-management panel"><form id="class-form"><label>新班级名称<input name="className" required maxlength="30" placeholder="例如：二班"></label><button class="button" type="submit">创建班级</button></form><form id="rename-class-form"><label>当前班级名称<input name="renameClassName" required maxlength="30" value="${esc(currentClass.name)}"></label><button class="button secondary" type="submit">修改名称</button></form><p id="class-error" class="form-error" role="alert"></p></div>
    ${importPanel()}<p class="small muted">调整班级会改变新作业的可见范围和按当前名单的统计，已存成绩不删除；升级前的历史作业仍可续做和回看。</p><div class="teacher-layout"><section class="panel"><div class="section-heading"><h2>${esc(currentClass.name)} · 学生名单</h2><span id="student-count" class="badge" aria-live="polite">${matchingStudents().length} / ${state.students.length} 人</span></div><div class="roster-search"><label>按姓名或学号搜索<input name="studentSearch" type="search" maxlength="64" autocomplete="off" placeholder="例如：张宁 或 00123" value="${esc(state.studentQuery)}" aria-controls="student-list"></label><button type="button" class="button secondary" data-action="clear-search">清空搜索</button></div><div id="student-list">${studentsTable(matchingStudents())}</div></section>
    <aside class="panel"><span class="eyebrow">加入班级</span><h2>创建学生账号</h2><form id="student-form"><label>学生姓名<input name="name" required maxlength="30" autocomplete="off" placeholder="例如：小雨"></label><label>所在班级<select name="classId">${classOptions()}</select></label><label>登录账号<input name="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_-]+" autocomplete="off" placeholder="例如：student03"><small>3–32 位字母、数字、下划线或短横线</small></label><label>初始密码<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="至少 8 个字符"><small>请自行记录并告知学生。</small></label><p class="form-error" id="student-error" role="alert"></p><button type="submit" class="button full">创建学生账号</button></form></aside></div>`;
}
function matchingStudents() {
  const query = state.studentQuery.trim().toLowerCase();
  return state.students.filter(s => s.name.toLowerCase().includes(query) || s.username.toLowerCase().includes(query));
}
function studentsTable(students) {
  return students.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">姓名</th><th scope="col">学号 / 登录账号</th><th scope="col">所在班级</th></tr></thead><tbody>${students.map(s => `<tr><td><a class="student-record-link" href="${historyHref(s.id)}"><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}<small>练习记录 →</small></a></td><td class="mono">${esc(s.username)}</td><td><select data-student-class="${s.id}" aria-label="${esc(s.name)}（${esc(s.username)}）的班级">${classOptions(s.classId)}</select></td></tr>`).join('')}</tbody></table></div>` : state.students.length ? '<div class="empty"><h3>没有找到匹配的学生</h3><p>可更换姓名或学号，或清空搜索查看整班名单。</p></div>' : '<div class="empty"><h3>本班还没有学生</h3><p>导入名单、创建账号，或切换班级调整已有学生的归属。</p></div>';
}
function updateStudentSearch() {
  const list = document.querySelector('#student-list');
  if (!list) return;
  const students = matchingStudents();
  list.innerHTML = studentsTable(students);
  document.querySelector('#student-count').textContent = `${students.length} / ${state.students.length} 人`;
}
function importPanel() {
  const result = state.importResult;
  return `<section class="panel roster-import"><div class="section-heading"><h2>批量导入到 ${esc(state.classes.find(c => c.id === state.classId)?.name)}</h2><a class="text-button" href="/student-roster-template.xlsx" download="学生名单样例.xlsx">下载 Excel 样例</a></div><p>上传 .xlsx 或 UTF-8 CSV，第一行是“学号、姓名”两列。Excel 只读取第一个工作表，学号请设为文本，例如 00123。每次最多 500 名学生，文件不超过 512 KB。</p><p>新学生用学号作为账号和初始密码。有问题的行会跳过；文件内重复学号的各行均跳过，已有账号的姓名、密码和班级保持原样。</p><form id="import-form"><label>名单文件<input type="file" name="rosterFile" required accept=".xlsx,.csv"></label><button class="button" type="submit">导入当前班级</button><p id="import-error" class="form-error" role="alert"></p></form>${result ? `<div id="import-result" role="status"><p><strong>已导入 ${result.created} 名，跳过 ${result.skipped} 行。</strong>可在下方当前班级名单核对。</p>${result.issues.length ? `<div class="table-wrap"><table><thead><tr><th>文件行号</th><th>学号</th><th>姓名</th><th>未导入原因</th></tr></thead><tbody>${result.issues.map(issue => `<tr><td>第 ${issue.row} 行</td><td class="mono">${esc(issue.username) || '（空）'}</td><td>${esc(issue.name) || '（空）'}</td><td class="import-reason">${esc(issue.errors.join('；'))}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>` : ''}</section>`;
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取文件，请重新选择名单'));
    reader.readAsDataURL(file);
  });
}
function reportView(a) {
  return `<a class="back-link" href="${state.calendarBack ?? '#/'}">← ${state.calendarBack ? '返回练习月历' : '返回班级作业'}</a>${classPicker(a.classes)}${pageTitle('作业成绩', esc(a.title), `${assignmentSummary(a)} · 满分 100 分 · ${date(a.createdAt)} 发布 · ${deadline(a)}`, '<button class="button secondary" data-action="refresh">刷新成绩 ↻</button>')}
    <div class="report-stats"><div><span>已交人数</span><strong>${a.submitted}<small> / ${a.total} 人</small></strong></div><div><span>未交人数</span><strong>${a.pending}<small> 人</small></strong></div><div><span>班级平均分</span><strong>${a.average ?? '—'}<small>${a.average === null ? ' 暂无提交' : ' 分'}</small></strong></div></div>
    <section class="panel"><div class="section-heading"><h2>每位同学的进度</h2><span class="muted small">平均分仅计算已提交学生</span></div><div class="table-wrap"><table><thead><tr><th scope="col">学生</th><th scope="col">账号</th><th scope="col">作业状态</th><th scope="col">提交时间</th><th scope="col">成绩 / 100</th></tr></thead><tbody>${a.students.map(s => `<tr><td><a class="student-review-link" href="${esc(reviewHref(a.id, s.id, routeParams().has('calendar') ? { calendar: routeParams().get('calendar') } : {}))}"><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}<small>查看作答 →</small></a></td><td class="mono">${esc(s.username)}</td><td>${badge({ ...s, dueAt: a.dueAt, isClosed: a.isClosed })}</td><td>${date(s.submittedAt)}</td><td class="score-cell">${s.score ?? '—'}</td></tr>`).join('') || '<tr><td colspan="5">还没有学生，请前往学生名单创建账号。</td></tr>'}</tbody></table></div></section><details class="panel questions-details"><summary>查看本次题目（${a.questionCount} 题）</summary><div class="question-preview">${a.expressions.map((expression, i) => `<span>${i + 1}.　${esc(expression)} = ?</span>`).join('')}</div></details>`;
}
function studentHome() {
  const pending = state.assignments.filter(a => !a.submittedAt && !closed(a)).length;
  const overdue = state.assignments.filter(a => !a.submittedAt && closed(a)).length;
  const detail = [pending ? `还有 ${pending} 份练习可以提交。` : '', overdue ? `${overdue} 份已截止未交，仍可查看和保存草稿。` : ''].join(' ');
  return `${pageTitle('我的作业本', `${esc(state.user.name)}，今天也加油！`, detail.trim() || (state.assignments.length ? '所有作业都完成了，可以打开看看批改结果。' : '老师发布作业后，就会出现在这里。'))}
    <section class="student-grid">${state.assignments.map(a => `<a class="assignment-card student-card" href="#/assignment/${a.id}"><div class="card-top">${badge(a)}<span class="muted small">${date(a.createdAt)}</span></div><h2>${esc(a.title)}</h2><p class="muted">${assignmentSummary(a)} · 满分 100 分<br>${deadline(a)}</p><div class="student-card-bottom">${a.submittedAt ? `<strong class="result-score">${a.score}<small> 分</small></strong><span>查看批改 →</span>` : `<span>${a.savedAt ? `上次已保存 ${a.answers.filter(v => v !== null).length}/${a.questionCount} 题` : '认真想一想，再写下答案'}</span><strong>${closed(a) ? '查看草稿' : a.savedAt ? '继续作答' : '开始作答'} →</strong>`}</div></a>`).join('') || '<div class="empty panel"><span class="empty-symbol">＋ −</span><h2>作业本还是空的</h2><p>稍后再来看看吧。</p><button class="button secondary" data-action="refresh">刷新作业</button></div>'}</section>`;
}
function workbook(a) {
  const done = !!a.submittedAt;
  if (a.timeLimitMinutes && !a.startedAt && !done) return `<a class="back-link" href="#/">← 返回我的作业</a>${pageTitle('限时练习', esc(a.title), `${assignmentSummary(a)} · ${deadline(a)}`)}<section class="panel"><h2>准备好后开始作答</h2><p>点击后开始计时，刷新或重新登录不会暂停。个人限时和全班截止以先到者为准；到点仍可保存草稿，未提交计为未交。</p><button class="button" data-action="start" ${closed(a) ? 'disabled' : ''}>${closed(a) ? '已截止，不能开始' : '开始作答'}</button><p id="start-error" class="form-error" role="alert"></p></section>`;
  const count = a.answers.filter(v => v !== null).length;
  return `<a class="back-link" href="#/">← 返回我的作业</a><div class="workbook-heading">${pageTitle(done ? '练习完成' : '专心算一算', esc(a.title), `${assignmentSummary(a)} · 每题 ${100 / a.questionCount} 分 · 答案是 0–${a.answerMax} 的整数 · ${deadline(a)}`)}${done ? `<div class="score-stamp"><strong>${a.score}</strong><span>/ 100 分</span></div>` : ''}</div>
    ${done ? `<div class="result-banner"><strong>${a.score === 100 ? '全部答对，真棒！' : `答对了 ${a.results.filter(r => r.correct).length} / ${a.questionCount} 道题，再看看需要订正的地方。`}</strong><span>${date(a.submittedAt)} 提交 · 已自动批改</span></div>` : `<div class="progress-heading"><span id="progress-label">已作答 ${count} / ${a.questionCount} 题</span><span id="save-state" class="muted">${a.savedAt ? `草稿保存于 ${date(a.savedAt)}` : '写好几题后，可以先保存草稿。'}</span></div><progress id="progress" max="${a.questionCount}" value="${count}" aria-label="作答进度"></progress>`}
    ${a.timeLimitMinutes && !done ? `<div class="timer-panel"><strong id="countdown" role="timer"></strong><span>开始于 ${date(a.startedAt)} · 最晚 ${date(a.effectiveDueAt)}（北京时间）</span></div>` : ''}<p id="deadline-state" class="deadline-message" role="status" hidden></p><form id="answer-form"><fieldset ${done ? 'disabled' : ''}><legend class="sr-only">${a.questionCount} 道计算题</legend><div class="question-grid">${a.expressions.map((expression, i) => `<div class="question ${done ? (a.results[i].correct ? 'correct' : 'incorrect') : ''}"><span class="question-number">第 ${i + 1} 题</span><div class="equation"><label for="answer-${i}"><span class="sr-only">第 ${i + 1} 题：</span>${esc(expression)} <span class="operator">＝</span></label><input id="answer-${i}" name="answer-${i}" type="number" min="0" max="${a.answerMax}" step="1" inputmode="numeric" autocomplete="off" aria-label="第 ${i + 1} 题答案" value="${esc(a.answers[i])}" ${done ? 'readonly' : ''}></div>${done ? `<div class="question-feedback">${a.results[i].correct ? '✓ 答对了' : `✕ 正确答案：${a.results[i].correctAnswer}`}</div>` : ''}</div>`).join('')}</div></fieldset>
    ${done ? '<div class="actions result-actions"><a class="button secondary" href="#/">返回我的作业</a><span class="muted">作业已提交，答案不能再修改。</span></div>' : `<div class="answer-actions"><div><strong>慢慢算，认真检查。</strong><p class="small muted">保存草稿后，下次登录可以接着写。</p></div><div class="actions"><button type="button" class="button secondary" data-action="save">保存草稿</button><button type="submit" class="button" data-submit>提交作业 →</button></div></div><p id="answer-error" class="form-error" role="alert"></p>`}</form>`;
}
function render() {
  let view;
  if (!state.user) view = loginView();
  else if (state.loading) view = '<p class="loading">正在打开作业本…</p>';
  else if (state.loadError) view = `<section class="empty panel"><h2>作业本暂时没有打开</h2><p>${esc(state.loadError)}</p><button class="button" data-action="refresh">重新加载</button><p><a href="#/">返回作业列表</a></p></section>`;
  else if (state.reviewData) view = reviewView(state.reviewData);
  else if (state.historyData) view = historyView(state.historyData);
  else if (routePath() === '#/students' && state.user.role === 'teacher') view = studentsView();
  else if (routePath() === '#/calendar' && state.user.role === 'teacher') view = calendarView(state.calendarData);
  else if (state.assignment) view = state.user.role === 'teacher' ? reportView(state.assignment) : workbook(state.assignment);
  else view = state.user.role === 'teacher' ? teacherHome() : studentHome();
  root.innerHTML = `${header()}${state.user ? `<main class="main">${view}</main>` : view}<footer>小小算术 <span>·</span> 每天进步一点点</footer>`;
  syncDeadlineUI();
  syncPracticeFields();
}
async function load() {
  if (!state.user) { render(); return; }
  const epoch = ++loadEpoch;
  state.loading = true; state.loadError = ''; state.assignment = null; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; render();
  try {
    const path = routePath(), params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (state.user.role === 'teacher') {
      const [classes, practiceOptions] = await Promise.all([api('/classes'), api('/practice-options')]);
      if (epoch !== loadEpoch) return;
      state.classes = classes; state.practiceOptions = practiceOptions;
      if (params.has('classId')) {
        const id = Number(params.get('classId'));
        if (!classes.some(c => c.id === id)) throw new Error('请选择有效班级');
        state.classId = id;
      }
      if (!classes.some(c => c.id === state.classId)) state.classId = classes[0].id;
    }
    const match = path.match(/^#\/assignment\/([1-9]\d*)$/);
    const reviewMatch = path.match(/^#\/assignment\/([1-9]\d*)\/student\/([1-9]\d*)$/);
    const historyMatch = path.match(/^#\/students(?:\/([1-9]\d*))?\/history$/);
    if (historyMatch && state.user.role === 'teacher') {
      const students = await api(`/students?classId=${state.classId}`);
      if (epoch !== loadEpoch) return;
      state.students = students;
      const studentId = historyMatch[1] || students[0]?.id;
      const filters = recordFilters(params);
      const data = studentId ? await api(`/students/${studentId}/history?${new URLSearchParams({ classId: String(state.classId), ...filters })}`) : { classId: state.classId, student: null, filters, assignments: [] };
      if (epoch !== loadEpoch) return;
      state.historyData = data;
      if (!historyMatch[1] && studentId) history.replaceState(null, '', historyHref(studentId, data.filters));
    } else if (reviewMatch && state.user.role === 'teacher') {
      if (params.has('historyClassId') && !state.classes.some(c => c.id === Number(params.get('historyClassId')))) throw new Error('请选择有效班级');
      const data = await api(`/assignments/${reviewMatch[1]}/students/${reviewMatch[2]}?classId=${state.classId}`);
      if (epoch !== loadEpoch) return;
      state.reviewData = data;
      if (params.has('calendar')) state.calendarBack = reportHref(data.id);
    } else if (path === '#/calendar' && state.user.role === 'teacher') {
      const query = new URLSearchParams({ classId: String(state.classId) });
      if (params.has('month')) query.set('month', params.get('month'));
      const data = await api(`/calendar?${query}`);
      if (epoch !== loadEpoch) return;
      const day = params.get('day');
      if (day && !data.days.some(d => d.date === day)) throw new Error('所选日期不在当前月份，请重新选择');
      state.calendarData = data;
      state.calendarDay = day || (data.today.startsWith(data.month) ? data.today : data.days.find(d => d.assignments.length)?.date || data.days[0].date);
    } else if (match) {
      let a = await api(`/assignments/${match[1]}`);
      if (epoch !== loadEpoch) return;
      if (state.user.role === 'teacher') {
        if (params.has('classId') && !a.classIds.includes(state.classId)) throw new Error('这份作业未发布给该班级');
        if (!a.classIds.includes(state.classId)) state.classId = a.classIds[0];
        a = await api(`/assignments/${match[1]}/report?classId=${state.classId}`);
      }
      if (epoch !== loadEpoch) return; state.assignment = a;
      const from = params.get('calendar');
      if (state.user.role === 'teacher' && /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') && Number.isFinite(Date.parse(`${from}T00:00:00Z`)) && new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) === from) state.calendarBack = calendarHref(from.slice(0, 7), from);
    } else if (state.user.role === 'teacher') {
      const [assignments, students] = await Promise.all([api(`/assignments?classId=${state.classId}`), api(`/students?classId=${state.classId}`)]);
      if (epoch !== loadEpoch) return; state.assignments = assignments; state.students = students;
    } else {
      const assignments = await api('/assignments');
      if (epoch !== loadEpoch) return; state.assignments = assignments;
    }
    state.route = location.hash;
  } catch (e) { if (epoch === loadEpoch) { state.loadError = e.message; toast(e.message, true); } }
  finally { if (epoch === loadEpoch) { state.loading = false; render(); } }
}
function errorAt(id, message) {
  const el = document.getElementById(id); if (el) el.textContent = message; else toast(message, true);
}
async function formAction(form, errorId, action) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
  errorAt(errorId, '');
  try { await action(Object.fromEntries(new FormData(form))); }
  catch (e) { errorAt(errorId, e.message); }
  finally { state.busy = false; buttons.forEach(b => { b.disabled = false; }); }
}
root.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'history-filter-form' && !state.busy) {
    const filters = Object.fromEntries(new FormData(form));
    if (filters.from && filters.to && filters.from > filters.to) { errorAt('history-error', '开始日期不能晚于结束日期'); return; }
    const href = historyHref(state.historyData.student.id, filters);
    if (location.hash === href) await load(); else location.hash = href;
  }
  if (form.id === 'login-form') await formAction(form, 'login-error', async data => {
    state.user = await api('/login', 'POST', data); state.dirty = false; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.assignment = null;
    history.replaceState(null, '', '#/'); await load();
  });
  if (form.id === 'publish-form') await formAction(form, 'publish-error', async data => {
    const options = data.category === 'mixed-100' ? { grade: Number(data.grade), knowledgePoints: new FormData(form).getAll('knowledgePoints'), difficulty: data.difficulty } : {};
    const classIds = new FormData(form).getAll('classIds').map(Number);
    const a = await api('/assignments', 'POST', { ...data, ...options, classIds, questionCount: Number(data.questionCount), timeLimitMinutes: data.timeLimitMinutes ? Number(data.timeLimitMinutes) : null, dueAt: data.dueAt ? `${data.dueAt}+08:00` : null }); toast('作业已发布，所选班级学生可以开始作答。');
    location.hash = `#/assignment/${a.id}`;
  });
  if (form.id === 'student-form') await formAction(form, 'student-error', async data => {
    const student = await api('/students', 'POST', { ...data, classId: Number(data.classId) }); await load(); toast(`已创建 ${student.name} 的账号：${student.username}`);
  });
  if (form.id === 'import-form') await formAction(form, 'import-error', async () => {
    const file = form.querySelector('[name="rosterFile"]').files[0];
    if (!file) throw new Error('请先选择名单文件');
    const format = file.name.split('.').at(-1).toLowerCase();
    if (!['xlsx', 'csv'].includes(format)) throw new Error('请上传 .xlsx 或 UTF-8 .csv 文件');
    if (!file.size || file.size > 512 * 1024) throw new Error('名单文件不能为空，且不能超过 512 KB');
    const classId = state.classId;
    state.importResult = await api('/students/import', 'POST', { classId, format, content: await fileBase64(file) });
    state.studentQuery = '';
    await load();
  });
  if (form.id === 'class-form') await formAction(form, 'class-error', async data => {
    const classroom = await api('/classes', 'POST', { name: data.className }); state.classId = classroom.id; state.importResult = null; await load(); toast('班级已创建');
  });
  if (form.id === 'rename-class-form') await formAction(form, 'class-error', async data => {
    await api(`/classes/${state.classId}`, 'PUT', { name: data.renameClassName }); await load(); toast('班级名称已更新');
  });
  if (form.id === 'answer-form' && !state.busy) {
    if (closed(state.assignment)) { syncDeadlineUI(); errorAt('answer-error', closedMessage); }
    else dialog.showModal();
  }
});
async function saveAnswers(submit = false) {
  if (state.busy || !state.assignment || state.assignment.submittedAt) return;
  if (submit && closed(state.assignment)) { syncDeadlineUI(); errorAt('answer-error', closedMessage); return; }
  const form = document.querySelector('#answer-form');
  if (!form.reportValidity()) return;
  const answers = Array.from({ length: state.assignment.questionCount }, (_, i) => {
    const value = form.elements[`answer-${i}`].value; return value === '' ? null : Number(value);
  });
  if (submit && answers.includes(null)) { errorAt('answer-error', `还有题目未作答，请完成全部 ${state.assignment.questionCount} 题再提交。`); document.querySelector(`#answer-${answers.indexOf(null)}`).focus(); return; }
  state.busy = true;
  const fieldset = form.querySelector('fieldset'); fieldset.disabled = true;
  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  errorAt('answer-error', '');
  try {
    state.assignment = await api(`/assignments/${state.assignment.id}/${submit ? 'submit' : 'draft'}`, submit ? 'POST' : 'PUT', { answers });
    state.dirty = false; render(); toast(submit ? '作业已提交，批改结果出来啦！' : '草稿已保存，下次可以接着写。');
  } catch (e) {
    if (submit && e.status === 409) state.assignment.isClosed = true;
    errorAt('answer-error', e.message);
  }
  finally { state.busy = false; fieldset.disabled = false; form.querySelectorAll('button').forEach(b => { b.disabled = false; }); syncDeadlineUI(); }
}
root.addEventListener('input', event => {
  if (event.target.name === 'studentSearch') { state.studentQuery = event.target.value; updateStudentSearch(); }
  if (event.target.name === 'category' || event.target.name === 'grade') syncPracticeFields();
  if (event.target.closest('#answer-form')) {
    state.dirty = true;
    const inputs = [...document.querySelectorAll('.equation input')];
    const count = inputs.filter(input => input.value !== '').length;
    document.querySelector('#progress').value = count;
    document.querySelector('#progress-label').textContent = `已作答 ${count} / ${state.assignment.questionCount} 题`;
    document.querySelector('#save-state').textContent = '有未保存的修改';
  }
});
root.addEventListener('change', async event => {
  if (event.target.name === 'category' || event.target.name === 'grade') syncPracticeFields();
  if (state.busy) return;
  if (event.target.name === 'currentClass') {
    state.classId = Number(event.target.value); state.importResult = null;
    if (/^#\/students(?:\/\d+)?\/history$/.test(routePath())) {
      history.replaceState(null, '', historyHref(null, recordFilters(routeParams())));
    } else if (routePath() === '#/calendar' || routePath().startsWith('#/assignment/') || routeParams().has('classId')) {
      const params = new URLSearchParams(location.hash.split('?')[1] ?? ''); params.set('classId', String(state.classId));
      if (routePath() === '#/calendar' && state.calendarData) { params.set('month', state.calendarData.month); params.set('day', state.calendarDay); }
      history.replaceState(null, '', `${routePath()}?${params}`);
    }
    await load();
  }
  if (event.target.name === 'historyStudent') location.hash = historyHref(Number(event.target.value), state.historyData.filters);
  if (event.target.name === 'calendarMonth' && event.target.value) { history.pushState(null, '', calendarHref(event.target.value)); await load(); }
  if (event.target.dataset.studentClass) {
    state.busy = true;
    try { await api(`/students/${event.target.dataset.studentClass}`, 'PUT', { classId: Number(event.target.value) }); await load(); toast('学生班级已更新'); }
    catch (e) { toast(e.message, true); await load(); }
    finally { state.busy = false; }
  }
});
root.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (state.busy && (event.target.closest('a') || action)) { event.preventDefault(); return; }
  if (action === 'save') await saveAnswers();
  if (action === 'calendar-grid') document.querySelector('.calendar-panel')?.scrollIntoView?.({ block: 'start' });
  if (event.target.closest('.calendar-day')?.getAttribute('href') === location.hash) {
    event.preventDefault(); document.querySelector('.calendar-daily')?.scrollIntoView?.({ block: 'start' });
  }
  if (action === 'clear-search') {
    state.studentQuery = ''; document.querySelector('[name="studentSearch"]').value = ''; updateStudentSearch();
  }
  if (action === 'start') {
    state.busy = true;
    try { state.assignment = await api(`/assignments/${state.assignment.id}/start`, 'POST', {}); render(); }
    catch (e) { errorAt('start-error', e.message); }
    finally { state.busy = false; }
  }
  if (action === 'refresh') await load();
  if (action === 'logout') {
    if (state.dirty && !confirm('还有未保存的答案。确定退出并放弃这些修改吗？')) return;
    state.busy = true;
    try { await api('/logout', 'POST', {}); loadEpoch++; state.user = null; state.assignment = null; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.dirty = false; history.replaceState(null, '', '#/'); render(); }
    catch (e) { toast(e.message, true); }
    finally { state.busy = false; }
  }
});
document.querySelector('#cancel-submit').addEventListener('click', () => dialog.close());
document.querySelector('#confirm-submit').addEventListener('click', async () => { dialog.close(); await saveAnswers(true); });
let reverting = false;
window.addEventListener('hashchange', async () => {
  if (reverting) { reverting = false; return; }
  if (state.busy || (state.dirty && !confirm('还有未保存的答案。确定离开并放弃这些修改吗？'))) {
    reverting = true; location.hash = state.route || '#/'; return;
  }
  state.dirty = false; await load();
  if (routePath() === '#/calendar' && new URLSearchParams(location.hash.split('?')[1] ?? '').has('day')) document.querySelector('.calendar-daily')?.scrollIntoView?.({ block: 'start' });
  else window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
try { state.user = await api('/me'); } catch (e) { if (!e.message.includes('请先登录')) toast(e.message, true); }
await load();

setInterval(syncDeadlineUI, 1000);
window.addEventListener('focus', syncDeadlineUI);
