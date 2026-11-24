import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLearning } from './learning-fixture.mjs';
import { publishAssignment } from '../backend/store.mjs';

test('学生用原密码改密，仅保留当前会话，初始短密码、错误参数与并发改密均安全处理', async () => {
  await withLearning(async ({ request, login, db, restart }) => {
    const teacher = await login('teacher');
    await request('/students/import', teacher, 'POST', { classId: 1, format: 'csv', content: Buffer.from('学号,姓名\n00123,张宁\n00124,张宁').toString('base64') });
    const pupil = await login('00123', '00123'), otherSession = await login('00123', '00123'), otherPupil = await login('00124', '00124');
    const change = (currentPassword, newPassword, cookie = pupil) => request('/me/password', cookie, 'PUT', { currentPassword, newPassword, studentId: 3 });
    for (const [current, next] of [['wrong', 'NewStudent123!'], ['00123', 'short'], ['00123', null]]) assert.equal((await change(current, next)).status, 400);
    assert.equal((await change('00123', 'NewStudent123!')).status, 200);
    assert.equal((await request('/me', pupil)).status, 200); assert.equal((await request('/me', otherSession)).status, 401); assert.equal((await request('/me', otherPupil)).status, 200);
    assert.equal((await request('/login', null, 'POST', { username: '00123', password: '00123' })).status, 401);
    assert.equal((await change('Teacher123!', 'NewTeacher123!', teacher)).status, 403);
    assert.equal((await change('a', 'NewStudent123!', null)).status, 401);
    const races = await Promise.all([change('NewStudent123!', 'FirstStudent123!'), change('NewStudent123!', 'SecondStudent123!')]);
    assert.equal(races.filter(r => r.status === 200).length, 1);
    const current = races[0].status === 200 ? 'FirstStudent123!' : 'SecondStudent123!';
    await restart(); await login('00123', current); await login('00124', '00124');
    assert.ok(!JSON.stringify(races).includes('scrypt'));
    assert.equal(db().prepare("SELECT username FROM users WHERE id=2").get().username, '00123');
  });
});

test('教师按班级和学生编号重设同名学生，其他账号及原题草稿分数不变', async () => {
  await withLearning(async ({ request, login, db, restart }) => {
    const teacher = await login('teacher');
    await request('/classes', teacher, 'POST', { name: '二班' });
    for (const [username, classId] of [['same01', 1], ['same02', 1], ['same03', 2]]) await request('/students', teacher, 'POST', { username, name: '张宁', classId, password: 'Student123!' });
    const first = await login('same01', 'Student123!'), second = await login('same02', 'Student123!');
    const paper = publishAssignment(db(), '保留原卷', { classIds: [1,2] });
    const answers = [0, ...Array(9).fill(null)]; await request(`/assignments/${paper}/draft`, first, 'PUT', { answers });
    const originals = db().prepare('SELECT * FROM submissions').all(), oldUsers = db().prepare('SELECT * FROM users WHERE id<>2 ORDER BY id').all();
    const reset = (id, classId, newPassword = 'ResetStudent123!', cookie = teacher) => request(`/students/${id}/password`, cookie, 'PUT', { classId, newPassword });
    assert.equal((await reset(4, 1)).status, 404); assert.equal((await reset(1, 1)).status, 404); assert.equal((await reset(999,1)).status,404);
    assert.equal((await reset(2, 999)).status,400); assert.equal((await reset(2, 1, 'short')).status,400); assert.equal((await reset(2,1,'ResetStudent123!',second)).status,403);
    const done = await reset(2, 1); assert.equal(done.status,200); assert.equal(done.body.student.username,'same01'); assert.equal(done.body.student.password_hash,undefined);
    assert.equal((await request('/me',first)).status,401); assert.equal((await request('/me',second)).status,200); assert.equal((await request('/me',teacher)).status,200);
    assert.deepEqual(db().prepare('SELECT * FROM users WHERE id<>2 ORDER BY id').all(), oldUsers); assert.deepEqual(db().prepare('SELECT * FROM submissions').all(), originals);
    await restart(); const fresh = await login('same01','ResetStudent123!'); assert.deepEqual((await request(`/assignments/${paper}`,fresh)).body.answers,answers);
    await login('same02','Student123!'); await login('same03','Student123!');
    assert.equal((await request('/login',null,'POST',{username:'same01',password:'Student123!'})).status,401);
  });
});
