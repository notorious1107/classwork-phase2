import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSheet } from 'read-excel-file/node';
import { withLearning } from './learning-fixture.mjs';
import { seedAnalytics } from './analytics-fixture.mjs';
import { publishAssignment } from '../backend/store.mjs';

test('成绩工作簿按作业和班级导出，保留文本学号、数字零分和未交空单元格', async () => {
  await withLearning(async ({ db, login, port, request }) => {
    const { a, b, ids } = seedAnalytics(db()), teacher = await login('teacher');
    db().prepare("UPDATE users SET username='00000123',name='=1+1' WHERE id=?").run(ids.blank);
    const pupil = await login('00000123');
    const title = '分数/练习 (A) <一>';
    db().prepare('UPDATE assignments SET title=? WHERE id=?').run(title, a);
    const path = `/assignments/${a}`;
    const blank = await request(path + '/submit', pupil, 'POST', { answers: Array(10).fill(null), allowIncomplete: true });
    assert.equal(blank.status, 200); assert.equal(blank.body.score, 0);
    await request(`/students/${ids.blank}`, teacher, 'PUT', {classId:2});
    await request('/students', teacher, 'POST', {classId:1, name:'未开始', username:'00009', password:'Student123!'});
    const query = (url, cookie) => fetch(`http://127.0.0.1:${port()}/api${url}`, { headers: cookie ? { Cookie: cookie } : {} });
    const exportPath = path + '/report.xlsx';
    const before = db().prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all();
    const response = await query(exportPath + '?classId=1', teacher);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(decodeURIComponent(response.headers.get('content-disposition')), /一班-分数_练习 \(A\) _一_-成绩\.xlsx/);
    const rows = await readSheet(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(rows[0], ['学号','姓名','班级','作业','提交状态','提交时间（北京时间）','成绩（满分100分）']);
    assert.deepEqual(rows.slice(1).map(([id])=>id), ['lin','nan','draft','00000123','00009']);
    const row = username => rows.find(r => r[0] === username);
    assert.deepEqual(row('00000123').slice(0,5), ['00000123','=1+1','一班',title,'已交']);
    assert.equal(row('00000123')[6], 0);
    assert.equal(row('lin')[6], 80); assert.equal(row('nan')[6], 100);
    assert.equal(row('lin')[5].toISOString(), '2026-11-23T16:00:00.000Z');
    for (const id of ['draft','00009']) assert.deepEqual(row(id).slice(4), ['未交',null,null]);
    const other = await query(exportPath + '?classId=2', teacher);
    const otherRows = await readSheet(Buffer.from(await other.arrayBuffer()));
    assert.deepEqual(otherRows.slice(1).map(r => [r[0],r[2],r[6]]), [['zhou','二班',40]]);
    const otherAssignment = await query(`/assignments/${b}/report.xlsx?classId=1`, teacher);
    const different = await readSheet(Buffer.from(await otherAssignment.arrayBuffer()));
    assert.ok(different.slice(1).every(r => r[3] === '周四练习 B'));
    assert.equal(different.find(r => r[0] === 'lin')[6], 60);
    const preview = await request('/analytics/remedial-previews', teacher, 'POST',
      { assignmentId:a, classId:1, questionNumber:1, studentIds:[ids.lin] });
    const remedial = await request(`/analytics/remedial-previews/${preview.body.previewId}/publish`, teacher, 'POST', {});
    const targeted = await query(`/assignments/${remedial.body.id}/report.xlsx?classId=1`, teacher);
    const targetedRows = await readSheet(Buffer.from(await targeted.arrayBuffer()));
    assert.deepEqual(targetedRows.slice(1).map(r=>[r[0],r[6]]), [['lin',null]]);
    db().exec("INSERT INTO classes(name) VALUES('空班')");
    const empty = publishAssignment(db(), '空班作业', {classIds:[3]});
    const emptyReport = await query(`/assignments/${empty}/report.xlsx?classId=3`, teacher);
    assert.deepEqual(await readSheet(Buffer.from(await emptyReport.arrayBuffer())), [rows[0]]);
    for (const [url, cookie, status] of [
      [exportPath,teacher,400], [exportPath+'?classId=999',teacher,400], [exportPath+'?classId=3',teacher,404],
      ['/assignments/999/report.xlsx?classId=1',teacher,404], [exportPath+'?classId=1',pupil,403], [exportPath+'?classId=1',null,401]
    ]) assert.equal((await query(url,cookie)).status,status);
    assert.deepEqual(db().prepare('SELECT * FROM submissions ORDER BY assignment_id,student_id').all(),before);
  });
});
