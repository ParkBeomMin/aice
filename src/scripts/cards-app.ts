// 개념 카드 학습 화면 (T-07D). 뒤집기 → 평가(알아요/다시 볼게요) → 다음 카드. 기록은 aice-cards IndexedDB.
import { applyRating, cardStatus, deckStats, filterCards, shuffled, type Filter, type ProgressRecord, type Rating, type StudyCard } from '../lib/cards-progress';
import { clearReco, loadReco, openCardStore, type CardStore } from './cards-store';

interface DeckPayload { deck_id: string; title: string; cards: StudyCard[] }
interface Config { mode: 'deck' | 'review'; deckId: string | null; decks: DeckPayload[]; urls: { list: string; review: string; deck: string } }
type Item = StudyCard & { deck: string; deckTitle: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATE_LABEL: Record<string, string> = { new: '처음 보는 카드', known: '알아요로 표시함', review: '다시 볼 카드', changed: '내용이 바뀌어 다시 확인 필요' };

export async function startCardStudy(): Promise<void> {
  const cfg = JSON.parse($('cards-config').textContent || '{}') as Config;
  const all: Item[] = cfg.decks.flatMap((d) => d.cards.map((c) => ({ ...c, deck: d.deck_id, deckTitle: d.title })));
  const byId = new Map(all.map((c) => [c.id, c]));
  const store: CardStore = await openCardStore();
  let recs: Map<string, ProgressRecord> = await store.getAll();
  const showStoreNotice = () => {
    if (store.persistent) return;
    const n = $('cs-store-notice');
    n.textContent = store.lostHistory
      ? '이전 학습 기록을 불러오지 못했어요. 지금 창에서는 그대로 학습할 수 있지만, 창을 닫으면 이번 기록도 사라져요.'
      : '이 브라우저에 학습 기록을 저장할 수 없어요. 지금까지의 기록은 이 창에서 유지되지만, 창을 닫으면 사라져요.';
    n.hidden = false;
  };
  showStoreNotice();
  store.onStatusChange(showStoreNotice);

  let reco = cfg.mode === 'review' ? loadReco() : null;
  if (reco) reco = { ...reco, card_ids: reco.card_ids.filter((id) => byId.has(id)) };
  let filter: Filter = cfg.mode === 'review' && !reco?.card_ids.length ? 'review' : 'all';
  let shuffleOn = false;
  let queue: Item[] = [];
  let pos = 0;
  let flipped = false;
  const session = { known: 0, review: 0 };

  const base = (): Item[] => (reco?.card_ids.length ? reco.card_ids.map((id) => byId.get(id)!).filter(Boolean) : all);
  const live = (t: string) => { const el = $('cs-live'); el.textContent = ''; requestAnimationFrame(() => { el.textContent = t; }); };

  function rebuild(keepCard = false) {
    const cur = queue[pos]?.id;
    const list = filterCards(base(), recs, filter) as Item[];
    queue = shuffleOn ? shuffled(list) : list;
    pos = keepCard && cur ? Math.max(0, queue.findIndex((c) => c.id === cur)) : 0;
    flipped = false;
  }

  function renderCounts() {
    const b = base();
    const n = { all: b.length, new: filterCards(b, recs, 'new').length, review: filterCards(b, recs, 'review').length };
    document.querySelectorAll<HTMLElement>('.cs-n').forEach((el) => { el.textContent = String(n[el.dataset.n as Filter]); });
    document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b2) => b2.setAttribute('aria-pressed', String(b2.dataset.filter === filter)));
    $('cs-shuffle').setAttribute('aria-pressed', String(shuffleOn));
    const st = deckStats(b, recs);
    $('cs-stat').textContent = `알아요 ${st.known}, 다시 볼 카드 ${st.review + st.changed}, 처음 ${st.unseen}`;
    if (reco?.card_ids.length) {
      $('cs-reco').hidden = false;
      $('cs-reco-text').textContent = `‘${reco.pack_title}’ 채점 결과에서 틀리거나 부분 정답인 문항과 관련된 카드 ${reco.card_ids.length}장을 모았어요.`;
    } else $('cs-reco').hidden = true;
  }

  function showPanel(which: 'main' | 'done' | 'empty') {
    $('cs-main').hidden = which !== 'main';
    $('cs-done').hidden = which !== 'done';
    $('cs-empty').hidden = which !== 'empty';
  }

  function render(focus = false) {
    renderCounts();
    if (!queue.length) {
      showPanel('empty');
      const msg = filter === 'review' ? ['다시 볼 카드가 없어요', '‘다시 볼게요’ 로 표시한 카드가 여기에 모여요. 전체 카드부터 학습해 보세요.']
        : filter === 'new' ? ['모든 카드를 한 번씩 봤어요', '전체 카드나 다시 볼 카드로 복습해 보세요.'] : ['카드가 없어요', ''];
      $('cs-empty-title').textContent = msg[0];
      $('cs-empty-text').textContent = msg[1];
      if (focus) $('cs-empty').focus();
      return;
    }
    showPanel('main');
    const c = queue[pos];
    $('cs-count').textContent = `${pos + 1} / ${queue.length}`;
    ($('cs-bar-fill') as HTMLElement).style.width = `${Math.round(((pos + 1) / queue.length) * 100)}%`;
    $('cs-deck').textContent = c.deckTitle;
    const st = cardStatus(c, recs.get(c.id));
    $('cs-state').textContent = STATE_LABEL[st];
    $('cs-state').dataset.state = st;
    $('cs-front').textContent = c.f;
    const back = $('cs-back');
    const card = $('cs-card');
    card.classList.toggle('is-flipped', flipped);
    $('cs-flip').setAttribute('aria-expanded', String(flipped));
    $('cs-flip').innerHTML = flipped ? '질문만 보기 <kbd>Space</kbd>' : '정답 보기 <kbd>Space</kbd>';
    if (flipped) {
      $('cs-answer').textContent = c.b;
      const hasCode = !!c.code;
      $('cs-code-wrap').hidden = !hasCode;
      if (hasCode) {
        $('cs-code').textContent = c.code;
        $('cs-code-cap').textContent = c.rt === 'external_only' ? '참고 코드 (TensorFlow 등, 이 사이트에서는 실행하지 않아요)' : '참고 코드';
      }
      back.hidden = false;
    } else {
      back.hidden = true;
      $('cs-answer').textContent = '';
      $('cs-code').textContent = '';
    }
    ($('cs-known') as HTMLButtonElement).disabled = !flipped;
    ($('cs-again') as HTMLButtonElement).disabled = !flipped;
    $('cs-rate-hint').hidden = flipped;
    ($('cs-prev') as HTMLButtonElement).disabled = pos === 0;
    ($('cs-next') as HTMLButtonElement).textContent = pos === queue.length - 1 ? '마치기' : '다음 →';
    if (focus) { $('cs-front').focus({ preventScroll: true }); live(`카드 ${pos + 1} / ${queue.length}. ${c.f}`); }
  }

  function flip() {
    if (!queue.length || !$('cs-main').offsetParent) return;
    flipped = !flipped;
    render();
    live(flipped ? `정답: ${queue[pos].b}` : '질문으로 돌아왔어요');
    $('cs-flip').focus({ preventScroll: true }); // 평가 버튼으로 옮기면 Space 두 번에 '알아요' 가 눌릴 수 있음
  }
  function go(d: number) {
    if (!queue.length) return;
    if (pos + d >= queue.length) return finish();
    pos = Math.max(0, pos + d);
    flipped = false;
    render(true);
  }
  function finish() {
    showPanel('done');
    renderCounts();
    const st = deckStats(base(), recs);
    $('cs-done-text').textContent = `이번에 알아요 ${session.known}장, 다시 볼게요 ${session.review}장을 표시했어요. 지금까지 ${st.total}장 중 ${st.studied}장을 학습했고, 다시 볼 카드는 ${st.review + st.changed}장이에요.`;
    $('cs-done').focus();
    live('학습을 마쳤어요');
  }
  async function rate(r: Rating) {
    if (!flipped || !queue.length) return;
    const c = queue[pos];
    const rec = applyRating(c, c.deck, recs.get(c.id), r, new Date());
    recs.set(c.id, rec);
    session[r]++;
    await store.put(rec);
    showStoreNotice();
    live(r === 'known' ? '알아요로 표시했어요' : '다시 볼 카드에 넣었어요');
    go(1);
  }

  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter as Filter; rebuild(); render(true); }));
  $('cs-shuffle').addEventListener('click', () => { shuffleOn = !shuffleOn; rebuild(); render(true); live(shuffleOn ? '카드를 섞었어요' : '원래 순서로 돌아왔어요'); });
  $('cs-flip').addEventListener('click', flip);
  $('cs-known').addEventListener('click', () => void rate('known'));
  $('cs-again').addEventListener('click', () => void rate('review'));
  $('cs-prev').addEventListener('click', () => go(-1));
  $('cs-next').addEventListener('click', () => go(1));
  $('cs-done-review').addEventListener('click', () => { filter = 'review'; rebuild(); render(true); });
  $('cs-done-restart').addEventListener('click', () => { filter = 'all'; rebuild(); render(true); });
  $('cs-empty-all').addEventListener('click', () => { filter = 'all'; rebuild(); render(true); });
  $('cs-reco-clear').addEventListener('click', () => { clearReco(); reco = null; filter = 'review'; rebuild(); render(true); });
  $('cs-reset').addEventListener('click', async () => {
    const ids = all.map((c) => c.id);
    const what = cfg.mode === 'deck' ? '이 덱' : '모든 덱';
    if (!window.confirm(`${what}의 학습 기록(알아요, 다시 볼게요)을 지울까요? 되돌릴 수 없어요.`)) return;
    await store.remove(ids);
    recs = await store.getAll(); // 저장 실패 시에도 메모리 상태와 화면을 맞춘다
    showStoreNotice();
    filter = 'all'; rebuild(); render(true);
    live('학습 기록을 지웠어요');
  });
  // 키보드: 입력창, 편집 영역에서는 동작하지 않음. Space, Enter 는 버튼에 포커스가 있으면 버튼 기본 동작을 따른다.
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onButton = !!t.closest('button, a');
    const k = e.key && e.key !== 'Unidentified' ? e.key : '';
    const is = (key: string, ...codes: string[]) => k === key || codes.includes(e.code);
    if ((is(' ', 'Space') || is('Enter', 'Enter', 'NumpadEnter')) && !onButton) { e.preventDefault(); flip(); }
    else if (is('ArrowRight', 'ArrowRight')) { e.preventDefault(); go(1); }
    else if (is('ArrowLeft', 'ArrowLeft')) { e.preventDefault(); go(-1); }
    else if (is('1', 'Digit1', 'Numpad1')) { e.preventDefault(); void rate('known'); }
    else if (is('2', 'Digit2', 'Numpad2')) { e.preventDefault(); void rate('review'); }
  });
  store.onExternalChange(async () => { recs = await store.getAll(); renderCounts(); });

  // 덱 학습은 처음 보는 카드부터 (모두 봤으면 처음부터)
  rebuild();
  if (cfg.mode === 'deck') {
    const firstNew = queue.findIndex((c) => cardStatus(c, recs.get(c.id)) === 'new');
    if (firstNew > 0) pos = firstNew;
  }
  render();
  document.documentElement.dataset.cardsReady = '1';
}
