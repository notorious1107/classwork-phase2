// Share the report roster, including retained original-class students on migrated papers.
export function assignmentStudents(db, assignment, classId = null, includeAnswers = false) {
  if (classId !== null && !assignment.classIds.includes(classId)) throw Object.assign(new Error('这份作业未发布给该班级'), { status: 404 });
  const selected = classId === null ? assignment.classIds : [classId];
  return db.prepare(`SELECT u.id,u.username,u.name,s.submitted_at,s.saved_at,s.score,s.answers
    FROM users u LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=?
    WHERE u.role='student' AND (COALESCE(u.class_id,1) IN (${selected.map(() => '?').join(',')}) OR
      (? AND EXISTS(SELECT 1 FROM legacy_assignment_students l WHERE l.assignment_id=? AND l.student_id=u.id))) ORDER BY u.id`)
    .all(assignment.id, ...selected, selected.includes(1) ? 1 : 0, assignment.id).map(s => ({
      id: s.id, username: s.username, name: s.name,
      submittedAt: s.submitted_at ?? null, savedAt: s.saved_at ?? null, score: s.score ?? null,
      ...(includeAnswers ? { answers: s.answers ? JSON.parse(s.answers) : [] } : {})
    }));
}
