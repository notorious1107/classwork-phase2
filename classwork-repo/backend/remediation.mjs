import { randomUUID } from 'node:crypto';
import { binaryVariants } from './papers.mjs';
import { mixedVariants } from './questions.mjs';
import { formatExpression, insertAssignment, solution } from './store.mjs';
import { assignmentStudents } from './reporting.mjs';
import { questionResponses } from './analytics.mjs';

const count = 5;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function checkRecipients(db, assignment, classId, questionNumber, studentIds) {
  if (!positiveId(classId) || !positiveId(questionNumber) || questionNumber > assignment.questionCount)
    fail(400, '请选择有效的来源班级和题号');
  if (!Array.isArray(studentIds) || !studentIds.length || !studentIds.every(positiveId) || new Set(studentIds).size !== studentIds.length)
    fail(400, '请选择接收补练的学生，每人只能选一次');
  const index = questionNumber - 1, students = assignmentStudents(db, assignment, classId, true);
  const eligible = new Set(questionResponses(students, index, solution(assignment.questions[index]))
    .filter(s => s.status === 'wrong' || s.status === 'missing').map(s => s.id));
  if (studentIds.some(id => !eligible.has(id))) fail(400, '名单中有学生不属于本班这道题的已交错漏名单，请重新选择');
}

function previewView(row) {
  return { previewId: row.token, studentIds: JSON.parse(row.student_ids), expressions: JSON.parse(row.questions).map(q => formatExpression(q)) };
}
export function pendingRemedialPreview(db, teacherId, classId, assignmentId, questionNumber) {
  const row = db.prepare(`SELECT * FROM remedial_previews WHERE teacher_id=? AND class_id=? AND source_assignment_id=?
    AND question_number=? AND published_id IS NULL`).get(teacherId, classId, assignmentId, questionNumber);
  return row ? previewView(row) : null;
}
export function createRemedialPreview(db, teacherId, assignment, { classId, questionNumber, studentIds }) {
  checkRecipients(db, assignment, classId, questionNumber, studentIds);
  const index = questionNumber - 1, source = assignment.questions[index], category = assignment.questionCategories[index];
  const questions = category === 'mixed-100' ? mixedVariants(source, count, formatExpression) : binaryVariants(source, assignment.difficulty ?? 'basic', count);
  if (questions.length !== count) fail(422, '这道题暂时无法生成五道不同的同类题');
  const row = db.prepare(`INSERT INTO remedial_previews(token,teacher_id,class_id,source_assignment_id,question_number,student_ids,questions)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(teacher_id,class_id,source_assignment_id,question_number) WHERE published_id IS NULL
    DO UPDATE SET token=excluded.token,student_ids=excluded.student_ids,questions=excluded.questions RETURNING *`)
    .get(randomUUID(), teacherId, classId, assignment.id, questionNumber, JSON.stringify(studentIds), JSON.stringify(questions));
  return previewView(row);
}

function mixedTopic(expression) {
  if (expression.includes('(')) return 'parentheses';
  if (!/[×÷]/.test(expression)) return 'add-sub-chain';
  return /[＋−]/.test(expression) ? 'precedence' : 'mul-div-chain';
}
export function publishRemedialPreview(db, teacherId, token, getAssignment, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM remedial_previews WHERE token=? AND teacher_id=?').get(token, teacherId);
    if (!row) fail(409, '这份补练预览已替换或不存在，请重新生成');
    if (row.published_id !== null) { db.exec('COMMIT'); return { id: row.published_id, created: false }; }
    const source = getAssignment(row.source_assignment_id), index = row.question_number - 1;
    const studentIds = JSON.parse(row.student_ids), questions = JSON.parse(row.questions);
    checkRecipients(db, source, row.class_id, row.question_number, studentIds);
    const category = source.questionCategories[index], mixed = category === 'mixed-100';
    const suffix = ` · 第${row.question_number}题补练`;
    const options = { title: source.title.slice(0, 60 - suffix.length) + suffix, classIds: [row.class_id],
      category, selectedCategories: [category], difficulty: source.difficulty, grade: mixed ? source.grade : null,
      knowledgePoints: mixed ? [mixedTopic(source.expressions[index])] : [] };
    const id = insertAssignment(db, options, { questions, questionCategories: questions.map(() => category) }, new Date(now).toISOString(),
      { assignmentId: source.id, questionNumber: row.question_number, classId: row.class_id, studentIds });
    db.prepare('UPDATE remedial_previews SET published_id=? WHERE token=?').run(id, token);
    db.exec('COMMIT'); return { id, created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
