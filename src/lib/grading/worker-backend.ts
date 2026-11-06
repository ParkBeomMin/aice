// 브라우저 채점 백엔드: grading.worker 1개를 감싸고 셀 시간 제한(초과 시 terminate), 초기화/패키지 watchdog 을 적용
import type { CellRun, GradingBackend } from './grader.ts';
import type { CheckResult } from './types.ts';
import { PYODIDE_INDEX_URL, type DatasetSpec } from '../runtime/worker-protocol.ts';

export interface WorkerBackendOptions { datasets: DatasetSpec[]; workerFactory: () => Worker; initTimeoutMs?: number; packageTimeoutMs?: number; indexURL?: string }

export function workerBackendFactory(o: WorkerBackendOptions): () => GradingBackend {
  return () => {
    let w: Worker | null = null;
    let seq = 0;
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const failAll = (msg: string) => { for (const p of pending.values()) p.reject(new Error(msg)); pending.clear(); };
    const kill = () => { if (w) { w.onmessage = null; w.onerror = null; w.terminate(); w = null; } };
    const req = (type: string, payload: Record<string, unknown> = {}, timeoutMs = 0, onTimeout?: () => unknown): Promise<unknown> => new Promise((resolve, reject) => {
      if (!w) return reject(new Error('채점 Worker 가 종료됨'));
      const id = `g${++seq}`;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (fn: () => void) => { if (timer) clearTimeout(timer); pending.delete(id); fn(); };
      pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)) });
      if (timeoutMs > 0) timer = setTimeout(() => { pending.delete(id); kill(); failAll('채점 Worker 종료'); if (onTimeout) resolve(onTimeout()); else reject(new Error(`${type} 시간 초과 (${Math.round(timeoutMs / 1000)}초)`)); }, timeoutMs);
      w.postMessage({ id, type, ...payload });
    });
    return {
      async init() {
        w = o.workerFactory();
        w.onmessage = (e: MessageEvent) => { const m = e.data as { id: string; ok: boolean; value?: unknown; error?: string }; const p = pending.get(m.id); if (!p) return; m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); };
        w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); kill(); failAll(`채점 Worker 오류: ${e.message || '알 수 없음'}`); };
        await req('G_INIT', { indexURL: o.indexURL ?? PYODIDE_INDEX_URL, datasets: o.datasets }, o.initTimeoutMs ?? 90_000);
      },
      async loadPackages(packages) { await req('G_LOAD', { packages }, o.packageTimeoutMs ?? 180_000); },
      async imports(code) { return (await req('G_IMPORTS', { code }, 30_000)) as string[]; },
      async runCell(code, timeoutMs) { return (await req('G_RUN', { code }, timeoutMs, () => ({ ok: false, timedOut: true, error: null }))) as CellRun; },
      async preCapture(profile) { await req('G_PRE', { profile }, 30_000); },
      async check(profile) { return (await req('G_CHECK', { profile }, 30_000)) as CheckResult[]; },
      dispose() { kill(); failAll('채점 Worker 종료'); },
    };
  };
}
