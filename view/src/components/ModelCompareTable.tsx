import type { Record } from '../types';

interface Row {
  questionId: string;
  questionTitle: string;
  difficulty: string;
  bareScore: number | null;
  harnessScore: number | null;
  gain: number | null;
}

export default function ModelCompareTable({
  records,
  model,
  difficultyFilter,
}: {
  records: Record[];
  model: string;
  difficultyFilter: string; // 'all' | 'medium' | 'hard'
}) {
  // 筛选该模型的记录
  const modelRecords = records.filter((r) => r.model === model);

  // 按难度筛选
  const filtered = difficultyFilter === 'all'
    ? modelRecords
    : modelRecords.filter((r) => r.difficulty === difficultyFilter);

  // 按 questionId 分组，bare/harness 配对
  const questionMap = new Map<string, Record[]>();
  for (const r of filtered) {
    if (!questionMap.has(r.questionId)) questionMap.set(r.questionId, []);
    questionMap.get(r.questionId)!.push(r);
  }

  const rows: Row[] = Array.from(questionMap.entries()).map(([qid, recs]) => {
    const bare = recs.find((r) => r.harness === 'bare');
    const harness = recs.find((r) => r.harness === 'harness');
    const bareScore = bare?.scores?.total ?? null;
    const harnessScore = harness?.scores?.total ?? null;
    const gain = bareScore !== null && harnessScore !== null ? harnessScore - bareScore : null;
    return {
      questionId: qid,
      questionTitle: recs[0].questionTitle,
      difficulty: recs[0].difficulty,
      bareScore,
      harnessScore,
      gain,
    };
  });

  // 按题号排序
  rows.sort((a, b) => a.questionId.localeCompare(b.questionId));

  // 计算平均
  const validGains = rows.filter((r) => r.gain !== null);
  const avgBare = rows.filter((r) => r.bareScore !== null);
  const avgHarness = rows.filter((r) => r.harnessScore !== null);
  const bareAvg = avgBare.length > 0 ? avgBare.reduce((s, r) => s + r.bareScore!, 0) / avgBare.length : null;
  const harnessAvg = avgHarness.length > 0 ? avgHarness.reduce((s, r) => s + r.harnessScore!, 0) / avgHarness.length : null;
  const gainAvg = validGains.length > 0 ? validGains.reduce((s, r) => s + r.gain!, 0) / validGains.length : null;

  if (rows.length === 0) {
    return <div class="text-gray-400 text-sm">该模型在此难度下无 bare/harness 对照数据</div>;
  }

  const fmt = (v: number | null, digits = 1) => v !== null ? v.toFixed(digits) : '—';

  return (
    <table class="border-collapse text-sm">
      <thead>
        <tr class="border-b border-gray-300">
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">题</th>
          <th class="text-right px-3 py-2 font-medium whitespace-nowrap">bare 总分</th>
          <th class="text-right px-3 py-2 font-medium whitespace-nowrap">harness 总分</th>
          <th class="text-right px-3 py-2 font-medium whitespace-nowrap">增益</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.questionId} class="border-b border-gray-100 hover:bg-gray-50">
            <td class="px-3 py-2 font-medium">
              {row.questionId}
              <span class="text-xs text-gray-400 ml-1">({row.difficulty})</span>
              <div class="text-xs text-gray-400 font-normal">{row.questionTitle}</div>
            </td>
            <td class="text-right px-3 py-2 font-mono">{fmt(row.bareScore)}</td>
            <td class="text-right px-3 py-2 font-mono">{fmt(row.harnessScore)}</td>
            <td class={`text-right px-3 py-2 font-mono ${row.gain !== null && row.gain < 0 ? 'text-red-600' : row.gain !== null && row.gain > 0 ? 'text-green-600' : ''}`}>
              {row.gain !== null ? (row.gain > 0 ? '+' : '') + row.gain.toFixed(1) : '—'}
            </td>
          </tr>
        ))}
        {/* 平均行 */}
        <tr class="border-t-2 border-gray-300 font-bold bg-gray-50">
          <td class="px-3 py-2">平均</td>
          <td class="text-right px-3 py-2 font-mono">{fmt(bareAvg)}</td>
          <td class="text-right px-3 py-2 font-mono">{fmt(harnessAvg)}</td>
          <td class={`text-right px-3 py-2 font-mono ${gainAvg !== null && gainAvg < 0 ? 'text-red-600' : gainAvg !== null && gainAvg > 0 ? 'text-green-600' : ''}`}>
            {gainAvg !== null ? (gainAvg > 0 ? '+' : '') + gainAvg.toFixed(1) : '—'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
