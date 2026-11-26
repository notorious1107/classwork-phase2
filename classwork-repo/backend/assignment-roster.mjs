// Called inside the class migration transaction, after legacy rosters have been restored.
export function initializeAssignmentRoster(db) {
  const hasTable = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (hasTable('assignment_roster') && hasTable('remedial_assignments')) return;
  if (!hasTable('assignment_roster')) db.exec(`
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

  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS remedial_assignments(
      assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id),
      source_assignment_id INTEGER NOT NULL REFERENCES assignments(id),
      question_number INTEGER NOT NULL CHECK(question_number>0)
    );
    CREATE TABLE IF NOT EXISTS remedial_previews(
      token TEXT PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES users(id),
      class_id INTEGER NOT NULL REFERENCES classes(id), source_assignment_id INTEGER NOT NULL REFERENCES assignments(id),
      question_number INTEGER NOT NULL, student_ids TEXT NOT NULL, questions TEXT NOT NULL,
      published_id INTEGER REFERENCES assignments(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_remedial_preview
      ON remedial_previews(teacher_id,class_id,source_assignment_id,question_number) WHERE published_id IS NULL;
    DROP TRIGGER IF EXISTS roster_on_publication;
    CREATE TRIGGER roster_on_publication AFTER INSERT ON assignment_classes
    WHEN NOT EXISTS(SELECT 1 FROM remedial_assignments WHERE assignment_id=NEW.assignment_id) BEGIN
      INSERT INTO assignment_roster
        SELECT NEW.assignment_id, id, NEW.class_id FROM users
        WHERE role='student' AND COALESCE(class_id,1)=NEW.class_id;
    END;
  `);
  // Late joiners receive the class's previous assignments. An existing paper keeps its first class.
  for (const [name, event] of [['enrollment', 'INSERT'], ['transfer', 'UPDATE OF class_id']]) {
    db.exec(`DROP TRIGGER IF EXISTS roster_on_${name};
    CREATE TRIGGER roster_on_${name} AFTER ${event} ON users WHEN NEW.role='student' BEGIN
      INSERT INTO assignment_roster
        SELECT assignment_id, NEW.id, class_id FROM assignment_classes WHERE class_id=COALESCE(NEW.class_id,1)
        AND NOT EXISTS(SELECT 1 FROM remedial_assignments ra WHERE ra.assignment_id=assignment_classes.assignment_id)
        ON CONFLICT(assignment_id,student_id) DO NOTHING;
    END;`);
  }
}
