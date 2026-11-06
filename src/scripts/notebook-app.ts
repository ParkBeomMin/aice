// 공개 문제 노트북: 로드, 렌더링 (T-04) + Pyodide 실행, 자동 저장 (T-05) + 실행, 저장 안정화, 제출 스냅샷 (T-05-R1).
import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { keymap } from '@codemirror/view';
import { Prec, Compartment, EditorState } from '@codemirror/state';
import { renderMarkdown, escapeHtml } from '../lib/notebook/markdown';
import { PyodideKernel, type KernelState, type ExecStatus } from '../lib/runtime/kernel-adapter.ts';
import { renderOutput } from '../lib/runtime/output-render.ts';
import type { DatasetSpec } from '../lib/runtime/worker-protocol.ts';
import { RunCoordinator, isStaleResult, type RunTicket } from '../lib/runtime/run-coordinator.ts';
import { createNotebookSnapshot, sha256Text, type NotebookSnapshot } from '../lib/runtime/notebook-snapshot.ts';
import { IndexedDbStorage, type Draft, type DraftStore } from '../lib/storage/indexeddb-storage.ts';
import { DraftSaver } from '../lib/storage/draft-saver.ts';
import { DEBUG, expose } from '../lib/debug.ts';

interface NbCell { cell_type: string; id: string; metadata: { tags?: string[] }; source: string | string[]; outputs?: unknown[]; execution_count?: number | null }
interface Nb { nbformat: number; nbformat_minor: number; metadata: Record<string, unknown>; cells: NbCell[] }
interface CellUi {
  id: string; qid: string | null; view: EditorView; label: HTMLElement; out: HTMLElement; runBtn: HTMLButtonElement; external: boolean; maxMs: number; original: string;
  /** 현재 화면 출력이 실행한 코드 (실행 시작 시점에 고정). 실행 중에도 이 값과 비교해 stale 표시 */
  ranSource: string | null;
  running: RunTicket | null;
}
type RunOutcome = ExecStatus | 'skipped' | 'rejected';

export interface NotebookOptions {
  mode: 'practice' | 'exam';
  /** 실전 시도 초안 범위 ('exam:<attempt_id>'). 없으면 연습 초안 */
  scope?: string;
  /** false 면 저장하지 않음 (다른 탭이 시험 소유권을 가져감) */
  canWrite?: () => boolean;
  /** (T-06-R1) 실전: 소유권 세대를 확인하는 초안 저장소 */
  draftStore?: DraftStore;
}
export interface NotebookController {
  /** 노트북 렌더 + 초안 복구 완료 */
  ready: Promise<void>;
  snapshot(): Promise<NotebookSnapshot>;
  /** 편집, 실행 잠금 (제출 중, 시간 만료, 다른 탭 소유) */
  setLocked(locked: boolean, reason?: string): void;
  isRunning(): boolean;
  interrupt(): void;
  flushSave(): Promise<boolean>;
  disposeKernel(): void;
  notice(msg: string, kind?: 'info' | 'warn' | 'error', actions?: [string, () => void][]): void;
  exportNotebook(override?: Draft['cells']): Blob;
  download(blob: Blob, name: string): void;
}

export function startNotebook(opts: NotebookOptions = { mode: 'practice' }): NotebookController {
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('nb-root');
const statusEl = $('nb-status');
const navEl = $('nb-nav');
const progressEl = $('nb-progress');
const kernelEl = $('nb-kernel');
const saveEl = $('nb-save-status');
const noticeEl = $('nb-notice');
const btn = (id: string) => $<HTMLButtonElement>(id);
const packId = root.dataset.packId!;
const fingerprint = root.dataset.fingerprint!;
const runtime: Record<string, { type: string; max_ms: number }> = JSON.parse(root.dataset.runtime || '{}');
const datasets: DatasetSpec[] = JSON.parse(root.dataset.datasets || '[]');
const cells = new Map<string, CellUi>();
const order: string[] = [];
let notebook: Nb | null = null;
const metrics: Record<string, number> = {};
const runs = new RunCoordinator();
const pageWriter = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const runLog: { cellId: string; token: number; status: RunOutcome; stale: boolean; at: string }[] = [];
let locked = false;
const editable = new Compartment();
const editableExt = (on: boolean) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
expose('__acf', { metrics, cells, runs, runLog, snapshot: () => getNotebookSnapshot(), saver: () => saver, kernel: () => kernel });
const src = (s: string | string[]) => (Array.isArray(s) ? s.join('') : s);

function notice(msg: string, kind: 'info' | 'warn' | 'error' = 'info', actions: [string, () => void][] = []) {
  noticeEl.hidden = false;
  noticeEl.className = `nb-notice ${kind}`;
  noticeEl.replaceChildren(document.createTextNode(msg));
  for (const [label, fn] of actions) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; noticeEl.append(' ', b); }
  const x = document.createElement('button'); x.type = 'button'; x.textContent = '닫기'; x.onclick = () => { noticeEl.hidden = true; }; noticeEl.append(' ', x);
}

// ---------------- 커널 ----------------
const KSTATE: Record<KernelState, string> = { idle: 'Python 시작 전', loading: 'Python 준비 중…', ready: 'Python 준비 완료', busy: '실행 중…', error: 'Python 오류', dead: '커널 중지됨' };
const kernel = new PyodideKernel(datasets, {
  onState(state, detail) {
    kernelEl.textContent = `● ${KSTATE[state]}`;
    kernelEl.dataset.state = state;
    kernelEl.title = detail ?? '';
    syncInterrupt(state);
    if (state === 'dead' && detail) {
      for (const c of cells.values()) if (!c.running) c.label.textContent = c.external ? 'In [-]:' : 'In [ ]:';
      notice(`${detail}. 작성한 코드는 그대로 있습니다. 필요한 셀을 위에서부터 다시 실행하세요.`, 'warn');
    }
    if (state === 'error') notice(`Python 실행 환경 오류: ${detail ?? ''}. 작성한 코드는 그대로 있습니다.`, 'error', [['Python 다시 준비', () => { kernel.retry().catch(() => {}); }]]);
  },
  onOutput(cellId, o) { const c = cells.get(cellId); if (c?.running) c.out.append(renderOutput(o)); },
  onCellStarted(cellId) { const c = cells.get(cellId); if (c?.running) { c.label.textContent = 'In [*]:'; c.out.querySelector('.nb-pkg')?.remove(); } },
  onPackages(cellId, pk) { const c = cells.get(cellId); if (c?.running) { const d = document.createElement('div'); d.className = 'nb-pkg'; d.textContent = `패키지 불러오는 중: ${pk.join(', ')} (처음 한 번만)`; c.out.append(d); } },
  onMetric(name, ms) { metrics[name] = ms; },
}, () => new Worker(new URL('../lib/runtime/kernel.worker.ts', import.meta.url), { type: 'module' }), kernelOptions());

function kernelOptions() {
  // 검증용: ?acf_init_timeout_ms= / ?acf_pkg_timeout_ms= / ?acf_index_url= (기본값은 운영 값)
  if (!DEBUG) return {}; // production 에서는 URL 로 런타임 설정을 바꿀 수 없음
  const q = new URLSearchParams(location.search);
  const num = (k: string) => { const v = Number(q.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const idx = q.get('acf_index_url');
  return { initTimeoutMs: num('acf_init_timeout_ms'), packageTimeoutMs: num('acf_pkg_timeout_ms'), indexURL: idx && /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//.test(idx) ? idx : undefined };
}
function syncInterrupt(state: KernelState = kernel.status) {
  btn('nb-interrupt').disabled = !(state === 'busy' || (state === 'loading' && kernel.activeJobs > 0));
}

const note = (className: string, textContent: string) => Object.assign(document.createElement('div'), { className, textContent });

function setStale(c: CellUi, reason: 'edited' | 'edited-during-run' | null) {
  c.out.classList.toggle('stale', reason !== null);
  if (reason) c.out.dataset.staleReason = reason; else delete c.out.dataset.staleReason;
}

/** 셀 실행. 같은 셀 중복 요청, 전체 실행 중 개별 요청은 거부한다 (FIX-01). */
async function runCell(id: string, opts: { fromRunAll?: boolean } = {}): Promise<RunOutcome> {
  const c = cells.get(id);
  if (!c) return 'skipped';
  if (locked) return 'rejected';
  if (c.external) {
    c.out.replaceChildren(note('nb-pkg', '이 문항은 브라우저 실행을 지원하지 않습니다 (딥러닝 등). Colab 등 외부 환경에서 실행하세요.'));
    return 'skipped';
  }
  const code = c.view.state.doc.toString(); // 실행 소스 고정
  const req = runs.request(id, code, opts);
  if (!req.ok) {
    if (req.reason === 'run_all_active') notice('전체 실행 중에는 개별 셀을 실행할 수 없습니다. 끝날 때까지 기다리거나 ■ 실행 중단을 누르세요.', 'warn');
    else notice(`${(c.qid ?? id).toUpperCase()} 셀은 이미 실행 중이거나 대기 중입니다.`, 'info');
    return 'rejected';
  }
  const ticket = req.ticket;
  c.running = ticket;
  c.ranSource = code;
  c.out.replaceChildren();
  setStale(c, null);
  c.label.textContent = 'In [*]:';
  c.runBtn.disabled = true;
  c.out.dataset.runToken = String(ticket.token);
  const t0 = performance.now();
  const p = kernel.executeCell(id, code, c.maxMs);
  syncInterrupt();
  const r = await p;
  const isLatest = runs.complete(ticket);
  if (c.running?.token === ticket.token) c.running = null;
  c.runBtn.disabled = runs.runAllActive || locked; // 전체 실행 중, 잠금 중에는 비활성
  syncInterrupt();
  const stale = isStaleResult(code, c.view.state.doc.toString());
  runLog.push({ cellId: id, token: ticket.token, status: r.status, stale, at: new Date().toISOString() });
  if (!isLatest) return r.status; // 더 새 실행이 화면을 갖고 있음
  metrics[`last_exec_ms`] = r.durationMs;
  metrics[`last_total_ms`] = Math.round(performance.now() - t0);
  if (r.packageMs) metrics[`packages_ms_${id}`] = r.packageMs;
  c.label.textContent = r.executionCount ? `In [${r.executionCount}]:` : 'In [ ]:';
  c.label.dataset.status = r.status;
  if (r.status !== 'ok' && r.status !== 'error') c.out.querySelector('.nb-pkg')?.remove(); // 끝나지 못한 '패키지 불러오는 중' 안내 정리
  void sha256Text(code).then((h) => { if (c.out.dataset.runToken === String(ticket.token)) c.out.dataset.ranSha = h; }); // 출력이 어떤 코드의 결과인지 (검증, T-06 대조용)
  if (r.status === 'timeout') c.out.append(note('nb-out nb-out-error', `시간 제한(${Math.round(c.maxMs / 1000)}초)을 넘어 실행을 중단했습니다. 커널이 다시 시작되어 변수가 초기화되었습니다.`));
  if (r.status === 'restarted') c.out.append(note('nb-pkg', '실행이 중단되었습니다.'));
  if (r.status === 'cancelled') c.out.append(note('nb-pkg', '커널이 재시작되어 이 셀은 실행하지 않았습니다.'));
  if (r.status === 'kernel_error') c.out.append(note('nb-out nb-out-error', `Python 실행 환경 오류로 실행하지 못했습니다: ${r.error ?? ''}`));
  if (r.status === 'ok' && !c.out.childElementCount) c.out.append(note('nb-pkg', `완료 (${r.durationMs}ms)`));
  if (stale) setStale(c, 'edited-during-run');
  return r.status;
}

async function runAll() {
  const token = runs.beginRunAll();
  if (token === null) return;
  btn('nb-run-all').disabled = true;
  for (const c of cells.values()) if (!c.external) c.runBtn.disabled = true;
  const skipped: string[] = [];
  let stoppedAt: string | null = null;
  try {
    for (const id of order) {
      const c = cells.get(id)!;
      if (c.external) { skipped.push(c.qid ?? id); await runCell(id, { fromRunAll: true }); continue; }
      c.out.closest('section')?.scrollIntoView({ block: 'nearest' });
      const st = await runCell(id, { fromRunAll: true });
      if (st !== 'ok') { stoppedAt = c.qid ?? id; break; }
    }
  } finally {
    runs.endRunAll(token);
    btn('nb-run-all').disabled = false;
    for (const c of cells.values()) if (!c.external && !c.running) c.runBtn.disabled = locked;
  }
  const parts = [stoppedAt ? `${stoppedAt.toUpperCase()} 에서 멈췄습니다 (오류/중단). 이후 셀은 실행하지 않았습니다.` : '모든 셀을 실행했습니다.'];
  if (skipped.length) parts.push(`브라우저 미지원으로 건너뜀: ${skipped.map((s) => s.toUpperCase()).join(', ')}`);
  notice(parts.join(' '), stoppedAt ? 'warn' : 'info');
}

// ---------------- 저장 ----------------
// 정책 (FIX-02): 편집 800ms 후 자동 저장, 저장은 직렬화, '저장됨' 표시는 IndexedDB 커밋 완료 후.
// 페이지 숨김(visibilitychange), 이탈(pagehide)에는 즉시 저장을 시작하고, 커밋 전 변경이 남아 있으면 beforeunload 경고를 띄운다.
const timeStr = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const drafts: DraftStore = opts.draftStore ?? IndexedDbStorage;
const saver = new DraftSaver(drafts, {
  packId, fingerprint, writer: pageWriter, scope: opts.scope, canWrite: opts.canWrite,
  collect: () => { const now = new Date().toISOString(); const data: Draft['cells'] = {}; for (const [id, c] of cells) data[id] = { source: c.view.state.doc.toString(), updatedAt: now }; return data; },
  onEvent(e) {
    saveEl.dataset.saveState = e.type;
    if (e.type === 'dirty') saveEl.textContent = saver.saving ? '저장 중… (새 변경 있음)' : '변경됨, 저장 대기';
    else if (e.type === 'saving') saveEl.textContent = '저장 중…';
    else if (e.type === 'saved') saveEl.textContent = e.latest ? `저장됨 ${timeStr(e.at)} (이 브라우저)` : '저장 중… (새 변경 있음)';
    else if (e.type === 'cleared') saveEl.textContent = '초기화됨 (저장된 초안 삭제)';
    else if (e.type === 'error') {
      saveEl.textContent = '저장 실패';
      notice(`자동 저장 실패: ${e.error}. 코드를 잃지 않으려면 '내 노트북 다운로드'를 사용하세요.`, 'error', [['다시 저장', () => { void saver.flush(); }]]);
    }
  },
});
let programmaticEdit = false; // 복구, 초기화로 인한 변경은 편집으로 보지 않음
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saver.flushOnLeave(); });
addEventListener('pagehide', () => saver.flushOnLeave());
addEventListener('beforeunload', (e) => { if (saver.dirty) { saver.flushOnLeave(); e.preventDefault(); } });

async function restore() {
  try {
    const d = await drafts.loadDraft(packId, fingerprint, opts.scope);
    if (d) {
      let n = 0;
      for (const [id, v] of Object.entries(d.cells)) {
        const c = cells.get(id);
        if (c && v.source !== c.view.state.doc.toString()) { programmaticEdit = true; try { c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: v.source } }); } finally { programmaticEdit = false; } n++; }
      }
      saveEl.textContent = `복구됨 (${new Date(d.updatedAt).toLocaleString('ko-KR')})`;
      if (n) notice(`이전에 작성한 코드 ${n}개 셀을 복구했습니다. Python 변수는 복구되지 않으니 필요한 셀을 다시 실행하세요.`, 'info');
    }
    const others = opts.scope ? [] : (await IndexedDbStorage.listDrafts(packId)).filter((x) => !x.scope && x.fingerprint !== fingerprint);
    if (others.length) {
      const o = others.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      notice('문제 노트북이 개정되어 이전 개정판에서 작성한 코드는 자동으로 불러오지 않았습니다.', 'warn', [
        ['이전 코드 다운로드', () => download(exportNotebook(o.cells), `${packId}-previous-draft.ipynb`)],
      ]);
    }
  } catch (e) {
    saveEl.textContent = '자동 저장 사용 불가';
    notice(`이 브라우저에서는 자동 저장을 쓸 수 없습니다 (${(e as Error).message}). 시크릿 모드나 저장소 차단 여부를 확인하고, 다운로드로 보관하세요.`, 'warn');
  }
}

// ---------------- 렌더링 ----------------
function renderCell(cell: NbCell, n: number): HTMLElement {
  const sec = document.createElement('section');
  sec.className = `nb-cell nb-${cell.cell_type}`;
  sec.id = cell.id;
  const tag = cell.metadata?.tags?.[0] ?? '';
  const qid = /^q\d{2}-/.test(tag) ? tag.slice(0, 3) : null;
  if (qid) sec.dataset.qid = qid;
  if (cell.cell_type === 'markdown') {
    const body = document.createElement('div');
    body.className = 'nb-md';
    body.innerHTML = renderMarkdown(src(cell.source)); // 전체 이스케이프 후 제한 태그만
    sec.append(body);
    return sec;
  }
  if (cell.cell_type !== 'code') { const pre = document.createElement('pre'); pre.textContent = src(cell.source); sec.append(pre); return sec; }
  const rt = (qid && runtime[qid]) || { type: 'pyodide', max_ms: 10000 };
  const external = rt.type !== 'pyodide';
  const label = Object.assign(document.createElement('div'), { className: 'nb-in', textContent: external ? 'In [-]:' : 'In [ ]:' });
  label.setAttribute('aria-hidden', 'true');
  const edWrap = document.createElement('div');
  edWrap.className = 'nb-editor';
  edWrap.setAttribute('aria-label', `${qid ? qid.toUpperCase() + ' ' : ''}코드 셀 ${n}`);
  const out = document.createElement('div');
  out.className = 'nb-output';
  out.setAttribute('aria-live', 'polite');
  const bar = document.createElement('div');
  bar.className = 'nb-cellbar';
  const runBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: external ? '브라우저 실행 미지원' : '▶ 실행' }) as HTMLButtonElement;
  runBtn.title = external ? 'Colab 등 외부 환경에서 실행하세요' : 'Shift+Enter: 실행 후 다음 셀, Ctrl/Cmd+Enter: 실행';
  runBtn.disabled = external;
  bar.append(runBtn);
  const runKeys = Prec.highest(keymap.of([
    { key: 'Shift-Enter', run: () => { runCell(cell.id); focusNext(cell.id); return true; } },
    { key: 'Mod-Enter', run: () => { runCell(cell.id); return true; } },
  ]));
  const view = new EditorView({
    doc: src(cell.source),
    extensions: [runKeys, basicSetup, python(), editable.of(editableExt(!locked)), EditorView.theme({ '&': { fontSize: '14px' } }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (!programmaticEdit) saver.markDirty();
        const c = cells.get(cell.id);
        if (c && c.ranSource !== null && c.out.childElementCount) {
          const changed = u.state.doc.toString() !== c.ranSource;
          setStale(c, changed ? (c.running ? 'edited-during-run' : (c.out.dataset.staleReason === 'edited-during-run' ? 'edited-during-run' : 'edited')) : null);
        }
      })],
    parent: edWrap,
  });
  const ui: CellUi = { id: cell.id, qid, view, label, out, runBtn, external, maxMs: rt.max_ms, ranSource: null, running: null, original: src(cell.source) };
  cells.set(cell.id, ui);
  order.push(cell.id);
  runBtn.onclick = () => runCell(cell.id);
  if (external) out.textContent = '이 문항은 브라우저에서 실행할 수 없습니다 (딥러닝 등). 코드는 작성하고 다운로드할 수 있어요.';
  sec.append(label, edWrap, bar, out);
  return sec;
}

function focusNext(id: string) {
  const i = order.indexOf(id);
  const n = order[i + 1];
  if (n) { const c = cells.get(n)!; c.view.focus(); c.view.dom.closest('section')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function buildNav(nbCells: NbCell[]) {
  const prompts = nbCells.filter((c) => /^q\d{2}-prompt$/.test(c.id));
  navEl.innerHTML = '';
  for (const c of prompts) {
    const qid = c.id.slice(0, 3);
    const a = document.createElement('a');
    a.href = `#${c.id}`;
    a.dataset.qid = qid;
    const title = src(c.source).split('\n')[0].replace(/^#+\s*/, '').replace(/^문제 \d+\.\s*/, '');
    a.innerHTML = `<span class="num">${escapeHtml(qid.slice(1))}</span><span class="t">${escapeHtml(title)}</span>`;
    navEl.append(a);
  }
  const total = String(prompts.length).padStart(2, '0');
  const setCurrent = (qid: string) => { navEl.querySelectorAll('a').forEach((a) => a.classList.toggle('current', a.dataset.qid === qid)); progressEl.textContent = `문제 ${qid.slice(1)} / ${total}`; };
  if (prompts[0]) setCurrent(prompts[0].id.slice(0, 3));
  const io = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    const qid = (vis[0]?.target as HTMLElement | undefined)?.dataset.qid;
    if (qid) setCurrent(qid);
  }, { rootMargin: '-20% 0px -60% 0px' });
  root.querySelectorAll<HTMLElement>('[data-qid]').forEach((el) => io.observe(el));
}

// ---------------- 제출 스냅샷 (FIX-04, T-06 에서 사용) ----------------
/** 현재 에디터의 코드 셀 내용을 노트북 순서대로 불변 스냅샷으로 만든다. 실행 결과, 변수는 포함하지 않는다. */
function getNotebookSnapshot(): Promise<NotebookSnapshot> {
  if (!notebook) return Promise.reject(new Error('노트북이 아직 로드되지 않았습니다'));
  return createNotebookSnapshot({ packId, notebookFingerprint: fingerprint, cells: order.map((id) => { const c = cells.get(id)!; return { cellId: id, questionId: c.qid, source: c.view.state.doc.toString() }; }) });
}

// ---------------- 내보내기 ----------------
function exportNotebook(override?: Draft['cells']): Blob {
  const nb = structuredClone(notebook!) as Nb;
  for (const c of nb.cells) {
    if (c.cell_type !== 'code') continue;
    if (override) { if (override[c.id]) c.source = override[c.id].source; }
    else if (cells.has(c.id)) c.source = cells.get(c.id)!.view.state.doc.toString();
    c.outputs = []; c.execution_count = null; // 코드만 저장 (실행 결과 미포함)
  }
  return new Blob([JSON.stringify(nb, null, 1) + '\n'], { type: 'application/x-ipynb+json' });
}
function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function main() {
  const t0 = performance.now();
  try {
    const res = await fetch(root.dataset.notebookUrl!, { cache: 'no-cache' });
    if (!res.ok) { statusEl.textContent = `노트북을 불러오지 못했습니다 (HTTP ${res.status}).`; statusEl.classList.add('error'); return; }
    const nb = (await res.json()) as Nb;
    if (nb.nbformat !== 4 || !Array.isArray(nb.cells)) { statusEl.textContent = '지원하지 않는 노트북 형식입니다.'; statusEl.classList.add('error'); return; }
    notebook = nb;
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const c of nb.cells) frag.append(renderCell(c, c.cell_type === 'code' ? ++n : n));
    root.replaceChildren(frag);
    buildNav(nb.cells);
    metrics.notebook_render_ms = Math.round(performance.now() - t0);
    statusEl.textContent = `코드 셀 ${n}개`;
    for (const id of ['nb-download', 'nb-run-all', 'nb-restart', 'nb-save', 'nb-reset']) btn(id).disabled = false;
    await restore();
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    kernel.initialize().catch(() => {}); // 화면 표시 후 비동기 초기화
  } catch (e) {
    statusEl.textContent = `노트북을 불러오지 못했습니다: ${(e as Error).message}`;
    statusEl.classList.add('error');
  }
}

function setLocked(on: boolean, reason?: string) {
  locked = on;
  for (const c of cells.values()) { c.view.dispatch({ effects: editable.reconfigure(editableExt(!on)) }); if (!c.external) c.runBtn.disabled = on || runs.runAllActive || !!c.running; }
  for (const id of ['nb-run-all', 'nb-restart', 'nb-reset']) btn(id).disabled = on;
  root.classList.toggle('nb-locked', on);
  if (on && reason) notice(reason, 'warn');
}

btn('nb-download').onclick = () => download(exportNotebook(), `${packId}-my-notebook.ipynb`);
btn('nb-run-all').onclick = () => { if (!locked) void runAll(); };
btn('nb-interrupt').onclick = () => kernel.interrupt();
btn('nb-restart').onclick = async () => {
  await kernel.restartKernel().catch(() => {});
  for (const c of cells.values()) { if (c.running) continue; c.out.replaceChildren(); setStale(c, null); c.ranSource = null; c.label.textContent = c.external ? 'In [-]:' : 'In [ ]:'; }
};
btn('nb-save').onclick = () => { void saver.flush(); };
btn('nb-reset').onclick = async () => {
  if (!confirm('작성한 코드를 모두 지우고 문제 노트북 원본으로 되돌릴까요? 이 브라우저에 저장된 초안도 삭제됩니다.')) return;
  programmaticEdit = true;
  try { for (const c of cells.values()) { c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: c.original } }); if (!c.running) { c.out.replaceChildren(); setStale(c, null); c.ranSource = null; } } }
  finally { programmaticEdit = false; }
  try { await saver.clear(); } // 진행 중 저장을 기다린 뒤 삭제, 예약된 저장 취소 → 삭제된 초안이 되살아나지 않음
  catch (e) { saveEl.textContent = '초안 삭제 실패'; notice(`저장된 초안을 지우지 못했습니다: ${(e as Error).message}`, 'error'); }
};

const ready = main();
return {
  ready,
  snapshot: () => getNotebookSnapshot(),
  setLocked,
  isRunning: () => runs.runAllActive || runs.activeCells().length > 0 || kernel.activeJobs > 0,
  interrupt: () => kernel.interrupt('제출을 위해 실행을 중단했습니다'),
  flushSave: () => saver.flush(),
  disposeKernel: () => kernel.dispose(),
  notice,
  exportNotebook,
  download,
};
}
