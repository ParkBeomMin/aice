// Worker 생명주기, 세션, 실행 큐, 시간 제한 관리. 무한 루프 등은 Worker 종료 후 새 커널로 복구 (SharedArrayBuffer 인터럽트 미사용).
// T-05-R1 FIX-03: 초기화, 패키지 로딩 watchdog, Worker 오류 시 모든 대기 요청 실패 처리, epoch 기반으로 재시작 이전 요청이 새 커널에서 실행되지 않게 함.
import { PYODIDE_INDEX_URL, isFromWorker, type DatasetSpec, type FromWorker, type Output } from './worker-protocol.ts';

export type KernelState = 'idle' | 'loading' | 'ready' | 'busy' | 'error' | 'dead';
/**
 * ok/error: 사용자 코드 실행 완료 (error = Python 예외)
 * timeout: 사용자 코드 실행 시간 제한 초과 → 커널 재시작
 * restarted: 사용자 중단, 커널 재시작으로 끝남
 * kernel_error: Python 런타임 초기화, 패키지 로딩, Worker 자체 실패 (사용자 코드 결과 아님)
 * cancelled: 대기 중 커널이 재시작/실패하여 실행하지 않음
 */
export type ExecStatus = 'ok' | 'error' | 'timeout' | 'restarted' | 'kernel_error' | 'cancelled';
export interface ExecResult {
  status: ExecStatus; executionCount: number | null; outputs: Output[]; durationMs: number; packageMs: number;
  cellId: string; requestId: string | null; sessionId: string | null; error?: string;
}
export interface KernelEvents {
  onState(state: KernelState, detail?: string): void;
  onOutput(cellId: string, output: Output, requestId: string): void;
  onCellStarted(cellId: string, requestId: string): void;
  onPackages(cellId: string, packages: string[], requestId: string): void;
  onMetric?(name: string, ms: number): void;
}
export interface KernelOptions {
  /** INIT_KERNEL ~ 데이터셋 적재 완료까지 제한 (기본 90초). */
  initTimeoutMs?: number;
  /** EXECUTE_CELL 전송 ~ CELL_STARTED(패키지 로딩 완료)까지 제한 (기본 180초). 사용자 코드 시간 제한과 별도. */
  packageTimeoutMs?: number;
  indexURL?: string;
}
export const DEFAULT_INIT_TIMEOUT_MS = 90_000;
export const DEFAULT_PACKAGE_TIMEOUT_MS = 180_000;

let seq = 0;
/** 제한 시간 표시: 1초 미만은 ms */
export const fmtLimit = (ms: number) => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}초`);
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

class KernelInitError extends Error {
  kind: 'failed' | 'restarted';
  constructor(message: string, kind: 'failed' | 'restarted') { super(message); this.kind = kind; }
}

interface CurrentRun { requestId: string; cellId: string; finish: (r: Partial<ExecResult> & { status: ExecStatus }) => void }

export class PyodideKernel {
  private worker: Worker | null = null;
  private session = '';
  /** 재시작, 실패마다 증가. 이전 epoch 에 등록된 대기 요청은 실행하지 않는다. */
  private epoch = 0;
  private state: KernelState = 'idle';
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { cellId: string; on: (m: FromWorker) => void }>();
  private ready: Promise<void> | null = null;
  private abortInit: ((e: KernelInitError) => void) | null = null;
  private current: CurrentRun | null = null;
  private jobs = 0;
  private datasets: DatasetSpec[];
  private ev: KernelEvents;
  private workerFactory: () => Worker;
  private opts: Required<KernelOptions>;
  lastError = '';

  constructor(datasets: DatasetSpec[], ev: KernelEvents, workerFactory: () => Worker, opts: KernelOptions = {}) {
    this.datasets = datasets; this.ev = ev; this.workerFactory = workerFactory;
    this.opts = { initTimeoutMs: opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS, packageTimeoutMs: opts.packageTimeoutMs ?? DEFAULT_PACKAGE_TIMEOUT_MS, indexURL: opts.indexURL ?? PYODIDE_INDEX_URL };
  }

  get status() { return this.state; }
  get sessionId() { return this.session; }
  /** 대기, 실행 중인 셀 요청 수 */
  get activeJobs() { return this.jobs; }
  private set(state: KernelState, detail?: string) { this.state = state; this.ev.onState(state, detail); }

  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    const session = (this.session = nextId('session'));
    let w: Worker;
    try { w = this.workerFactory(); } catch (e) {
      const msg = `Worker 생성 실패: ${(e as Error).message}`;
      this.lastError = msg; this.set('error', msg);
      return Promise.reject(new KernelInitError(msg, 'failed'));
    }
    this.worker = w;
    this.set('loading', 'Python 런타임 다운로드 중');
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => { settled = true; clearTimeout(watchdog); if (this.abortInit === abort) this.abortInit = null; };
      const abort = (e: KernelInitError) => { if (settled) return; settle(); reject(e); };
      const fail = (msg: string) => { if (settled) return; settle(); this.failKernel(session, msg); reject(new KernelInitError(msg, 'failed')); };
      this.abortInit = abort;
      const watchdog = setTimeout(() => fail(`Python 준비 시간 초과 (${fmtLimit(this.opts.initTimeoutMs)}). 네트워크/CDN 상태를 확인하세요`), this.opts.initTimeoutMs);
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (!isFromWorker(m) || m.sessionId !== session || this.session !== session) return; // 이전 세션의 늦은 응답 무시
        if (m.type === 'KERNEL_STATUS') {
          if (m.status === 'error') { if (!settled) fail(m.detail || 'Python 초기화 실패'); else this.failKernel(session, m.detail || 'Python 런타임 오류'); }
          else if (!settled) this.ev.onState('loading', m.detail);
          return;
        }
        if (m.type === 'KERNEL_READY') {
          if (settled) return;
          this.ev.onMetric?.('kernel_init_ms', m.ms);
          const rid = nextId('ds');
          this.pending.set(rid, { cellId: '', on: (r) => {
            this.pending.delete(rid);
            if (r.type === 'DATASETS_LOADED') { if (settled) return; settle(); this.ev.onMetric?.('datasets_ms', r.ms); this.set('ready', `Python ${m.pythonVersion}, 데이터 ${r.files.join(', ')}`); resolve(); }
            else if (r.type === 'DATASETS_ERROR') fail(r.error);
          } });
          w.postMessage({ type: 'LOAD_DATASETS', sessionId: session, requestId: rid, datasets: this.datasets });
          return;
        }
        if ('requestId' in m) {
          const p = this.pending.get(m.requestId);
          if (!p) return; // 이미 끝났거나 모르는 요청
          if ('cellId' in m && p.cellId && m.cellId !== p.cellId) return; // 요청-셀 매핑이 다르면 무시
          if (m.type === 'CELL_OUTPUT') { this.ev.onOutput(m.cellId, m.output, m.requestId); return; }
          if (m.type === 'PACKAGES_LOADING') { this.ev.onPackages(m.cellId, m.packages, m.requestId); return; }
          if (m.type === 'CELL_STARTED') this.ev.onCellStarted(m.cellId, m.requestId);
          p.on(m);
        }
      };
      const onWorkerError = (msg: string) => { if (this.session !== session) return; if (!settled) fail(msg); else this.failKernel(session, msg); };
      w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); onWorkerError(`Worker 오류: ${e.message || '알 수 없는 오류'}`); };
      w.onmessageerror = () => onWorkerError('Worker 메시지 해석 실패');
      w.postMessage({ type: 'INIT_KERNEL', sessionId: session, indexURL: this.opts.indexURL });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  /** 셀 실행. 하나의 커널에서 순차 실행 (큐). timeoutMs 는 패키지 로딩 이후 사용자 코드 실행 시간에만 적용. 절대 reject 하지 않는다. */
  executeCell(cellId: string, code: string, timeoutMs: number): Promise<ExecResult> {
    const epoch = this.epoch;
    this.jobs++;
    const job = this.queue.then(() => this.run(cellId, code, timeoutMs, epoch)).finally(() => { this.jobs--; });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private base(cellId: string, status: ExecStatus, extra: Partial<ExecResult> = {}): ExecResult {
    return { status, executionCount: null, outputs: [], durationMs: 0, packageMs: 0, cellId, requestId: null, sessionId: null, ...extra };
  }

  private async run(cellId: string, code: string, timeoutMs: number, epoch: number): Promise<ExecResult> {
    if (epoch !== this.epoch) return this.base(cellId, 'cancelled');
    try { await this.initialize(); } catch (e) {
      const err = e as KernelInitError;
      return this.base(cellId, err.kind === 'restarted' ? 'restarted' : 'kernel_error', { error: err.message });
    }
    if (epoch !== this.epoch || !this.worker) return this.base(cellId, 'cancelled');
    const w = this.worker;
    const session = this.session;
    const requestId = nextId('req');
    this.set('busy');
    return new Promise<ExecResult>((resolve) => {
      let packageMs = 0;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (r: Partial<ExecResult> & { status: ExecStatus }) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (this.current?.requestId === requestId) this.current = null;
        this.pending.delete(requestId);
        if (this.state === 'busy' && this.session === session) this.set('ready');
        resolve({ ...this.base(cellId, r.status), packageMs, ...r, cellId, requestId, sessionId: session });
      };
      this.current = { requestId, cellId, finish };
      // 패키지 로딩 watchdog: CELL_STARTED 가 오기 전까지
      timer = setTimeout(() => {
        const msg = `패키지 불러오기 시간 초과 (${fmtLimit(this.opts.packageTimeoutMs)}). 네트워크 상태를 확인하고 다시 실행하세요`;
        this.hardRestart(msg, 'kernel_error', { error: msg });
        this.initialize().catch(() => {});
      }, this.opts.packageTimeoutMs);
      this.pending.set(requestId, { cellId, on: (m) => {
        if (m.type === 'CELL_STARTED') {
          packageMs = m.packageMs;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            this.hardRestart('시간 제한 초과로 실행을 중단했습니다', 'timeout', { durationMs: timeoutMs });
            this.initialize().catch(() => {}); // 새 커널 미리 준비 (변수는 초기화된 상태)
          }, timeoutMs);
        } else if (m.type === 'CELL_COMPLETED' || m.type === 'CELL_ERROR') {
          finish({ status: m.type === 'CELL_COMPLETED' ? 'ok' : 'error', executionCount: m.executionCount, outputs: m.outputs, durationMs: m.durationMs });
        }
      } });
      try { w.postMessage({ type: 'EXECUTE_CELL', sessionId: session, requestId, cellId, code }); }
      catch (e) { this.failKernel(session, `Worker 전송 실패: ${(e as Error).message}`); }
    });
  }

  /** 실행 중단: Worker 를 종료하고 새 커널을 준비 (변수 초기화). 초기화, 패키지 로딩 중인 요청도 중단할 수 있다. */
  interrupt(reason = '사용자가 실행을 중단했습니다') {
    if (this.state !== 'busy' && !(this.state === 'loading' && this.jobs > 0)) return;
    this.hardRestart(reason, 'restarted');
    this.initialize().catch(() => {});
  }

  async restartKernel(reason = '커널을 재시작했습니다'): Promise<void> {
    this.hardRestart(reason, 'restarted');
    await this.initialize();
  }

  /** 초기화 실패 후 다시 시도 */
  retry(): Promise<void> { return this.restartKernel('Python 실행 환경을 다시 준비합니다'); }

  /** Worker 종료 + 실행 중 요청 마무리 + 대기 요청 무효화(epoch 증가) */
  private hardRestart(reason: string, status: ExecStatus, extra: Partial<ExecResult> = {}) {
    this.teardown(new KernelInitError(reason, 'restarted'));
    const cur = this.current; this.current = null;
    cur?.finish({ status, ...extra });
    this.set('dead', `${reason}. Python 변수는 초기화됩니다`);
  }

  /** 초기화 실패, Worker 오류: 현재, 대기 요청을 kernel_error/cancelled 로 끝내고 error 상태로 둔다 (자동 재시도 없음). */
  private failKernel(session: string, msg: string) {
    if (session !== this.session) return;
    this.lastError = msg;
    this.teardown(new KernelInitError(msg, 'failed'));
    const cur = this.current; this.current = null;
    cur?.finish({ status: 'kernel_error', error: msg });
    this.set('error', msg);
  }

  private teardown(initErr: KernelInitError) {
    this.epoch++;
    const w = this.worker;
    this.worker = null;
    if (w) { w.onmessage = null; w.onerror = null; w.onmessageerror = null; try { w.terminate(); } catch { /* 이미 종료 */ } }
    this.ready = null;
    this.session = '';
    const ab = this.abortInit; this.abortInit = null;
    ab?.(initErr);
    this.pending.clear();
    this.queue = Promise.resolve();
  }

  dispose() { this.teardown(new KernelInitError('종료', 'restarted')); const cur = this.current; this.current = null; cur?.finish({ status: 'cancelled' }); this.set('dead'); }
}
