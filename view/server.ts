import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, type Subprocess } from 'bun';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_ROOT = __dirname;
const PROJECT_ROOT = resolve(VIEW_ROOT, '..');
const PROBE_DIR = join(PROJECT_ROOT, 'probe');
const RESULTS_PATH = join(PROBE_DIR, 'results', 'results.jsonl');
const CONFIG_PATH = join(PROBE_DIR, 'eval.config.json');
const MODELS_PATH = join(PROJECT_ROOT, 'models.json');
const EVAL_SCRIPT = join(PROBE_DIR, 'eval.mjs');
const DIST_DIR = join(VIEW_ROOT, 'dist');

// 当前运行中的 eval 子进程（全局单例，判断 running）
let currentProc: Subprocess | null = null;

// ───────────────────────── 数据读写 ─────────────────────────

interface RecordRow {
  batchId: string;
  model: string;
  [key: string]: unknown;
}

function readResultsJsonl(): { batches: Array<{ batchId: string; records: unknown[] }> } {
  if (!existsSync(RESULTS_PATH)) return { batches: [] };
  const content = readFileSync(RESULTS_PATH, 'utf8');
  const records = content
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => JSON.parse(line) as RecordRow);
  const map = new Map<string, unknown[]>();
  for (const r of records) {
    if (!map.has(r.batchId)) map.set(r.batchId, []);
    map.get(r.batchId)!.push(r);
  }
  // batchId 降序（最新在前）
  const batches = Array.from(map.entries())
    .map(([batchId, recs]) => ({ batchId, records: recs }))
    .sort((a, b) => b.batchId.localeCompare(a.batchId));
  return { batches };
}

function getConfigJson(): unknown {
  const content = readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(content);
}

function putConfigJson(body: unknown): void {
  const text = JSON.stringify(body, null, 2) + '\n';
  writeFileSync(CONFIG_PATH, text);
}

function getModelsList(): string[] {
  const content = readFileSync(MODELS_PATH, 'utf8');
  const models = JSON.parse(content);
  return models.providers.dashscope.models.map((m: { id: string }) => m.id);
}

function startRun(body: { mode?: string; harness?: string; model?: string | null; difficulty?: string | null; count?: number; timeout?: number | null }): { started: boolean } {
  if (currentProc && currentProc.killed === false) {
    throw new Error('已有测试在运行中');
  }
  const args: string[] = [];
  if (body.mode) args.push('--mode', body.mode);
  if (body.harness === 'harness') args.push('--harness', 'harness');
  if (body.model) args.push('--model', body.model);
  if (body.difficulty) args.push('--difficulty', body.difficulty);
  if (body.count && body.count > 1) args.push('--count', String(body.count));
  if (body.timeout) args.push('--timeout', String(body.timeout));

  mkdirSync(join(PROBE_DIR, 'results'), { recursive: true });

  // env 继承当前进程（含 DASHSCOPE_CODING_KEY，eval.mjs 自己读）
  currentProc = spawn(['node', EVAL_SCRIPT, ...args], {
    cwd: PROBE_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return { started: true };
}

function getRunStatus(): { running: boolean; latestBatchId: string | null; completedRecords: number; totalModels: number } {
  const running = currentProc !== null && !currentProc.killed;
  const { batches } = readResultsJsonl();
  const latestBatch = batches[0] ?? null;
  const latestBatchId = latestBatch?.batchId ?? null;
  const completedRecords = latestBatch?.records.length ?? 0;
  const totalModels = latestBatch
    ? new Set((latestBatch.records as RecordRow[]).map((r) => r.model)).size
    : 0;

  // 进程结束后清空引用
  if (currentProc && currentProc.killed && currentProc.exitCode !== null) {
    currentProc = null;
  }

  return { running, latestBatchId, completedRecords, totalModels };
}

// ───────────────────────── 路由处理器（各自独立函数）─────────────────────────
// fetch 查表分发：routes map 的 key = "METHOD /path"，value = handler

async function handleResults(): Promise<Response> {
  return Response.json(readResultsJsonl());
}

async function handleConfigGet(): Promise<Response> {
  return Response.json(getConfigJson());
}

async function handleConfigPut(req: Request): Promise<Response> {
  const body = await req.json();
  putConfigJson(body);
  return Response.json({ ok: true });
}

async function handleModels(): Promise<Response> {
  return Response.json(getModelsList());
}

async function handleRun(req: Request): Promise<Response> {
  const body = await req.json();
  return Response.json(startRun(body));
}

async function handleRunStatus(): Promise<Response> {
  return Response.json(getRunStatus());
}

// 静态文件服务（生产模式 dist/）
function serveStatic(pathname: string): Response | null {
  if (!existsSync(DIST_DIR)) return null;
  const filePath = join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (existsSync(filePath)) return new Response(Bun.file(filePath));
  const indexFile = join(DIST_DIR, 'index.html');
  if (existsSync(indexFile)) return new Response(Bun.file(indexFile));
  return null;
}

// 路由表：key = "METHOD /path" → handler（查表分发，fetch 内无 if 链）
const routes: Record<string, (req: Request) => Promise<Response>> = {
  'GET /api/results': handleResults,
  'GET /api/config': handleConfigGet,
  'PUT /api/config': handleConfigPut,
  'GET /api/models': handleModels,
  'POST /api/run': handleRun,
  'GET /api/run/status': handleRunStatus,
};

// ───────────────────────── HTTP 服务 ─────────────────────────

async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (handler) {
    try {
      return await handler(req);
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
  }
  return serveStatic(url.pathname) ?? new Response('Not found', { status: 404 });
}

const server = Bun.serve({
  port: 3001,
  fetch: fetchHandler,
});

console.log(`评测可视化服务: http://localhost:${server.port}`);
