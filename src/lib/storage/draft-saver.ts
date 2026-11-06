// T-05-R1 FIX-02: 자동 저장 직렬화 (순수 로직, DOM 없음).
// - 편집마다 revision 증가, 디바운스 후 저장. 저장은 한 번에 하나만 진행하고 그동안의 편집은 끝난 뒤 최신 내용으로 한 번 더 저장.
// - 성공 이벤트는 스토어가 커밋을 확인(resolve)한 뒤에만, 그리고 그 revision 기준으로 발생.
// - clear() 는 진행 중 저장이 끝나기를 기다린 뒤 삭제하고, 그 사이 예약된 저장을 취소하므로 삭제된 초안이 되살아나지 않는다.
import type { Draft, DraftStore } from './indexeddb-storage.ts';

export type SaveEvent =
  | { type: 'dirty'; revision: number }
  | { type: 'saving'; revision: number }
  | { type: 'saved'; revision: number; latest: boolean; at: string }
  | { type: 'error'; revision: number; error: string }
  | { type: 'cleared' };

export interface DraftSaverOptions {
  packId: string; fingerprint: string; writer: string;
  /** (T-06) 실전 시도 초안이면 'exam:<attempt_id>' */
  scope?: string;
  /** (T-06) false 를 반환하면 저장하지 않음 (예: 다른 탭이 시험 소유권을 가져감) */
  canWrite?: () => boolean;
  collect: () => Draft['cells'];
  onEvent: (e: SaveEvent) => void;
  debounceMs?: number;
}

export class DraftSaver {
  private revision = 0;
  private savedRevision = 0;
  private epoch = 0;
  private loop: Promise<void> | null = null;
  private again = false;
  private clearing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private store: DraftStore;
  private o: DraftSaverOptions;

  constructor(store: DraftStore, opts: DraftSaverOptions) { this.store = store; this.o = opts; }

  get currentRevision() { return this.revision; }
  get committedRevision() { return this.savedRevision; }
  /** 아직 커밋되지 않은 편집이 있는지 */
  get dirty() { return this.revision > this.savedRevision; }
  get saving() { return this.loop !== null; }

  /** 에디터 내용이 바뀜 → 디바운스 후 저장 */
  markDirty() {
    this.revision++;
    this.o.onEvent({ type: 'dirty', revision: this.revision });
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.o.debounceMs ?? 800);
  }

  /** 지금 저장. 최신 revision 이 커밋되면 true. */
  flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.clearing) { this.again = true; return Promise.resolve(false); }
    if (this.loop) this.again = true;
    else this.loop = this.runLoop().finally(() => { this.loop = null; });
    return this.loop.then(() => !this.dirty);
  }

  private async runLoop() {
    const epoch = this.epoch;
    do {
      this.again = false;
      if (epoch !== this.epoch || this.clearing) return;
      const rev = this.revision;
      if (rev <= this.savedRevision) continue;
      if (this.o.canWrite && !this.o.canWrite()) { this.o.onEvent({ type: 'error', revision: rev, error: '이 탭은 더 이상 저장 권한이 없습니다 (다른 탭에서 시험을 진행 중)' }); return; }
      const cells = this.o.collect(); // revision rev 시점 내용
      this.o.onEvent({ type: 'saving', revision: rev });
      try {
        await this.store.saveDraft({ packId: this.o.packId, fingerprint: this.o.fingerprint, cells, revision: rev, writer: this.o.writer, ...(this.o.scope ? { scope: this.o.scope } : {}) });
      } catch (e) {
        if (epoch === this.epoch) this.o.onEvent({ type: 'error', revision: rev, error: (e as Error).message || String(e) });
        return; // 실패 시 반복 저장하지 않음. 다음 편집, 저장 버튼에서 다시 시도
      }
      if (epoch !== this.epoch) return; // 저장 중 초기화됨 → 성공 표시 안 함 (clear 가 이후 삭제)
      if (rev > this.savedRevision) this.savedRevision = rev;
      this.o.onEvent({ type: 'saved', revision: rev, latest: rev === this.revision, at: new Date().toISOString() });
    } while (this.again || this.revision > this.savedRevision);
  }

  /** 초안 삭제 (초기화). 호출 시점까지의 편집은 깨끗한 상태로 본다. */
  async clear(): Promise<void> {
    const revAtClear = this.revision;
    this.epoch++;
    this.clearing = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.again = false;
    try {
      const l = this.loop;
      if (l) await l.catch(() => {});
      await this.store.clearDraft(this.o.packId, this.o.fingerprint, this.o.scope);
      if (revAtClear > this.savedRevision) this.savedRevision = revAtClear;
      this.o.onEvent({ type: 'cleared' });
    } finally {
      this.clearing = false;
    }
    if (this.revision > this.savedRevision) this.schedule(); // 삭제 도중 들어온 새 편집은 이후 저장
  }

  /** 페이지 이탈 직전: 예약된 저장을 즉시 시작 (완료 보장은 브라우저에 달림) */
  flushOnLeave() { if (this.dirty) void this.flush(); }
}
