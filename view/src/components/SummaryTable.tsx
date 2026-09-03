import type { Record } from '../types';

export default function SummaryTable({ records }: { records: Record[] }) {
  // 收集该批次所有 questionId
  const questionIds = Array.from(new Set(records.map((r) => r.questionId)));
  const questionMeta = new Map<string, { difficulty: string }>();
  for (const r of records) {
    if (!questionMeta.has(r.questionId)) {
      questionMeta.set(r.questionId, { difficulty: r.difficulty });
    }
  }

  // 按模型分组
  const modelMap = new Map<string, Record[]>();
  for (const r of records) {
    if (!modelMap.has(r.model)) modelMap.set(r.model, []);
    modelMap.get(r.model)!.push(r);
  }

  // 计算每个模型的平均总分、各题总分、medium均、hard均
  const rows = Array.from(modelMap.entries()).map(([model, recs]) => {
    const okRecords = recs.filter((r) => r.status === 'ok' && r.scores);
    const avgTotal = okRecords.length > 0
      ? okRecords.reduce((s, r) => s + (r.scores!.total ?? 0), 0) / okRecords.length
      : 0;
    const perQuestion = new Map<string, number>();
    for (const r of okRecords) {
      perQuestion.set(r.questionId, r.scores!.total);
    }
    const mediumRecs = okRecords.filter((r) => r.difficulty === 'medium');
    const hardRecs = okRecords.filter((r) => r.difficulty === 'hard');
    const mediumAvg = mediumRecs.length > 0 ? mediumRecs.reduce((s, r) => s + r.scores!.total, 0) / mediumRecs.length : 0;
    const hardAvg = hardRecs.length > 0 ? hardRecs.reduce((s, r) => s + r.scores!.total, 0) / hardRecs.length : 0;
    return { model, avgTotal, perQuestion, mediumAvg, hardAvg };
  });

  // 按平均总分降序
  rows.sort((a, b) => b.avgTotal - a.avgTotal);

  return (
    <table class="border-collapse text-sm">
      <thead>
        <tr class="border-b border-gray-300">
          <th class="text-left px-3 py-2 font-medium">模型</th>
          <th class="text-right px-3 py-2 font-medium">平均总分</th>
          {questionIds.map((qid) => (
            <th key={qid} class="text-right px-3 py-2 font-medium">
              {qid}
              <span class="text-xs text-gray-400 ml-1">({questionMeta.get(qid)?.difficulty})</span>
            </th>
          ))}
          <th class="text-right px-3 py-2 font-medium">medium均</th>
          <th class="text-right px-3 py-2 font-medium">hard均</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.model} class="border-b border-gray-100 hover:bg-gray-50">
            <td class="px-3 py-2 font-medium">{row.model}</td>
            <td class="text-right px-3 py-2 font-bold">{row.avgTotal.toFixed(1)}</td>
            {questionIds.map((qid) => {
              const val = row.perQuestion.get(qid);
              return <td key={qid} class="text-right px-3 py-2">{val !== undefined ? val.toFixed(1) : '—'}</td>;
            })}
            <td class="text-right px-3 py-2">{row.mediumAvg > 0 ? row.mediumAvg.toFixed(1) : '—'}</td>
            <td class="text-right px-3 py-2">{row.hardAvg > 0 ? row.hardAvg.toFixed(1) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
