import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openStore, hashPassword, verifyPassword, publishAssignment, solution, formatExpression, inferCategory, categories, questionCounts } from './store.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const safeUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });
const digest = token => createHash('sha256').update(token).digest('hex');
const cookie = (value, age) => `classwork_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请使用 JSON 请求');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 16_384) fail(413, '请求内容过大');
  }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { fail(400, '请求内容不是有效 JSON'); }
}
function textField(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    fail(400, `${label}需为 ${min}–${max} 个字符`);
  }
  return value.trim();
}
function validateAnswers(answers, complete, answerMax, questionCount) {
  if (!Array.isArray(answers) || answers.length !== questionCount ||
      answers.some(a => a !== null && (!Number.isInteger(a) || a < 0 || a > answerMax))) {
    fail(400, `请填写 0–${answerMax} 的整数，本份作业共 ${questionCount} 题`);
  }
  if (complete && answers.includes(null)) fail(400, `还有题目未作答，请完成全部 ${questionCount} 题再提交`);
  return answers;
}

function validateDueAt(value, currentTime) {
  if (value === undefined || value === null || value === '') return null;
  // Require an explicit timezone, and reject dates that Date.parse would silently roll over.
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) fail(400, '截止时间格式无效，请填写带时区的日期时间');
  const [, year, month, day, hour, minute, second = '0', , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const stamp = Date.parse(value);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) || !Number.isFinite(stamp)) {
    fail(400, '截止时间不是有效的日期时间');
  }
  if (stamp <= currentTime) fail(400, '截止时间须晚于当前时间（北京时间）');
  return new Date(stamp).toISOString();
}

function readAssignment(row) {
  const questions = JSON.parse(row.questions);
  const category = row.category ?? inferCategory(questions);
  return {
    id: row.id, title: row.title, createdAt: row.created_at, category, questionCount: questions.length, dueAt: row.due_at ?? null,
    answerMax: category === 'mixed-100' ? 100 : 20,
    questions, expressions: questions.map(q => formatExpression(q))
  };
}

export async function createApp({ dbPath = 'data/classwork.sqlite', teacherPassword, logger = console, clock = Date.now } = {}) {
  const db = await openStore(dbPath, teacherPassword);
  const attempts = new Map();
  const isClosed = a => a.dueAt !== null && clock() >= Date.parse(a.dueAt);
  function requireRole(user, role) {
    if (user.role !== role) fail(403, '当前账号无权执行此操作');
  }
  function assignment(id) {
    const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
    if (!row) fail(404, '作业不存在');
    return readAssignment(row);
  }
  function studentView(a, studentId) {
    const s = db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id, studentId);
    const result = { ...a, isClosed: isClosed(a),
      answers: s ? JSON.parse(s.answers) : Array(a.questionCount).fill(null), savedAt: s?.saved_at ?? null,
      submittedAt: s?.submitted_at ?? null, score: s?.score ?? null };
    if (s?.submitted_at) result.results = a.questions.map((q, i) => {
      const correctAnswer = solution(q);
      return { correctAnswer, correct: result.answers[i] === correctAnswer };
    });
    return result;
  }
  function report(a) {
    const students = db.prepare(`SELECT u.id,u.username,u.name,s.submitted_at,s.saved_at,s.score
      FROM users u LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=?
      WHERE u.role='student' ORDER BY u.id`).all(a.id).map(s => ({
        id: s.id, username: s.username, name: s.name,
        submittedAt: s.submitted_at ?? null, savedAt: s.saved_at ?? null, score: s.score ?? null
      }));
    const submitted = students.filter(s => s.submittedAt);
    return { ...a, isClosed: isClosed(a),
      students, total: students.length, submitted: submitted.length,
      pending: students.length - submitted.length,
      average: submitted.length ? Math.round(submitted.reduce((sum, s) => sum + s.score, 0) / submitted.length * 10) / 10 : null };
  }
  const server = createServer(async (req, res) => {
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (!['GET', 'POST', 'PUT'].includes(req.method)) fail(405, '不支持此请求方法');
      if (req.method !== 'GET' && req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { fail(403, '请求来源无效'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, '请求来源不受信任');
      }
      if (path === '/api/health' && req.method === 'GET') return send(200, { ok: true });
      if (path === '/api/login' && req.method === 'POST') {
        const input = await body(req);
        const username = textField(input.username, '账号', 1, 32);
        const password = textField(input.password, '密码', 1, 128);
        const key = `${req.socket.remoteAddress}:${username}`;
        const cutoff = Date.now();
        for (const [k, value] of attempts) if (value.until <= cutoff) attempts.delete(k);
        const entry = attempts.get(key) ?? { count: 0, until: cutoff + 60_000 };
        if (entry.count >= 10) fail(429, '尝试次数过多，请 1 分钟后重试');
        const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        // Use a real hash even for unknown users to avoid a fast username probe.
        const fallback = db.prepare("SELECT password_hash FROM users WHERE role='teacher'").get().password_hash;
        const valid = await verifyPassword(password, u?.password_hash ?? fallback);
        if (!u || !valid) {
          entry.count++; attempts.set(key, entry);
          fail(401, '账号或密码不正确');
        }
        attempts.delete(key);
        const token = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), u.id, Date.now() + 7 * 86400_000);
        return send(200, safeUser(u), { 'Set-Cookie': cookie(token, 7 * 86400) });
      }
      const rawToken = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('classwork_session='))?.slice(18);
      const user = rawToken && db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE s.token_hash=? AND s.expires>?`).get(digest(rawToken), Date.now());
      if (!user) fail(401, '请先登录');
      if (path === '/api/me' && req.method === 'GET') return send(200, safeUser(user));
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(rawToken));
        return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/students') {
        requireRole(user, 'teacher');
        if (req.method === 'GET') return send(200, db.prepare("SELECT id,username,name FROM users WHERE role='student' ORDER BY id").all());
        if (req.method === 'POST') {
          const input = await body(req);
          const username = textField(input.username, '账号', 3, 32);
          if (!/^[a-zA-Z0-9_-]+$/.test(username)) fail(400, '账号仅支持字母、数字、下划线和短横线');
          const name = textField(input.name, '姓名', 1, 30);
          const password = textField(input.password, '密码', 8, 128);
          const hash = await hashPassword(password);
          try {
            const result = db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,'student')").run(username, name, hash);
            return send(201, { id: Number(result.lastInsertRowid), username, name });
          } catch (e) {
            if (String(e.message).includes('UNIQUE')) fail(409, '账号已存在，请更换账号');
            throw e;
          }
        }
      }
      if (path === '/api/assignments') {
        if (req.method === 'GET') {
          const list = db.prepare('SELECT * FROM assignments ORDER BY id DESC').all().map(readAssignment);
          return send(200, list.map(a => user.role === 'teacher' ? report(a) : studentView(a, user.id)));
        }
        if (req.method === 'POST') {
          requireRole(user, 'teacher');
          const input = await body(req);
          const title = textField(input.title, '作业名称', 1, 60);
          const category = input.category === undefined ? 'add-sub-20' : input.category;
          const questionCount = input.questionCount === undefined ? 10 : input.questionCount;
          if (!categories.includes(category)) fail(400, '请选择一种有效题型');
          if (!questionCounts.includes(questionCount)) fail(400, '题目数量请选择 10、20 或 50 道');
          const dueAt = validateDueAt(input.dueAt, clock());
          const id = publishAssignment(db, title, { category, questionCount, dueAt });
          return send(201, report(assignment(id)));
        }
      }
      const match = path.match(/^\/api\/assignments\/([1-9]\d*)(?:\/(draft|submit|report))?$/);
      if (match) {
        const a = assignment(Number(match[1]));
        const action = match[2];
        if (action === 'report' && req.method === 'GET') {
          requireRole(user, 'teacher'); return send(200, report(a));
        }
        if (!action && req.method === 'GET') {
          return send(200, user.role === 'teacher' ? report(a) : studentView(a, user.id));
        }
        if ((action === 'draft' && req.method === 'PUT') || (action === 'submit' && req.method === 'POST')) {
          requireRole(user, 'student');
          const existing = studentView(a, user.id);
          if (existing.submittedAt) {
            if (action === 'submit') return send(200, existing);
            fail(409, '作业已提交，不能再修改答案');
          }
          const input = await body(req);
          // A request may wait for its body while another request submits this work.
          const latest = studentView(a, user.id);
          if (latest.submittedAt) {
            if (action === 'submit') return send(200, latest);
            fail(409, '作业已提交，不能再修改答案');
          }
          const answers = validateAnswers(input.answers, action === 'submit', a.answerMax, a.questionCount);
          const correct = a.questions.filter((q, i) => solution(q) === answers[i]).length;
          const score = action === 'submit' ? correct * 100 / a.questionCount : null;
          const stamp = clock();
          if (action === 'submit' && a.dueAt !== null && stamp >= Date.parse(a.dueAt)) {
            fail(409, '作业已截止，不能再提交；仍可保存草稿，老师处计为未交');
          }
          const savedAt = new Date(stamp).toISOString();
          const written = db.prepare(`INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score)
            VALUES(?,?,?,?,?,?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET
            answers=excluded.answers,saved_at=excluded.saved_at,submitted_at=excluded.submitted_at,score=excluded.score
            WHERE submissions.submitted_at IS NULL`)
            .run(a.id, user.id, JSON.stringify(answers), savedAt, action === 'submit' ? savedAt : null, score);
          if (!written.changes && action === 'draft') fail(409, '作业已提交，不能再修改答案');
          return send(200, studentView(a, user.id));
        }
      }
      fail(404, '接口不存在');
    } catch (e) {
      if (!e.status) logger.error(e);
      send(e.status ?? 500, { error: e.status ? e.message : '服务暂时不可用，请稍后重试' });
    }
  });
  return { server, db };
}
