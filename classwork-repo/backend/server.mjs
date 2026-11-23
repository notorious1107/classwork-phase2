import { createApp } from './app.mjs';
const { server, db } = await createApp({ dbPath: process.env.DB_PATH || 'data/classwork.sqlite', teacherPassword: process.env.TEACHER_PASSWORD });
const port = Number(process.env.API_PORT || 3001);
server.listen(port, '127.0.0.1', () => console.log(`API: http://127.0.0.1:${port}`));
server.on('error', e => { console.error(e.message); db.close(); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
