import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { paperOptions, generatePaper } from './papers.mjs';
import { initializePreviews } from './preview-store.mjs';
export { categories, questionCounts } from './papers.mjs';

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
export function generateQuestions(category = 'add-sub-20', questionCount = 10, options) {
  return generatePaper(paperOptions({ ...options, category, questionCount })).questions;
}

export function publishAssignment(db, title, { category = 'add-sub-20', questionCount = 10, dueAt = null, timeLimitMinutes = null, classIds = [1], ...input } = {}) {
  const options = { ...paperOptions({ ...input, category, questionCount }), title, dueAt, timeLimitMinutes, classIds };
  const paper = generatePaper(options);
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = insertAssignment(db, options, paper);
    db.exec('COMMIT'); return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Call inside a transaction so a preview publication and its published id are committed together.
export function insertAssignment(db, options, paper, createdAt = new Date().toISOString()) {
  const result = db.prepare(`INSERT INTO assignments(title,questions,created_at,category,due_at,time_limit_minutes,question_count,difficulty,mixed_grade,knowledge_points,selected_categories,question_categories)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(options.title, JSON.stringify(paper.questions), createdAt, options.category, options.dueAt ?? null, options.timeLimitMinutes ?? null,
      paper.questions.length, options.difficulty, options.grade, options.knowledgePoints.length ? JSON.stringify(options.knowledgePoints) : null,
      JSON.stringify(options.selectedCategories), JSON.stringify(paper.questionCategories));
  const id = Number(result.lastInsertRowid);
  for (const classId of options.classIds) db.prepare('INSERT INTO assignment_classes(assignment_id,class_id) VALUES(?,?)').run(id, classId);
  return id;
}
export function questionCategoriesFor(row, questions = JSON.parse(row.questions)) {
  return row.question_categories ? JSON.parse(row.question_categories) : questions.map(q => row.category === 'composite' ? inferCategory([q]) : row.category ?? inferCategory(questions));
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

function upgradeCorrectionAttempts(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(correction_attempts)').all().map(row => row.name));
  if (columns.has('request_id')) {
    db.exec(`ALTER TABLE correction_attempts RENAME COLUMN request_id TO request_key;
      ALTER TABLE correction_attempts RENAME COLUMN submitted_at TO created_at;`);
  }
  if (!columns.has('attempt_number')) {
    db.exec(`ALTER TABLE correction_attempts ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number >= 1);
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY student_id, assignment_id, question_number ORDER BY id) AS n
        FROM correction_attempts
      )
      UPDATE correction_attempts SET attempt_number = numbered.n FROM numbered WHERE correction_attempts.id = numbered.id;
      CREATE UNIQUE INDEX correction_attempts_by_question ON correction_attempts(student_id, assignment_id, question_number, attempt_number);`);
  }
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
  if (!db.prepare("SELECT 1 FROM pragma_table_info('submissions') WHERE name='draft_revision'").get()) {
    db.exec('ALTER TABLE submissions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='category'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN category TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='due_at'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN due_at TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='time_limit_minutes'").get()) {
    db.exec('ALTER TABLE assignments ADD COLUMN time_limit_minutes INTEGER');
  }
  for (const [name, type] of [['question_count', 'INTEGER'], ['difficulty', 'TEXT'], ['mixed_grade', 'INTEGER'], ['knowledge_points', 'TEXT'], ['selected_categories', 'TEXT'], ['question_categories', 'TEXT']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name=?").get(name)) db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_starts (
    assignment_id INTEGER NOT NULL REFERENCES assignments(id), student_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL, PRIMARY KEY(assignment_id,student_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS correction_attempts (
    id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), assignment_id INTEGER NOT NULL REFERENCES assignments(id),
    question_number INTEGER NOT NULL CHECK(question_number>=1), attempt_number INTEGER NOT NULL CHECK(attempt_number>=1),
    request_key TEXT NOT NULL, answer INTEGER NOT NULL CHECK(answer>=0), correct INTEGER NOT NULL CHECK(correct IN (0,1)), created_at TEXT NOT NULL,
    UNIQUE(student_id,assignment_id,question_number,attempt_number), UNIQUE(student_id,request_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS mistake_practice (
    id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL,
    question_number INTEGER NOT NULL, request_key TEXT NOT NULL, question TEXT NOT NULL,
    answer INTEGER CHECK(answer BETWEEN 0 AND 20), UNIQUE(student_id, request_key),
    FOREIGN KEY(assignment_id,student_id) REFERENCES submissions(assignment_id,student_id)
  );
  CREATE INDEX IF NOT EXISTS mistake_practice_source ON mistake_practice(student_id,assignment_id,question_number,id)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    upgradeCorrectionAttempts(db);
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
  initializePreviews(db);
  if (!db.prepare("SELECT id FROM users WHERE role='teacher'").get()) {
    db.prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
      .run('teacher', '数学老师', await hashPassword(teacherPassword), 'teacher');
  }
  return db;
}
