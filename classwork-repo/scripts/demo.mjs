import { openStore, hashPassword, publishAssignment } from '../backend/store.mjs';
const db = await openStore(process.env.DB_PATH || 'data/classwork.sqlite', process.env.TEACHER_PASSWORD);
try {
  for (const [username, name] of [['student01', '小雨'], ['student02', '小明']]) {
    if (!db.prepare('SELECT id FROM users WHERE username=?').get(username)) {
      db.prepare("INSERT INTO users(username,name,password_hash,role,class_id) VALUES(?,?,?,'student',1)")
        .run(username, name, await hashPassword('Student123!'));
      console.log(`已创建 ${name}：${username} / Student123!`);
    } else console.log(`${username} 已存在，保留原数据与密码。`);
  }
  if (!db.prepare('SELECT id FROM assignments LIMIT 1').get()) {
    publishAssignment(db, '第一份练习 · 20 以内加减');
    console.log('已发布第一份十题练习。');
  }
  console.log('演示数据准备完成，不会覆盖已有账号、作业或成绩。');
} finally { db.close(); }
