// T-06: 시험 시도 상태 전이 (순수 로직). 시간은 time_limit_minutes 로 계산 (90분 하드코딩 금지).
import type { Attempt, AttemptStatus } from '../storage/exam-store.ts';

const T: Record<AttemptStatus, AttemptStatus[]> = {
  not_started: ['in_progress'],
  in_progress: ['submitting', 'expired'],
  expired: ['submitting'],
  submitting: ['grading', 'in_progress', 'expired'], // 스냅샷, 저장 실패 시 되돌림 (만료된 시도는 expired 로)
  grading: ['submitted', 'grading_failed'],
  grading_failed: ['grading'], // 같은 제출본으로 재시도
  submitted: [],
};
export const EDITABLE: AttemptStatus[] = ['in_progress'];
export const canTransition = (from: AttemptStatus, to: AttemptStatus) => T[from].includes(to);
export class InvalidTransition extends Error {}

export function transition(a: Attempt, to: AttemptStatus, patch: Partial<Attempt> = {}): Attempt {
  if (!canTransition(a.status, to)) throw new InvalidTransition(`${a.status} → ${to} 전이 불가`);
  return { ...a, ...patch, status: to };
}

let seq = 0;
export function newAttemptId(now = Date.now(), rand = Math.random) {
  return `att-${now.toString(36)}-${(++seq).toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

export function startExamAttempt(o: { packId: string; fingerprint: string; timeLimitMinutes: number; now?: number }): Attempt {
  if (!Number.isFinite(o.timeLimitMinutes) || o.timeLimitMinutes <= 0) throw new Error('time_limit_minutes 가 올바르지 않음');
  const now = o.now ?? Date.now();
  const iso = new Date(now).toISOString();
  return { attempt_id: newAttemptId(now), pack_id: o.packId, notebook_fingerprint: o.fingerprint, mode: 'exam', status: 'in_progress',
    time_limit_minutes: o.timeLimitMinutes, started_at: iso, deadline_at: new Date(now + o.timeLimitMinutes * 60_000).toISOString(),
    submitted_at: null, submit_reason: null, snapshot_hash: null, grading_version: null, grading_error: null, updated_at: iso };
}

export function practiceAttempt(o: { packId: string; fingerprint: string; now?: number }): Attempt {
  const now = o.now ?? Date.now();
  const iso = new Date(now).toISOString();
  return { attempt_id: newAttemptId(now), pack_id: o.packId, notebook_fingerprint: o.fingerprint, mode: 'practice', status: 'submitting',
    time_limit_minutes: null, started_at: iso, deadline_at: null, submitted_at: null, submit_reason: 'practice',
    snapshot_hash: null, grading_version: null, grading_error: null, updated_at: iso };
}

export const remainingMs = (deadlineIso: string, nowMs: number) => Math.max(0, Date.parse(deadlineIso) - nowMs);

/** 남은 시간이 prev → cur 로 줄 때 지나간 안내 시점(분) */
export function crossedWarnings(prevMs: number, curMs: number, thresholdsMin = [10, 5, 1]): number[] {
  return thresholdsMin.filter((m) => prevMs > m * 60_000 && curMs <= m * 60_000);
}

export function formatRemaining(ms: number) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 탭 안에서는 performance.now() 기준으로 마감 시각을 고정 (탭이 열려 있는 동안 시스템 시계 변경 영향 없음) */
export class MonotonicDeadline {
  private perfDeadline: number;
  constructor(deadlineIso: string, nowWall = Date.now(), nowPerf = performance.now()) { this.perfDeadline = nowPerf + (Date.parse(deadlineIso) - nowWall); }
  remaining(nowPerf = performance.now()) { return Math.max(0, this.perfDeadline - nowPerf); }
}

/** (T-06-R1) 이어서 풀 시도: 현재 노트북 개정판(fingerprint)의 미완료 실전 시도만 */
export const ACTIVE_STATUSES: AttemptStatus[] = ['in_progress', 'expired', 'submitting', 'grading', 'grading_failed'];
export const findResumable = (atts: Attempt[], fingerprint: string) =>
  atts.find((a) => a.mode === 'exam' && ACTIVE_STATUSES.includes(a.status) && a.notebook_fingerprint === fingerprint);
/** 이전 개정판에서 남은 미완료 시도 (보존하되 이어갈 수 없음) */
export const staleRevisionAttempts = (atts: Attempt[], fingerprint: string) =>
  atts.filter((a) => a.mode === 'exam' && ACTIVE_STATUSES.includes(a.status) && a.notebook_fingerprint !== fingerprint);
/** 새 시도 시작 가능 여부 — 시작 화면 진입 조건과 같은 규칙 (현재 개정판 기준) */
export const canStartNew = (atts: Attempt[], fingerprint: string) => !findResumable(atts, fingerprint);
