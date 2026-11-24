import { randomInt } from 'node:crypto';

export const practiceOptions = {
  grades: [1, 2, 3, 4, 5, 6],
  topics: [
    { id: 'add-sub-chain', name: '连加连减与加减混合', minGrade: 1 },
    { id: 'mul-div-chain', name: '连乘连除与乘除混合', minGrade: 2 },
    { id: 'precedence', name: '先乘除后加减', minGrade: 2 },
    { id: 'parentheses', name: '小括号混合运算', minGrade: 2 }
  ],
  difficulties: [{ id: 'basic', name: '基础（2 步）' }, { id: 'advanced', name: '提高（3 步）' }]
};

export function mixedOptions(input = {}) {
  const grade = input.grade === undefined ? 3 : input.grade;
  const knowledgePoints = input.knowledgePoints === undefined ? (grade === 1 ? ['add-sub-chain'] : ['precedence', 'parentheses']) : input.knowledgePoints;
  const difficulty = input.difficulty === undefined ? 'basic' : input.difficulty;
  if (!practiceOptions.grades.includes(grade)) throw new Error('请选择 1–6 年级');
  if (!Array.isArray(knowledgePoints) || !knowledgePoints.length || new Set(knowledgePoints).size !== knowledgePoints.length ||
      knowledgePoints.some(id => !practiceOptions.topics.some(t => t.id === id && t.minGrade <= grade))) throw new Error('请选择本年级至少一个已学知识点');
  if (!practiceOptions.difficulties.some(d => d.id === difficulty)) throw new Error('难度请选择基础或提高');
  return { grade, knowledgePoints, difficulty };
}

const apply = (op, a, b) => ({ '+': () => a + b, '-': () => a - b, '*': () => a * b, '/': () => a / b })[op]();
const value = q => typeof q === 'number' ? q : apply(q.op, value(q.a), value(q.b));
function meaningful(op, a, b) {
  const result = apply(op, a, b);
  return a > 0 && b > 0 && (op !== '*' || (a > 1 && b > 1)) && (op !== '/' || (b > 1 && a > b)) &&
    Number.isInteger(result) && result > 0 && result <= 100;
}
const pools = Object.fromEntries(['+', '-', '*', '/'].map(op => {
  const list = [];
  for (let a = 1; a <= 100; a++) for (let b = 1; b <= 100; b++) if (meaningful(op, a, b)) list.push({ a, b, op });
  return [op, list];
}));
const pick = list => list[randomInt(list.length)];
function extend(inner, op) {
  const a = value(inner);
  const candidates = [];
  for (let b = 1; b <= 100; b++) {
    if (!meaningful(op, a, b)) continue;
    // Reject an operation immediately undoing the previous operation with the same operand.
    if ((inner.op === '+' && op === '-' && (b === value(inner.a) || b === value(inner.b))) ||
        (inner.op === '-' && op === '+' && b === value(inner.b)) ||
        (inner.op === '*' && op === '/' && (b === value(inner.a) || b === value(inner.b))) ||
        (inner.op === '/' && op === '*' && b === value(inner.b))) continue;
    candidates.push(b);
  }
  return candidates.length ? { a: inner, b: pick(candidates), op } : null;
}

export function generateMixed(count, input) {
  const options = mixedOptions(input), result = [], used = new Set();
  for (let i = 0; i < count; i++) {
    const topic = options.knowledgePoints[i % options.knowledgePoints.length];
    const variant = Math.floor(i / options.knowledgePoints.length);
    const low = ['+', '-'], high = ['*', '/'];
    let accepted = false;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const chainOps = topic === 'mul-div-chain' ? high : low;
      const firstOps = topic === 'precedence' ? high : chainOps;
      let q = pick(pools[firstOps[variant % 2]]);
      const secondOp = topic === 'parentheses' ? high[variant % 2] : topic === 'precedence' ? low[variant % 2] : chainOps[(variant + 1) % 2];
      q = extend(q, secondOp);
      if (!q) continue;
      if (options.difficulty === 'advanced') q = extend(q, topic === 'parentheses' || topic === 'precedence' ? low[(variant + 1) % 2] : chainOps[variant % 2]);
      if (!q) continue;
      const key = JSON.stringify(q);
      if (used.has(key)) continue;
      used.add(key); result.push(q); accepted = true; break;
    }
    if (!accepted) throw new Error('暂时无法生成符合要求的题目，请重试');
  }
  return result;
}
