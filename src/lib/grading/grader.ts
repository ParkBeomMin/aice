// T-06 채점 오케스트레이터 (백엔드 독립). 브라우저는 grading.worker 백엔드, 테스트는 Node Pyodide/가짜 백엔드를 쓴다.
// - 제출 스냅샷의 코드 셀만 노트북 순서대로 새 커널에서 실행 (학습 커널 변수 사용 안 함)
// - 셀마다 해당 문항 프로필 검사. 실행 시간 초과 시 백엔드 교체 후 이전 셀을 재실행(replay)하고 다음 셀로 진행
import type { CheckResult, GradingBundle, GradingTotals, QuestionMeta, QuestionResult, QuestionStatus } from './types.ts';

export interface CellRun { ok: boolean; timedOut?: boolean; error?: { ename: string; evalue: string } | null }
export interface GradingBackend {
  /** 새 Python 상태 + 데이터셋 적재 (무결성 검사) */
  init(): Promise<void>;
  /** 허용 패키지 로딩 후 난수 고정 */
  loadPackages(packages: string[]): Promise<void>;
  runCell(code: string, timeoutMs: number): Promise<CellRun>;
  preCapture(profileJson: string): Promise<void>;
  check(profileJson: string): Promise<CheckResult[]>;
  imports(code: string): Promise<string[]>;
  /** (기대값 도구 전용) probe 값 */
  probe?(probeJson: string): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  dispose(): void;
}
export interface GradeInput {
  cells: readonly { cellId: string; questionId: string | null; source: string }[];
  questions: QuestionMeta[]; bundle: GradingBundle | null;
  backendFactory: () => GradingBackend;
  packagesFor: (imports: string[]) => string[];
  onProgress?: (qid: string, index: number, total: number) => void;
  now?: () => number;
}
export class GradingFailed extends Error {}

const DEP_ERROR: QuestionStatus[] = ['execution_error', 'blocked'];

export const isUnanswered = (meta: QuestionMeta, source: string) => meta.starter_code !== undefined && source.trim() === meta.starter_code.trim();

export function scoreQuestion(meta: QuestionMeta, prof: GradingBundle['questions'][string] | undefined, run: CellRun | null,
  checks: CheckResult[], depStatuses: QuestionStatus[], durationMs: number, unanswered = false): QuestionResult {
  const base = { question_id: meta.question_id, feedback: [] as string[], error_summary: null as string | null, error_kind: null as QuestionResult['error_kind'], checks, duration_ms: durationMs };
  if (meta.runtime.type === 'external' || meta.grading.type === 'self_check')
    return { ...base, status: 'self_check', awarded_points: 0, available_points: 0, feedback: ['브라우저에서 실행하거나 자동 채점하지 않는 문항입니다. 해설을 보고 스스로 점검하세요.'] };
  if (meta.grading.type === 'none' || !prof)
    return { ...base, status: 'ungraded', awarded_points: 0, available_points: 0, feedback: [meta.grading.type === 'none' ? '자동 채점 대상이 아닌 문항입니다.' : '검증된 채점 규칙이 아직 없어 채점하지 않았습니다.'] };
  const pts = prof.points;
  // 미작성: 앞 셀들이 만든 상태 때문에 일부 검사가 우연히 통과해도 점수를 주지 않음
  if (unanswered) return { ...base, checks: [], status: 'incorrect', awarded_points: 0, available_points: pts, feedback: ['풀이를 작성하지 않았습니다 (starter 코드 그대로).'] };
  const depFailed = prof.depends_on.filter((_, i) => DEP_ERROR.includes(depStatuses[i]));
  if (!run || !run.ok) {
    const kind = run?.timedOut ? 'timeout' : 'exception';
    const summary = run?.timedOut ? '실행 시간 제한 초과' : `${run?.error?.ename ?? 'Error'}: ${run?.error?.evalue ?? ''}`;
    if (depFailed.length)
      return { ...base, status: 'blocked', awarded_points: 0, available_points: pts, error_kind: kind, error_summary: summary, feedback: [`선행 문항(${depFailed.map((q) => q.toUpperCase()).join(', ')}) 오류로 채점할 수 없습니다.`] };
    return { ...base, status: 'execution_error', awarded_points: 0, available_points: pts, error_kind: kind, error_summary: summary, feedback: ['코드 실행 중 오류가 발생했습니다.'] };
  }
  const total = prof.checks.reduce((s, c) => s + c.weight, 0) || 1;
  const passedW = prof.checks.reduce((s, c) => s + (checks.find((r) => r.id === c.id)?.passed ? c.weight : 0), 0);
  const fb = prof.checks.filter((c) => !checks.find((r) => r.id === c.id)?.passed).map((c) => c.feedback);
  if (passedW >= total) return { ...base, status: 'correct', awarded_points: pts, available_points: pts };
  if (depFailed.length) return { ...base, status: 'blocked', awarded_points: 0, available_points: pts, feedback: [`선행 문항(${depFailed.map((q) => q.toUpperCase()).join(', ')}) 오류로 채점할 수 없습니다.`, ...fb] };
  if (passedW > 0) return { ...base, status: 'partial', awarded_points: Math.round((pts * passedW / total) * 100) / 100, available_points: pts, feedback: fb };
  return { ...base, status: 'incorrect', awarded_points: 0, available_points: pts, feedback: fb };
}

export function totals(results: QuestionResult[]): GradingTotals {
  const gradable = results.filter((r) => r.status !== 'ungraded' && r.status !== 'self_check');
  const awarded = Math.round(gradable.reduce((s, r) => s + r.awarded_points, 0) * 100) / 100;
  const available = gradable.reduce((s, r) => s + r.available_points, 0);
  return {
    awarded_points: awarded, available_points: available, gradable_count: gradable.length,
    correct_count: results.filter((r) => r.status === 'correct').length, partial_count: results.filter((r) => r.status === 'partial').length,
    ungraded_count: results.filter((r) => r.status === 'ungraded').length, self_check_count: results.filter((r) => r.status === 'self_check').length,
    percent: available > 0 ? Math.round((awarded / available) * 1000) / 10 : null,
  };
}

export async function gradeCells(input: GradeInput): Promise<QuestionResult[]> {
  const now = input.now ?? (() => performance.now());
  const metaById = new Map(input.questions.map((q) => [q.question_id, q]));
  const runnable = input.cells.filter((c) => c.questionId && metaById.get(c.questionId)?.runtime.type === 'pyodide');
  const imports = new Set<string>();
  let backend = input.backendFactory();
  const fail = (msg: string, e?: unknown) => { backend.dispose(); return new GradingFailed(`${msg}${e ? `: ${(e as Error).message ?? e}` : ''}`); };
  let packages: string[];
  try {
    await backend.init();
    for (const c of runnable) for (const i of await backend.imports(c.source)) imports.add(i);
    const implicit = runnable.some((c) => /\.(plot|hist|boxplot)\s*\(|\.plot\.[a-z]+\s*\(/.test(c.source)) ? ['matplotlib'] : [];
    packages = input.packagesFor([...imports, ...implicit, 'pandas', 'numpy', 'sklearn']); // 채점 probe 가 쓰는 패키지 포함
    await backend.loadPackages(packages);
  } catch (e) { throw fail('채점 환경 준비 실패', e); }
  const executed: { source: string; timeoutMs: number }[] = [];
  const statuses = new Map<string, QuestionStatus>();
  const results: QuestionResult[] = [];
  const total = input.cells.length;
  try {
    for (let i = 0; i < input.cells.length; i++) {
      const cell = input.cells[i];
      const qid = cell.questionId;
      const meta = qid ? metaById.get(qid) : undefined;
      if (!qid || !meta) continue;
      input.onProgress?.(qid, i, total);
      const prof = input.bundle?.questions[qid];
      const deps = (prof?.depends_on ?? []).map((d) => statuses.get(d) ?? 'ungraded');
      if (meta.runtime.type !== 'pyodide') {
        const r = scoreQuestion(meta, prof, null, [], deps, 0);
        statuses.set(qid, r.status); results.push(r); continue;
      }
      const pj = prof ? JSON.stringify(prof) : null;
      if (pj) await backend.preCapture(pj);
      const t0 = now();
      const run = await backend.runCell(cell.source, meta.runtime.max_execution_ms);
      const dur = Math.round(now() - t0);
      let checks: CheckResult[] = [];
      if (run.timedOut) {
        // 백엔드 교체 + 이전에 끝난 셀 재실행 (시간 초과 셀 자체는 효과 없음으로 간주)
        backend.dispose();
        backend = input.backendFactory();
        await backend.init();
        await backend.loadPackages(packages);
        for (const ex of executed) {
          const rr = await backend.runCell(ex.source, ex.timeoutMs);
          if (rr.timedOut) throw new GradingFailed('재실행 중 시간 제한 초과');
        }
      } else {
        executed.push({ source: cell.source, timeoutMs: meta.runtime.max_execution_ms });
        if (pj && run.ok && !isUnanswered(meta, cell.source)) {
          const raw = await backend.check(pj);
          checks = raw.map((r) => { const c = prof!.checks.find((x) => x.id === r.id); return { ...r, label: c?.label, feedback: c?.feedback }; });
        }
      }
      const r = scoreQuestion(meta, prof, run, checks, deps, dur, isUnanswered(meta, cell.source));
      statuses.set(qid, r.status);
      results.push(r);
    }
  } catch (e) {
    throw e instanceof GradingFailed ? (backend.dispose(), e) : fail('채점 중 오류', e);
  }
  backend.dispose();
  return results;
}
