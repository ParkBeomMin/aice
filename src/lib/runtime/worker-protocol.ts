// 메인 스레드 ↔ Pyodide Worker 메시지 계약 (T-05)
export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// 브라우저에서 로드 허용하는 패키지 (find_imports 결과를 이 목록으로 제한)
export const ALLOWED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scikit-learn', 'scipy'] as const;
export const IMPORT_TO_PACKAGE: Record<string, string> = {
  numpy: 'numpy', pandas: 'pandas', matplotlib: 'matplotlib', sklearn: 'scikit-learn', scipy: 'scipy',
};
export const MAX_STREAM_CHARS = 100_000;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 30;

export interface DatasetSpec { name: string; url: string; sha256: string; size: number }

export type Output =
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string; truncated?: boolean }
  | { kind: 'result'; text: string; truncated?: boolean }
  | { kind: 'table'; columns: string[]; index: string[]; rows: string[][]; shape: [number, number]; truncated: boolean }
  | { kind: 'image'; png: string }
  | { kind: 'error'; ename: string; evalue: string; traceback: string };

export type ToWorker =
  | { type: 'INIT_KERNEL'; sessionId: string; indexURL: string }
  | { type: 'LOAD_DATASETS'; sessionId: string; requestId: string; datasets: DatasetSpec[] }
  | { type: 'EXECUTE_CELL'; sessionId: string; requestId: string; cellId: string; code: string }
  | { type: 'RESTART_KERNEL'; sessionId: string }
  | { type: 'TERMINATE_KERNEL'; sessionId: string };

export type FromWorker =
  | { type: 'KERNEL_STATUS'; sessionId: string; status: 'loading' | 'ready' | 'error'; detail?: string; ms?: number; versions?: Record<string, string> }
  | { type: 'KERNEL_READY'; sessionId: string; ms: number; pythonVersion: string }
  | { type: 'DATASETS_LOADED'; sessionId: string; requestId: string; files: string[]; ms: number }
  | { type: 'DATASETS_ERROR'; sessionId: string; requestId: string; error: string }
  | { type: 'PACKAGES_LOADING'; sessionId: string; requestId: string; cellId: string; packages: string[] }
  | { type: 'CELL_STARTED'; sessionId: string; requestId: string; cellId: string; packageMs: number }
  | { type: 'CELL_OUTPUT'; sessionId: string; requestId: string; cellId: string; output: Output }
  | { type: 'CELL_COMPLETED'; sessionId: string; requestId: string; cellId: string; executionCount: number; durationMs: number; outputs: Output[] }
  | { type: 'CELL_ERROR'; sessionId: string; requestId: string; cellId: string; executionCount: number; durationMs: number; outputs: Output[] };

export const TO_WORKER_TYPES = ['INIT_KERNEL', 'LOAD_DATASETS', 'EXECUTE_CELL', 'RESTART_KERNEL', 'TERMINATE_KERNEL'];
export const FROM_WORKER_TYPES = ['KERNEL_STATUS', 'KERNEL_READY', 'DATASETS_LOADED', 'DATASETS_ERROR', 'PACKAGES_LOADING', 'CELL_STARTED', 'CELL_OUTPUT', 'CELL_COMPLETED', 'CELL_ERROR'];

export function isFromWorker(m: unknown): m is FromWorker {
  return !!m && typeof m === 'object' && FROM_WORKER_TYPES.includes((m as { type?: string }).type ?? '') && typeof (m as { sessionId?: unknown }).sessionId === 'string';
}

export function packagesFor(imports: string[]): string[] {
  const out = new Set<string>();
  for (const i of imports) {
    const top = i.split('.')[0];
    const p = IMPORT_TO_PACKAGE[top];
    if (p && (ALLOWED_PACKAGES as readonly string[]).includes(p)) out.add(p);
  }
  return [...out].sort();
}

/** import 없이 쓰는 패키지 (pandas .plot()/.hist() 는 내부에서 matplotlib 사용) */
export function implicitPackages(code: string): string[] {
  return /\.(plot|hist|boxplot)\s*\(|\.plot\.[a-z]+\s*\(/.test(code) ? ['matplotlib'] : [];
}

// 이미지 데이터는 base64 문자만 허용 (data: URL 로만 사용)
export function isSafeBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length < 8_000_000;
}

export function truncate(text: string, max = MAX_STREAM_CHARS): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
