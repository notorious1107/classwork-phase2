import { randomBytes } from 'node:crypto';
import { formatExpression, inferCategory, insertAssignment } from './store.mjs';
import { paperOptions, generatePaper } from './papers.mjs';
import { storedPreview, writePreview, markPreviewPublished } from './preview-store.mjs';

const parse = value => value ? JSON.parse(value) : null;
export function readPreview(db, teacherId) {
  const stored = storedPreview(db, teacherId);
  if (!stored) return null;
  const row = stored.row, payload = parse(stored.config) ?? {}, raw = payload.settings ?? payload.config ?? payload;
  const questions = parse(stored.questions);
  const settings = { ...paperOptions({ ...raw, category: raw.category ?? row.category ?? inferCategory(questions), questionCount: questions.length,
    selectedCategories: raw.selectedCategories ?? parse(row.selected_categories), difficulty: raw.difficulty ?? row.difficulty ?? 'basic',
    grade: raw.grade ?? row.mixed_grade ?? undefined, knowledgePoints: raw.knowledgePoints ?? parse(row.knowledge_points) ?? undefined }),
    title: raw.title ?? row.title ?? '历史预览练习', classIds: raw.classIds ?? parse(row.class_ids) ?? [1],
    dueAt: raw.dueAt ?? row.due_at ?? null, timeLimitMinutes: raw.timeLimitMinutes ?? row.time_limit_minutes ?? null };
  const questionCategories = raw.questionCategories ?? parse(row.question_categories) ?? questions.map(q => settings.category === 'composite' ? inferCategory([q]) : settings.category);
  const components = settings.selectedCategories.map(category => ({ category, count: questionCategories.filter(c => c === category).length }));
  return { previewId: stored.previewId, createdAt: stored.createdAt, publishedAssignmentId: stored.publishedAssignmentId, usesCurrentRules: raw.generationVersion === 1, settings,
    questions, questionCategories, components, expressions: questions.map(q => formatExpression(q)) };
}
export function createPreview(db, teacherId, settings, now) {
  let paper = generatePaper(settings);
  const previous = storedPreview(db, teacherId), oldQuestions = previous ? JSON.stringify(parse(previous.questions)) : '';
  for (let retry = 0; JSON.stringify(paper.questions) === oldQuestions && retry < 5; retry++) paper = generatePaper(settings);
  if (JSON.stringify(paper.questions) === oldQuestions) throw new Error('暂时无法换出新卷，请重试');
  const previewId = randomBytes(18).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try { writePreview(db, teacherId, previewId, settings, paper, new Date(now).toISOString()); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return readPreview(db, teacherId);
}
export function publishPreview(db, teacherId, previewId, now, validateSettings) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = storedPreview(db, teacherId);
    if (!stored || stored.previewId !== previewId) throw Object.assign(new Error('预览已更新或不存在，请重新预览后发布'), { status: 409 });
    if (stored.publishedAssignmentId !== null) { db.exec('COMMIT'); return { id: stored.publishedAssignmentId, created: false }; }
    const preview = readPreview(db, teacherId), settings = validateSettings(preview.settings);
    const id = insertAssignment(db, settings, preview, new Date(now).toISOString());
    markPreviewPublished(db, teacherId, id); db.exec('COMMIT'); return { id, created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
