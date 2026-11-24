import { readSheet } from 'read-excel-file/node';
import { Open } from 'unzipper-esm';
import { hashPassword } from './store.mjs';

export const rosterMaxBytes = 512 * 1024;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

function csvRows(source) {
  const rows = [];
  let cells = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  const finishCell = () => { cells.push(field); field = ''; closed = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else if (c === '\r' || c === '\n') { field += '\n'; if (c === '\r' && source[i + 1] === '\n') i++; line++; }
      else field += c;
    } else if (c === ',') finishCell();
    else if (c === '\r' || c === '\n') {
      finishCell(); rows.push({ row: start, cells }); cells = [];
      if (c === '\r' && source[i + 1] === '\n') i++;
      line++; start = line;
    } else if (closed) { if (c !== ' ' && c !== '\t') invalid(`第 ${line} 行的 CSV 引号格式无效`); }
    else if (c === '"') { if (field) invalid(`第 ${line} 行的 CSV 引号格式无效`); quoted = true; }
    else field += c;
  }
  if (quoted) invalid(`第 ${start} 行的 CSV 引号没有结束`);
  if (field || cells.length || closed) { finishCell(); rows.push({ row: start, cells }); }
  return rows;
}

async function excelRows(buffer) {
  try {
    const zip = await Open.buffer(buffer);
    if (zip.files.length > 100 || zip.files.reduce((sum, f) => sum + f.uncompressedSize, 0) > 8 * 1024 * 1024) invalid('Excel 内容过大，请使用精简的名单文件');
    // Bound sparse ranges before the reader allocates a rectangular cell array.
    for (const file of zip.files.filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f.path))) {
      const xml = (await file.buffer()).toString('utf8');
      for (const match of xml.matchAll(/\b(?:r|ref)="([A-Z]*\d+(?::[A-Z]*\d+)?)"/g)) {
        for (const ref of match[1].split(':')) {
          const [, column, row] = ref.match(/^([A-Z]*)(\d+)$/);
          if (Number(row) > 5001 || column.length > 1) invalid('Excel 行列范围过大，请只保留名单两列，最多 500 名学生');
        }
      }
    }
    const data = await readSheet(buffer, { trim: false });
    return data.map((cells, i) => ({ row: i + 1, cells }));
  } catch (e) { if (e.status) throw e; invalid('无法读取 Excel，请上传有效的 .xlsx 名单文件'); }
}

export async function parseRoster(format, buffer) {
  if (!buffer.length || buffer.length > rosterMaxBytes) invalid('名单文件不能为空，且不能超过 512 KB');
  let rows;
  if (format === 'csv') {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
    catch { invalid('CSV 请使用 UTF-8 编码，或改用 Excel 样例'); }
    rows = csvRows(source);
  } else if (format === 'xlsx') rows = await excelRows(buffer);
  else invalid('请上传 .xlsx 或 UTF-8 .csv 文件');
  const headers = rows.shift()?.cells.map(v => typeof v === 'string' ? v.trim() : v);
  if (!headers || headers.filter(v => v !== '' && v !== null).length !== 2 || !headers.includes('学号') || !headers.includes('姓名')) invalid('第 1 行须为“学号、姓名”两列，可下载样例填写');
  const idColumn = headers.indexOf('学号'), nameColumn = headers.indexOf('姓名');
  const entries = rows.filter(r => r.cells.some(v => v !== null && String(v).trim() !== '')).map(r => {
    const rawId = r.cells[idColumn], rawName = r.cells[nameColumn];
    const username = typeof rawId === 'string' ? rawId.trim() : rawId == null ? '' : String(rawId);
    const name = typeof rawName === 'string' ? rawName.trim() : rawName == null ? '' : String(rawName);
    const errors = [];
    if (!username) errors.push('学号为空');
    else if (typeof rawId !== 'string') errors.push('学号须为文本，请按样例设置，避免丢失开头的零');
    else if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) errors.push('学号须为 1–32 位字母、数字、下划线或短横线');
    if (!name) errors.push('姓名为空');
    else if (typeof rawName !== 'string' || name.length > 30 || /[\u0000-\u001f\u007f]/.test(name)) errors.push('姓名须为 1–30 个普通文字字符');
    if (r.cells.some((v, i) => i !== idColumn && i !== nameColumn && v !== null && String(v).trim() !== '')) errors.push('本行存在“学号、姓名”以外的内容');
    return { row: r.row, username, name, errors };
  });
  if (!entries.length) invalid('名单中没有学生，请在表头下面填写学号和姓名');
  if (entries.length > 500) invalid('每次最多导入 500 名学生，请拆分名单');
  const occurrences = new Map();
  for (const e of entries) if (e.username) occurrences.set(e.username, [...(occurrences.get(e.username) ?? []), e.row]);
  for (const e of entries) if (occurrences.get(e.username)?.length > 1) e.errors.push(`学号在文件第 ${occurrences.get(e.username).join('、')} 行重复，这些行均跳过`);
  return entries;
}

export async function importRoster(db, classId, entries) {
  const candidates = [];
  for (const e of entries) {
    if (e.username && db.prepare('SELECT 1 FROM users WHERE username=?').get(e.username)) e.errors.push('账号已存在，保留原姓名、密码和班级');
    if (!e.errors.length) candidates.push({ ...e, hash: await hashPassword(e.username) });
  }
  const students = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of candidates) {
      const result = db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) VALUES(?,?,?,'student',?) ON CONFLICT(username) DO NOTHING").run(e.username, e.name, e.hash, classId);
      if (result.changes) students.push({ id: Number(result.lastInsertRowid), username: e.username, name: e.name, classId });
      else entries.find(row => row.row === e.row).errors.push('账号已存在，保留原姓名、密码和班级');
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const issues = entries.filter(e => e.errors.length);
  return { classId, total: entries.length, created: students.length, skipped: issues.length, students, issues };
}
