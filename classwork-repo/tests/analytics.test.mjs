import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { publishAssignment, solution } from '../backend/store.mjs';
import { seedAnalytics } from './analytics-fixture.mjs';
import { createHistoryClass, teacherPassword, snapshot } from './history-fixture.mjs';

async function withAnalytics(run, legacy=false) {
  const dir = await mkdtemp(join(tmpdir(),'classwork-analytics-')), dbPath = join(dir,'test.sqlite');
  if (legacy) await createHistoryClass(dbPath);
  const app = await createApp({dbPath,clock:()=>Date.parse('2026-11-23T16:05:00Z')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const request = async (path, cookie, data) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`,{method:data?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const login = async (username='teacher',password=legacy?teacherPassword:'Teacher123!') => {
    const r = await request('/login',null,{username,password}); assert.equal(r.status,200); return r.cookie;
  };
  try {await run({...app,request,login});}
  finally {app.server.closeAllConnections(); await new Promise(resolve=>app.server.close(resolve));app.db.close();await rm(dir,{recursive:true,force:true});}
}
const range = '/analytics?classId=1&from=2026-11-17&to=2026-11-19';

test('班级学情按原分数逐份加权，逐题区分答错、漏答、未交和数字零；订正不改变首次统计', async()=> {
  await withAnalytics(async({db,request,login})=>{
    const {ids,a,b} = seedAnalytics(db), teacher = await login(), student = await login('lin');
    const before = snapshot(db);
    const r = await request(range,teacher); assert.equal(r.status,200);
    assert.deepEqual(r.body.summary,{assignmentCount:2,total:8,submitted:3,pending:5,average:80});
    assert.equal(r.body.timeZone,'Asia/Shanghai'); assert.equal(r.body.questions.length,20);
    assert.deepEqual(r.body.assignments.map(a=>a.average),[60,90]);
    const first = r.body.questions.find(q=>q.assignmentId===a&&q.questionNumber===1);
    assert.deepEqual([first.correctCount,first.wrongCount,first.missingCount,first.unsubmittedCount],[1,1,0,2]);
    const second = r.body.questions.find(q=>q.assignmentId===a&&q.questionNumber===2);
    assert.deepEqual([second.correctCount,second.wrongCount,second.missingCount,second.unsubmittedCount],[1,0,1,2]);
    assert.ok(r.body.questions.every(q=>q.correctCount+q.wrongCount+q.missingCount+q.unsubmittedCount===q.total));
    assert.ok(r.body.questions.every(q=>q.students===undefined&&q.correctAnswer===undefined));
    for(let i=1;i<r.body.questions.length;i++) assert.ok(r.body.questions[i-1].errorCount>=r.body.questions[i].errorCount);
    const detail = (await request(`${range}&assignmentId=${a}&questionNumber=1`,teacher)).body.selectedQuestion;
    assert.equal(detail.correctAnswer,0); assert.deepEqual(detail.students.map(s=>s.id),[ids.lin,ids.nan,ids.draft,ids.blank]);
    assert.deepEqual(detail.students.map(s=>[s.status,s.answer]),[['wrong',1],['correct',0],['unsubmitted',0],['unsubmitted',null]]);
    const other = (await request(`/analytics?classId=2&from=&to=&assignmentId=${a}&questionNumber=1`,teacher)).body;
    assert.deepEqual(other.summary,{assignmentCount:1,total:1,submitted:1,pending:0,average:40});
    assert.deepEqual(other.selectedQuestion.students.map(s=>s.id),[ids.zhou]);
    assert.deepEqual(snapshot(db),before);
    for(const answer of [2,0]) assert.equal((await request(`/mistakes/${a}/1/attempts`,student,{answer,requestId:`analytics-attempt-${answer}`})).status,201);
    assert.deepEqual((await request(range,teacher)).body,r.body);
    assert.deepEqual(snapshot(db),before);
    for(const suffix of [`&assignmentId=${b}&questionNumber=11`,'&assignmentId=999&questionNumber=1']) assert.equal((await request(range+suffix,teacher)).status,404);
    assert.equal((await request(`/analytics?classId=2&from=&to=&assignmentId=${b}&questionNumber=1`,teacher)).status,404);
    assert.equal((await request(`${range}&assignmentId=${a}&questionNumber=1`,student)).status,403);
    assert.equal((await request(range)).status,401);
  });
});

test('学情按北京时间发布日期包含起止日，默认最近七日；空均分和零分不同，筛选严格校验',async()=>{
  await withAnalytics(async({db,request,login})=>{
    const {a,b,ids}=seedAnalytics(db), teacher=await login();
    for(const [stamp,title] of [['2026-11-16T15:59:59.999Z','范围前'],['2026-11-19T16:00:00Z','范围后']]){
      const id=publishAssignment(db,title,{classIds:[1]});db.prepare('UPDATE assignments SET created_at=?,due_at=? WHERE id=?').run(stamp,'2026-11-18T12:00:00Z',id);
    }
    const results=(await request(range,teacher)).body; assert.deepEqual(results.assignments.map(a=>a.assignmentId),[b,a]);
    const defaults=(await request('/analytics?classId=1',teacher)).body;assert.deepEqual(defaults.filters,{from:'2026-11-18',to:'2026-11-24'});
    const empty=(await request('/analytics?classId=1&from=2026-12-01&to=2026-12-01',teacher)).body;
    assert.deepEqual(empty.summary,{assignmentCount:0,total:0,submitted:0,pending:0,average:null});assert.deepEqual(empty.questions,[]);
    const pending=publishAssignment(db,'无人提交',{classIds:[1]}); db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run('2026-12-01T00:00:00Z',pending);
    assert.equal((await request('/analytics?classId=1&from=2026-12-01',teacher)).body.summary.average,null);
    db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?)').run(pending,ids.lin,JSON.stringify(Array(10).fill(0)),'2026-12-02T00:00:00Z','2026-12-02T00:00:00Z',0);
    assert.equal((await request('/analytics?classId=1&from=2026-12-01',teacher)).body.summary.average,0);
    assert.equal((await request('/analytics?classId=1&from=&to=',teacher)).body.summary.assignmentCount,5);
    for(const query of ['classId=999','classId=','from=2026-02-30','from=0000-01-01','to=bad','from=2026-11-20&to=2026-11-19','assignmentId=1','questionNumber=1','assignmentId=1&questionNumber=0','assignmentId=1&questionNumber=9007199254740992']){
      assert.equal((await request('/analytics?'+(query.startsWith('classId=')?'':'classId=1&')+query,teacher)).status,400,query);
    }
    assert.equal((await request('/analytics',teacher)).status,400);
    assert.equal((await request(`/analytics?classId=1&from=2026-12-01&assignmentId=${a}&questionNumber=1`,teacher)).status,404);
  });
});

test('20题综合卷与50题括号卷按实际题量统计，第50题订正不影响首次答案',async()=>{
  await withAnalytics(async({db,request,login})=>{
    seedAnalytics(db);const teacher=await login(), pupil=await login('lin'), papers=[];
    for(const options of [{category:'composite',selectedCategories:['add-sub-20','mul-div-20','mixed-100'],questionCount:20},{category:'mixed-100',questionCount:50,grade:3,knowledgePoints:['parentheses'],difficulty:'advanced'}]){
      const id=publishAssignment(db,`${options.questionCount}题卷`,{...options,classIds:[1]});
      db.prepare('UPDATE assignments SET created_at=? WHERE id=?').run('2026-12-03T00:00:00Z',id);
      const questions=JSON.parse(db.prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions),answers=questions.map(solution);
      answers[answers.length-1]=answers.at(-1)===0?1:0;
      const submission=await request(`/assignments/${id}/submit`,pupil,{answers});assert.equal(submission.status,200);assert.equal(submission.body.score,options.questionCount===20?95:98);
      papers.push({id,questions,answers});
    }
    const query='/analytics?classId=1&from=2026-12-03&to=2026-12-03', original=(await request(query,teacher)).body;
    assert.equal(original.questions.length,70);assert.equal(original.summary.average,96.5);
    const {id,questions}=papers[1], detail=(await request(`${query}&assignmentId=${id}&questionNumber=50`,teacher)).body.selectedQuestion;
    assert.deepEqual([detail.correctCount,detail.wrongCount,detail.missingCount,detail.unsubmittedCount],[0,1,0,3]);assert.equal(detail.correctAnswer,solution(questions[49]));
    assert.equal((await request(`/mistakes/${id}/50/attempts`,pupil,{answer:detail.correctAnswer,requestId:'analytics-question-50'})).status,201);
    assert.deepEqual((await request(query,teacher)).body,original);
  });
});

test('迁入旧班的难度、题量、草稿、原成绩保持不变，转班后历史名单与旧报告一致',async()=>{
  await withAnalytics(async({db,request,login})=>{
    db.prepare("INSERT INTO classes(name) VALUES('二班')").run();db.prepare('UPDATE users SET class_id=2 WHERE id=2').run();
    db.prepare('UPDATE assignments SET question_count=50 WHERE id=33').run();
    const teacher=await login(), before=snapshot(db), analytics=(await request('/analytics?classId=1&from=&to=',teacher)).body;
    assert.equal(analytics.summary.assignmentCount,3);assert.equal(analytics.questions.length,30);
    for(const a of analytics.assignments){
      const report=(await request(`/assignments/${a.assignmentId}?classId=1`,teacher)).body;
      assert.deepEqual([a.total,a.submitted,a.pending,a.average],[report.total,report.submitted,report.pending,report.average]);
    }
    const detail=(await request('/analytics?classId=1&from=&to=&assignmentId=33&questionNumber=2',teacher)).body.selectedQuestion;
    assert.equal(detail.students.find(s=>s.id===4).answer,13);assert.equal(detail.students.find(s=>s.id===4).status,'unsubmitted');
    assert.equal((await request('/analytics?classId=2&from=&to=',teacher)).body.summary.assignmentCount,0);
    assert.deepEqual(snapshot(db),before);
  },true);
});
