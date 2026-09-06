// BigCodeBench adapter：单维通过率，unittest 执行模式
// 差异全部封装于此。test 是 unittest.TestCase 类，解析 test_ 通过数算通过率
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = join(__dirname, 'bigcodebench.jsonl');
const FAIL_TYPE = { PASS: '通过', CE: '编译错误', RE: '运行异常', WA: '答案错误', TLE: '超时' };

function truncateLines(text, max) {
  return text.split('\n').filter((l) => l.trim()).slice(0, max).join('\n');
}

// 解析 unittest 输出：Ran N tests, failures=M, errors=K → 通过率
function parseUnitTest(combined) {
  const ran = parseInt((combined.match(/Ran (\d+) tests/) || [])[1] ?? '0', 10);
  const failures = parseInt((combined.match(/failures=(\d+)/) || [])[1] ?? '0', 10);
  const errors = parseInt((combined.match(/errors=(\d+)/) || [])[1] ?? '0', 10);
  const passed = ran - failures - errors;
  return { ran, passed, passRate: ran > 0 ? passed / ran : 0 };
}

export default function createAdapter(config) {
  return {
    name: 'bigcodebench',
    load() {
      if (!existsSync(DATASET_PATH)) throw new Error(`数据集不存在: ${DATASET_PATH}`);
      return readFileSync(DATASET_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    },
    normalize(row) {
      return { dataset: 'bigcodebench', questionId: row.task_id, prompt: row.instruct_prompt, entryPoint: row.entry_point, test: row.test };
    },
    buildPrompt(q) {
      return `用 Python 3 实现以下函数（函数名 ${q.entryPoint}）。将完整代码（含函数定义与 import）放在一个 \`\`\`python 代码块中输出，代码块外不要解释。\n\n${q.prompt}`;
    },
    buildFeedback(tr, q, sampleCount) {
      const lines = ['测试未全部通过，请根据失败信息修正代码，仍输出完整代码在 ```python 代码块中。', ''];
      const r = tr.base;
      lines.push(`- test：${r.passed ? '通过' : FAIL_TYPE[r.failType] ?? '失败'}（通过率 ${r.score.toFixed(0)}%）`);
      if (!r.passed && r.stderr) lines.push('  失败信息：', '  ' + truncateLines(r.stderr, sampleCount * 3).replace(/\n/g, '\n  '));
      return lines.join('\n');
    },
    runTests(code, q) {
      if (!code.trim()) return { base: { passed: false, score: 0, failType: 'CE', stderr: '无代码' }, plus: null, allPass: false };
      const filePath = `/tmp/eval_${randomUUID()}.py`;
      // 拼接 agent 代码 + unittest 类 + 触发 main(verbosity=2)
      const fullCode = code + '\n\n' + q.test + `\n\nif __name__ == "__main__":\n    import unittest\n    unittest.main(verbosity=2, exit=False)\n`;
      writeFileSync(filePath, fullCode);
      try {
        execSync(`python3 ${filePath}`, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { base: { passed: true, score: 100, failType: 'PASS', stderr: '' }, plus: null, allPass: true };
      } catch (err) {
        const stderr = (err.stderr ?? '').toString();
        const stdout = err.stdout ? err.stdout.toString() : '';
        const combined = stderr + '\n' + stdout;
        if (err.killed || err.signal === 'SIGTERM') return { base: { passed: false, score: 0, failType: 'TLE', stderr: '' }, plus: null, allPass: false };
        if (/SyntaxError|IndentationError|TabError/.test(combined)) return { base: { passed: false, score: 0, failType: 'CE', stderr: combined.slice(0, 500) }, plus: null, allPass: false };
        const { passRate } = parseUnitTest(combined);
        return { base: { passed: passRate === 1, score: passRate * 100, failType: 'WA', stderr: combined.slice(0, 500) }, plus: null, allPass: passRate === 1 };
      } finally {
        try { unlinkSync(filePath); } catch {}
      }
    },
    scoreE(tr) {
      // 单维：rawE = base.score（通过率×100），无 E₂
      const E1 = tr.base.score;
      return { E1, E2: null, rawE: E1 };
    },
    summaryLabel() {
      return 'E=test通过率×100×turnFactor（单维，无 base/plus 区分）';
    },
  };
}
