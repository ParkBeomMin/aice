// 개념 카드 공개 산출물(src/data/generated/cards) 읽기 (T-07D). acf cards build 가 만든 파일만 사용한다.
export type CardDifficulty = 'basic' | 'intermediate' | 'advanced';
export interface PublicCard {
  card_id: string; revision: number; front: string; back: string; code_example: string | null;
  code_language: 'python' | 'text'; code_runtime: 'reference_only' | 'pyodide' | 'external_only';
  tags: string[]; difficulty: CardDifficulty; content_digest: string;
}
export interface PublicDeck {
  deck_id: string; revision: number; title: string; summary: string; intro_md: string; learning_objectives: string[];
  seo: { title: string; description: string }; tags: string[]; publication_status: 'draft' | 'approved'; license: string; cards: PublicCard[];
}
interface CardIndex { mode: 'preview' | 'production'; decks: { deck_id: string; title: string; summary: string; card_count: number }[]; question_links: { pack_id: string }[] }
interface QuestionLinks { pack_id: string; links: { question_id: string; card_ids: string[] }[] }

const idxMods = import.meta.glob('../data/generated/cards/index.json', { eager: true, import: 'default' }) as Record<string, CardIndex>;
const deckMods = import.meta.glob('../data/generated/cards/decks/*.json', { eager: true, import: 'default' }) as Record<string, PublicDeck>;
const linkMods = import.meta.glob('../data/generated/cards/question-links/*.json', { eager: true, import: 'default' }) as Record<string, QuestionLinks>;

const index: CardIndex | null = Object.values(idxMods)[0] ?? null;

export function getDecks(): PublicDeck[] {
  if (!index) return [];
  const all = Object.values(deckMods);
  return index.decks.map((d) => all.find((x) => x.deck_id === d.deck_id)).filter((d): d is PublicDeck => Boolean(d));
}
export const cardsEnabled = (): boolean => getDecks().length > 0;
export const getDeck = (id: string) => getDecks().find((d) => d.deck_id === id);
export const totalCards = () => getDecks().reduce((n, d) => n + d.cards.length, 0);

export interface CardRef { deck_id: string; deck_title: string; card: PublicCard }
export function cardMap(): Map<string, CardRef> {
  const m = new Map<string, CardRef>();
  for (const d of getDecks()) for (const c of d.cards) m.set(c.card_id, { deck_id: d.deck_id, deck_title: d.title, card: c });
  return m;
}
/** 문항 → 연결 카드 ID (공개 덱에 있는 것만) */
export function questionLinks(packId: string): Record<string, string[]> {
  const l = Object.values(linkMods).find((x) => x.pack_id === packId);
  return l ? Object.fromEntries(l.links.map((x) => [x.question_id, x.card_ids])) : {};
}
/** 카드 → 연결된 문항 (pack_id, question_id) */
export function cardQuestions(): Map<string, { pack_id: string; question_id: string }[]> {
  const m = new Map<string, { pack_id: string; question_id: string }[]>();
  for (const l of Object.values(linkMods)) for (const x of l.links) for (const c of x.card_ids) {
    if (!m.has(c)) m.set(c, []);
    m.get(c)!.push({ pack_id: l.pack_id, question_id: x.question_id });
  }
  return m;
}
export const CARD_DIFFICULTY_LABEL: Record<CardDifficulty, string> = { basic: '기초', intermediate: '중급', advanced: '심화' };
export const runtimeLabel = (c: PublicCard) =>
  c.code_runtime === 'external_only' ? '참고 코드 (TensorFlow 등, 이 사이트에서는 실행하지 않아요)' : '참고 코드';
/** 학습 화면용 최소 데이터 (공개 학습 콘텐츠) */
export const studyPayload = (decks: PublicDeck[]) =>
  decks.map((d) => ({ deck_id: d.deck_id, title: d.title, cards: d.cards.map((c) => ({ id: c.card_id, f: c.front, b: c.back, code: c.code_example, rt: c.code_runtime, dg: c.content_digest, rev: c.revision })) }));
