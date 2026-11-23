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
async function withPages(run, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-ui-'));
  const dbPath = join(dir, 'ui.sqlite');
  if (seed) await seed(dbPath);
  const app = await createApp({ dbPath });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const web = createWebServer({ apiPort: app.server.address().port });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${web.address().port}`;
  const windows = [];
  async function page(session = { cookie: '' }, hash = '#/') {
    const dom = new JSDOM(html, { url: base + '/' + hash, runScripts: 'outside-only' });
    const w = dom.window; windows.push(w);
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
