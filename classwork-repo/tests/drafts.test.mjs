import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { withLearning, createRevisionClass } from './learning-fixture.mjs';
import { createHistoryClass, historyDraft, studentPassword, teacherPassword, snapshot } from './history-fixture.mjs';
import { publishAssignment, solution } from '../backend/store.mjs';

async function newClass({request,login,db}) {
  const teacher=await login('teacher'); await request('/students',teacher,'POST',{username:'pupil',name:'小林',password:'Student123!'});
  return {teacher,pupil:await login('pupil','Student123!'),id:publishAssignment(db(),'自动存草稿')};
}
test('草稿版本防止旧窗口覆盖，响应丢失可重试，交卷锁定和会话重设后慢请求不再写入',async()=>{
  await withLearning(async ctx=>{
    const {request,db,port}=ctx,{teacher,pupil,id}=await newClass(ctx), path=`/assignments/${id}`, answers=[0,...Array(9).fill(null)];
    const save=(values,revision)=>request(path+'/draft',pupil,'PUT',{answers:values,draftRevision:revision});
    assert.equal((await request(path,pupil)).body.draftRevision,0);
    const first=await save(answers,0);assert.equal(first.status,200);assert.equal(first.body.draftRevision,1);assert.equal(first.body.answers[0],0);
    assert.equal((await save(answers,0)).body.draftRevision,1);
    const other=[0,3,...Array(8).fill(null)];assert.equal((await save(other,1)).body.draftRevision,2);
    const conflict=await save([1,...Array(9).fill(null)],1);assert.equal(conflict.status,409);assert.equal(conflict.body.code,'DRAFT_CONFLICT');assert.equal(conflict.body.draftRevision,2);
    assert.deepEqual((await request(path,pupil)).body.answers,other);
    for(const revision of [-1,1.5,'2',null])assert.equal((await save(other,revision)).status,400);
    const staleSubmit=await request(path+'/submit',pupil,'POST',{answers,draftRevision:1,allowIncomplete:true});assert.equal(staleSubmit.body.code,'DRAFT_CONFLICT');
    const complete=JSON.parse(db().prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions).map(solution);
    const submitted=await request(path+'/submit',pupil,'POST',{answers:complete,draftRevision:2});assert.equal(submitted.status,200);assert.equal(submitted.body.score,100);
    assert.equal((await save(other,2)).status,409);assert.deepEqual((await request(path,pupil)).body.answers,complete);
    const fresh=publishAssignment(db(),'慢草稿'), input=JSON.stringify({answers,draftRevision:0});
    let finish; const slow=new Promise((resolve,reject)=>{
      const req=httpRequest({host:'127.0.0.1',port:port(),path:`/api/assignments/${fresh}/draft`,method:'PUT',headers:{Cookie:pupil,'Content-Type':'application/json','Content-Length':Buffer.byteLength(input)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.write(input.slice(0,-1));finish=()=>req.end(input.slice(-1));
    });
    await new Promise(r=>setTimeout(r,30));assert.equal((await request('/students/2/password',teacher,'PUT',{classId:1,newPassword:'ResetStudent123!'})).status,200);finish();
    assert.equal((await slow).status,401);assert.equal(db().prepare('SELECT 1 FROM submissions WHERE assignment_id=?').get(fresh),undefined);
  });
});

test('旧库已有draft_revision保留版本和原草稿，可继续保存并重启；无版本旧草稿默认从零接续',async()=>{
  for(const seed of [createRevisionClass,createHistoryClass])await withLearning(async({request,login,db,restart})=>{
    const teacher=await login('teacher',teacherPassword), pupil=await login('pupil4',studentPassword),before=snapshot(db());
    const original=(await request('/assignments/33',pupil)).body,revision=seed===createRevisionClass?17:0;
    assert.deepEqual(original.answers,historyDraft);assert.equal(original.draftRevision,revision);assert.deepEqual(snapshot(db()),before);
    const updated=[0,13,...Array(8).fill(null)];const save=await request('/assignments/33/draft',pupil,'PUT',{answers:updated,draftRevision:revision});assert.equal(save.status,200);assert.equal(save.body.draftRevision,revision+1);
    await restart();const restored=(await request('/assignments/33',pupil)).body;assert.deepEqual(restored.answers,updated);assert.equal(restored.draftRevision,revision+1);
    const after=snapshot(db());assert.deepEqual(after.assignments,before.assignments);assert.deepEqual(after.users,before.users);assert.deepEqual(after.submissions.filter(s=>s.assignment_id!==33||s.student_id!==4),before.submissions.filter(s=>s.assignment_id!==33||s.student_id!==4));
    assert.equal((await request('/assignments/33/report?classId=1',teacher)).body.pending,1);
  },seed);
});

test('晚到的旧版本草稿不能覆盖另一窗口刚保存的新答案',async()=>{
  await withLearning(async ctx=>{
    const {request,port}=ctx,{pupil,id}=await newClass(ctx),older=[0,...Array(9).fill(null)],newer=[5,...Array(9).fill(null)],input=JSON.stringify({answers:older,draftRevision:0});
    let finish;const slow=new Promise((resolve,reject)=>{
      const req=httpRequest({host:'127.0.0.1',port:port(),path:`/api/assignments/${id}/draft`,method:'PUT',headers:{Cookie:pupil,'Content-Type':'application/json','Content-Length':Buffer.byteLength(input)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.write(input.slice(0,-1));finish=()=>req.end(input.slice(-1));
    });
    await new Promise(r=>setTimeout(r,30));const saved=await request(`/assignments/${id}/draft`,pupil,'PUT',{answers:newer,draftRevision:0});assert.equal(saved.status,200);finish();
    const rejected=await slow;assert.equal(rejected.status,409);assert.equal(rejected.body.code,'DRAFT_CONFLICT');assert.deepEqual((await request(`/assignments/${id}`,pupil)).body.answers,newer);
  });
});

test('确认漏题交卷按总题数评分，原卷、错题本、班级分析识别漏答，截止后仍可存草稿',async()=>{
  await withLearning(async ctx=>{
    const {request,db,now,restart}=ctx,{teacher,pupil,id}=await newClass(ctx),path=`/assignments/${id}`;
    const key=JSON.parse(db().prepare('SELECT questions FROM assignments WHERE id=?').get(id).questions).map(solution),answers=[...key.slice(0,8),null,null];
    const rejected=await request(path+'/submit',pupil,'POST',{answers});assert.equal(rejected.status,400);assert.match(rejected.body.error,/2 题未作答/);
    for(const allowIncomplete of ['true',1,false])assert.equal((await request(path+'/submit',pupil,'POST',{answers,allowIncomplete})).status,400);
    const marked=await request(path+'/submit',pupil,'POST',{answers,allowIncomplete:true,draftRevision:0});assert.equal(marked.status,200);assert.equal(marked.body.score,80);assert.equal(marked.body.results.filter(r=>r.missing).length,2);
    const review=(await request(`/assignments/${id}/students/2?classId=1`,teacher)).body;assert.equal(review.results[8].missing,true);assert.equal(review.results[8].correct,false);assert.equal(review.answers[8],null);
    const mistakes=(await request('/mistakes',pupil)).body;assert.deepEqual(mistakes.map(m=>[m.questionNumber,m.originalStatus,m.originalAnswer]),[[9,'missing',null],[10,'missing',null]]);
    const summary=(await request(`/analytics?classId=1&from=&to=&assignmentId=${id}&questionNumber=9`,teacher)).body;assert.equal(summary.summary.average,80);assert.equal(summary.selectedQuestion.missingCount,1);assert.equal(summary.selectedQuestion.wrongCount,0);assert.equal(summary.selectedQuestion.students[0].status,'missing');
    await request(`/mistakes/${id}/9/attempts`,pupil,'POST',{answer:key[8],requestId:'missing-question-correction'});assert.deepEqual((await request(path,pupil)).body.answers,answers);assert.equal((await request(path,pupil)).body.score,80);
    await restart();assert.equal((await request(path,pupil)).body.score,80);
    const due=Date.parse('2026-11-24T12:00:00Z'),closed=publishAssignment(db(),'到时漏题',{dueAt:new Date(due).toISOString(),timeLimitMinutes:20}),closedPath=`/assignments/${closed}`;
    now(due-1);await request(closedPath+'/start',pupil,'POST',{});now(due);
    assert.equal((await request(closedPath+'/submit',pupil,'POST',{answers,allowIncomplete:true,draftRevision:0})).status,409);
    const saved=await request(closedPath+'/draft',pupil,'PUT',{answers:[0,...Array(9).fill(null)],draftRevision:0});assert.equal(saved.status,200);assert.equal(saved.body.submittedAt,null);assert.equal(saved.body.score,null);
    assert.equal((await request(closedPath+'/report?classId=1',teacher)).body.pending,1);
    for(const input of [{answers:Array(10).fill(null),allowIncomplete:true},{answers:Array(10).fill(1000),allowIncomplete:true}]){
      const blank=publishAssignment(db(),'空卷');const result=await request(`/assignments/${blank}/submit`,pupil,'POST',input);assert.equal(result.status,input.answers[0]===null?200:400);if(result.status===200)assert.equal(result.body.score,0);
    }
  });
});
