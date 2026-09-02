// 模型性能探针：从 HumanEval 随机抽 1 道低难度编程题 → 5 模型并行流式请求 → 输出 5 个性能指标。
// 形态：独立脚本，Node.js 原生 fetch + stream:true，不引入框架依赖。
// 启动：node probe/probe.mjs   （或 npm run probe）

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// 读模型清单（单一真相源：models.json）
const modelsJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'models.json'), 'utf8'));
const MODELS = modelsJson.providers.dashscope.models.map((m) => m.id);

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DATASET_DIR = join(__dirname, 'datasets', 'humaneval');
const DATASET_PATH = join(DATASET_DIR, 'humaneval.jsonl');
const RESULTS_DIR = join(__dirname, 'results');

// ───────────────────────── 数据集 ─────────────────────────
// 从 HuggingFace datasets-server 拉取 openai/openai_humaneval 全部 164 行，转 JSONL 存本地。
// 仅在本地缺失时下载，保证脱网可重复运行。
const HF_ROWS_API = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'openai/openai_humaneval';
const CONFIG = 'openai_humaneval';
const SPLIT = 'test';
const TOTAL = 164; // HumanEval 共 164 题
const PAGE = 100; // datasets-server 单次最多 100 行

async function fetchHumanEval() {
  mkdirSync(DATASET_DIR, { recursive: true });
  const rows = [];
  for (let off = 0; off < TOTAL; off += PAGE) {
    const len = Math.min(PAGE, TOTAL - off);
    const url = `${HF_ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}&split=${SPLIT}&offset=${off}&length=${len}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 HumanEval 失败: HTTP ${res.status} @ offset ${off}`);
    const json = await res.json();
    for (const r of json.rows) rows.push(r.row);
  }
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(DATASET_PATH, lines);
  console.log(`HumanEval 数据集已下载: ${rows.length} 题 → ${DATASET_PATH}`);
  return rows;
}

function loadHumanEval() {
  if (!existsSync(DATASET_PATH)) return null;
  return readFileSync(DATASET_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// 从 HumanEval 随机抽 1 道，只取 prompt 字段（函数签名 + docstring）。
function pickQuestion() {
  const all = loadHumanEval();
  if (!all) return null;
  const idx = Math.floor(Math.random() * all.length);
  const row = all[idx];
  return {
    id: row.task_id,
    source: `HumanEval (${row.task_id})`,
    prompt: row.prompt,
    entryPoint: row.entry_point,
  };
}

// ───────────────────────── 请求构造 ─────────────────────────
// 按模型构造思考参数（思考开高，分路径）
function thinkingParams(modelId) {
  if (modelId === 'deepseek-v4-flash-0731' || modelId === 'deepseek-v4-pro-0813') {
    return { reasoning_effort: 'high' };
  }
  if (modelId === 'glm-5.2' || modelId === 'qwen3.8-max') {
    return { enable_thinking: true, thinking_budget: 32768 };
  }
  if (modelId === 'kimi-k3') {
    return { enable_thinking: true };
  }
  return {};
}

// 获取 API key（只读使用，不写入代码/配置/git；~/.zshenv 里，非交互 shell 用 zsh -c 起能拿到）
function getApiKey() {
  return execSync("zsh -c 'printf %s \"$DASHSCOPE_CODING_KEY\"'").toString();
}

// ───────────────────────── 单次流式调用 ─────────────────────────
// 拆分为 4 个独立函数 + 编排，降低 attempt 圈复杂度（原 32 → 目标 ≤5）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 发 HTTP 请求 + 状态码判断。成功返回 Response，失败抛带 retryable/status 标记的错误。
async function sendRequest(body, apiKey) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.retryable = true;
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.retryable = false;
    err.status = res.status;
    throw err;
  }
  return res;
}

// 2. SSE 解析器（async generator）：缓冲/切行/JSON parse 容错，产出 delta 事件流。
// 独立后可复用、可单测。
async function* parseSSEStream(reader) {
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      yield json;
    }
  }
}

// 3. 消费 delta 事件，累计时间戳与计数。返回采集结果。
// 每个 delta 事件在到达瞬间打时间戳。
async function collectMetrics(reader) {
  let firstChunkAt = null; // 首个任何 chunk（含思考）到达
  let firstReasonAt = null; // 首个思考 chunk
  let firstContentAt = null; // 首个可见 chunk
  let lastAt = null; // 末 chunk
  let reasonChars = 0;
  let contentChars = 0;
  let usage = null;
  let finishReason = null;

  for await (const json of parseSSEStream(reader)) {
    const now = performance.now();
    if (firstChunkAt === null) firstChunkAt = now;
    lastAt = now;
    const choice = json.choices?.[0];
    const delta = choice?.delta || {};
    if (delta.reasoning_content) {
      if (firstReasonAt === null) firstReasonAt = now;
      reasonChars += String(delta.reasoning_content).length;
    }
    if (delta.content) {
      if (firstContentAt === null) firstContentAt = now;
      contentChars += String(delta.content).length;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) usage = json.usage;
  }

  if (firstChunkAt === null) {
    throw new Error('流式响应无任何 chunk');
  }

  return {
    firstChunkAt,
    firstReasonAt,
    firstContentAt,
    lastAt,
    reasonChars,
    contentChars,
    usage,
    finishReason,
  };
}

// 4. 纯计算 5 指标，无 IO。
function computeMetrics(timings, t0, modelId, question) {
  const { firstChunkAt, firstReasonAt, firstContentAt, lastAt, reasonChars, contentChars, usage, finishReason } = timings;

  // 生成时长 = 首 chunk → 末 chunk（墙钟）
  const genDurationMs = lastAt - firstChunkAt;
  const totalMs = lastAt - t0;
  const ttftMs = firstChunkAt - t0;

  // 思考时间 = 首思考 chunk → 首可见 chunk；模型先思考后可见，此为正。
  // 若无思考或无可见，占比为 0。
  let thinkRatio = 0;
  if (firstReasonAt !== null && firstContentAt !== null && genDurationMs > 0) {
    const thinkMs = firstContentAt - firstReasonAt;
    thinkRatio = thinkMs > 0 ? thinkMs / genDurationMs : 0;
  }

  // token 用量：completion_tokens 含思考（reasoning_tokens 在其内）
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const tokenUsage = promptTokens + completionTokens;

  // TPS = 全部 token（思考+可见）÷ 生成时长。仅同模型内可比，跨模型不直接比较。
  const tps = genDurationMs > 0 ? completionTokens / (genDurationMs / 1000) : 0;

  return {
    status: 'ok',
    model: modelId,
    questionId: question.id,
    questionSource: question.source,
    metrics: {
      ttftMs: Math.round(ttftMs),
      tps: Number(tps.toFixed(1)),
      totalMs: Math.round(totalMs),
      tokenUsage,
      thinkRatio: Number(thinkRatio.toFixed(3)),
    },
    detail: {
      promptTokens,
      completionTokens,
      reasoningTokens,
      visibleTokens: completionTokens - reasoningTokens,
      finishReason,
      reasonChars,
      contentChars,
      genDurationMs: Math.round(genDurationMs),
    },
  };
}

// 编排：sendRequest → collectMetrics → computeMetrics。
const attempt = async (body, apiKey, modelId, question) => {
  const t0 = performance.now();
  const res = await sendRequest(body, apiKey);
  const timings = await collectMetrics(res.body.getReader());
  return computeMetrics(timings, t0, modelId, question);
};

// 返回该次运行的指标记录。
// 错误处理：429/5xx 等 2 秒重试 1 次仍失败标"限频跳过"；其他错误记错误跳过；不补跑。
async function runOnce(modelId, question, apiKey) {
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: question.prompt }],
    temperature: 0,
    max_tokens: 32000,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingParams(modelId),
  };

  try {
    return await attempt(body, apiKey, modelId, question);
  } catch (err) {
    if (err.retryable) {
      // 429/5xx：等 2 秒重试 1 次
      await sleep(2000);
      try {
        return await attempt(body, apiKey, modelId, question);
      } catch (err2) {
        return skipped(modelId, question, err2);
      }
    }
    return skipped(modelId, question, err);
  }
}

function skipped(modelId, question, err) {
  const label = err.status === 429 || err.status >= 500 ? '限频跳过' : '错误跳过';
  return {
    status: 'skipped',
    label,
    model: modelId,
    questionId: question.id,
    questionSource: question.source,
    error: err.message.slice(0, 200),
    metrics: null,
    detail: null,
  };
}

// ───────────────────────── 汇总表 ─────────────────────────
// 模型 × 5 指标（TTFT / TPS / 总耗时 / token 用量 / 思考时间占比）
function printSummary(records) {
  const cols = [
    { key: 'ttftMs', label: 'TTFT(ms)', width: 11 },
    { key: 'tps', label: 'TPS', width: 8 },
    { key: 'totalMs', label: '总耗时(ms)', width: 12 },
    { key: 'tokenUsage', label: 'token用量', width: 11 },
    { key: 'thinkRatio', label: '思考占比', width: 9 },
  ];
  const modelCol = '模型'.padEnd(24);
  const header = modelCol + cols.map((c) => c.label.padEnd(c.width)).join('');
  console.log('\n' + '='.repeat(header.length));
  console.log(`性能探针汇总（5 模型 × ${records[0]?.questionId ?? '?'}）`);
  console.log('指标: TTFT=首chunk到达 | TPS=全部token÷生成时长(仅同模型内可比) | 总耗时=请求→末chunk | token用量=prompt+completion | 思考占比=思考时间÷生成时长');
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of records) {
    let row = r.model.padEnd(24);
    if (r.status !== 'ok') {
      row += (r.label + ' ' + (r.error ?? '')).slice(0, cols.reduce((s, c) => s + c.width, 0)).padEnd(cols.reduce((s, c) => s + c.width, 0));
      console.log(row);
      continue;
    }
    for (const c of cols) {
      let v;
      if (c.key === 'thinkRatio') v = (r.metrics.thinkRatio * 100).toFixed(0) + '%';
      else v = String(r.metrics[c.key]);
      row += v.padEnd(c.width);
    }
    console.log(row);
  }
  console.log('\n说明：TPS 用 completion_tokens 计算，跨模型 tokenizer 不同不直接比较；并行请求下指标受共享资源竞争影响，为相对参考。');
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  // 1. 数据集：缺失则下载
  let question = pickQuestion();
  if (!question) {
    console.log('本地无 HumanEval 数据集，开始下载...');
    await fetchHumanEval();
    question = pickQuestion();
  }
  console.log(`抽题: ${question.id}（entry_point: ${question.entryPoint}）`);

  // 2. API key
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('未取到 DASHSCOPE_CODING_KEY');
    process.exit(1);
  }

  // 3. 5 模型并行流式请求
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(RESULTS_DIR, `perf-${ts}.jsonl`);
  writeFileSync(resultsPath, ''); // 覆盖建空文件

  console.log(`并行请求 5 个模型 ...`);
  const records = await Promise.all(MODELS.map((m) => runOnce(m, question, apiKey)));

  // 4. 写 JSONL（一行一模型）
  for (const r of records) {
    writeFileSync(resultsPath, JSON.stringify(r) + '\n', { flag: 'a' });
  }

  // 5. 终端汇总表
  printSummary(records);
  console.log(`\nJSONL 结果已写入: ${resultsPath}`);
  const ok = records.filter((r) => r.status === 'ok').length;
  const skip = records.length - ok;
  console.log(`完成: ${ok} 个成功, ${skip} 个跳过, 共 ${records.length} 个`);
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
