// P1.1 模型智能体评测框架（RPC 多轮对话 + adapter 多数据集 + 二维/单维评分）
// 输入：agentProfile × model 矩阵 → adapter 抽题 → 题间串行，每题内矩阵并行
// → 框架扮演对话方：发题→agent 出码→adapter 跑测试→未全通过反馈→agent 修正（最多 maxTurns 轮）
// → 评分：E（效果，口径在 adapter）× turnFactor + T(速度) + C(成本) + 总分
// 启动：
//   node probe/eval.mjs --mode standard [--dataset humanevalplus|bigcodebench] [--profile <name>] [--model <pattern>] [--timeout <秒>]
//   node probe/eval.mjs --question-id <id> [--dataset <name>] [...]
// 数据集差异封装在 datasets/<name>/adapter.mjs，主流程不感知数据集

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const RESULTS_DIR = join(__dirname, 'results');
const CONFIG_PATH = join(__dirname, 'eval.config.json');
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const FAIL_TYPE = { PASS: '通过', CE: '编译错误', RE: '运行异常', WA: '答案错误', TLE: '超时', TIMEOUT: '超时' };

// ───────────────────────── CLI ─────────────────────────
const CLI_FLAGS = [
  { flag: '--dataset', key: 'dataset', type: 'string', default: 'humanevalplus' },
  { flag: '--mode', key: 'mode', type: 'string', default: null },
  { flag: '--question-id', key: 'questionId', type: 'string', default: null },
  { flag: '--profile', key: 'profile', type: 'string', default: null },
  { flag: '--model', key: 'model', type: 'string', default: null },
  { flag: '--timeout', key: 'timeout', type: 'int', default: null },
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

// 加载 adapter（差异封装）：动态 import，路径校验防任意路径
async function loadAdapter(name) {
  const allowed = ['humanevalplus', 'bigcodebench'];
  if (!allowed.includes(name)) throw new Error(`未知 dataset: ${name}（应为 ${allowed.join('/')}`);
  const mod = await import(`./datasets/${name}/adapter.mjs`);
  return mod.default(CONFIG);
}

// ───────────────────────── 被测矩阵 ─────────────────────────
function selectProfiles(filter) {
  const all = Object.keys(CONFIG.agentProfiles);
  if (!filter) return all;
  const names = filter.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!all.includes(n)) throw new Error(`未知 profile: ${n}（应为 ${all.join('/')}）`);
  return names;
}

function selectModels(filter) {
  const all = CONFIG.models;
  if (!filter) return all;
  const patterns = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return all.filter((m) => patterns.some((p) => m.includes(p)));
}

// ───────────────────────── 抽题（adapter 驱动）─────────────────────────
function sampleQuestions(rows, n, adapter) {
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n).map((row) => adapter.normalize(row));
}

function pickQuestions(adapter, opts) {
  const all = adapter.load();
  const totalTimeout = opts.timeout ?? CONFIG.timeouts.total;
  if (opts.questionId) {
    const row = all.find((q) => q[adapter.questionIdKey ?? 'task_id'] === opts.questionId);
    if (!row) throw new Error(`题号 ${opts.questionId} 不存在`);
    return [{ question: adapter.normalize(row), timeoutSec: totalTimeout }];
  }
  const count = opts.mode === 'standard' ? CONFIG.standardCount : 1;
  if (count > CONFIG.maxQuestions) throw new Error(`抽题数 ${count} 超过上限 ${CONFIG.maxQuestions}`);
  return sampleQuestions(all, count, adapter).map((q) => ({ question: q, timeoutSec: totalTimeout }));
}

// ───────────────────────── 代码提取（共享）─────────────────────────
function extractCode(text) {
  if (!text) return '';
  const re = /```python\n([\s\S]*?)```/g;
  let last = '';
  let m;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last.trim();
}

function extractCodeFromWrite(writePyContents) {
  if (writePyContents && writePyContents.length > 0) return writePyContents[writePyContents.length - 1].trim();
  return '';
}

// ───────────────────────── 轮次衰减（共享）─────────────────────────
function turnFactor(evalTurn, maxTurns) {
  if (!evalTurn || maxTurns <= 0) return 1;
  return (maxTurns - evalTurn + 1) / maxTurns;
}

// ───────────────────────── 采集器（共享）─────────────────────────
function createCollector() {
  return {
    t0: null, ttftMs: null, agentStartAt: null, agentEndAt: null,
    accInput: 0, accOutput: 0, accReasoning: 0, accTotalTokens: 0, accCacheRead: 0, accCost: 0,
    totalThinkMs: 0, totalGenMs: 0,
    thinkingStartAt: null, genStartAt: null, textEndAt: null,
    evalTurn: 0, turnFinalText: '', writePyContents: [], stderrTail: '',
  };
}

function resetEvalTurn(c) {
  c.turnFinalText = ''; c.writePyContents = [];
  c.thinkingStartAt = null; c.genStartAt = null; c.textEndAt = null;
}

function collectWritePy(c, tc) {
  if (tc.name !== 'write' || !tc.arguments) return;
  if ((tc.arguments.path || '').endsWith('.py')) c.writePyContents.push(tc.arguments.content || '');
}

function handleAgentStart(c, now) { if (c.agentStartAt === null) c.agentStartAt = now; }

function handleMessageUpdate(c, event, now, t0) {
  if (c.ttftMs === null) c.ttftMs = now - t0;
  if (c.genStartAt === null) c.genStartAt = now;
  const ame = event.assistantMessageEvent;
  if (!ame) return;
  switch (ame.type) {
    case 'thinking_start': c.thinkingStartAt = now; break;
    case 'thinking_end':
      if (c.thinkingStartAt !== null) { c.totalThinkMs += now - c.thinkingStartAt; c.thinkingStartAt = null; }
      break;
    case 'text_end': c.textEndAt = now; break;
    case 'toolcall_end': if (ame.toolCall) collectWritePy(c, ame.toolCall); break;
  }
}

function handleMessageEnd(c, event) {
  const msg = event.message;
  if (!msg || msg.role !== 'assistant') return;
  const u = msg.usage;
  if (u) {
    c.accInput += u.input ?? 0; c.accOutput += u.output ?? 0; c.accReasoning += u.reasoning ?? 0;
    c.accTotalTokens += u.totalTokens ?? 0; c.accCacheRead += u.cacheRead ?? 0; c.accCost += u.cost?.total ?? 0;
  }
  const texts = (msg.content ?? []).filter((i) => i?.type === 'text').map((i) => i.text);
  if (texts.length > 0) c.turnFinalText = texts.join('');
  for (const item of msg.content ?? []) if (item?.type === 'toolCall') collectWritePy(c, item);
}

function handleTurnEnd(c) {
  if (c.genStartAt !== null && c.textEndAt !== null) c.totalGenMs += c.textEndAt - c.genStartAt;
  c.thinkingStartAt = null; c.genStartAt = null; c.textEndAt = null;
}

function dispatchEvent(c, event, t0) {
  const now = performance.now();
  const type = event.type;
  if (type === 'agent_start') handleAgentStart(c, now);
  else if (type === 'agent_end') c.agentEndAt = now;
  else if (type === 'message_update') handleMessageUpdate(c, event, now, t0);
  else if (type === 'message_end') handleMessageEnd(c, event);
  else if (type === 'turn_end') handleTurnEnd(c);
}

function computeMetrics(c) {
  const totalMs = (c.agentStartAt && c.agentEndAt) ? c.agentEndAt - c.agentStartAt : null;
  const tokenRatio = c.accTotalTokens > 0 ? c.accReasoning / c.accTotalTokens : 0;
  const tps = c.totalGenMs > 0 ? c.accOutput / (c.totalGenMs / 1000) : 0;
  const cacheHitRate = (c.accInput + c.accCacheRead) > 0 ? c.accCacheRead / (c.accInput + c.accCacheRead) : 0;
  return {
    ttftMs: c.ttftMs !== null ? Math.round(c.ttftMs) : null,
    thinkMs: Math.round(c.totalThinkMs),
    tokenRatio: Number(tokenRatio.toFixed(4)),
    tps: Number(tps.toFixed(1)),
    totalMs: totalMs !== null ? Math.round(totalMs) : null,
    totalTokens: c.accTotalTokens,
    cacheHitRate: Number(cacheHitRate.toFixed(4)),
    cost: c.accCost,
  };
}

// ───────────────────────── 速度/成本评分（共享）─────────────────────────
function clip(x, min, max) { return Math.max(min, Math.min(max, x)); }

function scoreT(modelMs, medianMs) {
  if (modelMs === null || modelMs <= 0 || medianMs <= 0) return null;
  return clip(medianMs / modelMs * CONFIG.scoring.speedFactor, 0, 100);
}

function scoreC(modelCost, medianCost) {
  if (modelCost <= 0 || medianCost <= 0) return null;
  return clip(medianCost / modelCost * CONFIG.scoring.costFactor, 0, 100);
}

function median(arr) {
  const sorted = [...arr].filter((v) => v !== null && v !== undefined && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 并发上限：控制题内并行单元数，防 API 限频/资源抢占
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ───────────────────────── pi 驱动（adapter 注入差异）─────────────────────────
function buildPiArgs(profile, modelId, thinking) {
  const args = ['--mode', 'rpc', '--no-session', '--model', modelId, '--thinking', thinking];
  if (profile.noExtensions) args.push('--no-extensions');
  if (profile.noSkills) args.push('--no-skills');
  if (profile.noContextFiles) args.push('--no-context-files');
  if (profile.extensions) for (const e of profile.extensions) args.push('-e', e);
  if (profile.skills) for (const s of profile.skills) args.push('--skill', s);
  if (profile.systemPrompt) args.push('--system-prompt', profile.systemPrompt);
  if (profile.appendSystemPrompt) {
    const path = profile.appendSystemPrompt;
    if (existsSync(path)) args.push('--append-system-prompt', readFileSync(path, 'utf8'));
    else console.warn(`appendSystemPrompt 文件不存在，跳过: ${path}`);
  }
  if (profile.tools) args.push('--tools', profile.tools.join(','));
  if (profile.excludeTools) args.push('--exclude-tools', profile.excludeTools.join(','));
  if (profile.approve) args.push('-a');
  return args;
}

function runPiAgent(adapter, profile, profileName, modelId, question, opts) {
  return new Promise((resolve) => {
    const args = buildPiArgs(profile, modelId, opts.thinking);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PI_SESSION')));
    const proc = spawn('pi', args, { cwd: PROJECT_ROOT, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    const c = createCollector();
    let buffer = '';
    let settledResolver = null;
    let timedOut = false;
    let totalTimer = null;
    let perTurnTimer = null;
    let done = false;
    let evalTurn = 0;
    let lastCode = '';
    let lastTestResult = null;
    let retryReason = null;
    let t0 = 0;

    const finish = (status) => {
      if (done) return;
      done = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (perTurnTimer) clearTimeout(perTurnTimer);
      try { proc.kill('SIGTERM'); } catch {}
      resolve(buildAgentResult(adapter, status, c, modelId, profileName, lastCode, lastTestResult, retryReason, timedOut, t0, evalTurn));
    };

    if (opts.totalTimeout > 0) {
      totalTimer = setTimeout(() => { timedOut = true; finish('timeout'); }, opts.totalTimeout * 1000);
    }

    const setPerTurnTimer = () => {
      if (perTurnTimer) clearTimeout(perTurnTimer);
      if (opts.perTurnTimeout > 0) {
        perTurnTimer = setTimeout(() => { retryReason = 'per_turn_timeout'; finish('timeout'); }, opts.perTurnTimeout * 1000);
      }
    };

    const waitForSettled = () => new Promise((r) => { settledResolver = r; });
    const sendPrompt = (msg) => { proc.stdin.write(JSON.stringify({ type: 'prompt', message: msg }) + '\n'); };

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'response') continue;
        dispatchEvent(c, event, c.t0);
        if (event.type === 'agent_settled' && settledResolver) {
          const r = settledResolver;
          settledResolver = null;
          r();
        }
      }
    });

    proc.stderr.on('data', (d) => { c.stderrTail = (c.stderrTail + d.toString()).slice(-4000); });
    proc.on('close', (code) => {
      if (settledResolver) { const r = settledResolver; settledResolver = null; r(); }
      if (!done) { retryReason = `pi 进程退出 code=${code}`; finish('error'); }
    });
    proc.on('error', (err) => { if (!done) { retryReason = String(err).slice(0, 200); finish('error'); } });

    (async () => {
      t0 = performance.now();
      c.t0 = t0;

      evalTurn = 1;
      resetEvalTurn(c);
      setPerTurnTimer();
      sendPrompt(adapter.buildPrompt(question));
      await waitForSettled();
      if (done) return;
      if (perTurnTimer) clearTimeout(perTurnTimer);

      lastCode = extractCode(c.turnFinalText) || extractCodeFromWrite(c.writePyContents);
      if (!lastCode) { retryReason = 'empty_code'; finish('ok'); return; }
      lastTestResult = adapter.runTests(lastCode, question);
      if (lastTestResult.allPass) { finish('ok'); return; }

      while (evalTurn < opts.maxTurns) {
        evalTurn++;
        resetEvalTurn(c);
        setPerTurnTimer();
        sendPrompt(adapter.buildFeedback(lastTestResult, question, opts.feedbackSampleCount));
        await waitForSettled();
        if (done) return;
        if (perTurnTimer) clearTimeout(perTurnTimer);

        const code = extractCode(c.turnFinalText) || extractCodeFromWrite(c.writePyContents);
        if (!code) { retryReason = 'empty_code'; break; }
        lastCode = code;
        lastTestResult = adapter.runTests(lastCode, question);
        if (lastTestResult.allPass) break;
      }

      finish('ok');
    })().catch((e) => { if (!done) { retryReason = String(e).slice(0, 200); finish('error'); } });
  });
}

// 构建返回结果：adapter 算口径 E₁/E₂/rawE，主层乘 turnFactor 得 E
function buildAgentResult(adapter, status, c, modelId, profileName, code, testResult, retryReason, timedOut, t0, evalTurn) {
  const makeFail = (ft) => ({ base: { passed: false, score: 0, failType: ft, stderr: '' }, plus: null, allPass: false });
  if (status === 'timeout') {
    return { status: 'timeout', model: modelId, profile: profileName, code: '', testResult: makeFail('TIMEOUT'), scores: { E1: 0, E2: null, E: 0, T: null, C: null, total: 0 }, metrics: null, detail: { evalTurn, retryReason, stderrTail: c.stderrTail.slice(-500) } };
  }
  if (status === 'error') {
    return { status: 'error', model: modelId, profile: profileName, code: '', testResult: makeFail('RE'), scores: { E1: 0, E2: null, E: 0, T: null, C: null, total: 0 }, metrics: null, detail: { evalTurn, retryReason, stderrTail: c.stderrTail.slice(-500) } };
  }
  const tr = testResult ?? makeFail('CE');
  const scored = adapter.scoreE(tr);
  const factor = CONFIG.scoring.turnDecay ? turnFactor(evalTurn, CONFIG.maxTurns) : 1;
  const E = scored.rawE * factor;
  return {
    status: 'ok', model: modelId, profile: profileName, code,
    testResult: tr,
    scores: { E1: scored.E1, E2: scored.E2, E: Number(E.toFixed(2)), T: null, C: null, total: null },
    metrics: computeMetrics(c),
    detail: { evalTurn, retryReason, stderrTail: c.stderrTail.slice(-500) },
  };
}

// ───────────────────────── 记录（共享）─────────────────────────
function serializeRecord(question, r, batchId, partial) {
  return JSON.stringify({
    batchId, questionId: question.questionId, dataset: question.dataset, entryPoint: question.entryPoint,
    profile: r.profile, model: r.model, status: r.status, metrics: r.metrics,
    testResult: r.testResult ?? null, scores: r.scores ?? null, baseline: r.baseline ?? null,
    detail: r.detail, partial,
  });
}

function appendRecord(resultsPath, question, r, batchId) {
  writeFileSync(resultsPath, serializeRecord(question, r, batchId, true) + '\n', { flag: 'a' });
}

function updateQuestionRecords(resultsPath, question, records, batchId) {
  let kept = [];
  if (existsSync(resultsPath)) {
    const content = readFileSync(resultsPath, 'utf8');
    kept = content.split('\n').filter((l) => l.trim()).filter((line) => {
      try {
        const obj = JSON.parse(line);
        return !(obj.batchId === batchId && obj.questionId === question.questionId);
      } catch { return true; }
    });
  }
  for (const r of records) kept.push(serializeRecord(question, r, batchId, false));
  writeFileSync(resultsPath, kept.length ? kept.join('\n') + '\n' : '');
}

// ───────────────────────── 单题评测 ──────────────────────────
async function runOneQuestion(adapter, question, timeoutSec, profiles, models, resultsPath, batchId) {
  console.log(`\n=== 题: ${question.questionId}（entry: ${question.entryPoint}）[${adapter.name}] | 超时 ${timeoutSec}s | 矩阵 ${profiles.length}×${models.length} ===`);

  const pairs = [];
  for (const pn of profiles) for (const m of models) pairs.push({ profileName: pn, modelId: m });

  const records = await runWithConcurrency(pairs, CONFIG.concurrency ?? pairs.length, async ({ profileName, modelId }) => {
    const profile = CONFIG.agentProfiles[profileName];
    const raw = await runPiAgent(adapter, profile, profileName, modelId, question, {
      thinking: CONFIG.thinking, maxTurns: CONFIG.maxTurns, feedbackSampleCount: CONFIG.feedbackSampleCount,
      totalTimeout: timeoutSec, perTurnTimeout: CONFIG.timeouts.perTurn,
    });
    appendRecord(resultsPath, question, raw, batchId);
    const tr = raw.testResult;
    const baseS = tr.base.passed ? '通过' : (FAIL_TYPE[tr.base.failType] ?? tr.base.failType);
    const plusS = tr.plus ? (tr.plus.passed ? '通过' : (FAIL_TYPE[tr.plus.failType] ?? tr.plus.failType)) : '-';
    console.log(`  [完成] ${profileName}/${modelId} → ${raw.status} | E₁=${tr.base.score.toFixed(0)} E₂=${tr.plus ? tr.plus.score.toFixed(0) : '-'} 轮=${raw.detail.evalTurn}${raw.detail.retryReason ? ' [' + raw.detail.retryReason + ']' : ''}`);
    return raw;
  });

  // T/C 基线：参测 ok 记录中位数；单单元置 null
  const validRecords = records.filter((r) => r.status === 'ok' && r.metrics);
  const medianMs = median(validRecords.map((r) => r.metrics.totalMs));
  const medianCost = median(validRecords.map((r) => r.metrics.cost));
  const single = validRecords.length <= 1;

  for (const r of records) {
    if (r.status !== 'ok' || !r.metrics) continue;
    const T = single ? null : scoreT(r.metrics.totalMs, medianMs);
    const C = single ? null : scoreC(r.metrics.cost, medianCost);
    const { effect, speed, cost } = CONFIG.scoring.weights;
    const TTerm = T !== null ? speed * T / 100 : 0;
    const CTerm = C !== null ? cost * C / 100 : 0;
    r.scores.T = T === null ? null : Number(T.toFixed(2));
    r.scores.C = C === null ? null : Number(C.toFixed(2));
    r.scores.total = Number((r.scores.E * (effect + TTerm + CTerm)).toFixed(2));
    r.baseline = single ? null : { medianMs, medianCost };
  }

  updateQuestionRecords(resultsPath, question, records, batchId);
  printSummary(adapter, question, records);

  const ok = records.filter((r) => r.status === 'ok').length;
  const timeout = records.filter((r) => r.status === 'timeout').length;
  const err = records.filter((r) => r.status === 'error').length;
  console.log(`本题完成: ${ok} 成功, ${timeout} 超时, ${err} 错误, 共 ${records.length}`);
  return records;
}

// ───────────────────────── 汇总（adapter 口口径标注）─────────────────────────
function formatOkRow(r) {
  const m = r.metrics ?? {};
  const E1 = r.scores.E1 ?? '-';
  const E2 = r.scores.E2 === null ? '-' : r.scores.E2.toFixed(0);
  const total = r.scores.total ?? '-';
  const T = r.scores.T === null ? '-' : r.scores.T.toFixed(0);
  const C = r.scores.C === null ? '-' : r.scores.C.toFixed(0);
  const baseS = r.testResult.base.passed ? '通过' : (FAIL_TYPE[r.testResult.base.failType] ?? r.testResult.base.failType);
  const plusS = r.testResult.plus ? (r.testResult.plus.passed ? '通过' : (FAIL_TYPE[r.testResult.plus.failType] ?? r.testResult.plus.failType)) : '-';
  const turns = r.detail?.evalTurn ?? '-';
  const totalMs = m.totalMs ?? '-';
  const cost = m.cost != null ? m.cost.toFixed(3) : '-';
  return `${r.profile}/${r.model}`.padEnd(44) + `${total}(${E1},${E2})`.padEnd(14) + `B:${baseS} P:${plusS}`.padEnd(18) + `${turns}轮`.padStart(6) + `${totalMs}ms`.padStart(10) + `${cost}`.padStart(9) + `${T}`.padStart(6) + `${C}`.padStart(6);
}

function formatNonOkRow(r) {
  const tail = r.detail?.stderrTail?.slice(0, 40) ?? '';
  return `${r.profile}/${r.model}`.padEnd(44) + `(${r.status}: ${tail})`;
}

function formatRow(r) { return r.status === 'ok' ? formatOkRow(r) : formatNonOkRow(r); }

function printSummary(adapter, question, records) {
  const header = 'profile/model' + ' '.repeat(32) + '总分(E1,E2)   base/plus        轮数    总耗时    成本     T    C';
  console.log('\n' + '='.repeat(header.length));
  console.log(`P1.1 评测汇总（题: ${question.questionId} entry: ${question.entryPoint} [${adapter.name}]）`);
  const { effect, speed, cost } = CONFIG.scoring.weights;
  console.log(`总分=E×(${effect}+${speed}×T/100+${cost}×C/100) | E×turnFactor（轮次衰减） | ${adapter.summaryLabel()} | 单模型参测时 T/C=null`);
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of records) console.log(formatRow(r));
}

function printOverallSummary(adapter, questions, allResults) {
  const keyTotals = {};
  for (const qr of allResults) {
    for (const r of qr.records) {
      const k = `${r.profile}/${r.model}`;
      if (!keyTotals[k]) keyTotals[k] = [];
      const total = r.status === 'ok' && r.scores?.total != null ? r.scores.total : 0;
      const E1 = r.status === 'ok' ? (r.scores.E1 ?? 0) : 0;
      const E2 = r.status === 'ok' ? (r.scores.E2 ?? 0) : 0;
      keyTotals[k].push({ questionId: qr.question.questionId, total, E1, E2 });
    }
  }
  const avgOf = (entries, field) => entries.length > 0 ? entries.reduce((s, e) => s + e[field], 0) / entries.length : 0;
  const keys = Object.keys(keyTotals);
  const keyAvg = {};
  for (const k of keys) keyAvg[k] = avgOf(keyTotals[k], 'total');
  const ranked = [...keys].sort((a, b) => keyAvg[b] - keyAvg[a]);

  const colW = 12;
  const labelCol = 44;
  let header = 'profile/model'.padEnd(labelCol) + '平均'.padStart(colW) + 'E₁均'.padStart(colW) + 'E₂均'.padStart(colW);
  for (const q of questions) header += q.questionId.slice(-4).padStart(colW);

  const bar = '='.repeat(header.length);
  console.log('\n' + bar);
  console.log(`P1.1 总汇总（多题平均 [${adapter.name}]）`);
  const { effect, speed, cost } = CONFIG.scoring.weights;
  console.log(`总分=E×(${effect}+${speed}×T/100+${cost}×C/100) | E×turnFactor | 非ok 记录按 0 计入平均 | ${adapter.summaryLabel()}`);
  console.log(bar);
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const k of ranked) {
    let row = k.padEnd(labelCol) + keyAvg[k].toFixed(1).padStart(colW) + avgOf(keyTotals[k], 'E1').toFixed(0).padStart(colW) + avgOf(keyTotals[k], 'E2').toFixed(0).padStart(colW);
    for (const q of questions) {
      const e = keyTotals[k].find((x) => x.questionId === q.questionId);
      row += (e ? e.total.toFixed(0) : '-').padStart(colW);
    }
    console.log(row);
  }
  console.log(`\nE₁均/E₂均 口口径见 ${adapter.name} adapter | 平均=各题总分算术平均`);
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  const opts = parseArgs();
  const adapter = await loadAdapter(opts.dataset);
  const profiles = selectProfiles(opts.profile);
  const models = selectModels(opts.model);
  if (profiles.length === 0) { console.error('无 profile'); process.exit(1); }
  if (models.length === 0) { console.error(`模型 ${opts.model} 不存在于 config.models`); process.exit(1); }

  const items = pickQuestions(adapter, opts);
  const questions = items.map((it) => it.question);
  console.log(`数据集: ${adapter.name} | 抽题 ${questions.length} 道: ${questions.map((q) => q.questionId).join(' ')}`);
  console.log(`矩阵: ${profiles.length} profile × ${models.length} model = ${profiles.length * models.length} 单元/题`);
  console.log(`思考: ${CONFIG.thinking} | 最大轮数: ${CONFIG.maxTurns} | 并发: ${CONFIG.concurrency} | 反馈样例: ${CONFIG.feedbackSampleCount}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const batchId = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(RESULTS_DIR, 'results.jsonl');

  const allResults = [];
  for (let i = 0; i < items.length; i++) {
    const { question, timeoutSec } = items[i];
    console.log(`\n[${i + 1}/${items.length}] 开始评测`);
    const records = await runOneQuestion(adapter, question, timeoutSec, profiles, models, resultsPath, batchId);
    allResults.push({ question, records });
  }

  if (questions.length > 1) printOverallSummary(adapter, questions, allResults);
  console.log(`\nJSONL 结果已写入: ${resultsPath}`);
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
