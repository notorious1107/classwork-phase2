import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { generateMixed, mixedOptions } from './questions.mjs';

const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export const categories = ['add-sub-20', 'mul-div-20', 'mixed-100'];
export const questionCounts = [10, 20, 50];

function binaryQuestion(op, max) {
  const a = randomInt(0, max + 1);
  const candidates = Array.from({ length: max + 1 }, (_, b) => b).filter(b => {
    const value = operators[op].apply(a, b);
    return (op !== '/' || b !== 0) && Number.isInteger(value) && value >= 0 && value <= max;
  });
  if (!candidates.length) return binaryQuestion(op, max);
  return { a, b: candidates[randomInt(candidates.length)], op };
}
export function generateQuestions(category = 'add-sub-20', questionCount = 10, options) {
  if (!categories.includes(category) || !questionCounts.includes(questionCount)) throw new Error('无效的作业题型或题量');
  if (category === 'mixed-100') return generateMixed(questionCount, options);
  const questions = [];
  const used = new Set();
  while (questions.length < questionCount) {
    let q;
    const ops = category === 'add-sub-20' ? ['+', '-'] : ['*', '/'];
    q = binaryQuestion(ops[questions.length % 2], 20);
    const key = JSON.stringify(q);
    if (used.has(key)) continue;
    used.add(key);
    questions.push(q);
  }
  return questions;
}

export function publishAssignment(db, title, { category = 'add-sub-20', questionCount = 10, dueAt = null, timeLimitMinutes = null, classIds = [1], ...input } = {}) {
  const options = category === 'mixed-100' ? mixedOptions(input) : null;
  const questions = JSON.stringify(generateQuestions(category, questionCount, options));
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`INSERT INTO assignments(title,questions,created_at,category,due_at,time_limit_minutes,question_count,difficulty,mixed_grade,knowledge_points)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(title, questions, new Date().toISOString(), category, dueAt, timeLimitMinutes,
      questionCount, options?.difficulty ?? null, options?.grade ?? null, options ? JSON.stringify(options.knowledgePoints) : null);
    const id = Number(result.lastInsertRowid);
    for (const classId of classIds) db.prepare('INSERT INTO assignment_classes(assignment_id,class_id) VALUES(?,?)').run(id, classId);
    db.exec('COMMIT'); return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const operators = {
  '+': { symbol: '＋', precedence: 1, apply: (a, b) => a + b },
  '-': { symbol: '−', precedence: 1, apply: (a, b) => a - b },
  '*': { symbol: '×', precedence: 2, apply: (a, b) => a * b },
  '/': { symbol: '÷', precedence: 2, apply: (a, b) => a / b }
};
const aliases = { '＋': '+', '−': '-', '×': '*', '÷': '/' };
function operator(op) {
  const key = aliases[op] ?? op;
  if (!Object.hasOwn(operators, key)) throw new Error('题目含有未知的运算符');
  return operators[key];
}
export function solution(q) {
  if (typeof q === 'number') return q;
  return operator(q.op).apply(solution(q.a), solution(q.b));
}
export function inferCategory(questions) {
  if (questions.some(q => typeof q.a !== 'number' || typeof q.b !== 'number')) return 'mixed-100';
  const productsOrQuotients = questions.filter(q => operator(q.op).precedence === 2).length;
  if (productsOrQuotients === 0) return 'add-sub-20';
  return productsOrQuotients === questions.length ? 'mul-div-20' : 'mixed-100';
}
export function formatExpression(q, parentPrecedence = 0, right = false) {
  if (typeof q === 'number') return String(q);
  const { symbol, precedence } = operator(q.op);
  const expression = `${formatExpression(q.a, precedence)} ${symbol} ${formatExpression(q.b, precedence, true)}`;
  // Equal-precedence operations normally group from the left.
  return precedence < parentPrecedence || (right && precedence === parentPrecedence)
    ? `(${expression})` : expression;
}

export async function openStore(path, teacherPassword = 'Teacher123!') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('teacher','student'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL,
      questions TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      assignment_id INTEGER NOT NULL REFERENCES assignments(id),
      student_id INTEGER NOT NULL REFERENCES users(id), answers TEXT NOT NULL,
      saved_at TEXT NOT NULL, submitted_at TEXT, score INTEGER,
      PRIMARY KEY(assignment_id, student_id)
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='category'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN category TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='due_at'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN due_at TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='time_limit_minutes'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN time_limit_minutes INTEGER');
  }
  for (const [name, type] of [['question_count', 'INTEGER'], ['difficulty', 'TEXT'], ['mixed_grade', 'INTEGER'], ['knowledge_points', 'TEXT']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name=?").get(name)) db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_starts (
    assignment_id INTEGER NOT NULL REFERENCES assignments(id), student_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL, PRIMARY KEY(assignment_id,student_id)
  )`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const migratingClass = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignment_classes'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS classes(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      INSERT OR IGNORE INTO classes(id,name) VALUES(1,'原班级');`);
    if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='class_id'").get()) db.exec('ALTER TABLE users ADD COLUMN class_id INTEGER REFERENCES classes(id)');
    db.exec(`UPDATE users SET class_id=1 WHERE role='student' AND class_id IS NULL;
      CREATE TABLE IF NOT EXISTS assignment_classes(
        assignment_id INTEGER NOT NULL REFERENCES assignments(id), class_id INTEGER NOT NULL REFERENCES classes(id), PRIMARY KEY(assignment_id,class_id)
      );
      CREATE TABLE IF NOT EXISTS legacy_assignment_students(
        assignment_id INTEGER NOT NULL REFERENCES assignments(id), student_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(assignment_id,student_id)
      );`);
    if (migratingClass) db.exec(`INSERT INTO assignment_classes SELECT id,1 FROM assignments;
      INSERT INTO legacy_assignment_students SELECT a.id,u.id FROM assignments a CROSS JOIN users u WHERE u.role='student';`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (!db.prepare("SELECT id FROM users WHERE role='teacher'").get()) {
    db.prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
      .run('teacher', '数学老师', await hashPassword(teacherPassword), 'teacher');
  }
  return db;
}
