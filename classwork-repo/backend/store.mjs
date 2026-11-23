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
export function generateQuestions() {
  const questions = [];
  const used = new Set();
  while (questions.length < 10) {
    const op = questions.length % 2 === 0 ? '+' : '-';
    const a = randomInt(0, 21);
    const b = randomInt(0, op === '+' ? 21 - a : a + 1);
    const key = `${a}${op}${b}`;
    if (used.has(key)) continue;
    used.add(key);
    questions.push({ a, b, op });
  }
  return questions;
}
export const solution = q => q.op === '+' ? q.a + q.b : q.a - q.b;

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
  if (!db.prepare("SELECT id FROM users WHERE role='teacher'").get()) {
    db.prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
      .run('teacher', '数学老师', await hashPassword(teacherPassword), 'teacher');
  }
  return db;
}
