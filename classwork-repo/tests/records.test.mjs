import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { publishAssignment } from '../backend/store.mjs';
import { createHistoryClass, historyAssignments, historyDraft, teacherPassword, snapshot } from './history-fixture.mjs';

async function withRecords(run, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-records-')), path = join(dir, 'records.sqlite');
  if (seed) await seed(path);
  const app = await createApp({ dbPath: path });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, cookie) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: response.status, body: await response.json() };
  };
  const login = async (username, password = 'Teacher123!') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  try { await run({ ...app, request, login }); }
  finally { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true }); }
}

test('教师按成绩名单读取原卷、已交逐题对错和未评分草稿，学生不能读取教师接口', async () => {
  await withRecords(async ({ db, request, login }) => {
    db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    for (const [username, classId] of [['lin', 1], ['draft', 1], ['blank', 1], ['zhou', 2]]) db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',? FROM users WHERE role='teacher'").run(username, username, classId);
    const teacher = await login('teacher'), pupil = await login('lin');
    const idOf = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    const id = publishAssignment(db, '原卷 <b>80 分', { classIds: [1, 2] });
    const original = historyAssignments[1], answers = [...original.key]; answers[0]++; answers[1]++;
    db.prepare('UPDATE assignments SET questions=?,category=?,due_at=? WHERE id=?').run(JSON.stringify(original.questions), original.category, '2020-01-01T00:00:00Z', id);
    const savedAt = '2026-11-17T04:00:00Z';
    const write = db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)');
    write.run(id, idOf('lin'), JSON.stringify(answers), savedAt, savedAt, 80);
    const draft = [0, null, 16, ...Array(7).fill(null)]; write.run(id, idOf('draft'), JSON.stringify(draft), savedAt, null, null);
    write.run(id, idOf('zhou'), JSON.stringify(original.key), savedAt, savedAt, 100);
    const before = snapshot(db);
    const detailPath = (student, classId = 1) => `/assignments/${id}/students/${idOf(student)}?classId=${classId}`;
    const submitted = await request(detailPath('lin'), teacher);
    assert.equal(submitted.status, 200); assert.equal(submitted.body.score, 80); assert.equal(submitted.body.status, 'submitted');
    assert.deepEqual(submitted.body.questions, original.questions); assert.deepEqual(submitted.body.answers, answers);
    assert.deepEqual(submitted.body.results.map(r => r.correctAnswer), original.key);
    assert.deepEqual(submitted.body.results.map(r => r.correct), [false, false, ...Array(8).fill(true)]);
    assert.ok(submitted.body.expressions[1].includes('÷')); assert.equal(submitted.body.student.username, 'lin');
    assert.equal(submitted.body.student.password_hash, undefined);
    const partial = (await request(detailPath('draft'), teacher)).body;
    assert.equal(partial.status, 'draft'); assert.equal(partial.submittedAt, null); assert.equal(partial.score, null); assert.equal(partial.savedAt, savedAt);
    assert.deepEqual(partial.answers, draft); assert.ok(partial.results.every(r => r.correct === null));
    assert.deepEqual(partial.results.map(r => r.correctAnswer), original.key);
    const blank = (await request(detailPath('blank'), teacher)).body;
    assert.equal(blank.status, 'unstarted'); assert.deepEqual(blank.answers, Array(10).fill(null)); assert.equal(blank.score, null);
    assert.equal((await request(detailPath('zhou'), teacher)).status, 404);
    assert.equal((await request(detailPath('zhou', 2), teacher)).body.score, 100);
    const onlySecond = publishAssignment(db, '二班专属', { classIds: [2] });
    assert.equal((await request(`/assignments/${onlySecond}/students/${idOf('lin')}?classId=1`, teacher)).status, 404);
    assert.equal((await request(detailPath('lin'), pupil)).status, 403);
    assert.equal((await request(detailPath('lin'))).status, 401);
    assert.equal((await request(`/assignments/${id}/students/${idOf('lin')}`, teacher)).status, 400);
    assert.equal((await request(detailPath('lin', 999), teacher)).status, 400);
    assert.equal((await request(`/assignments/${id}/students/999?classId=1`, teacher)).status, 404);
    assert.equal((await request(`/assignments/999/students/${idOf('lin')}?classId=1`, teacher)).status, 404);
    // Exclude the independently created second assignment when comparing the read-only results.
    assert.deepEqual(snapshot(db).submissions, before.submissions); assert.deepEqual(snapshot(db).users, before.users);
    assert.deepEqual(snapshot(db).assignments.filter(a => a.id === id), before.assignments);
  });
});

test('学生记录以北京时间发布日期筛选日期及知识点，兼容旧班级和已有难度题量字段', async () => {
  await withRecords(async ({ db, request, login }) => {
    const teacher = await login('teacher', teacherPassword);
    db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    db.prepare('UPDATE users SET class_id=2 WHERE id=2').run();
    const before = snapshot(db);
    const old = (await request('/students/2/history?classId=2&from=2026-10-01&to=2026-10-01', teacher)).body;
    assert.equal(old.assignments.length, 3); assert.ok(old.assignments.every(a => a.reviewClassId === 1));
    assert.equal(old.assignments.find(a => a.id === 22).score, 90);
    const detail = (await request('/assignments/33/students/2?classId=1', teacher)).body;
    assert.deepEqual(detail.questions, historyAssignments[2].questions); assert.equal(detail.difficulty, null);
    const draft = (await request('/assignments/33/students/4?classId=1', teacher)).body;
    assert.deepEqual(draft.answers, historyDraft); assert.equal(draft.status, 'draft'); assert.equal(draft.score, null);
    assert.equal((await request('/students/2/history?classId=1', teacher)).status, 404);
    assert.deepEqual(snapshot(db), before);
    const publish = (title, stamp, category = 'mul-div-20', options = {}) => {
      const id = publishAssignment(db, title, { classIds: [2], category, ...options });
      db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run(stamp, id); return id;
    };
    publish('范围前一刻', '2026-11-15T15:59:59.999Z');
    const lower = publish('上周第一刻', '2026-11-15T16:00:00.000Z', 'mul-div-20', { questionCount: 20 });
    const upper = publish('上周最后一刻', '2026-11-22T15:59:59.999Z');
    publish('范围后一刻', '2026-11-22T16:00:00.000Z');
    publish('周外布置周内截止', '2026-11-14T08:00:00Z', 'mul-div-20', { dueAt: '2026-11-18T12:00:00Z' });
    const mixed = publish('先乘除后加减提高', '2026-11-18T08:00:00Z', 'mixed-100', { questionCount: 50, grade: 3, difficulty: 'advanced', knowledgePoints: ['precedence'] });
    publish('小括号', '2026-11-18T08:00:00Z', 'mixed-100', { knowledgePoints: ['parentheses'] });
    publishAssignment(db, '只属于原班的新作业', { classIds: [1] });
    const answer50 = [0, ...Array(49).fill(null)]; db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)').run(mixed, 2, JSON.stringify(answer50), '2026-11-19T04:00:00Z', null, null);
    const unchanged = snapshot(db);
    const base = '/students/2/history?classId=2';
    const week = await request(base + '&from=2026-11-16&to=2026-11-22&topic=mul-div-20', teacher);
    assert.equal(week.status, 200); assert.deepEqual(week.body.assignments.map(a => a.id), [upper, lower]);
    assert.equal(week.body.assignments[1].questionCount, 20); assert.equal(week.body.timeZone, 'Asia/Shanghai');
    assert.equal(week.body.assignments[0].questions, undefined); assert.equal(week.body.assignments[0].answers, undefined);
    const topic = (await request(base + '&topic=precedence', teacher)).body;
    assert.deepEqual(topic.assignments.map(a => a.id), [mixed]); assert.equal(topic.assignments[0].status, 'draft'); assert.equal(topic.assignments[0].score, null);
    assert.equal((await request(base + '&from=2026-12-01', teacher)).body.assignments.length, 0);
    const full = (await request(`/assignments/${mixed}/students/2?classId=2`, teacher)).body;
    assert.equal(full.questions.length, 50); assert.equal(full.results.length, 50); assert.deepEqual(full.answers, answer50);
    for (const query of ['&from=2026-02-30', '&to=not-a-date', '&from=0000-01-01', '&from=2026-11-22&to=2026-11-16', '&topic=unknown']) assert.equal((await request(base + query, teacher)).status, 400, query);
    assert.equal((await request('/students/999/history?classId=2', teacher)).status, 404);
    assert.equal((await request('/students/2/history', teacher)).status, 400);
    assert.equal((await request('/students/1/history?classId=1', teacher)).status, 404);
    assert.equal((await request(base)).status, 401);
    const pupil = await login('pupil2', 'FixtureStudent42'); assert.equal((await request(base, pupil)).status, 403);
    assert.deepEqual(snapshot(db), unchanged);
  }, createHistoryClass);
});
