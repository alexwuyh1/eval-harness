// P1.1 模型性能评测框架（裸跑模式）
// 输入：难度（可选）+ 题号（可选）→ 从 LiveCodeBench 按难度抽 1 道题
// → models.json 所有模型并行通过 pi CLI 跑 → 采集性能指标 + 提取代码执行测试用例打分
// → 输出各模型性能指标 + 效果分 + 总分
// 启动：node probe/eval.mjs [--difficulty easy|medium|hard] [--question-id <id>] [--harness bare|harness]

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DATASET_PATH = join(__dirname, 'datasets', 'livecodebench', 'livecodebench.jsonl');
const RESULTS_DIR = join(__dirname, 'results');

// ───────────────────────── CLI 参数 ─────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { difficulty: null, questionId: null, harness: 'bare' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--difficulty' && i + 1 < args.length) opts.difficulty = args[++i];
    else if (args[i] === '--question-id' && i + 1 < args.length) opts.questionId = args[++i];
    else if (args[i] === '--harness' && i + 1 < args.length) opts.harness = args[++i];
  }
  return opts;
}

// ───────────────────────── 模型清单 ─────────────────────────
// 单一真相源：models.json（pi 模型配置）
const modelsJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'models.json'), 'utf8'));
const MODELS = modelsJson.providers.dashscope.models.map((m) => ({ id: m.id, cost: m.cost }));

// ───────────────────────── 数据集 ─────────────────────────
function loadLiveCodeBench() {
  if (!existsSync(DATASET_PATH)) throw new Error(`数据集不存在: ${DATASET_PATH}`);
  return readFileSync(DATASET_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function pickQuestion(difficulty, questionId) {
  const all = loadLiveCodeBench();
  let pool = all;
  if (questionId) {
    pool = all.filter((q) => q.question_id === questionId);
    if (pool.length === 0) throw new Error(`题号 ${questionId} 不存在`);
  } else if (difficulty) {
    pool = all.filter((q) => q.difficulty === difficulty);
    if (pool.length === 0) throw new Error(`难度 ${difficulty} 无可用题`);
  }
  const row = pool[Math.floor(Math.random() * pool.length)];
  return {
    questionId: row.question_id,
    questionTitle: row.question_title,
    questionContent: row.question_content,
    platform: row.platform,
    difficulty: row.difficulty,
    starterCode: row.starter_code,
    publicTestCases: JSON.parse(row.public_test_cases),
    privateTestCasesRaw: row.private_test_cases,
  };
}

// private_test_cases 解码：base64 → zlib → pickle → JSON 字符串
// 大 base64/JSON 走临时文件（解码后可达数 MB，超过 execSync 缓冲区上限）
// Python 脚本读 b64 文件 → 解码 → 写 JSON 文件 → Node 读回
function decodePrivateTestCases(base64Str) {
  const tmpB64 = join(tmpdir(), `lcb_pvt_${randomUUID()}.b64`);
  const tmpJson = join(tmpdir(), `lcb_pvt_${randomUUID()}.json`);
  writeFileSync(tmpB64, base64Str);
  try {
    execSync(
      `python3 -c "import base64,zlib,pickle,json,sys; d=base64.b64decode(open(sys.argv[1]).read()); d=zlib.decompress(d); open(sys.argv[2],'w').write(pickle.loads(d))" "${tmpB64}" "${tmpJson}"`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 * 1024 },
    );
    return JSON.parse(readFileSync(tmpJson, 'utf8'));
  } finally {
    try { unlinkSync(tmpB64); } catch {}
    try { unlinkSync(tmpJson); } catch {}
  }
}

// ───────────────────────── prompt 构造 ─────────────────────────
function buildPrompt(question) {
  let prompt = `用 Python 3 解以下题目。将完整解题代码放在一个 \`\`\`python 代码块中输出（代码块外不要解释）。代码从 STDIN 读输入，向 STDOUT 写输出。\n\n${question.questionContent}`;
  if (question.starterCode && question.starterCode.trim()) {
    prompt += `\n\n函数签名/起始代码：\n${question.starterCode}`;
  }
  return prompt;
}

// ───────────────────────── pi CLI 驱动 ─────────────────────────
// 裸跑参数：pi --mode json -p --no-extensions --thinking high --model dashscope/<id> "<prompt>"
// env 剥离 PI_SESSION_*，否则子进程复用父会话句柄空跑（参考 extensions/index.ts）
function runPiModel(modelId, prompt) {
  return new Promise((resolve) => {
    const args = [
      '--mode', 'json',
      '-p',
      '--no-extensions',
      '--thinking', 'high',
      '--model', `dashscope/${modelId}`,
      prompt,
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('PI_SESSION')),
    );

    const t0 = performance.now();
    const proc = spawn('pi', args, {
      cwd: PROJECT_ROOT,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 采集状态
    let ttftMs = null; // 首个 message_update 到达 - t0
    let thinkingStartAt = null;
    let thinkingEndAt = null;
    let textEndAt = null;
    let agentStartAt = null;
    let agentEndAt = null;
    let usage = null;
    let finalText = '';
    let stderrTail = '';

    let buffer = '';
    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const now = performance.now();
      const type = event.type;

      if (type === 'agent_start') agentStartAt = now;
      else if (type === 'agent_end') agentEndAt = now;
      else if (type === 'message_update') {
        // TTFT：首个 message_update 到达
        if (ttftMs === null) ttftMs = now - t0;
        const ame = event.assistantMessageEvent;
        if (ame) {
          if (ame.type === 'thinking_start' && thinkingStartAt === null) thinkingStartAt = now;
          else if (ame.type === 'thinking_end') thinkingEndAt = now;
          else if (ame.type === 'text_end') textEndAt = now;
        }
        if (event.usage) usage = event.usage;
      } else if (type === 'message_end' && event.message?.role === 'assistant') {
        // message_end 的 usage 在 message.usage（非顶层），message_update 的 usage 在顶层
        if (event.message?.usage) usage = event.message.usage;
        const texts = (event.message.content ?? [])
          .filter((c) => c?.type === 'text')
          .map((c) => c.text);
        if (texts.length > 0) finalText = texts.join('');
      }
    };

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (data) => {
      stderrTail = (stderrTail + data.toString()).slice(-4000);
    });

    proc.on('close', (code) => {
      if (buffer.trim()) processLine(buffer);

      // 生成时长：thinking_start（有思考）或 首个 message_update（无思考）到 text_end
      const genStartAt = thinkingStartAt ?? (ttftMs !== null ? t0 + ttftMs : null);
      const genDurationMs = (genStartAt && textEndAt) ? textEndAt - genStartAt : null;

      const totalMs = (agentStartAt && agentEndAt) ? agentEndAt - agentStartAt : null;
      const thinkMs = (thinkingStartAt && thinkingEndAt) ? thinkingEndAt - thinkingStartAt : 0;

      const totalTokens = usage?.totalTokens ?? 0;
      const reasoning = usage?.reasoning ?? 0;
      const output = usage?.output ?? 0;
      const input = usage?.input ?? 0;
      const cacheRead = usage?.cacheRead ?? 0;
      const cost = usage?.cost?.total ?? 0;

      const tokenRatio = totalTokens > 0 ? reasoning / totalTokens : 0;
      const tps = (genDurationMs && genDurationMs > 0) ? output / (genDurationMs / 1000) : 0;
      const cacheHitRate = (input + cacheRead) > 0 ? cacheRead / (input + cacheRead) : 0;

      resolve({
        status: code === 0 ? 'ok' : 'error',
        model: modelId,
        code: finalText,
        metrics: {
          ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
          thinkMs: Math.round(thinkMs),
          tokenRatio: Number(tokenRatio.toFixed(4)),
          tps: Number(tps.toFixed(1)),
          totalMs: totalMs !== null ? Math.round(totalMs) : null,
          totalTokens,
          cacheHitRate: Number(cacheHitRate.toFixed(4)),
          cost,
        },
        detail: {
          input,
          output,
          reasoning,
          cacheRead,
          exitCode: code,
          stderrTail: stderrTail.slice(-500),
        },
      });
    });

    proc.on('error', (err) => {
      resolve({
        status: 'error',
        model: modelId,
        code: '',
        metrics: null,
        detail: { exitCode: -1, stderrTail: String(err).slice(0, 500) },
      });
    });
  });
}

// ───────────────────────── 代码提取 ─────────────────────────
function extractCode(text) {
  if (!text) return '';
  const re = /```python\n([\s\S]*?)```/g;
  let last = '';
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
  }
  return last.trim();
}

// ───────────────────────── 测试执行 ─────────────────────────
function runTestCase(code, tc) {
  if (!code.trim()) return { status: 'CE', stderr: '无代码' };

  const fileId = randomUUID();
  const filePath = `/tmp/eval_${fileId}.py`;
  writeFileSync(filePath, code);

  try {
    const result = execSync(
    `echo ${shellQuote(tc.input)} | python3 ${filePath}`,
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const actual = (result ?? '').trim();
  const expected = (tc.output ?? '').trim();
  return actual === expected ? { status: 'PASS' } : { status: 'WA', actual, expected };
  } catch (err) {
    const stderr = (err.stderr ?? '').toString();
    // 超时
    if (err.killed || err.signal === 'SIGTERM') return { status: 'TLE' };
    // 语法/编译错误
    if (stderr.includes('SyntaxError') || stderr.includes('IndentationError') || stderr.includes('TabError')) {
      return { status: 'CE', stderr: stderr.slice(0, 300) };
    }
    // 运行异常
    return { status: 'RE', stderr: stderr.slice(0, 300) };
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function runAllTests(code, testCases) {
  const results = testCases.map((tc) => runTestCase(code, tc));
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const statuses = new Set(results.map((r) => r.status));

  let failType = 'PASS';
  if (passCount === 0 && statuses.has('CE')) failType = 'CE';
  else if (passCount < results.length) {
    if (statuses.has('RE')) failType = 'RE';
    else if (statuses.has('TLE')) failType = 'TLE';
    else failType = 'WA';
  }

  return {
    passCount,
    total: testCases.length,
    passRate: results.length > 0 ? passCount / results.length : 0,
    failType,
    results,
  };
}

// ───────────────────────── 评分 ─────────────────────────
// E（效果分，0-100）：全过=100，CE=10，部分通过=通过率×100×惩罚系数
function scoreE(testResult) {
  if (testResult.failType === 'PASS') return 100;
  if (testResult.failType === 'CE') return 10;
  let penalty = 1.0;
  if (testResult.failType === 'RE') penalty = 0.8;
  else if (testResult.failType === 'TLE') penalty = 0.9;
  return testResult.passRate * 100 * penalty;
}

// clip(x, min, max)
function clip(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// T（速度分，0-100）：clip(中位耗时/模型耗时×50, 0, 100)
function scoreT(modelMs, medianMs) {
  if (modelMs === null || modelMs <= 0 || medianMs <= 0) return 0;
  return clip(medianMs / modelMs * 50, 0, 100);
}

// C（成本分，0-100）：clip(中位成本/模型成本×50, 0, 100)
function scoreC(modelCost, medianCost) {
  if (modelCost <= 0 || medianCost <= 0) return 0;
  return clip(medianCost / modelCost * 50, 0, 100);
}

function median(arr) {
  const sorted = [...arr].filter((v) => v !== null && v !== undefined && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ───────────────────────── 汇总表 ─────────────────────────
function printSummary(question, records) {
  const header = `模型${' '.repeat(22)}E分  T分  C分  总分  通过率   失败 TTFT 思考ms token比 吞吐 总ms  token  缓存 命率 成本`;
  console.log('\n' + '='.repeat(header.length));
  console.log(`P1.1 评测汇总（题: ${question.questionId} ${question.difficulty} ${question.platform}）`);
  console.log('E=效果分 T=速度分 C=成本分 总分=E×(0.6+0.3×T/100+0.1×C/100) | TTFT=首token(ms) 思考=思考时间(ms) token比=思考/总 吞吐=tok/s 总ms=总耗时 缓存=缓存命中 成本=元');
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of records) {
    const m = r.metrics || {};
    let row = r.model.padEnd(24);
    if (r.status !== 'ok') {
      row += `(错误: ${r.detail?.stderrTail?.slice(0, 60) ?? ''})`;
      console.log(row);
      continue;
    }
    const E = r.scores.E.toFixed(0).padStart(4);
    const T = r.scores.T.toFixed(0).padStart(4);
    const C = r.scores.C.toFixed(0).padStart(4);
    const total = r.scores.total.toFixed(1).padStart(5);
    const passRate = (r.testResult.passRate * 100).toFixed(0).padStart(3) + '%';
    const failType = r.testResult.failType.padEnd(4);
    const ttft = String(m.ttftMs ?? '-').padStart(5);
    const think = String(m.thinkMs ?? '-').padStart(6);
    const tokenRatio = (m.tokenRatio * 100).toFixed(0).padStart(4) + '%';
    const tps = String(m.tps ?? '-').padStart(5);
    const totalMs = String(m.totalMs ?? '-').padStart(5);
    const tokens = String(m.totalTokens ?? '-').padStart(6);
    const cache = (m.cacheHitRate * 100).toFixed(0).padStart(3) + '%';
    const cost = m.cost.toFixed(4).padStart(7);
    row += `${E} ${T} ${C} ${total}  ${passRate}  ${failType} ${ttft} ${think} ${tokenRatio} ${tps} ${totalMs} ${tokens} ${cache} ${cost}`;
    console.log(row);
  }
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  const opts = parseArgs();

  // harness 模式留接口不实现
  if (opts.harness === 'harness') {
    console.log('暂未实现 harness 模式');
    process.exit(0);
  }

  // 1. 抽题
  const question = pickQuestion(opts.difficulty, opts.questionId);
  console.log(`抽题: ${question.questionId}（${question.difficulty} ${question.platform}）${question.questionTitle}`);

  // 2. 合并测试用例
  let testCases = [...question.publicTestCases];
  try {
    const privateTc = decodePrivateTestCases(question.privateTestCasesRaw);
    testCases = testCases.concat(privateTc);
  } catch (err) {
    console.error(`private_test_cases 解码失败: ${err.message}`);
  }
  console.log(`测试用例: ${testCases.length} 个（public ${question.publicTestCases.length} + private ${testCases.length - question.publicTestCases.length}）`);

  // 3. 构造 prompt
  const prompt = buildPrompt(question);

  // 4. 所有模型并行通过 pi CLI 跑
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(RESULTS_DIR, `eval-${ts}.jsonl`);
  writeFileSync(resultsPath, '');

  console.log(`并行评测 ${MODELS.length} 个模型 ...`);
  const rawResults = await Promise.all(MODELS.map((m) => runPiModel(m.id, prompt)));

  // 5. 提取代码 + 执行测试用例
  const records = rawResults.map((r) => {
    if (r.status !== 'ok') return r;
    const code = extractCode(r.code);
    const testResult = runAllTests(code, testCases);
    return { ...r, code, testResult };
  });

  // 6. 评分（基线用参测模型中位数）
  const validRecords = records.filter((r) => r.status === 'ok' && r.metrics);
  const medianMs = median(validRecords.map((r) => r.metrics.totalMs));
  const medianCost = median(validRecords.map((r) => r.metrics.cost));

  for (const r of records) {
    if (r.status !== 'ok') continue;
    const E = scoreE(r.testResult);
    const T = scoreT(r.metrics.totalMs, medianMs);
    const C = scoreC(r.metrics.cost, medianCost);
    const total = E * (0.6 + 0.3 * T / 100 + 0.1 * C / 100);
    r.scores = { E: Number(E.toFixed(2)), T: Number(T.toFixed(2)), C: Number(C.toFixed(2)), total: Number(total.toFixed(2)) };
    r.baseline = { medianMs, medianCost };
  }

  // 7. 终端汇总表
  printSummary(question, records);

  // 8. 写 JSONL（一行一模型）
  for (const r of records) {
    const line = JSON.stringify({
      questionId: question.questionId,
      questionTitle: question.questionTitle,
      difficulty: question.difficulty,
      platform: question.platform,
      model: r.model,
      status: r.status,
      metrics: r.metrics,
      testResult: r.testResult ?? null,
      scores: r.scores ?? null,
      baseline: r.baseline ?? null,
      detail: r.detail,
    });
    writeFileSync(resultsPath, line + '\n', { flag: 'a' });
  }

  console.log(`\nJSONL 结果已写入: ${resultsPath}`);
  const ok = records.filter((r) => r.status === 'ok').length;
  const err = records.length - ok;
  console.log(`完成: ${ok} 个成功, ${err} 个错误, 共 ${records.length} 个`);
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
