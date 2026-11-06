// T-05-R1 FIX-04: 제출 연동용 불변 코드 스냅샷 (T-06 제출, 채점에서 사용). 실행 결과, 커널 상태는 포함하지 않는다.
export const SNAPSHOT_VERSION = 1;

export interface CellSnapshot {
  readonly cellId: string;
  readonly questionId: string | null;
  readonly source: string;
  readonly sourceSha256: string;
}
export interface NotebookSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly packId: string;
  readonly notebookFingerprint: string;
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
  /** 노트북 순서대로의 코드 셀 */
  readonly cells: readonly CellSnapshot[];
  /** version, packId, fingerprint, 셀(cellId, questionId, sourceSha256) 의 정규 JSON SHA-256. createdAt 은 제외 → 같은 코드면 같은 해시 */
  readonly snapshotSha256: string;
}
export interface SnapshotInput { packId: string; notebookFingerprint: string; cells: { cellId: string; questionId: string | null; source: string }[] }

export async function sha256Text(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const canonical = (s: { packId: string; notebookFingerprint: string; cells: readonly { cellId: string; questionId: string | null; sourceSha256: string }[] }) =>
  JSON.stringify({ version: SNAPSHOT_VERSION, packId: s.packId, notebookFingerprint: s.notebookFingerprint,
    cells: s.cells.map((c) => ({ cellId: c.cellId, questionId: c.questionId, sourceSha256: c.sourceSha256 })) });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
}

/**
 * 입력 셀의 문자열을 호출 즉시(첫 await 이전) 복사하므로, 호출 이후의 에디터 편집은 스냅샷에 영향을 주지 않는다.
 */
export async function createNotebookSnapshot(input: SnapshotInput, now: () => Date = () => new Date()): Promise<NotebookSnapshot> {
  const createdAt = now().toISOString();
  if (!input.packId || !input.notebookFingerprint) throw new Error('packId, notebookFingerprint 필요');
  const seen = new Set<string>();
  const copied = input.cells.map((c) => {
    if (typeof c.cellId !== 'string' || !c.cellId) throw new Error('cellId 필요');
    if (seen.has(c.cellId)) throw new Error(`중복 cellId: ${c.cellId}`);
    if (typeof c.source !== 'string') throw new Error(`source 는 문자열이어야 함: ${c.cellId}`);
    seen.add(c.cellId);
    return { cellId: c.cellId, questionId: c.questionId ?? null, source: String(c.source) };
  });
  const cells: CellSnapshot[] = [];
  for (const c of copied) cells.push({ ...c, sourceSha256: await sha256Text(c.source) });
  const base = { packId: input.packId, notebookFingerprint: input.notebookFingerprint, cells };
  return deepFreeze({ version: SNAPSHOT_VERSION, ...base, createdAt, snapshotSha256: await sha256Text(canonical(base)) });
}

/** 스냅샷 무결성 재검증 (셀 해시, 전체 해시) */
export async function verifyNotebookSnapshot(s: NotebookSnapshot): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  if (s.version !== SNAPSHOT_VERSION) errors.push(`지원하지 않는 version: ${s.version}`);
  for (const c of s.cells) if ((await sha256Text(c.source)) !== c.sourceSha256) errors.push(`${c.cellId}: sourceSha256 불일치`);
  if ((await sha256Text(canonical(s))) !== s.snapshotSha256) errors.push('snapshotSha256 불일치');
  return { ok: errors.length === 0, errors };
}
