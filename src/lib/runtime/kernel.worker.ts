/// <reference lib="webworker" />
// Pyodide 커널 Worker: 노트북 세션 하나 = Pyodide 인스턴스 하나 (셀 간 변수 공유).
import type { ToWorker, FromWorker, Output, DatasetSpec } from './worker-protocol.ts';
import { packagesFor, implicitPackages, truncate, MAX_STREAM_CHARS } from './worker-protocol.ts';
import { PY_HELPERS } from './python-helpers';

declare const self: DedicatedWorkerGlobalScope;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null;
let sessionId = '';
let execCount = 0;
let datasets: DatasetSpec[] = [];
const loaded = new Set<string>();

const post = (m: FromWorker) => self.postMessage(m);

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeDatasets(list: DatasetSpec[]): Promise<string[]> {
  const names: string[] = [];
  for (const d of list) {
    if (!/^[A-Za-z0-9._-]+$/.test(d.name)) throw new Error(`허용되지 않는 파일명: ${d.name}`);
    const u = new URL(d.url, self.location.href);
    if (u.origin !== self.location.origin) throw new Error(`외부 출처 데이터셋 거부: ${u.origin}`);
    const res = await fetch(u, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${d.name} 다운로드 실패 (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== d.size || (await sha256Hex(buf)) !== d.sha256) throw new Error(`${d.name} 무결성 검사 실패 (크기/SHA-256 불일치)`);
    pyodide.FS.writeFile(`/home/pyodide/${d.name}`, new Uint8Array(buf));
    names.push(d.name);
  }
  return names;
}

async function init(indexURL: string) {
  const t0 = performance.now();
  post({ type: 'KERNEL_STATUS', sessionId, status: 'loading', detail: 'Python 런타임 다운로드 중' });
  const mod = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  pyodide = await mod.loadPyodide({ indexURL });
  pyodide.FS.chdir('/home/pyodide');
  await pyodide.runPythonAsync(PY_HELPERS);
  const ver = pyodide.runPython('import sys; sys.version.split()[0]');
  post({ type: 'KERNEL_READY', sessionId, ms: Math.round(performance.now() - t0), pythonVersion: ver });
}

async function execute(requestId: string, cellId: string, code: string) {
  const outputs: Output[] = [];
  let streamChars = 0;
  const emit = (o: Output) => { outputs.push(o); post({ type: 'CELL_OUTPUT', sessionId, requestId, cellId, output: o }); };
  const streamOut = (name: 'stdout' | 'stderr') => (s: string) => {
    if (streamChars >= MAX_STREAM_CHARS) return;
    const t = truncate(s, MAX_STREAM_CHARS - streamChars);
    streamChars += t.text.length;
    emit({ kind: 'stream', name, text: t.text + '\n', truncated: t.truncated || undefined });
  };
  pyodide.setStdout({ batched: streamOut('stdout') });
  pyodide.setStderr({ batched: streamOut('stderr') });
  const tp = performance.now();
  const fi = pyodide.globals.get('_acf_imports');
  const pyImports = fi(code);
  const imports: string[] = pyImports.toJs();
  pyImports.destroy?.(); fi.destroy?.();
  const pkgs = [...new Set([...packagesFor(imports), ...implicitPackages(code)])].filter((p) => !loaded.has(p));
  if (pkgs.length) {
    post({ type: 'PACKAGES_LOADING', sessionId, requestId, cellId, packages: pkgs });
    await pyodide.loadPackage(pkgs, { messageCallback: () => {}, errorCallback: () => {} });
    pkgs.forEach((p) => loaded.add(p));
  }
  const packageMs = Math.round(performance.now() - tp);
  post({ type: 'CELL_STARTED', sessionId, requestId, cellId, packageMs });
  const t0 = performance.now();
  execCount += 1;
  const run = pyodide.globals.get('_acf_run');
  const raw: string = await run(code);
  run.destroy?.();
  const res = JSON.parse(raw) as { ok: boolean; outputs: Output[] };
  for (const o of res.outputs) emit(o);
  const durationMs = Math.round(performance.now() - t0);
  post({ type: res.ok ? 'CELL_COMPLETED' : 'CELL_ERROR', sessionId, requestId, cellId, executionCount: execCount, durationMs, outputs });
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === 'INIT_KERNEL') { sessionId = m.sessionId; await init(m.indexURL); return; }
    if (m.sessionId !== sessionId) return; // 다른 세션 요청 무시
    if (m.type === 'LOAD_DATASETS') {
      const t0 = performance.now();
      try { datasets = m.datasets; const files = await writeDatasets(datasets); post({ type: 'DATASETS_LOADED', sessionId, requestId: m.requestId, files, ms: Math.round(performance.now() - t0) }); }
      catch (e) { post({ type: 'DATASETS_ERROR', sessionId, requestId: m.requestId, error: (e as Error).message }); }
      return;
    }
    if (m.type === 'EXECUTE_CELL') { await execute(m.requestId, m.cellId, m.code); return; }
    if (m.type === 'TERMINATE_KERNEL') { self.close(); }
  } catch (e) {
    const err = e as Error;
    if (m.type === 'EXECUTE_CELL') {
      const o: Output = { kind: 'error', ename: err.name || 'Error', evalue: err.message, traceback: '' };
      post({ type: 'CELL_ERROR', sessionId, requestId: m.requestId, cellId: m.cellId, executionCount: execCount, durationMs: 0, outputs: [o] });
    } else {
      post({ type: 'KERNEL_STATUS', sessionId, status: 'error', detail: err.message });
    }
  }
};
