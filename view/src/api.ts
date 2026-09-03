// fetch 封装：所有 API 调用集中在此
import type { ResultsResponse, EvalConfig, RunStatus, RunBody } from './types';

const BASE = '/api';

export async function getResults(): Promise<ResultsResponse> {
  const r = await fetch(`${BASE}/results`);
  if (!r.ok) throw new Error(`GET /results: ${r.status}`);
  return r.json();
}

export async function getConfig(): Promise<EvalConfig> {
  const r = await fetch(`${BASE}/config`);
  if (!r.ok) throw new Error(`GET /config: ${r.status}`);
  return r.json();
}

export async function putConfig(config: EvalConfig): Promise<void> {
  const r = await fetch(`${BASE}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(`PUT /config: ${r.status}`);
}

export async function getModels(): Promise<string[]> {
  const r = await fetch(`${BASE}/models`);
  if (!r.ok) throw new Error(`GET /models: ${r.status}`);
  return r.json();
}

export async function runTest(body: RunBody): Promise<{ started: boolean }> {
  const r = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /run: ${r.status}`);
  return r.json();
}

export async function getRunStatus(): Promise<RunStatus> {
  const r = await fetch(`${BASE}/run/status`);
  if (!r.ok) throw new Error(`GET /run/status: ${r.status}`);
  return r.json();
}
