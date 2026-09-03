import type { Record } from '../types';

// 格式化辅助：一格内多值逗号分隔，括号内辅助数据
function fmtScore(r: Record): string {
  if (r.scores) {
    const { E, T, C, total } = r.scores;
    return `${total.toFixed(1)}(${E.toFixed(0)},${T.toFixed(0)},${C.toFixed(0)})`;
  }
  return r.status === 'timeout' ? '超时' : '错误';
}

function fmtPassRate(r: Record): string {
  if (r.testResult) {
    const pct = (r.testResult.passRate * 100).toFixed(0) + '%';
    return `${pct}(${r.testResult.failType})`;
  }
  return '—';
}

function fmtTotalMs(r: Record): string {
  if (r.metrics.totalMs !== null) {
    const thinkPct = (r.metrics.tokenRatio * 100).toFixed(0) + '%';
    return `${r.metrics.totalMs}ms(${thinkPct})`;
  }
  return '—';
}

function fmtCost(r: Record): string {
  if (r.metrics.cost !== undefined && r.metrics.cost !== null) {
    return `${r.metrics.cost.toFixed(4)}元`;
  }
  return '—';
}

function fmtTokens(r: Record): string {
  if (r.metrics.totalTokens !== null) {
    const cachePct = (r.metrics.cacheHitRate * 100).toFixed(0) + '%';
    return `${r.metrics.totalTokens}(${cachePct})`;
  }
  return '—';
}

function fmtTtft(r: Record): string {
  return r.metrics.ttftMs !== null ? String(r.metrics.ttftMs) : '—';
}

function fmtTps(r: Record): string {
  return r.metrics.tps !== null ? r.metrics.tps.toFixed(1) : '—';
}

export default function QuestionTable({ records }: { records: Record[] }) {
  // 按总分降序
  const sorted = [...records].sort((a, b) => {
    const ta = a.scores?.total ?? -1;
    const tb = b.scores?.total ?? -1;
    return tb - ta;
  });

  return (
    <table class="border-collapse text-sm">
      <thead>
        <tr class="border-b border-gray-300">
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">模型</th>
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">总分(E,T,C)</th>
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">通过率(类型)</th>
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">总耗时(思考%)</th>
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">总成本(元)</th>
          <th class="text-left px-3 py-2 font-medium whitespace-nowrap">总token(缓存%)</th>
          <th class="text-right px-3 py-2 font-medium whitespace-nowrap">TTFT(ms)</th>
          <th class="text-right px-3 py-2 font-medium whitespace-nowrap">吞吐量(tok/s)</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.model + r.harness} class="border-b border-gray-100 hover:bg-gray-50">
            <td class="px-3 py-2 font-medium">
              {r.model}
              <span class="text-xs text-gray-400 ml-1">[{r.harness}]</span>
            </td>
            <td class="px-3 py-2 font-mono">{fmtScore(r)}</td>
            <td class="px-3 py-2 font-mono">{fmtPassRate(r)}</td>
            <td class="px-3 py-2 font-mono">{fmtTotalMs(r)}</td>
            <td class="px-3 py-2 font-mono">{fmtCost(r)}</td>
            <td class="px-3 py-2 font-mono">{fmtTokens(r)}</td>
            <td class="text-right px-3 py-2 font-mono">{fmtTtft(r)}</td>
            <td class="text-right px-3 py-2 font-mono">{fmtTps(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
