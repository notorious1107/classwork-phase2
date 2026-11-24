const ident = value => `"${value.replaceAll('"', '""')}"`;
const info = db => db.prepare('PRAGMA table_info(assignment_previews)').all();
function columns(db) {
  const fields = info(db), names = new Set(fields.map(f => f.name));
  const pick = candidates => candidates.find(c => names.has(c));
  return { fields, teacher: pick(['teacher_id', 'user_id']), id: pick(['preview_id', 'preview_token', 'token', 'preview_key']) ?? fields.find(f => f.name === 'id' && !/INT/i.test(f.type))?.name,
    config: pick(['config', 'settings', 'payload', 'settings_json', 'config_json']), questions: pick(['questions', 'questions_json']),
    created: pick(['created_at', 'generated_at']), published: pick(['published_assignment_id', 'assignment_id', 'last_published_assignment_id']) };
}
export function initializePreviews(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_previews (
    teacher_id INTEGER PRIMARY KEY REFERENCES users(id), preview_id TEXT NOT NULL UNIQUE, config TEXT NOT NULL,
    questions TEXT NOT NULL, created_at TEXT NOT NULL, published_assignment_id INTEGER REFERENCES assignments(id)
  )`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const c = columns(db);
    for (const [key, name, type] of [['id', 'preview_id', 'TEXT'], ['config', 'config', 'TEXT'], ['created', 'created_at', 'TEXT'], ['published', 'published_assignment_id', 'INTEGER']]) {
      if (!c[key]) db.exec(`ALTER TABLE assignment_previews ADD COLUMN ${name} ${type}`);
    }
    if (!c.teacher || !c.questions) throw new Error('旧预览表缺少教师或题目字段');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function storedPreview(db, teacherId) {
  const c = columns(db), row = db.prepare(`SELECT * FROM assignment_previews WHERE ${ident(c.teacher)}=?`).get(teacherId);
  return row ? { row, previewId: String(row[c.id] ?? row.id ?? `legacy-${teacherId}`), config: row[c.config], questions: row[c.questions],
    createdAt: row[c.created] ?? null, publishedAssignmentId: row[c.published] ?? null } : null;
}
export function writePreview(db, teacherId, previewId, settings, paper, createdAt) {
  const c = columns(db), names = new Set(c.fields.map(f => f.name));
  const config = JSON.stringify({ ...settings, questionCategories: paper.questionCategories, generationVersion: 1 });
  const values = { [c.teacher]: teacherId, [c.id]: previewId, [c.config]: config, [c.questions]: JSON.stringify(paper.questions), [c.created]: createdAt, [c.published]: null };
  const compatible = { title: settings.title, category: settings.category, difficulty: settings.difficulty, question_count: settings.questionCount,
    mixed_grade: settings.grade, knowledge_points: settings.knowledgePoints.length ? JSON.stringify(settings.knowledgePoints) : null,
    class_ids: JSON.stringify(settings.classIds), selected_categories: JSON.stringify(settings.selectedCategories), question_categories: JSON.stringify(paper.questionCategories),
    due_at: settings.dueAt, time_limit_minutes: settings.timeLimitMinutes, updated_at: createdAt };
  for (const [key, value] of Object.entries(compatible)) if (names.has(key)) values[key] = value;
  // Some old schemas have a text primary key as well as a separate preview token.
  if (names.has('id') && !/INT/i.test(c.fields.find(f => f.name === 'id').type)) values.id = previewId;
  const keys = Object.keys(values);
  if (storedPreview(db, teacherId)) {
    const updated = keys.filter(k => k !== c.teacher);
    db.prepare(`UPDATE assignment_previews SET ${updated.map(k => `${ident(k)}=?`).join(',')} WHERE ${ident(c.teacher)}=?`).run(...updated.map(k => values[k]), teacherId);
  } else db.prepare(`INSERT INTO assignment_previews(${keys.map(ident).join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(k => values[k]));
}
export function markPreviewPublished(db, teacherId, assignmentId) {
  const c = columns(db);
  db.prepare(`UPDATE assignment_previews SET ${ident(c.published)}=? WHERE ${ident(c.teacher)}=?`).run(assignmentId, teacherId);
}
