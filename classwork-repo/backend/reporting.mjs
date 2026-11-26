// All teacher reports use the same per-paper roster, independent of subsequent transfers.
export function assignmentStudents(db, assignment, classId = null, includeAnswers = false) {
  if (classId !== null && !assignment.classIds.includes(classId)) throw Object.assign(new Error('这份作业未发布给该班级'), { status: 404 });
  return db.prepare(`SELECT u.id,u.username,u.name,s.submitted_at,s.saved_at,s.score,s.answers,t.started_at
    FROM assignment_roster r JOIN users u ON u.id=r.student_id
    LEFT JOIN submissions s USING(assignment_id,student_id)
    LEFT JOIN assignment_starts t USING(assignment_id,student_id)
    WHERE r.assignment_id=? AND (? IS NULL OR r.class_id=?) ORDER BY u.id`)
    .all(assignment.id, classId, classId).map(s => ({
      id: s.id, username: s.username, name: s.name, startedAt: s.started_at,
      submittedAt: s.submitted_at ?? null, savedAt: s.saved_at ?? null, score: s.score ?? null,
      ...(includeAnswers ? { answers: s.answers ? JSON.parse(s.answers) : [] } : {})
    }));
}
