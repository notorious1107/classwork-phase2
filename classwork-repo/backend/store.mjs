import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, randomInt } from 'node:crypto';
import { promisify } from 'node:util';

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
export function generateQuestions(category = 'add-sub-20', questionCount = 10) {
  if (!categories.includes(category) || !questionCounts.includes(questionCount)) throw new Error('无效的作业题型或题量');
  const questions = [];
  const used = new Set();
  while (questions.length < questionCount) {
    let q;
    if (category === 'mixed-100') {
      const ops = ['+', '-', '*', '/'];
      const inner = binaryQuestion(ops[questions.length % 4], 100);
      const op = ops[(questions.length + 1) % 4];
      const right = randomInt(2) === 1;
      const value = solution(inner);
      const candidates = Array.from({ length: 101 }, (_, n) => n).filter(n => {
        const a = right ? n : value, b = right ? value : n;
        const result = operators[op].apply(a, b);
        return (op !== '/' || b !== 0) && Number.isInteger(result) && result >= 0 && result <= 100;
      });
      if (!candidates.length) continue;
      const n = candidates[randomInt(candidates.length)];
      q = { a: right ? n : inner, b: right ? inner : n, op };
    } else {
      const ops = category === 'add-sub-20' ? ['+', '-'] : ['*', '/'];
      q = binaryQuestion(ops[questions.length % 2], 20);
    }
    const key = JSON.stringify(q);
    if (used.has(key)) continue;
    used.add(key);
    questions.push(q);
  }
  return questions;
}

export function publishAssignment(db, title, { category = 'add-sub-20', questionCount = 10, dueAt = null } = {}) {
  const result = db.prepare('INSERT INTO assignments(title,questions,created_at,category,due_at) VALUES(?,?,?,?,?)')
    .run(title, JSON.stringify(generateQuestions(category, questionCount)), new Date().toISOString(), category, dueAt);
  return Number(result.lastInsertRowid);
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
  if (!db.prepare("SELECT id FROM users WHERE role='teacher'").get()) {
    db.prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
      .run('teacher', '数学老师', await hashPassword(teacherPassword), 'teacher');
  }
  return db;
}
