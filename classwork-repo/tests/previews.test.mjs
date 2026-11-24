import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyPreviewClass, legacyPreviewSchemas } from './preview-fixture.mjs';
import { createApp } from '../backend/app.mjs';
import { generatePaper, paperOptions, practiceCategories } from '../backend/papers.mjs';
import { solution, formatExpression } from '../backend/store.mjs';
import { teacherPassword, snapshot } from './history-fixture.mjs';

async function fixture(run, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-preview-')), dbPath = join(dir, 'test.sqlite');
  if (seed) await seed(dbPath);
  let app, now = Date.parse('2026-11-24T11:00:00Z');
  const start = async () => { app = await createApp({ dbPath, clock: () => now }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  await start();
  const request = async (path, cookie, method = 'GET', data) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, password = 'Teacher123!') => { const r = await request('/login', null, 'POST', { username, password }); assert.equal(r.status, 200); return r.cookie; };
  try { await run({ db: () => app.db, request, login, time: value => { now = Date.parse(value); }, restart: async () => { await stop(); await start(); } }); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}

test('专项基础提高有明确区别，综合题两三类均分且保留范围整除与题序标签', () => {
  for (const difficulty of ['basic', 'advanced']) for (const questionCount of [10, 20, 50]) {
    for (let round = 0; round < 5; round++) for (const category of practiceCategories) {
      const paper = generatePaper(paperOptions({ category, difficulty, questionCount }));
      assert.equal(paper.questions.length, questionCount); assert.equal(new Set(paper.questions.map(formatExpression)).size, questionCount);
      for (const q of paper.questions) {
        const check = node => { if (typeof node === 'number') { assert.ok(node >= 0 && node <= (category === 'mixed-100' ? 100 : 20)); return; } check(node.a); check(node.b); const v = solution(node); assert.ok(Number.isInteger(v) && v >= 0 && v <= (category === 'mixed-100' ? 100 : 20)); };
        check(q);
        if (category === 'add-sub-20') {
          const regroup = q.op === '+' ? q.a % 10 + q.b % 10 >= 10 : q.a % 10 < q.b % 10;
          assert.equal(regroup, difficulty === 'advanced');
        }
        if (category === 'mul-div-20') {
          const factors = q.op === '*' ? [q.a, q.b] : [q.b, q.a / q.b];
          if (difficulty === 'basic') assert.ok(factors.some(n => [0, 1, 2, 5, 10].includes(n)));
          else assert.ok(factors.every(n => n >= 2));
        }
      }
    }
    for (const selectedCategories of [practiceCategories, practiceCategories.slice(0, 2), practiceCategories.slice(1), [practiceCategories[0], practiceCategories[2]]]) {
      const paper = generatePaper(paperOptions({ category: 'composite', selectedCategories, difficulty, questionCount, knowledgePoints: ['precedence'] }));
      assert.equal(paper.questions.length, questionCount); assert.equal(paper.questionCategories.length, questionCount);
      assert.ok(Math.max(...paper.components.map(c => c.count)) - Math.min(...paper.components.map(c => c.count)) <= 1);
      paper.components.forEach(c => assert.equal(paper.questionCategories.filter(k => k === c.category).length, c.count));
    }
  }
  const twenty = generatePaper(paperOptions({ category: 'composite', selectedCategories: [...practiceCategories].reverse(), questionCount: 20 }));
  assert.deepEqual(twenty.components, [{ category: 'add-sub-20', count: 7 }, { category: 'mul-div-20', count: 7 }, { category: 'mixed-100', count: 6 }]);
  for (const selectedCategories of [[], ['add-sub-20'], ['mixed-100', 'mixed-100'], ['add-sub-20', 'unknown']]) assert.throws(() => paperOptions({ category: 'composite', selectedCategories }));
  assert.throws(() => paperOptions({ category: 'add-sub-20', difficulty: 'unknown' }));
});

test('预览换卷不对学生可见，最终原样发布、并发重试幂等、教师隔离、过期重设及综合评分', async () => {
  await fixture(async ({ db, request, login, restart, time }) => {
    db().prepare("INSERT INTO classes(name) VALUES('二班')").run();
    for (const [name, role, classId] of [['teacher2', 'teacher', null], ['lin', 'student', 1], ['zhou', 'student', 2]]) db().prepare('INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,?,? FROM users WHERE username=\'teacher\'').run(name, name, role, classId);
    const teacher = await login('teacher'), secondTeacher = await login('teacher2'), lin = await login('lin'), zhou = await login('zhou');
    const config = { title: '三类综合练习', category: 'composite', selectedCategories: [...practiceCategories].reverse(), questionCount: 20, difficulty: 'advanced', grade: 3, knowledgePoints: ['parentheses'], classIds: [1, 2], dueAt: '2026-11-24T12:00:00Z' };
    assert.equal((await request('/assignment-previews/current', teacher)).body.preview, null);
    const first = await request('/assignment-previews', teacher, 'POST', config); assert.equal(first.status, 201);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 0);
    assert.deepEqual((await request('/assignments', lin)).body, []); assert.deepEqual((await request('/assignments', zhou)).body, []);
    const final = (await request('/assignment-previews', teacher, 'POST', config)).body;
    assert.equal(final.usesCurrentRules, true);
    assert.notEqual(final.previewId, first.body.previewId); assert.notDeepEqual(final.questions, first.body.questions);
    assert.equal((await request(`/assignment-previews/${first.body.previewId}/publish`, teacher, 'POST', {})).status, 409);
    const other = (await request('/assignment-previews', secondTeacher, 'POST', { title: '其他老师的预览' })).body;
    assert.equal((await request(`/assignment-previews/${other.previewId}/publish`, teacher, 'POST', {})).status, 409);
    for (const path of ['/assignment-previews/current', '/assignment-previews']) assert.equal((await request(path, lin, path.endsWith('current') ? 'GET' : 'POST', path.endsWith('current') ? undefined : config)).status, 403);
    await restart();
    assert.deepEqual((await request('/assignment-previews/current', teacher)).body.preview, final);
    const published = await Promise.all([request(`/assignment-previews/${final.previewId}/publish`, teacher, 'POST', { questions: [], title: '伪造设置' }), request(`/assignment-previews/${final.previewId}/publish`, teacher, 'POST', {})]);
    assert.deepEqual(published.map(p => p.status).sort(), [200, 201]);
    const assignment = published[0].body;
    assert.equal(assignment.title, config.title); assert.deepEqual(assignment.questions, final.questions); assert.deepEqual(assignment.expressions, final.expressions); assert.deepEqual(assignment.components.map(c => c.count), [7, 7, 6]);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 1);
    assert.deepEqual((await request(`/assignments/${assignment.id}`, lin)).body.questions, final.questions);
    assert.deepEqual((await request(`/assignments/${assignment.id}`, zhou)).body.questions, final.questions);
    const answers = final.questions.map(solution), partial = answers.map((v, i) => i < 12 ? v : null);
    assert.equal((await request(`/assignments/${assignment.id}/draft`, lin, 'PUT', { answers: partial })).status, 200);
    const invalid = [...partial]; invalid[0] = 21;
    assert.equal((await request(`/assignments/${assignment.id}/draft`, lin, 'PUT', { answers: invalid })).status, 400);
    const wrong = [...answers]; wrong[19] = (wrong[19] + 1) % 101;
    assert.equal((await request(`/assignments/${assignment.id}/submit`, lin, 'POST', { answers: wrong })).body.score, 95);
    assert.equal((await request(`/assignments/${assignment.id}/report?classId=1`, teacher)).body.average, 95);
    assert.equal((await request(`/assignments/${assignment.id}/report?classId=2`, teacher)).body.average, null);
    time('2026-11-24T12:00:00Z');
    assert.equal((await request(`/assignment-previews/${final.previewId}/publish`, teacher, 'POST', {})).body.id, assignment.id);
    const pending = (await request('/assignment-previews', teacher, 'POST', { title: '很快截止', dueAt: '2026-11-24T12:01:00Z' })).body;
    time('2026-11-24T12:01:00Z');
    assert.equal((await request(`/assignment-previews/${pending.previewId}/publish`, teacher, 'POST', {})).status, 400);
    const refreshed = (await request('/assignment-previews', teacher, 'POST', { title: '更新设置', category: 'mul-div-20', difficulty: 'advanced' })).body;
    assert.equal((await request(`/assignment-previews/${refreshed.previewId}/publish`, teacher, 'POST', {})).status, 201);
  });
});

test('接续每位老师一行的旧预览表，保留已有发布关联和旧原题草稿成绩', async t => {
  for (const [index, schema] of legacyPreviewSchemas.entries()) await t.test(`旧表形态 ${index + 1}`, async () => {
    await fixture(async ({ db, request, login, restart }) => {
      const originals = snapshot(db()), oldQuestions = db().prepare('SELECT questions FROM assignments WHERE id=33').get().questions;
      const teacher = await login('teacher', teacherPassword), teacher2 = await login('teacher2', teacherPassword);
      const old = (await request('/assignment-previews/current', teacher)).body.preview;
      assert.equal(old.previewId, 'legacy-preview-1'); assert.equal(old.usesCurrentRules, false); assert.deepEqual(old.questions, JSON.parse(oldQuestions));
      const oldPublished = await request('/assignment-previews/legacy-preview-9/publish', teacher2, 'POST', {});
      assert.equal(oldPublished.status, 200); assert.equal(oldPublished.body.id, 22);
      const continued = await request(`/assignment-previews/${old.previewId}/publish`, teacher, 'POST', {});
      assert.equal(continued.status, 201); assert.deepEqual(continued.body.questions, old.questions);
      const first = (await request('/assignment-previews', teacher, 'POST', { title: '升级后预览', category: 'composite', selectedCategories: practiceCategories, questionCount: 20, difficulty: 'advanced' })).body;
      const changed = (await request('/assignment-previews', teacher, 'POST', first.settings)).body;
      assert.notEqual(first.previewId, changed.previewId); await restart();
      assert.deepEqual((await request('/assignment-previews/current', teacher)).body.preview.questions, changed.questions);
      const result = await request(`/assignment-previews/${changed.previewId}/publish`, teacher, 'POST', {});
      assert.equal(result.status, 201); assert.deepEqual(result.body.questions, changed.questions);
      assert.equal((await request('/assignment-previews/current', teacher2)).body.preview.publishedAssignmentId, 22);
      const after = snapshot(db()); assert.deepEqual(after.users, originals.users); assert.deepEqual(after.submissions, originals.submissions);
      assert.deepEqual(after.assignments.filter(a => [11, 22, 33].includes(a.id)), originals.assignments);
      assert.equal((await request('/assignments/22', teacher)).body.difficulty, 'advanced');
    }, path => legacyPreviewClass(path, schema));
  });
});
