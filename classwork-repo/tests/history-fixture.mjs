import { hashPassword, openStore } from '../backend/store.mjs';

const q = (a, op, b) => ({ a, op, b });
export const historyAssignments = [
  {
    id: 11, category: 'add-sub-20', title: '练习甲',
    questions: [q(2, '+', 3), q(7, '-', 5), q(4, '+', 9), q(8, '-', 8), q(1, '+', 19),
      q(19, '-', 4), q(0, '+', 5), q(10, '-', 3), q(9, '+', 7), q(14, '-', 8)],
    key: [5, 2, 13, 0, 20, 15, 5, 7, 16, 6]
  },
  {
    id: 22, category: 'mul-div-20', title: '练习乙',
    questions: [q(2, '×', 1), q(18, '÷', 3), q(4, '*', 4), q(20, '/', 5), q(0, '×', 8),
      q(12, '÷', 2), q(3, '*', 5), q(9, '/', 9), q(5, '×', 4), q(0, '÷', 6)],
    key: [2, 6, 16, 4, 0, 6, 15, 1, 20, 0]
  },
  {
    id: 33, category: 'mixed-100', title: '练习丙',
    questions: [q(q(3, '*', 8), '+', 3), q(18, '-', q(7, '-', 2)), q(24, '/', q(12, '/', 3)),
      q(q(q(3, '×', 2), '+', 5), '-', 2), q(q(6, '+', 3), '×', 4), q(10, '*', 10),
      q(8, '-', q(5, '+', 3)), q(8, '÷', q(4, '*', 2)), q(60, '/', q(5, '-', 2)), q(2, '+', 2)],
    key: [27, 13, 6, 9, 36, 100, 0, 1, 20, 4]
  }
];
export const historyDraft = [null, 13, ...Array(8).fill(null)];
export const teacherPassword = 'FixtureTeacher42';
export const studentPassword = 'FixtureStudent42';

export function snapshot(db) {
  return {
    users: db.prepare('SELECT * FROM users ORDER BY id').all(),
    assignments: db.prepare('SELECT * FROM assignments ORDER BY id').all(),
    submissions: db.prepare('SELECT * FROM submissions ORDER BY assignment_id, student_id').all()
  };
}

// Build and close a synthetic class before the application opens it.
export async function createHistoryClass(path) {
  const db = await openStore(path, teacherPassword);
  try {
    db.exec(`ALTER TABLE assignments ADD COLUMN category TEXT NOT NULL DEFAULT 'add-sub-20';
      ALTER TABLE assignments ADD COLUMN due_at TEXT;`);
    const insertUser = db.prepare("INSERT INTO users(id, username, name, password_hash, role) VALUES(?,?,?,?, 'student')");
    for (const id of [2, 3, 4]) {
      insertUser.run(id, `pupil${id}`, `同学${id}`, await hashPassword(studentPassword));
    }
    const insertAssignment = db.prepare('INSERT INTO assignments(id,title,questions,created_at,category) VALUES(?,?,?,?,?)');
    const insertAnswers = db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)');
    const stamp = '2026-10-01T04:00:00.000Z';
    for (const [index, a] of historyAssignments.entries()) {
      insertAssignment.run(a.id, a.title, JSON.stringify(a.questions), stamp, a.category);
      for (const id of [2, 3]) {
        const missed = index + id - 2;
        const answers = a.key.map((v, i) => i < missed ? 0 : v);
        insertAnswers.run(a.id, id, JSON.stringify(answers), stamp, stamp, 100 - 10 * missed);
      }
    }
    insertAnswers.run(33, 4, JSON.stringify(historyDraft), stamp, null, null);
    return snapshot(db);
  } finally { db.close(); }
}
