import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createApp } from '../backend/app.mjs';
import { createWebServer } from '../frontend/server.mjs';
import { solution } from '../backend/store.mjs';
import { createHistoryClass, historyAssignments, studentPassword, teacherPassword } from './history-fixture.mjs';

const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../frontend/app.mjs', import.meta.url), 'utf8');
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function withPages(run, seed, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-ui-'));
  const dbPath = join(dir, 'ui.sqlite');
  if (seed) await seed(dbPath);
  const app = await createApp({ dbPath, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const web = createWebServer({ apiPort: app.server.address().port });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${web.address().port}`;
  const windows = [];
  async function page(session = { cookie: '' }, hash = '#/') {
    const dom = new JSDOM(html, { url: base + '/' + hash, runScripts: 'outside-only' });
    const w = dom.window; windows.push(w);
    if (session.now) w.Date.now = session.now;
    if (session.monotonic) w.performance.now = session.monotonic;
    w.scrollTo = () => {};
    w.confirm = () => true;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    w.fetch = async (path, options = {}) => {
      if (session.failPath && String(path).includes(session.failPath)) throw new Error('模拟断网');
      const response = await fetch(new URL(path, base), { ...options, headers: {
        ...options.headers, Origin: base, ...(session.cookie ? { Cookie: session.cookie } : {})
      } });
      const cookie = response.headers.get('set-cookie');
      if (cookie) session.cookie = cookie.split(';')[0];
      return response;
    };
    await w.eval(`(async () => { ${source}\n })()`);
    return { w, d: w.document, session,
      fill(name, value) { const input = w.document.querySelector(`[name="${name}"]`); assert.ok(input, name); input.value = String(value); input.dispatchEvent(new w.Event('input', { bubbles: true })); },
      submit(id) { w.document.getElementById(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
      click(selector) { const node = w.document.querySelector(selector); assert.ok(node, selector); node.click(); },
      async route(hash) { w.location.hash = hash; await waitFor(() => !w.document.querySelector('.loading'), '切换页面'); }
    };
  }
  async function login(p, username, password) {
    p.fill('username', username); p.fill('password', password); p.submit('login-form');
    await waitFor(() => p.d.querySelector('[data-action="logout"]') && !p.d.querySelector('.loading'), '登录');
  }
  try { await run({ app, base, page, login }); }
  finally {
    windows.forEach(w => w.close());
    web.closeAllConnections(); app.server.closeAllConnections();
    await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => app.server.close(resolve))]);
    app.db.close(); await rm(dir, { recursive: true, force: true });
  }
}
test('页面表单经独立前端代理完成师生全流程（DOM 环境，无视觉渲染）', async t => {
  await withPages(async ({ app, base, page, login }) => {
    let teacher, student, other, id;
    await t.test('静态资源、代理、CSP 和路径隔离', async () => {
      for (const path of ['/', '/app.mjs', '/style.css']) {
        const response = await fetch(base + path); assert.equal(response.status, 200);
        assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
      }
      assert.equal((await fetch(base + '/backend/store.mjs')).status, 404);
      assert.equal((await fetch(base + '/api/health')).status, 200);
      assert.equal((await fetch(base + '/api/students')).status, 401);
    });
    await t.test('教师登录错误提示、创建学生、重复账号错误与发布', async () => {
      teacher = await page();
      teacher.fill('username', 'teacher'); teacher.fill('password', 'wrong'); teacher.submit('login-form');
      await waitFor(() => teacher.d.querySelector('#login-error').textContent.includes('不正确'), '登录错误');
      await login(teacher, 'teacher', 'Teacher123!');
      teacher.click('a[href="#/students"]');
      await waitFor(() => teacher.d.querySelector('#student-form'), '学生名单');
      for (const [username, name] of [['ui01', '小雨 <b>'], ['ui02', '小明']]) {
        teacher.fill('name', name); teacher.fill('username', username); teacher.fill('password', 'Student123!'); teacher.submit('student-form');
        await waitFor(() => teacher.d.querySelector('tbody')?.textContent.includes(username), '创建学生');
      }
      assert.ok(teacher.d.querySelector('tbody').textContent.includes('小雨 <b>'));
      assert.equal(teacher.d.querySelector('tbody b'), null);
      teacher.fill('name', '重复'); teacher.fill('username', 'ui01'); teacher.fill('password', 'Student123!'); teacher.submit('student-form');
      await waitFor(() => teacher.d.querySelector('#student-error').textContent.includes('已存在'), '重名错误');
      teacher.click('nav a[href="#/"]');
      await waitFor(() => teacher.d.querySelector('#publish-form'), '作业页');
      teacher.fill('title', '周三练习 <script>'); teacher.submit('publish-form');
      await waitFor(() => teacher.d.querySelector('.report-stats'), '发布作业');
      assert.equal(teacher.d.querySelector('h1').textContent, '周三练习 <script>');
      assert.equal(teacher.d.querySelectorAll('tbody tr').length, 2);
      id = Number(teacher.w.location.hash.split('/').at(-1));
    });
    await t.test('学生保存、断网重试、未保存离开保护与刷新恢复', async () => {
      student = await page(); await login(student, 'ui01', 'Student123!');
      assert.equal(student.d.querySelector('a[href="#/students"]'), null);
      student.click('.student-card');
      await waitFor(() => student.d.querySelector('#answer-form'), '打开作业');
      student.fill('answer-0', 21);
      assert.equal(student.d.querySelector('#answer-0').validity.rangeOverflow, true);
      student.fill('answer-0', 4);
      assert.equal(student.d.querySelector('#progress').value, 1);
      student.w.confirm = () => false;
      student.click('.back-link');
      await waitFor(() => student.w.location.hash === `#/assignment/${id}`, '取消离开');
      assert.equal(student.d.querySelector('#answer-0').value, '4');
      student.session.failPath = '/draft'; student.click('[data-action="save"]');
      await waitFor(() => student.d.querySelector('#answer-error').textContent.includes('连接失败'), '断网保存提示');
      assert.equal(student.d.querySelector('#answer-0').value, '4');
      assert.equal(student.d.querySelector('#answer-0').disabled, false);
      student.session.failPath = ''; student.click('[data-action="save"]');
      await waitFor(() => student.d.querySelector('#save-state').textContent.includes('草稿保存于'), '保存草稿');
      const session = student.session;
      student.w.close(); student = await page(session, `#/assignment/${id}`);
      assert.equal(student.d.querySelector('#answer-0').value, '4');
      assert.equal(student.d.querySelector('#answer-1').value, '');
      other = await page(); await login(other, 'ui02', 'Student123!'); other.click('.student-card');
      await waitFor(() => other.d.querySelector('#answer-form'), '另一学生打开作业');
      assert.equal(other.d.querySelector('#answer-0').value, '');
    });
    await t.test('未完成拦截、确认提交、逐题反馈及教师统计刷新', async () => {
      student.submit('answer-form'); assert.equal(student.d.querySelector('dialog').open, true);
      student.click('#confirm-submit');
      await waitFor(() => student.d.querySelector('#answer-error').textContent.includes('未作答'), '未完成拦截');
      const questions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions);
      questions.forEach((q, i) => student.fill(`answer-${i}`, i === 0 ? (solution(q) + 1) % 21 : solution(q)));
      student.submit('answer-form'); student.click('#cancel-submit');
      assert.equal(student.d.querySelector('dialog').open, false);
      student.submit('answer-form'); student.click('#confirm-submit');
      await waitFor(() => student.d.querySelector('.score-stamp'), '批改结果');
      assert.equal(student.d.querySelector('.score-stamp strong').textContent, '90');
      assert.equal(student.d.querySelectorAll('.incorrect').length, 1);
      assert.equal(student.d.querySelectorAll('.correct').length, 9);
      assert.equal(student.d.querySelector('[data-action="save"]'), null);
      teacher.click('[data-action="refresh"]');
      await waitFor(() => teacher.d.querySelector('.score-cell')?.textContent === '90', '教师刷新成绩');
      assert.deepEqual([...teacher.d.querySelectorAll('.report-stats strong')].map(n => n.firstChild.textContent), ['1', '1', '90']);
      student.click('[data-action="logout"]');
      await waitFor(() => student.d.querySelector('#login-form'), '退出');
      await login(student, 'ui02', 'Student123!');
      assert.ok(!student.d.querySelector('.student-card').textContent.includes('90'));
    });
    await t.test('页面加载失败显示重试，避免残留上个账号成绩', async () => {
      student.click('[data-action="logout"]'); await waitFor(() => student.d.querySelector('#login-form'), '退出');
      student.session.failPath = '/assignments';
      await login(student, 'ui01', 'Student123!');
      assert.ok(student.d.querySelector('h2').textContent.includes('暂时没有打开'));
      assert.equal(student.d.querySelector('.student-card'), null);
      student.session.failPath = ''; student.click('[data-action="refresh"]');
      await waitFor(() => student.d.querySelector('.student-card'), '加载重试');
      assert.ok(student.d.querySelector('.student-card').textContent.includes('90'));
    });
  });
});

test('发布自选题型和题量，20 题续做草稿后答对 19 题显示 95 分', async () => {
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    assert.deepEqual([...teacher.d.querySelector('[name="category"]').options].map(o => o.value), ['add-sub-20', 'mul-div-20', 'mixed-100']);
    assert.deepEqual([...teacher.d.querySelector('[name="questionCount"]').options].map(o => o.value), ['10', '20', '50']);
    app.db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT 'pupil','学生',password_hash,'student' FROM users WHERE role='teacher'").run();
    for (const [category, count] of [['mul-div-20', 20], ['mixed-100', 50]]) {
      teacher.fill('title', '自选练习'); teacher.fill('category', category); teacher.fill('questionCount', count); teacher.submit('publish-form');
      await waitFor(() => teacher.d.querySelector('.report-stats'), '发布自选练习');
      assert.ok(teacher.d.querySelector('summary').textContent.includes(`${count} 题`));
      assert.equal(teacher.d.querySelectorAll('.question-preview span').length, count);
      const id = Number(teacher.w.location.hash.split('/').at(-1));
      if (count === 20) {
        const student = await page(); await login(student, 'pupil', 'Teacher123!'); student.click('.student-card');
        await waitFor(() => student.d.querySelector('#answer-form'), '打开 20 题');
        assert.equal(student.d.querySelector('#progress').max, 20);
        const questions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions);
        questions.slice(0, 12).forEach((q, i) => student.fill(`answer-${i}`, solution(q)));
        assert.equal(student.d.querySelector('#progress-label').textContent, '已作答 12 / 20 题');
        student.click('[data-action="save"]');
        await waitFor(() => student.d.querySelector('#save-state').textContent.includes('草稿保存于'), '保存 12 题');
        const session = student.session; student.w.close();
        const resumed = await page(session, `#/assignment/${id}`);
        assert.equal(resumed.d.querySelectorAll('.equation input').length, 20);
        assert.equal(resumed.d.querySelector('#answer-11').value, String(solution(questions[11])));
        assert.equal(resumed.d.querySelector('#answer-12').value, '');
        questions.forEach((q, i) => resumed.fill(`answer-${i}`, i === 19 ? (solution(q) + 1) % 21 : solution(q)));
        resumed.submit('answer-form'); resumed.click('#confirm-submit');
        await waitFor(() => resumed.d.querySelector('.score-stamp'), '20 题批改');
        assert.equal(resumed.d.querySelector('.score-stamp strong').textContent, '95');
        assert.ok(resumed.d.querySelector('.result-banner').textContent.includes('19 / 20'));
        teacher.click('[data-action="refresh"]');
        await waitFor(() => teacher.d.querySelector('.score-cell')?.textContent === '95', '教师查看 95 分');
      }
      teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#publish-form'), '返回发布表单');
    }
  });
});

test('北京时间发布、页面到点保留答案、逾期存草稿和已交回看', async () => {
  const boundary = Date.parse('2026-11-24T12:00:00Z');
  let currentTime = boundary - 60_000;
  await withPages(async ({ app, page, login }) => {
    const teacher = await page({ cookie: '', now: () => currentTime }); await login(teacher, 'teacher', 'Teacher123!');
    assert.equal(teacher.d.querySelector('[name="dueAt"]').type, 'datetime-local');
    for (const username of ['early', 'late', 'stale']) app.db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT ?,?,password_hash,'student' FROM users WHERE role='teacher'").run(username, username);
    teacher.fill('title', '明晚八点前交'); teacher.fill('questionCount', 20);
    teacher.fill('dueAt', '2026-11-23T20:00'); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelector('#publish-error').textContent.includes('晚于当前时间'), '拒绝过去截止时间');
    teacher.fill('dueAt', '2026-11-24T20:00'); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelector('.report-stats'), '发布带截止时间作业');
    assert.ok(teacher.d.querySelector('.page-title p').textContent.includes('20:00（北京时间）'));
    const id = Number(teacher.w.location.hash.split('/').at(-1));
    assert.equal(app.db.prepare('SELECT due_at FROM assignments WHERE id=?').get(id).due_at, '2026-11-24T12:00:00.000Z');
    const questions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions);
    const early = await page({ cookie: '', now: () => currentTime }); await login(early, 'early', 'Teacher123!'); early.click('.student-card');
    await waitFor(() => early.d.querySelector('#answer-form'), '截止前打开作业');
    questions.forEach((q, i) => early.fill(`answer-${i}`, solution(q)));
    early.submit('answer-form'); early.click('#confirm-submit');
    await waitFor(() => early.d.querySelector('.score-stamp'), '提前提交');
    const late = await page({ cookie: '', now: () => currentTime }); await login(late, 'late', 'Teacher123!'); late.click('.student-card');
    await waitFor(() => late.d.querySelector('#answer-form'), '未交学生打开作业');
    questions.slice(0, 12).forEach((q, i) => late.fill(`answer-${i}`, solution(q)));
    late.submit('answer-form'); assert.equal(late.d.querySelector('dialog').open, true);
    const stale = await page({ cookie: '', now: () => boundary - 60_000 }); await login(stale, 'stale', 'Teacher123!'); stale.click('.student-card');
    await waitFor(() => stale.d.querySelector('#answer-form'), '时钟慢的学生打开作业');
    questions.forEach((q, i) => stale.fill(`answer-${i}`, solution(q)));
    currentTime = boundary;
    stale.submit('answer-form'); stale.click('#confirm-submit');
    await waitFor(() => stale.d.querySelector('#answer-error').textContent.includes('已截止'), '服务器拒绝逾期提交');
    assert.equal(stale.d.querySelector('[data-submit]').disabled, true);
    assert.equal(stale.d.querySelector('#answer-19').value, String(solution(questions[19])));
    await waitFor(() => late.d.querySelector('[data-submit]').disabled, '页面到点禁用提交');
    assert.equal(late.d.querySelector('dialog').open, false);
    assert.equal(late.d.querySelector('#deadline-state').hidden, false);
    assert.equal(late.d.querySelector('#answer-11').value, String(solution(questions[11])));
    assert.equal(late.d.querySelector('#answer-12').disabled, false);
    late.session.failPath = '/draft'; late.click('[data-action="save"]');
    await waitFor(() => late.d.querySelector('#answer-error').textContent.includes('连接失败'), '逾期断网草稿重试');
    assert.equal(late.d.querySelector('[data-submit]').disabled, true);
    late.session.failPath = ''; late.click('[data-action="save"]');
    await waitFor(() => late.d.querySelector('#save-state').textContent.includes('草稿保存于'), '逾期保存草稿');
    const session = late.session; late.w.close();
    const resumed = await page(session, `#/assignment/${id}`);
    assert.equal(resumed.d.querySelector('#answer-11').value, String(solution(questions[11])));
    assert.equal(resumed.d.querySelector('[data-submit]').disabled, true);
    assert.ok(resumed.d.querySelector('#deadline-state').textContent.includes('老师处计为未交'));
    teacher.click('[data-action="refresh"]');
    await waitFor(() => teacher.d.querySelector('.badge.overdue'), '教师刷新逾期状态');
    assert.deepEqual([...teacher.d.querySelectorAll('.report-stats strong')].map(n => n.firstChild.textContent), ['1', '2', '100']);
    const earlySession = early.session; early.w.close();
    const graded = await page(earlySession, `#/assignment/${id}`);
    assert.equal(graded.d.querySelector('.score-stamp strong').textContent, '100');
    assert.equal(graded.d.querySelectorAll('.correct').length, 20);
    assert.equal(graded.d.querySelector('[data-action="save"]'), null);
    resumed.click('.back-link'); await waitFor(() => resumed.d.querySelector('.student-card'), '回列表查看截止状态');
    assert.ok(resumed.d.querySelector('.badge').textContent.includes('已截止'));
    assert.ok(resumed.d.querySelector('.page-title p').textContent.includes('已截止未交'));
  }, undefined, { clock: () => currentTime });
});

test('名单文件上传、逐行反馈、刷新名单与前导零账号登录', async () => {
  await withPages(async ({ app, base, page, login }) => {
    app.db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    app.db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT 'old01','原学生',password_hash,'student',2 FROM users WHERE role='teacher'").run();
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!'); teacher.click('a[href="#/students"]');
    await waitFor(() => teacher.d.querySelector('#import-form'), '导入入口');
    const downloaded = await fetch(base + teacher.d.querySelector('a[download]').getAttribute('href'));
    assert.equal(downloaded.status, 200); assert.ok(downloaded.headers.get('content-type').includes('spreadsheetml'));
    const xlsx = await readFile(new URL('../frontend/student-roster-template.xlsx', import.meta.url));
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), xlsx);
    const attach = (name, data) => {
      Object.defineProperty(teacher.d.querySelector('[name="rosterFile"]'), 'files', { configurable: true, value: [new teacher.w.File([data], name)] });
    };
    attach('不支持.txt', '学号,姓名'); teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#import-error').textContent.includes('.xlsx'), '格式提示');
    const csv = '学号,姓名\n00123,张宁\n,没有学号\n00777,甲\n00777,乙\nold01,换名\n00124,张宁\n';
    attach('一班.csv', csv); teacher.session.failPath = '/students/import'; teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#import-error').textContent.includes('连接失败'), '导入断网提示');
    assert.equal(teacher.d.querySelector('[name="rosterFile"]').files[0].name, '一班.csv');
    teacher.session.failPath = ''; teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#import-result'), '显示导入结果');
    assert.match(teacher.d.querySelector('#import-result strong').textContent, /已导入 2 名，跳过 4 行/);
    assert.deepEqual([...teacher.d.querySelectorAll('#import-result tbody td:first-child')].map(n => n.textContent), ['第 3 行', '第 4 行', '第 5 行', '第 6 行']);
    const rows = teacher.d.querySelectorAll('#student-form'); assert.equal(rows.length, 1);
    assert.equal(app.db.prepare("SELECT class_id FROM users WHERE username='old01'").get().class_id, 2);
    assert.ok(teacher.d.querySelector('.teacher-layout tbody').textContent.includes('00123'));
    assert.ok(teacher.d.querySelector('.teacher-layout tbody').textContent.includes('00124'));
    const pupil = await page(); await login(pupil, '00123', '00123');
    assert.ok(pupil.d.querySelector('.user').textContent.includes('00123'));
    const chooser = teacher.d.querySelector('[name="currentClass"]'); chooser.value = '2'; chooser.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('h2')?.textContent === '批量导入到 二班', '导入切班');
    assert.equal(teacher.d.querySelector('#import-result'), null);
    attach('样例.xlsx', xlsx); teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#import-result'), '真实 Excel 上传');
    assert.match(teacher.d.querySelector('#import-result strong').textContent, /已导入 1 名，跳过 2 行/);
    assert.ok(teacher.d.querySelector('.teacher-layout tbody').textContent.includes('00125'));
    assert.ok(!teacher.d.querySelector('.teacher-layout tbody').textContent.includes('00123'));
  });
});

test('导入后按姓名和学号搜索当前班，换班不混入同名学生，清空恢复全班', async () => {
  await withPages(async ({ app, page, login }) => {
    app.db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    for (const [username, name] of [['10223', '张宁'], ['10224', '小林']]) app.db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',2 FROM users WHERE role='teacher'").run(username, name);
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!'); teacher.click('a[href="#/students"]');
    await waitFor(() => teacher.d.querySelector('#import-form'), '名单与搜索入口');
    const attach = data => Object.defineProperty(teacher.d.querySelector('[name="rosterFile"]'), 'files', { configurable: true, value: [new teacher.w.File([data], '名单.csv')] });
    attach('学号,姓名\n00123,张宁\n00124,张宁\n00125,李雪'); teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#import-result'), '导入核对名单');
    const ids = () => [...teacher.d.querySelectorAll('#student-list tbody tr td:nth-child(2)')].map(n => n.textContent);
    assert.deepEqual(ids(), ['00123', '00124', '00125']);
    attach('学号,姓名\n00999,王明');
    teacher.fill('studentSearch', '张宁'); assert.deepEqual(ids(), ['00123', '00124']);
    assert.equal(teacher.d.querySelector('#student-count').textContent, '2 / 3 人');
    assert.equal(teacher.d.querySelector('[name="rosterFile"]').files[0].name, '名单.csv');
    teacher.fill('studentSearch', '00123'); assert.deepEqual(ids(), ['00123']);
    teacher.fill('studentSearch', '  张宁  '); assert.deepEqual(ids(), ['00123', '00124']);
    teacher.fill('studentSearch', '<b>张宁</b>'); assert.equal(teacher.d.querySelector('#student-list b'), null);
    assert.ok(teacher.d.querySelector('#student-list').textContent.includes('没有找到匹配'));
    teacher.click('[data-action="clear-search"]'); assert.deepEqual(ids(), ['00123', '00124', '00125']);
    teacher.fill('studentSearch', '没有这个人'); teacher.submit('import-form');
    await waitFor(() => teacher.d.querySelector('#student-count')?.textContent === '4 / 4 人', '导入后显示全班便于核对');
    assert.equal(teacher.d.querySelector('[name="studentSearch"]').value, ''); assert.deepEqual(ids(), ['00123', '00124', '00125', '00999']);
    teacher.fill('studentSearch', '张宁');
    const select = teacher.d.querySelector('[name="currentClass"]'); select.value = '2'; select.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.value === '2' && !teacher.d.querySelector('.loading'), '搜索时换班');
    assert.equal(teacher.d.querySelector('[name="studentSearch"]').value, '张宁'); assert.deepEqual(ids(), ['10223']);
    assert.equal(teacher.d.querySelector('#student-count').textContent, '1 / 2 人');
    teacher.click('[data-action="clear-search"]'); assert.deepEqual(ids(), ['10223', '10224']);
    assert.equal(teacher.d.querySelector('#student-count').textContent, '2 / 2 人');
  });
});

test('班级页面建班分配学生、同卷发布和切班成绩互不混入', async () => {
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!'); teacher.click('a[href="#/students"]');
    await waitFor(() => teacher.d.querySelector('#class-form'), '班级管理');
    const changeClass = async id => {
      const select = teacher.d.querySelector('[name="currentClass"]'); select.value = String(id);
      select.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
      await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.value === String(id) && !teacher.d.querySelector('.loading'), '切换班级');
    };
    teacher.fill('renameClassName', '一班'); teacher.submit('rename-class-form');
    await waitFor(() => teacher.d.querySelector('[name="currentClass"]').textContent.includes('一班'), '原班级改名');
    teacher.fill('className', '二班'); teacher.submit('class-form');
    await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.value === '2', '创建二班');
    const createStudent = async (username, name) => {
      teacher.fill('name', name); teacher.fill('username', username); teacher.fill('password', 'Student123!'); teacher.submit('student-form');
      await waitFor(() => teacher.d.querySelector('tbody')?.textContent.includes(username), '建立本班学生');
    };
    await createStudent('zhou', '小周'); await changeClass(1); await createStudent('lin', '小林');
    teacher.click('nav a[href="#/"]'); await waitFor(() => teacher.d.querySelector('#publish-form'), '回发布页');
    teacher.fill('title', '只发一班'); teacher.submit('publish-form'); await waitFor(() => teacher.d.querySelector('.report-stats'), '单班发布');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#publish-form'), '再次发布');
    teacher.fill('title', '两个班同一套题'); teacher.fill('questionCount', 20); teacher.d.querySelector('[name="classIds"][value="2"]').checked = true; teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelector('.report-stats'), '双班发布');
    const id = Number(teacher.w.location.hash.split('/').at(-1));
    const questions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions);
    const pupils = [];
    for (const [username, expectedCount] of [['lin', 2], ['zhou', 1]]) {
      const p = await page(); await login(p, username, 'Student123!'); assert.equal(p.d.querySelectorAll('.student-card').length, expectedCount);
      p.click(`a[href="#/assignment/${id}"]`); await waitFor(() => p.d.querySelector('#answer-form'), '学生答同卷');
      questions.forEach((q, i) => p.fill(`answer-${i}`, username === 'lin' && i === 0 ? (solution(q) + 1) % 21 : solution(q)));
      p.submit('answer-form'); p.click('#confirm-submit'); await waitFor(() => p.d.querySelector('.score-stamp'), '学生提交同卷'); pupils.push(p);
    }
    teacher.click('[data-action="refresh"]'); await waitFor(() => teacher.d.querySelector('.score-cell')?.textContent === '95', '一班成绩');
    assert.ok(teacher.d.querySelector('tbody').textContent.includes('小林')); assert.ok(!teacher.d.querySelector('tbody').textContent.includes('小周'));
    await changeClass(2);
    assert.equal(teacher.d.querySelector('.score-cell').textContent, '100');
    assert.ok(teacher.d.querySelector('tbody').textContent.includes('小周')); assert.ok(!teacher.d.querySelector('tbody').textContent.includes('小林'));
    assert.deepEqual([...teacher.d.querySelectorAll('.report-stats strong')].map(n => n.firstChild.textContent), ['1', '0', '100']);
  });
});

test('混合练习表单按年级选择知识点与提高难度', async () => {
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    assert.equal(teacher.d.querySelector('#practice-fields').hidden, true);
    teacher.fill('category', 'mixed-100'); assert.equal(teacher.d.querySelector('#practice-fields').hidden, false);
    teacher.fill('grade', 1);
    assert.equal(teacher.d.querySelector('input[value="parentheses"]').disabled, true);
    assert.equal(teacher.d.querySelector('input[value="add-sub-chain"]').checked, true);
    teacher.fill('grade', 3);
    for (const checkbox of teacher.d.querySelectorAll('[name="knowledgePoints"]')) checkbox.checked = checkbox.value === 'parentheses';
    teacher.fill('difficulty', 'advanced'); teacher.fill('title', '三年级提高括号'); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelector('.report-stats'), '发布提高题');
    assert.ok(teacher.d.querySelector('.page-title p').textContent.includes('3 年级 · 提高'));
    const row = app.db.prepare('SELECT difficulty,mixed_grade,knowledge_points FROM assignments').get();
    assert.equal(row.difficulty, 'advanced'); assert.equal(row.mixed_grade, 3); assert.equal(row.knowledge_points, '["parentheses"]');
    for (const item of teacher.d.querySelectorAll('.question-preview span')) assert.ok(item.textContent.includes('('));
  });
});

test('个人限时页面：开始后倒计时、刷新续计、到时保留答案与保存草稿', async () => {
  let current = Date.parse('2026-11-24T11:00:00Z');
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    app.db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT 'timed','计时学生',password_hash,'student' FROM users WHERE role='teacher'").run();
    teacher.fill('title', '20分钟练习'); teacher.fill('timeLimitMinutes', 20); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelector('.report-stats'), '发布限时作业');
    let pupil = await page({ cookie: '', monotonic: () => current }); await login(pupil, 'timed', 'Teacher123!'); pupil.click('.student-card');
    await waitFor(() => pupil.d.querySelector('[data-action="start"]'), '打开开始说明');
    assert.equal(pupil.d.querySelector('#answer-form'), null);
    pupil.click('[data-action="start"]');
    await waitFor(() => pupil.d.querySelector('#countdown'), '开始倒计时');
    assert.ok(pupil.d.querySelector('#countdown').textContent.includes('20 分 00 秒'));
    pupil.fill('answer-0', 7); pupil.click('[data-action="save"]');
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.includes('草稿保存于'), '保存限时草稿');
    const session = pupil.session, hash = pupil.w.location.hash; pupil.w.close();
    current += 5 * 60_000; pupil = await page(session, hash);
    assert.ok(pupil.d.querySelector('#countdown').textContent.includes('15 分 00 秒'));
    assert.equal(pupil.d.querySelector('#answer-0').value, '7');
    pupil.fill('answer-1', 9); current += 15 * 60_000;
    await waitFor(() => pupil.d.querySelector('[data-submit]').disabled, '个人到时禁交');
    assert.equal(pupil.d.querySelector('#answer-1').value, '9');
    pupil.click('[data-action="save"]');
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.includes('草稿保存于'), '个人到时仍可存草稿');
    assert.equal(pupil.d.querySelector('.score-stamp'), null);
  }, undefined, { clock: () => current });
});

test('INC-001 师生页面显示历史算式、续做混合草稿并回看批改', async () => {
  await withPages(async ({ page, login }) => {
    const teacher = await page(), pupil = await page();
    await login(teacher, 'teacher', teacherPassword);
    await login(pupil, 'pupil4', studentPassword);
    const card = id => `.assignment-card[href="#/assignment/${id}"]`;
    for (const p of [teacher, pupil]) {
      for (const [id, label] of [[11, '20 以内加减'], [22, '20 以内乘除'], [33, '100 以内混合运算']]) {
        assert.ok(p.d.querySelector(card(id)).textContent.includes(label));
      }
    }
    teacher.click(card(22));
    await waitFor(() => teacher.d.querySelector('.question-preview'), '教师查看乘除题');
    const productPreview = teacher.d.querySelectorAll('.question-preview span');
    assert.ok(productPreview[0].textContent.includes('2 × 1')); assert.ok(productPreview[1].textContent.includes('18 ÷ 3'));
    const graded = await page(); await login(graded, 'pupil3', studentPassword);
    graded.click(card(22));
    await waitFor(() => graded.d.querySelector('.score-stamp'), '学生回看已批乘除题');
    assert.ok(graded.d.querySelector('.equation label').textContent.includes('2 × 1'));
    assert.ok(graded.d.querySelector('.question-feedback').textContent.includes('正确答案：2'));
    assert.equal(graded.d.querySelector('.score-stamp strong').textContent, '80');
    assert.equal(graded.d.querySelector('fieldset').disabled, true);

    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector(card(33)), '返回教师列表');
    teacher.click(card(33)); pupil.click(card(33));
    await waitFor(() => teacher.d.querySelector('.question-preview') && pupil.d.querySelector('#answer-form'), '师生打开混合题');
    assert.ok(teacher.d.querySelector('.page-title p').textContent.includes('100 以内混合运算'));
    assert.ok(pupil.d.querySelector('.page-title p').textContent.includes('答案是 0–100 的整数'));
    const preview = teacher.d.querySelectorAll('.question-preview span');
    const labels = pupil.d.querySelectorAll('.equation label');
    for (const [i, expected] of [[1, '18 − (7 − 2)'], [2, '24 ÷ (12 ÷ 3)'], [4, '(6 ＋ 3) × 4'], [8, '60 ÷ (5 − 2)']]) {
      assert.ok(preview[i].textContent.includes(expected)); assert.ok(labels[i].textContent.includes(expected));
    }
    assert.equal(pupil.d.querySelector('#answer-1').value, '13');
    assert.equal(pupil.d.querySelector('#answer-0').value, '');
    pupil.fill('answer-0', 101); assert.equal(pupil.d.querySelector('#answer-form').checkValidity(), false);
    pupil.fill('answer-0', 27); assert.equal(pupil.d.querySelector('#answer-form').checkValidity(), true);
    pupil.click('[data-action="save"]');
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.includes('草稿保存于'), '保存 27');
    pupil.w.close();
    const resumed = await page(pupil.session, '#/assignment/33');
    assert.equal(resumed.d.querySelector('#answer-0').value, '27');
    assert.equal(resumed.d.querySelector('#answer-1').value, '13');
    assert.equal(resumed.d.querySelector('#answer-2').value, '');
    historyAssignments[2].key.forEach((value, i) => resumed.fill(`answer-${i}`, i === 1 ? 17 : value));
    resumed.submit('answer-form'); resumed.click('#confirm-submit');
    await waitFor(() => resumed.d.querySelector('.score-stamp'), '混合运算批改');
    assert.equal(resumed.d.querySelector('.score-stamp strong').textContent, '90');
    assert.equal(resumed.d.querySelectorAll('.question.correct').length, 9);
    assert.ok(resumed.d.querySelector('.incorrect .question-feedback').textContent.includes('正确答案：13'));
    assert.equal(resumed.d.querySelector('[data-action="save"]'), null);
    teacher.click('[data-action="refresh"]');
    await waitFor(() => teacher.d.querySelectorAll('.score-cell')[2]?.textContent === '90', '教师查看新增成绩');
    assert.deepEqual([...teacher.d.querySelectorAll('.score-cell')].map(el => el.textContent), ['80', '70', '90']);
    assert.ok(teacher.d.querySelector('.report-stats div:last-child strong').textContent.startsWith('80'));
  }, createHistoryClass);
});
