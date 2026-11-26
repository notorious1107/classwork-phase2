import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { solution, generateQuestions, formatExpression } from '../backend/store.mjs';
import { practiceOptions } from '../backend/questions.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-phase3-'));
  let current = Date.parse('2026-11-24T11:00:00Z'), app;
  const start = async () => {
    app = await createApp({ dbPath: join(dir, 'test.sqlite'), clock: () => current });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  const request = async (path, cookie, method = 'GET', data) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async username => {
    const result = await request('/login', null, 'POST', { username, password: username === 'teacher' ? 'Teacher123!' : 'Student123!' });
    assert.equal(result.status, 200); return result.cookie;
  };
  await start();
  try {
    const teacher = await login('teacher');
    const student = async (username, classId) => {
      const made = await request('/students', teacher, 'POST', { username, name: username, password: 'Student123!', ...(classId === undefined ? {} : { classId }) });
      assert.equal(made.status, 201); return { ...made.body, cookie: await login(username) };
    };
    await run({ request, login, teacher, student, db: () => app.db, time: value => { current = Date.parse(value); }, restart: async () => { await stop(); await start(); } });
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}

test('转班后按发布时班级查原卷和成绩，多班同卷只计一次，新班的个人记录保留老卷', async () => {
  await fixture(async ({ request, teacher, student, restart }) => {
    const other = (await request('/classes', teacher, 'POST', { name: '二班' })).body.id;
    const rain = await student('xiaoyu', 1), classmate = await student('classmate', other);
    const publish = async (title, classIds) => (await request('/assignments', teacher, 'POST', { title, classIds })).body;
    const solo = await publish('一班加减法', [1]), shared = await publish('两班同卷', [1, other]);
    const answers = solo.questions.map(solution);
    const submit = (work, values) => request(`/assignments/${work.id}/submit`, rain.cookie, 'POST', { answers: values });
    const original = (await submit(solo, answers)).body;
    assert.equal(original.score, 100);
    assert.equal((await request(`/students/${rain.id}`, teacher, 'PUT', { classId: other })).status, 200);
    // Submission after transfer must still use the class at publication, even for a zero score.
    assert.equal((await submit(shared, shared.questions.map(q => solution(q) === 0 ? 1 : 0))).body.score, 0);
    const later = await publish('转班后的二班练习', [other]);
    const unrelated = await publish('转班后的一班新卷', [1]);
    await restart();
    for (const work of [solo, shared]) {
      const score = work.id === solo.id ? 100 : 0;
      const path = `/assignments/${work.id}`;
      const report = (await request(path + '/report?classId=1', teacher)).body;
      assert.deepEqual(report.students.map(s => s.id), [rain.id]);
      assert.equal(report.submitted, 1); assert.equal(report.average, score);
      const review = (await request(`${path}/students/${rain.id}?classId=1`, teacher)).body;
      assert.equal(review.reviewClassId, 1); assert.equal(review.student.classId, other); assert.equal(review.score, score);
      assert.equal((await request(`${path}/students/${rain.id}?classId=${other}`, teacher)).status, 404);
    }
    const secondReport = (await request(`/assignments/${shared.id}/report?classId=${other}`, teacher)).body;
    assert.deepEqual(secondReport.students.map(s => s.id), [classmate.id]);
    assert.equal(secondReport.average, null); assert.equal(secondReport.pending, 1);
    const history = (await request(`/students/${rain.id}/history?classId=${other}`, teacher)).body.assignments;
    assert.deepEqual(history.map(a => [a.id, a.reviewClassId]), [[later.id, other], [shared.id, 1], [solo.id, 1]]);
    const personal = (await request(`/students/${rain.id}/history/${solo.id}?classId=${other}`, teacher)).body;
    assert.deepEqual(personal.answers, answers); assert.equal(personal.submittedAt, original.submittedAt);
    assert.equal((await request(`/students/${rain.id}/history/${unrelated.id}?classId=${other}`, teacher)).status, 404);
    assert.equal((await request(`/students/${rain.id}/history/${solo.id}?classId=${other}`, classmate.cookie)).status, 403);
    assert.deepEqual((await request('/assignments', rain.cookie)).body.map(a => a.id), [later.id, shared.id, solo.id]);
    assert.deepEqual((await request(`/assignments/${solo.id}`, rain.cookie)).body.answers, answers);
    assert.equal((await request(`/assignments/${solo.id}/draft`, rain.cookie, 'PUT', { answers })).status, 404);
    assert.equal((await request(`/assignments/${solo.id}`, classmate.cookie)).status, 404);
  });
});

test('旧多班库升级恢复单班原卷，无法归班的同卷保留个人记录，重复启动不改归属', async () => {
  await fixture(async ({ db, request, teacher, student, restart }) => {
    const second = (await request('/classes', teacher, 'POST', { name: '二班' })).body.id;
    const third = (await request('/classes', teacher, 'POST', { name: '三班' })).body.id;
    const rain = await student('xiaoyu', second);
    const ids = [];
    for (const classIds of [[second], [1, second]]) {
      const work = (await request('/assignments', teacher, 'POST', { title: '旧库作业', classIds })).body;
      ids.push(work.id);
      assert.equal((await request(`/assignments/${work.id}/submit`, rain.cookie, 'POST', { answers: work.questions.map(solution) })).body.score, 100);
    }
    // Recreate the previous schema, which stored submissions and targets but no per-paper class.
    db().exec('DROP TRIGGER roster_on_publication; DROP TRIGGER roster_on_enrollment; DROP TRIGGER roster_on_transfer; DROP TABLE assignment_roster');
    db().prepare('UPDATE users SET class_id=? WHERE id=?').run(third, rain.id);
    const original = db().prepare('SELECT * FROM submissions ORDER BY assignment_id').all();
    await restart(); await restart();
    const records = (await request(`/students/${rain.id}/history?classId=${third}`, teacher)).body.assignments;
    assert.deepEqual(records.map(a => [a.id, a.reviewClassId]), [[ids[1], null], [ids[0], second]]);
    assert.equal((await request(`/assignments/${ids[0]}/students/${rain.id}?classId=${second}`, teacher)).body.score, 100);
    const personal = (await request(`/students/${rain.id}/history/${ids[1]}?classId=${third}`, teacher)).body;
    assert.deepEqual(personal.answers, JSON.parse(original[1].answers)); assert.equal(personal.reviewClassId, null);
    for (const classId of [1, second]) assert.equal((await request(`/assignments/${ids[1]}/report?classId=${classId}`, teacher)).body.total, 0);
    assert.deepEqual(db().prepare('SELECT * FROM submissions ORDER BY assignment_id').all(), original);
  });
});

test('个人限时：独立起点、幂等开始、全班截止取较早者及重启恢复', async () => {
  await fixture(async ({ request, teacher, student, time, restart }) => {
    const lin = await student('lin'), zhou = await student('zhou');
    for (const value of [0, -1, 1.5, 1441, '20', true]) assert.equal((await request('/assignments', teacher, 'POST', { title: '非法限时', timeLimitMinutes: value })).status, 400);
    const work = (await request('/assignments', teacher, 'POST', { title: '20 分钟', timeLimitMinutes: 20 })).body;
    const path = `/assignments/${work.id}`, answers = work.questions.map(solution);
    const before = (await request(path, lin.cookie)).body;
    assert.equal(before.startedAt, null); assert.deepEqual(before.questions, []); assert.deepEqual(before.expressions, []);
    const unstarted = (await request(path + '/report?classId=1', teacher)).body.students[0];
    assert.equal(unstarted.startedAt, null); assert.equal(unstarted.effectiveDueAt, null); assert.equal(unstarted.isClosed, false);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers })).status, 400);
    assert.equal((await request(path + '/start', teacher, 'POST', {})).status, 403);
    const starts = await Promise.all([request(path + '/start', lin.cookie, 'POST', {}), request(path + '/start', lin.cookie, 'POST', {})]);
    for (const result of starts) { assert.equal(result.status, 200); assert.equal(result.body.startedAt, '2026-11-24T11:00:00.000Z'); assert.equal(result.body.effectiveDueAt, '2026-11-24T11:20:00.000Z'); }
    time('2026-11-24T11:10:00Z');
    const later = (await request(path + '/start', zhou.cookie, 'POST', {})).body;
    assert.equal(later.effectiveDueAt, '2026-11-24T11:30:00.000Z');
    assert.equal((await request(path + '/start', lin.cookie, 'POST', {})).body.effectiveDueAt, '2026-11-24T11:20:00.000Z');
    const partial = answers.map((v, i) => i < 4 ? v : null);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers: partial })).status, 200);
    await restart();
    assert.deepEqual((await request(path, lin.cookie)).body.answers, partial);
    time('2026-11-24T11:19:59.999Z');
    assert.equal((await request(path + '/report', teacher)).body.students.find(s => s.id === lin.id).isClosed, false);
    time('2026-11-24T11:20:00Z');
    const rows = (await request(path + '/report?classId=1', teacher)).body.students;
    for (const [pupil, end, expired] of [[lin, '11:20', true], [zhou, '11:30', false]]) {
      const row = rows.find(s => s.id === pupil.id);
      const home = (await request('/assignments', pupil.cookie)).body.find(a => a.id === work.id);
      for (const view of [row, home]) {
        assert.equal(view.effectiveDueAt, `2026-11-24T${end}:00.000Z`);
        assert.equal(view.deadlineSource, 'personal');
        assert.equal(view.isClosed, expired);
      }
    }
    assert.equal((await request(path + '/submit', lin.cookie, 'POST', { answers, startedAt: '2099-01-01' })).status, 409);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers })).status, 200);
    assert.equal((await request(path, lin.cookie)).body.submittedAt, null);
    assert.equal((await request(path + '/submit', zhou.cookie, 'POST', { answers })).body.score, 100);
    const report = (await request(path + '/report', teacher)).body;
    assert.equal(report.pending, 1); assert.equal(report.average, 100);
    time('2026-11-24T11:00:00Z');
    const limited = (await request('/assignments', teacher, 'POST', { title: '全班19:25', timeLimitMinutes: 20, dueAt: '2026-11-24T19:25+08:00' })).body;
    time('2026-11-24T11:10:00Z');
    const limitedPath = `/assignments/${limited.id}`;
    assert.equal((await request(limitedPath + '/start', zhou.cookie, 'POST', {})).body.effectiveDueAt, '2026-11-24T11:25:00.000Z');
    time('2026-11-24T11:25:00Z');
    const limitedRows = (await request(limitedPath + '/report', teacher)).body.students;
    assert.ok(limitedRows.every(s => s.deadlineSource === 'class' && s.isClosed));
    assert.equal(limitedRows.find(s => s.id === lin.id).startedAt, null);
    assert.equal((await request(limitedPath + '/submit', zhou.cookie, 'POST', { answers: limited.questions.map(solution) })).status, 409);
    assert.equal((await request(limitedPath + '/start', lin.cookie, 'POST', {})).status, 409);
    assert.equal((await request(path + '/submit', zhou.cookie, 'POST', { answers })).body.score, 100);
  });
});

test('知识点生成：基础2步、提高3步，整除范围与每一步实际运算', () => {
  const inspect = q => {
    if (typeof q === 'number') { assert.ok(Number.isInteger(q) && q > 0 && q <= 100); return { answer: q, steps: 0 }; }
    const a = inspect(q.a), b = inspect(q.b);
    if (q.op === '*') { assert.ok(a.answer > 1); assert.ok(b.answer > 1); }
    if (q.op === '/') { assert.ok(b.answer > 1); assert.ok(a.answer > b.answer); assert.equal(a.answer % b.answer, 0); }
    const answer = q.op === '+' ? a.answer + b.answer : q.op === '-' ? a.answer - b.answer : q.op === '*' ? a.answer * b.answer : a.answer / b.answer;
    assert.ok(Number.isInteger(answer) && answer > 0 && answer <= 100);
    return { answer, steps: a.steps + b.steps + 1 };
  };
  for (const topic of practiceOptions.topics) for (const difficulty of ['basic', 'advanced']) for (const count of [10, 20, 50]) {
    for (let round = 0; round < 5; round++) {
      const questions = generateQuestions('mixed-100', count, { grade: topic.minGrade, knowledgePoints: [topic.id], difficulty });
      assert.equal(questions.length, count); assert.equal(new Set(questions.map(q => JSON.stringify(q))).size, count);
      for (const q of questions) {
        const checked = inspect(q); assert.equal(checked.steps, difficulty === 'basic' ? 2 : 3); assert.equal(checked.answer, solution(q));
        const expression = formatExpression(q);
        if (topic.id === 'parentheses') assert.match(expression, /\(/);
        else assert.doesNotMatch(expression, /\(/);
        if (topic.id === 'precedence') { assert.match(expression, /[×÷]/); assert.match(expression, /[＋−]/); }
        if (topic.id === 'add-sub-chain') assert.doesNotMatch(expression, /[×÷]/);
        if (topic.id === 'mul-div-chain') assert.doesNotMatch(expression, /[＋−]/);
      }
    }
  }
});

test('混合题配置经API校验并持久保存，年级知识点与难度可回看', async () => {
  await fixture(async ({ request, teacher, restart }) => {
    const catalog = await request('/practice-options', teacher); assert.equal(catalog.status, 200);
    for (const input of [{ grade: 0 }, { grade: '3' }, { knowledgePoints: [] }, { knowledgePoints: ['unknown'] }, { grade: 1, knowledgePoints: ['parentheses'] }, { knowledgePoints: ['precedence', 'precedence'] }, { difficulty: null }, { difficulty: 'hard' }]) {
      assert.equal((await request('/assignments', teacher, 'POST', { title: '无效配置', category: 'mixed-100', ...input })).status, 400);
    }
    const created = await request('/assignments', teacher, 'POST', { title: '提高括号', category: 'mixed-100', grade: 3, knowledgePoints: ['parentheses'], difficulty: 'advanced', questionCount: 50 });
    assert.equal(created.status, 201); const a = created.body;
    assert.equal(a.grade, 3); assert.equal(a.difficulty, 'advanced'); assert.deepEqual(a.knowledgePoints, ['parentheses']);
    await restart();
    const restored = (await request(`/assignments/${a.id}`, teacher)).body;
    assert.deepEqual(restored, a);
  });
});

test('多班作业权限、同卷发布、分班统计与重启隔离', async () => {
  await fixture(async ({ request, teacher, student, restart }) => {
    assert.equal((await request('/classes/1', teacher, 'PUT', { name: '一班' })).status, 200);
    const second = (await request('/classes', teacher, 'POST', { name: '二班' })).body;
    const third = (await request('/classes', teacher, 'POST', { name: '三班' })).body;
    assert.equal((await request('/classes', teacher, 'POST', { name: '二班' })).status, 409);
    assert.equal((await request('/classes/1', teacher, 'PUT', { name: '二班' })).status, 409);
    const lin = await student('lin', 1), pending1 = await student('pending1', 1);
    const zhou = await student('zhou', second.id), pending2 = await student('pending2', second.id), outsider = await student('outside', third.id);
    for (const path of ['/classes', '/students']) assert.equal((await request(path, zhou.cookie)).status, 403);
    assert.equal((await request(`/students/${lin.id}`, zhou.cookie, 'PUT', { classId: second.id })).status, 403);
    assert.equal((await request('/classes', zhou.cookie, 'POST', { name: '越权' })).status, 403);
    for (const classIds of [[], [1, 1], ['1'], [999], null]) assert.equal((await request('/assignments', teacher, 'POST', { title: '错误班级', classIds })).status, 400);
    const solo = (await request('/assignments', teacher, 'POST', { title: '只给一班', classIds: [1] })).body;
    assert.deepEqual((await request('/assignments', zhou.cookie)).body, []);
    for (const [suffix, method, data] of [['?classId=1', 'GET', undefined], ['/start', 'POST', {}], ['/draft', 'PUT', { answers: solo.questions.map(solution) }], ['/submit', 'POST', { answers: solo.questions.map(solution) }]]) {
      assert.equal((await request(`/assignments/${solo.id}${suffix}`, zhou.cookie, method, data)).status, 404);
    }
    const published = await request('/assignments', teacher, 'POST', { title: '两班同卷限时提高题', classIds: [1, second.id], category: 'mixed-100', questionCount: 20,
      grade: 3, knowledgePoints: ['parentheses'], difficulty: 'advanced', timeLimitMinutes: 20 });
    assert.equal(published.status, 201); const both = published.body, path = `/assignments/${both.id}`;
    const linView = (await request(path + '/start', lin.cookie, 'POST', {})).body;
    const zhouView = (await request(path + '/start', zhou.cookie, 'POST', {})).body;
    assert.deepEqual(linView.questions, zhouView.questions); assert.deepEqual(linView.expressions, zhouView.expressions);
    assert.equal((await request(path, outsider.cookie)).status, 404);
    const answers = both.questions.map(solution), wrong = (n) => answers.map((v, i) => i < n ? (v + 1) % 101 : v);
    assert.equal((await request(path + '/submit', lin.cookie, 'POST', { answers: wrong(1) })).body.score, 95);
    assert.equal((await request(path + '/submit', zhou.cookie, 'POST', { answers: wrong(2) })).body.score, 90);
    for (const [classId, score, names] of [[1, 95, ['lin', 'pending1']], [second.id, 90, ['zhou', 'pending2']]]) {
      const report = (await request(`${path}/report?classId=${classId}`, teacher)).body;
      assert.equal(report.total, 2); assert.equal(report.submitted, 1); assert.equal(report.pending, 1); assert.equal(report.average, score);
      assert.deepEqual(report.students.map(s => s.username), names);
      assert.equal((await request(`/students?classId=${classId}`, teacher)).body.length, 2);
    }
    assert.equal((await request(path + '/report', teacher)).body.average, 92.5);
    assert.equal((await request(`${path}/report?classId=${third.id}`, teacher)).status, 404);
    await restart();
    assert.deepEqual((await request(path, teacher)).body.classIds, [1, second.id]);
    assert.equal((await request(`/assignments/${solo.id}`, zhou.cookie)).status, 404);
    assert.equal((await request(`${path}/report?classId=${second.id}`, teacher)).body.average, 90);
    // A new student's class is the source of visibility; a query parameter cannot select another class.
    const newcomer = await student('newcomer', second.id);
    assert.deepEqual((await request('/assignments?classId=1', newcomer.cookie)).body.map(a => a.id), [both.id]);
    assert.equal((await request(`/students/${pending1.id}`, teacher, 'PUT', { classId: second.id })).status, 200);
    assert.equal((await request(`/assignments/${solo.id}`, pending1.cookie)).status, 404);
    assert.equal((await request(`/students/${pending2.id}`, teacher, 'PUT', { classId: 999 })).status, 400);
  });
});
