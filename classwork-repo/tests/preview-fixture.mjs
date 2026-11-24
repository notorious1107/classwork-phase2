import { DatabaseSync } from 'node:sqlite';
import { createHistoryClass, historyAssignments } from './history-fixture.mjs';

export const legacyPreviewSchemas = [
  "teacher_id INTEGER PRIMARY KEY, preview_id TEXT NOT NULL, questions TEXT NOT NULL, published_assignment_id INTEGER",
  "id TEXT PRIMARY KEY, teacher_id INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, questions TEXT NOT NULL, created_at TEXT NOT NULL, published_assignment_id INTEGER",
  "id INTEGER PRIMARY KEY, teacher_id INTEGER NOT NULL UNIQUE, preview_token TEXT NOT NULL, settings_json TEXT NOT NULL, questions_json TEXT NOT NULL, generated_at TEXT NOT NULL, assignment_id INTEGER"
];
export async function legacyPreviewClass(path, schema) {
  await createHistoryClass(path); const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE assignment_previews(${schema})`);
    db.prepare("INSERT INTO users(id,username,name,password_hash,role) SELECT 9,'teacher2','第二位老师',password_hash,'teacher' FROM users WHERE username='teacher'").run();
    const settings = JSON.stringify({ title: '旧预览', category: 'mixed-100', difficulty: 'advanced', grade: 3, knowledgePoints: ['parentheses'], questionCount: 10, classIds: [1] });
    const values = teacherId => { const id = `legacy-preview-${teacherId}`, questions = JSON.stringify(historyAssignments[2].questions), stamp = '2026-10-01T04:00:00Z', published = teacherId === 9 ? 22 : null; return schema === legacyPreviewSchemas[0] ? [teacherId, id, questions, published] : schema === legacyPreviewSchemas[1] ? [id, teacherId, settings, questions, stamp, published] : [teacherId, teacherId, id, settings, questions, stamp, published]; };
    const insert = db.prepare(`INSERT INTO assignment_previews VALUES(${values(1).map(() => '?').join(',')})`); insert.run(...values(1)); insert.run(...values(9));
  } finally { db.close(); }
}
