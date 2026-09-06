// HumanEval+ adapter：base/plus 二维，check 执行模式
// 差异全部封装于此，eval.mjs 主流程只调 adapter 接口
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = join(__dirname, 'humanevalplus.jsonl');
const FAIL_TYPE = { PASS: '通过', CE: '编译错误', RE: '运行异常', WA: '答案错误', TLE: '超时' };

function truncateLines(text, max) {
  return text.split('\n').filter((l) => l.trim()).slice(0, max).join('\n');
}

// 拼接 agent 代码 + test + check(entry_point) 整体跑，二值通过/失败 + 类型分类
function runAssertTests(code, testCode, entryPoint) {
  if (!code.trim()) return { passed: false, failType: 'CE', stderr: '无代码' };
  const filePath = `/tmp/eval_${randomUUID()}.py`;
  const fullCode = code + '\n\n' + testCode + `\n\ncheck(${entryPoint})\n`;
  writeFileSync(filePath, fullCode);
  try {
    execSync(`python3 ${filePath}`, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { passed: true, failType: 'PASS', stderr: '' };
  } catch (err) {
    const stderr = (err.stderr ?? '').toString();
    if (err.killed || err.signal === 'SIGTERM') return { passed: false, failType: 'TLE', stderr: '' };
    if (/SyntaxError|IndentationError|TabError/.test(stderr)) return { passed: false, failType: 'CE', stderr: stderr.slice(0, 500) };
    if (/AssertionError|assert/.test(stderr)) return { passed: false, failType: 'WA', stderr: stderr.slice(0, 500) };
    return { passed: false, failType: 'RE', stderr: stderr.slice(0, 500) };
  } finally {
    try { unlinkSync(filePath); } catch {}
  }
}

export default function createAdapter(config) {
  return {
    name: 'humanevalplus',
    load() {
      if (!existsSync(DATASET_PATH)) throw new Error(`数据集不存在: ${DATASET_PATH}`);
      return readFileSync(DATASET_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    },
    normalize(row) {
      return { dataset: 'humanevalplus', questionId: row.task_id, prompt: row.prompt, entryPoint: row.entry_point, baseTest: row.baseTest, test: row.test };
    },
    buildPrompt(q) {
      return `用 Python 3 实现以下函数。将完整代码（含函数定义与 import）放在一个 \`\`\`python 代码块中输出，代码块外不要解释。\n\n${q.prompt}`;
    },
    buildFeedback(tr, q, sampleCount) {
      const lines = ['测试未全部通过，请根据失败信息修正代码，仍输出完整代码在 ```python 代码块中。', ''];
      const fmt = (label, r) => {
        lines.push(`- ${label}：${r.passed ? '通过' : FAIL_TYPE[r.failType] ?? '失败'}`);
        if (!r.passed && r.stderr) lines.push('  失败信息：', '  ' + truncateLines(r.stderr, sampleCount * 3).replace(/\n/g, '\n  '));
      };
      fmt('base test（功能正确性）', tr.base);
      if (tr.plus) fmt('plus test（健壮性，含边界/异常用例）', tr.plus);
      return lines.join('\n');
    },
    runTests(code, q) {
      const base = runAssertTests(code, q.baseTest, q.entryPoint);
      const plus = runAssertTests(code, q.test, q.entryPoint);
      return {
        base: { passed: base.passed, score: base.passed ? 100 : 0, failType: base.failType, stderr: base.stderr },
        plus: { passed: plus.passed, score: plus.passed ? 100 : 0, failType: plus.failType, stderr: plus.stderr },
        allPass: base.passed && plus.passed,
      };
    },
    scoreE(tr) {
      const ew = config.scoring.effectWeights;
      const E1 = tr.base.score;
      const E2 = tr.plus?.score ?? 0;
      return { E1, E2, rawE: E1 * (ew.functional ?? 0.5) + E2 * (ew.robust ?? 0.5) };
    },
    summaryLabel() {
      const ew = config.scoring.effectWeights;
      return `E=(E₁×${ew.functional}+E₂×${ew.robust})×turnFactor | E₁=base通过(100/0) | E₂=plus通过(100/0)`;
    },
  };
}
