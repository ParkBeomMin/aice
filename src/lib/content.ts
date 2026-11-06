// acf content build 가 만든 공개 번들(src/data/generated)만 읽는다. 관리자 API/NAS 에 접근하지 않는다.
import bank from '../data/generated/bank-index.json';

export type Difficulty = 'easy' | 'medium' | 'hard';
export interface PublicDataset { dataset_id: string; url_path: string; sha256: string; size_bytes: number; license: string }
export interface ManifestQuestion { question_id: string; public_id: string; revision: number; title: string; topic: string; difficulty: Difficulty; file: string; sha256: string }
export interface Manifest {
  pack_id: string; title: string; summary: string; mode: 'preview' | 'production'; mock: boolean;
  time_limit_minutes: number; question_count: number; questions: ManifestQuestion[]; datasets: PublicDataset[];
  notebook: { kind: 'question_notebook'; format: string; url_path: string; sha256: string; size_bytes: number; question_ids: string[] };
  grading: { kind: 'grading_bundle'; url_path: string; sha256: string; size_bytes: number; engine_version: string; grading_version: string; question_ids: string[] } | null;
}
export interface PublicQuestion {
  pack_id: string; question_id: string; public_id: string; revision: number; title: string; topic: string;
  difficulty: Difficulty; prompt: string; starter_code: string;
  runtime: { type: 'pyodide' | 'external'; max_execution_ms: number; packages: string[] };
  datasets: PublicDataset[]; grading: { type: string; profile: string | null };
  explanation: { available: boolean; body_md: string | null }; answer: { available: boolean; code: string | null };
  video: { youtube_id: string | null; start_seconds: number | null }; publication_status: 'draft' | 'approved';
}

const manifestMods = import.meta.glob('../data/generated/*/manifest.json', { eager: true, import: 'default' }) as Record<string, Manifest>;
const questionMods = import.meta.glob('../data/generated/*/q[0-9][0-9].json', { eager: true, import: 'default' }) as Record<string, PublicQuestion>;

export const bankMode: 'preview' | 'production' = (bank as { mode: 'preview' | 'production' }).mode;
export const isProduction = bankMode === 'production';

export function getManifests(): Manifest[] {
  const order = (bank as { packs: { pack_id: string }[] }).packs.map((p) => p.pack_id);
  const all = Object.values(manifestMods);
  return order.map((id) => all.find((m) => m.pack_id === id)).filter((m): m is Manifest => Boolean(m));
}

export function getManifest(packId: string): Manifest | undefined {
  return getManifests().find((m) => m.pack_id === packId);
}

export function getQuestion(packId: string, qid: string): PublicQuestion | undefined {
  return Object.values(questionMods).find((q) => q.pack_id === packId && q.question_id === qid);
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '하', medium: '중', hard: '상' };
export const TOPIC_LABEL: Record<string, string> = {
  pandas: 'Pandas', preprocessing: '전처리', visualization: '시각화', machine_learning: '머신러닝', deep_learning: '딥러닝',
};
export function topicLabel(t: string): string { return TOPIC_LABEL[t] ?? t; }
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
