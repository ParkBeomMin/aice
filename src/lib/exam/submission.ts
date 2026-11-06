// T-06: 제출 스냅샷 검증 (해시 무결성 + 공개 Manifest 와의 정합성). 해시는 데이터 무결성 확인용이며 전자서명, 부정행위 방지 수단이 아니다.
import { verifyNotebookSnapshot, type NotebookSnapshot } from '../runtime/notebook-snapshot.ts';

export const MAX_CELL_BYTES = 100_000;
export const MAX_TOTAL_BYTES = 1_000_000;
export interface ExpectedNotebook { packId: string; fingerprint: string; questionIds: string[] }

export async function validateSubmissionSnapshot(s: NotebookSnapshot, exp: ExpectedNotebook): Promise<string[]> {
  const errors: string[] = [];
  const v = await verifyNotebookSnapshot(s);
  errors.push(...v.errors);
  if (s.packId !== exp.packId) errors.push(`pack_id 불일치 (${s.packId} ≠ ${exp.packId})`);
  if (s.notebookFingerprint !== exp.fingerprint) errors.push('노트북 fingerprint 불일치 (문제 노트북이 개정됨)');
  const want = exp.questionIds.map((q) => `${q}-attempt`);
  const got = s.cells.map((c) => c.cellId);
  if (new Set(got).size !== got.length) errors.push('중복 셀');
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length) errors.push(`누락 셀: ${missing.join(', ')}`);
  if (extra.length) errors.push(`추가 셀: ${extra.join(', ')}`);
  if (!missing.length && !extra.length && got.join() !== want.join()) errors.push('셀 순서가 Manifest 문항 순서와 다름');
  const enc = new TextEncoder();
  let total = 0;
  for (const c of s.cells) {
    if (c.cellId !== `${c.questionId}-attempt`) errors.push(`${c.cellId}: questionId(${c.questionId}) 불일치`);
    const n = enc.encode(c.source).length; total += n;
    if (n > MAX_CELL_BYTES) errors.push(`${c.cellId}: 코드가 너무 큼 (${n} bytes > ${MAX_CELL_BYTES})`);
  }
  if (total > MAX_TOTAL_BYTES) errors.push(`전체 코드가 너무 큼 (${total} bytes)`);
  return errors;
}
