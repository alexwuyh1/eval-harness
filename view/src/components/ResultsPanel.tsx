import { useState } from 'preact/hooks';
import SummaryTable from './SummaryTable';
import QuestionTable from './QuestionTable';
import ModelCompareTable from './ModelCompareTable';
import type { ResultsResponse, Record } from '../types';

type Tab = 'summary' | 'question';

// ───────────────────────── 按批次视图 ─────────────────────────
function BatchView({ results }: { results: ResultsResponse }) {
  const [batchId, setBatchId] = useState('');
  const [tab, setTab] = useState<Tab>('summary');
  const [questionId, setQuestionId] = useState('');

  const batches = results.batches;
  if (batches.length === 0) {
    return <div class="text-gray-400 text-sm">暂无评测数据，启动测试后查看结果</div>;
  }

  const selectedBatch = batches.find((b) => b.batchId === batchId) ?? batches[0];
  const records = selectedBatch.records as Record[];
  const questionIds = Array.from(new Set(records.map((r) => r.questionId)));
  const selectedQuestion = questionId && questionIds.includes(questionId) ? questionId : questionIds[0] ?? '';

  return (
    <div>
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-medium">批次:</span>
        <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={selectedBatch.batchId} onChange={(e) => setBatchId((e.target as HTMLSelectElement).value)}>
          {batches.map((b) => <option key={b.batchId} value={b.batchId}>{b.batchId}</option>)}
        </select>
        <div class="ml-4 flex gap-1">
          <button class={`px-3 py-1 rounded text-sm ${tab === 'summary' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`} onClick={() => setTab('summary')}>总汇总</button>
          <button class={`px-3 py-1 rounded text-sm ${tab === 'question' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`} onClick={() => setTab('question')}>各题</button>
        </div>
      </div>

      {tab === 'summary' && <SummaryTable records={records} />}
      {tab === 'question' && (
        <div>
          <div class="flex items-center gap-2 mb-3">
            <span class="text-sm font-medium">题目:</span>
            <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={selectedQuestion} onChange={(e) => setQuestionId((e.target as HTMLSelectElement).value)}>
              {questionIds.map((qid) => {
                const r = records.find((rec) => rec.questionId === qid);
                return <option key={qid} value={qid}>{qid}({r?.difficulty})</option>;
              })}
            </select>
            {selectedQuestion && (
              <span class="text-xs text-gray-400">
                {records.find((r) => r.questionId === selectedQuestion)?.questionTitle}
              </span>
            )}
          </div>
          <QuestionTable records={records.filter((r) => r.questionId === selectedQuestion)} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 按模型视图 ─────────────────────────
function ModelView({ results, models }: { results: ResultsResponse; models: string[] }) {
  const [model, setModel] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState('all');

  const modelList = models.length > 0
    ? models
    : Array.from(new Set(results.batches.flatMap((b) => (b.records as Record[]).map((r) => r.model))));
  const selectedModel = model && modelList.includes(model) ? model : modelList[0] ?? '';
  const allRecords = results.batches.flatMap((b) => b.records as Record[]);

  return (
    <div>
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-medium">模型:</span>
        <select class="border border-gray-300 rounded px-2 py-1 text-sm" value={selectedModel} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
          {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span class="text-sm font-medium ml-4">难度:</span>
        <button class={`px-3 py-1 rounded text-sm ${difficultyFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`} onClick={() => setDifficultyFilter('all')}>全部</button>
        <button class={`px-3 py-1 rounded text-sm ${difficultyFilter === 'medium' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`} onClick={() => setDifficultyFilter('medium')}>medium</button>
        <button class={`px-3 py-1 rounded text-sm ${difficultyFilter === 'hard' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`} onClick={() => setDifficultyFilter('hard')}>hard</button>
      </div>
      <ModelCompareTable records={allRecords} model={selectedModel} difficultyFilter={difficultyFilter} />
    </div>
  );
}

export default function ResultsPanel({
  dimension,
  results,
  models,
}: {
  dimension: 'batch' | 'model';
  results: ResultsResponse;
  models: string[];
}) {
  if (dimension === 'batch') return <BatchView results={results} />;
  return <ModelView results={results} models={models} />;
}
