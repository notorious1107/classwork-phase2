const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#submit-dialog');
const state = { user: null, assignments: [], students: [], assignment: null, dirty: false, busy: false, route: '', loading: false, loadError: '' };
let loadEpoch = 0;
let toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
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
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      loadEpoch++; state.user = null; state.dirty = false; state.assignment = null; state.assignments = []; state.students = []; render();
    }
    throw new Error(result.error || '操作失败，请重试');
  }
  return result;
}
function badge(a) {
  return a.submittedAt ? '<span class="badge done">已批改</span>' : a.savedAt ? '<span class="badge draft">草稿</span>' : '<span class="badge">待完成</span>';
}
function header() {
  return `<header class="header"><a href="#/" class="brand"><span class="brand-mark">＋</span><span>小小算术<small>班级作业本</small></span></a>
    ${state.user ? `<nav aria-label="主导航"><a href="#/" ${!location.hash.includes('students') ? 'aria-current="page"' : ''}>${state.user.role === 'teacher' ? '作业与成绩' : '我的作业'}</a>${state.user.role === 'teacher' ? `<a href="#/students" ${location.hash.includes('students') ? 'aria-current="page"' : ''}>学生名单</a>` : ''}</nav>
    <div class="user"><span>${esc(state.user.name)}<small>${state.user.role === 'teacher' ? '教师' : '学生'} · ${esc(state.user.username)}</small></span><button class="text-button" data-action="logout">退出</button></div>` : '<span class="header-note">每天十道题，一点点进步。</span>'}</header>`;
}
function loginView() {
  return `<main class="login-layout"><section class="login-story"><span class="eyebrow">把计算，练成小本领</span><h1>今天也来<br>算一算<span class="blue">。</span></h1><p>打开自己的作业本，<br>认真思考，再写下答案。</p>
    <div class="math-note" aria-hidden="true"><span>今日小练习</span><div>8 <b>＋</b> 7 <i>＝</i> <strong>?</strong></div><small>加一点思考，多一点收获</small></div></section>
    <section class="login-card"><span class="eyebrow">欢迎回到班级</span><h2>登录作业本</h2><p class="muted">教师和学生使用各自的账号登录。</p><form id="login-form"><label>账号<input name="username" autocomplete="username" required maxlength="32" placeholder="请输入账号"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"></label><p class="form-error" id="login-error" role="alert"></p><button class="button full" type="submit">登录 →</button></form><p class="login-help">学生账号由老师创建。<br>如果忘记密码，请联系老师。</p></section></main>`;
}
function pageTitle(eyebrow, title, detail, extra = '') {
  return `<div class="page-title"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="muted">${detail}</p></div>${extra}</div>`;
}
const categoryNames = {
  'add-sub-20': '20 以内加减', 'mul-div-20': '20 以内乘除', 'mixed-100': '100 以内混合运算'
};
function assignmentSummary(a) {
  return `${categoryNames[a.category]} · ${a.questions.length} 题`;
}
function teacherHome() {
  return `${pageTitle('教师工作台', '每一份练习，都看得见', `全班 ${state.students.length} 名学生 · 已发布 ${state.assignments.length} 份作业`, '<button class="button secondary" data-action="refresh">刷新成绩 ↻</button>')}
    <div class="teacher-layout"><section><div class="section-heading"><h2>班级作业</h2><span class="muted">最新发布在前</span></div>
    ${state.assignments.length ? `<div class="assignment-list">${state.assignments.map(a => `<a class="assignment-card" href="#/assignment/${a.id}"><div class="card-top"><span class="eyebrow">${assignmentSummary(a)}</span><span class="arrow">↗</span></div><h3>${esc(a.title)}</h3><p class="muted">发布于 ${date(a.createdAt)}</p><div class="card-stats"><div><strong>${a.submitted}<small> / ${a.total}</small></strong><span>已交人数</span></div><div><strong>${a.pending}</strong><span>未交人数</span></div><div><strong>${a.average ?? '—'}</strong><span>平均分</span></div></div></a>`).join('')}</div>` : '<div class="empty"><span class="empty-symbol">＋ −</span><h3>从第一份练习开始</h3><p>在右侧填写名称，发布全班的十道计算题。</p></div>'}</section>
    <aside class="panel publish-panel"><span class="eyebrow">一份小练习</span><h2>发布新作业</h2><p class="muted">自动生成 5 道加法和 5 道减法，答案均在 0–20 以内。</p><form id="publish-form"><label>作业名称<input name="title" required maxlength="60" placeholder="例如：周三计算小练习"></label><div class="paper-spec"><span>题目数量<strong>10 题</strong></span><span>每题分值<strong>10 分</strong></span><span>面向学生<strong>全班学生</strong></span></div><p class="form-error" id="publish-error" role="alert"></p><button type="submit" class="button full">发布作业 ＋</button></form><p class="small muted">发布后学生即可开始作答。新加入的学生也能看到历史作业。</p></aside></div>`;
}
function studentsView() {
  return `${pageTitle('班级管理', '把同学们加进来', '创建账号后，将账号和密码告知对应学生。')}
    <div class="teacher-layout"><section class="panel"><div class="section-heading"><h2>学生名单</h2><span class="badge">${state.students.length} 人</span></div>${state.students.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">姓名</th><th scope="col">登录账号</th></tr></thead><tbody>${state.students.map(s => `<tr><td><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}</td><td class="mono">${esc(s.username)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>还没有学生</h3><p>先创建一个学生账号，再体验作业流程。</p></div>'}</section>
    <aside class="panel"><span class="eyebrow">加入班级</span><h2>创建学生账号</h2><form id="student-form"><label>学生姓名<input name="name" required maxlength="30" autocomplete="off" placeholder="例如：小雨"></label><label>登录账号<input name="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_-]+" autocomplete="off" placeholder="例如：student03"><small>3–32 位字母、数字、下划线或短横线</small></label><label>初始密码<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="至少 8 个字符"><small>请自行记录并告知学生。</small></label><p class="form-error" id="student-error" role="alert"></p><button type="submit" class="button full">创建学生账号</button></form></aside></div>`;
}
function reportView(a) {
  return `<a class="back-link" href="#/">← 返回班级作业</a>${pageTitle('作业成绩', esc(a.title), `${assignmentSummary(a)} · 满分 100 分 · ${date(a.createdAt)} 发布`, '<button class="button secondary" data-action="refresh">刷新成绩 ↻</button>')}
    <div class="report-stats"><div><span>已交人数</span><strong>${a.submitted}<small> / ${a.total} 人</small></strong></div><div><span>未交人数</span><strong>${a.pending}<small> 人</small></strong></div><div><span>班级平均分</span><strong>${a.average ?? '—'}<small>${a.average === null ? ' 暂无提交' : ' 分'}</small></strong></div></div>
    <section class="panel"><div class="section-heading"><h2>每位同学的进度</h2><span class="muted small">平均分仅计算已提交学生</span></div><div class="table-wrap"><table><thead><tr><th scope="col">学生</th><th scope="col">账号</th><th scope="col">作业状态</th><th scope="col">提交时间</th><th scope="col">成绩 / 100</th></tr></thead><tbody>${a.students.map(s => `<tr><td><span class="avatar">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}</td><td class="mono">${esc(s.username)}</td><td>${badge(s)}</td><td>${date(s.submittedAt)}</td><td class="score-cell">${s.score ?? '—'}</td></tr>`).join('') || '<tr><td colspan="5">还没有学生，请前往学生名单创建账号。</td></tr>'}</tbody></table></div></section><details class="panel questions-details"><summary>查看本次题目（10 题）</summary><div class="question-preview">${a.expressions.map((expression, i) => `<span>${i + 1}.　${esc(expression)} = ?</span>`).join('')}</div></details>`;
}
function studentHome() {
  const pending = state.assignments.filter(a => !a.submittedAt).length;
  return `${pageTitle('我的作业本', `${esc(state.user.name)}，今天也加油！`, pending ? `还有 ${pending} 份练习等你完成。准备好，就开始吧。` : state.assignments.length ? '所有作业都完成了，可以打开看看批改结果。' : '老师发布作业后，就会出现在这里。')}
    <section class="student-grid">${state.assignments.map(a => `<a class="assignment-card student-card" href="#/assignment/${a.id}"><div class="card-top">${badge(a)}<span class="muted small">${date(a.createdAt)}</span></div><h2>${esc(a.title)}</h2><p class="muted">${assignmentSummary(a)} · 满分 100 分</p><div class="student-card-bottom">${a.submittedAt ? `<strong class="result-score">${a.score}<small> 分</small></strong><span>查看批改 →</span>` : `<span>${a.savedAt ? `上次已保存 ${a.answers.filter(v => v !== null).length}/10 题` : '认真想一想，再写下答案'}</span><strong>${a.savedAt ? '继续作答' : '开始作答'} →</strong>`}</div></a>`).join('') || '<div class="empty panel"><span class="empty-symbol">＋ −</span><h2>作业本还是空的</h2><p>稍后再来看看吧。</p><button class="button secondary" data-action="refresh">刷新作业</button></div>'}</section>`;
}
function workbook(a) {
  const done = !!a.submittedAt;
  const count = a.answers.filter(v => v !== null).length;
  return `<a class="back-link" href="#/">← 返回我的作业</a><div class="workbook-heading">${pageTitle(done ? '练习完成' : '专心算一算', esc(a.title), `${assignmentSummary(a)} · 每题 10 分 · 答案是 0–${a.answerMax} 的整数`)}${done ? `<div class="score-stamp"><strong>${a.score}</strong><span>/ 100 分</span></div>` : ''}</div>
    ${done ? `<div class="result-banner"><strong>${a.score === 100 ? '全部答对，真棒！' : `答对了 ${a.score / 10} 道题，再看看需要订正的地方。`}</strong><span>${date(a.submittedAt)} 提交 · 已自动批改</span></div>` : `<div class="progress-heading"><span id="progress-label">已作答 ${count} / 10 题</span><span id="save-state" class="muted">${a.savedAt ? `草稿保存于 ${date(a.savedAt)}` : '写好几题后，可以先保存草稿。'}</span></div><progress id="progress" max="10" value="${count}" aria-label="作答进度"></progress>`}
    <form id="answer-form"><fieldset ${done ? 'disabled' : ''}><legend class="sr-only">十道计算题</legend><div class="question-grid">${a.expressions.map((expression, i) => `<div class="question ${done ? (a.results[i].correct ? 'correct' : 'incorrect') : ''}"><span class="question-number">第 ${i + 1} 题</span><div class="equation"><label for="answer-${i}"><span class="sr-only">第 ${i + 1} 题：</span>${esc(expression)} <span class="operator">＝</span></label><input id="answer-${i}" name="answer-${i}" type="number" min="0" max="${a.answerMax}" step="1" inputmode="numeric" autocomplete="off" aria-label="第 ${i + 1} 题答案" value="${esc(a.answers[i])}" ${done ? 'readonly' : ''}></div>${done ? `<div class="question-feedback">${a.results[i].correct ? '✓ 答对了' : `✕ 正确答案：${a.results[i].correctAnswer}`}</div>` : ''}</div>`).join('')}</div></fieldset>
    ${done ? '<div class="actions result-actions"><a class="button secondary" href="#/">返回我的作业</a><span class="muted">作业已提交，答案不能再修改。</span></div>' : `<div class="answer-actions"><div><strong>慢慢算，认真检查。</strong><p class="small muted">保存草稿后，下次登录可以接着写。</p></div><div class="actions"><button type="button" class="button secondary" data-action="save">保存草稿</button><button type="submit" class="button">提交作业 →</button></div></div><p id="answer-error" class="form-error" role="alert"></p>`}</form>`;
}
function render() {
  let view;
  if (!state.user) view = loginView();
  else if (state.loading) view = '<p class="loading">正在打开作业本…</p>';
  else if (state.loadError) view = `<section class="empty panel"><h2>作业本暂时没有打开</h2><p>${esc(state.loadError)}</p><button class="button" data-action="refresh">重新加载</button><p><a href="#/">返回作业列表</a></p></section>`;
  else if (location.hash === '#/students' && state.user.role === 'teacher') view = studentsView();
  else if (state.assignment) view = state.user.role === 'teacher' ? reportView(state.assignment) : workbook(state.assignment);
  else view = state.user.role === 'teacher' ? teacherHome() : studentHome();
  root.innerHTML = `${header()}${state.user ? `<main class="main">${view}</main>` : view}<footer>小小算术 <span>·</span> 每天进步一点点</footer>`;
}
async function load() {
  if (!state.user) { render(); return; }
  const epoch = ++loadEpoch;
  state.loading = true; state.loadError = ''; state.assignment = null; render();
  try {
    const match = location.hash.match(/^#\/assignment\/([1-9]\d*)$/);
    if (match) {
      const a = await api(`/assignments/${match[1]}`);
      if (epoch !== loadEpoch) return; state.assignment = a;
    } else if (state.user.role === 'teacher') {
      const [assignments, students] = await Promise.all([api('/assignments'), api('/students')]);
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
  if (form.id === 'login-form') await formAction(form, 'login-error', async data => {
    state.user = await api('/login', 'POST', data); state.dirty = false; state.assignments = []; state.students = []; state.assignment = null;
    history.replaceState(null, '', '#/'); await load();
  });
  if (form.id === 'publish-form') await formAction(form, 'publish-error', async data => {
    const a = await api('/assignments', 'POST', data); toast('作业已发布，全班学生可以开始作答。');
    location.hash = `#/assignment/${a.id}`;
  });
  if (form.id === 'student-form') await formAction(form, 'student-error', async data => {
    const student = await api('/students', 'POST', data); await load(); toast(`已创建 ${student.name} 的账号：${student.username}`);
  });
  if (form.id === 'answer-form' && !state.busy) dialog.showModal();
});
async function saveAnswers(submit = false) {
  if (state.busy || !state.assignment || state.assignment.submittedAt) return;
  const form = document.querySelector('#answer-form');
  if (!form.reportValidity()) return;
  const answers = Array.from({ length: 10 }, (_, i) => {
    const value = form.elements[`answer-${i}`].value; return value === '' ? null : Number(value);
  });
  if (submit && answers.includes(null)) { errorAt('answer-error', '还有题目未作答，请完成全部 10 题再提交。'); document.querySelector(`#answer-${answers.indexOf(null)}`).focus(); return; }
  state.busy = true;
  const fieldset = form.querySelector('fieldset'); fieldset.disabled = true;
  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  errorAt('answer-error', '');
  try {
    state.assignment = await api(`/assignments/${state.assignment.id}/${submit ? 'submit' : 'draft'}`, submit ? 'POST' : 'PUT', { answers });
    state.dirty = false; render(); toast(submit ? '作业已提交，批改结果出来啦！' : '草稿已保存，下次可以接着写。');
  } catch (e) { errorAt('answer-error', e.message); }
  finally { state.busy = false; fieldset.disabled = false; form.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
root.addEventListener('input', event => {
  if (event.target.closest('#answer-form')) {
    state.dirty = true;
    const inputs = [...document.querySelectorAll('.equation input')];
    const count = inputs.filter(input => input.value !== '').length;
    document.querySelector('#progress').value = count;
    document.querySelector('#progress-label').textContent = `已作答 ${count} / 10 题`;
    document.querySelector('#save-state').textContent = '有未保存的修改';
  }
});
root.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (state.busy && (event.target.closest('a') || action)) { event.preventDefault(); return; }
  if (action === 'save') await saveAnswers();
  if (action === 'refresh') await load();
  if (action === 'logout') {
    if (state.dirty && !confirm('还有未保存的答案。确定退出并放弃这些修改吗？')) return;
    state.busy = true;
    try { await api('/logout', 'POST', {}); loadEpoch++; state.user = null; state.assignment = null; state.assignments = []; state.students = []; state.dirty = false; history.replaceState(null, '', '#/'); render(); }
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
  state.dirty = false; await load(); window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
try { state.user = await api('/me'); } catch (e) { if (!e.message.includes('请先登录')) toast(e.message, true); }
await load();
