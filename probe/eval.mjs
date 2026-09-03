// P1.1 模型性能评测框架（裸跑 + harness 模式，支持多题）
// 输入：模式/难度/题号 → 从 LiveCodeBench 抽题（1-5 道）
// → 题间串行，每题内 models.json 所有模型并行通过 pi CLI 跑
// → 采集性能指标 + 提取代码执行测试用例打分 → 每题汇总 + 多题总汇总
// 启动：
//   node probe/eval.mjs --mode standard [--harness bare|harness] [--model <id>] [--timeout <秒>]
//     标准模式：medium 1 + hard 1（超时 medium 600s/hard 900s，--timeout 统一覆盖）
//   node probe/eval.mjs --difficulty easy,medium --count 2 [...]（自定义，每难度抽 count 道，总≤5）
//   node probe/eval.mjs [--difficulty easy|medium|hard] [--question-id <id>] [...]（单题，默认全难度随机1道）

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

// harness 模式固定路径
const EXTENSION_PATH = '/Users/apple/Program/my-agent/extensions/index.ts';
const AGENTS_MD_PATH = '/Users/apple/知识库/技能/AGENTS.md';

// 默认超时（秒）：裸跑 5 分钟，harness 10 分钟
const DEFAULT_TIMEOUT_BARE = 300;
const DEFAULT_TIMEOUT_HARNESS = 600;
// 标准模式超时（秒）：按难度递增，medium 10 分钟，hard 15 分钟（裸跑默认）
const STANDARD_TIMEOUTS = { medium: 600, hard: 900 };

// ───────────────────────── CLI 参数 ─────────────────────────
// CLI flag 配置表：flag名 → { key, type, default }。parseArgs 遍历匹配，无 if/else 链
const CLI_FLAGS = [
  { flag: '--mode', key: 'mode', type: 'string', default: null },
  { flag: '--difficulty', key: 'difficulty', type: 'string', default: null },
  { flag: '--count', key: 'count', type: 'int', default: 1 },
  { flag: '--question-id', key: 'questionId', type: 'string', default: null },
  { flag: '--harness', key: 'harness', type: 'string', default: 'bare' },
  { flag: '--timeout', key: 'timeout', type: 'int', default: null },
  { flag: '--model', key: 'model', type: 'string', default: null },
];

function parseArgs() {
  const opts = Object.fromEntries(CLI_FLAGS.map((f) => [f.key, f.default]));
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const def = CLI_FLAGS.find((f) => f.flag === args[i]);
    if (!def || i + 1 >= args.length) continue;
    const val = args[++i];
    opts[def.key] = def.type === 'int' ? parseInt(val, 10) : val;
  }
  return opts;
}

// ───────────────────────── 模型清单 ─────────────────────────
// 单一真相源：models.json（pi 模型配置）。--model 可限定单模型跑（自测用）
const modelsJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'models.json'), 'utf8'));
const ALL_MODELS = modelsJson.providers.dashscope.models.map((m) => ({ id: m.id, cost: m.cost }));
function selectModels(modelFilter) {
  if (!modelFilter) return ALL_MODELS;
  return ALL_MODELS.filter((m) => m.id === modelFilter);
}

// ───────────────────────── 数据集 ─────────────────────────
function loadLiveCodeBench() {
  if (!existsSync(DATASET_PATH)) throw new Error(`数据集不存在: ${DATASET_PATH}`);
  return readFileSync(DATASET_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// 将数据集原始行归一化为评测题对象（SSOT：题对象唯一构造入口）
function normalizeQuestion(row) {
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

// 从池中随机抽 n 道不重复题（Fisher-Yates 洗牌后取前 n）
function sampleQuestions(pool, n, timeoutSec) {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n).map((row) => ({ question: normalizeQuestion(row), timeoutSec }));
}

// 校验难度列表合法 + count 正整数 + 总题数≤5，返回去重后的难度数组
function validateDifficultyList(difficultyStr, count) {
  const difficulties = difficultyStr.split(',').map((s) => s.trim()).filter(Boolean);
  for (const d of difficulties) {
    if (!['easy', 'medium', 'hard'].includes(d)) throw new Error(`未知难度: ${d}（应为 easy/medium/hard）`);
  }
  if (!Number.isInteger(count) || count < 1) throw new Error(`--count 应为正整数，当前: ${count}`);
  const total = difficulties.length * count;
  if (total > 5) throw new Error(`总题数 ${total} 超过上限 5`);
  return difficulties;
}

// --question-id <id>：单题
function pickByQuestionId(all, opts, defaultTimeout) {
  const row = all.find((q) => q.question_id === opts.questionId);
  if (!row) throw new Error(`题号 ${opts.questionId} 不存在`);
  return [{ question: normalizeQuestion(row), timeoutSec: defaultTimeout }];
}

// --mode standard：medium 随机 1 + hard 随机 1（超时 medium 600s/hard 900s）
function pickStandard(all, opts) {
  const mediums = all.filter((q) => q.difficulty === 'medium');
  const hards = all.filter((q) => q.difficulty === 'hard');
  if (mediums.length === 0) throw new Error('难度 medium 无可用题');
  if (hards.length === 0) throw new Error('难度 hard 无可用题');
  const m = sampleQuestions(mediums, 1, opts.timeout ?? STANDARD_TIMEOUTS.medium);
  const h = sampleQuestions(hards, 1, opts.timeout ?? STANDARD_TIMEOUTS.hard);
  return [...m, ...h];
}

// --difficulty <列表> --count <n>：每难度抽 count 道
function pickByDifficultyList(all, opts, defaultTimeout) {
  const difficulties = validateDifficultyList(opts.difficulty, opts.count);
  const result = [];
  for (const d of difficulties) {
    const pool = all.filter((q) => q.difficulty === d);
    if (pool.length === 0) throw new Error(`难度 ${d} 无可用题`);
    if (pool.length < opts.count) throw new Error(`难度 ${d} 只有 ${pool.length} 题，不足 ${opts.count}`);
    result.push(...sampleQuestions(pool, opts.count, defaultTimeout));
  }
  return result;
}

// 默认：全难度随机 1 道
function pickDefault(all, defaultTimeout) {
  const row = all[Math.floor(Math.random() * all.length)];
  return [{ question: normalizeQuestion(row), timeoutSec: defaultTimeout }];
}

// 从数据集按需抽题，返回 [{ question, timeoutSec }]（题间串行，每题带自己的超时）
// 抽题规则：
//   --question-id <id>  → 单题（1 道）
//   --mode standard      → medium 随机 1 + hard 随机 1（超时 medium 600s/hard 900s）
//   --difficulty <列表> --count <每难度题数> → 每难度抽 count 道，总≤5
//   默认                 → 全难度随机 1 道
// --timeout 统一覆盖所有题的超时
function pickQuestions(opts, harness) {
  const all = loadLiveCodeBench();
  const defaultTimeout = opts.timeout ?? (harness === 'harness' ? DEFAULT_TIMEOUT_HARNESS : DEFAULT_TIMEOUT_BARE);
  if (opts.questionId) return pickByQuestionId(all, opts, defaultTimeout);
  if (opts.mode === 'standard') return pickStandard(all, opts);
  if (opts.difficulty) return pickByDifficultyList(all, opts, defaultTimeout);
  return pickDefault(all, defaultTimeout);
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
// 裸跑：pi --mode json -p --no-extensions --no-skills --thinking high --model dashscope/<id> "<prompt>"
// harness：pi --mode json -p --extension <ext> --append-system-prompt <agents.md> --thinking high --model dashscope/<id> "<prompt>"
// env 剥离 PI_SESSION_*，否则子进程复用父会话句柄空跑（参考 extensions/index.ts）
// 统一多轮采集：裸跑单轮 = 累加 1 轮，harness 多轮 = 累加多轮，结果等价

// 采集状态对象（从闭包局部变量提取，让 handler 函数能操作）
function createCollector() {
  return {
    ttftMs: null, // 首个 message_update 到达 - t0（跨轮只记首个）
    agentStartAt: null,
    agentEndAt: null,
    finalText: '',
    stderrTail: '',
    // 多轮累加器
    accInput: 0,
    accOutput: 0,
    accReasoning: 0,
    accTotalTokens: 0,
    accCacheRead: 0,
    accCost: 0,
    totalThinkMs: 0, // 所有 thinking_start→thinking_end 段累加
    totalGenMs: 0, // 所有轮生成时长累加
    // 当前轮状态（turn_end 时累加并重置）
    thinkingStartAt: null,
    genStartAt: null, // 当前轮生成开始（thinking_start 或首个 message_update）
    textEndAt: null, // 当前轮 text_end
    // write .py 内容（harness 特有：agent 可能用 write 工具写 .py 文件）
    writePyContents: [],
  };
}

// 从 toolCall 对象提取 write .py 文件内容
function collectWritePy(c, tc) {
  if (tc.name !== 'write' || !tc.arguments) return;
  const p = tc.arguments.path || '';
  if (p.endsWith('.py')) c.writePyContents.push(tc.arguments.content || '');
}

// agent_start：记首个 agent_start 时间
function handleAgentStart(c, now) {
  if (c.agentStartAt === null) c.agentStartAt = now;
}

// agent_end：记 agent_end 时间
function handleAgentEnd(c, now) {
  c.agentEndAt = now;
}

// message_update：TTFT + 生成开始 + thinking/text/toolcall 子事件
function handleMessageUpdate(c, event, now, t0) {
  if (c.ttftMs === null) c.ttftMs = now - t0;
  if (c.genStartAt === null) c.genStartAt = now;

  const ame = event.assistantMessageEvent;
  if (!ame) return;

  switch (ame.type) {
    case 'thinking_start':
      c.thinkingStartAt = now;
      break;
    case 'thinking_end':
      if (c.thinkingStartAt !== null) {
        c.totalThinkMs += now - c.thinkingStartAt;
        c.thinkingStartAt = null;
      }
      break;
    case 'text_end':
      c.textEndAt = now;
      break;
    case 'toolcall_end':
      if (ame.toolCall) collectWritePy(c, ame.toolCall);
      break;
  }
}

// message_end（assistant）：累加该轮 usage + 提取最终文本
function handleMessageEnd(c, event) {
  const msg = event.message;
  if (!msg || msg.role !== 'assistant') return;

  const u = msg.usage;
  if (u) {
    c.accInput += u.input ?? 0;
    c.accOutput += u.output ?? 0;
    c.accReasoning += u.reasoning ?? 0;
    c.accTotalTokens += u.totalTokens ?? 0;
    c.accCacheRead += u.cacheRead ?? 0;
    c.accCost += u.cost?.total ?? 0;
  }

  const texts = (msg.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text);
  if (texts.length > 0) c.finalText = texts.join('');
}

// turn_end：累加当前轮生成时长，重置轮级状态
function handleTurnEnd(c) {
  if (c.genStartAt !== null && c.textEndAt !== null) {
    c.totalGenMs += c.textEndAt - c.genStartAt;
  }
  c.thinkingStartAt = null;
  c.genStartAt = null;
  c.textEndAt = null;
}

// 末轮兜底：若无 turn_end 但有 genStartAt+textEndAt（裸跑可能无 turn_end）
function finalizeLastTurnGen(c) {
  if (c.genStartAt !== null && c.textEndAt !== null && c.totalGenMs === 0) {
    c.totalGenMs = c.textEndAt - c.genStartAt;
  }
}

// 计算最终指标（纯计算，无 IO）
function computeMetrics(c) {
  const totalMs = (c.agentStartAt && c.agentEndAt) ? c.agentEndAt - c.agentStartAt : null;
  const tokenRatio = c.accTotalTokens > 0 ? c.accReasoning / c.accTotalTokens : 0;
  const tps = c.totalGenMs > 0 ? c.accOutput / (c.totalGenMs / 1000) : 0;
  const cacheHitRate = (c.accInput + c.accCacheRead) > 0 ? c.accCacheRead / (c.accInput + c.accCacheRead) : 0;
  return {
    metrics: {
      ttftMs: c.ttftMs !== null ? Math.round(c.ttftMs) : null,
      thinkMs: Math.round(c.totalThinkMs),
      tokenRatio: Number(tokenRatio.toFixed(4)),
      tps: Number(tps.toFixed(1)),
      totalMs: totalMs !== null ? Math.round(totalMs) : null,
      totalTokens: c.accTotalTokens,
      cacheHitRate: Number(cacheHitRate.toFixed(4)),
      cost: c.accCost,
    },
    detail: {
      input: c.accInput,
      output: c.accOutput,
      reasoning: c.accReasoning,
      cacheRead: c.accCacheRead,
      stderrTail: c.stderrTail.slice(-500),
    },
  };
}

// 事件 dispatch：解析 JSON → 按 type 分发到 handler（CCN 低）
function dispatchEvent(c, line, t0) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const now = performance.now();
  const type = event.type;
  if (type === 'agent_start') handleAgentStart(c, now);
  else if (type === 'agent_end') handleAgentEnd(c, now);
  else if (type === 'message_update') handleMessageUpdate(c, event, now, t0);
  else if (type === 'message_end') handleMessageEnd(c, event);
  else if (type === 'turn_end') handleTurnEnd(c);
}

function runPiModel(modelId, prompt, opts) {
  return new Promise((resolve) => {
    const harness = opts.harness === 'harness';
    const timeoutSec = opts.timeout;

    const args = ['--mode', 'json', '-p'];
    if (harness) {
      args.push('--extension', EXTENSION_PATH);
      args.push('--append-system-prompt', AGENTS_MD_PATH);
    } else {
      args.push('--no-extensions', '--no-skills');
    }
    args.push('--thinking', 'high');
    args.push('--model', `dashscope/${modelId}`);
    args.push(prompt);

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

    const c = createCollector();
    let buffer = '';

    // 超时机制：setTimeout 到时 SIGTERM kill 进程
    let timedOut = false;
    let timeoutTimer = null;
    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch {}
      }, timeoutSec * 1000);
    }

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) dispatchEvent(c, line, t0);
    });

    proc.stderr.on('data', (data) => {
      c.stderrTail = (c.stderrTail + data.toString()).slice(-4000);
    });

    proc.on('close', (code) => {
      if (buffer.trim()) dispatchEvent(c, buffer, t0);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(buildResult(c, code, modelId, timedOut));
    });

    proc.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({
        status: 'error',
        model: modelId,
        code: '',
        writePyContents: [],
        metrics: null,
        detail: { exitCode: -1, stderrTail: String(err).slice(0, 500) },
      });
    });
  });
}

// 根据采集状态 + 退出码构建返回结果（超时/正常路径分离）
function buildResult(c, code, modelId, timedOut) {
  if (timedOut) {
    return {
      status: 'timeout',
      model: modelId,
      code: '',
      writePyContents: [],
      metrics: null,
      detail: { exitCode: code ?? -1, stderrTail: c.stderrTail.slice(-500) },
    };
  }
  finalizeLastTurnGen(c);
  const { metrics, detail } = computeMetrics(c);
  return {
    status: code === 0 ? 'ok' : 'error',
    model: modelId,
    code: c.finalText,
    writePyContents: c.writePyContents,
    metrics,
    detail: { ...detail, exitCode: code },
  };
}

// ───────────────────────── 代码提取 ─────────────────────────
// 裸跑：从最终文本提取最后一个 ```python 代码块
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

// harness：优先从最终文本提取 ```python 代码块（复用裸跑逻辑），
// 若无则从 write 工具调用提取最后一个 .py 文件内容，都无则空
function extractCodeHarness(text, writePyContents) {
  const fromText = extractCode(text);
  if (fromText) return fromText;
  if (writePyContents && writePyContents.length > 0) {
    return writePyContents[writePyContents.length - 1].trim();
  }
  return '';
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
// 超时模型 E=0（不跑测试）
function scoreE(testResult) {
  if (!testResult) return 0;
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
function formatOkRow(r) {
  const m = r.metrics;
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
  return r.model.padEnd(24) + `${E} ${T} ${C} ${total}  ${passRate}  ${failType} ${ttft} ${think} ${tokenRatio} ${tps} ${totalMs} ${tokens} ${cache} ${cost}`;
}

function formatNonOkRow(r, label) {
  const tail = r.detail?.stderrTail?.slice(0, 60) ?? '';
  return r.model.padEnd(24) + `(${label}: ${tail})`;
}

function formatRow(r) {
  if (r.status === 'ok') return formatOkRow(r);
  if (r.status === 'timeout') return formatNonOkRow(r, '超时');
  return formatNonOkRow(r, '错误');
}

function printSummary(question, records) {
  const header = `模型${' '.repeat(22)}E分  T分  C分  总分  通过率   失败 TTFT 思考ms token比 吞吐 总ms  token  缓存 命率 成本`;
  console.log('\n' + '='.repeat(header.length));
  console.log(`P1.1 评测汇总（题: ${question.questionId} ${question.difficulty} ${question.platform}）[${records[0]?._harness ?? 'bare'}]`);
  console.log('E=效果分 T=速度分 C=成本分 总分=E×(0.6+0.3×T/100+0.1×C/100) | TTFT=首token(ms) 思考=思考时间(ms) token比=思考/总 吞吐=tok/s 总ms=总耗时 缓存=缓存命中 成本=元');
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of records) console.log(formatRow(r));
}

// ───────────────────────── 记录序列化（SSOT）─────────────────────────
// 单一真相源：record → JSON 字符串。appendRecord/updateQuestionRecords 共用
function serializeRecord(question, r) {
  return JSON.stringify({
    questionId: question.questionId,
    questionTitle: question.questionTitle,
    difficulty: question.difficulty,
    platform: question.platform,
    harness: r._harness,
    model: r.model,
    status: r.status,
    metrics: r.metrics,
    testResult: r.testResult ?? null,
    scores: r.scores ?? null,
    baseline: r.baseline ?? null,
    detail: r.detail,
  });
}

// 追加一条记录到 JSONL（逐个记录架构：每个模型完成立即 append）
function appendRecord(resultsPath, question, r) {
  writeFileSync(resultsPath, serializeRecord(question, r) + '\n', { flag: 'a' });
}

// 更新 JSONL 中某题的记录：过滤掉该题旧记录，append 完整版（T/C/总分/baseline 已算完）
// 多题串行下不清空整个文件，只替换当前题的行
function updateQuestionRecords(resultsPath, question, records) {
  let kept = [];
  if (existsSync(resultsPath)) {
    const content = readFileSync(resultsPath, 'utf8');
    kept = content.split('\n').filter((l) => l.trim()).filter((line) => {
      try { return JSON.parse(line).questionId !== question.questionId; }
      catch { return true; }
    });
  }
  for (const r of records) kept.push(serializeRecord(question, r));
  writeFileSync(resultsPath, kept.length ? kept.join('\n') + '\n' : '');
}

// ───────────────────────── 单题评测（题内全流程）─────────────────────────
// 复用现有 pi 驱动/采集/提取/测试/评分逻辑（SSOT，不复制）
// 返回该题所有模型的 records（含 T/C/总分/baseline）
async function runOneQuestion(question, timeoutSec, models, harness, resultsPath) {
  console.log(`\n=== 题: ${question.questionId}（${question.difficulty} ${question.platform}）${question.questionTitle} | 超时 ${timeoutSec}s ===`);

  // 合并测试用例
  let testCases = [...question.publicTestCases];
  try {
    const privateTc = decodePrivateTestCases(question.privateTestCasesRaw);
    testCases = testCases.concat(privateTc);
  } catch (err) {
    console.error(`private_test_cases 解码失败: ${err.message}`);
  }
  console.log(`测试用例: ${testCases.length} 个（public ${question.publicTestCases.length} + private ${testCases.length - question.publicTestCases.length}）`);

  const prompt = buildPrompt(question);
  console.log(`并行评测 ${models.length} 个模型 ...`);

  // 逐个记录架构：每个模型完成立即 append（E 有值，T/C/total 待评分后补充）
  const records = await Promise.all(models.map((m) => (async () => {
    const raw = await runPiModel(m.id, prompt, { harness, timeout: timeoutSec });

    // 超时/错误：直接写记录，不跑测试
    if (raw.status === 'timeout' || raw.status === 'error') {
      const record = {
        model: raw.model,
        status: raw.status,
        _harness: harness,
        code: '',
        testResult: raw.status === 'timeout' ? { failType: 'timeout', passRate: 0, passCount: 0, total: testCases.length, results: [] } : null,
        scores: { E: 0, T: null, C: null, total: 0 },
        baseline: null,
        metrics: null,
        detail: raw.detail,
      };
      appendRecord(resultsPath, question, record);
      console.log(`  [完成] ${raw.model} → ${raw.status}`);
      return record;
    }

    // 成功：提取代码 → 测试 → 算 E
    const code = harness === 'harness'
      ? extractCodeHarness(raw.code, raw.writePyContents)
      : extractCode(raw.code);
    const testResult = runAllTests(code, testCases);
    const E = scoreE(testResult);

    const record = {
      model: raw.model,
      status: 'ok',
      _harness: harness,
      code,
      testResult,
      scores: { E: Number(E.toFixed(2)), T: null, C: null, total: null },
      baseline: null,
      metrics: raw.metrics,
      detail: raw.detail,
    };
    appendRecord(resultsPath, question, record);
    console.log(`  [完成] ${raw.model} → ok | E=${E.toFixed(0)} 通过率=${(testResult.passRate * 100).toFixed(0)}%`);
    return record;
  })()));

  // 评分（题内基线：参测模型中位数）：T/C 需要所有模型完成才能算
  const validRecords = records.filter((r) => r.status === 'ok' && r.metrics);
  const medianMs = median(validRecords.map((r) => r.metrics.totalMs));
  const medianCost = median(validRecords.map((r) => r.metrics.cost));

  for (const r of records) {
    if (r.status !== 'ok') continue;
    const T = scoreT(r.metrics.totalMs, medianMs);
    const C = scoreC(r.metrics.cost, medianCost);
    const total = r.scores.E * (0.6 + 0.3 * T / 100 + 0.1 * C / 100);
    r.scores.T = Number(T.toFixed(2));
    r.scores.C = Number(C.toFixed(2));
    r.scores.total = Number(total.toFixed(2));
    r.baseline = { medianMs, medianCost };
  }

  // 更新 JSONL 中该题的记录（补充 T/C/总分/baseline，不影响其他题）
  updateQuestionRecords(resultsPath, question, records);

  // 每题汇总表
  printSummary(question, records);

  const ok = records.filter((r) => r.status === 'ok').length;
  const timeout = records.filter((r) => r.status === 'timeout').length;
  const err = records.filter((r) => r.status === 'error').length;
  console.log(`本题完成: ${ok} 成功, ${timeout} 超时, ${err} 错误, 共 ${records.length}`);
  return records;
}

// ───────────────────────── 多题总汇总表 ─────────────────────────
// 每模型多题总分平均 → 排名 + 分难度明细（每难度各题总分单列 + 该难度平均）
function printOverallSummary(questions, allResults) {
  // 每模型每题的总分（ok 取 scores.total，非 ok 取 0）
  const modelTotals = {}; // { model: [{ questionId, difficulty, total }] }
  for (const qr of allResults) {
    for (const r of qr.records) {
      if (!modelTotals[r.model]) modelTotals[r.model] = [];
      const total = r.status === 'ok' && r.scores?.total != null ? r.scores.total : 0;
      modelTotals[r.model].push({ questionId: qr.question.questionId, difficulty: qr.question.difficulty, total });
    }
  }

  const avgOf = (entries) => entries.length > 0 ? entries.reduce((s, e) => s + e.total, 0) / entries.length : 0;
  const modelIds = Object.keys(modelTotals);
  const modelAvg = {};
  for (const m of modelIds) modelAvg[m] = avgOf(modelTotals[m]);

  // 按平均总分降序
  const ranked = [...modelIds].sort((a, b) => modelAvg[b] - modelAvg[a]);

  // 难度列表（按题序出现顺序去重）
  const difficulties = [...new Set(questions.map((q) => q.difficulty))];

  const colW = 10;
  const modelCol = 24;

  // 表头
  let header = '模型'.padEnd(modelCol) + '平均'.padStart(colW);
  for (const q of questions) {
    const tag = q.questionId.slice(-6) + '(' + q.difficulty[0].toUpperCase() + ')';
    header += tag.padStart(colW);
  }
  for (const d of difficulties) {
    header += (d + '均').padStart(colW);
  }

  const bar = '='.repeat(header.length);
  console.log('\n' + bar);
  console.log('P1.1 总汇总（多题平均 + 分难度明细）');
  console.log('总分=E×(0.6+0.3×T/100+0.1×C/100) | 非ok 记录按 0 分计入平均 | 平均=各题总分算术平均');
  console.log(bar);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const model of ranked) {
    let row = model.padEnd(modelCol) + modelAvg[model].toFixed(1).padStart(colW);
    for (const q of questions) {
      const e = modelTotals[model].find((x) => x.questionId === q.questionId);
      row += (e ? e.total.toFixed(0) : '-').padStart(colW);
    }
    for (const d of difficulties) {
      const dEntries = modelTotals[model].filter((x) => x.difficulty === d);
      row += avgOf(dEntries).toFixed(1).padStart(colW);
    }
    console.log(row);
  }
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  const opts = parseArgs();
  const harness = opts.harness === 'harness' ? 'harness' : 'bare';
  const models = selectModels(opts.model);
  if (models.length === 0) {
    console.error(`模型 ${opts.model} 不存在于 models.json`);
    process.exit(1);
  }

  // 抽题（支持多题：标准模式 medium+hard / 自定义难度+count / 单题）
  const items = pickQuestions(opts, harness);
  const questions = items.map((it) => it.question);
  console.log(`抽题 ${questions.length} 道: ${questions.map((q) => `${q.questionId}(${q.difficulty})`).join(' ')}`);
  console.log(`模式: ${harness}${opts.mode ? ' | 标准模式' : ''} | 超时: ${items.map((it) => it.timeoutSec + 's').join('/')}`);

  // 建空 JSONL 文件（逐个记录架构：每个模型完成立即 append）
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(RESULTS_DIR, `eval-${ts}.jsonl`);
  writeFileSync(resultsPath, '');

  // 题间串行，每题内 Promise.all 6模型并行
  const allResults = [];
  for (let i = 0; i < items.length; i++) {
    const { question, timeoutSec } = items[i];
    console.log(`\n[${i + 1}/${items.length}] 开始评测`);
    const records = await runOneQuestion(question, timeoutSec, models, harness, resultsPath);
    allResults.push({ question, records });
  }

  // 多题总汇总（>1 题时打印）
  if (questions.length > 1) {
    printOverallSummary(questions, allResults);
  }

  console.log(`\nJSONL 结果已写入: ${resultsPath}`);
}


main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
