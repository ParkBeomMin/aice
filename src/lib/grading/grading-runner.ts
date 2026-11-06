// T-06: 제출 → 채점 → 결과 저장 흐름. 제출본은 한 번 저장되면 바뀌지 않고, 채점 실패 후 재시도도 같은 제출본을 쓴다.
import { gradeCells, GradingFailed, totals, type GradingBackend } from './grader.ts';
import { DISCLAIMER, GRADING_ENGINE_VERSION, RESULT_SCHEMA_VERSION, type AttemptResult, type GradingBundle, type QuestionMeta } from './types.ts';
import { sha256Text, type NotebookSnapshot } from '../runtime/notebook-snapshot.ts';
import { validateSubmissionSnapshot, type ExpectedNotebook } from '../exam/submission.ts';
import { transition } from '../exam/exam-state.ts';
import { StaleOwner, type Attempt, type ExamStore } from '../storage/exam-store.ts';

export interface GradingConfig {
  packId: string; fingerprint: string; questionIds: string[]; questions: QuestionMeta[];
  grading: { url: string; sha256: string; grading_version: string; engine_version: string } | null;
}
export class SubmitError extends Error {}

export async function loadBundle(cfg: GradingConfig, fetchFn: typeof fetch = fetch): Promise<GradingBundle | null> {
  if (!cfg.grading) return null;
  const res = await fetchFn(cfg.grading.url, { cache: 'no-cache' });
  if (!res.ok) throw new GradingFailed(`채점 규칙을 불러오지 못함 (HTTP ${res.status})`);
  const text = await res.text();
  if ((await sha256Text(text)) !== cfg.grading.sha256) throw new GradingFailed('채점 규칙 파일이 Manifest 해시와 다릅니다 (변조 또는 캐시 불일치)');
  const b = JSON.parse(text) as GradingBundle;
  if (b.pack_id !== cfg.packId || b.grading_version !== cfg.grading.grading_version) throw new GradingFailed('채점 규칙의 pack/version 이 Manifest 와 다릅니다');
  if (b.engine_version !== GRADING_ENGINE_VERSION) throw new GradingFailed(`지원하지 않는 채점 엔진 버전 ${b.engine_version}`);
  return b;
}

const expected = (cfg: GradingConfig): ExpectedNotebook => ({ packId: cfg.packId, fingerprint: cfg.fingerprint, questionIds: cfg.questionIds });

/** 스냅샷 검증 → 제출본+시도 상태를 한 트랜잭션으로 커밋. 이미 제출본이 있으면 기존 것을 사용 (중복 제출 방지) */
export async function commitSubmission(store: ExamStore, attempt: Attempt, snapshot: NotebookSnapshot, reason: 'manual' | 'expired' | 'practice', cfg: GradingConfig, gen?: number) {
  const errs = await validateSubmissionSnapshot(snapshot, expected(cfg));
  if (errs.length) throw new SubmitError(`제출 스냅샷 검증 실패: ${errs.join('; ')}`);
  const submittedAt = new Date().toISOString();
  const next = transition({ ...attempt, status: 'submitting' }, 'grading', { submitted_at: submittedAt, submit_reason: reason, snapshot_hash: snapshot.snapshotSha256 });
  return store.commitSubmission({ attempt_id: attempt.attempt_id, pack_id: attempt.pack_id, mode: attempt.mode, submitted_at: submittedAt, submit_reason: reason, snapshot },
    { status: next.status, submitted_at: next.submitted_at, submit_reason: next.submit_reason, snapshot_hash: next.snapshot_hash }, gen);
}

/** 저장된 제출본으로 채점. 실패하면 grading_failed 로 기록 (재시도 가능) */
export async function gradeSubmission(store: ExamStore, attemptId: string, cfg: GradingConfig, backendFactory: () => GradingBackend,
  packagesFor: (i: string[]) => string[], onProgress?: (qid: string, i: number, n: number) => void, gen?: number): Promise<AttemptResult> {
  const put = (a: Attempt) => (gen === undefined ? store.putAttempt(a) : store.putAttemptFenced(a, gen));
  const existing = await store.getResult(attemptId);
  if (existing) return existing;
  const sub = await store.getSubmission(attemptId);
  let att = await store.getAttempt(attemptId);
  if (!sub || !att) throw new GradingFailed('제출본 또는 시도 기록이 없습니다');
  if (att.status === 'grading_failed') att = await put(transition(att, 'grading', { grading_error: null }));
  const t0 = performance.now();
  try {
    const errs = await validateSubmissionSnapshot(sub.snapshot, expected(cfg));
    if (errs.length) throw new GradingFailed(`제출본 검증 실패: ${errs.join('; ')}`);
    const bundle = await loadBundle(cfg);
    const questions = await gradeCells({ cells: sub.snapshot.cells, questions: cfg.questions, bundle, backendFactory, packagesFor, onProgress });
    const r: AttemptResult = {
      schema_version: RESULT_SCHEMA_VERSION, attempt_id: attemptId, pack_id: att.pack_id, mode: att.mode,
      notebook_fingerprint: sub.snapshot.notebookFingerprint, snapshot_sha256: sub.snapshot.snapshotSha256,
      grading_version: bundle?.grading_version ?? 'none', engine_version: GRADING_ENGINE_VERSION,
      started_at: att.started_at, submitted_at: sub.submitted_at, completed_at: new Date().toISOString(),
      grading_ms: Math.round(performance.now() - t0), submit_reason: sub.submit_reason, questions, totals: totals(questions), disclaimer: DISCLAIMER,
    };
    return (await store.commitResult(r, gen)).result; // 실전은 소유권 세대 확인 (R1.1)
  } catch (e) {
    if (e instanceof StaleOwner) throw e; // 소유권 상실은 채점 실패가 아님 → 상태를 바꾸지 않고 그대로 전달
    const msg = (e as Error).message || String(e);
    const cur = await store.getAttempt(attemptId);
    if (cur && cur.status === 'grading') await put(transition(cur, 'grading_failed', { grading_error: msg })).catch(() => {}); // 소유권을 잃었으면 기록하지 않음
    throw e instanceof GradingFailed ? e : new GradingFailed(msg);
  }
}
