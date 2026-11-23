import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../backend/app.mjs';
import { generateQuestions, solution } from '../backend/store.mjs';
import { createHistoryClass, historyAssignments, historyDraft, snapshot, studentPassword, teacherPassword } from './history-fixture.mjs';

test('题目符合范围、配比与去重规则', () => {
  for (let round = 0; round < 100; round++) {
    const questions = generateQuestions();
    assert.equal(questions.length, 10);
    assert.equal(questions.filter(q => q.op === '+').length, 5);
    assert.equal(new Set(questions.map(q => JSON.stringify(q))).size, 10);
    for (const q of questions) {
      for (const n of [q.a, q.b, solution(q)]) assert.ok(Number.isInteger(n) && n >= 0 && n <= 20);
    }
  }
});

function apiClient(base) {
  async function request(path, { method = 'GET', data, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, { method, headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...headers
    }, body: data !== undefined ? JSON.stringify(data) : undefined });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(username, password) {
    const result = await request('/api/login', { method: 'POST', data: { username, password } });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  return { request, login };
}

test('真实 HTTP 师生流程、权限、统计与重启持久化', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-test-'));
  const dbPath = join(dir, 'test.sqlite');
  let app, base, request, login;
  async function start() {
    app = await createApp({ dbPath, logger: { error: e => { throw e; } } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    ({ request, login } = apiClient(base));
  }
  async function stop() {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
  let teacher, alice, bob, id, correct;
  await start();
  try {
    await t.test('登录、身份与来源保护', async () => {
      assert.equal((await request('/api/assignments')).status, 401);
      assert.equal((await request('/api/login', { method: 'POST', data: { username: 'teacher', password: 'bad' } })).status, 401);
      assert.equal((await request('/api/login', { method: 'POST', data: { username: 'teacher', password: 'Teacher123!' }, headers: { Origin: 'https://other.example' } })).status, 403);
      teacher = await login('teacher', 'Teacher123!');
      assert.equal((await request('/api/me', { cookie: teacher })).body.role, 'teacher');
      assert.equal((await request('/api/students', { cookie: teacher })).body.length, 0);
    });
    await t.test('教师创建学生、校验与重名处理', async () => {
      for (const [username, name] of [['alice', '小雨'], ['bob', '小明']]) {
        assert.equal((await request('/api/students', { method: 'POST', cookie: teacher,
          data: { username, name, password: 'Student123!' } })).status, 201);
      }
      assert.equal((await request('/api/students', { method: 'POST', cookie: teacher,
        data: { username: 'alice', name: '重复', password: 'Student123!' } })).status, 409);
      assert.equal((await request('/api/students', { method: 'POST', cookie: teacher,
        data: { username: 'other', name: '短密码', password: '123' } })).status, 400);
      alice = await login('alice', 'Student123!'); bob = await login('bob', 'Student123!');
      assert.equal((await request('/api/students', { cookie: alice })).status, 403);
      assert.equal((await request('/api/students', { method: 'POST', cookie: alice,
        data: { username: 'evil', name: '越权', password: 'Student123!' } })).status, 403);
    });
    await t.test('发布并展示十道题，禁止学生发布和读取全班成绩', async () => {
      const published = await request('/api/assignments', { method: 'POST', cookie: teacher, data: { title: '第一次数学练习' } });
      assert.equal(published.status, 201); id = published.body.id;
      correct = published.body.questions.map(solution);
      assert.equal(published.body.pending, 2); assert.equal(published.body.average, null);
      assert.equal((await request('/api/assignments', { method: 'POST', cookie: alice, data: { title: '越权' } })).status, 403);
      assert.equal((await request(`/api/assignments/${id}/report`, { cookie: alice })).status, 403);
      const view = (await request(`/api/assignments/${id}`, { cookie: alice })).body;
      assert.equal(view.category, 'add-sub-20'); assert.equal(view.answerMax, 20);
      assert.equal(view.questions.length, 10); assert.equal(view.results, undefined);
      assert.equal(view.students, undefined); assert.equal(view.score, null);
      assert.equal((await request('/api/assignments/9999', { cookie: alice })).status, 404);
    });
    await t.test('草稿持久化、按会话隔离且不信任 student_id', async () => {
      const partial = [correct[0], ...Array(9).fill(null)];
      const saved = await request(`/api/assignments/${id}/draft`, { method: 'PUT', cookie: alice, data: { answers: partial, student_id: 3 } });
      assert.equal(saved.status, 200); assert.ok(saved.body.savedAt); assert.equal(saved.body.results, undefined);
      const own = (await request(`/api/assignments/${id}?student_id=3`, { cookie: alice })).body;
      assert.deepEqual(own.answers, partial);
      assert.deepEqual((await request(`/api/assignments/${id}?student_id=2`, { cookie: bob })).body.answers, Array(10).fill(null));
      assert.equal((await request(`/api/assignments/${id}/submit`, { method: 'POST', cookie: alice, data: { answers: partial } })).status, 400);
      for (const answers of [Array(9).fill(1), Array(10).fill('1'), Array(10).fill(21), Array(10).fill(1.5)]) {
        assert.equal((await request(`/api/assignments/${id}/draft`, { method: 'PUT', cookie: alice, data: { answers } })).status, 400);
      }
    });
    await t.test('服务器评分、重复提交、锁定答案及平均分', async () => {
      const wrong = [...correct]; wrong[0] = correct[0] === 20 ? 19 : correct[0] + 1;
      const submitted = await request(`/api/assignments/${id}/submit`, { method: 'POST', cookie: alice, data: { answers: wrong, score: 100 } });
      assert.equal(submitted.body.score, 90); assert.equal(submitted.body.results[0].correct, false);
      assert.equal(submitted.body.results[0].correctAnswer, correct[0]);
      assert.equal((await request(`/api/assignments/${id}/submit`, { method: 'POST', cookie: alice, data: { answers: correct } })).body.score, 90);
      assert.equal((await request(`/api/assignments/${id}/draft`, { method: 'PUT', cookie: alice, data: { answers: correct } })).status, 409);
      let report = (await request(`/api/assignments/${id}/report`, { cookie: teacher })).body;
      assert.equal(report.submitted, 1); assert.equal(report.pending, 1); assert.equal(report.average, 90);
      assert.equal((await request(`/api/assignments/${id}/submit`, { method: 'POST', cookie: bob, data: { answers: correct } })).body.score, 100);
      report = (await request(`/api/assignments/${id}/report`, { cookie: teacher })).body;
      assert.equal(report.average, 95); assert.equal(report.submitted, 2); assert.equal(report.pending, 0);
      assert.deepEqual(report.students.map(s => s.score), [90, 100]);
      const list = (await request('/api/assignments', { cookie: bob })).body;
      assert.equal(list[0].score, 100); assert.equal(list[0].students, undefined);
    });
    await t.test('新学生可见历史作业，统计计入当前名单', async () => {
      await request('/api/students', { method: 'POST', cookie: teacher, data: { username: 'carol', name: '小红', password: 'Student123!' } });
      const carol = await login('carol', 'Student123!');
      assert.equal((await request('/api/assignments', { cookie: carol })).body.length, 1);
      const report = (await request(`/api/assignments/${id}/report`, { cookie: teacher })).body;
      assert.equal(report.total, 3); assert.equal(report.pending, 1); assert.equal(report.average, 95);
      await request(`/api/assignments/${id}/draft`, { method: 'PUT', cookie: carol, data: { answers: [1, ...Array(9).fill(null)] } });
    });
    await t.test('重开无类别列的首版旧库，保留账号、会话、题目、草稿及成绩', async () => {
      const before = snapshot(app.db);
      assert.ok(!app.db.prepare('PRAGMA table_info(assignments)').all().some(column => column.name === 'category'));
      await stop(); await start();
      assert.deepEqual(snapshot(app.db), before);
      assert.equal((await request('/api/me', { cookie: teacher })).status, 200);
      const report = (await request(`/api/assignments/${id}/report`, { cookie: teacher })).body;
      assert.equal(report.average, 95); assert.equal(report.students.length, 3);
      const carol = await login('carol', 'Student123!');
      assert.equal((await request(`/api/assignments/${id}`, { cookie: carol })).body.answers[0], 1);
      assert.equal((await request(`/api/assignments/${id}`, { cookie: alice })).body.score, 90);
    });
    await t.test('延迟到达的草稿和重复提交不能覆盖已交结果', async () => {
      const published = await request('/api/assignments', { method: 'POST', cookie: teacher, data: { title: '并发提交检查' } });
      assert.equal(published.status, 201); assert.equal(published.body.category, 'add-sub-20');
      const raceId = published.body.id;
      const answers = published.body.questions.map(solution);
      const wrong = answers.map(v => (v + 1) % 21);
      for (const [action, method, session, expected] of [['draft', 'PUT', alice, 409], ['submit', 'POST', bob, 200]]) {
        const payload = JSON.stringify({ answers: wrong });
        const received = new Promise(resolve => app.server.once('request', resolve));
        let slow;
        const response = new Promise((resolve, reject) => {
          slow = httpRequest(`${base}/api/assignments/${raceId}/${action}`, { method,
            headers: { Cookie: session, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
            let data = ''; res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
          });
          slow.on('error', reject); slow.write(payload.slice(0, 12));
        });
        try {
          await received;
          assert.equal((await request(`/api/assignments/${raceId}/submit`, { method: 'POST', cookie: session, data: { answers } })).body.score, 100);
          slow.end(payload.slice(12));
          const delayed = await response;
          assert.equal(delayed.status, expected);
          if (action === 'submit') assert.equal(delayed.body.score, 100);
          const final = (await request(`/api/assignments/${raceId}`, { cookie: session })).body;
          assert.equal(final.score, 100); assert.deepEqual(final.answers, answers);
        } finally { slow.destroy(); }
      }
    });
    await t.test('退出注销服务端会话，密码不明文保存', async () => {
      const row = app.db.prepare("SELECT password_hash FROM users WHERE username='alice'").get();
      assert.ok(!row.password_hash.includes('Student123!'));
      assert.equal((await request('/api/logout', { method: 'POST', cookie: alice })).status, 200);
      assert.equal((await request('/api/me', { cookie: alice })).status, 401);
      app.db.prepare('UPDATE sessions SET expires=0').run();
      assert.equal((await request('/api/me', { cookie: teacher })).status, 401);
    });
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('INC-001 已有班级在合成迁移库副本上继续使用', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const backup = join(dir, 'backup.sqlite'), dbPath = join(dir, 'class.sqlite');
  const before = await createHistoryClass(backup);
  await copyFile(backup, dbPath);
  const { db, server } = await createApp({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { request, login } = apiClient(`http://127.0.0.1:${server.address().port}`);
  try {
    const teacher = await login('teacher', teacherPassword);
    const students = [];
    for (const id of [2, 3, 4]) students.push(await login(`pupil${id}`, studentPassword));
    await t.test('原密码可登录，三份原题、六条成绩与一份草稿按原值读取', async () => {
      const roster = await request('/api/students', { cookie: teacher });
      assert.deepEqual(roster.body.map(s => s.username), ['pupil2', 'pupil3', 'pupil4']);
      const list = await request('/api/assignments', { cookie: teacher });
      assert.equal(list.body.length, 3);
      for (const a of historyAssignments) {
        const report = (await request(`/api/assignments/${a.id}/report`, { cookie: teacher })).body;
        assert.deepEqual(list.body.find(row => row.id === a.id), report);
        assert.equal(report.category, a.category);
        assert.deepEqual(report.questions, a.questions);
        assert.equal(report.submitted, 2); assert.equal(report.pending, 1);
        const stored = before.submissions.filter(s => s.assignment_id === a.id && s.submitted_at);
        assert.equal(report.average, (stored[0].score + stored[1].score) / 2);
        for (const [i, row] of stored.entries()) {
          const cookie = students[i];
          const path = `/api/assignments/${a.id}`;
          const view = (await request(path, { cookie })).body;
          assert.deepEqual(view.answers, JSON.parse(row.answers));
          assert.equal(view.savedAt, row.saved_at); assert.equal(view.submittedAt, row.submitted_at);
          assert.deepEqual(view.results, a.key.map((correctAnswer, j) => ({ correctAnswer, correct: correctAnswer === view.answers[j] })));
          assert.equal(view.results.filter(r => r.correct).length * 10, row.score);
          assert.equal(view.score, row.score); assert.equal(report.students[i].score, row.score);
          const retry = await request(path + '/submit', { method: 'POST', cookie, data: { answers: a.key } });
          assert.equal(retry.status, 200); assert.deepEqual(retry.body, view);
          assert.equal((await request(path + '/draft', { method: 'PUT', cookie, data: { answers: a.key } })).status, 409);
        }
      }
      assert.deepEqual(snapshot(db), before);
    });
    const cookie = students[2];
    await t.test('混合题草稿续答、范围校验、提交与教师汇总', async () => {
      const path = '/api/assignments/33';
      const get = async () => (await request(path, { cookie })).body;
      const put = answers => request(path + '/draft', { method: 'PUT', cookie, data: { answers } });
      const submit = answers => request(path + '/submit', { method: 'POST', cookie, data: { answers } });
      const draft = await get();
      assert.deepEqual(draft.answers, historyDraft); assert.equal(draft.results, undefined);
      assert.equal(draft.answerMax, 100);
      for (const value of [-1, 101, 1.5, '27']) {
        assert.equal((await put([value, ...historyDraft.slice(1)])).status, 400);
      }
      const partial = [27, ...historyDraft.slice(1)];
      assert.equal((await put(partial)).status, 200);
      assert.deepEqual((await get()).answers, partial);
      assert.equal((await submit(partial)).status, 400);
      const answers = [...historyAssignments[2].key]; answers[1] = 17;
      const marked = await submit(answers);
      assert.equal(marked.status, 200); assert.equal(marked.body.score, 90);
      assert.deepEqual(marked.body.results[1], { correct: false, correctAnswer: 13 });
      assert.equal((await put(partial)).status, 409);
      const report = (await request(path + '/report', { cookie: teacher })).body;
      assert.deepEqual(report.students.map(s => s.score), [80, 70, 90]);
      assert.equal(report.average, 80);
    });
    await t.test('未开始的乘除题仍校验 0–20，新发布仍是十道加减', async () => {
      const path = '/api/assignments/22';
      const blank = (await request(path, { cookie })).body;
      assert.deepEqual(blank.answers, Array(10).fill(null)); assert.equal(blank.answerMax, 20);
      assert.equal((await request(path + '/draft', { method: 'PUT', cookie, data: { answers: Array(10).fill(21) } })).status, 400);
      const marked = await request(path + '/submit', { method: 'POST', cookie, data: { answers: historyAssignments[1].key } });
      assert.equal(marked.status, 200); assert.equal(marked.body.score, 100);
      const published = await request('/api/assignments', { method: 'POST', cookie: teacher, data: { title: '迁移后的第一份新作业' } });
      assert.equal(published.status, 201);
      assert.equal(published.body.category, 'add-sub-20'); assert.equal(published.body.answerMax, 20);
      for (const op of ['+', '-']) assert.equal(published.body.questions.filter(q => q.op === op).length, 5);
      const freshPath = `/api/assignments/${published.body.id}/submit`;
      assert.equal((await request(freshPath, { method: 'POST', cookie, data: { answers: Array(10).fill(27) } })).status, 400);
      const after = snapshot(db);
      assert.deepEqual(after.users, before.users);
      assert.deepEqual(after.assignments.slice(0, 3), before.assignments);
      assert.deepEqual(after.submissions.filter(s => s.student_id !== 4), before.submissions.filter(s => s.submitted_at));
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  }
});
