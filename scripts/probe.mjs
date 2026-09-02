/**
 * 模型性能探针（P1-4）
 *
 * 输入 models.json 里的模型清单，对每个模型发固定 prompt 的流式请求，
 * 测 TTFT（首 chunk 到达）、生成吞吐（completion_tokens / 生成时长）、总耗时、token 用量。
 * 每模型跑 RUNS_PER_MODEL 次取中位数，结果写 JSONL + 终端汇总表。
 *
 * 用法：node scripts/probe.mjs   （或 npm run probe）
 * 凭证：环境变量 DASHSCOPE_CODING_KEY（只读，不写盘）
 */

import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 探针常量（控制变量）----
const RUNS_PER_MODEL = 3;
const MAX_TOKENS = 800;
const REQUEST_TIMEOUT_MS = 120_000;
// 固定 prompt：让模型生成足够长度的内容，吞吐测量需要足够 token 量
const PROMPT =
  '请用中文写一段 400 字左右的技术说明，介绍 HTTP 长连接（keep-alive）的工作原理、' +
  '它解决了短连接的什么性能问题，以及在实际部署中需要注意的两个事项。' +
  '直接输出正文，不要标题、不要列表编号、不要客套话。';
const RESULTS_PATH = join(ROOT, 'scripts', 'probe-results.jsonl');

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 从 models.json 读端点、key 环境变量名、模型清单 */
async function loadConfig() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'models.json'), 'utf8'));
  const provider = cfg.providers.dashscope;
  const keyEnv = provider.apiKey.replace(/^\$/, '');
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`环境变量 ${keyEnv} 未设置（在 ~/.zshenv，用 zsh -c 起可拿到）`);
  return { baseUrl: provider.baseUrl, apiKey, models: provider.models.map((m) => m.id) };
}

/**
 * 对单个模型跑一次流式探针。
 * 返回 { ttftMs, totalMs, genMs, throughputTokS, promptTokens, completionTokens }
 * genMs = totalMs - ttftMs；吞吐 = completionTokens / (genMs/1000)。
 */
async function probeOnce(baseUrl, apiKey, model) {
  const t0 = performance.now();
  let firstChunkAt = null;
  let usage = null;
  let contentChars = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    // 逐行解析 SSE：data: {json}\n\n，结束于 data: [DONE]
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(data); } catch { continue; }
          if (firstChunkAt === null) firstChunkAt = performance.now();
          if (evt.usage) usage = evt.usage;
          // kimi-k3 可能带 reasoning_content，只按 content 统计
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') contentChars += delta.length;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const totalMs = performance.now() - t0;
  if (firstChunkAt === null) throw new Error('未收到任何流式 chunk');
  const ttftMs = firstChunkAt - t0;
  const genMs = totalMs - ttftMs;
  const completionTokens = usage?.completion_tokens ?? null;
  // kimi-k3 的 usage.completion_tokens 含不可见 thinking token（~2100 tok 对 ~500 字），
  // 而 flash/pro/glm 只计可见 content。为保证横向对比公平，吞吐按实际交付的 contentChars 计算。
  const throughputTokS = genMs > 0 ? Math.round((contentChars / (genMs / 1000)) * 10) / 10 : null;
  return {
    ttftMs: Math.round(ttftMs),
    totalMs: Math.round(totalMs),
    genMs: Math.round(genMs),
    throughputTokS,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens,
    contentChars,
  };
}

function fmt(n, digits = 0) {
  return n === null || n === undefined ? '-' : Number(n).toFixed(digits);
}

async function main() {
  const { baseUrl, apiKey, models } = await loadConfig();
  console.log(`端点: ${baseUrl}`);
  console.log(`模型: ${models.join(', ')}`);
  console.log(`每模型 ${RUNS_PER_MODEL} 次，max_tokens=${MAX_TOKENS}，结果追加到 ${RESULTS_PATH}\n`);

  await mkdir(dirname(RESULTS_PATH), { recursive: true });
  const startedAt = new Date().toISOString();
  const allRuns = [];

  // 逐模型、逐次串行：避免并发互相抢带宽污染数据
  for (const model of models) {
    const runs = [];
    for (let i = 1; i <= RUNS_PER_MODEL; i++) {
      process.stdout.write(`  ${model} 第 ${i}/${RUNS_PER_MODEL} 次... `);
      try {
        const r = await probeOnce(baseUrl, apiKey, model);
        const rec = { ts: new Date().toISOString(), model, run: i, ...r };
        runs.push(r);
        allRuns.push(rec);
        await appendFile(RESULTS_PATH, JSON.stringify(rec) + '\n');
        console.log(`TTFT ${r.ttftMs}ms, 吞吐 ${fmt(r.throughputTokS, 1)} tok/s, 总耗时 ${r.totalMs}ms`);
      } catch (err) {
        const rec = { ts: new Date().toISOString(), model, run: i, error: String(err.message ?? err) };
        allRuns.push(rec);
        await appendFile(RESULTS_PATH, JSON.stringify(rec) + '\n');
        console.log(`失败: ${err.message ?? err}`);
      }
    }
  }

  // ---- 汇总表（每模型取中位数）----
  console.log('\n===== 汇总（中位数）=====');
  const header = ['模型', 'TTFT(ms)', '吞吐(字/s)', '总耗时(ms)', 'prompt_tok', 'completion_tok', '内容字数', '成功率'];
  const widths = [Math.max(...models.map((m) => m.length), 4), 10, 12, 12, 11, 14, 10, 8];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join(' '));

  for (const model of models) {
    const runs = allRuns.filter((r) => r.model === model && !r.error);
    const ok = runs.length;
    if (ok === 0) {
      console.log(line([model, '-', '-', '-', '-', '-', '-', `0/${RUNS_PER_MODEL}`]));
      continue;
    }
    console.log(line([
      model,
      fmt(median(runs.map((r) => r.ttftMs))),
      fmt(median(runs.map((r) => r.throughputTokS)), 1),
      fmt(median(runs.map((r) => r.totalMs))),
      fmt(median(runs.map((r) => r.promptTokens))),
      fmt(median(runs.map((r) => r.completionTokens))),
      fmt(median(runs.map((r) => r.contentChars))),
      `${ok}/${RUNS_PER_MODEL}`,
    ]));
  }
  console.log(`\n明细已写入 ${RESULTS_PATH}（开始于 ${startedAt}）`);
}

main().catch((err) => {
  console.error('探针失败:', err);
  process.exit(1);
});
