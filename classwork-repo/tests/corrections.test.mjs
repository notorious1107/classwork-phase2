import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { explainQuestion } from '../backend/corrections.mjs';
import { similarAddSubQuestion } from '../backend/papers.mjs';
import { publishAssignment, solution } from '../backend/store.mjs';
import { correctionQuestions, seedCorrections } from './correction-fixture.mjs';
import { createHistoryClass, snapshot, studentPassword, teacherPassword, historyAssignments } from './history-fixture.mjs';

async function withBook(run, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-corrections-')), dbPath = join(dir, 'test.sqlite');
  if (seed) await seed(dbPath);
  let app;
  async function start() { app = await createApp({ dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  async function stop() { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); }
  await start();
  const request = async (path, cookie, method = 'GET', data) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, password = 'Teacher123!') => { const result = await request('/login', null, 'POST', { username, password }); assert.equal(result.status, 200); return result.cookie; };
  try { await run({ db: app.db, request, login, restart: async () => { await stop(); await start(); return app.db; } }); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}

test('沿用旧订正表，逐题接续编号并保留原答案、时间和请求记录', async () => {
  const requests = '/mistakes/33/1/attempts';
  await withBook(async ({ request, login, restart }) => {
    const pupil = await login('pupil3', studentPassword);
    const history = await request(requests, pupil);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.map(a => [a.attemptNumber, a.answer, a.submittedAt]), [
      [1, 0, '2026-10-01T08:00:00Z'], [2, 27, '2026-10-02T08:00:00Z']
    ]);
    const again = await request(requests, pupil, 'POST', { answer: 27, requestId: 'legacy-request-002' });
    assert.equal(again.status, 200);
    assert.equal(again.body.attempt.attemptNumber, 2);
    const next = await request(requests, pupil, 'POST', { answer: 27, requestId: 'review-attempt-003' });
    assert.equal(next.status, 201);
    assert.equal(next.body.attempt.attemptNumber, 3);
    const reopened = await restart();
    assert.equal((await request(requests, pupil)).body.length, 3);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  }, async path => {
    await createHistoryClass(path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE correction_attempts (
        id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id),
        assignment_id INTEGER NOT NULL REFERENCES assignments(id), question_number INTEGER NOT NULL CHECK(question_number > 0),
        answer INTEGER NOT NULL, correct INTEGER NOT NULL CHECK(correct IN (0,1)), created_at TEXT NOT NULL,
        request_key TEXT NOT NULL, UNIQUE(student_id,request_key),
        FOREIGN KEY(assignment_id,student_id) REFERENCES submissions(assignment_id,student_id)
      );`);
      const add = db.prepare('INSERT INTO correction_attempts VALUES (NULL,3,33,1,?,?,?,?)');
      add.run(0, 0, '2026-10-01T08:00:00Z', 'legacy-request-001');
      add.run(27, 1, '2026-10-02T08:00:00Z', 'legacy-request-002');
    } finally { db.close(); }
  });
});

test('20 以内每道一步加减法都能换数，首题和连续再练均保留运算及进退位', () => {
  for (const op of ['+', '-']) for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) {
    const original = { a, b, op }, result = solution(original);
    if (result < 0 || result > 20) continue;
    const history = [];
    for (let i = 0; i < 3; i++) {
      const q = similarAddSubQuestion(original, history);
      assert.equal(q.op, op);
      assert.ok([q.a, q.b, solution(q)].every(n => Number.isInteger(n) && n >= 0 && n <= 20));
      assert.equal(op === '+' ? q.a % 10 + q.b % 10 >= 10 : q.a % 10 < q.b % 10,
        op === '+' ? a % 10 + b % 10 >= 10 : a % 10 < b % 10);
      for (const previous of [original, ...history.slice(0, 1)]) {
        assert.notEqual(q.a, previous.a); assert.notEqual(q.b, previous.b); assert.notEqual(solution(q), solution(previous));
      }
      history.unshift(q);
    }
  }
});

test('订正正确后独立生成并批改同类新题，重试、重启和换账号均保留题目归属', async () => {
  await withBook(async ({ db, request, login, restart }) => {
    const { students, shared } = seedCorrections(db);
    const id = publishAssignment(db, '再练测试卷');
    const original = { a: 18, op: '−', b: 5 };
    db.prepare('UPDATE assignments SET questions=? WHERE id=?').run(JSON.stringify(Array(10).fill(original)), id);
    const answers = [0, ...Array(9).fill(13)];
    const add = db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,90)');
    for (const student of [students.learner, students.other]) add.run(id, student, JSON.stringify(answers), '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z');
    const before = snapshot(db), pupil = await login('learner'), other = await login('other'), teacher = await login('teacher');
    const base = `/mistakes/${id}/1`, path = base + '/practice', input = { requestId: 'new-practice-first' };
    assert.equal((await request(path, pupil, 'POST', input)).status, 409);
    await request(base + '/attempts', pupil, 'POST', { answer: 13, requestId: 'correct-original-001' });
    assert.equal((await request(path, teacher, 'POST', input)).status, 403);
    assert.equal((await request(path, other, 'POST', input)).status, 409);
    assert.equal((await request(path, null, 'POST', input)).status, 401);
    assert.equal((await request(`/mistakes/${shared}/1/practice`, pupil, 'POST', input)).status, 400);
    const first = await Promise.all([request(path, pupil, 'POST', input), request(path, pupil, 'POST', input)]);
    assert.deepEqual(first.map(r => r.status).sort(), [200, 201]);
    assert.deepEqual(first[0].body, first[1].body);
    const practice = path + '/' + first[0].body.practiceId;
    const view = (await request(practice, pupil)).body;
    assert.equal(view.practiceKind, '不退位减法'); assert.notEqual(view.expression, '18 − 5');
    assert.equal(view.feedback, undefined); assert.equal(view.correctAnswer, undefined);
    const [a, b] = view.expression.split(' − ').map(Number), answer = a - b;
    assert.equal((await request(practice, other)).status, 404);
    assert.equal((await request(practice, other, 'POST', { answer, studentId: students.learner })).status, 404);
    assert.equal((await request(practice, pupil, 'POST', { answer: null })).status, 400);
    const marked = await request(practice, pupil, 'POST', { answer: 13, correctAnswer: 13 });
    assert.equal(marked.status, 200); assert.equal(marked.body.feedback.attempt.correct, false);
    assert.equal(marked.body.feedback.correctAnswer, answer);
    assert.deepEqual((await request(practice, pupil, 'POST', { answer: 13 })).body, marked.body);
    assert.equal((await request(practice, pupil, 'POST', { answer })).status, 409);
    const next = await request(path, pupil, 'POST', { requestId: 'new-practice-second' });
    const second = path + '/' + next.body.practiceId, secondView = (await request(second, pupil)).body;
    assert.notEqual(secondView.expression, view.expression); assert.equal(secondView.feedback, undefined);
    const [left, right] = secondView.expression.split(' − ').map(Number);
    const correct = (await request(second, pupil, 'POST', { answer: left - right })).body.feedback;
    assert.equal(correct.attempt.correct, true); assert.ok(correct.steps[0].calculation.startsWith(secondView.expression));
    const reopened = await restart();
    assert.deepEqual((await request(practice, pupil)).body, marked.body);
    assert.equal((await request(base + '/attempts', pupil)).body.length, 1);
    assert.deepEqual(snapshot(reopened), before);
  });
});

test('订正逐步讲解遵循可见括号、乘除优先和从左往右，保留原题', () => {
  const original = structuredClone(correctionQuestions);
  const nested = explainQuestion(correctionQuestions[0]);
  assert.equal(nested.correctAnswer, 13);
  assert.deepEqual(nested.steps.map(s => s.after), ['24 ÷ 4 ＋ 7', '6 ＋ 7', '13']);
  assert.deepEqual(nested.steps.map(s => s.calculation), ['36 − 12 ＝ 24', '24 ÷ 4 ＝ 6', '6 ＋ 7 ＝ 13']);
  assert.ok(nested.steps[0].reason.includes('小括号'));
  assert.deepEqual(explainQuestion(correctionQuestions[1]).steps.map(s => s.after), ['24 ÷ 4', '6']);
  // The left subtree is addition, but the independent multiplication on the right must go first.
  assert.deepEqual(explainQuestion(correctionQuestions[2]).steps.map(s => s.after), ['3 ＋ 5 ＋ 12', '8 ＋ 12', '20']);
  assert.equal(explainQuestion(correctionQuestions[3]).correctAnswer, 0);
  for (const a of historyAssignments) a.questions.forEach((q, i) => assert.equal(explainQuestion(q).correctAnswer, a.key[i]));
  assert.deepEqual(correctionQuestions, original);
});

test('错题本只收首次已交错题，订正独立计次、幂等、隔离并在重启后保留', async () => {
  await withBook(async ({ db, request, login, restart }) => {
    const ids = seedCorrections(db), learner = await login('learner'), other = await login('other'), teacher = await login('teacher');
    const originals = snapshot(db);
    const book = (await request('/mistakes', learner)).body;
    assert.equal(book.length, 6);
    assert.deepEqual(book.map(i => [i.assignmentId, i.questionNumber]), [[ids.second, 1], [ids.shared, 1], [ids.shared, 2], [ids.shared, 3], [ids.shared, 5], [ids.fifty, 50]]);
    assert.ok(book.every(i => i.attemptCount === 0 && i.firstCorrectAttempt === null));
    assert.equal(book[0].expression, book[1].expression); assert.notEqual(book[0].assignmentId, book[1].assignmentId);
    assert.equal((await request('/mistakes', await login('draft'))).body.length, 0);
    assert.equal((await request('/mistakes', await login('perfect'))).body.length, 0);
    assert.equal((await request('/mistakes', other)).body.length, 1);
    assert.ok(!JSON.stringify(book).includes('correctAnswer'));
    const base = `/mistakes/${ids.shared}/1`, attempts = base + '/attempts';
    const question = (await request(base, learner)).body;
    assert.equal(question.expression, '(36 − 12) ÷ 4 ＋ 7'); assert.equal(question.answerMax, 100);
    for (const field of ['correctAnswer', 'steps', 'originalAnswer', 'answers', 'results', 'attempts']) assert.equal(question[field], undefined);
    assert.equal((await request(base, other)).status, 404);
    assert.equal((await request(base + '/original', other)).status, 404);
    assert.equal((await request(attempts, other)).status, 404);
    assert.equal((await request(attempts, other, 'POST', { answer: 13, requestId: 'other-forged-0001', studentId: ids.students.learner })).status, 404);
    for (const path of ['/mistakes', base, attempts, base + '/original']) {
      assert.equal((await request(path, teacher)).status, 403); assert.equal((await request(path)).status, 401);
    }
    for (const n of [0, 4, 11, '999999999999999999999999999999']) assert.equal((await request(`/mistakes/${ids.shared}/${n}`, learner)).status, 404);
    assert.equal((await request(`/mistakes/${ids.fifty}/50`, learner)).status, 200);
    for (const answer of [null, '', '13', -1, 101, 1.5]) assert.equal((await request(attempts, learner, 'POST', { answer, requestId: 'invalid-answer-001' })).status, 400);
    assert.equal((await request(attempts, learner, 'POST', { answer: 13 })).status, 400);
    const firstInput = { answer: 0, requestId: 'first-attempt-0001', studentId: ids.students.other };
    const first = await Promise.all([request(attempts, learner, 'POST', firstInput), request(attempts, learner, 'POST', firstInput)]);
    assert.deepEqual(first.map(r => r.status).sort(), [200, 201]);
    assert.equal(first[0].body.attempt.attemptNumber, 1); assert.equal(first[0].body.attempt.answer, 0); assert.equal(first[0].body.attempt.correct, false);
    assert.equal(first[0].body.correctAnswer, 13); assert.equal(first[0].body.steps.length, 3);
    assert.equal((await request(attempts, learner, 'POST', { ...firstInput, answer: 13 })).status, 409);
    const second = (await request(attempts, learner, 'POST', { answer: 13, requestId: 'second-attempt-002' })).body;
    assert.equal(second.attempt.correct, true); assert.equal(second.attempt.attemptNumber, 2);
    const third = (await request(attempts, learner, 'POST', { answer: 12, requestId: 'third-attempt-0003' })).body;
    assert.equal(third.attempt.attemptNumber, 3); assert.equal(third.attempt.correct, false);
    const fresh = (await request(base, learner)).body;
    assert.equal(fresh.attemptCount, 3); assert.equal(fresh.correctAnswer, undefined); assert.equal(fresh.steps, undefined);
    assert.deepEqual((await request(attempts, learner)).body.map(a => a.correct), [false, true, false]);
    assert.equal((await request(attempts, learner, 'POST', firstInput)).body.attempt.attemptNumber, 1);
    const progress = (await request('/mistakes', learner)).body.find(i => i.assignmentId === ids.shared && i.questionNumber === 1);
    assert.equal(progress.attemptCount, 3); assert.equal(progress.firstCorrectAttempt, 2); assert.equal(progress.lastAttemptCorrect, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM correction_attempts WHERE student_id=?').get(ids.students.other).n, 0);
    assert.deepEqual(snapshot(db), originals);
    // Moving class does not erase the student's already submitted mistake sources.
    db.prepare('UPDATE users SET class_id=2 WHERE id=?').run(ids.students.learner);
    assert.equal((await request(`/assignments/${ids.shared}`, learner)).status, 404);
    assert.deepEqual((await request(base + '/original', learner)).body.answers, ids.firstAnswers);
    const afterMove = snapshot(db);
    const reopened = await restart();
    assert.equal((await request(base, learner)).body.attemptCount, 3);
    assert.deepEqual((await request(attempts, learner)).body.map(a => a.correct), [false, true, false]);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM correction_attempts').get().n, 3);
    assert.deepEqual(snapshot(reopened), afterMove);
  });
});

test('升级前 basic、advanced、空难度的原题草稿成绩不变，旧错题可独立订正', async () => {
  await withBook(async ({ db, request, login, restart }) => {
    const before = snapshot(db), pupil = await login('pupil3', studentPassword);
    const items = (await request('/mistakes', pupil)).body;
    assert.deepEqual([...new Set(items.map(i => i.assignmentId))].sort((a, b) => a - b), [11, 22, 33]);
    const result = await request('/mistakes/33/1/attempts', pupil, 'POST', { answer: 27, requestId: 'legacy-attempt-001' });
    assert.equal(result.status, 201); assert.equal(result.body.attempt.correct, true); assert.equal(result.body.steps[0].calculation, '3 × 8 ＝ 24');
    assert.deepEqual(snapshot(db), before);
    const reopened = await restart(); assert.deepEqual(snapshot(reopened), before);
    const teacher = await login('teacher', teacherPassword);
    assert.equal((await request('/assignments/33/report?classId=1', teacher)).body.students.find(s => s.id === 3).score, 70);
    assert.equal((await request('/mistakes/33/1/attempts', pupil)).body.length, 1);
  }, createHistoryClass);
});
