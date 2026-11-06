// 개념 카드 학습 기록 규칙 (순수 함수, T-07D). 저장은 scripts/cards-store.ts.
export type Rating = 'known' | 'review';
export interface ProgressRecord {
  card_id: string; deck_id: string; card_revision: number; content_digest: string;
  last_rating: Rating; reviewed_at: string; review_count: number; known_count: number; review_count_missed: number;
}
export interface StudyCard { id: string; f: string; b: string; code: string | null; rt: string; dg: string; rev: number }
export type CardStatus = 'new' | 'known' | 'review' | 'changed';

/** 카드 내용(digest)이 바뀌면 이전 '알아요' 를 이어받지 않고 changed (다시 확인 필요) */
export function cardStatus(card: StudyCard, rec: ProgressRecord | undefined): CardStatus {
  if (!rec) return 'new';
  if (rec.content_digest !== card.dg) return 'changed';
  return rec.last_rating;
}

export function applyRating(card: StudyCard, deckId: string, prev: ProgressRecord | undefined, rating: Rating, now: Date): ProgressRecord {
  const same = prev && prev.content_digest === card.dg ? prev : undefined;
  return {
    card_id: card.id, deck_id: deckId, card_revision: card.rev, content_digest: card.dg, last_rating: rating,
    reviewed_at: now.toISOString(), review_count: (same?.review_count ?? 0) + 1,
    known_count: (same?.known_count ?? 0) + (rating === 'known' ? 1 : 0),
    review_count_missed: (same?.review_count_missed ?? 0) + (rating === 'review' ? 1 : 0),
  };
}

export interface DeckStats { total: number; known: number; review: number; changed: number; unseen: number; studied: number; percent: number }
export function deckStats(cards: StudyCard[], recs: Map<string, ProgressRecord>): DeckStats {
  const s = { total: cards.length, known: 0, review: 0, changed: 0, unseen: 0, studied: 0, percent: 0 };
  for (const c of cards) {
    const st = cardStatus(c, recs.get(c.id));
    if (st === 'new') s.unseen++; else if (st === 'changed') s.changed++; else s[st]++;
  }
  s.studied = s.known + s.review;
  s.percent = s.total ? Math.round((s.studied / s.total) * 100) : 0;
  return s;
}

export type Filter = 'all' | 'new' | 'review';
/** review 필터는 '다시 볼게요' + 내용이 바뀐 카드, new 는 아직 평가하지 않은 카드 */
export function filterCards(cards: StudyCard[], recs: Map<string, ProgressRecord>, f: Filter): StudyCard[] {
  if (f === 'all') return cards.slice();
  return cards.filter((c) => {
    const st = cardStatus(c, recs.get(c.id));
    return f === 'new' ? st === 'new' : st === 'review' || st === 'changed';
  });
}

/** Fisher-Yates. rng 주입 가능 (테스트) */
export function shuffled<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** 결과 화면 추천: 오답, 부분 정답, 실행 오류, 채점 불가 문항의 연결 카드 (중복 제거, 문항 순서 유지) */
export const RECOMMEND_STATUSES = new Set(['incorrect', 'partial', 'execution_error', 'blocked']);
export function recommendCards(statuses: { question_id: string; status: string }[], links: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const q of statuses) if (RECOMMEND_STATUSES.has(q.status)) for (const c of links[q.question_id] ?? []) if (!out.includes(c)) out.push(c);
  return out;
}
