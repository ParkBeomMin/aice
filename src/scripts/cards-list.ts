// 덱 목록, 덱 소개 페이지의 학습 진행률 표시 (T-07D). 기록이 없거나 저장소를 못 쓰면 기본 문구 유지.
import { deckStats, type StudyCard } from '../lib/cards-progress';
import { openCardStore } from './cards-store';

interface Cfg { decks: { id: string; cards: { id: string; dg: string }[] }[] }

export async function startCardProgress(): Promise<void> {
  const el = document.getElementById('cards-progress-config');
  if (!el) return;
  const cfg = JSON.parse(el.textContent || '{}') as Cfg;
  const store = await openCardStore();
  const paint = async () => {
    const recs = await store.getAll();
    let reviewTotal = 0;
    for (const d of cfg.decks) {
      const cards = d.cards.map((c) => ({ id: c.id, dg: c.dg }) as StudyCard);
      const st = deckStats(cards, recs);
      reviewTotal += st.review + st.changed;
      for (const box of document.querySelectorAll<HTMLElement>(`[data-deck-id="${d.id}"]`)) {
        const fill = box.querySelector<HTMLElement>('.cl-fill');
        const txt = box.querySelector<HTMLElement>('.cl-ptext');
        if (fill) fill.style.width = `${st.percent}%`;
        if (txt && st.studied + st.changed > 0) {
          txt.textContent = `${st.total}장 중 ${st.studied}장 학습, 알아요 ${st.known}, 다시 볼 카드 ${st.review + st.changed}`;
        }
      }
    }
    const cta = document.getElementById('cards-review-cta');
    if (cta) { cta.hidden = reviewTotal === 0; const n = document.getElementById('cards-review-n'); if (n) n.textContent = String(reviewTotal); }
  };
  await paint();
  store.onExternalChange(() => void paint());
}
