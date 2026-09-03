// JSONL record 类型（单一真相源：probe/eval.mjs serializeRecord）
export interface Metrics {
  ttftMs: number | null;
  thinkMs: number | null;
  tokenRatio: number;
  tps: number | null;
  totalMs: number | null;
  totalTokens: number | null;
  cacheHitRate: number;
  cost: number;
}

export interface TestResult {
  failType: string; // 中文：通过/编译错误/运行异常/答案错误/超时
  passRate: number;
  passCount: number;
  total: number;
  results: unknown[];
}

export interface Scores {
  E: number;
  T: number;
  C: number;
  total: number;
}

export interface Baseline {
  medianMs: number;
  medianCost: number;
}

export interface Detail {
  exitCode: number;
  stderrTail: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

export interface Record {
  batchId: string;
  questionId: string;
  questionTitle: string;
  difficulty: string; // easy/medium/hard
  platform: string;
  harness: 'bare' | 'harness';
  model: string;
  status: 'ok' | 'timeout' | 'error';
  metrics: Metrics;
  testResult: TestResult | null;
  scores: Scores | null;
  baseline: Baseline | null;
  detail: Detail;
}

// GET /api/results 返回
export interface BatchGroup {
  batchId: string;
  records: Record[];
}

export interface ResultsResponse {
  batches: BatchGroup[];
}

// GET /api/config 返回 eval.config.json 完整结构
export interface EvalConfig {
  scoring: {
    weights: { effect: number; speed: number; cost: number };
    speedFactor: number;
    costFactor: number;
  };
  penalty: { passAll: number };
  difficulties: string[];
  maxQuestions: number;
  timeouts: {
    bare: { default: number; easy: number; medium: number; hard: number };
    harness: { default: number; easy: number; medium: number; hard: number };
  };
  standardMode: { difficulty: string; count: number }[];
}

// GET /api/run/status
export interface RunStatus {
  running: boolean;
  latestBatchId: string | null;
  completedRecords: number;
  totalModels: number;
}

// POST /api/run body
export interface RunBody {
  mode: 'standard' | string;
  harness: 'bare' | 'harness';
  model: string | null;
  difficulty: string | null;
  count: number;
  timeout: number | null;
}
