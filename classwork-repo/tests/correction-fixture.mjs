import { publishAssignment } from '../backend/store.mjs';

const q = (a, op, b) => ({ a, op, b });
export const correctionQuestions = [q(q(q(36, '-', 12), '/', 4), '+', 7), q(24, '/', q(12, '/', 3)), q(q(3, '+', 5), '+', q(2, '*', 6)),
  q(8, '-', 8), q(2, '*', 3), q(19, '-', 4), q(10, '+', 5), q(12, '/', 3), q(9, '+', 7), q(14, '-', 8)];
export const correctionKeys = [13, 6, 20, 0, 6, 15, 15, 4, 16, 6];
export function seedCorrections(db) {
  db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
  const students = {};
  for (const [username, name] of [['learner', '小林'], ['other', '小周'], ['draft', '草稿同学'], ['perfect', '全对同学']]) {
    students[username] = Number(db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',1 FROM users WHERE role='teacher'").run(username, name).lastInsertRowid);
  }
  const make = (title, questions, stamp) => {
    const id = publishAssignment(db, title, { category: 'mixed-100', questionCount: questions.length, knowledgePoints: ['parentheses', 'precedence'], difficulty: 'advanced', dueAt: '2026-11-19T12:00:00Z' });
    db.prepare('UPDATE assignments SET questions=?,created_at=? WHERE id=?').run(JSON.stringify(questions), stamp, id); return id;
  };
  const shared = make('括号与运算顺序 <b>', correctionQuestions, '2026-11-17T01:00:00Z');
  const second = make('另一份同题练习', correctionQuestions, '2026-11-23T16:00:00Z');
  const fifty = make('五十题练习', Array.from({ length: 50 }, (_, i) => correctionQuestions[i % 10]), '2026-11-16T01:00:00Z');
  const insert = db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?)');
  const firstAnswers = correctionKeys.map((v, i) => [0, 1, 2, 4].includes(i) ? v - 1 : v);
  insert.run(shared, students.learner, JSON.stringify(firstAnswers), '2026-11-18T04:00:00Z', '2026-11-18T04:00:00Z', 60);
  insert.run(shared, students.other, JSON.stringify(correctionKeys.map((v, i) => i === 1 ? 5 : v)), '2026-11-18T05:00:00Z', '2026-11-18T05:00:00Z', 90);
  insert.run(shared, students.draft, JSON.stringify(Array(10).fill(0)), '2026-11-18T06:00:00Z', null, null);
  insert.run(shared, students.perfect, JSON.stringify(correctionKeys), '2026-11-18T07:00:00Z', '2026-11-18T07:00:00Z', 100);
  insert.run(second, students.learner, JSON.stringify(correctionKeys.map((v, i) => i === 0 ? 0 : v)), '2026-11-24T04:00:00Z', '2026-11-24T04:00:00Z', 90);
  insert.run(fifty, students.learner, JSON.stringify(Array.from({ length: 50 }, (_, i) => i === 49 ? 0 : correctionKeys[i % 10])), '2026-11-17T04:00:00Z', '2026-11-17T04:00:00Z', 98);
  return { shared, second, fifty, students, firstAnswers };
}
