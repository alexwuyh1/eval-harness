import { useState, useRef } from 'preact/hooks';
import { runTest, getRunStatus } from '../api';
import type { RunStatus } from '../types';

export default function RunPanel({ models, onFinished }: { models: string[]; onFinished: () => void }) {
  const [mode, setMode] = useState('standard');
  const [harness, setHarness] = useState('bare');
  const [model, setModel] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [count, setCount] = useState(1);
  const [timeout, setTimeoutVal] = useState(0);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPoll = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const s = await getRunStatus();
        setStatus(s);
        if (!s.running) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          onFinished();
        }
      } catch (e) {
        setError(String(e));
      }
    }, 2500);
  };

  const handleStart = async () => {
    setError('');
    try {
      await runTest({
        mode,
        harness: harness as 'bare' | 'harness',
        model: model || null,
        difficulty: difficulty || null,
        count,
        timeout: timeout || null,
      });
      startPoll();
    } catch (e) {
      setError(String(e));
    }
  };

  const isRunning = status?.running ?? false;

  return (
    <div class="bg-white border-b border-gray-200 px-4 py-3">
      <div class="max-w-7xl mx-auto flex flex-wrap items-end gap-3">
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">mode</label>
          <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)}>
            <option value="standard">standard（标准模式）</option>
            <option value="">单题（--difficulty）</option>
          </select>
        </div>
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">harness</label>
          <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={harness} onChange={(e) => setHarness((e.target as HTMLSelectElement).value)}>
            <option value="bare">bare（裸跑）</option>
            <option value="harness">harness（带 harness）</option>
          </select>
        </div>
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">model</label>
          <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
            <option value="">全部模型</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">difficulty（单题模式）</label>
          <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={difficulty} onChange={(e) => setDifficulty((e.target as HTMLSelectElement).value)}>
            <option value="">默认</option>
            <option value="easy">easy</option>
            <option value="medium">medium</option>
            <option value="hard">hard</option>
          </select>
        </div>
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">count</label>
          <input type="number" min="1" max="5" class="border border-gray-300 rounded px-2 py-1 text-sm w-16" value={count} onInput={(e) => setCount(parseInt((e.target as HTMLInputElement).value, 10) || 1)} />
        </div>
        <div class="flex flex-col">
          <label class="text-xs text-gray-500 mb-1">timeout(s)</label>
          <input type="number" min="0" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={timeout} onInput={(e) => setTimeoutVal(parseInt((e.target as HTMLInputElement).value, 10) || 0)} />
        </div>
        <button
          class="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          onClick={handleStart}
          disabled={isRunning}
        >
          {isRunning ? '运行中...' : '启动测试'}
        </button>
        <div class="text-sm text-gray-600 self-center">
          {isRunning && status ? `运行中... 已完成 ${status.completedRecords} 条记录，批次 ${status.latestBatchId}` : ''}
        </div>
        {error && <div class="text-sm text-red-600 self-center">{error}</div>}
      </div>
    </div>
  );
}
