import { useState, useEffect } from 'preact/hooks';
import RunPanel from './components/RunPanel';
import ResultsPanel from './components/ResultsPanel';
import ConfigPanel from './components/ConfigPanel';
import { getResults, getModels } from './api';
import type { ResultsResponse } from './types';

type Dimension = 'batch' | 'model';

export default function App() {
  const [dimension, setDimension] = useState<Dimension>('batch');
  const [results, setResults] = useState<ResultsResponse>({ batches: [] });
  const [models, setModels] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    getResults().then(setResults).catch((e) => console.error(e));
    getModels().then(setModels).catch((e) => console.error(e));
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div class="min-h-screen bg-gray-50 text-gray-800">
      {/* 启动区 */}
      <RunPanel models={models} onFinished={refresh} />

      {/* 维度切换 */}
      <div class="max-w-7xl mx-auto px-4 py-2 border-b border-gray-200">
        <span class="text-sm font-medium mr-3">维度:</span>
        <button
          class={`px-3 py-1 rounded text-sm ${dimension === 'batch' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          onClick={() => setDimension('batch')}
        >
          按批次
        </button>
        <button
          class={`px-3 py-1 rounded text-sm ml-2 ${dimension === 'model' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          onClick={() => setDimension('model')}
        >
          按模型
        </button>
      </div>

      {/* 内容区 */}
      <div class="max-w-7xl mx-auto px-4 py-4">
        <ResultsPanel dimension={dimension} results={results} models={models} />
      </div>

      {/* 配置区 */}
      <div class="max-w-7xl mx-auto px-4 py-4 border-t border-gray-200">
        <ConfigPanel />
      </div>
    </div>
  );
}
