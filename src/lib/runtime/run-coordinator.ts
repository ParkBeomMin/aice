// T-05-R1 FIX-01: 셀 실행 요청 정책 (순수 로직, DOM, Worker 없음).
// - 같은 셀이 대기, 실행 중이면 새 요청은 거부 (duplicate). 결과는 항상 요청 토큰으로 셀에 연결.
// - 전체 실행 중에는 개별 실행 요청 거부 (run_all_active). 전체 실행은 하나만.
// - 실행 시작 시 소스를 고정하고, 완료 시 현재 소스와 비교해 stale 여부를 판정.
export type RunRejectReason = 'duplicate' | 'run_all_active';
export interface RunTicket { cellId: string; token: number; source: string; startedAt: number }
export type RunRequest = { ok: true; ticket: RunTicket } | { ok: false; reason: RunRejectReason };

export class RunCoordinator {
  private active = new Map<string, RunTicket>();
  private latest = new Map<string, number>();
  private seq = 0;
  private runAllToken: number | null = null;

  get runAllActive() { return this.runAllToken !== null; }
  isActive(cellId: string) { return this.active.has(cellId); }
  activeCells() { return [...this.active.keys()]; }

  /** 실행 요청. source 는 요청 시점의 에디터 내용 (이후 편집과 무관하게 고정). */
  request(cellId: string, source: string, opts: { fromRunAll?: boolean } = {}): RunRequest {
    if (this.runAllToken !== null && !opts.fromRunAll) return { ok: false, reason: 'run_all_active' };
    if (this.active.has(cellId)) return { ok: false, reason: 'duplicate' };
    const ticket: RunTicket = Object.freeze({ cellId, token: ++this.seq, source, startedAt: Date.now() });
    this.active.set(cellId, ticket);
    this.latest.set(cellId, ticket.token);
    return { ok: true, ticket };
  }

  /** 실행 종료. 이 티켓이 해당 셀의 최신 실행이면 true (결과를 화면에 반영해도 됨). */
  complete(ticket: RunTicket): boolean {
    if (this.active.get(ticket.cellId)?.token === ticket.token) this.active.delete(ticket.cellId);
    return this.latest.get(ticket.cellId) === ticket.token;
  }

  beginRunAll(): number | null {
    if (this.runAllToken !== null) return null;
    this.runAllToken = ++this.seq;
    return this.runAllToken;
  }
  endRunAll(token: number) { if (this.runAllToken === token) this.runAllToken = null; }
}

/** 실행이 끝났을 때 현재 에디터 코드가 실행한 코드와 다르면 그 결과는 이전 코드의 결과 */
export const isStaleResult = (ranSource: string, currentSource: string) => ranSource !== currentSource;
