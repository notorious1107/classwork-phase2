import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openStore, hashPassword, verifyPassword, publishAssignment, solution, formatExpression, inferCategory, questionCategoriesFor } from './store.mjs';
import { practiceOptions } from './questions.mjs';
import { paperOptions } from './papers.mjs';
import { readPreview, createPreview, publishPreview } from './previews.mjs';
import { parseRoster, importRoster, rosterMaxBytes } from './roster.mjs';
import { calendarMonth, beijingDateKey } from './calendar.mjs';
import { assignmentStudents } from './reporting.mjs';
import { analyticsFilters, analyticsSelection, aggregatePractice } from './analytics.mjs';
import { historyFilters, matchesTopic, submissionStatus } from './records.mjs';
import { mistakeBook, mistakeSource, correctionQuestion, correctionHistory, submitCorrection } from './corrections.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const safeUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, classId: u.role === 'student' ? u.class_id ?? 1 : null });
const digest = token => createHash('sha256').update(token).digest('hex');
const cookie = (value, age) => `classwork_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;

async function body(req, maxBytes = 16_384) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请使用 JSON 请求');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > maxBytes) fail(413, '请求内容过大');
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
function validateAnswers(answers, complete, answerMax, questionCount, answerMaxes, allowIncomplete = false) {
  if (!Array.isArray(answers) || answers.length !== questionCount ||
      answers.some((a, i) => a !== null && (!Number.isInteger(a) || a < 0 || a > (answerMaxes?.[i] ?? answerMax)))) {
    fail(400, `请填写 0–${answerMax} 的整数，本份作业共 ${questionCount} 题`);
  }
  if (complete && answers.includes(null) && !allowIncomplete) fail(400, `还有 ${answers.filter(a => a === null).length} 题未作答，请返回补答，或确认按现有答案交卷`);
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
  const questionCategories = questionCategoriesFor(row, questions), selectedCategories = row.selected_categories ? JSON.parse(row.selected_categories) : category === 'composite' ? [...new Set(questionCategories)] : [category];
  const answerMaxes = questionCategories.map(c => c === 'mixed-100' ? 100 : 20);
  return {
    id: row.id, title: row.title, createdAt: row.created_at, category, questionCount: questions.length, dueAt: row.due_at ?? null,
    timeLimitMinutes: row.time_limit_minutes ?? null,
    difficulty: row.difficulty ?? null, grade: row.mixed_grade ?? null, knowledgePoints: row.knowledge_points ? JSON.parse(row.knowledge_points) : [],
    knowledgePointNames: row.knowledge_points ? JSON.parse(row.knowledge_points).map(id => practiceOptions.topics.find(t => t.id === id)?.name ?? id) : [],
    selectedCategories, questionCategories, components: selectedCategories.map(category => ({ category, count: questionCategories.filter(c => c === category).length })),
    answerMax: Math.max(...answerMaxes), answerMaxes,
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
  function validClassId(value) {
    if (!Number.isInteger(value) || !db.prepare('SELECT id FROM classes WHERE id=?').get(value)) fail(400, '请选择有效班级');
    return value;
  }
  function classFilter(url) {
    return url.searchParams.has('classId') ? validClassId(Number(url.searchParams.get('classId'))) : null;
  }
  function assignmentSettings(input) {
    const title = textField(input.title, '作业名称', 1, 60);
    const classIds = input.classIds === undefined ? [1] : input.classIds;
    if (!Array.isArray(classIds) || !classIds.length || new Set(classIds).size !== classIds.length) fail(400, '请选择至少一个班级，不能重复');
    classIds.forEach(validClassId);
    const dueAt = validateDueAt(input.dueAt, clock()), timeLimitMinutes = input.timeLimitMinutes ?? null;
    if (timeLimitMinutes !== null && (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes < 1 || timeLimitMinutes > 1440)) fail(400, '个人限时请填写 1–1440 的整数分钟，或留空');
    return { ...paperOptions(input), title, classIds, dueAt, timeLimitMinutes };
  }
  function withClasses(row) {
    const classes = db.prepare('SELECT c.id,c.name FROM classes c JOIN assignment_classes ac ON ac.class_id=c.id WHERE ac.assignment_id=? ORDER BY c.id').all(row.id);
    return { ...readAssignment(row), classes, classIds: classes.map(c => c.id) };
  }
  function canAccess(a, user) {
    return a.classIds.includes(user.class_id ?? 1) || !!db.prepare('SELECT 1 FROM legacy_assignment_students WHERE assignment_id=? AND student_id=?').get(a.id, user.id);
  }
  function requireAccess(a, user) { if (user.role === 'student' && !canAccess(a, user)) fail(404, '作业不存在'); }
  function currentStudent(user) { return db.prepare('SELECT * FROM users WHERE id=?').get(user.id); }
  function assignment(id) {
    const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
    if (!row) fail(404, '作业不存在');
    return withClasses(row);
  }
  function studentView(a, studentId) {
    const s = db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id, studentId);
    const start = db.prepare('SELECT started_at FROM assignment_starts WHERE assignment_id=? AND student_id=?').get(a.id, studentId);
    const personalDue = a.timeLimitMinutes && start ? Date.parse(start.started_at) + a.timeLimitMinutes * 60_000 : null;
    const deadlines = [a.dueAt && Date.parse(a.dueAt), personalDue].filter(v => v !== null && v !== false);
    const effectiveDueAt = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
    const result = { ...a, startedAt: start?.started_at ?? null, effectiveDueAt,
      isClosed: effectiveDueAt !== null && clock() >= Date.parse(effectiveDueAt),
      answers: s ? JSON.parse(s.answers) : Array(a.questionCount).fill(null), savedAt: s?.saved_at ?? null,
      submittedAt: s?.submitted_at ?? null, score: s?.score ?? null, draftRevision: s?.draft_revision ?? 0 };
    if (a.timeLimitMinutes) result.serverNow = new Date(clock()).toISOString();
    if (a.timeLimitMinutes && !start && !s?.submitted_at) {
      result.questions = []; result.expressions = []; result.answers = [];
    }
    if (s?.submitted_at) result.results = a.questions.map((q, i) => {
      const correctAnswer = solution(q);
      return { correctAnswer, correct: result.answers[i] === correctAnswer, missing: result.answers[i] == null || result.answers[i] === '' };
    });
    return result;
  }
  function report(a, classId = null) {
    const students = assignmentStudents(db, a, classId);
    const submitted = students.filter(s => s.submittedAt);
    return { ...a, reportClassId: classId, isClosed: isClosed(a),
      students, total: students.length, submitted: submitted.length,
      pending: students.length - submitted.length,
      average: submitted.length ? Math.round(submitted.reduce((sum, s) => sum + s.score, 0) / submitted.length * 10) / 10 : null };
  }
  function student(id) {
    const row = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(id);
    if (!row) fail(404, '学生不存在');
    return row;
  }
  function review(a, studentId, classId) {
    if (classId === null) fail(400, '请先选择班级');
    if (!report(a, classId).students.some(s => s.id === studentId)) fail(404, '该学生不在本班这份作业的成绩名单中');
    const pupil = student(studentId);
    const s = db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id, studentId);
    const answers = s ? JSON.parse(s.answers) : Array(a.questionCount).fill(null);
    return { ...a, reviewClassId: classId, student: safeUser(pupil), status: submissionStatus(s),
      savedAt: s?.saved_at ?? null, submittedAt: s?.submitted_at ?? null, score: s?.submitted_at ? s.score : null,
      answers, results: a.questions.map((q, i) => {
        const correctAnswer = solution(q);
        return { correctAnswer, correct: s?.submitted_at ? answers[i] === correctAnswer : null, missing: s?.submitted_at ? answers[i] == null || answers[i] === '' : null };
      }) };
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
        if (!u || !valid || db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id)?.password_hash !== u.password_hash) {
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
      const recheckSession = () => {
        if (!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires>?').get(digest(rawToken), user.id, Date.now())) fail(401, '登录已失效，请重新登录');
      };
      if (path === '/api/me' && req.method === 'GET') return send(200, safeUser(user));
      if (path === '/api/me/password' && req.method === 'PUT') {
        requireRole(user, 'student');
        const input = await body(req), currentPassword = textField(input.currentPassword, '原密码', 1, 128), password = textField(input.newPassword, '新密码', 8, 128);
        if (!await verifyPassword(currentPassword, user.password_hash)) fail(400, '原密码不正确');
        const hash = await hashPassword(password);
        recheckSession();
        const changed = db.prepare("UPDATE users SET password_hash=? WHERE id=? AND role='student' AND password_hash=?").run(hash, user.id, user.password_hash);
        if (!changed.changes) fail(409, '密码已在其他窗口改变，请重新登录后重试');
        db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, digest(rawToken));
        return send(200, { ok: true });
      }
      const passwordMatch = path.match(/^\/api\/students\/([1-9]\d*)\/password$/);
      if (passwordMatch && req.method === 'PUT') {
        requireRole(user, 'teacher');
        const input = await body(req), classId = validClassId(input.classId), pupil = student(Number(passwordMatch[1]));
        if ((pupil.class_id ?? 1) !== classId) fail(404, '该学生不在当前班级');
        const hash = await hashPassword(textField(input.newPassword, '新密码', 8, 128));
        recheckSession();
        const changed = db.prepare("UPDATE users SET password_hash=? WHERE id=? AND role='student' AND COALESCE(class_id,1)=?").run(hash, pupil.id, classId);
        if (!changed.changes) fail(409, '学生已转班，请刷新当前名单后重试');
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(pupil.id);
        return send(200, { ok: true, student: safeUser(pupil) });
      }
      if (path === '/api/assignment-previews/current' && req.method === 'GET') { requireRole(user, 'teacher'); return send(200, { preview: readPreview(db, user.id) }); }
      if (path === '/api/assignment-previews' && req.method === 'POST') {
        requireRole(user, 'teacher'); const settings = assignmentSettings(await body(req));
        return send(201, createPreview(db, user.id, settings, clock()));
      }
      const publishMatch = path.match(/^\/api\/assignment-previews\/([^/]+)\/publish$/);
      if (publishMatch && req.method === 'POST') {
        requireRole(user, 'teacher'); await body(req);
        const result = publishPreview(db, user.id, decodeURIComponent(publishMatch[1]), clock(), assignmentSettings);
        return send(result.created ? 201 : 200, report(assignment(result.id)));
      }
      if (path === '/api/mistakes' && req.method === 'GET') {
        requireRole(user, 'student'); return send(200, mistakeBook(db, user.id));
      }
      const mistakeMatch = path.match(/^\/api\/mistakes\/([1-9]\d*)\/([1-9]\d*)(?:\/(attempts|original))?$/);
      if (mistakeMatch) {
        requireRole(user, 'student');
        const assignmentId = Number(mistakeMatch[1]), questionNumber = Number(mistakeMatch[2]), action = mistakeMatch[3];
        mistakeSource(db, user.id, assignmentId, questionNumber);
        if (!action && req.method === 'GET') return send(200, correctionQuestion(db, user.id, assignmentId, questionNumber));
        if (action === 'original' && req.method === 'GET') return send(200, studentView(assignment(assignmentId), user.id));
        if (action === 'attempts' && req.method === 'GET') return send(200, correctionHistory(db, user.id, assignmentId, questionNumber));
        if (action === 'attempts' && req.method === 'POST') {
          const input = await body(req);
          const result = submitCorrection(db, user.id, assignmentId, questionNumber, input, clock());
          return send(result.created ? 201 : 200, result.result);
        }
      }
      if (path === '/api/practice-options' && req.method === 'GET') { requireRole(user, 'teacher'); return send(200, practiceOptions); }
      const historyMatch = path.match(/^\/api\/students\/([1-9]\d*)\/history$/);
      if (historyMatch && req.method === 'GET') {
        requireRole(user, 'teacher');
        const classId = classFilter(url);
        if (classId === null) fail(400, '请先选择班级');
        const pupil = student(Number(historyMatch[1]));
        if ((pupil.class_id ?? 1) !== classId) fail(404, '该学生不在当前班级');
        const filters = historyFilters(url);
        const rows = db.prepare(`SELECT a.*,s.saved_at,s.submitted_at,s.score FROM assignments a
          LEFT JOIN submissions s ON s.assignment_id=a.id AND s.student_id=?
          WHERE (?='' OR julianday(a.created_at)>=julianday(?)) AND (?='' OR julianday(a.created_at)<julianday(?)+1)
          ORDER BY julianday(a.created_at) DESC,a.id DESC`).all(pupil.id, filters.from, `${filters.from}T00:00:00+08:00`, filters.to, `${filters.to}T00:00:00+08:00`);
        const assignments = [];
        for (const row of rows) {
          const a = withClasses(row);
          if (!canAccess(a, pupil) || !matchesTopic(a, filters.topic)) continue;
          const reviewClassId = a.classIds.includes(classId) ? classId : 1;
          assignments.push({ id: a.id, title: a.title, createdAt: a.createdAt, dueAt: a.dueAt, category: a.category,
            questionCount: a.questionCount, knowledgePoints: a.knowledgePoints, knowledgePointNames: a.knowledgePointNames, components: a.components,
            savedAt: row.saved_at ?? null, submittedAt: row.submitted_at ?? null, score: row.submitted_at ? row.score : null,
            status: submissionStatus(row), reviewClassId, reviewClassName: a.classes.find(c => c.id === reviewClassId).name });
        }
        return send(200, { classId, student: safeUser(pupil), filters, timeZone: 'Asia/Shanghai', assignments });
      }
      const reviewMatch = path.match(/^\/api\/assignments\/([1-9]\d*)\/students\/([1-9]\d*)$/);
      if (reviewMatch && req.method === 'GET') {
        requireRole(user, 'teacher');
        return send(200, review(assignment(Number(reviewMatch[1])), Number(reviewMatch[2]), classFilter(url)));
      }
      if (path === '/api/analytics' && req.method === 'GET') {
        requireRole(user, 'teacher');
        const classId = classFilter(url);
        if (classId === null) fail(400, '请先选择班级');
        const filters = analyticsFilters(url, clock()), selection = analyticsSelection(url);
        const rows = db.prepare(`SELECT a.* FROM assignments a JOIN assignment_classes ac ON ac.assignment_id=a.id
          WHERE ac.class_id=? AND (?='' OR julianday(a.created_at)>=julianday(?))
          AND (?='' OR julianday(a.created_at)<julianday(?)+1)
          ORDER BY julianday(a.created_at) DESC,a.id DESC`).all(classId, filters.from, `${filters.from}T00:00:00+08:00`, filters.to, `${filters.to}T00:00:00+08:00`);
        const papers = rows.map(row => { const a = withClasses(row); return { assignment: a, students: assignmentStudents(db, a, classId, true) }; });
        return send(200, { classId, className: db.prepare('SELECT name FROM classes WHERE id=?').get(classId).name,
          filters, timeZone: 'Asia/Shanghai', ...aggregatePractice(papers, selection) });
      }
      if (path === '/api/calendar' && req.method === 'GET') {
        requireRole(user, 'teacher');
        const classId = classFilter(url);
        if (classId === null) fail(400, '请先选择班级');
        const today = beijingDateKey(new Date(clock()).toISOString());
        const month = url.searchParams.has('month') ? url.searchParams.get('month') : today.slice(0, 7);
        const { start, days } = calendarMonth(month);
        const grouped = new Map(days.map(date => [date, { date, assignments: [] }]));
        const rows = db.prepare(`SELECT a.* FROM assignments a JOIN assignment_classes ac ON ac.assignment_id=a.id
          WHERE ac.class_id=? AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?)+?
          ORDER BY julianday(a.created_at) DESC,a.id DESC`).all(classId, start, start, days.length);
        for (const row of rows) {
          const a = withClasses(row), summary = report(a, classId);
          grouped.get(beijingDateKey(a.createdAt)).assignments.push({
            id: a.id, title: a.title, createdAt: a.createdAt, dueAt: a.dueAt,
            category: a.category, questionCount: a.questionCount, components: a.components, difficulty: a.difficulty,
            submitted: summary.submitted, pending: summary.pending, total: summary.total, average: summary.average
          });
        }
        return send(200, { classId, className: db.prepare('SELECT name FROM classes WHERE id=?').get(classId).name,
          month, today, timeZone: 'Asia/Shanghai', total: rows.length, days: [...grouped.values()] });
      }
      if (path === '/api/classes') {
        requireRole(user, 'teacher');
        if (req.method === 'GET') return send(200, db.prepare('SELECT id,name FROM classes ORDER BY id').all());
        if (req.method === 'POST') {
          const input = await body(req), name = textField(input.name, '班级名称', 1, 30);
          try {
            const result = db.prepare('INSERT INTO classes(name) VALUES(?)').run(name);
            return send(201, { id: Number(result.lastInsertRowid), name });
          } catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, '班级名称已存在'); throw e; }
        }
      }
      const classMatch = path.match(/^\/api\/classes\/([1-9]\d*)$/);
      if (classMatch && req.method === 'PUT') {
        requireRole(user, 'teacher'); const id = validClassId(Number(classMatch[1]));
        const input = await body(req), name = textField(input.name, '班级名称', 1, 30);
        try { db.prepare('UPDATE classes SET name=? WHERE id=?').run(name, id); }
        catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, '班级名称已存在'); throw e; }
        return send(200, { id, name });
      }
      const studentMatch = path.match(/^\/api\/students\/([1-9]\d*)$/);
      if (studentMatch && req.method === 'PUT') {
        requireRole(user, 'teacher'); const input = await body(req), classId = validClassId(input.classId);
        const result = db.prepare("UPDATE users SET class_id=? WHERE id=? AND role='student'").run(classId, Number(studentMatch[1]));
        if (!result.changes) fail(404, '学生不存在'); return send(200, { ok: true });
      }
      if (path === '/api/students/import' && req.method === 'POST') {
        requireRole(user, 'teacher');
        const input = await body(req, Math.ceil(rosterMaxBytes * 4 / 3) + 1024);
        const classId = validClassId(input.classId);
        if (typeof input.content !== 'string' || !input.content.length) fail(400, '文件内容无效，请重新选择名单文件');
        const content = Buffer.from(input.content, 'base64');
        if (content.toString('base64') !== input.content) fail(400, '文件内容无效，请重新选择名单文件');
        const entries = await parseRoster(input.format, content);
        return send(200, await importRoster(db, classId, entries));
      }
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(rawToken));
        return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/students') {
        requireRole(user, 'teacher');
        if (req.method === 'GET') {
          const selected = classFilter(url);
          return send(200, db.prepare(`SELECT id,username,name,COALESCE(class_id,1) AS classId FROM users WHERE role='student'
            ${selected === null ? '' : 'AND COALESCE(class_id,1)=?'} ORDER BY id`).all(...(selected === null ? [] : [selected])));
        }
        if (req.method === 'POST') {
          const input = await body(req);
          const username = textField(input.username, '账号', 3, 32);
          if (!/^[a-zA-Z0-9_-]+$/.test(username)) fail(400, '账号仅支持字母、数字、下划线和短横线');
          const name = textField(input.name, '姓名', 1, 30);
          const password = textField(input.password, '密码', 8, 128);
          const classId = validClassId(input.classId === undefined ? 1 : input.classId);
          const hash = await hashPassword(password);
          try {
            const result = db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) VALUES(?,?,?,'student',?)").run(username, name, hash, classId);
            return send(201, { id: Number(result.lastInsertRowid), username, name, classId });
          } catch (e) {
            if (String(e.message).includes('UNIQUE')) fail(409, '账号已存在，请更换账号');
            throw e;
          }
        }
      }
      if (path === '/api/assignments') {
        if (req.method === 'GET') {
          let list = db.prepare('SELECT * FROM assignments ORDER BY id DESC').all().map(withClasses);
          const selected = user.role === 'teacher' ? classFilter(url) : null;
          list = list.filter(a => user.role === 'teacher' ? selected === null || a.classIds.includes(selected) : canAccess(a, user));
          return send(200, list.map(a => user.role === 'teacher' ? report(a, selected) : studentView(a, user.id)));
        }
        if (req.method === 'POST') {
          requireRole(user, 'teacher');
          const settings = assignmentSettings(await body(req));
          const id = publishAssignment(db, settings.title, settings);
          return send(201, report(assignment(id)));
        }
      }
      const match = path.match(/^\/api\/assignments\/([1-9]\d*)(?:\/(draft|submit|report|start))?$/);
      if (match) {
        const a = assignment(Number(match[1]));
        const action = match[2];
        if (action === 'report' && req.method === 'GET') {
          requireRole(user, 'teacher'); return send(200, report(a, classFilter(url)));
        }
        requireAccess(a, user);
        if (!action && req.method === 'GET') {
          return send(200, user.role === 'teacher' ? report(a, classFilter(url)) : studentView(a, user.id));
        }
        if (action === 'start' && req.method === 'POST') {
          requireRole(user, 'student'); await body(req); recheckSession(); requireAccess(a, currentStudent(user));
          const view = studentView(a, user.id);
          if (view.startedAt || view.submittedAt) return send(200, view);
          if (isClosed(a)) fail(409, '作业已截止，不能开始作答');
          db.prepare('INSERT OR IGNORE INTO assignment_starts(assignment_id,student_id,started_at) VALUES(?,?,?)')
            .run(a.id, user.id, new Date(clock()).toISOString());
          return send(200, studentView(a, user.id));
        }
        if ((action === 'draft' && req.method === 'PUT') || (action === 'submit' && req.method === 'POST')) {
          requireRole(user, 'student');
          const existing = studentView(a, user.id);
          if (existing.submittedAt) {
            if (action === 'submit') return send(200, existing);
            fail(409, '作业已提交，不能再修改答案');
          }
          const input = await body(req);
          recheckSession();
          requireAccess(a, currentStudent(user));
          // A request may wait for its body while another request submits this work.
          const latest = studentView(a, user.id);
          if (latest.submittedAt) {
            if (action === 'submit') return send(200, latest);
            fail(409, '作业已提交，不能再修改答案');
          }
          if (a.timeLimitMinutes && !latest.startedAt) fail(400, '请先点击开始作答');
          const answers = validateAnswers(input.answers, action === 'submit', a.answerMax, a.questionCount, a.answerMaxes, input.allowIncomplete === true);
          if (input.draftRevision !== undefined && (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0)) fail(400, '草稿版本无效，请重新打开作业');
          const conflict = () => send(409, { error: '草稿已在其他窗口更新。已保留本页答案，请选择载入已保存草稿，或确认保留本页答案后再保存。', code: 'DRAFT_CONFLICT', draftRevision: studentView(a, user.id).draftRevision });
          let revision = input.draftRevision ?? null;
          if (revision !== null && revision !== latest.draftRevision) {
            // A lost save response can safely be retried when the stored answers are identical.
            if (JSON.stringify(answers) !== JSON.stringify(latest.answers)) return conflict();
            if (action === 'draft') return send(200, latest);
            revision = latest.draftRevision;
          }
          const correct = a.questions.filter((q, i) => solution(q) === answers[i]).length;
          const score = action === 'submit' ? correct * 100 / a.questionCount : null;
          const stamp = clock();
          if (action === 'submit' && latest.effectiveDueAt !== null && stamp >= Date.parse(latest.effectiveDueAt)) {
            fail(409, '作业已截止或个人时间已用完，不能再提交；仍可保存草稿，老师处计为未交');
          }
          const savedAt = new Date(stamp).toISOString();
          const written = db.prepare(`INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score,draft_revision)
            VALUES(?,?,?,?,?,?,1) ON CONFLICT(assignment_id,student_id) DO UPDATE SET
            answers=excluded.answers,saved_at=excluded.saved_at,submitted_at=excluded.submitted_at,score=excluded.score,draft_revision=COALESCE(submissions.draft_revision,0)+1
            WHERE submissions.submitted_at IS NULL AND (? IS NULL OR COALESCE(submissions.draft_revision,0)=?)`)
            .run(a.id, user.id, JSON.stringify(answers), savedAt, action === 'submit' ? savedAt : null, score, revision, revision);
          if (!written.changes) {
            const current = studentView(a, user.id);
            if (!current.submittedAt) return conflict();
            if (action === 'draft') fail(409, '作业已提交，不能再修改答案');
          }
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
