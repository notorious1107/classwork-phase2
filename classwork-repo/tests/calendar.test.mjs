import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { solution } from '../backend/store.mjs';

test('教师月历按北京时间发布日期归类、分班统计、月界和闰年，读取不改原数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-calendar-'));
  const app = await createApp({ dbPath: join(dir, 'test.sqlite'), clock: () => Date.parse('2026-11-24T04:00:00Z') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, cookie, method = 'GET', data) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async username => (await request('/login', null, 'POST', { username, password: 'Teacher123!' })).cookie;
  try {
    const teacher = await login('teacher');
    app.db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    for (const [username, classId] of [['lin', 1], ['pending', 1], ['zhou', 2]]) app.db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',? FROM users WHERE role='teacher'").run(username, username, classId);
    const lin = await login('lin'), zhou = await login('zhou');
    const publish = async (title, stamp, classIds = [1], dueAt = null) => {
      const result = await request('/assignments', teacher, 'POST', { title, classIds, dueAt }); assert.equal(result.status, 201);
      app.db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run(stamp, result.body.id); return result.body;
    };
    const shared = await publish('周二两班同卷，周四截止', '2026-11-24T00:05:00+08:00', [1, 2], '2026-11-26T20:00+08:00');
    const pending = await publish('周二第二份', '2026-11-24T11:00:00Z');
    const onlySecond = await publish('二班专属', '2026-11-24T09:00:00Z', [2]);
    const zero = await publish('有人提交但得零分', '2026-11-25T04:00:00Z');
    await publish('十月最后一刻', '2026-10-31T15:59:59.999Z');
    const first = await publish('十一月第一刻', '2026-10-31T16:00:00.000Z');
    const last = await publish('十一月最后一刻', '2026-11-30T15:59:59.999Z');
    const december = await publish('十二月第一刻', '2026-11-30T16:00:00.000Z');
    const january = await publish('新年第一刻', '2026-12-31T16:00:00Z');
    const leap = await publish('闰日', '2024-02-28T16:00:00Z');
    const correct = shared.questions.map(solution), wrong = correct.map((v, i) => i === 0 ? (v + 1) % 21 : v);
    assert.equal((await request(`/assignments/${shared.id}/submit`, lin, 'POST', { answers: wrong })).body.score, 90);
    assert.equal((await request(`/assignments/${shared.id}/submit`, zhou, 'POST', { answers: correct })).body.score, 100);
    assert.equal((await request(`/assignments/${zero.id}/submit`, lin, 'POST', { answers: zero.questions.map(q => (solution(q) + 1) % 21) })).body.score, 0);
    const snapshot = () => ['assignments', 'users', 'submissions'].map(table => app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const result = await request('/calendar?classId=1&month=2026-11', teacher), month = result.body;
    assert.equal(result.status, 200); assert.equal(month.month, '2026-11'); assert.equal(month.timeZone, 'Asia/Shanghai'); assert.equal(month.today, '2026-11-24');
    assert.equal(month.days.length, 30); assert.equal(month.total, 5);
    const day = month.days.find(d => d.date === '2026-11-24');
    assert.deepEqual(day.assignments.map(a => a.id), [pending.id, shared.id]);
    const paper = day.assignments.find(a => a.id === shared.id);
    assert.equal(paper.dueAt, '2026-11-26T12:00:00.000Z'); assert.equal(paper.submitted, 1); assert.equal(paper.pending, 1); assert.equal(paper.average, 90);
    assert.equal(paper.questions, undefined); assert.equal(paper.students, undefined);
    assert.equal(day.assignments.find(a => a.id === pending.id).average, null);
    assert.equal(month.days.find(d => d.date === '2026-11-25').assignments[0].average, 0);
    assert.equal(month.days[0].assignments[0].id, first.id); assert.equal(month.days[29].assignments[0].id, last.id);
    assert.equal(month.days.find(d => d.date === '2026-11-26').assignments.length, 0);
    const second = (await request('/calendar?classId=2&month=2026-11', teacher)).body;
    assert.equal(second.className, '二班'); assert.equal(second.total, 2);
    const secondDay = second.days.find(d => d.date === '2026-11-24');
    assert.deepEqual(secondDay.assignments.map(a => a.id), [onlySecond.id, shared.id]);
    assert.equal(secondDay.assignments.find(a => a.id === shared.id).average, 100);
    assert.equal(secondDay.assignments.find(a => a.id === shared.id).pending, 0);
    assert.equal((await request('/calendar?classId=1&month=2026-12', teacher)).body.days[0].assignments[0].id, december.id);
    assert.equal((await request('/calendar?classId=1&month=2027-01', teacher)).body.days[0].assignments[0].id, january.id);
    const february = (await request('/calendar?classId=1&month=2024-02', teacher)).body;
    assert.equal(february.days.length, 29); assert.equal(february.days[28].assignments[0].id, leap.id);
    const empty = (await request('/calendar?classId=2&month=2025-02', teacher)).body;
    assert.equal(empty.days.length, 28); assert.equal(empty.total, 0);
    assert.equal((await request('/calendar?classId=1', teacher)).body.month, '2026-11');
    for (const query of ['', '?month=2026-11', '?classId=999', '?classId=1&month=', '?classId=1&month=2026-13', '?classId=1&month=2026-2', '?classId=1&month=0000-01']) assert.equal((await request('/calendar' + query, teacher)).status, 400, query);
    assert.equal((await request('/calendar?classId=1', lin)).status, 403);
    assert.equal((await request('/calendar?classId=1')).status, 401);
    assert.deepEqual(snapshot(), before);
  } finally {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
  }
});
