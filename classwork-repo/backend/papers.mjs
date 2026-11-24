import { randomInt } from 'node:crypto';
import { generateMixed, mixedOptions } from './questions.mjs';

export const practiceCategories = ['add-sub-20', 'mul-div-20', 'mixed-100'];
export const categories = [...practiceCategories, 'composite'];
export const questionCounts = [10, 20, 50];
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function paperOptions(input = {}) {
  const category = input.category === undefined ? 'add-sub-20' : input.category, questionCount = input.questionCount === undefined ? 10 : input.questionCount, difficulty = input.difficulty === undefined ? 'basic' : input.difficulty;
  if (!categories.includes(category)) invalid('请选择一种有效题型');
  if (!questionCounts.includes(questionCount)) invalid('题目数量请选择 10、20 或 50 道');
  if (!['basic', 'advanced'].includes(difficulty)) invalid('难度请选择基础或提高');
  let selectedCategories = [category];
  if (category === 'composite') {
    const selected = input.selectedCategories;
    if (!Array.isArray(selected) || selected.length < 2 || selected.length > 3 || new Set(selected).size !== selected.length || selected.some(c => !practiceCategories.includes(c))) invalid('综合练习请勾选两种或三种题型');
    selectedCategories = practiceCategories.filter(c => selected.includes(c));
  }
  let mixed = { grade: null, knowledgePoints: [] };
  if (selectedCategories.includes('mixed-100')) {
    try { mixed = mixedOptions({ ...input, difficulty }); } catch (e) { invalid(e.message); }
  }
  return { category, selectedCategories, questionCount, difficulty, grade: mixed.grade, knowledgePoints: mixed.knowledgePoints };
}
function shuffle(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) { const j = randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}
const pools = Object.fromEntries(['+', '-', '*', '/'].map(op => {
  const list = [];
  for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) {
    const answer = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
    if (Number.isInteger(answer) && answer >= 0 && answer <= 20 && (op !== '/' || b)) list.push({ a, b, op });
  }
  return [op, list];
}));
function binaryPool(op, difficulty) {
  if (op === '+' || op === '-') return shuffle(pools[op].filter(q => {
    const regroup = op === '+' ? q.a % 10 + q.b % 10 >= 10 : q.a % 10 < q.b % 10;
    return difficulty === 'advanced' ? regroup : !regroup;
  }));
  if (difficulty === 'basic') return shuffle(pools[op].filter(q => {
    const factors = op === '*' ? [q.a, q.b] : [q.b, q.a / q.b];
    return factors.some(n => [0, 1, 2, 5, 10].includes(n));
  }));
  const nontrivial = pools[op].filter(q => (op === '*' ? [q.a, q.b] : [q.b, q.a / q.b]).every(n => n >= 2));
  const harder = q => (op === '*' ? [q.a, q.b] : [q.b, q.a / q.b]).every(n => n >= 3);
  return [...shuffle(nontrivial.filter(harder)), ...shuffle(nontrivial.filter(q => !harder(q)))];
}
function binaryQuestions(category, count, difficulty) {
  const ops = category === 'add-sub-20' ? ['+', '-'] : ['*', '/'];
  const choices = ops.map(op => binaryPool(op, difficulty));
  return Array.from({ length: count }, (_, i) => {
    const q = choices[i % 2].shift();
    if (!q) throw new Error('暂时无法生成符合难度的题目，请调整题量');
    return q;
  });
}
export function generatePaper(options) {
  const { selectedCategories, questionCount } = options, questions = [], questionCategories = [], components = [];
  selectedCategories.forEach((category, index) => {
    const count = Math.floor(questionCount / selectedCategories.length) + Number(index < questionCount % selectedCategories.length);
    const generated = category === 'mixed-100' ? generateMixed(count, options) : binaryQuestions(category, count, options.difficulty);
    questions.push(...generated); questionCategories.push(...Array(count).fill(category)); components.push({ category, count });
  });
  return { questions, questionCategories, components };
}
