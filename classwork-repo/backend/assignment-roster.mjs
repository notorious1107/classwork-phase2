// Called inside the class migration transaction, after legacy rosters have been restored.
export function initializeAssignmentRoster(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignment_roster'").get()) return;
  db.exec(`
    CREATE TABLE assignment_roster(
      assignment_id INTEGER NOT NULL REFERENCES assignments(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      class_id INTEGER,
      PRIMARY KEY(assignment_id, student_id),
      FOREIGN KEY(assignment_id, class_id) REFERENCES assignment_classes(assignment_id, class_id)
    );
    CREATE INDEX roster_by_student ON assignment_roster(student_id, assignment_id);
    CREATE INDEX roster_by_class ON assignment_roster(assignment_id, class_id);

    INSERT INTO assignment_roster SELECT assignment_id, student_id, 1 FROM legacy_assignment_students;
    INSERT OR IGNORE INTO assignment_roster
      SELECT ac.assignment_id, u.id, ac.class_id FROM assignment_classes ac
      JOIN users u ON COALESCE(u.class_id,1)=ac.class_id WHERE u.role='student';

    -- Older multiclass papers have no transfer log. Preserve work even when no single class can be inferred.
    WITH worked AS (
      SELECT assignment_id, student_id FROM submissions UNION SELECT assignment_id, student_id FROM assignment_starts
    ), targets AS (
      SELECT assignment_id, CASE WHEN COUNT(*)=1 THEN MIN(class_id) END AS only_class
      FROM assignment_classes GROUP BY assignment_id
    )
    INSERT OR IGNORE INTO assignment_roster
      SELECT w.assignment_id, w.student_id, t.only_class FROM worked w JOIN targets t USING(assignment_id);

    CREATE TRIGGER roster_on_publication AFTER INSERT ON assignment_classes BEGIN
      INSERT INTO assignment_roster
        SELECT NEW.assignment_id, id, NEW.class_id FROM users
        WHERE role='student' AND COALESCE(class_id,1)=NEW.class_id;
    END;
  `);
  // Late joiners receive the class's previous assignments. An existing paper keeps its first class.
  for (const [name, event] of [['enrollment', 'INSERT'], ['transfer', 'UPDATE OF class_id']]) {
    db.exec(`CREATE TRIGGER roster_on_${name} AFTER ${event} ON users WHEN NEW.role='student' BEGIN
      INSERT INTO assignment_roster
        SELECT assignment_id, NEW.id, class_id FROM assignment_classes WHERE class_id=COALESCE(NEW.class_id,1)
        ON CONFLICT(assignment_id,student_id) DO NOTHING;
    END;`);
  }
}
