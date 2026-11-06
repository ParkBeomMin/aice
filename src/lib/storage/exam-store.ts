// T-06: 시험 시도, 제출, 채점 결과 저장 (IndexedDB v2). 제출본, 결과는 일반 초안(drafts)과 분리되어 초안을 바꾸거나 지워도 영향 없음.
import { txn, defaultIdb, type IdbFactoryFn } from './indexeddb-storage.ts';
import type { NotebookSnapshot } from '../runtime/notebook-snapshot.ts';
import type { AttemptResult } from '../grading/types.ts';

export type AttemptStatus = 'not_started' | 'in_progress' | 'submitting' | 'grading' | 'submitted' | 'expired' | 'grading_failed';
export interface Attempt {
  attempt_id: string; pack_id: string; notebook_fingerprint: string; mode: 'practice' | 'exam'; status: AttemptStatus;
  time_limit_minutes: number | null; started_at: string; deadline_at: string | null;
  submitted_at: string | null; submit_reason: 'manual' | 'expired' | 'practice' | null;
  snapshot_hash: string | null; grading_version: string | null; grading_error: string | null; updated_at: string;
  /** (T-06-R1) 소유권 세대 (fencing). 탭이 소유권을 얻을 때마다 +1. 쓰기 시 자신의 세대와 같아야 함 */
  owner_generation?: number;
  owner_tab?: string | null;
}
export interface Submission {
  attempt_id: string; pack_id: string; mode: 'practice' | 'exam'; submitted_at: string; submit_reason: 'manual' | 'expired' | 'practice';
  snapshot: NotebookSnapshot;
}
export interface ExamStore {
  putAttempt(a: Attempt): Promise<Attempt>;
  getAttempt(id: string): Promise<Attempt | undefined>;
  /** (T-06-R1) 소유권 획득 직후 호출: 세대 +1 을 기록하고 새 세대를 돌려줌 */
  claimOwnership(id: string, tab: string): Promise<{ attempt: Attempt; generation: number }>;
  /** (T-06-R1) 현재 세대가 gen 일 때만 쓰기 (아니면 StaleOwner) */
  putAttemptFenced(a: Attempt, gen: number): Promise<Attempt>;
  listAttempts(packId: string): Promise<Attempt[]>;
  /** 제출 스냅샷 기록 + 시도 상태 갱신을 한 트랜잭션으로. 이미 제출본이 있으면 새로 쓰지 않고 기존 것을 돌려줌 (중복 제출 방지) */
  commitSubmission(s: Submission, attemptPatch: Partial<Attempt>, gen?: number): Promise<{ created: boolean; submission: Submission; attempt: Attempt }>;
  getSubmission(id: string): Promise<Submission | undefined>;
  /** 결과 저장 + 시도 submitted 를 한 트랜잭션으로. 이미 결과가 있으면 덮어쓰지 않음 */
  commitResult(r: AttemptResult, gen?: number): Promise<{ created: boolean; result: AttemptResult }>;
  getResult(id: string): Promise<AttemptResult | undefined>;
}

export class StorageConflict extends Error {}
/** (T-06-R1) 다른 탭이 소유권을 가져가 이 탭의 세대가 낡음 */
export class StaleOwner extends StorageConflict {}

export function createExamStore(factory: IdbFactoryFn = defaultIdb): ExamStore {
  const now = () => new Date().toISOString();
  const get = <T>(st: IDBObjectStore, key: string, cb: (v: T | undefined) => void) => { const r = st.get(key); r.onsuccess = () => cb(r.result as T | undefined); };
  return {
    putAttempt(a) {
      const rec = { ...a, updated_at: now() };
      return txn<Attempt>(factory, ['attempts'], 'readwrite', (t, set) => { t.objectStore('attempts').put(rec).onsuccess = () => set(rec); });
    },
    getAttempt(id) { return txn(factory, ['attempts'], 'readonly', (t, set) => get<Attempt>(t.objectStore('attempts'), id, set)); },
    claimOwnership(id, tab) {
      return txn(factory, ['attempts'], 'readwrite', (t, set, abort) => {
        const st = t.objectStore('attempts');
        get<Attempt>(st, id, (a) => {
          if (!a) return abort(new StorageConflict('시도 기록이 없습니다'));
          const generation = (a.owner_generation ?? 0) + 1;
          const next = { ...a, owner_generation: generation, owner_tab: tab, updated_at: now() };
          st.put(next).onsuccess = () => set({ attempt: next, generation });
        });
      });
    },
    putAttemptFenced(a, gen) {
      return txn(factory, ['attempts'], 'readwrite', (t, set, abort) => {
        const st = t.objectStore('attempts');
        get<Attempt>(st, a.attempt_id, (cur) => {
          if (!cur) return abort(new StorageConflict('시도 기록이 없습니다'));
          if ((cur.owner_generation ?? 0) !== gen) return abort(new StaleOwner('다른 탭이 이 시험의 소유권을 가져갔습니다'));
          const next = { ...a, owner_generation: gen, owner_tab: cur.owner_tab ?? null, updated_at: now() };
          st.put(next).onsuccess = () => set(next);
        });
      });
    },
    listAttempts(packId) {
      return txn<Attempt[]>(factory, ['attempts'], 'readonly', (t, set) => { const r = t.objectStore('attempts').index('pack_id').getAll(packId); r.onsuccess = () => set((r.result as Attempt[]).sort((a, b) => b.started_at.localeCompare(a.started_at))); });
    },
    commitSubmission(s, patch, gen) {
      return txn(factory, ['submissions', 'attempts'], 'readwrite', (t, set, abort) => {
        const subs = t.objectStore('submissions'); const atts = t.objectStore('attempts');
        get<Attempt>(atts, s.attempt_id, (att) => {
          if (!att) return abort(new StorageConflict('시도 기록이 없습니다'));
          // 같은 트랜잭션 안에서 소유권 세대 확인 → 소유권을 잃은 탭은 제출을 확정할 수 없음
          if (gen !== undefined && (att.owner_generation ?? 0) !== gen) return abort(new StaleOwner('다른 탭이 이 시험의 소유권을 가져가 제출하지 않았습니다'));
          get<Submission>(subs, s.attempt_id, (existing) => {
            if (existing) { set({ created: false, submission: existing, attempt: att }); return; }
            const next = { ...att, ...patch, updated_at: now() };
            subs.add(s);
            atts.put(next).onsuccess = () => set({ created: true, submission: s, attempt: next });
          });
        });
      });
    },
    getSubmission(id) { return txn(factory, ['submissions'], 'readonly', (t, set) => get<Submission>(t.objectStore('submissions'), id, set)); },
    commitResult(r, gen) {
      return txn(factory, ['grading_results', 'attempts', 'submissions'], 'readwrite', (t, set, abort) => {
        const res = t.objectStore('grading_results'); const atts = t.objectStore('attempts');
        const proceed = (fn: () => void) => {
          if (gen === undefined) return fn();
          // (R1.1) 실전: 같은 트랜잭션 안에서 소유권 세대 확인 → 소유권을 넘긴 탭은 결과, 상태를 확정할 수 없음
          get<Attempt>(atts, r.attempt_id, (a) => { if (!a || (a.owner_generation ?? 0) !== gen) return abort(new StaleOwner('다른 탭이 이 시험을 가져가 이 탭의 채점 결과는 저장하지 않았습니다')); fn(); });
        };
        proceed(() => get<Submission>(t.objectStore('submissions'), r.attempt_id, (sub) => {
          if (!sub) return abort(new StorageConflict('제출본이 없는 결과는 저장하지 않습니다'));
          if (sub.snapshot.snapshotSha256 !== r.snapshot_sha256) return abort(new StorageConflict('결과의 스냅샷 해시가 제출본과 다릅니다'));
          get<AttemptResult>(res, r.attempt_id, (existing) => {
            if (existing) { set({ created: false, result: existing }); return; }
            res.add(r);
            get<Attempt>(atts, r.attempt_id, (att) => {
              if (att) atts.put({ ...att, status: 'submitted', grading_version: r.grading_version, grading_error: null, updated_at: now() });
              set({ created: true, result: r });
            });
          });
        }));
      });
    },
    getResult(id) { return txn(factory, ['grading_results'], 'readonly', (t, set) => get<AttemptResult>(t.objectStore('grading_results'), id, set)); },
  };
}

/** (T-06-R1) 실전 초안 저장도 소유권 세대 확인 (소유권을 잃은 탭의 늦은 자동 저장이 새 탭의 초안을 덮어쓰지 않게) */
export function createFencedDraftStore(base: import('./indexeddb-storage.ts').DraftStore, attemptId: string, getGen: () => number,
  factory: IdbFactoryFn = defaultIdb): import('./indexeddb-storage.ts').DraftStore {
  return {
    ...base,
    saveDraft(d) {
      return txn(factory, ['drafts', 'attempts'], 'readwrite', (t, set, abort) => {
        const r = t.objectStore('attempts').get(attemptId);
        r.onsuccess = () => {
          const a = r.result as Attempt | undefined;
          if (!a || (a.owner_generation ?? 0) !== getGen()) return abort(new StaleOwner('다른 탭이 이 시험을 가져가 이 탭의 코드는 저장하지 않았습니다'));
          const draft = { ...d, key: draftKeyFor(d), version: 1, updatedAt: new Date().toISOString() };
          t.objectStore('drafts').put(draft).onsuccess = () => set(draft as never);
        };
      });
    },
    /** (R1.1) 실전 초안 초기화(삭제)도 같은 트랜잭션에서 세대 확인 */
    clearDraft(packId, fingerprint, scope) {
      return txn<void>(factory, ['drafts', 'attempts'], 'readwrite', (t, _set, abort) => {
        const r = t.objectStore('attempts').get(attemptId);
        r.onsuccess = () => {
          const a = r.result as Attempt | undefined;
          if (!a || (a.owner_generation ?? 0) !== getGen()) return abort(new StaleOwner('다른 탭이 이 시험을 가져가 이 탭에서는 초안을 지우지 않았습니다'));
          t.objectStore('drafts').delete(draftKey(packId, fingerprint, scope));
        };
      });
    },
  };
}
import { draftKey } from './indexeddb-storage.ts';
const draftKeyFor = (d: { packId: string; fingerprint: string; scope?: string }) => draftKey(d.packId, d.fingerprint, d.scope);
