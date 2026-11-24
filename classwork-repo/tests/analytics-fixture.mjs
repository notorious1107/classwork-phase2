import { publishAssignment } from '../backend/store.mjs';

export function seedAnalytics(db) {
  db.prepare("UPDATE classes SET name='一班' WHERE id=1").run();
  db.prepare("INSERT INTO classes(name) VALUES('二班')").run();
  const ids = {};
  for (const [username, name, classId] of [['lin','小林',1],['nan','张宁',1],['draft','张宁',1],['blank','小周',1],['zhou','小周',2]]) {
    ids[username] = Number(db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) SELECT ?,?,password_hash,'student',? FROM users WHERE role='teacher'").run(username, name, classId).lastInsertRowid);
  }
  const questions = [{a:8,op:'-',b:8}, ...Array.from({length:9}, (_,i) => ({a:i+1,op:'+',b:2}))], key = [0,3,4,5,6,7,8,9,10,11];
  const a = publishAssignment(db, '周二练习 <A>', {classIds:[1,2]});
  const b = publishAssignment(db, '周四练习 B', {classIds:[1]});
  for (const [id, stamp] of [[a,'2026-11-16T16:00:00Z'],[b,'2026-11-19T15:59:59.999Z']]) db.prepare('UPDATE assignments SET questions=?,created_at=?,due_at=? WHERE id=?').run(JSON.stringify(questions),stamp,'2026-11-24T12:00:00Z',id);
  const save = (id, student, answers, score, submitted=true) => db.prepare('INSERT INTO submissions(assignment_id,student_id,answers,saved_at,submitted_at,score) VALUES(?,?,?,?,?,?)').run(id,ids[student],JSON.stringify(answers),'2026-11-23T08:00:00Z',submitted?'2026-11-23T08:00:00Z':null,score);
  save(a,'lin',[1,null,...key.slice(2)],80); save(a,'nan',key,100);
  save(a,'draft',[0,...Array(9).fill(null)],null,false);
  save(a,'zhou',key.map((n,i)=>i<6?n+1:n),40);
  save(b,'lin',key.map((n,i)=>i<4?n+1:n),60);
  save(b,'draft',[9,...Array(9).fill(null)],null,false);
  return {ids,a,b,key};
}
