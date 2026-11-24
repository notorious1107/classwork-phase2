import { categories } from './store.mjs';
import { practiceOptions } from './questions.mjs';

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
function dateFilter(value, label) {
  if (!value) return '';
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000' || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) invalid(`${label}请填写有效日期（YYYY-MM-DD）`);
  return value;
}
export function historyFilters(url) {
  const from = dateFilter(url.searchParams.get('from'), '开始日期');
  const to = dateFilter(url.searchParams.get('to'), '结束日期');
  if (from && to && from > to) invalid('开始日期不能晚于结束日期');
  const topic = url.searchParams.get('topic') || '';
  if (topic && !categories.includes(topic) && !practiceOptions.topics.some(t => t.id === topic)) invalid('请选择有效的知识点或练习内容');
  return { from, to, topic };
}
export const matchesTopic = (a, topic) => !topic || a.category === topic || a.knowledgePoints.includes(topic);
export const submissionStatus = s => s?.submitted_at ? 'submitted' : s?.saved_at ? 'draft' : 'unstarted';
