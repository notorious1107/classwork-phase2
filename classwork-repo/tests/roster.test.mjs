import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createApp } from '../backend/app.mjs';
import { parseRoster } from '../backend/roster.mjs';
import { solution } from '../backend/store.mjs';

const sample = await readFile(new URL('../frontend/student-roster-template.xlsx', import.meta.url));
async function withClass(run) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-roster-'));
  let app;
  const start = async () => {
    app = await createApp({ dbPath: join(dir, 'test.sqlite') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  const request = async (path, cookie, method = 'GET', data) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, password) => request('/login', null, 'POST', { username, password });
  await start();
  try {
    const teacher = (await login('teacher', 'Teacher123!')).cookie;
    const second = (await request('/classes', teacher, 'POST', { name: '二班' })).body.id;
    const upload = (data, classId = 1, format = 'csv', cookie = teacher) => request('/students/import', cookie, 'POST', { classId, format, content: Buffer.from(data).toString('base64') });
    await run({ request, login, teacher, second, upload, db: () => app.db, restart: async () => { await stop(); await start(); } });
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}

test('CSV 物理行号、BOM、换行、引号及重复行校验，学号不转数字', async () => {
  const rows = await parseRoster('csv', Buffer.from('\uFEFF姓名,学号\r\n张宁,00123\r\n\r\n"张,宁",00124\r\n"跨\r\n行",00125\r\n空学号,\r\n同号甲,77\r\n同号乙,77\r\n'));
  assert.deepEqual(rows.map(r => r.row), [2, 4, 5, 7, 8, 9]);
  assert.equal(rows[0].username, '00123'); assert.deepEqual(rows[0].errors, []); assert.equal(rows[1].name, '张,宁');
  assert.match(rows[2].errors[0], /普通文字/); assert.deepEqual(rows[3].errors, ['学号为空']);
  for (const r of rows.slice(4)) assert.match(r.errors[0], /第 8、9 行重复/);
  for (const value of ['学号,姓名\n"未结束', '学号,姓名\n12,坏"引号', '账号,姓名\n00123,张宁', '学号,学号\n00123,张宁', '学号,姓名\n', '学号,姓名\n' + Array.from({ length: 501 }, (_, i) => `${i},学生`).join('\n')]) {
    await assert.rejects(parseRoster('csv', Buffer.from(value)), e => e.status === 400);
  }
  await assert.rejects(parseRoster('csv', Buffer.from([0xff, 0xfe])), /UTF-8/);
});

test('Excel 样例以文本保存前导零，数字学号和异常范围有明确错误', async () => {
  const entries = await parseRoster('xlsx', sample);
  assert.deepEqual(entries.map(r => [r.username, r.name, r.errors]), [['00123', '张宁', []], ['00124', '张宁', []], ['00125', '李雪', []]]);
  const files = unzipSync(sample), key = 'xl/worksheets/sheet1.xml';
  files[key] = strToU8(strFromU8(files[key]).replace(/(r="A2"[^>]*t=)"str"/, '$1"n"').replace('>00123<', '>123<'));
  const numeric = await parseRoster('xlsx', Buffer.from(zipSync(files)));
  assert.match(numeric[0].errors[0], /学号须为文本/);
  files[key] = strToU8(strFromU8(files[key]).replace('r="A2"', 'r="XFD1048576"'));
  await assert.rejects(parseRoster('xlsx', Buffer.from(zipSync(files))), /行列范围过大/);
  await assert.rejects(parseRoster('xlsx', Buffer.from('不是 Excel')), /有效的 .xlsx/);
});

test('逐行导入、同名不同学号、全局账号冲突与历史数据保护', async () => {
  await withClass(async ({ request, login, teacher, second, upload, db, restart }) => {
    const old = (await request('/students', teacher, 'POST', { username: '99888', name: '原姓名', password: 'Original123!', classId: second })).body;
    const pupil = (await login('99888', 'Original123!')).cookie;
    const work = (await request('/assignments', teacher, 'POST', { title: '旧成绩', classIds: [second] })).body;
    await request(`/assignments/${work.id}/submit`, pupil, 'POST', { answers: work.questions.map(solution) });
    const oldRow = db().prepare('SELECT * FROM users WHERE id=?').get(old.id), oldAnswers = db().prepare('SELECT * FROM submissions').all();
    const result = await upload('学号,姓名\n00123,张宁\n,无学号\n00777,甲\n00777,乙\n99888,替换姓名\n00124,张宁\nteacher,替换教师\n');
    assert.equal(result.status, 200); assert.equal(result.body.total, 7); assert.equal(result.body.created, 2); assert.equal(result.body.skipped, 5);
    assert.deepEqual(result.body.issues.map(e => e.row), [3, 4, 5, 6, 8]);
    assert.deepEqual(db().prepare('SELECT * FROM users WHERE id=?').get(old.id), oldRow);
    assert.deepEqual(db().prepare('SELECT * FROM submissions').all(), oldAnswers);
    assert.equal((await login('00123', '00123')).status, 200); assert.equal((await login('00124', '00124')).status, 200);
    assert.equal((await login('00123', '123')).status, 401); assert.equal((await login('123', '123')).status, 401);
    assert.equal((await login('99888', 'Original123!')).status, 200);
    assert.equal((await request('/students?classId=1', teacher)).body.filter(s => s.name === '张宁').length, 2);
    assert.deepEqual((await request(`/students?classId=${second}`, teacher)).body.map(s => s.username), ['99888']);
    assert.equal((await upload('学号,姓名\n00123,重试\n', second)).body.created, 0);
    await restart();
    assert.equal((await login('00123', '00123')).status, 200);
    assert.equal((await request('/students?classId=1', teacher)).body.length, 2);
    assert.deepEqual(db().prepare('SELECT * FROM users WHERE id=?').get(old.id), oldRow);
  });
});

test('Excel 真实HTTP导入及权限、空文件、大小与错误格式保护', async () => {
  await withClass(async ({ request, login, teacher, second, upload, db }) => {
    assert.equal((await upload(sample, second, 'xlsx')).body.created, 3);
    const pupil = (await login('00123', '00123')).cookie;
    assert.equal((await upload(sample, 1, 'xlsx', pupil)).status, 403);
    assert.equal((await upload(sample, 1, 'xlsx', '')).status, 401);
    assert.equal((await upload(sample, 999, 'xlsx')).status, 400);
    assert.equal((await upload(sample, 1, 'xls')).status, 400);
    assert.equal((await upload('', 1)).status, 400);
    assert.equal((await upload(Buffer.alloc(512 * 1024 + 1), 1)).status, 400);
    assert.equal((await request('/students/import', teacher, 'POST', { classId: 1, format: 'csv', content: '@@@' })).status, 400);
    const before = db().prepare('SELECT * FROM users ORDER BY id').all();
    assert.equal((await upload('错误表头\n00123,学生', 1)).status, 400);
    assert.deepEqual(db().prepare('SELECT * FROM users ORDER BY id').all(), before);
  });
});

test('并发导入同一学号只创建一次，不覆盖先创建的账号', async () => {
  await withClass(async ({ upload, second, db, login }) => {
    const result = await Promise.all([upload('学号,姓名\n00001,一班学生', 1), upload('学号,姓名\n00001,二班学生', second)]);
    assert.deepEqual(result.map(r => r.body.created).sort(), [0, 1]);
    const winner = result.find(r => r.body.created === 1).body.students[0];
    const stored = db().prepare("SELECT * FROM users WHERE username='00001'").get();
    assert.equal(stored.class_id, winner.classId); assert.equal(stored.name, winner.name);
    assert.equal((await login('00001', '00001')).status, 200);
  });
});
