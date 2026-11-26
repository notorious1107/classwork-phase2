import writeExcelFile from 'write-excel-file/node';

const columns = [['学号', 24], ['姓名', 18], ['班级', 22], ['作业', 40], ['提交状态', 13], ['提交时间（北京时间）', 25], ['成绩（满分100分）', 22]];
const beijingOffset = 8 * 60 * 60 * 1000;

export async function gradeWorkbook(report) {
  const className = report.classes.find(c => c.id === report.reportClassId).name;
  const header = columns.map(([value]) => ({ value, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: '#274B70' }));
  const rows = report.students.map(s => [
    { type: String, value: s.username, format: '@' }, s.name, className, report.title, s.submittedAt ? '已交' : '未交',
    // Excel stores a wall-clock date without a timezone. Use Beijing time regardless of server locale.
    s.submittedAt ? { type: Date, value: new Date(Date.parse(s.submittedAt) + beijingOffset), format: 'yyyy-mm-dd hh:mm:ss' } : null,
    s.submittedAt ? s.score : null
  ]);
  const buffer = await writeExcelFile([header, ...rows], {
    sheet: '作业成绩', stickyRowsCount: 1, columns: columns.map(([, width]) => ({ width }))
  }).toBuffer();
  const filename = `${className}-${report.title}-成绩.xlsx`.toWellFormed().replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return { buffer, disposition: `attachment; filename="grades-${report.id}-${report.reportClassId}.xlsx"; filename*=UTF-8''${encoded}` };
}
