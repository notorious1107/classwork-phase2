import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createApp } from '../backend/app.mjs';
import { createWebServer } from '../frontend/server.mjs';
import { solution, publishAssignment } from '../backend/store.mjs';
import { createHistoryClass, historyAssignments, studentPassword, teacherPassword } from './history-fixture.mjs';
import { seedCorrections } from './correction-fixture.mjs';
import { legacyPreviewClass, legacyPreviewSchemas } from './preview-fixture.mjs';
import { seedAnalytics } from './analytics-fixture.mjs';
import { createRevisionClass } from './learning-fixture.mjs';

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
  async function page(session = { cookie: '' }, hash = '#/', storage = {}) {
    const dom = new JSDOM(html, { url: base + '/' + hash, runScripts: 'outside-only' });
    const w = dom.window; windows.push(w);
    for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
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
      async publish() {
        w.document.getElementById('publish-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(() => w.document.querySelector('#assignment-preview [data-action="confirm-preview"]:not(:disabled)'), '生成预览');
        w.document.querySelector('[data-action="confirm-preview"]').click();
        await waitFor(() => w.document.querySelector('.report-stats'), '确认发布');
      },
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
      teacher.fill('title', '周三练习 <script>'); await teacher.publish();
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
    await t.test('未完成提示可返回补答、确认提交、逐题反馈及教师统计刷新', async () => {
      student.submit('answer-form'); assert.equal(student.d.querySelector('dialog').open, true);
      assert.ok(student.d.querySelector('#submit-missing').textContent.includes('9 题没答'));
      student.click('#cancel-submit'); assert.equal(student.d.querySelector('dialog').open, false);
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
    assert.deepEqual([...teacher.d.querySelector('[name="category"]').options].map(o => o.value), ['add-sub-20', 'mul-div-20', 'mixed-100', 'composite']);
    assert.deepEqual([...teacher.d.querySelector('[name="questionCount"]').options].map(o => o.value), ['10', '20', '50']);
    app.db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT 'pupil','学生',password_hash,'student' FROM users WHERE role='teacher'").run();
    for (const [category, count] of [['mul-div-20', 20], ['mixed-100', 50]]) {
      teacher.fill('title', '自选练习'); teacher.fill('category', category); teacher.fill('questionCount', count); await teacher.publish();
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
    teacher.fill('dueAt', '2026-11-24T20:00'); await teacher.publish();
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

test('教师整卷预览、换卷、修改重看与综合练习最后题序一致，学生一卷草稿和95分', async () => {
  await withPages(async ({ app, page, login }) => {
    app.db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    for (const [username, classId] of [['pupil', 1], ['zhou', 2]]) app.db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',? FROM users WHERE role='teacher'").run(username, username, classId);
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    const pupil = await page(); await login(pupil, 'pupil', 'Teacher123!');
    teacher.fill('title', '三类综合 <b>'); teacher.fill('category', 'composite'); teacher.fill('questionCount', 20); teacher.fill('difficulty', 'advanced');
    assert.equal(teacher.d.querySelector('#composite-fields').hidden, false); assert.equal(teacher.d.querySelector('#practice-fields').hidden, false);
    teacher.d.querySelector('[name="classIds"][value="2"]').checked = true;
    teacher.submit('publish-form'); await waitFor(() => teacher.d.querySelector('#assignment-preview'), '先预览未发布');
    assert.equal(teacher.d.querySelectorAll('.preview-questions li').length, 20); assert.equal(teacher.d.querySelector('#preview-title b'), null);
    assert.deepEqual([...teacher.d.querySelectorAll('[data-preview-category]')].map(el => el.textContent.match(/\d+ 题$/)[0]), ['7 题', '7 题', '6 题']);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 0);
    pupil.click('[data-action="refresh"]'); await waitFor(() => pupil.d.querySelector('.student-grid .empty'), '学生仍看不到预览');
    const firstId = teacher.d.querySelector('#assignment-preview').dataset.previewId;
    const firstQuestions = JSON.parse(app.db.prepare('SELECT questions FROM assignment_previews').get().questions);
    teacher.click('[data-action="replace-preview"]'); await waitFor(() => teacher.d.querySelector('#assignment-preview')?.dataset.previewId !== firstId, '换一套');
    assert.notDeepEqual(JSON.parse(app.db.prepare('SELECT questions FROM assignment_previews').get().questions), firstQuestions);
    teacher.fill('questionCount', 50);
    assert.equal(teacher.d.querySelector('[data-action="confirm-preview"]').disabled, true); assert.equal(teacher.d.querySelector('#preview-stale').hidden, false);
    assert.equal(teacher.d.querySelectorAll('.preview-questions li').length, 20);
    teacher.submit('publish-form'); await waitFor(() => teacher.d.querySelectorAll('.preview-questions li').length === 50, '修改设置再预览');
    assert.deepEqual([...teacher.d.querySelectorAll('[data-preview-category]')].map(el => el.textContent.match(/\d+ 题$/)[0]), ['17 题', '17 题', '16 题']);
    teacher.fill('questionCount', 20); teacher.fill('difficulty', 'basic'); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelectorAll('.preview-questions li').length === 20 && !teacher.d.querySelector('[data-action="confirm-preview"]').disabled, '最后的基础20题预览');
    assert.ok(teacher.d.querySelector('.preview-difficulty').textContent.includes('不进位'));
    const finalQuestions = JSON.parse(app.db.prepare('SELECT questions FROM assignment_previews').get().questions);
    const finalExpressions = [...teacher.d.querySelectorAll('.preview-questions li')].map(el => el.children[1].textContent.replace(' ＝ ?', ''));
    teacher.click('[data-action="confirm-preview"]'); await waitFor(() => teacher.d.querySelector('.report-stats'), '确认发布');
    const id = Number(teacher.w.location.hash.split('/').at(-1));
    assert.deepEqual(JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions), finalQuestions);
    assert.deepEqual([...teacher.d.querySelectorAll('.question-preview span')].map(el => el.textContent.replace(/^\d+\.　/, '').replace(' = ?', '')), finalExpressions);
    pupil.click('[data-action="refresh"]'); await waitFor(() => pupil.d.querySelector('.student-card'), '发布后学生可见');
    pupil.click('.student-card'); await waitFor(() => pupil.d.querySelectorAll('.equation input').length === 20, '学生同一张综合卷');
    assert.equal(pupil.d.querySelector('#answer-0').max, '20'); assert.equal(pupil.d.querySelector('#answer-14').max, '100');
    finalQuestions.slice(0, 12).forEach((q, i) => pupil.fill(`answer-${i}`, solution(q))); pupil.click('[data-action="save"]');
    await waitFor(() => pupil.d.querySelector('#save-state')?.textContent.includes('草稿保存于'), '综合卷12题草稿');
    const resumed = await page(pupil.session, `#/assignment/${id}`); assert.equal(resumed.d.querySelector('#answer-11').value, String(solution(finalQuestions[11])));
    finalQuestions.forEach((q, i) => resumed.fill(`answer-${i}`, i === 19 ? (solution(q) + 1) % 101 : solution(q)));
    resumed.submit('answer-form'); resumed.click('#confirm-submit'); await waitFor(() => resumed.d.querySelector('.score-stamp'), '综合卷批改');
    assert.equal(resumed.d.querySelector('.score-stamp strong').textContent, '95');
  });
});

test('刷新恢复未发布预览，确认断网和回包丢失可重试，其他窗口换卷后旧预览停发', async () => {
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    teacher.fill('title', '口诀提高卷'); teacher.fill('category', 'mul-div-20'); teacher.fill('difficulty', 'advanced'); teacher.fill('questionCount', 50);
    teacher.submit('publish-form'); await waitFor(() => teacher.d.querySelector('#assignment-preview'), '口诀预览');
    assert.ok(teacher.d.querySelector('.preview-difficulty').textContent.includes('排除乘 0/1'));
    const previewId = teacher.d.querySelector('#assignment-preview').dataset.previewId;
    const refreshed = await page(teacher.session);
    assert.equal(refreshed.d.querySelector('#assignment-preview').dataset.previewId, previewId);
    assert.equal(refreshed.d.querySelector('[name="difficulty"]').value, 'advanced'); assert.equal(refreshed.d.querySelector('[name="questionCount"]').value, '50');
    refreshed.session.failPath = `/assignment-previews/${previewId}/publish`; refreshed.click('[data-action="confirm-preview"]');
    await waitFor(() => refreshed.d.querySelector('#preview-error')?.textContent.includes('连接失败'), '确认离线');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 0);
    refreshed.session.failPath = ''; let lost = true; const original = refreshed.w.fetch;
    refreshed.w.fetch = async (path, options) => { const response = await original(path, options); if (lost && String(path).endsWith('/publish')) { lost = false; throw new Error('丢失回包'); } return response; };
    refreshed.click('[data-action="confirm-preview"]'); await waitFor(() => !lost && refreshed.d.querySelector('#preview-error')?.textContent.includes('连接失败'), '发布已保存但回包丢失');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 1);
    refreshed.click('[data-action="confirm-preview"]'); await waitFor(() => refreshed.d.querySelector('.report-stats'), '重试确认回原作业');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 1);
    refreshed.click('.back-link'); await waitFor(() => refreshed.d.querySelector('#publish-form'), '再次准备预览');
    refreshed.fill('title', '第二次预览'); refreshed.submit('publish-form'); await waitFor(() => refreshed.d.querySelector('#assignment-preview'), '新预览');
    const oldId = refreshed.d.querySelector('#assignment-preview').dataset.previewId;
    const otherWindow = await page(refreshed.session); otherWindow.click('[data-action="replace-preview"]');
    await waitFor(() => otherWindow.d.querySelector('#assignment-preview')?.dataset.previewId !== oldId, '另一个窗口换卷');
    refreshed.click('[data-action="confirm-preview"]'); await waitFor(() => refreshed.d.querySelector('#preview-error')?.textContent.includes('预览已更新'), '旧窗口拒绝发布');
    assert.equal(refreshed.d.querySelector('[data-action="confirm-preview"]').disabled, true);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 1);
    teacher.w.close(); otherWindow.w.close();
  });
});

test('旧预览表页面继续确认旧题、换卷及发布综合卷，原作业草稿成绩原样保留', async () => {
  await withPages(async ({ app, page, login }) => {
    const originals = app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all();
    const oldQuestions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=33').get().questions);
    const teacher = await page(); await login(teacher, 'teacher', teacherPassword);
    assert.equal(teacher.d.querySelector('#assignment-preview').dataset.previewId, 'legacy-preview-1');
    assert.ok(teacher.d.querySelector('.preview-difficulty').textContent.includes('沿用历史预览原题'));
    assert.equal(teacher.d.querySelectorAll('.preview-questions li').length, 10);
    teacher.click('[data-action="confirm-preview"]'); await waitFor(() => teacher.d.querySelector('.report-stats'), '老班级继续确认预览');
    const firstId = Number(teacher.w.location.hash.split('/').at(-1)); assert.deepEqual(JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(firstId).questions), oldQuestions);
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#publish-form'), '返回设置');
    teacher.fill('title', '老班级综合练习'); teacher.fill('category', 'composite'); teacher.fill('questionCount', 20); teacher.submit('publish-form');
    await waitFor(() => teacher.d.querySelectorAll('.preview-questions li').length === 20, '旧表存新预览');
    const initial = teacher.d.querySelector('#assignment-preview').dataset.previewId;
    teacher.click('[data-action="replace-preview"]'); await waitFor(() => teacher.d.querySelector('#assignment-preview')?.dataset.previewId !== initial, '旧表换卷');
    teacher.click('[data-action="confirm-preview"]'); await waitFor(() => teacher.d.querySelector('.report-stats'), '旧表发布新综合卷');
    assert.deepEqual(app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all(), originals);
    teacher.w.location.hash = '#/assignment/22?classId=1'; await waitFor(() => teacher.d.querySelector('h1')?.textContent === '练习乙' && teacher.d.querySelector('.report-stats'), '原已发布卷照常查看');
    assert.ok(teacher.d.querySelector('tbody').textContent.includes('90'));
  }, path => legacyPreviewClass(path, legacyPreviewSchemas[1]));
});

test('学生错题本跨作业归集，独立订正先隐答案、逐步反馈、重复练习并回看原卷', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedCorrections(app.db), pupil = await page(); await login(pupil, 'learner', 'Teacher123!');
    const before = app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all();
    pupil.click('nav a[href="#/mistakes"]'); await waitFor(() => pupil.d.querySelectorAll('.mistake-card').length === 6, '六道首次交卷错题');
    assert.equal(pupil.d.querySelector('nav a[href="#/mistakes"]').getAttribute('aria-current'), 'page');
    assert.equal(pupil.d.querySelector('.mistake-card').dataset.mistake, `${ids.second}:1`);
    assert.equal(pupil.d.querySelector('.mistake-origin b'), null);
    assert.equal(pupil.d.querySelector(`[data-mistake="${ids.shared}:4"]`), null);
    pupil.click(`[data-mistake="${ids.shared}:2"] .mistake-origin`);
    await waitFor(() => pupil.d.querySelector('.source-question'), '回原卷并标出第2题');
    assert.equal(pupil.d.querySelector('.source-question').dataset.originalQuestion, '2');
    assert.equal(pupil.d.querySelector('#answer-1').value, '5'); assert.equal(pupil.d.querySelector('#answer-1').matches(':disabled'), true);
    assert.equal(pupil.d.querySelector('.score-stamp strong').textContent, '60');
    pupil.click('.back-link'); await waitFor(() => pupil.d.querySelector('.mistake-card'), '回错题本');
    pupil.click(`[data-mistake="${ids.shared}:1"] a.button`); await waitFor(() => pupil.d.querySelector('#correction-form'), '独立订正');
    assert.equal(pupil.d.querySelector('[name="correctionAnswer"]').value, '');
    assert.equal(pupil.d.querySelector('.correction-explanation,.correction-result,.attempts-table'), null);
    assert.ok(pupil.d.querySelector('.correction-expression').textContent.includes('(36 − 12) ÷ 4 ＋ 7'));
    pupil.fill('correctionAnswer', 0); pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.wrong'), '第一次订正答错');
    assert.equal(pupil.d.querySelectorAll('.correction-explanation li').length, 3);
    assert.deepEqual([...pupil.d.querySelectorAll('.correction-explanation li small')].map(el => el.textContent), ['36 − 12 ＝ 24', '24 ÷ 4 ＝ 6', '6 ＋ 7 ＝ 13']);
    assert.ok(pupil.d.querySelector('.attempts-table tbody').textContent.includes('第 1 次0'));
    pupil.click('[data-action="retry-correction"]');
    assert.equal(pupil.d.querySelector('[name="correctionAnswer"]').value, ''); assert.equal(pupil.d.querySelector('.correction-explanation,.correction-result,.attempts-table'), null);
    pupil.fill('correctionAnswer', 13); pupil.submit('correction-form'); await waitFor(() => pupil.d.querySelector('.correction-result.right'), '第二次做对');
    assert.ok(pupil.d.querySelector('.correction-result').textContent.includes('第 2 次'));
    pupil.click('[data-action="retry-correction"]'); pupil.fill('correctionAnswer', 12); pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.wrong')?.textContent.includes('第 3 次'), '第三次再练');
    pupil.click('.back-link'); await waitFor(() => pupil.d.querySelector(`[data-mistake="${ids.shared}:1"]`), '带订正进度回错题本');
    const card = () => pupil.d.querySelector(`[data-mistake="${ids.shared}:1"]`);
    assert.ok(card().textContent.includes('已订正 3 次 · 第 2 次首次做对')); assert.ok(card().textContent.includes('继续订正'));
    pupil.click(`[data-mistake="${ids.shared}:1"] [data-action="correction-history"]`);
    await waitFor(() => card().querySelector('.attempts-table'), '查看订正历史');
    assert.equal(card().querySelectorAll('tbody tr').length, 3); assert.equal(card().querySelectorAll('.attempt-right').length, 1);
    assert.ok(pupil.d.querySelector(`[data-mistake="${ids.second}:1"]`).textContent.includes('已订正 0 次'));
    const refreshed = await page(pupil.session, '#/mistakes'); assert.ok(refreshed.d.querySelector(`[data-mistake="${ids.shared}:1"]`).textContent.includes('已订正 3 次')); refreshed.w.close();
    assert.deepEqual(app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all(), before);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('学生订正 18 − 5 后直接换一道不退位减法，新题独立作答，领取与交答案都可重试', async () => {
  await withPages(async ({ app, page, login }) => {
    seedCorrections(app.db);
    const id = publishAssignment(app.db, '减法再练'), original = { a: 18, op: '-', b: 5 };
    const questions = JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions);
    questions[0] = original;
    app.db.prepare('UPDATE assignments SET questions=? WHERE id=?').run(JSON.stringify(questions), id);
    const pupil = await page(); await login(pupil, 'learner', 'Teacher123!');
    const answers = questions.map(solution); answers[0] = 0;
    const submission = await pupil.w.fetch(`/api/assignments/${id}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers })
    });
    assert.equal((await submission.json()).score, 90);
    const card = `[data-mistake="${id}:1"]`;
    pupil.click('nav a[href="#/mistakes"]');
    await waitFor(() => pupil.d.querySelector(card), '错题出现在错题本');
    assert.equal(pupil.d.querySelector(card + ' [data-action="start-practice"]'), null);
    pupil.click(card + ' a.button');
    await waitFor(() => pupil.d.querySelector('#correction-form'), '打开原题');
    pupil.fill('correctionAnswer', 1); pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.wrong'), '原题尚未改对');
    assert.equal(pupil.d.querySelector('[data-action="start-practice"]'), null);
    pupil.click('[data-action="retry-correction"]');
    assert.match(pupil.d.querySelector('.correction-expression').textContent, /18 − 5/);
    pupil.fill('correctionAnswer', 13); pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.right'), '原题订正成功');
    const fetch = pupil.w.fetch;
    let dropStart = true, dropAnswer = true;
    pupil.w.fetch = async (path, options) => {
      const response = await fetch(path, options);
      if (options.method === 'POST') {
        if (dropStart && path.endsWith('/practice')) { dropStart = false; throw new Error('领取回包丢失'); }
        if (dropAnswer && /\/practice\/\d+$/.test(path)) { dropAnswer = false; throw new Error('提交回包丢失'); }
      }
      return response;
    };
    pupil.click('[data-action="start-practice"]');
    await waitFor(() => !dropStart && !pupil.d.querySelector('[data-action="start-practice"]').disabled, '领取后可重试');
    pupil.click('[data-action="start-practice"]');
    await waitFor(() => pupil.d.querySelector('h1')?.textContent === '同类再练', '换到同类题');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM mistake_practice').get().n, 1);
    const expression = pupil.d.querySelector('.correction-expression').textContent;
    const [, left, right] = expression.match(/^(\d+) − (\d+) ＝ \?$/);
    assert.notEqual(Number(left), 18); assert.notEqual(Number(right), 5);
    assert.ok(Number(left) % 10 >= Number(right) % 10);
    assert.equal(pupil.d.querySelector('[name="correctionAnswer"]').value, '');
    assert.equal(pupil.d.querySelector('.correction-result,.correction-explanation,.attempts-table'), null);
    const refreshed = await page(pupil.session, pupil.w.location.hash);
    assert.equal(refreshed.d.querySelector('.correction-expression').textContent, expression); refreshed.w.close();
    pupil.fill('correctionAnswer', 13); pupil.submit('correction-form');
    await waitFor(() => !dropAnswer && pupil.d.querySelector('#correction-error').textContent.includes('连接失败'), '新题答卷重试');
    assert.equal(pupil.d.querySelector('[name="correctionAnswer"]').value, '13');
    pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.wrong'), '用原答案答新题判错');
    assert.match(pupil.d.querySelector('.correction-explanation li small').textContent, new RegExp(`＝ ${left - right}$`));
    pupil.click('[data-action="start-practice"]');
    await waitFor(() => pupil.d.querySelector('#correction-form'), '再换一道');
    const next = pupil.d.querySelector('.correction-expression').textContent;
    assert.notEqual(next, expression);
    const [, a, b] = next.match(/^(\d+) − (\d+)/);
    pupil.fill('correctionAnswer', a - b); pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('.correction-result.right'), '按第二道新题的答案判对');
    pupil.click('.back-link');
    await waitFor(() => pupil.d.querySelector(card + ' [data-action="start-practice"]'), '回错题本可直接同类再练');
    assert.match(pupil.d.querySelector(card + ' .mistake-progress').textContent, /已订正 2 次 · 第 2 次首次做对/);
    pupil.click(card + ' .mistake-origin');
    await waitFor(() => pupil.d.querySelector('.score-stamp'), '回看原卷');
    assert.equal(pupil.d.querySelector('.score-stamp strong').textContent, '90');
    assert.equal(pupil.d.querySelector('#answer-0').value, '0');
  });
});

test('订正断网保留输入、响应丢失重试不重复计次，刷新隐答案且账号之间不串题', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedCorrections(app.db), pupil = await page(); await login(pupil, 'learner', 'Teacher123!');
    const path = `#/mistakes/${ids.shared}/1`;
    pupil.w.location.hash = path; await waitFor(() => pupil.d.querySelector('#correction-form'), '打开订正');
    pupil.fill('correctionAnswer', 12); pupil.session.failPath = '/attempts'; pupil.submit('correction-form');
    await waitFor(() => pupil.d.querySelector('#correction-error')?.textContent.includes('连接失败'), '离线提示');
    assert.equal(pupil.d.querySelector('[name="correctionAnswer"]').value, '12');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM correction_attempts').get().n, 0);
    pupil.session.failPath = '';
    const original = pupil.w.fetch; let lost = true;
    pupil.w.fetch = async (path, options) => { const response = await original(path, options); if (lost && String(path).endsWith('/attempts') && options.method === 'POST') { lost = false; throw new Error('模拟回包丢失'); } return response; };
    pupil.submit('correction-form'); await waitFor(() => !lost && pupil.d.querySelector('#correction-error')?.textContent.includes('连接失败'), '保存成功但回包丢失');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM correction_attempts').get().n, 1);
    pupil.submit('correction-form'); await waitFor(() => pupil.d.querySelector('.correction-result'), '同一次提交重试');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM correction_attempts').get().n, 1);
    const fresh = await page(pupil.session, path);
    assert.equal(fresh.d.querySelector('.correction-result,.correction-explanation,.attempts-table'), null);
    assert.equal(fresh.d.querySelector('[name="correctionAnswer"]').value, '');
    assert.ok(fresh.d.querySelector('.page-title p').textContent.includes('已订正 1 次'));
    fresh.fill('correctionAnswer', 13); fresh.w.confirm = () => false; fresh.click('nav a[href="#/mistakes"]');
    await waitFor(() => fresh.w.location.hash === path, '取消离开订正'); assert.equal(fresh.d.querySelector('[name="correctionAnswer"]').value, '13');
    fresh.w.confirm = () => true; fresh.click('[data-action="logout"]'); await waitFor(() => fresh.d.querySelector('#login-form'), '退出订正');
    await login(fresh, 'other', 'Teacher123!'); fresh.click('nav a[href="#/mistakes"]');
    await waitFor(() => fresh.d.querySelectorAll('.mistake-card').length === 1, '另一学生只有自己的错题');
    assert.equal(fresh.d.querySelector('.mistake-card').dataset.mistake, `${ids.shared}:2`);
    fresh.w.location.hash = path; await waitFor(() => fresh.d.querySelector('.empty p')?.textContent.includes('错题不存在'), '拦截其他学生的错题');
    assert.equal(fresh.d.querySelector('#correction-form,.correction-result'), null);
    for (const username of ['perfect', 'draft']) { const empty = await page(); await login(empty, username, 'Teacher123!'); empty.click('nav a[href="#/mistakes"]'); await waitFor(() => empty.d.querySelector('.empty h2')?.textContent === '暂时没有错题', '没有已交错题'); empty.w.close(); }
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!'); assert.equal(teacher.d.querySelector('nav a[href="#/mistakes"]'), null);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('旧班级学生从错题本订正历史混合题，原分数和答案仍可回看', async () => {
  await withPages(async ({ app, page, login }) => {
    const before = app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all();
    const pupil = await page(); await login(pupil, 'pupil3', studentPassword); pupil.click('nav a[href="#/mistakes"]');
    await waitFor(() => pupil.d.querySelector('[data-mistake="33:1"]'), '历史错题自动收录');
    pupil.click('[data-mistake="33:1"] a.button'); await waitFor(() => pupil.d.querySelector('#correction-form'), '历史混合题订正');
    pupil.fill('correctionAnswer', 27); pupil.submit('correction-form'); await waitFor(() => pupil.d.querySelector('.correction-result.right'), '旧题订正正确');
    assert.equal(pupil.d.querySelectorAll('.correction-explanation li').length, 2);
    pupil.click('.correction-original a'); await waitFor(() => pupil.d.querySelector('.source-question'), '回历史原卷');
    assert.equal(pupil.d.querySelector('.score-stamp strong').textContent, '70'); assert.equal(pupil.d.querySelector('#answer-0').value, '0');
    assert.deepEqual(app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all(), before);
  }, createHistoryClass);
});

function seedRecords(app) {
  const ids = seedCalendar(app), db = app.db;
  const pupil = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
  const original = historyAssignments[1], wrong = [...original.key]; wrong[0]++; wrong[1]++;
  db.prepare('UPDATE assignments SET questions=?,category=? WHERE id=?').run(JSON.stringify(original.questions), original.category, ids.shared);
  db.prepare('UPDATE submissions SET answers=?,score=80 WHERE assignment_id=? AND student_id=?').run(JSON.stringify(wrong), ids.shared, pupil('lin'));
  db.prepare('UPDATE submissions SET answers=? WHERE assignment_id=? AND student_id=?').run(JSON.stringify(original.key), ids.shared, pupil('zhou'));
  db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)').run(ids.shared, pupil('pending'), JSON.stringify([0, null, 16, ...Array(7).fill(null)]), '2026-11-24T04:00:00Z', null, null);
  const mixed = publishAssignment(db, '上周先乘除后加减', { category: 'mixed-100', questionCount: 50, grade: 3, knowledgePoints: ['precedence'] });
  db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run('2026-11-17T01:00:00Z', mixed);
  db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)').run(mixed, pupil('lin'), JSON.stringify([0, ...Array(49).fill(null)]), '2026-11-18T01:00:00Z', null, null);
  db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT 'blank','小林',password_hash,'student',1 FROM users WHERE role='teacher'").run();
  db.prepare("INSERT INTO classes(name) VALUES('空班')").run();
  return { ...ids, mixed, lin: pupil('lin'), pendingStudent: pupil('pending'), zhou: pupil('zhou'), blank: pupil('blank') };
}

test('教师转班后能从原班成绩表和新班个人记录打开同一原卷，学生可自行回看', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedRecords(app), teacher = await page();
    await login(teacher, 'teacher', 'Teacher123!');
    teacher.click('nav a[href="#/students"]');
    const transferSelect = `[data-student-class="${ids.lin}"]`;
    await waitFor(() => teacher.d.querySelector(transferSelect), '找到原班学生');
    const select = teacher.d.querySelector(transferSelect);
    select.value = '2'; select.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('#student-list') && !teacher.d.querySelector(transferSelect), '学生名单已转班');
    teacher.w.location.hash = `#/assignment/${ids.shared}?classId=1`;
    const rowLink = `.student-review-link[href*="student/${ids.lin}?"]`;
    await waitFor(() => teacher.d.querySelector(rowLink), '原班仍有该生成绩');
    teacher.click(rowLink);
    await waitFor(() => teacher.d.querySelector('.review-total strong')?.textContent === '80', '查看原班的 80 分卷');
    const answers = () => [...teacher.d.querySelectorAll('.review-student-answer')].map(el => el.textContent);
    const original = answers();
    teacher.click('.review-links a[href*="/history"]');
    const entry = `[data-history-assignment="${ids.shared}"]`;
    await waitFor(() => teacher.d.querySelector(entry), '转入班个人记录');
    assert.equal(teacher.d.querySelector('[name="currentClass"]').value, '2');
    assert.match(teacher.d.querySelector(entry).textContent, /原班级历史作业/);
    teacher.click(entry);
    await waitFor(() => teacher.d.querySelector('.review-total'), '从个人记录打开原卷');
    assert.deepEqual(answers(), original);
    assert.match(teacher.d.querySelector('.review-links a').getAttribute('href'), /classId=1/);
    teacher.click('.back-link');
    await waitFor(() => teacher.d.querySelector(entry), '返回新班个人记录');
    const pupil = await page(); await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`.student-card[href="#/assignment/${ids.shared}"]`);
    await waitFor(() => pupil.d.querySelector('.score-stamp strong')?.textContent === '80', '学生自己的已交原卷');
    assert.equal(pupil.d.querySelector('#answer-0').value, original[0]);
    assert.equal(pupil.d.querySelector('#answer-0').matches(':disabled'), true);
  });
});

test('教师从成绩姓名查看原卷和未评分草稿，刷新、成绩表与月历往返保持上下文', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedRecords(app), teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    const before = app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all();
    const report = `#/assignment/${ids.shared}?classId=1&calendar=2026-11-24`;
    teacher.w.location.hash = report; await waitFor(() => teacher.d.querySelector('.report-stats'), '原班成绩表');
    teacher.click(`.student-review-link[href*="student/${ids.lin}?"]`);
    await waitFor(() => teacher.d.querySelectorAll('.review-question').length === 10, '已交原卷');
    assert.equal(teacher.d.querySelector('.review-total strong').textContent, '80');
    assert.equal(teacher.d.querySelectorAll('.review-question.incorrect').length, 2);
    assert.equal(teacher.d.querySelectorAll('.review-question.correct').length, 8);
    assert.equal(teacher.d.querySelector('[data-review-question="0"] .review-student-answer').textContent, '3');
    assert.equal(teacher.d.querySelector('[data-review-question="0"] .review-correct-answer').textContent, '2');
    assert.equal(teacher.d.querySelector('[data-review-question="4"] .review-student-answer').textContent, '0');
    assert.equal(teacher.d.querySelector('.review-summary h2 b'), null);
    assert.equal(teacher.d.querySelector('#answer-form'), null); assert.equal(teacher.d.querySelector('[data-action="save"]'), null);
    assert.equal(teacher.d.querySelector('.back-link').getAttribute('href'), report);
    const refreshed = await page(teacher.session, teacher.w.location.hash);
    assert.equal(refreshed.d.querySelector('.review-total strong').textContent, '80'); refreshed.w.close();
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('.report-stats'), '回成绩表');
    teacher.click(`.student-review-link[href*="student/${ids.pendingStudent}?"]`);
    await waitFor(() => teacher.d.querySelector('.review-status.ungraded'), '已保存草稿');
    assert.ok(teacher.d.querySelector('.review-status').textContent.includes('未交、未评分'));
    assert.ok(teacher.d.querySelector('.review-status').textContent.includes('2026/11/24 12:00'));
    assert.equal(teacher.d.querySelector('.review-total'), null);
    assert.equal(teacher.d.querySelectorAll('.review-question.incorrect,.review-question.correct').length, 0);
    assert.equal(teacher.d.querySelector('[data-review-question="0"] .review-student-answer').textContent, '0');
    assert.equal(teacher.d.querySelector('[data-review-question="1"] .review-student-answer').textContent, '未填');
    assert.equal(teacher.d.querySelector('[data-review-question="1"] .review-correct-answer').textContent, '6');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('.report-stats'), '再回成绩表');
    teacher.click(`.student-review-link[href*="student/${ids.blank}?"]`);
    await waitFor(() => teacher.d.querySelector('.review-status')?.textContent.includes('暂无已保存答案'), '未保存原卷');
    assert.equal([...teacher.d.querySelectorAll('.review-student-answer')].filter(el => el.textContent === '未填').length, 10);
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('.report-stats'), '回成绩');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('.month-calendar'), '回月历');
    assert.equal(teacher.d.querySelector('.calendar-day[aria-current="date"] time').getAttribute('datetime'), '2026-11-24');
    assert.deepEqual(app.db.prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all(), before);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('个人练习记录按日期知识点查询、原卷返回保留筛选，同名学生和切班不混入', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedRecords(app), teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    teacher.click('nav a[href="#/students"]'); await waitFor(() => teacher.d.querySelector('.student-record-link'), '名单记录入口');
    teacher.click(`.student-record-link[href*="students/${ids.lin}/history"]`);
    await waitFor(() => teacher.d.querySelector('#history-filter-form'), '小林练习记录');
    assert.ok(teacher.d.querySelector('[name="historyStudent"]').textContent.includes('小林 · lin'));
    assert.ok(teacher.d.querySelector('[name="historyStudent"]').textContent.includes('小林 · blank'));
    teacher.fill('from', '2026-11-24'); teacher.fill('to', '2026-11-24'); teacher.fill('topic', 'mul-div-20'); teacher.submit('history-filter-form');
    await waitFor(() => teacher.d.querySelectorAll('.history-item').length === 1 && teacher.d.querySelector('[name="topic"]')?.value === 'mul-div-20', '按发布日期查乘除');
    assert.ok(teacher.d.querySelector('.history-item').textContent.includes('80'));
    assert.ok(teacher.d.querySelector('.history-item').textContent.includes('2026/11/24 00:30'));
    const filteredHash = teacher.w.location.hash;
    teacher.click('.history-item'); await waitFor(() => teacher.d.querySelector('.review-total'), '记录打开原卷');
    assert.equal(teacher.d.querySelector('.back-link').getAttribute('href'), filteredHash);
    const refreshed = await page(teacher.session, teacher.w.location.hash);
    refreshed.click('.back-link'); await waitFor(() => refreshed.d.querySelector('#history-filter-form'), '刷新原卷后返回筛选');
    assert.equal(refreshed.d.querySelector('[name="from"]').value, '2026-11-24'); assert.equal(refreshed.d.querySelector('[name="topic"]').value, 'mul-div-20'); refreshed.w.close();
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#history-filter-form'), '回记录');
    teacher.fill('from', '2026-11-16'); teacher.fill('to', '2026-11-22'); teacher.fill('topic', 'precedence'); teacher.submit('history-filter-form');
    await waitFor(() => teacher.d.querySelector(`[data-history-assignment="${ids.mixed}"]`), '上周知识点筛选');
    assert.ok(teacher.d.querySelector('.history-item').textContent.includes('未交、未评分'));
    teacher.click('.history-item'); await waitFor(() => teacher.d.querySelectorAll('.review-question').length === 50, '50题草稿原卷');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#history-filter-form'), '返回上周筛选');
    teacher.fill('from', '2026-11-25'); teacher.submit('history-filter-form');
    assert.ok(teacher.d.querySelector('#history-error').textContent.includes('开始日期不能晚于结束日期'));
    teacher.click('.history-filters a.button'); await waitFor(() => teacher.d.querySelector('[name="from"]')?.value === '', '清空筛选');
    const select = teacher.d.querySelector('[name="historyStudent"]'); select.value = String(ids.blank); select.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('.page-title p')?.textContent.includes('blank'), '切换同名学生');
    assert.equal(teacher.d.querySelector('.history-score strong'), null);
    const changeClass = async id => { const field = teacher.d.querySelector('[name="currentClass"]'); field.value = String(id); field.dispatchEvent(new teacher.w.Event('change', { bubbles: true })); await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.value === String(id) && !teacher.d.querySelector('.loading'), '记录切班'); };
    await changeClass(2); assert.ok(teacher.d.querySelector('.page-title p').textContent.includes('zhou'));
    assert.equal(teacher.d.querySelectorAll('[name="historyStudent"] option').length, 1);
    assert.ok(!teacher.d.querySelector(`[data-history-assignment="${ids.pending}"]`));
    assert.equal(teacher.d.querySelector(`[data-history-assignment="${ids.shared}"] .history-score strong`).textContent, '100');
    await changeClass(3); assert.ok(teacher.d.querySelector('.empty').textContent.includes('本班还没有学生'));
    await changeClass(1); await waitFor(() => teacher.d.querySelector('#history-filter-form'), '返回一班');
    teacher.fill('from', '2027-01-01'); teacher.submit('history-filter-form');
    await waitFor(() => teacher.d.querySelector('.history-list .empty'), '空筛选');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#student-form'), '回原班名单');
    await changeClass(2); assert.equal(teacher.d.querySelector('tbody').textContent.includes('小周'), true);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('学生原卷与记录断网可重试，跨班或学生账号不能查看教师记录', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedRecords(app), teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    teacher.session.failPath = `/assignments/${ids.shared}/students/`;
    teacher.w.location.hash = `#/assignment/${ids.shared}/student/${ids.lin}?classId=1`;
    await waitFor(() => teacher.d.querySelector('.empty p')?.textContent.includes('连接失败'), '原卷断网');
    teacher.session.failPath = ''; teacher.click('[data-action="refresh"]'); await waitFor(() => teacher.d.querySelector('.review-total'), '原卷重试');
    teacher.w.location.hash = `#/assignment/${ids.shared}/student/${ids.zhou}?classId=1`;
    await waitFor(() => teacher.d.querySelector('.empty p')?.textContent.includes('成绩名单'), '跨班原卷拦截');
    assert.equal(teacher.d.querySelector('.review-question'), null);
    teacher.session.failPath = '/history?'; teacher.w.location.hash = `#/students/${ids.lin}/history?classId=1`;
    await waitFor(() => teacher.d.querySelector('.empty p')?.textContent.includes('连接失败'), '记录断网');
    teacher.session.failPath = ''; teacher.click('[data-action="refresh"]'); await waitFor(() => teacher.d.querySelector('#history-filter-form'), '记录重试');
    const pupil = await page(); await login(pupil, 'lin', 'Teacher123!');
    pupil.w.location.hash = `#/assignment/${ids.shared}/student/${ids.pendingStudent}?classId=1`;
    await waitFor(() => pupil.d.querySelector('.student-grid') && !pupil.d.querySelector('.loading'), '学生不能访问教师原卷');
    assert.equal(pupil.d.querySelector('.review-question'), null); assert.equal(pupil.d.querySelector('#history-filter-form'), null);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

function seedCalendar(app) {
  const db = app.db;
  db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
  for (const [username, name, classId] of [['lin', '小林', 1], ['pending', '未交同学', 1], ['zhou', '小周', 2]]) db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',? FROM users WHERE role='teacher'").run(username, name, classId);
  const make = (title, createdAt, classIds = [1], dueAt = null) => {
    const id = publishAssignment(db, title, { classIds, dueAt }); db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run(createdAt, id); return id;
  };
  const shared = make('周二同卷 <b>，周四截止', '2026-11-23T16:30:00Z', [1, 2], '2026-11-26T12:00:00Z');
  const pending = make('周二第二份', '2026-11-24T05:00:00Z');
  const other = make('二班专属', '2026-11-24T08:00:00Z', [2]);
  const december = make('十二月第一份', '2026-11-30T16:00:00Z', [1, 2]);
  make('闰日练习', '2024-02-28T16:00:00Z');
  const questions = JSON.parse(db.prepare('SELECT questions FROM assignments WHERE id=?').get(shared).questions);
  for (const [username, score] of [['lin', 90], ['zhou', 100]]) {
    const answers = questions.map((q, i) => score === 90 && i === 0 ? (solution(q) + 1) % 21 : solution(q));
    const student = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)')
      .run(shared, student.id, JSON.stringify(answers), '2026-11-24T06:00:00Z', '2026-11-24T06:00:00Z', score);
  }
  return { shared, pending, other, december };
}

test('教师月历翻月、日期归类、分班统计与成绩往返保留班级日期', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedCalendar(app), teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    teacher.click('nav a[href="#/calendar"]');
    await waitFor(() => teacher.d.querySelector('.month-calendar'), '练习月历');
    assert.equal(teacher.d.querySelector('[name="calendarMonth"]').value, '2026-11');
    assert.equal(teacher.d.querySelectorAll('.calendar-day').length, 30);
    assert.equal(teacher.d.querySelector('nav a[href="#/calendar"]').getAttribute('aria-current'), 'page');
    const card = id => teacher.d.querySelector(`[data-calendar-assignment="${id}"]`);
    const scores = id => [...card(id).querySelectorAll('.card-stats strong')].map(n => n.firstChild.textContent);
    assert.equal(teacher.d.querySelectorAll('.calendar-paper').length, 2);
    assert.deepEqual(scores(ids.shared), ['1', '1', '90']);
    assert.ok(card(ids.shared).textContent.includes('2026/11/24 00:30'));
    assert.ok(card(ids.shared).textContent.includes('截止：2026/11/26 20:00'));
    assert.equal(card(ids.shared).querySelector('h3 b'), null);
    assert.equal(card(ids.pending).querySelector('.calendar-no-average').textContent, '暂无均分');
    teacher.click('.calendar-day[href*="day=2026-11-26"]');
    await waitFor(() => teacher.d.querySelector('.calendar-day[aria-current="date"] time')?.getAttribute('datetime') === '2026-11-26', '截止日期不代替发布日期');
    assert.equal(teacher.d.querySelectorAll('.calendar-paper').length, 0);
    assert.ok(teacher.d.querySelector('.calendar-daily').textContent.includes('这一天没有发布练习'));
    teacher.click('.calendar-day[href*="day=2026-11-24"]');
    await waitFor(() => card(ids.shared), '回到周二');
    teacher.click(`[data-calendar-assignment="${ids.shared}"]`);
    await waitFor(() => teacher.d.querySelector('.report-stats'), '进入现有成绩明细');
    assert.ok(teacher.w.location.hash.includes('classId=1')); assert.ok(teacher.w.location.hash.includes('calendar=2026-11-24'));
    assert.ok(teacher.d.querySelector('tbody').textContent.includes('小林')); assert.ok(!teacher.d.querySelector('tbody').textContent.includes('小周'));
    assert.equal(teacher.d.querySelector('.back-link').textContent, '← 返回练习月历');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('.month-calendar'), '从明细返回月历');
    assert.equal(teacher.d.querySelector('.calendar-day[aria-current="date"] time').getAttribute('datetime'), '2026-11-24');
    const classSelect = teacher.d.querySelector('[name="currentClass"]'); classSelect.value = '2'; classSelect.dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('#calendar-daily-title')?.textContent.startsWith('二班'), '月历切二班');
    assert.deepEqual(scores(ids.shared), ['1', '0', '100']); assert.equal(card(ids.pending), null); assert.ok(card(ids.other));
    const session = teacher.session, hash = teacher.w.location.hash;
    const refreshed = await page(session, hash);
    assert.equal(refreshed.d.querySelector('[name="currentClass"]').value, '2');
    assert.equal(refreshed.d.querySelector(`[data-calendar-assignment="${ids.shared}"] .card-stats div:last-child strong`).textContent, '100');
    refreshed.w.close();
    teacher.click('[aria-label="下个月"]');
    await waitFor(() => teacher.d.querySelector('.month-calendar')?.getAttribute('aria-label') === '2026-12 练习月历', '翻到十二月');
    assert.equal(teacher.d.querySelectorAll('.calendar-day').length, 31); assert.ok(card(ids.december));
    teacher.click('[aria-label="下个月"]');
    await waitFor(() => teacher.d.querySelector('.month-calendar')?.getAttribute('aria-label') === '2027-01 练习月历', '跨年翻月');
    teacher.click('[aria-label="上个月"]');
    await waitFor(() => teacher.d.querySelector('.month-calendar')?.getAttribute('aria-label') === '2026-12 练习月历', '上一月');
    teacher.fill('calendarMonth', '2024-02'); teacher.d.querySelector('[name="calendarMonth"]').dispatchEvent(new teacher.w.Event('change', { bubbles: true }));
    await waitFor(() => teacher.d.querySelector('.month-calendar')?.getAttribute('aria-label') === '2024-02 练习月历', '直接选闰年月份');
    assert.equal(teacher.d.querySelectorAll('.calendar-day').length, 29);
    assert.ok(teacher.d.querySelector('.calendar-month-total').textContent.includes('共 0 份练习'));
    teacher.click('.calendar-toolbar .text-button');
    await waitFor(() => teacher.d.querySelector('.month-calendar')?.getAttribute('aria-label') === '2026-11 练习月历', '回到北京时间本月');
    teacher.click(`[data-calendar-assignment="${ids.shared}"]`); await waitFor(() => teacher.d.querySelector('.report-stats'), '二班进入成绩');
    const detail = await page(session, teacher.w.location.hash);
    assert.equal(detail.d.querySelector('[name="currentClass"]').value, '2');
    assert.ok(detail.d.querySelector('tbody').textContent.includes('小周')); assert.ok(!detail.d.querySelector('tbody').textContent.includes('小林'));
    detail.click('.back-link'); await waitFor(() => detail.d.querySelector('#calendar-daily-title')?.textContent.startsWith('二班'), '明细刷新后返回原班日期');
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('月历断网重试、错误月份和日期、延迟响应不会串班', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedCalendar(app), teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    const route = id => `#/calendar?classId=${id}&month=2026-11&day=2026-11-24`;
    teacher.w.location.hash = route(1); await waitFor(() => teacher.d.querySelector('.month-calendar'), '打开固定日期');
    teacher.session.failPath = '/calendar?'; teacher.click('[data-action="refresh"]');
    await waitFor(() => teacher.d.querySelector('.empty h2')?.textContent.includes('暂时没有打开'), '月历断网错误');
    assert.equal(teacher.d.querySelector('.calendar-paper'), null);
    teacher.session.failPath = ''; teacher.click('[data-action="refresh"]');
    await waitFor(() => teacher.d.querySelector('.month-calendar'), '重试月历');
    teacher.w.location.hash = '#/calendar?classId=1&month=2026-13';
    await waitFor(() => teacher.d.querySelector('.empty p')?.textContent.includes('YYYY-MM'), '月份校验');
    teacher.w.location.hash = '#/calendar?classId=1&month=2024-02&day=2024-02-30';
    await waitFor(() => teacher.d.querySelector('.empty p')?.textContent.includes('日期不在当前月份'), '日期校验');
    teacher.w.location.hash = route(2); await waitFor(() => teacher.d.querySelector('#calendar-daily-title')?.textContent.startsWith('二班'), '进入二班');
    let release, received, parsed;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { received = resolve; }), completed = new Promise(resolve => { parsed = resolve; });
    const original = teacher.w.fetch;
    teacher.w.fetch = async (path, options) => {
      const response = await original(path, options);
      if (!String(path).includes('/calendar?classId=1&')) return response;
      received(); await gate;
      return { ok: response.ok, status: response.status, json: async () => { const value = await response.json(); parsed(); return value; } };
    };
    teacher.w.location.hash = route(1); await started;
    teacher.w.location.hash = route(2); await waitFor(() => teacher.d.querySelector('#calendar-daily-title')?.textContent.startsWith('二班'), '等待新班级响应');
    release(); await completed; await new Promise(resolve => setImmediate(resolve));
    assert.equal(teacher.d.querySelector('[name="currentClass"]').value, '2');
    assert.equal(teacher.d.querySelector(`[data-calendar-assignment="${ids.shared}"] .card-stats div:last-child strong`).textContent, '100');
    assert.equal(teacher.d.querySelector(`[data-calendar-assignment="${ids.pending}"]`), null);
  }, undefined, { clock: () => Date.parse('2026-11-24T08:00:00Z') });
});

test('教师班级学情的加权均分、常错题、逐人原答案、原卷往返和换班范围', async () => {
  await withPages(async ({ app, page, login }) => {
    const {a,ids} = seedAnalytics(app.db); let teacher = await page(); await login(teacher,'teacher','Teacher123!');
    teacher.click('nav a[href="#/analytics"]'); await waitFor(()=>teacher.d.querySelector('#analytics-filter-form'),'学情入口');
    assert.equal(teacher.d.querySelector('[name="from"]').value,'2026-11-18');
    assert.equal(teacher.d.querySelector('[name="to"]').value,'2026-11-24');
    teacher.fill('from','2026-11-17'); teacher.fill('to','2026-11-19'); teacher.submit('analytics-filter-form');
    const metrics = () => [...teacher.d.querySelectorAll('.analytics-summary strong')].map(n=>n.textContent);
    await waitFor(()=>metrics().join(',')==='2,3,5,80','80/100/60 逐份均分');
    assert.equal(teacher.d.querySelector('nav [aria-current="page"]').textContent,'班级学情');
    assert.equal(teacher.d.querySelectorAll('.analytics-question').length,6);
    assert.ok(teacher.d.querySelector(`[data-analytics-question="${a}:1"]`).textContent.includes('周二练习 <A>'));
    assert.equal(teacher.d.querySelector('.analytics-question A'),null);
    teacher.click(`[data-analytics-question="${a}:1"]`); await waitFor(()=>teacher.d.querySelector('#analytics-detail'),'逐人原答案');
    assert.equal(teacher.d.querySelector('#analytics-detail .analytics-expression').textContent,'8 − 8 ＝ 0');
    const row = id => teacher.d.querySelector(`[data-analytics-student="${id}"]`);
    assert.equal(row(ids.nan).children[2].textContent,'0');
    assert.ok(row(ids.draft).textContent.includes('未交、未评分'));assert.equal(row(ids.draft).children[2].textContent,'草稿：0');
    assert.equal(row(ids.blank).children[2].textContent,'未保存答案');assert.equal(row(ids.zhou),null);
    teacher.click('[name="analyticsAll"]');assert.equal(teacher.d.querySelectorAll('.analytics-question').length,20);
    const detailHash=teacher.w.location.hash;
    teacher.w.close();teacher=await page(teacher.session,detailHash);
    assert.equal(teacher.d.querySelectorAll('.analytics-question').length,20);assert.ok(teacher.d.querySelector('[name="analyticsAll"]').checked);
    teacher.click(`[data-analytics-student="${ids.lin}"] .student-name`); await waitFor(()=>teacher.d.querySelector('.review-summary'),'学情到原卷');
    assert.equal(teacher.d.querySelector('.review-total strong').textContent,'80');assert.equal(teacher.d.querySelector('.back-link').textContent,'← 返回班级学情');
    teacher.click('.back-link');await waitFor(()=>teacher.d.querySelector('#analytics-detail'),'返回保留范围及题号');
    assert.equal(teacher.w.location.hash,detailHash);
    teacher.click(`[data-analytics-question="${a}:2"]`);await waitFor(()=>teacher.d.querySelector('#analytics-detail h2')?.textContent.startsWith('第 2 题'),'已交漏答');
    assert.equal(row(ids.lin).children[1].textContent,'漏答');assert.equal(row(ids.lin).children[2].textContent,'未填');
    const chooser=teacher.d.querySelector('[name="currentClass"]');chooser.value='2';chooser.dispatchEvent(new teacher.w.Event('change',{bubbles:true}));
    await waitFor(()=>metrics().join(',')==='1,1,0,40','切班独立均分');
    assert.equal(teacher.d.querySelector('#analytics-detail'),null);assert.equal(teacher.d.querySelector('[name="from"]').value,'2026-11-17');
    assert.ok(!teacher.w.location.hash.includes('assignmentId='));
    teacher.click(`[data-analytics-question="${a}:1"]`);await waitFor(()=>teacher.d.querySelector('#analytics-detail'),'二班原答案');
    assert.deepEqual([...teacher.d.querySelectorAll('[data-analytics-student]')].map(n=>n.dataset.analyticsStudent),[String(ids.zhou)]);
    teacher.fill('from','2026-11-20');teacher.fill('to','2026-11-19');teacher.submit('analytics-filter-form');
    assert.ok(teacher.d.querySelector('#analytics-error').textContent.includes('开始日期不能晚于结束日期'));
    teacher.fill('from','2026-12-01');teacher.fill('to','2026-12-01');teacher.submit('analytics-filter-form');
    await waitFor(()=>metrics().join(',')==='0,0,0,暂无均分','无练习范围');
    assert.ok(teacher.d.querySelector('#analytics-question-list').textContent.includes('当前范围没有练习'));
    teacher.click('#analytics-filter-form a');await waitFor(()=>metrics().join(',')==='1,1,0,40','清空日期全部历史');
    assert.equal(teacher.d.querySelector('[name="from"]').value,'');assert.equal(teacher.d.querySelector('[name="to"]').value,'');
    const student=await page();await login(student,'lin','Teacher123!');assert.equal(student.d.querySelector('nav a[href="#/analytics"]'),null);
  },undefined,{clock:()=>Date.parse('2026-11-23T16:05:00Z')});
});

test('学情无人提交与零分展示、断网重试、无效题号和延迟响应不串班',async()=>{
  await withPages(async({app,page,login})=>{
    const {a,ids}=seedAnalytics(app.db), pending=publishAssignment(app.db,'无人交',{classIds:[1]});
    app.db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run('2026-12-01T00:00:00Z',pending);
    const teacher=await page();await login(teacher,'teacher','Teacher123!');
    const route = id => `#/analytics?classId=${id}&from=2026-11-17&to=2026-11-19`;
    teacher.w.location.hash='#/analytics?classId=1&from=2026-12-01&to=2026-12-01';
    await waitFor(()=>teacher.d.querySelector('.analytics-summary'),'无人提交范围');
    assert.equal(teacher.d.querySelector('.analytics-summary>div:last-child strong').textContent,'暂无均分');
    teacher.click('[name="analyticsAll"]');assert.equal(teacher.d.querySelectorAll('.analytics-question').length,10);
    assert.ok(teacher.d.querySelector('.analytics-counts>div:last-child').textContent.includes('4 人'));
    app.db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)').run(pending,ids.lin,JSON.stringify(Array(10).fill(0)),'2026-12-02T00:00:00Z','2026-12-02T00:00:00Z',0);
    teacher.click('[data-action="refresh"]');await waitFor(()=>teacher.d.querySelector('.analytics-summary>div:last-child strong')?.textContent==='0','实际均分零');
    teacher.session.failPath='/analytics?';teacher.click('[data-action="refresh"]');await waitFor(()=>teacher.d.querySelector('.empty h2')?.textContent.includes('暂时没有打开'),'断网');
    assert.equal(teacher.d.querySelector('.analytics-summary'),null);
    teacher.session.failPath='';teacher.click('[data-action="refresh"]');await waitFor(()=>teacher.d.querySelector('.analytics-summary'),'重试');
    teacher.w.location.hash=route(1)+`&assignmentId=${a}&questionNumber=11`;
    await waitFor(()=>teacher.d.querySelector('.empty p')?.textContent.includes('没有这道题'),'无效题号');
    teacher.w.location.hash=route(2);await waitFor(()=>teacher.d.querySelector('.analytics-heading h2')?.textContent.startsWith('二班'),'进入二班');
    let release,received,parsed;
    const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{received=r;}),completed=new Promise(r=>{parsed=r;});
    const original=teacher.w.fetch;
    teacher.w.fetch=async(path,options)=>{
      const response=await original(path,options);if(!String(path).includes('/analytics?classId=1&'))return response;
      received();await gate;return{ok:response.ok,status:response.status,json:async()=>{const value=await response.json();parsed();return value;}};
    };
    teacher.w.location.hash=route(1);await started;teacher.w.location.hash=route(2);
    await waitFor(()=>teacher.d.querySelector('.analytics-heading h2')?.textContent.startsWith('二班'),'新班先完成');release();await completed;await new Promise(r=>setImmediate(r));
    assert.equal(teacher.d.querySelector('[name="currentClass"]').value,'2');
    assert.equal(teacher.d.querySelector('.analytics-summary>div:last-child strong').textContent,'40');
  });
});

test('停笔自动保存零答案，保存中继续输入不丢失，旧版草稿版本接续并刷新恢复',async()=>{
  await withPages(async({app,page,login})=>{
    let pupil=await page();await login(pupil,'pupil4',studentPassword);pupil.click('a[href="#/assignment/33"]');await waitFor(()=>pupil.d.querySelector('#answer-form'),'打开旧草稿');
    assert.equal(pupil.d.querySelector('#answer-1').value,'13');assert.equal(app.db.prepare('SELECT draft_revision FROM submissions WHERE assignment_id=33 AND student_id=4').get().draft_revision,17);
    let release,received;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{received=r;});const original=pupil.w.fetch;
    pupil.w.fetch=async(path,options)=>{const response=await original(path,options);if(!String(path).endsWith('/draft'))return response;received();await gate;return response;};
    pupil.fill('answer-2',0);pupil.d.querySelector('#answer-2').focus();await started;
    assert.ok(pupil.d.querySelector('#save-state').textContent.includes('正在保存'));assert.equal(pupil.d.querySelector('#answer-2').disabled,false);
    const input=pupil.d.querySelector('#answer-3');pupil.fill('answer-3',9);input.focus();release();
    await waitFor(()=>pupil.d.querySelector('#save-state').textContent.startsWith('已保存')&&app.db.prepare('SELECT draft_revision FROM submissions WHERE assignment_id=33 AND student_id=4').get().draft_revision===19,'后续输入再次自动保存');
    assert.equal(pupil.d.activeElement,input);assert.equal(input.value,'9');assert.equal(pupil.d.querySelector('#answer-2').value,'0');
    const session=pupil.session;pupil.w.close();pupil=await page(session,'#/assignment/33');assert.equal(pupil.d.querySelector('#answer-2').value,'0');assert.equal(pupil.d.querySelector('#answer-3').value,'9');
    const teacher=await page();await login(teacher,'teacher',teacherPassword);teacher.w.location.hash='#/assignment/33?classId=1';await waitFor(()=>teacher.d.querySelector('.report-stats'),'草稿仍未交');assert.ok(teacher.d.querySelector('.report-stats').textContent.includes('未交'));
  },createRevisionClass);
});

test('单题超范围时自动保存其他题，保存并离开可选择修正或保留原值', async () => {
  await withPages(async ({ app, page, login }) => {
    const { ids } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '先保存会做的题');
    const pupil = await page();
    await login(pupil, 'lin', 'Teacher123!');
    const open = async () => {
      pupil.click(`a[href="#/assignment/${id}"]`);
      await waitFor(() => pupil.d.querySelector('#answer-form'), '打开草稿');
    };
    const saved = () => app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id, ids.lin);
    await open();
    pupil.fill('answer-0', 8);
    pupil.fill('answer-2', 3);
    pupil.click('[data-action="save"]');
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.startsWith('已保存'), '保存原答案');
    pupil.fill('answer-0', 200);
    pupil.fill('answer-1', 0);
    pupil.fill('answer-2', '');
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.includes('第 1 题需修改'), '提示具体题号');
    assert.equal(pupil.d.querySelector('#answer-0').value, '200');
    assert.deepEqual(JSON.parse(saved().answers).slice(0, 3), [8, 0, null]);
    pupil.click('[data-submit]');
    assert.equal(pupil.d.querySelector('dialog').open, false);
    let confirmation;
    pupil.w.confirm = message => { confirmation = message; return false; };
    pupil.click('[data-action="save-leave"]');
    await waitFor(() => confirmation, '留页修改');
    assert.match(confirmation, /第 1 题/);
    assert.equal(pupil.d.querySelector('#answer-0').value, '200');
    pupil.w.confirm = () => true;
    pupil.click('[data-action="save-leave"]');
    await waitFor(() => pupil.d.querySelector('.student-card'), '确认跳过无效输入后离开');
    await open();
    assert.deepEqual([0, 1, 2].map(i => pupil.d.querySelector(`#answer-${i}`).value), ['8', '0', '']);
    assert.equal(saved().submitted_at, null);
    assert.equal(saved().score, null);
  });
});

test('保存并离开等待进行中的写入和最新修改，断网时留在作业页', async () => {
  await withPages(async ({ app, page, login }) => {
    const { ids } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '保存最新修改');
    const pupil = await page();
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="#/assignment/${id}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-form'), '打开作业');
    pupil.session.failPath = '/draft';
    pupil.fill('answer-0', 1);
    pupil.click('[data-action="save-leave"]');
    await waitFor(() => pupil.d.querySelector('#answer-error')?.textContent.includes('连接失败'), '断网留页');
    assert.equal(pupil.d.querySelector('#answer-0').value, '1');
    pupil.session.failPath = '';
    const original = pupil.w.fetch;
    let release;
    pupil.w.fetch = async (path, options) => {
      const response = await original(path, options);
      if (path.endsWith('/draft') && !release) await new Promise(resolve => { release = resolve; });
      return response;
    };
    pupil.click('[data-action="save"]');
    await waitFor(() => release, '服务器已写入，回包尚未返回');
    pupil.fill('answer-1', 0);
    pupil.click('[data-action="save-leave"]');
    pupil.click('[data-action="save-leave"]');
    assert.ok(pupil.d.querySelector('#answer-form'));
    release();
    await waitFor(() => pupil.d.querySelector('.student-card'), '最新修改写入后离开');
    const stored = app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id, ids.lin);
    assert.deepEqual(JSON.parse(stored.answers).slice(0, 2), [1, 0]);
    assert.equal(stored.draft_revision, 2);
    assert.equal(stored.submitted_at, null);
  });
});

test('自动保存遇到登录过期，重开浏览器后只有原账号可恢复最新输入', async () => {
  await withPages(async ({ app, page, login }) => {
    const { ids } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '重新登录续写');
    const route = `#/assignment/${id}`;
    let pupil = await page();
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="${route}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-form'), '打开作业');
    app.db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(ids.lin);
    pupil.fill('answer-0', 0);
    pupil.fill('answer-1', 999);
    await waitFor(() => pupil.d.querySelector('#login-form'), '自动保存要求重新登录');
    assert.equal(pupil.d.querySelector('#answer-form'), null);
    const storage = { ...pupil.w.localStorage };
    pupil.w.close();
    pupil = await page({ cookie: '' }, route, storage);
    await login(pupil, 'nan', 'Teacher123!');
    assert.ok(pupil.d.querySelector('.student-card'));
    pupil.click(`a[href="${route}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-form'), '同班另一账号打开相同作业');
    assert.equal(pupil.d.querySelector('#answer-0').value, '');
    assert.equal(pupil.d.querySelector('#answer-1').value, '');
    pupil.click('[data-action="logout"]');
    await waitFor(() => pupil.d.querySelector('#login-form'), '换回原账号');
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="${route}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-0')?.value === '0', '原账号恢复答案');
    assert.equal(pupil.d.querySelector('#answer-1').value, '999');
    assert.equal(pupil.d.querySelector('#progress').value, 2);
    const stored = () => app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id, ids.lin);
    await waitFor(() => pupil.d.querySelector('#save-state').textContent.includes('其他答案已保存'), '恢复后自动同步');
    assert.deepEqual(JSON.parse(stored().answers).slice(0, 2), [0, null]);
    pupil.fill('answer-1', 7);
    pupil.click('[data-action="save-leave"]');
    await waitFor(() => pupil.d.querySelector('.student-card'), '修正后离开');
    assert.deepEqual(JSON.parse(stored().answers).slice(0, 2), [0, 7]);
    assert.equal(stored().submitted_at, null);
    assert.equal(pupil.w.localStorage.length, 0);
  });
});

test('共享会话切换账号后旧页面的保存被拦截，原账号登录回原卷并处理较新版本', async () => {
  await withPages(async ({ app, page, login }) => {
    const { ids } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '切换共享会话'), route = `#/assignment/${id}`;
    const pupil = await page(), other = await page();
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="${route}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-form'), '打开原卷');
    const sameAccount = await page({ ...pupil.session }, route);
    await login(other, 'nan', 'Teacher123!');
    pupil.session.cookie = other.session.cookie;
    pupil.fill('answer-0', 6);
    pupil.click('[data-action="save-leave"]');
    await waitFor(() => pupil.d.querySelector('#login-form'), '旧页面重新核对身份');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=?').get(id).n, 0);
    sameAccount.fill('answer-0', 9);
    sameAccount.click('[data-action="save"]');
    await waitFor(() => sameAccount.d.querySelector('#save-state').textContent.startsWith('已保存'), '另一窗口先写入');
    await login(pupil, 'lin', 'Teacher123!');
    assert.equal(pupil.w.location.hash, route);
    assert.equal(pupil.d.querySelector('#answer-0').value, '6');
    assert.equal(pupil.d.querySelector('#draft-conflict').hidden, false);
    pupil.click('[data-action="save-leave"]');
    assert.equal(pupil.w.location.hash, route);
    const saved = app.db.prepare('SELECT answers FROM submissions WHERE assignment_id=? AND student_id=?').get(id, ids.lin);
    assert.equal(JSON.parse(saved.answers)[0], 9);
    pupil.click('[data-action="load-saved-draft"]');
    await waitFor(() => pupil.d.querySelector('#answer-0')?.value === '9', '明确载入账号中草稿');
    assert.equal(pupil.w.localStorage.length, 0);
  });
});

test('登录中断后原卷已提交，恢复时显示批改结果并移除待恢复的答案', async () => {
  await withPages(async ({ app, page, login }) => {
    const { ids, key } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '已提交草稿锁定'), route = `#/assignment/${id}`;
    const pupil = await page();
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="${route}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-form'), '打开原卷');
    pupil.fill('answer-0', 19);
    pupil.session.cookie = '';
    pupil.submit('answer-form');
    pupil.click('#confirm-submit');
    await waitFor(() => pupil.d.querySelector('#login-form'), '提交时登录已失效');
    const other = await page();
    await login(other, 'lin', 'Teacher123!');
    const response = await other.w.fetch(`/api/assignments/${id}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: key })
    });
    assert.ok(response.ok);
    await login(pupil, 'lin', 'Teacher123!');
    assert.ok(pupil.d.querySelector('.score-stamp'));
    assert.equal(pupil.d.querySelector('#answer-0').value, String(key[0]));
    assert.equal(pupil.d.querySelector('[data-action="save-leave"]'), null);
    assert.equal(pupil.w.localStorage.length, 0);
    assert.equal(app.db.prepare('SELECT draft_revision FROM submissions WHERE assignment_id=? AND student_id=?').get(id, ids.lin).draft_revision, 1);
  });
});

test('自动草稿断网和响应丢失保留输入可重试，到截止后仍自动保存且保持未交',async()=>{
  await withPages(async({app,page,login})=>{
    const ids=seedAnalytics(app.db), id=publishAssignment(app.db,'逾期仍自动保存',{dueAt:'2020-01-01T00:00:00Z'}),pupil=await page();await login(pupil,'lin','Teacher123!');
    pupil.click(`a[href="#/assignment/${id}"]`);await waitFor(()=>pupil.d.querySelector('#answer-form'),'打开逾期作业');assert.equal(pupil.d.querySelector('[data-submit]').disabled,true);
    pupil.session.failPath='/draft';pupil.fill('answer-2',0);await waitFor(()=>pupil.d.querySelector('#save-state').textContent.includes('保存失败'),'自动保存失败');assert.equal(pupil.d.querySelector('#answer-2').value,'0');
    pupil.session.failPath='';const original=pupil.w.fetch;let lose=true;
    pupil.w.fetch=async(path,options)=>{const response=await original(path,options);if(lose&&String(path).endsWith('/draft')){lose=false;throw new Error('响应丢失');}return response;};
    pupil.w.dispatchEvent(new pupil.w.Event('online'));await waitFor(()=>app.db.prepare('SELECT draft_revision FROM submissions WHERE assignment_id=? AND student_id=?').get(id,ids.ids.lin)?.draft_revision===1,'服务器已保存但响应丢失');
    await waitFor(()=>pupil.d.querySelector('#save-state').textContent.includes('保存失败'),'回包丢失提示');pupil.click('[data-action="save"]');
    await waitFor(()=>pupil.d.querySelector('#save-state').textContent.startsWith('已保存'),'同版本重试');
    const stored=app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id,ids.ids.lin);assert.equal(stored.draft_revision,1);assert.equal(stored.submitted_at,null);assert.equal(stored.score,null);assert.equal(JSON.parse(stored.answers)[2],0);
    const refreshed=await page(pupil.session,`#/assignment/${id}`);assert.equal(refreshed.d.querySelector('#answer-2').value,'0');assert.equal(refreshed.d.querySelector('[data-submit]').disabled,true);
  });
});

test('两个窗口的自动草稿冲突暂停保存，保留本页答案或载入新草稿须明确选择',async()=>{
  await withPages(async({app,page,login})=>{
    const ids=seedAnalytics(app.db),id=publishAssignment(app.db,'两窗口草稿'),first=await page();await login(first,'lin','Teacher123!');first.click(`a[href="#/assignment/${id}"]`);await waitFor(()=>first.d.querySelector('#answer-form'),'第一窗口');
    const second=await page(first.session,`#/assignment/${id}`);first.fill('answer-0',0);await waitFor(()=>first.d.querySelector('#save-state').textContent.startsWith('已保存'),'先保存');
    second.fill('answer-0',9);await waitFor(()=>second.d.querySelector('#draft-conflict')&&!second.d.querySelector('#draft-conflict').hidden,'旧窗口冲突');
    assert.equal(second.d.querySelector('#answer-0').value,'9');assert.ok(second.d.querySelector('#save-state').textContent.includes('已暂停'));assert.equal(second.d.querySelector('[data-submit]').disabled,false);
    const stored=()=>app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id,ids.ids.lin);
    assert.equal(JSON.parse(stored().answers)[0],0);second.w.confirm=()=>false;second.click('[data-action="keep-local-draft"]');assert.equal(stored().draft_revision,1);
    second.w.confirm=()=>true;second.click('[data-action="keep-local-draft"]');await waitFor(()=>second.d.querySelector('#save-state').textContent.startsWith('已保存'),'明确保留本页答案');assert.equal(stored().draft_revision,2);assert.equal(JSON.parse(stored().answers)[0],9);
    first.fill('answer-1',8);await waitFor(()=>!first.d.querySelector('#draft-conflict').hidden,'第一窗口变为旧版本');first.click('[data-action="load-saved-draft"]');await waitFor(()=>first.d.querySelector('#answer-0')?.value==='9','载入较新草稿');assert.equal(first.d.querySelector('#answer-1').value,'');
  });
});

test('50 题交卷确认按顺序列出漏题，点击题号可直接补答，填 0 后更新清单', async () => {
  await withPages(async ({ app, page, login }) => {
    seedAnalytics(app.db);
    const id = publishAssignment(app.db, '查找漏题', { questionCount: 50 });
    const pupil = await page();
    await login(pupil, 'lin', 'Teacher123!');
    pupil.click(`a[href="#/assignment/${id}"]`);
    await waitFor(() => pupil.d.querySelector('#answer-49'), '打开 50 题作业');
    const buttons = () => [...pupil.d.querySelectorAll('#missing-questions button')];
    const labels = () => buttons().map(button => button.textContent);
    const dialog = pupil.d.querySelector('#submit-dialog');

    pupil.click('[data-submit]');
    assert.deepEqual(labels(), Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 题`));
    buttons()[49].click();
    assert.equal(dialog.open, false);
    assert.equal(pupil.d.activeElement.id, 'answer-49');
    for (let n = 1; n <= 50; n++) {
      if (n !== 2 && n !== 31) pupil.fill(`answer-${n - 1}`, 0);
    }
    pupil.click('[data-submit]');
    assert.match(pupil.d.querySelector('#missing-summary').textContent, /还有 2 题没答/);
    assert.deepEqual(labels(), ['第 2 题', '第 31 题']);
    buttons()[1].click();
    assert.equal(pupil.d.activeElement.id, 'answer-30');
    pupil.fill('answer-30', 3);
    pupil.click('[data-submit]');
    assert.deepEqual(labels(), ['第 2 题']);
    buttons()[0].click();
    assert.equal(pupil.d.activeElement.id, 'answer-1');
    pupil.fill('answer-1', 0);
    pupil.click('[data-submit]');
    assert.equal(dialog.open, true);
    assert.equal(pupil.d.querySelector('#submit-missing').hidden, true);
    assert.deepEqual(labels(), []);
    assert.equal(pupil.d.querySelector('#confirm-submit').textContent, '确认提交');
    pupil.click('#cancel-submit');
    assert.equal(pupil.d.querySelector('#answer-30').value, '3');
    assert.equal(pupil.d.querySelector('#answer-49').value, '0');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=? AND submitted_at IS NOT NULL').get(id).n, 0);
  });
});

test('漏题确认可返回补答，自动保存期间交卷顺序正确，80分原卷与错题本明确标注漏答',async()=>{
  await withPages(async({app,page,login})=>{
    const ids=seedAnalytics(app.db),id=publishAssignment(app.db,'先交会做的题'),questions=JSON.parse(app.db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions),pupil=await page();await login(pupil,'lin','Teacher123!');
    pupil.click(`a[href="#/assignment/${id}"]`);await waitFor(()=>pupil.d.querySelector('#answer-form'),'打开练习');questions.slice(0,8).forEach((q,i)=>pupil.fill(`answer-${i}`,solution(q)));
    pupil.submit('answer-form');assert.ok(pupil.d.querySelector('#submit-missing').textContent.includes('2 题没答'));assert.equal(pupil.d.querySelector('#confirm-submit').textContent,'确认按现有答案交卷');pupil.click('#cancel-submit');assert.equal(pupil.d.querySelector('dialog').open,false);assert.equal(pupil.d.querySelector('.score-stamp'),null);
    let release,received;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{received=r;});const original=pupil.w.fetch;
    pupil.w.fetch=async(path,options)=>{const response=await original(path,options);if(!String(path).endsWith('/draft'))return response;received();await gate;return response;};
    await started;pupil.submit('answer-form');pupil.click('#confirm-submit');assert.equal(pupil.d.querySelector('#answer-form fieldset').disabled,true);release();
    await waitFor(()=>pupil.d.querySelector('.score-stamp strong')?.textContent==='80','80分交卷');assert.equal([...pupil.d.querySelectorAll('.question-feedback')].filter(n=>n.textContent.includes('漏答')).length,2);
    const submitted=app.db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(id,ids.ids.lin);assert.equal(submitted.draft_revision,2);assert.equal(JSON.parse(submitted.answers).filter(a=>a===null).length,2);
    pupil.click('nav a[href="#/mistakes"]');await waitFor(()=>pupil.d.querySelector(`[data-mistake="${id}:9"]`),'漏答进入错题本');assert.ok(pupil.d.querySelector(`[data-mistake="${id}:9"]`).textContent.includes('漏答（未填）'));
    pupil.click(`[data-mistake="${id}:9"] .mistake-origin`);await waitFor(()=>pupil.d.querySelector('.source-question'),'漏答回原卷');assert.ok(pupil.d.querySelector('.source-question').textContent.includes('漏答'));
    const teacher=await page();await login(teacher,'teacher','Teacher123!');teacher.w.location.hash=`#/assignment/${id}/student/${ids.ids.lin}?classId=1`;await waitFor(()=>teacher.d.querySelector('.review-summary'),'教师原卷');assert.equal(teacher.d.querySelector('[data-review-question="8"] .review-verdict').textContent,'漏答');
    teacher.w.location.hash=`#/analytics?classId=1&from=&to=&assignmentId=${id}&questionNumber=9`;await waitFor(()=>teacher.d.querySelector('#analytics-detail'),'漏答统计');assert.equal(teacher.d.querySelector('#analytics-detail .analytics-counts>div:nth-child(3) dd').textContent,'1 人');assert.equal(teacher.d.querySelector(`[data-analytics-student="${ids.ids.lin}"] .analytics-status`).textContent,'漏答');
  });
});

test('学生自行改密与教师按学号重设同名学生，提示、权限、重新登录和草稿保留', async () => {
  await withPages(async ({ app, page, login }) => {
    const ids = seedAnalytics(app.db), pupil = await page(); await login(pupil,'lin','Teacher123!');
    pupil.click('nav a[href="#/password"]');await waitFor(()=>pupil.d.querySelector('#password-form'),'学生改密');
    pupil.fill('currentPassword','wrong');pupil.fill('newPassword','MyStudent123!');pupil.fill('confirmPassword','Mismatch123!');pupil.submit('password-form');
    await waitFor(()=>pupil.d.querySelector('#password-error').textContent.includes('不一致'),'重复密码校验');
    pupil.fill('confirmPassword','MyStudent123!');pupil.submit('password-form');await waitFor(()=>pupil.d.querySelector('#password-error').textContent.includes('原密码不正确'),'原密码校验');
    pupil.fill('currentPassword','Teacher123!');pupil.submit('password-form');await waitFor(()=>pupil.d.querySelector('#password-success').textContent.includes('密码已修改'),'改密成功');
    assert.equal(pupil.d.querySelector('[name="newPassword"]').value,'');
    pupil.click('[data-action="logout"]');await waitFor(()=>pupil.d.querySelector('#login-form'),'退出');await login(pupil,'lin','MyStudent123!');
    const teacher=await page();await login(teacher,'teacher','Teacher123!');teacher.click('nav a[href="#/students"]');await waitFor(()=>teacher.d.querySelector('#student-form'),'教师名单');
    teacher.fill('studentSearch','draft');teacher.click('.reset-password-link');await waitFor(()=>teacher.d.querySelector('#password-form'),'指定学号重设');
    assert.ok(teacher.d.querySelector('.password-target').textContent.includes('张宁'));assert.ok(teacher.d.querySelector('.password-target').textContent.includes('draft'));
    teacher.fill('newPassword','ResetStudent123!');teacher.fill('confirmPassword','ResetStudent123!');teacher.submit('password-form');await waitFor(()=>teacher.d.querySelector('#password-success').textContent.includes('draft'),'重设反馈');
    const selected=await page();await login(selected,'draft','ResetStudent123!');selected.click(`a[href="#/assignment/${ids.a}"]`);await waitFor(()=>selected.d.querySelector('#answer-form'),'原草稿可续做');assert.equal(selected.d.querySelector('#answer-0').value,'0');
    const sameName=await page();await login(sameName,'nan','Teacher123!');
    teacher.w.location.hash=`#/students/${ids.ids.zhou}/password?classId=1`;await waitFor(()=>teacher.d.querySelector('.empty p')?.textContent.includes('不在当前班级'),'跨班拦截');
  });
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
    await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.textContent.includes('一班'), '原班级改名');
    teacher.fill('className', '二班'); teacher.submit('class-form');
    await waitFor(() => teacher.d.querySelector('[name="currentClass"]')?.value === '2', '创建二班');
    const createStudent = async (username, name) => {
      teacher.fill('name', name); teacher.fill('username', username); teacher.fill('password', 'Student123!'); teacher.submit('student-form');
      await waitFor(() => teacher.d.querySelector('tbody')?.textContent.includes(username), '建立本班学生');
    };
    await createStudent('zhou', '小周'); await changeClass(1); await createStudent('lin', '小林');
    teacher.click('nav a[href="#/"]'); await waitFor(() => teacher.d.querySelector('#publish-form'), '回发布页');
    teacher.fill('title', '只发一班'); await teacher.publish(); await waitFor(() => teacher.d.querySelector('.report-stats'), '单班发布');
    teacher.click('.back-link'); await waitFor(() => teacher.d.querySelector('#publish-form'), '再次发布');
    teacher.fill('title', '两个班同一套题'); teacher.fill('questionCount', 20); teacher.d.querySelector('[name="classIds"][value="2"]').checked = true; await teacher.publish();
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
    teacher.fill('difficulty', 'advanced'); teacher.fill('title', '三年级提高括号'); await teacher.publish();
    await waitFor(() => teacher.d.querySelector('.report-stats'), '发布提高题');
    assert.ok(teacher.d.querySelector('.page-title p').textContent.includes('3 年级 · 提高'));
    const row = app.db.prepare('SELECT difficulty,mixed_grade,knowledge_points FROM assignments').get();
    assert.equal(row.difficulty, 'advanced'); assert.equal(row.mixed_grade, 3); assert.equal(row.knowledge_points, '["parentheses"]');
    for (const item of teacher.d.querySelectorAll('.question-preview span')) assert.ok(item.textContent.includes('('));
  });
});

test('我的作业分组并按本人实际截止排序，已交优先于到期状态，打开首页时到点自动移组', async () => {
  const start = Date.parse('2026-11-24T11:00:00Z');
  let now = start;
  const stamp = minutes => new Date(start + minutes * 60_000).toISOString();
  await withPages(async ({ app, page, login }) => {
    const db = app.db;
    const student = Number(db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT 'sorter','小雨',password_hash,'student' FROM users WHERE role='teacher'").run().lastInsertRowid);
    const paper = (title, options = {}) => publishAssignment(db, title, options);
    const personal = paper('本人时间最少', { timeLimitMinutes: 10, dueAt: stamp(60) });
    const classFirst = paper('以全班截止为准', { timeLimitMinutes: 60, dueAt: stamp(2) });
    const regular = paper('全班三分钟后交', { dueAt: stamp(3) });
    const notStarted = paper('未开始也有全班截止', { timeLimitMinutes: 1, dueAt: stamp(4) });
    const untimed = paper('没有期限');
    const waiting = paper('开始后才限时', { timeLimitMinutes: 1 });
    const expired = paper('之前已到期', { dueAt: stamp(-5) });
    const done = paper('已交零分', { timeLimitMinutes: 1 });
    const begin = db.prepare('INSERT INTO assignment_starts(assignment_id,student_id,started_at) VALUES(?,?,?)');
    begin.run(personal, student, stamp(-9)); begin.run(classFirst, student, stamp(0)); begin.run(done, student, stamp(-15));
    db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)')
      .run(done, student, JSON.stringify(Array(10).fill(null)), stamp(-15), stamp(-15), 0);
    const pupil = await page({ cookie: '', now: () => start + 86400000, monotonic: () => now - start });
    await login(pupil, 'sorter', 'Teacher123!');
    const ids = label => [...pupil.d.querySelectorAll(`.work-group[aria-label="${label}"] .student-card`)].map(card => Number(card.hash.split('/').pop()));
    assert.deepEqual(ids('可提交'), [personal, classFirst, regular, notStarted, waiting, untimed]);
    assert.deepEqual(ids('已截止未交'), [expired]);
    assert.deepEqual(ids('已提交'), [done]);
    const card = id => pupil.d.querySelector(`.student-card[href="#/assignment/${id}"]`);
    assert.match(card(personal).textContent, /个人截止.*19:01/);
    assert.match(card(waiting).textContent, /开始作答后计时/);
    assert.equal(card(done).querySelector('.result-score').textContent.trim(), '0 分');
    now += 60000;
    await waitFor(() => ids('已截止未交').includes(personal), '个人到时自动移出可交组');
    assert.match(card(personal).textContent, /个人限时已到.*不能提交/);
    assert.deepEqual(ids('可提交'), [classFirst, regular, notStarted, waiting, untimed]);
    assert.deepEqual(ids('已提交'), [done]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_starts').get().n, 3);
    now += 60000;
    await waitFor(() => ids('已截止未交').includes(classFirst), '全班截止早于个人限时');
    assert.doesNotMatch(card(classFirst).textContent, /个人限时已到/);
  }, undefined, { clock: () => now });
});

test('教师打开限时成绩表后能获知新开始的计时，每名学生到点单独标明不能提交', async () => {
  let now = Date.parse('2026-11-24T11:00:00Z');
  await withPages(async ({ app, page, login }) => {
    const { ids } = seedAnalytics(app.db);
    const id = publishAssignment(app.db, '各自计时', { timeLimitMinutes: 2, classIds: [1, 2] });
    const teacher = await page({ cookie: '', now: () => now - 86400000, monotonic: () => now });
    await login(teacher, 'teacher', 'Teacher123!');
    teacher.click(`a[href="#/assignment/${id}"]`);
    await waitFor(() => teacher.d.querySelector('#report-progress'), '打开限时成绩表');
    const row = username => [...teacher.d.querySelectorAll('#report-progress tbody tr')].find(tr => tr.children[1].textContent === username);
    assert.equal(row('lin').querySelector('.badge').textContent, '待完成');
    const begin = app.db.prepare('INSERT INTO assignment_starts(assignment_id,student_id,started_at) VALUES(?,?,?)');
    begin.run(id, ids.lin, new Date(now).toISOString());
    now += 60000;
    begin.run(id, ids.nan, new Date(now).toISOString());
    teacher.w.dispatchEvent(new teacher.w.Event('focus'));
    await waitFor(() => row('lin').querySelector('.badge').textContent === '作答中', '已打开的成绩表同步个人起点');
    now += 60000;
    await waitFor(() => row('lin').querySelector('.badge.overdue'), '到点自动更新个人状态');
    assert.match(row('lin').textContent, /个人限时已到.*未交.*不能提交/);
    assert.equal(row('nan').querySelector('.badge').textContent, '作答中');
    assert.equal(row('blank').querySelector('.badge').textContent, '待完成');
    assert.equal(row('zhou'), undefined);
    assert.equal(row('lin').querySelector('.score-cell').textContent, '—');
    assert.deepEqual([...teacher.d.querySelectorAll('.report-stats strong')].map(n => n.firstChild.textContent), ['0', '4', '—']);
    teacher.click('[data-action="refresh"]');
    await waitFor(() => row('lin')?.querySelector('.overdue'), '刷新仍显示个人限时已到');
  }, undefined, { clock: () => now });
});

test('个人限时页面：开始后倒计时、刷新续计、到时保留答案与保存草稿', async () => {
  let current = Date.parse('2026-11-24T11:00:00Z');
  await withPages(async ({ app, page, login }) => {
    const teacher = await page(); await login(teacher, 'teacher', 'Teacher123!');
    app.db.prepare("INSERT INTO users(username,name,password_hash,role) SELECT 'timed','计时学生',password_hash,'student' FROM users WHERE role='teacher'").run();
    teacher.fill('title', '20分钟练习'); teacher.fill('timeLimitMinutes', 20); await teacher.publish();
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
