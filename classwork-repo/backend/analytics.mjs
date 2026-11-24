import { solution } from './store.mjs';
import { dateRangeFilters } from './records.mjs';
import { beijingDateKey } from './calendar.mjs';

export function analyticsFilters(url, now) {
  if (url.searchParams.has('from') || url.searchParams.has('to')) return dateRangeFilters(url);
  return { from: beijingDateKey(new Date(now - 6 * 86400_000).toISOString()), to: beijingDateKey(new Date(now).toISOString()) };
}
export function analyticsSelection(url) {
  const keys = ['assignmentId', 'questionNumber'];
  if (!keys.some(k => url.searchParams.has(k))) return null;
  if (!keys.every(k => /^[1-9]\d*$/.test(url.searchParams.get(k) ?? '') && Number.isSafeInteger(Number(url.searchParams.get(k))))) {
    throw Object.assign(new Error('请选择有效的作业和题号'), { status: 400 });
  }
  return Object.fromEntries(keys.map(k => [k, Number(url.searchParams.get(k))]));
}
const mean = students => students.length ? Math.round(students.reduce((sum, s) => sum + s.score, 0) / students.length * 10) / 10 : null;
const answerStatus = (student, index, correctAnswer) => !student.submittedAt ? 'unsubmitted' : student.answers[index] == null || student.answers[index] === '' ? 'missing' : student.answers[index] === correctAnswer ? 'correct' : 'wrong';

export function aggregatePractice(papers, selection) {
  const assignments = [], questions = [], allSubmitted = [];
  let total = 0, selectedQuestion = null;
  for (const { assignment: a, students } of papers) {
    const submitted = students.filter(s => s.submittedAt);
    total += students.length; allSubmitted.push(...submitted);
    assignments.push({ assignmentId: a.id, title: a.title, createdAt: a.createdAt, questionCount: a.questionCount,
      total: students.length, submitted: submitted.length, pending: students.length - submitted.length, average: mean(submitted) });
    a.questions.forEach((q, index) => {
      const correctAnswer = solution(q), counts = { correct: 0, wrong: 0, missing: 0, unsubmitted: 0 };
      for (const student of students) counts[answerStatus(student, index, correctAnswer)]++;
      const errorCount = counts.wrong + counts.missing;
      const stats = { assignmentId: a.id, title: a.title, createdAt: a.createdAt, questionNumber: index + 1,
        expression: a.expressions[index], correctCount: counts.correct, wrongCount: counts.wrong,
        missingCount: counts.missing, unsubmittedCount: counts.unsubmitted, total: students.length,
        submittedCount: submitted.length, errorCount, errorRate: submitted.length ? Math.round(errorCount / submitted.length * 1000) / 10 : null };
      questions.push(stats);
      if (selection?.assignmentId === a.id && selection.questionNumber === index + 1) selectedQuestion = {
        ...stats, correctAnswer, students: students.map(s => ({ id: s.id, username: s.username, name: s.name,
          status: answerStatus(s, index, correctAnswer), answer: s.answers[index] ?? null, submittedAt: s.submittedAt, savedAt: s.savedAt }))
      };
    });
  }
  if (selection && !selectedQuestion) throw Object.assign(new Error('当前班级和日期范围内没有这道题'), { status: 404 });
  questions.sort((a, b) => b.errorCount - a.errorCount || (b.errorRate ?? 0) - (a.errorRate ?? 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.assignmentId - a.assignmentId || a.questionNumber - b.questionNumber);
  return { summary: { assignmentCount: assignments.length, total, submitted: allSubmitted.length, pending: total - allSubmitted.length, average: mean(allSubmitted) }, assignments, questions, selectedQuestion };
}
