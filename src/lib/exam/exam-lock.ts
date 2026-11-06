// T-06: 같은 시도를 여러 탭에서 수정하지 못하게 하는 소유권 (Web Locks API). 탭이 닫히면 잠금은 자동 해제된다.
// Web Locks 를 쓸 수 없는 브라우저에서는 실전 모드를 막는다 (실패 안전).
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean; mode?: 'exclusive' }, cb: (lock: unknown | null) => Promise<unknown> | unknown): Promise<unknown>;
}
export interface AttemptLock { name: string; readonly owned: boolean; lost: Promise<void>; release(): void }

export const lockName = (attemptId: string) => `aice-attempt:${attemptId}`;
export const locksAvailable = (locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks) => !!locks;

/** 소유권 획득. 다른 탭이 가지고 있으면 null (steal=true 면 빼앗음 → 상대 탭의 lost 가 resolve) */
export function acquireAttemptLock(attemptId: string, opts: { steal?: boolean; locks?: LockManagerLike } = {}): Promise<AttemptLock | null> {
  const locks = opts.locks ?? (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks) return Promise.reject(new Error('이 브라우저는 Web Locks 를 지원하지 않아 실전 모드를 사용할 수 없습니다'));
  const name = lockName(attemptId);
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let markLost!: () => void;
    const lost = new Promise<void>((r) => { markLost = r; });
    let owned = false;
    const handle: AttemptLock = { name, get owned() { return owned; }, lost, release: () => { owned = false; release(); } };
    locks.request(name, opts.steal ? { steal: true } : { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      owned = true;
      resolve(handle);
      return held;
    }).then(() => { if (owned) { owned = false; markLost(); } }, (e) => {
      if (owned) { owned = false; markLost(); return; } // steal 당함 (AbortError)
      reject(e);
    });
  });
}
