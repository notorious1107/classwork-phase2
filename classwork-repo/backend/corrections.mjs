import { solution, formatExpression, questionCategoriesFor } from './store.mjs';
import { addSubPracticeKind, similarAddSubQuestion } from './papers.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const opInfo = op => {
  if (['+', '＋'].includes(op)) return { precedence: 1, name: '加法' };
  if (['-', '−'].includes(op)) return { precedence: 1, name: '减法' };
  return { precedence: 2, name: ['*', '×'].includes(op) ? '乘法' : '除法' };
};
// Ready operations are ordered by visible parentheses, then precedence, then left to right.
function readyOperations(q, path = [], parentPrecedence = 0, right = false, depth = 0, ready = []) {
  if (typeof q === 'number') return ready;
  const { precedence } = opInfo(q.op);
  const bracketDepth = depth + Number(precedence < parentPrecedence || (right && precedence === parentPrecedence));
  if (typeof q.a === 'number' && typeof q.b === 'number') ready.push({ q, path, depth: bracketDepth, precedence });
  else {
    readyOperations(q.a, [...path, 'a'], precedence, false, bracketDepth, ready);
    readyOperations(q.b, [...path, 'b'], precedence, true, bracketDepth, ready);
  }
  return ready;
}
function replaceAt(q, path, value) {
  if (!path.length) return value;
  const [key, ...rest] = path;
  return { ...q, [key]: replaceAt(q[key], rest, value) };
}
export function explainQuestion(question) {
  let current = question;
  const steps = [];
  while (typeof current !== 'number') {
    const ready = readyOperations(current).sort((a, b) => b.depth - a.depth || b.precedence - a.precedence);
    const next = ready[0], result = solution(next.q), before = formatExpression(current);
    current = replaceAt(current, next.path, result);
    const reason = next.depth ? `先算小括号内的${opInfo(next.q.op).name}。` : typeof current === 'number' ? `算出${opInfo(next.q.op).name}的结果。` : next.precedence === 2 ? '先算乘除；同级运算从左往右算。' : '同级运算从左往右算。';
    steps.push({ before, calculation: `${formatExpression(next.q)} ＝ ${result}`, after: formatExpression(current), reason });
  }
  return { correctAnswer: current, steps };
}

export function mistakeSource(db, studentId, assignmentId, questionNumber) {
  if (!Number.isSafeInteger(assignmentId) || !Number.isSafeInteger(questionNumber)) fail(404, '错题不存在');
  const row = db.prepare(`SELECT a.*,s.answers,s.submitted_at FROM assignments a JOIN submissions s ON s.assignment_id=a.id
    WHERE a.id=? AND s.student_id=? AND s.submitted_at IS NOT NULL`).get(assignmentId, studentId);
  if (!row) fail(404, '错题不存在');
  const questions = JSON.parse(row.questions), answers = JSON.parse(row.answers), index = questionNumber - 1;
  if (!Number.isSafeInteger(questionNumber) || index < 0 || index >= questions.length || answers[index] === solution(questions[index])) fail(404, '错题不存在');
  return { row, question: questions[index], originalAnswer: answers[index], category: questionCategoriesFor(row, questions)[index] };
}
export function correctionHistory(db, studentId, assignmentId, questionNumber) {
  return db.prepare(`SELECT attempt_number,answer,correct,created_at FROM correction_attempts
    WHERE student_id=? AND assignment_id=? AND question_number=? ORDER BY attempt_number`).all(studentId, assignmentId, questionNumber)
    .map(r => ({ attemptNumber: r.attempt_number, answer: r.answer, correct: !!r.correct, submittedAt: r.created_at }));
}
export function correctionQuestion(db, studentId, assignmentId, questionNumber) {
  const source = mistakeSource(db, studentId, assignmentId, questionNumber);
  return { assignmentId, questionNumber, title: source.row.title, expression: formatExpression(source.question),
    answerMax: source.category === 'mixed-100' ? 100 : 20, practiceKind: addSubPracticeKind(source.question),
    attemptCount: correctionHistory(db, studentId, assignmentId, questionNumber).length };
}
export function mistakeBook(db, studentId) {
  const progress = new Map();
  for (const r of db.prepare('SELECT assignment_id,question_number,attempt_number,correct FROM correction_attempts WHERE student_id=? ORDER BY attempt_number').all(studentId)) {
    const key = `${r.assignment_id}:${r.question_number}`, previous = progress.get(key);
    progress.set(key, { attemptCount: r.attempt_number, firstCorrectAttempt: previous?.firstCorrectAttempt ?? (r.correct ? r.attempt_number : null), lastAttemptCorrect: !!r.correct });
  }
  const items = [];
  const rows = db.prepare(`SELECT a.*,s.answers,s.submitted_at FROM assignments a JOIN submissions s ON s.assignment_id=a.id
    WHERE s.student_id=? AND s.submitted_at IS NOT NULL ORDER BY julianday(s.submitted_at) DESC,a.id DESC`).all(studentId);
  for (const row of rows) {
    const questions = JSON.parse(row.questions), answers = JSON.parse(row.answers);
    questions.forEach((q, i) => {
      if (answers[i] === solution(q)) return;
      items.push({ assignmentId: row.id, questionNumber: i + 1, title: row.title, createdAt: row.created_at, submittedAt: row.submitted_at,
        expression: formatExpression(q), practiceKind: addSubPracticeKind(q), originalAnswer: answers[i] ?? null, originalStatus: answers[i] == null || answers[i] === '' ? 'missing' : 'wrong',
        ...(progress.get(`${row.id}:${i + 1}`) ?? { attemptCount: 0, firstCorrectAttempt: null, lastAttemptCorrect: null }) });
    });
  }
  return items;
}
export function submitCorrection(db, studentId, assignmentId, questionNumber, input, now) {
  const source = mistakeSource(db, studentId, assignmentId, questionNumber), max = source.category === 'mixed-100' ? 100 : 20;
  if (!Number.isInteger(input.answer) || input.answer < 0 || input.answer > max) fail(400, `订正答案请填写 0–${max} 的整数`);
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.requestId)) fail(400, '订正请求标识无效，请重新打开订正');
  const explanation = explainQuestion(source.question);
  let created = false, attemptNumber;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM correction_attempts WHERE student_id=? AND request_key=?').get(studentId, input.requestId);
    if (existing) {
      if (existing.assignment_id !== assignmentId || existing.question_number !== questionNumber || existing.answer !== input.answer) fail(409, '这次订正已记录，请开始新一次订正');
      attemptNumber = existing.attempt_number;
    } else {
      attemptNumber = db.prepare('SELECT COUNT(*) AS n FROM correction_attempts WHERE student_id=? AND assignment_id=? AND question_number=?').get(studentId, assignmentId, questionNumber).n + 1;
      db.prepare(`INSERT INTO correction_attempts(student_id,assignment_id,question_number,attempt_number,request_key,answer,correct,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(studentId, assignmentId, questionNumber, attemptNumber, input.requestId, input.answer, Number(input.answer === explanation.correctAnswer), new Date(now).toISOString());
      created = true;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const attempts = correctionHistory(db, studentId, assignmentId, questionNumber);
  return { created, result: { ...correctionQuestion(db, studentId, assignmentId, questionNumber), ...explanation, attempt: attempts.find(a => a.attemptNumber === attemptNumber), attempts } };
}

export function startPractice(db, studentId, assignmentId, questionNumber, requestId) {
  const source = mistakeSource(db, studentId, assignmentId, questionNumber);
  if (!addSubPracticeKind(source.question)) fail(400, '同类再练目前支持 20 以内的一步加减法');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) fail(400, '再练请求标识无效');
  const key = [studentId, assignmentId, questionNumber];
  if (!db.prepare('SELECT 1 FROM correction_attempts WHERE student_id=? AND assignment_id=? AND question_number=? AND correct=1 LIMIT 1').get(...key)) {
    fail(409, '请先把原题订正正确，再练同类题');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT id,assignment_id,question_number FROM mistake_practice WHERE student_id=? AND request_key=?').get(studentId, requestId);
    let id = existing?.id;
    if (existing) {
      if (existing.assignment_id !== assignmentId || existing.question_number !== questionNumber) fail(409, '该请求已用于另一道练习');
    } else {
      const history = db.prepare(`SELECT question FROM mistake_practice WHERE student_id=? AND assignment_id=? AND question_number=?
        GROUP BY question ORDER BY MAX(id) DESC`).all(...key);
      const question = similarAddSubQuestion(source.question, history.map(row => JSON.parse(row.question)));
      id = Number(db.prepare('INSERT INTO mistake_practice(student_id,assignment_id,question_number,request_key,question) VALUES(?,?,?,?,?)')
        .run(...key, requestId, JSON.stringify(question)).lastInsertRowid);
    }
    db.exec('COMMIT');
    return { practiceId: id, created: !existing };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function practiceQuestion(db, studentId, assignmentId, questionNumber, practiceId, input) {
  const row = db.prepare(`SELECT p.question,p.answer,a.title FROM mistake_practice p JOIN assignments a ON a.id=p.assignment_id
    WHERE p.id=? AND p.student_id=? AND p.assignment_id=? AND p.question_number=?`).get(practiceId, studentId, assignmentId, questionNumber);
  if (!row) fail(404, '同类练习不存在');
  const question = JSON.parse(row.question);
  if (input !== undefined) {
    if (!Number.isInteger(input.answer) || input.answer < 0 || input.answer > 20) fail(400, '练习答案请填写 0–20 的整数');
    const written = db.prepare('UPDATE mistake_practice SET answer=? WHERE id=? AND (answer IS NULL OR answer=?)').run(input.answer, practiceId, input.answer);
    if (!written.changes) fail(409, '这道练习已作答，请刷新查看结果');
    row.answer = input.answer;
  }
  const view = { assignmentId, questionNumber, practiceId, title: row.title, practiceKind: addSubPracticeKind(question), expression: formatExpression(question), answerMax: 20 };
  if (row.answer !== null) view.feedback = { attempt: { answer: row.answer, correct: row.answer === solution(question) }, ...explainQuestion(question) };
  return view;
}
