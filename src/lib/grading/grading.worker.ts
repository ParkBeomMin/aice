/// <reference lib="webworker" />
// T-06 채점 전용 Worker: 제출 1건 = Pyodide 인스턴스 1개 (학습용 커널과 완전히 분리). 끝나면 메인 스레드가 terminate.
import { GRADING_PY } from './grading-python.ts';
import type { DatasetSpec } from '../runtime/worker-protocol.ts';

declare const self: DedicatedWorkerGlobalScope;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let py: any = null;

async function sha256Hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function init(indexURL: string, datasets: DatasetSpec[]) {
  const mod = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  py = await mod.loadPyodide({ indexURL });
  py.FS.chdir('/home/pyodide');
  for (const d of datasets) {
    if (!/^[A-Za-z0-9._-]+$/.test(d.name)) throw new Error(`허용되지 않는 파일명: ${d.name}`);
    const u = new URL(d.url, self.location.href);
    if (u.origin !== self.location.origin) throw new Error(`외부 출처 데이터셋 거부: ${u.origin}`);
    const res = await fetch(u, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${d.name} 다운로드 실패 (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== d.size || (await sha256Hex(buf)) !== d.sha256) throw new Error(`${d.name} 무결성 검사 실패`);
    py.FS.writeFile(`/home/pyodide/${d.name}`, new Uint8Array(buf));
  }
  await py.runPythonAsync(GRADING_PY);
}

const call = (name: string, ...args: unknown[]) => { const f = py.globals.get(name); try { return f(...args); } finally { f.destroy?.(); } };

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { id: string; type: string; [k: string]: unknown };
  try {
    let value: unknown = null;
    if (m.type === 'G_INIT') await init(m.indexURL as string, m.datasets as DatasetSpec[]);
    else if (m.type === 'G_LOAD') { const pk = m.packages as string[]; if (pk.length) await py.loadPackage(pk, { messageCallback() {}, errorCallback() {} }); call('_g_seed'); }
    else if (m.type === 'G_IMPORTS') { const r = call('_g_imports', m.code); value = r.toJs(); r.destroy?.(); }
    else if (m.type === 'G_RUN') value = JSON.parse(await call('_g_run', m.code));
    else if (m.type === 'G_PRE') call('_g_pre_capture', m.profile);
    else if (m.type === 'G_CHECK') value = JSON.parse(call('_g_check', m.profile));
    else throw new Error(`알 수 없는 요청 ${m.type}`);
    self.postMessage({ id: m.id, ok: true, value });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: (e as Error).message || String(e) });
  }
};
