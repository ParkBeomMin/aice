// 개념 카드 학습 기록 저장 (T-07D, R1). 모의고사 DB(aice-notebook)와 분리된 IndexedDB 'aice-cards' v1.
// - 마지막으로 읽거나 쓴 기록을 메모리 캐시에 유지한다.
// - 읽기, 쓰기, 삭제 중 하나라도 실패하면 메모리 모드(persistent=false)로 바꾸고 캐시를 그대로 이어 쓴다 (기존 기록 보존).
// - 처음부터 기록을 읽지 못했으면 lostHistory=true 로 알린다 (UI 가 "이전 기록을 불러오지 못함" 안내).
// - 다른 탭 변경은 BroadcastChannel 로 반영.
import type { ProgressRecord } from '../lib/cards-progress';

export const CARDS_DB = 'aice-cards';
const STORE = 'progress';

export interface CardBackend {
  getAll(): Promise<ProgressRecord[]>;
  put(rec: ProgressRecord): Promise<void>;
  remove(ids: string[]): Promise<void>;
}
export interface Channel { post(): void; onMessage(cb: () => void): void }

export interface CardStore {
  /** 이 브라우저 저장소에 기록되는지 */
  persistent: boolean;
  /** 이전 기록을 읽지 못한 채 메모리 모드가 되었는지 */
  lostHistory: boolean;
  getAll(): Promise<Map<string, ProgressRecord>>;
  /** 저장소에 기록되면 true, 메모리에만 남으면 false */
  put(rec: ProgressRecord): Promise<boolean>;
  remove(cardIds: string[]): Promise<boolean>;
  onExternalChange(cb: () => void): void;
  onStatusChange(cb: () => void): void;
}

export function createCardStore(backend: CardBackend | null, channel: Channel | null = null): CardStore {
  const cache = new Map<string, ProgressRecord>();
  let readOk = false;
  const ext: (() => void)[] = [];
  const status: (() => void)[] = [];
  channel?.onMessage(() => ext.forEach((f) => f()));
  const store: CardStore = {
    persistent: backend !== null,
    lostHistory: false,
    async getAll() {
      if (store.persistent && backend) {
        try {
          const list = await backend.getAll();
          cache.clear();
          for (const r of list) cache.set(r.card_id, r);
          readOk = true;
        } catch { degrade(!readOk); }
      }
      return new Map(cache);
    },
    async put(rec) {
      if (store.persistent && backend) {
        try { await backend.put(rec); cache.set(rec.card_id, rec); channel?.post(); return true; } catch { degrade(false); }
      }
      cache.set(rec.card_id, rec);
      return false;
    },
    async remove(ids) {
      if (store.persistent && backend) {
        try { await backend.remove(ids); ids.forEach((id) => cache.delete(id)); channel?.post(); return true; } catch { degrade(false); }
      }
      ids.forEach((id) => cache.delete(id));
      return false;
    },
    onExternalChange(cb) { ext.push(cb); },
    onStatusChange(cb) { status.push(cb); },
  };
  function degrade(lost: boolean) {
    store.persistent = false;
    if (lost) store.lostHistory = true;
    status.forEach((f) => f());
  }
  if (!backend) store.lostHistory = false; // 처음부터 저장소가 없으면 잃을 기록도 없음
  return store;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(CARDS_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'card_id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}
function idbBackend(db: IDBDatabase): CardBackend {
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('abort'));
    });
  return {
    getAll: async () => (await run<ProgressRecord[]>('readonly', (s) => s.getAll())) ?? [],
    put: async (rec) => { await run('readwrite', (s) => s.put(rec)); },
    remove: async (ids) => { await run('readwrite', (s) => { ids.forEach((id) => s.delete(id)); }); },
  };
}

export async function openCardStore(): Promise<CardStore> {
  let backend: CardBackend | null = null;
  try {
    if (typeof indexedDB !== 'undefined') backend = idbBackend(await openDb());
  } catch { backend = null; }
  let channel: Channel | null = null;
  if (backend && typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel('aice-cards');
    channel = { post: () => ch.postMessage('changed'), onMessage: (cb) => { ch.onmessage = () => cb(); } };
  }
  return createCardStore(backend, channel);
}

/** 결과 화면 → 복습 화면 추천 전달 (URL 에 점수, 답안, attempt_id 를 넣지 않고 세션 저장소로만) */
export const RECO_KEY = 'aice-cards-reco';
export interface Reco { pack_id: string; pack_title: string; card_ids: string[] }
export function saveReco(r: Reco): boolean { try { sessionStorage.setItem(RECO_KEY, JSON.stringify(r)); return true; } catch { return false; } }
export function loadReco(): Reco | null {
  try { const v = sessionStorage.getItem(RECO_KEY); const r = v ? JSON.parse(v) : null; return r && Array.isArray(r.card_ids) ? r : null; } catch { return null; }
}
export function clearReco(): void { try { sessionStorage.removeItem(RECO_KEY); } catch { /* 무시 */ } }
