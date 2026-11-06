// (T-06-R1) 새 실전 시도 생성: 팩 단위 잠금 안에서 저장소를 다시 읽고, 현재 개정판의 미완료 시도가 없을 때만 1건 생성
import { canStartNew, startExamAttempt } from './exam-state.ts';
import type { Attempt, ExamStore } from '../storage/exam-store.ts';

export interface ExclusiveLocks { request(name: string, cb: () => Promise<void>): Promise<unknown> }

export async function startExamExclusive(store: ExamStore, locks: ExclusiveLocks, o: { packId: string; fingerprint: string; timeLimitMinutes: number }): Promise<Attempt | null> {
  let created: Attempt | null = null;
  await locks.request(`aice-exam-start:${o.packId}`, async () => {
    const atts = await store.listAttempts(o.packId);
    if (!canStartNew(atts, o.fingerprint)) return;
    created = await store.putAttempt(startExamAttempt(o));
  });
  return created;
}
