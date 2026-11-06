// 작성 코드 자동 저장 (IndexedDB). 키 = 네임스페이스 + pack_id + 노트북 fingerprint(sha256). 실행 결과는 저장하지 않는다.
// T-05-R1 FIX-02: 요청 onsuccess 가 아니라 transaction.oncomplete(커밋 완료) 시점에만 성공으로 resolve.
//                 abort/error 는 reject. 같은 writer 의 더 새 revision 이 이미 저장돼 있으면 오래된 쓰기는 건너뜀.
// T-06: DB 버전 2 — drafts 유지 + attempts / submissions / grading_results 추가 (기존 초안 보존 마이그레이션)
export const DB_NAME = 'aice-notebook';
export const DB_VERSION = 2;
export const STORE = 'drafts';
export const STORES_V2 = ['attempts', 'submissions', 'grading_results'] as const;
export const DRAFT_VERSION = 1;

export interface Draft {
  key: string; version: number; packId: string; fingerprint: string;
  cells: Record<string, { source: string; updatedAt: string }>; updatedAt: string;
  /** (R1) 같은 페이지 세션 안에서 증가하는 편집 revision. 이전 초안에는 없음 */
  revision?: number;
  /** (R1) 이 초안을 쓴 페이지 세션 ID */
  writer?: string;
  /** (T-06) 없음 = 연습 모드 초안, 'exam:<attempt_id>' = 실전 시도 초안 */
  scope?: string;
}
export type DraftInput = Omit<Draft, 'key' | 'version' | 'updatedAt'>;
export interface DraftStore {
  saveDraft(d: DraftInput): Promise<Draft>;
  loadDraft(packId: string, fingerprint: string, scope?: string): Promise<Draft | undefined>;
  listDrafts(packId: string): Promise<Draft[]>;
  clearDraft(packId: string, fingerprint: string, scope?: string): Promise<void>;
}

export const draftKey = (packId: string, fingerprint: string, scope?: string) => `aice:v${DRAFT_VERSION}:${packId}:${fingerprint}${scope ? `:${scope}` : ''}`;

export type IdbFactoryFn = () => IDBFactory | undefined;
export const defaultIdb: IdbFactoryFn = () => (typeof indexedDB === 'undefined' ? undefined : indexedDB);

/** DB 열기 + 업그레이드. v1(drafts) 데이터는 그대로 두고 v2 스토어만 추가 */
export function openDb(factory: IdbFactoryFn = defaultIdb): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = factory();
    if (!idb) return reject(new Error('이 브라우저는 IndexedDB 를 지원하지 않습니다'));
    let req: IDBOpenDBRequest;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e as Error); }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const old = (ev as IDBVersionChangeEvent).oldVersion;
      if (old < 1 && !db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('packId', 'packId');
      if (old < 2) {
        if (!db.objectStoreNames.contains('attempts')) db.createObjectStore('attempts', { keyPath: 'attempt_id' }).createIndex('pack_id', 'pack_id');
        if (!db.objectStoreNames.contains('submissions')) db.createObjectStore('submissions', { keyPath: 'attempt_id' });
        if (!db.objectStoreNames.contains('grading_results')) db.createObjectStore('grading_results', { keyPath: 'attempt_id' }).createIndex('pack_id', 'pack_id');
      }
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 열기 실패'));
    req.onblocked = () => reject(new Error('IndexedDB 가 다른 탭에 의해 차단됨 (다른 탭을 새로고침하세요)'));
  });
}

/** 여러 스토어 트랜잭션. fn 이 설정한 결과는 커밋(oncomplete) 뒤에만 resolve. fn 안에서 abort(reason) 로 실패 처리 */
export function txn<T>(factory: IdbFactoryFn, stores: string[], mode: IDBTransactionMode,
  fn: (t: IDBTransaction, setResult: (v: T) => void, abort: (e: Error) => void) => void): Promise<T> {
  return openDb(factory).then((db) => new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let reason: Error | null = null;
    let t: IDBTransaction;
    try { t = db.transaction(stores, mode); } catch (e) { db.close(); return reject(e as Error); }
    t.oncomplete = () => { db.close(); resolve(result as T); };
    t.onerror = () => { /* onabort 에서 처리 */ };
    t.onabort = () => { db.close(); reject(reason ?? t.error ?? new Error('IndexedDB 트랜잭션 중단 (저장 공간 부족 가능)')); };
    const abort = (e: Error) => { reason = e; try { t.abort(); } catch { /* 이미 끝남 */ } };
    try { fn(t, (v) => { result = v; }, abort); } catch (e) { abort(e as Error); }
  }));
}

export function createIndexedDbStorage(factory: IdbFactoryFn = defaultIdb): DraftStore {
  /** fn 이 반환한 값은 트랜잭션이 커밋(oncomplete)된 뒤에만 resolve 된다. */
  function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore, setResult: (v: T) => void) => void): Promise<T> {
    return txn<T>(factory, [STORE], mode, (t, set) => fn(t.objectStore(STORE), set));
  }

  const getReq = <T>(r: IDBRequest<T>, set: (v: T) => void) => { r.onsuccess = () => set(r.result); };

  return {
    saveDraft(d) {
      const draft: Draft = { ...d, key: draftKey(d.packId, d.fingerprint, d.scope), version: DRAFT_VERSION, updatedAt: new Date().toISOString() };
      return tx<Draft>('readwrite', (s, set) => {
        const cur = s.get(draft.key) as IDBRequest<Draft | undefined>;
        cur.onsuccess = () => {
          const old = cur.result;
          // 같은 writer 가 더 새 revision 을 이미 커밋했다면 오래된 초안으로 덮어쓰지 않음
          if (old && draft.writer && old.writer === draft.writer && (old.revision ?? 0) > (draft.revision ?? 0)) { set(old); return; }
          s.put(draft).onsuccess = () => set(draft);
        };
      });
    },
    loadDraft(packId, fingerprint, scope) {
      return tx<Draft | undefined>('readonly', (s, set) => getReq(s.get(draftKey(packId, fingerprint, scope)) as IDBRequest<Draft | undefined>, set));
    },
    listDrafts(packId) {
      return tx<Draft[]>('readonly', (s, set) => getReq(s.index('packId').getAll(packId) as IDBRequest<Draft[]>, set));
    },
    clearDraft(packId, fingerprint, scope) {
      return tx<void>('readwrite', (s) => { s.delete(draftKey(packId, fingerprint, scope)); });
    },
  };
}

export const IndexedDbStorage: DraftStore = createIndexedDbStorage();
