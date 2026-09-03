import { useState, useEffect } from 'preact/hooks';
import { getConfig, putConfig } from '../api';
import type { EvalConfig } from '../types';

export default function ConfigPanel() {
  const [config, setConfig] = useState<EvalConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setError('');
    setSaved(false);
    try {
      await putConfig(config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  const update = (fn: (c: EvalConfig) => EvalConfig) => {
    setConfig((c) => (c ? fn({ ...c }) : c));
  };

  if (error) return <div class="text-red-600 text-sm">{error}</div>;
  if (!config) return <div class="text-gray-400 text-sm">加载配置...</div>;

  return (
    <div>
      <div class="flex items-center gap-2 mb-3">
        <h3 class="text-sm font-medium">配置 (eval.config.json)</h3>
        <button class="bg-blue-600 text-white px-3 py-1 rounded text-sm" onClick={handleSave}>保存</button>
        {saved && <span class="text-sm text-green-600">已保存</span>}
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 评分权重 */}
        <div class="border border-gray-200 rounded p-3">
          <h4 class="text-xs font-medium text-gray-500 mb-2">评分权重 (scoring.weights)</h4>
          <label class="flex items-center gap-2 mb-1">
            <span class="text-xs w-20">effect (E)</span>
            <input type="number" step="0.1" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={config.scoring.weights.effect}
              onInput={(e) => update((c) => { c.scoring.weights.effect = parseFloat((e.target as HTMLInputElement).value); return c; })} />
          </label>
          <label class="flex items-center gap-2 mb-1">
            <span class="text-xs w-20">speed (T)</span>
            <input type="number" step="0.1" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={config.scoring.weights.speed}
              onInput={(e) => update((c) => { c.scoring.weights.speed = parseFloat((e.target as HTMLInputElement).value); return c; })} />
          </label>
          <label class="flex items-center gap-2 mb-1">
            <span class="text-xs w-20">cost (C)</span>
            <input type="number" step="0.1" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={config.scoring.weights.cost}
              onInput={(e) => update((c) => { c.scoring.weights.cost = parseFloat((e.target as HTMLInputElement).value); return c; })} />
          </label>
        </div>

        {/* 惩罚 + maxQuestions */}
        <div class="border border-gray-200 rounded p-3">
          <h4 class="text-xs font-medium text-gray-500 mb-2">惩罚 & 题数</h4>
          <label class="flex items-center gap-2 mb-1">
            <span class="text-xs w-20">passAll</span>
            <input type="number" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={config.penalty.passAll}
              onInput={(e) => update((c) => { c.penalty.passAll = parseInt((e.target as HTMLInputElement).value, 10); return c; })} />
          </label>
          <label class="flex items-center gap-2 mb-1">
            <span class="text-xs w-20">maxQuestions</span>
            <input type="number" min="1" max="20" class="border border-gray-300 rounded px-2 py-1 text-sm w-20" value={config.maxQuestions}
              onInput={(e) => update((c) => { c.maxQuestions = parseInt((e.target as HTMLInputElement).value, 10); return c; })} />
          </label>
        </div>

        {/* 超时 */}
        <div class="border border-gray-200 rounded p-3">
          <h4 class="text-xs font-medium text-gray-500 mb-2">超时 (timeouts)</h4>
          <table class="text-xs">
            <thead>
              <tr>
                <th class="px-1 py-1"></th>
                <th class="px-1 py-1 font-normal text-gray-400">default</th>
                <th class="px-1 py-1 font-normal text-gray-400">easy</th>
                <th class="px-1 py-1 font-normal text-gray-400">medium</th>
                <th class="px-1 py-1 font-normal text-gray-400">hard</th>
              </tr>
            </thead>
            <tbody>
              {(['bare', 'harness'] as const).map((hk) => (
                <tr key={hk}>
                  <td class="px-1 py-1 font-medium">{hk}</td>
                  {(['default', 'easy', 'medium', 'hard'] as const).map((dk) => (
                    <td key={dk} class="px-1 py-1">
                      <input type="number" class="border border-gray-300 rounded px-1 py-0.5 text-xs w-16" value={config.timeouts[hk][dk]}
                        onInput={(e) => update((c) => { c.timeouts[hk][dk] = parseInt((e.target as HTMLInputElement).value, 10); return c; })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 标准模式 */}
        <div class="border border-gray-200 rounded p-3 col-span-1 md:col-span-3">
          <h4 class="text-xs font-medium text-gray-500 mb-2">标准模式 (standardMode)</h4>
          <div class="flex flex-wrap gap-3">
            {config.standardMode.map((spec, i) => (
              <div key={i} class="flex items-center gap-2 text-xs">
                <select class="border border-gray-300 rounded px-1 py-0.5" value={spec.difficulty}
                  onChange={(e) => update((c) => { c.standardMode[i].difficulty = (e.target as HTMLSelectElement).value; return c; })}>
                  {config.difficulties.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input type="number" min="1" max="10" class="border border-gray-300 rounded px-1 py-0.5 w-12" value={spec.count}
                  onInput={(e) => update((c) => { c.standardMode[i].count = parseInt((e.target as HTMLInputElement).value, 10); return c; })} />
                <span class="text-gray-400">题</span>
              </div>
            ))}
          </div>
          <div class="mt-2 text-xs text-gray-400">难度列表: {config.difficulties.join(', ')}</div>
        </div>
      </div>
    </div>
  );
}
