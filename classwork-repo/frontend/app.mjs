const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#submit-dialog');
const state = { user: null, assignments: [], students: [], classes: [], classId: null, importResult: null, studentQuery: '', calendarData: null, calendarDay: '', calendarBack: null, historyData: null, reviewData: null, mistakes: null, correction: null, mistakeHistories: {}, practiceOptions: null, assignment: null, dirty: false, busy: false, route: '', loading: false, loadError: '' };
let loadEpoch = 0;
let toastTimer;
let autosaveTimer, draftFlight = null, draftConflict = null, draftRetryDelay = 1000;
function resetDraftSaving() { clearTimeout(autosaveTimer); draftFlight = null; draftConflict = null; draftRetryDelay = 1000; }
state.analyticsData = null; state.analyticsAll = false; state.passwordStudent = null;
state.preview = null; state.publishDraft = null; state.previewFingerprint = ''; state.previewStale = false;
function resetPublish() { state.preview = null; state.publishDraft = null; state.previewFingerprint = ''; state.previewStale = false; }
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
const assignmentNow = a => a.serverNow && a.receivedAt !== undefined ? Date.parse(a.serverNow) + Math.max(0, performance.now() - a.receivedAt) : Date.now();
const dueTime = a => a.effectiveDueAt || a.dueAt ? Date.parse(a.effectiveDueAt || a.dueAt) : Infinity;
const closed = (a, now = assignmentNow(a)) => a.isClosed || now >= dueTime(a);
const deadline = a => a.dueAt ? `截止：${date(a.dueAt)}（北京时间）` : '不限截止时间';
const closedMessage = '已截止，不能提交。仍可保存草稿，老师处计为未交。';
let nextOverviewExpiry = Infinity;
function syncDeadlineUI() {
  const a = state.assignment;
  const panel = document.querySelector('#student-home, #report-progress');
  if (panel && assignmentNow(a ?? state.assignments[0] ?? {}) >= nextOverviewExpiry) updateOverviewPanel(panel);
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
  const user = state.user;
  const headers = data === undefined ? {} : { 'Content-Type': 'application/json' };
  if (user) headers['X-Classwork-User'] = String(user.id);
  let response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers,
      body: data === undefined ? undefined : JSON.stringify(data) });
  } catch { throw new Error('连接失败，请检查网络后重试。未保存的答案仍保留在本页。'); }
  const result = await response.json();
  for (const a of Array.isArray(result) ? result : [result]) if (a.serverNow) a.receivedAt = performance.now();
  if (!response.ok) {
    if (response.status === 401 && user && state.user === user) {
      rememberEdits();
      activeRecovery = null;
      if (dialog.open) dialog.close();
      loadEpoch++; resetDraftSaving(); resetPublish(); state.user = null; state.dirty = false; state.assignment = null; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.passwordStudent = null; state.analyticsData = null; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.mistakes = null; state.correction = null; state.mistakeHistories = {}; render();
      toast('登录已失效，请用原账号登录后继续。');
    }
    throw Object.assign(new Error(result.error || '操作失败，请重试'), { status: response.status, code: result.code, draftRevision: result.draftRevision, answers: result.answers });
  }
  return result;
}
function badge(a, now) {
  if (a.submittedAt) return '<span class="badge done">已批改</span>';
  if (closed(a, now)) {
    const reason = a.deadlineSource === 'personal' ? '个人限时已到' : '已截止';
    return `<span class="badge overdue">${reason} · 未交，不能提交</span>`;
  }
  return a.savedAt ? '<span class="badge draft">草稿</span>' : a.startedAt ? '<span class="badge">作答中</span>' : '<span class="badge">待完成</span>';
}
function header() {
  const inAnalytics = routePath() === '#/analytics' || (state.reviewData && routeParams().has('analytics'));
  const inCalendar = routePath() === '#/calendar' || !!state.calendarBack;
  const inStudents = routePath().startsWith('#/students') || (state.reviewData && new URLSearchParams(location.hash.split('?')[1]).has('historyClassId'));
  const inMistakes = routePath().startsWith('#/mistakes');
  const inPassword = routePath() === '#/password';
  return `<header class="header"><a href="#/" class="brand"><span class="brand-mark">＋</span><span>小小算术<small>班级作业本</small></span></a>
    ${state.user ? `<nav aria-label="主导航"><a href="#/" ${!inStudents && !inCalendar && !inMistakes && !inAnalytics && !inPassword ? 'aria-current="page"' : ''}>${state.user.role === 'teacher' ? '作业与成绩' : '我的作业'}</a>${state.user.role === 'teacher' ? `<a href="#/calendar" ${inCalendar ? 'aria-current="page"' : ''}>练习月历</a><a href="#/analytics" ${inAnalytics ? 'aria-current="page"' : ''}>班级学情</a><a href="#/students" ${inStudents ? 'aria-current="page"' : ''}>学生名单</a>` : `<a href="#/mistakes" ${inMistakes ? 'aria-current="page"' : ''}>我的错题本</a><a href="#/password" ${inPassword ? 'aria-current="page"' : ''}>修改密码</a>`}</nav>
    <div class="user"><span>${esc(state.user.name)}<small>${state.user.role === 'teacher' ? '教师' : '学生'} · ${esc(state.user.username)}</small></span><button class="text-button" data-action="logout">退出</button></div>` : '<span class="header-note">每天练一练，一点点进步。</span>'}</header>`;
}
function passwordView() {
  const pupil = state.passwordStudent, reset = !!pupil, target = pupil ?? state.user;
  return `<a class="back-link" href="${reset ? `#/students?classId=${state.classId}` : '#/'}">← 返回${reset ? '本班名单' : '我的作业'}</a>${pageTitle('账号管理', reset ? '重设学生密码' : '修改我的密码', reset ? '请按学号核对学生，再填写新密码。' : '填写原密码，将初始密码换成自己记得住的新密码。')}<section class="panel password-panel"><div class="password-target"><strong>${esc(target.name)}</strong><p>学号 / 账号：<b>${esc(target.username)}</b>${reset ? `<br>班级：${esc(state.classes.find(c => c.id === state.classId)?.name)}` : ''}</p></div><form id="password-form">${reset ? '' : '<label>原密码<input type="password" name="currentPassword" autocomplete="current-password" required maxlength="128"></label>'}<label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="8" maxlength="128" required><small>8–128 个字符，请自行记录。</small></label><label>再输入一次新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" maxlength="128" required></label><p class="small muted">${reset ? '只重设上述账号的密码。该学生需要用新密码重新登录，请把新密码告知本人。' : '修改成功后本窗口可继续使用，其他窗口需要用新密码重新登录。'}</p><p id="password-error" class="form-error" role="alert"></p><p id="password-success" class="password-success" role="status"></p><button class="button" type="submit">${reset ? '确认重设此人密码' : '确认修改密码'}</button></form></section>`;
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
  'add-sub-20': '20 以内加减', 'mul-div-20': '20 以内乘除', 'mixed-100': '100 以内混合运算', composite: '综合练习'
};
const practiceCategories = ['add-sub-20', 'mul-div-20', 'mixed-100'];
const difficultyHint = (category, difficulty) => category === 'add-sub-20' ? (difficulty === 'advanced' ? '进位加法、退位减法。' : '不进位加法、不退位减法。') : category === 'mul-div-20' ? (difficulty === 'advanced' ? '优先非平凡口诀与对应除法，排除乘 0/1、除 1 和同数相除。' : '练熟 0、1、2、5、10 等口诀与对应除法。') : (difficulty === 'advanced' ? '混合题实际运算 3 步；专项按提高难度出题。' : '混合题实际运算 2 步；专项按基础难度出题。');
function publishFormState() {
  const form = document.querySelector('#publish-form');
  const value = name => form.elements[name].value;
  const checked = name => [...form.querySelectorAll(`[name="${name}"]:checked`)].map(n => n.value);
  return { title: value('title'), category: value('category'), questionCount: Number(value('questionCount')), difficulty: value('difficulty'),
    selectedCategories: checked('selectedCategories'), classIds: checked('classIds').map(Number), grade: Number(value('grade')),
    knowledgePoints: checked('knowledgePoints'), timeLimitMinutes: value('timeLimitMinutes'), dueAt: value('dueAt') };
}
function draftFromPreview(settings) {
  return { title: settings.title, category: settings.category, questionCount: settings.questionCount, difficulty: settings.difficulty,
    selectedCategories: settings.category === 'composite' ? settings.selectedCategories : practiceCategories, classIds: settings.classIds, grade: settings.grade || 3,
    knowledgePoints: settings.knowledgePoints.length ? settings.knowledgePoints : ['precedence', 'parentheses'], timeLimitMinutes: settings.timeLimitMinutes === null ? '' : String(settings.timeLimitMinutes),
    dueAt: settings.dueAt ? new Date(Date.parse(settings.dueAt) + 8 * 60 * 60_000).toISOString().slice(0, 16) : '' };
}
function restorePublishForm() {
  const form = document.querySelector('#publish-form'), draft = state.publishDraft;
  if (!form || !draft) return;
  for (const [name, value] of Object.entries(draft)) {
    if (Array.isArray(value)) { for (const field of form.querySelectorAll(`[name="${name}"]`)) field.checked = value.map(String).includes(field.value); }
    else if (form.elements[name]) form.elements[name].value = String(value);
  }
}
function updatePreviewControls() {
  const button = document.querySelector('[data-action="confirm-preview"]'), warning = document.querySelector('#preview-stale');
  if (button) button.disabled = state.previewStale;
  if (warning) warning.hidden = !state.previewStale;
}
function publishChanged() {
  state.publishDraft = publishFormState();
  state.previewStale = !!state.preview && JSON.stringify(state.publishDraft) !== state.previewFingerprint;
  updatePreviewControls();
}
async function requestPreview(form) {
  await formAction(form, 'publish-error', async () => {
    const draft = publishFormState(), fingerprint = JSON.stringify(draft); state.publishDraft = draft;
    const preview = await api('/assignment-previews', 'POST', { ...draft, timeLimitMinutes: draft.timeLimitMinutes ? Number(draft.timeLimitMinutes) : null, dueAt: draft.dueAt ? `${draft.dueAt}+08:00` : null });
    state.preview = preview; state.previewFingerprint = fingerprint; state.previewStale = JSON.stringify(state.publishDraft) !== fingerprint;
    render(); document.querySelector('#assignment-preview')?.scrollIntoView?.({ block: 'start' });
  });
}
async function confirmPreview() {
  if (state.busy || !state.preview || state.previewStale) return;
  if (JSON.stringify(publishFormState()) !== state.previewFingerprint) { state.previewStale = true; updatePreviewControls(); return; }
  const button = document.querySelector('[data-action="confirm-preview"]');
  const controls = [...document.querySelectorAll('#publish-form input,#publish-form select,#publish-form button')].map(field => [field, field.disabled]);
  state.busy = true; button.disabled = true; controls.forEach(([field]) => { field.disabled = true; }); errorAt('preview-error', '');
  try {
    const a = await api(`/assignment-previews/${encodeURIComponent(state.preview.previewId)}/publish`, 'POST', {});
    resetPublish(); toast('作业已发布，题目和顺序与最后预览一致。'); location.hash = `#/assignment/${a.id}`;
  } catch (e) { if ([400, 409].includes(e.status)) state.previewStale = true; errorAt('preview-error', e.message); }
  finally { state.busy = false; controls.forEach(([field, disabled]) => { field.disabled = disabled; }); updatePreviewControls(); }
}
function previewView(p) {
  const a = p.settings;
  return `<section class="panel assignment-preview" id="assignment-preview" aria-labelledby="preview-title" data-preview-id="${esc(p.previewId)}"><div class="section-heading"><div><span class="eyebrow">仅教师可见 · 尚未发布</span><h2 id="preview-title">${esc(a.title)} · 整卷预览</h2></div><button class="text-button" data-action="edit-preview">修改设置 ↓</button></div><p class="muted">${assignmentSummary({ ...a, components: p.components, knowledgePointNames: a.knowledgePoints.map(id => state.practiceOptions.topics.find(t => t.id === id)?.name ?? id) })}<br>发布给：${a.classIds.map(id => esc(state.classes.find(c => c.id === id)?.name ?? '班级已变更')).join('、')} · ${deadline(a)}</p><div class="preview-counts">${p.components.map(c => `<span class="badge" data-preview-category="${c.category}">${categoryNames[c.category]} ${c.count} 题</span>`).join('')}</div><p class="preview-difficulty">${p.usesCurrentRules ? p.components.map(c => `${categoryNames[c.category]}：${difficultyHint(c.category, a.difficulty)}`).join(' ') : '沿用历史预览原题；新生成卷按当前难度规则出题。'}</p><p id="preview-stale" class="preview-stale" ${state.previewStale ? '' : 'hidden'}>设置已修改，请更新预览后再确认发布。</p><ol class="preview-questions">${p.expressions.map((expression, i) => `<li><span class="preview-question-number">${i + 1}.</span><span>${esc(expression)} ＝ ?</span><small>${categoryNames[p.questionCategories[i]]}</small></li>`).join('')}</ol><div class="actions preview-actions"><button class="button secondary" data-action="replace-preview">换一套</button><button class="button" data-action="confirm-preview" ${state.previewStale ? 'disabled' : ''}>确认发布 →</button></div><p id="preview-error" class="form-error" role="alert"></p></section>`;
}
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
function analyticsHref({ filters = {}, classId = state.classId, selection = null, all = state.analyticsAll } = {}) {
  const params = new URLSearchParams({ classId: String(classId) });
  for (const key of ['from', 'to']) if (Object.hasOwn(filters, key)) params.set(key, filters[key]);
  if (selection) { params.set('assignmentId', selection.assignmentId); params.set('questionNumber', selection.questionNumber); }
  if (all) params.set('all', '1');
  return `#/analytics?${params}`;
}
const analyticsCounts = q => `<dl class="analytics-counts"><div><dt>答对</dt><dd>${q.correctCount} 人</dd></div><div><dt>答错</dt><dd>${q.wrongCount} 人</dd></div><div><dt>漏答</dt><dd>${q.missingCount} 人</dd></div><div><dt>未交</dt><dd>${q.unsubmittedCount} 人</dd></div></dl>`;
const analyticsQuestions = () => state.analyticsData.questions.filter(q => state.analyticsAll || q.errorCount > 0);
function analyticsQuestionList() {
  const data = state.analyticsData, questions = analyticsQuestions();
  if (!questions.length) return `<div class="empty"><h3>${data.summary.assignmentCount ? '当前范围暂无常错题' : '当前范围没有练习'}</h3><p>${data.summary.submitted ? '已交原答案中没有答错或漏答，可勾选包含全部题目查看。' : '暂无学生提交，可勾选包含全部题目查看未交人数。'}</p></div>`;
  return `<div class="analytics-questions">${questions.map(q => `<a class="analytics-question" href="${esc(analyticsHref({ filters: data.filters, selection: q }))}" data-analytics-question="${q.assignmentId}:${q.questionNumber}"><div class="section-heading"><span class="question-number">第 ${q.questionNumber} 题</span><span class="analytics-error">${q.errorCount ? `${q.errorCount} 人需讲评` : '暂无错漏'}</span></div><p class="analytics-expression">${esc(q.expression)} ＝ ?</p><p class="analytics-source">${esc(q.title)}<br>${date(q.createdAt)} 发布</p>${analyticsCounts(q)}<span class="analytics-open">查看逐人原答案 →</span></a>`).join('')}</div>`;
}
function analyticsDetail(data) {
  const q = data.selectedQuestion;
  if (!q) return '';
  const statuses = { correct: '答对', wrong: '答错', missing: '漏答', unsubmitted: '未交、未评分' };
  return `<section id="analytics-detail" class="panel analytics-detail" aria-label="逐人原答案"><div class="section-heading"><h2>第 ${q.questionNumber} 题 · 逐人原答案</h2><button class="text-button" data-action="analytics-list">返回题目列表 ↓</button></div><p class="analytics-source">${esc(q.title)} · ${date(q.createdAt)} 发布（北京时间）</p><p class="analytics-expression">${esc(q.expression)} ＝ ${q.correctAnswer}</p>${analyticsCounts(q)}<p class="muted">已交显示首次交卷答案；未交只展示最后保存的草稿，不评对错。</p><div class="table-wrap"><table><thead><tr><th>学生 / 学号</th><th>状态</th><th>当时填写的答案</th><th>时间（北京时间）</th></tr></thead><tbody>${q.students.map(s => `<tr data-analytics-student="${s.id}"><td><a class="student-name" href="${esc(reviewHref(q.assignmentId, s.id, { analytics: '1', ...data.filters, questionNumber: String(q.questionNumber), all: state.analyticsAll ? '1' : '0' }))}">${esc(s.name)}</a><small class="analytics-account">${esc(s.username)}</small></td><td><span class="analytics-status ${s.status}">${statuses[s.status]}</span></td><td>${s.status === 'unsubmitted' ? s.savedAt ? `<span class="small muted">草稿：</span>${s.answer == null || s.answer === '' ? '未填' : esc(s.answer)}` : '未保存答案' : s.status === 'missing' ? '未填' : esc(s.answer)}</td><td>${date(s.submittedAt || s.savedAt)}${!s.submittedAt && s.savedAt ? '<small class="analytics-account">草稿保存</small>' : ''}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function analyticsView(data) {
  const s = data.summary, range = data.filters;
  return `${pageTitle('备课与讲评', '班级学情', '按北京时间的发布日期查看练习，统计首次交卷情况。', '<button class="button secondary" data-action="refresh">刷新学情 ↻</button>')}<section class="panel analytics-filters">${classPicker()}<form id="analytics-filter-form"><label>发布日期 · 开始<input type="date" name="from" value="${esc(range.from)}"></label><label>发布日期 · 结束<input type="date" name="to" value="${esc(range.to)}"></label><div class="actions"><button class="button" type="submit">查询学情</button><a class="text-button" href="${esc(analyticsHref({ filters: { from: '', to: '' } }))}">清空日期</a></div><p id="analytics-error" class="form-error" role="alert"></p></form></section><div class="analytics-heading"><h2>${esc(data.className)} · 练习概况</h2><span class="muted">${range.from || '最早'} 至 ${range.to || '最新'} · 含起止日</span></div><section class="analytics-summary" aria-label="班级练习概况">${[['练习份数', s.assignmentCount, '份练习'], ['已交份数', s.submitted, '份学生作业'], ['未交份数', s.pending, '份学生作业'], ['整体均分', s.average ?? '暂无均分', s.average === null ? '等待首次提交' : '/ 100 分']].map(([label, value, unit]) => `<div><span>${label}</span><strong>${value}</strong><small>${unit}</small></div>`).join('')}</section><p class="small muted analytics-note">同一学生交两份作业计为两份；整体均分按所有已交原分数逐份计算，草稿不计分。订正不改变这里的统计。</p>${data.assignments.length ? `<details class="panel analytics-assignments"><summary>核对这 ${data.assignments.length} 份练习</summary><div class="table-wrap"><table><thead><tr><th>来源作业</th><th>发布日期（北京时间）</th><th>已交 / 未交</th><th>本班均分</th></tr></thead><tbody>${data.assignments.map(a => `<tr><td><a href="${esc(reportHref(a.assignmentId))}">${esc(a.title)}</a></td><td>${date(a.createdAt)}</td><td>${a.submitted} / ${a.pending}</td><td>${a.average ?? '暂无均分'}</td></tr>`).join('')}</tbody></table></div></details>` : ''}${analyticsDetail(data)}<section id="analytics-list" class="panel analytics-list"><div class="section-heading"><div><h2>常错题 <span id="analytics-question-count" class="badge">${analyticsQuestions().length} 题</span></h2><p class="small muted">按答错与漏答总人数从多到少排列；人数相同时优先错漏率高的题。</p></div><label class="analytics-all"><input name="analyticsAll" type="checkbox" ${state.analyticsAll ? 'checked' : ''}>包含全部题目</label></div><p class="small muted">漏答：已交但该题为空。未交：含草稿与未开始，不算答错或漏答。</p><div id="analytics-question-list">${analyticsQuestionList()}</div></section>`;
}
function reviewView(a) {
  const params = routeParams(), fromHistory = params.has('historyClassId'), done = !!a.submittedAt;
  const fromAnalytics = params.has('analytics');
  const back = fromAnalytics ? analyticsHref({ filters: recordFilters(params), classId: a.reviewClassId, selection: { assignmentId: a.id, questionNumber: params.get('questionNumber') }, all: params.get('all') === '1' }) : fromHistory ? historyHref(a.student.id, recordFilters(params), Number(params.get('historyClassId'))) : reportHref(a.id, a.reviewClassId);
  return `<a class="back-link" href="${esc(back)}">← 返回${fromAnalytics ? '班级学情' : fromHistory ? '学生练习记录' : '班级成绩表'}</a>${pageTitle('学生原卷', `${esc(a.student.name)}的作答`, `${esc(state.classes.find(c => c.id === a.reviewClassId)?.name)} · 学号 / 账号：${esc(a.student.username)}`, '<button class="button secondary" data-action="refresh">刷新原卷 ↻</button>')}<section class="panel review-summary"><h2>${esc(a.title)}</h2><p class="muted">${assignmentSummary(a)}<br>${date(a.createdAt)} 发布（北京时间） · ${deadline(a)}</p><div class="review-status ${done ? 'graded' : 'ungraded'}"><div><strong>${done ? '已交 · 已评分' : '未交、未评分'}</strong><p>${done ? `${date(a.submittedAt)} 提交 · 答对 ${a.results.filter(r => r.correct).length} / ${a.questionCount} 题` : a.savedAt ? `上次保存于 ${date(a.savedAt)}（北京时间）。以下为已保存的草稿，不含尚未保存的修改。` : '暂无已保存答案。该学生尚未提交，未评分。'}</p></div>${done ? `<div class="review-total"><strong>${a.score}</strong><span>/ 100 分</span></div>` : ''}</div><div class="actions review-links"><a class="text-button" href="${esc(reportHref(a.id, a.reviewClassId))}">班级成绩表 →</a><a class="text-button" href="${esc(historyHref(a.student.id, fromHistory ? recordFilters(params) : {}, a.student.classId))}">该生练习记录 →</a></div></section><section class="review-questions" aria-label="逐题作答详情">${a.expressions.map((expression, i) => `<article class="review-question ${done ? a.results[i].correct ? 'correct' : 'incorrect' : 'ungraded'}" data-review-question="${i}"><div class="section-heading"><span class="question-number">第 ${i + 1} 题</span><span class="review-verdict">${done ? a.results[i].missing ? '漏答' : a.results[i].correct ? '✓ 正确' : '✕ 错误' : '未评分'}</span></div><p class="review-expression">${esc(expression)} ＝ ?</p><dl class="review-answers"><div><dt>学生答案</dt><dd class="review-student-answer">${a.answers[i] == null ? `<span class="muted">${done ? '漏答（未填）' : '未填'}</span>` : esc(a.answers[i])}</dd></div><div><dt>正确答案</dt><dd class="review-correct-answer">${a.results[i].correctAnswer}</dd></div></dl></article>`).join('')}</section>`;
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
  return `${categoryNames[a.category]} · ${a.questionCount} 题${a.grade ? ` · ${a.grade} 年级` : ''}${a.difficulty ? ` · ${a.difficulty === 'advanced' ? '提高' : '基础'}` : ''}${a.category === 'composite' && a.components ? ` · ${a.components.map(c => `${categoryNames[c.category]} ${c.count} 题`).join(' / ')}` : ''}${a.grade ? ` · ${esc(a.knowledgePointNames.join('、'))}` : ''}${a.timeLimitMinutes ? ` · 个人限时 ${a.timeLimitMinutes} 分钟` : ''}`;
}
function practiceFields() {
  const p = state.practiceOptions;
  if (!p) return '';
  return `<fieldset id="practice-fields" class="practice-fields" hidden disabled><legend>混合练习内容</legend><label>年级<select name="grade">${p.grades.map(g => `<option value="${g}" ${g === 3 ? 'selected' : ''}>${g} 年级</option>`).join('')}</select></label><div class="topic-options"><span>勾选本班已学知识点</span>${p.topics.map(t => `<label data-min-grade="${t.minGrade}"><input type="checkbox" name="knowledgePoints" value="${t.id}" ${['precedence', 'parentheses'].includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')}</div><small>年级用于筛选，按本班实际学习进度勾选。混合题基础 2 步、提高 3 步，数字仍在 100 以内。</small></fieldset>`;
}
function syncPracticeFields() {
  const fields = document.querySelector('#practice-fields');
  if (!fields) return;
  const category = document.querySelector('[name="category"]').value, composite = document.querySelector('#composite-fields');
  composite.hidden = composite.disabled = category !== 'composite';
  const mixed = category === 'mixed-100' || category === 'composite' && !!composite.querySelector('[value="mixed-100"]:checked');
  document.querySelector('#difficulty-hint').textContent = difficultyHint(category, document.querySelector('[name="difficulty"]').value);
  fields.hidden = fields.disabled = !mixed;
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
    ${state.preview ? previewView(state.preview) : ''}<div class="teacher-layout"><section><div class="section-heading"><h2>班级作业</h2><span class="muted">最新发布在前</span></div>
    ${state.assignments.length ? `<div class="assignment-list">${state.assignments.map(a => `<a class="assignment-card" href="#/assignment/${a.id}"><div class="card-top"><span class="eyebrow">${assignmentSummary(a)}</span><span class="arrow">↗</span></div><h3>${esc(a.title)}</h3><p class="muted">发布于 ${date(a.createdAt)}<br>${deadline(a)}</p><div class="card-stats"><div><strong>${a.submitted}<small> / ${a.total}</small></strong><span>已交人数</span></div><div><strong>${a.pending}</strong><span>未交人数</span></div><div><strong>${a.average ?? '—'}</strong><span>平均分</span></div></div></a>`).join('')}</div>` : '<div class="empty"><span class="empty-symbol">＋ −</span><h3>从第一份练习开始</h3><p>选择题型和题量，发布全班的计算练习。</p></div>'}</section>
    <aside class="panel publish-panel"><span class="eyebrow">一份小练习</span><h2>发布新作业</h2><p class="muted">选择题型和接收班级，所选班级完成同一套题，满分 100 分。</p><form id="publish-form"><label>作业名称<input name="title" required maxlength="60" placeholder="例如：周三计算小练习"></label><label>练习题型<select name="category">${Object.entries(categoryNames).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><fieldset id="composite-fields" class="practice-fields" hidden disabled><legend>综合练习包含</legend>${practiceCategories.map(c => `<label><input type="checkbox" name="selectedCategories" value="${c}" checked>${categoryNames[c]}</label>`).join('')}<small>勾选两类或三类，题量尽量均分；余题按加减、乘除、混合顺序分配。</small></fieldset><label>练习难度<select name="difficulty"><option value="basic">基础</option><option value="advanced">提高</option></select><small id="difficulty-hint"></small></label>${practiceFields()}${targetFields()}<label>题目数量<select name="questionCount">${[10, 20, 50].map(n => `<option value="${n}">${n} 道</option>`).join('')}</select></label><label>每人作答时间（分钟，可选）<input type="number" name="timeLimitMinutes" min="1" max="1440" step="1" placeholder="例如：20"><small>留空则不限制个人时长，点击开始后连续计时。</small></label><label>截止时间（北京时间，可选）<input type="datetime-local" name="dueAt" step="60"><small>留空则不限时；到点停止提交，仍可保存草稿。</small></label><div class="paper-spec"><span>总分<strong>100 分，按答对比例计分</strong></span><span>面向学生<strong>所选班级学生</strong></span></div><p class="form-error" id="publish-error" role="alert"></p><button type="submit" class="button full">生成 / 更新预览</button></form><p class="small muted">发布后，所选班级学生可以开始作答；其他班级看不到这份新作业。</p></aside></div>`;
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
  return students.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">姓名</th><th scope="col">学号 / 登录账号</th><th scope="col">所在班级</th><th scope="col">账号操作</th></tr></thead><tbody>${students.map(s => `<tr><td><a class="student-record-link" href="${historyHref(s.id)}"><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}<small>练习记录 →</small></a></td><td class="mono">${esc(s.username)}</td><td><select data-student-class="${s.id}" aria-label="${esc(s.name)}（${esc(s.username)}）的班级">${classOptions(s.classId)}</select></td><td><a class="reset-password-link" href="#/students/${s.id}/password?classId=${state.classId}" aria-label="重设 ${esc(s.name)}（${esc(s.username)}）的密码">重设密码</a></td></tr>`).join('')}</tbody></table></div>` : state.students.length ? '<div class="empty"><h3>没有找到匹配的学生</h3><p>可更换姓名或学号，或清空搜索查看整班名单。</p></div>' : '<div class="empty"><h3>本班还没有学生</h3><p>导入名单、创建账号，或切换班级调整已有学生的归属。</p></div>';
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
    <div id="report-progress">${reportProgress(a)}</div><details class="panel questions-details"><summary>查看本次题目（${a.questionCount} 题）</summary><div class="question-preview">${a.expressions.map((expression, i) => `<span>${i + 1}.　${esc(expression)} = ?</span>`).join('')}</div></details>`;
}
function reportProgress(a) {
  const now = assignmentNow(a);
  nextOverviewExpiry = a.students.reduce((next, student) =>
    student.submittedAt || closed(student, now) ? next : Math.min(next, dueTime(student)), Infinity);
  return `<div class="report-stats"><div><span>已交人数</span><strong>${a.submitted}<small> / ${a.total} 人</small></strong></div><div><span>未交人数</span><strong>${a.pending}<small> 人</small></strong></div><div><span>班级平均分</span><strong>${a.average ?? '—'}<small>${a.average === null ? ' 暂无提交' : ' 分'}</small></strong></div></div>
    <section class="panel"><div class="section-heading"><h2>每位同学的进度</h2><span class="muted small">平均分仅计算已提交学生</span></div><div class="table-wrap"><table><thead><tr><th scope="col">学生</th><th scope="col">账号</th><th scope="col">作业状态</th><th scope="col">提交时间</th><th scope="col">成绩 / 100</th></tr></thead><tbody>${a.students.map(s => `<tr><td><a class="student-review-link" href="${esc(reviewHref(a.id, s.id, routeParams().has('calendar') ? { calendar: routeParams().get('calendar') } : {}))}"><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}<small>查看作答 →</small></a></td><td class="mono">${esc(s.username)}</td><td>${badge(s, now)}</td><td>${date(s.submittedAt)}</td><td class="score-cell">${s.score ?? '—'}</td></tr>`).join('') || '<tr><td colspan="5">还没有学生，请前往学生名单创建账号。</td></tr>'}</tbody></table></div></section>`;
}
const mistakeHref = (a, original = false) => `#/mistakes/${a.assignmentId}/${a.questionNumber}${original ? '/original' : ''}`;
function attemptsTable(attempts) {
  return attempts.length ? `<div class="table-wrap"><table class="attempts-table"><thead><tr><th scope="col">次数</th><th scope="col">我的答案</th><th scope="col">结果</th><th scope="col">订正时间（北京时间）</th></tr></thead><tbody>${attempts.map(a => `<tr><td>第 ${a.attemptNumber} 次</td><td class="mono">${a.answer}</td><td class="${a.correct ? 'attempt-right' : 'attempt-wrong'}">${a.correct ? '✓ 做对了' : '✕ 还没做对'}</td><td>${date(a.submittedAt)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">还没有订正记录。</p>';
}
function mistakesView() {
  const items = state.mistakes;
  return `${pageTitle('每天进步一点点', '我的错题本', '收录第一次交卷时做错的题；订正后仍保留原作答和原分数。', '<button class="button secondary" data-action="refresh">刷新错题 ↻</button>')}<div class="mistake-overview"><span class="badge">共 ${items.length} 道错题</span><span class="badge done">最近订正正确 ${items.filter(i => i.lastAttemptCorrect).length} 道</span><span class="small muted">按原交卷时间，最近在前</span></div><section class="mistake-grid">${items.map(a => {
    const key = `${a.assignmentId}:${a.questionNumber}`, history = state.mistakeHistories[key];
    return `<article class="panel mistake-card" data-mistake="${key}"><div class="section-heading"><span class="eyebrow">第 ${a.questionNumber} 题</span><span class="badge ${a.lastAttemptCorrect ? 'done' : 'draft'}">${a.lastAttemptCorrect ? '最近订正正确' : a.attemptCount ? '继续订正' : '还未订正'}</span></div><p class="mistake-expression">${esc(a.expression)} ＝ ?</p><a class="mistake-origin" href="${mistakeHref(a, true)}">${esc(a.title)} · 第 ${a.questionNumber} 题 ↗</a><p class="small muted">${date(a.submittedAt)} 首次交卷 · 当时的答案：${a.originalStatus === 'missing' ? '漏答（未填）' : esc(a.originalAnswer)}</p><p class="mistake-progress">已订正 ${a.attemptCount} 次${a.firstCorrectAttempt ? ` · 第 ${a.firstCorrectAttempt} 次首次做对` : ''}</p><div class="actions"><a class="button" href="${mistakeHref(a)}">订正 →</a>${a.attemptCount ? `<button class="text-button" data-action="correction-history" data-assignment="${a.assignmentId}" data-number="${a.questionNumber}">${history ? '收起订正记录' : '查看订正记录'}</button>` : ''}</div>${history ? `<section class="mistake-history" aria-label="第 ${a.questionNumber} 题订正记录">${attemptsTable(history)}</section>` : ''}</article>`;
  }).join('') || '<div class="empty panel"><h2>暂时没有错题</h2><p>交卷后，第一次答错的题会收在这里。草稿和未交作业不收录。</p><a class="button secondary" href="#/">返回我的作业</a></div>'}</section>`;
}
function correctionView() {
  const c = state.correction, a = c.question, result = c.feedback;
  return `<a class="back-link" href="#/mistakes">← 返回我的错题本</a>${pageTitle('合上答案，再算一次', '独立订正', `${esc(a.title)} · 第 ${a.questionNumber} 题 · 已订正 ${result?.attemptCount ?? a.attemptCount} 次`)}<section class="panel correction-paper"><span class="eyebrow">第 ${a.questionNumber} 题</span><p class="correction-expression">${esc(a.expression)} ＝ ?</p>${result ? `<div class="correction-result ${result.attempt.correct ? 'right' : 'wrong'}" role="status"><strong>第 ${result.attempt.attemptNumber} 次订正：${result.attempt.correct ? '✓ 答对了' : '再想一想'}</strong><p>我的答案：<b>${result.attempt.answer}</b>　正确答案：<b>${result.correctAnswer}</b></p></div><section class="correction-explanation"><h2>一步一步算</h2><ol>${result.steps.map(s => `<li><strong>${esc(s.reason)}</strong><p class="step-expression">${esc(s.before)}<br>＝ ${esc(s.after)}</p><small>${esc(s.calculation)}</small></li>`).join('')}</ol></section><div class="actions correction-actions"><button class="button" data-action="retry-correction">${result.attempt.correct ? '合上讲解，再练一次' : '再订正一次'}</button><a class="button secondary" href="#/mistakes">返回错题本</a></div><section class="correction-attempts"><h2>我的订正记录</h2>${attemptsTable(result.attempts)}</section>` : `<p class="muted small">先独立计算，提交后再看对错和讲解。</p><form id="correction-form"><fieldset><legend class="sr-only">独立填写订正答案</legend><label>订正答案<input name="correctionAnswer" type="number" min="0" max="${a.answerMax}" step="1" inputmode="numeric" autocomplete="off" required value="${esc(c.answer)}" placeholder="填入你的答案"></label><button class="button" type="submit">提交订正</button></fieldset><p id="correction-error" class="form-error" role="alert"></p></form>`}<div class="correction-original"><a class="text-button" href="${mistakeHref(a, true)}">查看当时交的原卷 →</a><p class="muted small">每次订正单独记录，原作业的答案和分数照旧。</p></div></section>`;
}
async function saveCorrection() {
  if (state.busy || !state.correction || state.correction.feedback) return;
  const form = document.querySelector('#correction-form');
  if (!form.reportValidity()) return;
  const c = state.correction, answer = Number(form.elements.correctionAnswer.value);
  if (!c.request || c.request.answer !== answer) c.request = { answer, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), v => v.toString(16).padStart(2, '0')).join('') };
  state.busy = true; form.querySelector('fieldset').disabled = true; errorAt('correction-error', '');
  try {
    const result = await api(`/mistakes/${c.question.assignmentId}/${c.question.questionNumber}/attempts`, 'POST', c.request);
    c.feedback = result; state.dirty = false; render();
  } catch (e) { errorAt('correction-error', e.message); }
  finally { state.busy = false; form.querySelector('fieldset').disabled = false; }
}
function studentCard(a, now) {
  const personal = a.deadlineSource === 'personal';
  const cutoff = personal ? `个人截止：${date(a.effectiveDueAt)}（北京时间）` : deadline(a);
  let action = a.savedAt || a.startedAt ? '继续作答' : '开始作答';
  if (closed(a, now)) action = a.timeLimitMinutes && !a.startedAt ? '查看作业' : '查看草稿';
  const progress = a.savedAt ? `已保存 ${a.answers.filter(v => v !== null).length}/${a.questionCount} 题` : a.timeLimitMinutes && !a.startedAt && !closed(a, now) ? '开始作答后计时' : '';
  return `<a class="assignment-card student-card" href="#/assignment/${a.id}">
    <div class="card-top">${badge(a, now)}<span class="muted small">${date(a.createdAt)}</span></div>
    <h3>${esc(a.title)}</h3><p class="muted">${assignmentSummary(a)} · 满分 100 分<br>${cutoff}</p>
    <div class="student-card-bottom">${a.submittedAt
      ? `<strong class="result-score">${a.score}<small> 分</small></strong><span>查看批改 →</span>`
      : `<span>${progress}</span><strong>${action} →</strong>`}</div></a>`;
}
function studentHome() {
  const assignments = state.assignments, now = assignmentNow(assignments[0] ?? {});
  const open = [], overdue = [], submitted = [];
  for (const a of assignments) {
    if (a.submittedAt) submitted.push(a);
    else if (closed(a, now)) overdue.push(a);
    else open.push(a);
  }
  open.sort((a, b) => dueTime(a) - dueTime(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  nextOverviewExpiry = open.length ? dueTime(open[0]) : Infinity;
  const groups = [['可提交', open], ['已截止未交', overdue], ['已提交', submitted]];
  const summary = assignments.length ? `${open.length} 份可提交 · ${overdue.length} 份已截止未交 · ${submitted.length} 份已提交` : '老师发布作业后，就会出现在这里。';
  const title = pageTitle('我的作业本', `${esc(state.user.name)}，今天也加油！`, summary);
  if (!assignments.length) return title + '<section class="student-grid"><div class="empty panel"><span class="empty-symbol">＋ −</span><h2>作业本还是空的</h2><p>稍后再来看看吧。</p><button class="button secondary" data-action="refresh">刷新作业</button></div></section>';
  return title + groups.filter(([, papers]) => papers.length).map(([label, papers]) => `
    <section class="work-group" aria-label="${label}"><h2>${label} <small>${papers.length} 份</small></h2>
    <div class="student-grid">${papers.map(a => studentCard(a, now)).join('')}</div></section>`).join('');
}
function updateOverviewPanel(panel) {
  const focusedLink = panel.contains(document.activeElement) && document.activeElement.closest('a')?.getAttribute('href');
  panel.innerHTML = panel.id === 'report-progress' ? reportProgress(state.assignment) : studentHome();
  if (focusedLink) [...panel.querySelectorAll('a')].find(link => link.getAttribute('href') === focusedLink)?.focus({ preventScroll: true });
}
async function refreshTimedOverview() {
  const panel = document.querySelector('#student-home, #report-progress');
  if (!panel || document.visibilityState === 'hidden' || panel.dataset.refreshing) return;
  const report = state.assignment, rows = report ? report.students : state.assignments;
  if (!rows.some(row => (report ?? row).timeLimitMinutes && !row.submittedAt && !row.isClosed)) return;
  panel.dataset.refreshing = 'true';
  try {
    const latest = await api(report ? `/assignments/${report.id}/report?classId=${state.classId}` : '/assignments');
    if (!panel.isConnected) return;
    const next = report ? latest.students : latest;
    const changed = rows.length !== next.length || next.some((row, i) =>
      ['id', 'startedAt', 'submittedAt', 'savedAt', 'isClosed', 'name'].some(key => row[key] !== rows[i][key]));
    if (report) state.assignment = latest;
    else state.assignments = latest;
    if (changed) updateOverviewPanel(panel);
    else syncDeadlineUI();
  } catch {
    // Continue from the last known deadlines until the next successful refresh.
  } finally { delete panel.dataset.refreshing; }
}
function workbook(a) {
  const done = !!a.submittedAt;
  const original = routePath().match(/^#\/mistakes\/([1-9]\d*)\/([1-9]\d*)\/original$/);
  const sourceNote = original ? `<div class="mistake-source-note">来自错题本 · 第 ${original[2]} 题已标出。<a href="#/mistakes/${original[1]}/${original[2]}">合上原卷，独立订正 →</a></div>` : '';
  if (a.timeLimitMinutes && !a.startedAt && !done) return `<a class="back-link" href="#/">← 返回我的作业</a>${pageTitle('限时练习', esc(a.title), `${assignmentSummary(a)} · ${deadline(a)}`)}<section class="panel"><h2>准备好后开始作答</h2><p>点击后开始计时，刷新或重新登录不会暂停。个人限时和全班截止以先到者为准；到点仍可保存草稿，未提交计为未交。</p><button class="button" data-action="start" ${closed(a) ? 'disabled' : ''}>${closed(a) ? '已截止，不能开始' : '开始作答'}</button><p id="start-error" class="form-error" role="alert"></p></section>`;
  const count = a.answers.filter(v => v !== null).length;
  return `<a class="back-link" href="${original ? '#/mistakes' : '#/'}">← 返回${original ? '我的错题本' : '我的作业'}</a>${sourceNote}<div class="workbook-heading">${pageTitle(done ? '练习完成' : '专心算一算', esc(a.title), `${assignmentSummary(a)} · 每题 ${100 / a.questionCount} 分 · ${a.category === 'composite' ? '按每题标注的范围填写整数' : `答案是 0–${a.answerMax} 的整数`} · ${deadline(a)}`)}${done ? `<div class="score-stamp"><strong>${a.score}</strong><span>/ 100 分</span></div>` : ''}</div>
    ${done ? `<div class="result-banner"><strong>${a.score === 100 ? '全部答对，真棒！' : `答对了 ${a.results.filter(r => r.correct).length} / ${a.questionCount} 道题，再看看需要订正的地方。`}</strong><span>${date(a.submittedAt)} 提交 · 已自动批改</span></div>` : `<div class="progress-heading"><span id="progress-label">已作答 ${count} / ${a.questionCount} 题</span><span id="save-state" class="muted" role="status" aria-live="polite">${a.savedAt ? `草稿保存于 ${date(a.savedAt)}` : '停笔一会儿会自动保存，也可手动保存。'}</span></div><progress id="progress" max="${a.questionCount}" value="${count}" aria-label="作答进度"></progress>`}
    ${a.timeLimitMinutes && !done ? `<div class="timer-panel"><strong id="countdown" role="timer"></strong><span>开始于 ${date(a.startedAt)} · 最晚 ${date(a.effectiveDueAt)}（北京时间）</span></div>` : ''}<p id="deadline-state" class="deadline-message" role="status" hidden></p>${!done ? '<section id="draft-conflict" class="draft-conflict" role="alert" hidden><p></p><div class="actions"><button class="button secondary" data-action="load-saved-draft">载入已保存草稿</button><button class="button" data-action="keep-local-draft">保留本页答案并保存</button></div></section>' : ''}<form id="answer-form"><fieldset ${done ? 'disabled' : ''}><legend class="sr-only">${a.questionCount} 道计算题</legend><div class="question-grid">${a.expressions.map((expression, i) => `<div data-original-question="${i + 1}" class="question ${original && Number(original[2]) === i + 1 ? 'source-question' : ''} ${done ? (a.results[i].correct ? 'correct' : 'incorrect') : ''}"><span class="question-number">第 ${i + 1} 题${a.category === 'composite' ? ` · 答案 0–${a.answerMaxes[i]}` : ''}</span><div class="equation"><label for="answer-${i}"><span class="sr-only">第 ${i + 1} 题：</span>${esc(expression)} <span class="operator">＝</span></label><input id="answer-${i}" name="answer-${i}" type="number" min="0" max="${a.answerMaxes?.[i] ?? a.answerMax}" step="1" inputmode="numeric" autocomplete="off" aria-label="第 ${i + 1} 题答案" ${done ? '' : `aria-describedby="hint-${i}"`} value="${esc(a.answers[i])}" ${done ? 'readonly' : ''}></div>${done ? `<div class="question-feedback">${a.results[i].missing ? `漏答 · 正确答案：${a.results[i].correctAnswer}` : a.results[i].correct ? '✓ 答对了' : `✕ 正确答案：${a.results[i].correctAnswer}`}</div>` : `<span id="hint-${i}" class="draft-hint">请填写 0–${a.answerMaxes?.[i] ?? a.answerMax} 的整数。其他题可先保存。</span>`}</div>`).join('')}</div></fieldset>
    ${done ? '<div class="actions result-actions"><a class="button secondary" href="#/">返回我的作业</a><span class="muted">作业已提交，答案不能再修改。</span></div>' : `<div class="answer-actions"><div><strong>慢慢算，认真检查。</strong><p class="small muted">保存草稿后，下次登录可以接着写。</p></div><div class="actions"><button type="button" class="button secondary" data-action="save">保存草稿</button><button type="button" class="button secondary" data-action="save-leave">保存并离开</button><button type="submit" class="button" data-submit>提交作业 →</button></div></div><p id="answer-error" class="form-error" role="alert"></p>`}</form>`;
}
function render() {
  let view;
  if (!state.user) view = loginView();
  else if (state.loading) view = '<p class="loading">正在打开作业本…</p>';
  else if (state.loadError) view = `<section class="empty panel"><h2>作业本暂时没有打开</h2><p>${esc(state.loadError)}</p><button class="button" data-action="refresh">重新加载</button><p><a href="#/">返回作业列表</a></p></section>`;
  else if (state.passwordStudent || (routePath() === '#/password' && state.user.role === 'student')) view = passwordView();
  else if (state.correction) view = correctionView();
  else if (state.mistakes) view = mistakesView();
  else if (state.reviewData) view = reviewView(state.reviewData);
  else if (state.historyData) view = historyView(state.historyData);
  else if (state.analyticsData) view = analyticsView(state.analyticsData);
  else if (routePath() === '#/students' && state.user.role === 'teacher') view = studentsView();
  else if (routePath() === '#/calendar' && state.user.role === 'teacher') view = calendarView(state.calendarData);
  else if (state.assignment) view = state.user.role === 'teacher' ? reportView(state.assignment) : workbook(state.assignment);
  else view = state.user.role === 'teacher' ? teacherHome() : `<div id="student-home">${studentHome()}</div>`;
  root.innerHTML = `${header()}${state.user ? `<main class="main">${view}</main>` : view}<footer>小小算术 <span>·</span> 每天进步一点点</footer>`;
  syncDeadlineUI();
  restorePublishForm();
  syncPracticeFields();
  updatePreviewControls();
}
async function load() {
  if (!state.user) { render(); return; }
  resetDraftSaving();
  activeRecovery = null;
  const epoch = ++loadEpoch;
  state.loading = true; state.loadError = ''; state.assignment = null; state.passwordStudent = null; state.analyticsData = null; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.mistakes = null; state.correction = null; state.mistakeHistories = {}; render();
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
    const mistakeMatch = path.match(/^#\/mistakes\/([1-9]\d*)\/([1-9]\d*)(\/original)?$/);
    if (path === '#/mistakes' && state.user.role === 'student') {
      const mistakes = await api('/mistakes');
      if (epoch !== loadEpoch) return; state.mistakes = mistakes;
    } else if (mistakeMatch && state.user.role === 'student') {
      const data = await api(`/mistakes/${mistakeMatch[1]}/${mistakeMatch[2]}${mistakeMatch[3] ?? ''}`);
      if (epoch !== loadEpoch) return;
      if (mistakeMatch[3]) state.assignment = data;
      else state.correction = { question: data, answer: '', feedback: null, request: null };
    } else if (path === '#/analytics' && state.user.role === 'teacher') {
      const query = new URLSearchParams({ classId: String(state.classId) });
      for (const key of ['from', 'to', 'assignmentId', 'questionNumber']) if (params.has(key)) query.set(key, params.get(key));
      const data = await api(`/analytics?${query}`);
      if (epoch !== loadEpoch) return;
      state.analyticsData = data; state.analyticsAll = params.get('all') === '1';
      history.replaceState(null, '', analyticsHref({ filters: data.filters, selection: data.selectedQuestion }));
    } else if (/^#\/students\/[1-9]\d*\/password$/.test(path) && state.user.role === 'teacher') {
      const students = await api(`/students?classId=${state.classId}`);
      if (epoch !== loadEpoch) return;
      const pupil = students.find(s => s.id === Number(path.split('/')[2]));
      if (!pupil) throw new Error('该学生不在当前班级，请返回名单重新选择');
      state.passwordStudent = pupil;
    } else if (historyMatch && state.user.role === 'teacher') {
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
      const [assignments, students, currentPreview] = await Promise.all([api(`/assignments?classId=${state.classId}`), api(`/students?classId=${state.classId}`), path === '#/students' ? Promise.resolve(null) : api('/assignment-previews/current')]);
      if (epoch !== loadEpoch) return; state.assignments = assignments; state.students = students;
      const preview = currentPreview?.preview;
      if (preview && preview.publishedAssignmentId === null) {
        const restored = draftFromPreview(preview.settings);
        if (state.preview?.previewId !== preview.previewId) state.previewFingerprint = JSON.stringify(restored);
        state.preview = preview; state.publishDraft ??= restored; state.previewStale = JSON.stringify(state.publishDraft) !== state.previewFingerprint;
      } else state.preview = null;
    } else {
      const assignments = await api('/assignments');
      if (epoch !== loadEpoch) return; state.assignments = assignments;
    }
    state.route = location.hash;
  } catch (e) { if (epoch === loadEpoch) { state.loadError = e.message; toast(e.message, true); } }
  finally {
    if (epoch === loadEpoch) {
      state.loading = false;
      render();
      if (state.user?.role === 'student' && state.assignment) restoreEdits(state.assignment);
    }
  }
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
  if (form.id === 'password-form') await formAction(form, 'password-error', async data => {
    document.querySelector('#password-success').textContent = '';
    if (data.newPassword !== data.confirmPassword) throw new Error('两次输入的新密码不一致');
    const pupil = state.passwordStudent;
    await api(pupil ? `/students/${pupil.id}/password` : '/me/password', 'PUT', pupil ? { classId: state.classId, newPassword: data.newPassword } : { currentPassword: data.currentPassword, newPassword: data.newPassword });
    form.reset();
    document.querySelector('#password-success').textContent = pupil ? `已重设 ${pupil.name}（${pupil.username}）的密码，请告知该学生。` : '密码已修改，请在下次登录时使用新密码。';
  });
  if (form.id === 'analytics-filter-form' && !state.busy) {
    const filters = Object.fromEntries(new FormData(form));
    if (filters.from && filters.to && filters.from > filters.to) { errorAt('analytics-error', '开始日期不能晚于结束日期'); return; }
    const href = analyticsHref({ filters });
    if (location.hash === href) await load(); else location.hash = href;
  }
  if (form.id === 'correction-form') await saveCorrection();
  if (form.id === 'history-filter-form' && !state.busy) {
    const filters = Object.fromEntries(new FormData(form));
    if (filters.from && filters.to && filters.from > filters.to) { errorAt('history-error', '开始日期不能晚于结束日期'); return; }
    const href = historyHref(state.historyData.student.id, filters);
    if (location.hash === href) await load(); else location.hash = href;
  }
  if (form.id === 'login-form') await formAction(form, 'login-error', async data => {
    resetPublish();
    state.user = await api('/login', 'POST', data); state.dirty = false; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.passwordStudent = null; state.analyticsData = null; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.mistakes = null; state.correction = null; state.mistakeHistories = {}; state.assignment = null;
    const assignmentId = routePath().match(/^#\/assignment\/([1-9]\d*)$/)?.[1];
    const resume = state.user.role === 'student' && assignmentId && readRecovery(recoveryKey(assignmentId));
    history.replaceState(null, '', resume ? `#/assignment/${assignmentId}` : '#/'); await load();
  });
  if (form.id === 'publish-form') await requestPreview(form);
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
    else if (form.reportValidity()) {
      const missing = readAnswers(form).flatMap((answer, index) => answer === null ? [index + 1] : []);
      document.querySelector('#submit-missing').hidden = missing.length === 0;
      document.querySelector('#missing-summary').textContent = missing.length
        ? `还有 ${missing.length} 题没答。点题号可返回补答。按现有答案交卷时，空题计 0 分。` : '';
      document.querySelector('#missing-questions').innerHTML = missing.map(number =>
        `<button type="button" data-answer-id="answer-${number - 1}">第 ${number} 题</button>`
      ).join('');
      document.querySelector('#confirm-submit').textContent = missing.length ? '确认按现有答案交卷' : '确认提交';
      dialog.showModal();
    }
  }
});
function readAnswers(form = document.querySelector('#answer-form')) {
  return Array.from({ length: state.assignment.questionCount }, (_, i) => { const value = form.elements[`answer-${i}`].value; return value === '' ? null : Number(value); });
}
function draftSnapshot(form, assignment) {
  const invalid = [];
  const answers = assignment.answers.map((saved, i) => {
    const input = form.elements[`answer-${i}`];
    if (input.validity.valid) return input.value === '' ? null : Number(input.value);
    invalid.push(i + 1);
    return saved;
  });
  return { answers, invalid };
}
const sameAnswers = (left, right) => left.every((value, i) => value === right[i]);
const memoryRecoveries = new Map();
let activeRecovery = null;
const recoveryKey = id => `classwork:unfinished:${state.user.id}:${encodeURIComponent(state.user.username)}:${id}`;
function readRecovery(key) {
  if (memoryRecoveries.has(key)) return memoryRecoveries.get(key);
  try { return localStorage.getItem(key); } catch { return null; }
}
function rememberEdits() {
  const a = state.assignment, form = document.querySelector('#answer-form');
  if (!state.dirty || state.user?.role !== 'student' || !a || a.submittedAt || !form) return;
  const values = a.answers.map((saved, i) => {
    const field = form.elements[`answer-${i}`];
    // Number inputs do not expose unfinished tokens such as a lone minus sign.
    return field.validity.badInput ? String(saved ?? '') : field.value;
  });
  const key = recoveryKey(a.id);
  const text = JSON.stringify({ createdAt: a.createdAt, revision: a.draftRevision, values });
  activeRecovery = { key, text };
  try { localStorage.setItem(key, text); memoryRecoveries.delete(key); }
  catch { memoryRecoveries.set(key, text); }
}
function forgetEdits() {
  if (!activeRecovery) return;
  const { key, text } = activeRecovery;
  activeRecovery = null;
  if (readRecovery(key) !== text) return;
  memoryRecoveries.delete(key);
  try { if (localStorage.getItem(key) === text) localStorage.removeItem(key); } catch { /* Storage disabled. */ }
}
function restoreEdits(a) {
  const key = recoveryKey(a.id), text = readRecovery(key);
  if (!text) return;
  activeRecovery = { key, text };
  let record;
  try { record = JSON.parse(text); } catch { forgetEdits(); return; }
  if (a.submittedAt || record?.createdAt !== a.createdAt || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !Array.isArray(record.values) || record.values.length !== a.questionCount || !record.values.every(v => typeof v === 'string')) {
    forgetEdits(); return;
  }
  const form = document.querySelector('#answer-form');
  if (!form) return;
  record.values.forEach((value, i) => { form.elements[`answer-${i}`].value = value; });
  const { answers, invalid } = draftSnapshot(form, a);
  const changed = !sameAnswers(answers, a.answers);
  state.dirty = changed || invalid.length > 0;
  if (!state.dirty) { forgetEdits(); return; }
  updateProgress(form);
  if (changed && record.revision !== a.draftRevision) {
    const revision = a.draftRevision;
    a.draftRevision = record.revision;
    showDraftConflict({ code: 'DRAFT_CONFLICT', draftRevision: revision, answers: a.answers, message: '已恢复上次输入。账号中的草稿已更新，请选择要继续使用的答案。' });
    return;
  }
  saveStatus('已恢复上次输入，正在等待自动保存。');
  scheduleAutosave();
}
function updateProgress(form) {
  const count = [...form.querySelectorAll('.equation input')].filter(input => input.value !== '').length;
  document.querySelector('#progress').value = count;
  document.querySelector('#progress-label').textContent = `已作答 ${count} / ${state.assignment.questionCount} 题`;
}
function saveStatus(message) { const node = document.querySelector('#save-state'); if (node) node.textContent = message; }
function scheduleAutosave(delay = 1000) {
  clearTimeout(autosaveTimer);
  if (state.user?.role === 'student' && state.assignment && !state.assignment.submittedAt && state.dirty && !draftConflict) autosaveTimer = setTimeout(() => saveDraft(), delay);
}
function showDraftConflict(error) {
  clearTimeout(autosaveTimer);
  draftConflict = { revision: error.draftRevision, answers: error.answers, submitted: error.code !== 'DRAFT_CONFLICT' };
  const panel = document.querySelector('#draft-conflict');
  if (panel) { panel.hidden = false; panel.querySelector('p').textContent = error.message; panel.querySelector('[data-action="keep-local-draft"]').hidden = draftConflict.submitted; }
  saveStatus('自动保存已暂停 · 本页答案仍保留');
}
async function saveDraft(manual = false) {
  if (!state.assignment || state.assignment.submittedAt || state.user?.role !== 'student' || (state.busy && !manual) || draftConflict) return false;
  clearTimeout(autosaveTimer);
  if (draftFlight) return draftFlight;
  const form = document.querySelector('#answer-form');
  if (!form) return false;
  const a = state.assignment, { answers } = draftSnapshot(form, a);
  const epoch = loadEpoch, button = form.querySelector('[data-action="save"]');
  const current = () => epoch === loadEpoch && state.assignment === a && form.isConnected;
  let retry = false;
  saveStatus('正在保存草稿…'); if (button) button.disabled = true;
  errorAt('answer-error', '');
  const flight = (async () => {
    try {
      const saved = await api(`/assignments/${a.id}/draft`, 'PUT', { answers, draftRevision: a.draftRevision });
      if (!current()) return false;
      a.answers = saved.answers; a.savedAt = saved.savedAt; a.draftRevision = saved.draftRevision;
      const latest = draftSnapshot(form, a);
      retry = !sameAnswers(latest.answers, saved.answers);
      state.dirty = retry || latest.invalid.length > 0;
      if (!state.dirty) forgetEdits();
      else if (activeRecovery) rememberEdits();
      draftRetryDelay = 1000;
      if (retry) saveStatus('有新修改，稍后自动保存');
      else if (latest.invalid.length) saveStatus(`第 ${latest.invalid.join('、')} 题需修改，其他答案已保存。`);
      else saveStatus(`已保存 · 草稿保存于 ${date(saved.savedAt)}`);
      if (manual && !state.dirty) toast('草稿已保存，下次可以接着写。');
      return true;
    } catch (e) {
      if (!current()) return false;
      errorAt('answer-error', e.message);
      if (e.status === 409) showDraftConflict(e);
      else { retry = true; saveStatus('保存失败 · 本页答案仍保留，将自动重试'); draftRetryDelay = Math.min(30000, Math.max(3000, draftRetryDelay * 2)); }
      return false;
    } finally { if (current() && button) button.disabled = false; }
  })();
  draftFlight = flight;
  try { return await flight; }
  finally { if (draftFlight === flight) { draftFlight = null; if (current() && retry) scheduleAutosave(draftRetryDelay); } }
}
async function saveAndLeave() {
  if (draftConflict) {
    document.querySelector('[data-action="load-saved-draft"]')?.focus();
    return;
  }
  const form = document.querySelector('#answer-form'), a = state.assignment;
  state.busy = true;
  try {
    // Edits made while a previous save was in flight must reach the server too.
    let latest;
    do {
      if (!await saveDraft(true) || !form.isConnected) return;
      latest = draftSnapshot(form, a);
    } while (!sameAnswers(latest.answers, a.answers));
    if (latest.invalid.length && !confirm(`其他答案已保存。第 ${latest.invalid.join('、')} 题的输入无效，离开后这几题将保留上次保存的答案。确定离开吗？`)) {
      form.reportValidity();
      return;
    }
    forgetEdits();
    state.dirty = false;
    location.hash = '#/';
  } finally { state.busy = false; }
}
async function submitAnswers() {
  if (state.busy || !state.assignment || state.assignment.submittedAt) return;
  if (closed(state.assignment)) { syncDeadlineUI(); errorAt('answer-error', closedMessage); return; }
  const form = document.querySelector('#answer-form');
  if (!form.reportValidity()) return;
  const answers = readAnswers(form);
  clearTimeout(autosaveTimer);
  state.busy = true;
  const fieldset = form.querySelector('fieldset'); fieldset.disabled = true;
  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  errorAt('answer-error', '');
  try {
    if (draftFlight) await draftFlight;
    if (!state.assignment || !form.isConnected) return;
    if (draftConflict) { errorAt('answer-error', '请先处理草稿冲突，再确认交卷。本页答案仍保留。'); return; }
    state.assignment = await api(`/assignments/${state.assignment.id}/submit`, 'POST', { answers, draftRevision: state.assignment.draftRevision, allowIncomplete: answers.includes(null) });
    forgetEdits(); state.dirty = false; render(); toast('作业已提交，批改结果出来啦！');
  } catch (e) {
    if (e.code === 'DRAFT_CONFLICT') showDraftConflict(e);
    else if (e.status === 409 && e.message.includes('已截止')) state.assignment.isClosed = true;
    errorAt('answer-error', e.message);
  }
  finally { state.busy = false; fieldset.disabled = false; form.querySelectorAll('button').forEach(b => { b.disabled = false; }); syncDeadlineUI(); scheduleAutosave(); }
}
root.addEventListener('input', event => {
  if (event.target.name === 'correctionAnswer') { state.correction.answer = event.target.value; state.dirty = true; }
  if (event.target.name === 'studentSearch') { state.studentQuery = event.target.value; updateStudentSearch(); }
  if (event.target.closest('#publish-form')) { syncPracticeFields(); publishChanged(); }
  if (event.target.closest('#answer-form')) {
    state.dirty = true;
    updateProgress(event.target.form);
    saveStatus(draftConflict ? '自动保存已暂停 · 本页答案仍保留' : '有未保存的修改，停笔后自动保存');
    scheduleAutosave();
  }
});
root.addEventListener('change', async event => {
  if (event.target.closest('#publish-form')) { syncPracticeFields(); publishChanged(); }
  if (state.busy) return;
  if (event.target.name === 'analyticsAll' && state.analyticsData) {
    state.analyticsAll = event.target.checked;
    history.replaceState(null, '', analyticsHref({ filters: state.analyticsData.filters, selection: state.analyticsData.selectedQuestion }));
    document.querySelector('#analytics-question-count').textContent = `${analyticsQuestions().length} 题`;
    document.querySelector('#analytics-question-list').innerHTML = analyticsQuestionList();
    // Keep original-review links in the selected detail consistent with this display choice.
    document.querySelectorAll('#analytics-detail .student-name').forEach(link => { const url = new URL(link.href); const params = new URLSearchParams(url.hash.split('?')[1]); params.set('all', state.analyticsAll ? '1' : '0'); link.href = `${url.hash.split('?')[0]}?${params}`; });
  }
  if (event.target.name === 'currentClass') {
    state.classId = Number(event.target.value); state.importResult = null;
    if (routePath() === '#/analytics') {
      history.replaceState(null, '', analyticsHref({ filters: state.analyticsData?.filters ?? recordFilters(routeParams()) }));
    } else if (/^#\/students(?:\/\d+)?\/history$/.test(routePath())) {
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
  if (action === 'load-saved-draft' && confirm('将载入已保存的答案，放弃本页尚未保存的修改。确定继续吗？')) { forgetEdits(); state.dirty = false; await load(); }
  if (action === 'keep-local-draft' && draftConflict && !draftConflict.submitted && confirm('将以本页答案替换其他窗口已保存的草稿。确定保留本页答案吗？')) {
    state.assignment.draftRevision = draftConflict.revision;
    state.assignment.answers = draftConflict.answers ?? state.assignment.answers;
    draftConflict = null; document.querySelector('#draft-conflict').hidden = true; await saveDraft(true);
  }
  if (action === 'analytics-list') document.querySelector('#analytics-list')?.scrollIntoView?.({ block: 'start' });
  if (event.target.closest('[data-analytics-question]')?.getAttribute('href') === location.hash) { event.preventDefault(); document.querySelector('#analytics-detail')?.scrollIntoView?.({ block: 'start' }); }
  if (action === 'save') await saveDraft(true);
  if (action === 'save-leave') await saveAndLeave();
  if (action === 'confirm-preview') await confirmPreview();
  if (action === 'replace-preview') { const form = document.querySelector('#publish-form'); if (form.reportValidity()) await requestPreview(form); }
  if (action === 'edit-preview') { document.querySelector('#publish-form')?.scrollIntoView?.({ block: 'start' }); document.querySelector('#publish-form [name="title"]')?.focus(); }
  if (action === 'retry-correction' && state.correction) {
    const c = state.correction;
    state.correction = { question: { ...c.question, attemptCount: c.feedback.attemptCount }, answer: '', feedback: null, request: null };
    state.dirty = false; render(); document.querySelector('[name="correctionAnswer"]')?.focus();
  }
  if (action === 'correction-history') {
    const button = event.target.closest('button'), assignmentId = button.dataset.assignment, number = button.dataset.number, key = `${assignmentId}:${number}`, epoch = loadEpoch;
    if (state.mistakeHistories[key]) { delete state.mistakeHistories[key]; render(); }
    else {
      button.disabled = true;
      try { const history = await api(`/mistakes/${assignmentId}/${number}/attempts`); if (epoch === loadEpoch && state.mistakes) { state.mistakeHistories[key] = history; render(); } }
      catch (e) { toast(e.message, true); }
      finally { button.disabled = false; }
    }
  }
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
  if (action === 'refresh' && (!state.dirty || confirm('还有未保存的答案。确定重新加载并放弃这些修改吗？'))) { forgetEdits(); state.dirty = false; await load(); }
  if (action === 'logout') {
    if (state.dirty && !confirm('还有未保存的答案。确定退出并放弃这些修改吗？')) return;
    state.busy = true;
    try { await api('/logout', 'POST', {}); forgetEdits(); loadEpoch++; resetDraftSaving(); resetPublish(); state.user = null; state.assignment = null; state.assignments = []; state.students = []; state.importResult = null; state.studentQuery = ''; state.passwordStudent = null; state.analyticsData = null; state.calendarData = null; state.calendarBack = null; state.historyData = null; state.reviewData = null; state.mistakes = null; state.correction = null; state.mistakeHistories = {}; state.dirty = false; history.replaceState(null, '', '#/'); render(); }
    catch (e) { toast(e.message, true); }
    finally { state.busy = false; }
  }
});
document.querySelector('#cancel-submit').addEventListener('click', () => dialog.close());
document.querySelector('#missing-questions').addEventListener('click', event => {
  const button = event.target.closest('button[data-answer-id]');
  if (!button) return;
  const input = document.getElementById(button.dataset.answerId);
  dialog.close();
  input?.focus({ preventScroll: true });
  input?.closest('.question').scrollIntoView?.({ block: 'center' });
});
document.querySelector('#confirm-submit').addEventListener('click', async () => { dialog.close(); await submitAnswers(); });
let reverting = false;
window.addEventListener('hashchange', async () => {
  if (reverting) { reverting = false; return; }
  if (state.busy || (state.dirty && !confirm('还有未保存的答案。确定离开并放弃这些修改吗？'))) {
    reverting = true; location.hash = state.route || '#/'; return;
  }
  forgetEdits(); state.dirty = false; await load();
  if (document.querySelector('.source-question')) document.querySelector('.source-question').scrollIntoView?.({ block: 'center' });
  else if (routePath() === '#/analytics' && state.analyticsData?.selectedQuestion) document.querySelector('#analytics-detail')?.scrollIntoView?.({ block: 'start' });
  else if (routePath() === '#/calendar' && new URLSearchParams(location.hash.split('?')[1] ?? '').has('day')) document.querySelector('.calendar-daily')?.scrollIntoView?.({ block: 'start' });
  else window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', rememberEdits);
document.addEventListener('visibilitychange', () => { if (document.hidden) rememberEdits(); });
try { state.user = await api('/me'); } catch (e) { if (!e.message.includes('请先登录')) toast(e.message, true); }
await load();

setInterval(syncDeadlineUI, 1000);
setInterval(refreshTimedOverview, 15000);
window.addEventListener('focus', syncDeadlineUI);
window.addEventListener('focus', refreshTimedOverview);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { syncDeadlineUI(); refreshTimedOverview(); }
});
window.addEventListener('online', () => scheduleAutosave());
window.addEventListener('focus', () => scheduleAutosave());
