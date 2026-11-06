// T-06 결과 화면: IndexedDB 에 저장된 제출, 채점 결과를 렌더링 (외부 전송 없음). 모든 사용자 데이터는 textContent 로만 표시.
import { recommendCards } from '../lib/cards-progress';
import { saveReco } from './cards-store';
import { readConfig, runGrading, LAST_RESULT_KEY, type PageConfig } from './grading-ui.ts';
import { createExamStore, type Attempt, type ExamStore } from '../lib/storage/exam-store.ts';
import { acquireAttemptLock, locksAvailable } from '../lib/exam/exam-lock.ts';
import type { AttemptResult, QuestionStatus } from '../lib/grading/types.ts';
import { expose } from '../lib/debug.ts';

export const STATUS_LABEL: Record<QuestionStatus, string> = {
  correct: '정답', partial: '부분 정답', incorrect: '오답', execution_error: '실행 오류', blocked: '채점 불가(선행 문항 오류)', ungraded: '미채점', self_check: '자기 점검',
};
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...kids: (Node | string | null)[]) => {
  const { dataset, ...rest } = props;
  const el = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(el.dataset, dataset);
  el.append(...kids.filter((k): k is Node | string => k !== null));
  return el;
};
const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const dur = (ms: number) => { const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return m ? `${m}분 ${s}초` : `${s}초`; };

export async function startResultApp() {
  const cfg = readConfig();
  const store = createExamStore();
  const root = document.getElementById('rs-root')!;
  let atts: Attempt[];
  try { atts = await store.listAttempts(cfg.packId); }
  catch (e) { root.replaceChildren(h('p', { className: 'nb-notice error', textContent: `이 브라우저 저장소를 열 수 없습니다 (${(e as Error).message}).` })); return; }
  const results = new Map<string, AttemptResult>();
  for (const a of atts) { const r = await store.getResult(a.attempt_id).catch(() => undefined); if (r) results.set(a.attempt_id, r); }
  const pending = atts.filter((a) => (a.status === 'grading' || a.status === 'grading_failed') && !results.has(a.attempt_id) && a.notebook_fingerprint === cfg.fingerprint);
  const done = atts.filter((a) => results.has(a.attempt_id));
  expose('__acfResult', { results, atts });
  const kids: Node[] = [];
  for (const p of pending) kids.push(pendingCard(store, cfg, p));
  if (!done.length) {
    kids.push(h('p', {}, '아직 채점 결과가 없습니다. ', h('a', { href: cfg.urls.exam, textContent: '실전 모드' }), ' 또는 ', h('a', { href: cfg.urls.practice, textContent: '연습 모드' }), '에서 풀고 채점해 보세요.'));
    root.replaceChildren(...kids); return;
  }
  const want = sessionStorage.getItem(LAST_RESULT_KEY);
  let sel = done.find((a) => a.attempt_id === want) ?? done[0];
  const view = h('div', { id: 'rs-view' });
  if (done.length > 1) {
    const s = document.createElement('select');
    s.id = 'rs-select';
    for (const a of done) {
      const r = results.get(a.attempt_id)!;
      const o = document.createElement('option');
      o.value = a.attempt_id;
      o.textContent = `${a.mode === 'exam' ? '실전' : '연습'}, ${fmt(r.submitted_at)}, ${r.totals.awarded_points}/${r.totals.available_points}점`;
      s.append(o);
    }
    s.value = sel.attempt_id;
    s.onchange = () => { sel = done.find((a) => a.attempt_id === s.value)!; sessionStorage.setItem(LAST_RESULT_KEY, sel.attempt_id); void render(); };
    kids.push(h('p', {}, h('label', { htmlFor: 'rs-select', textContent: '기록: ' }), s));
  }
  kids.push(view);
  root.replaceChildren(...kids);
  const render = async () => view.replaceChildren(await renderResult(store, cfg, sel, results.get(sel.attempt_id)!));
  await render();
}

function pendingCard(store: ExamStore, cfg: PageConfig, a: Attempt) {
  const msg = h('span', { textContent: a.status === 'grading_failed' ? `채점 실패: ${a.grading_error ?? ''}` : '제출은 저장되었지만 채점이 끝나지 않았습니다.' });
  const b = h('button', { type: 'button', textContent: '같은 제출본으로 다시 채점', className: 'primary' });
  b.onclick = async () => {
    b.disabled = true;
    const lock = locksAvailable() ? await acquireAttemptLock(a.attempt_id).catch(() => null) : null;
    if (locksAvailable() && !lock) { msg.textContent = '다른 탭에서 채점 중입니다.'; b.disabled = false; return; }
    try { await runGrading(store, cfg, a.attempt_id); location.reload(); }
    catch (e) { msg.textContent = `채점 실패: ${(e as Error).message}`; b.disabled = false; }
    finally { lock?.release(); }
  };
  return h('div', { className: 'nb-notice warn rs-pending', dataset: { attempt: a.attempt_id } }, `${a.mode === 'exam' ? '실전' : '연습'}, ${a.submitted_at ? fmt(a.submitted_at) : ''}, `, msg, ' ', b);
}

async function renderResult(store: ExamStore, cfg: PageConfig, a: Attempt, r: AttemptResult) {
  const t = r.totals;
  const sub = await store.getSubmission(a.attempt_id);
  const info = new Map(cfg.info.map((i) => [i.question_id, i]));
  const head = h('section', { className: 'rs-summary' },
    h('h2', { textContent: `${a.mode === 'exam' ? '실전 모의고사' : '연습 채점'}: ${cfg.title}` }),
    h('div', { className: 'rs-score' },
      h('div', {}, h('strong', { className: 'rs-big', textContent: `${t.awarded_points}/${t.available_points}`, dataset: { testid: 'score' } }), h('span', { textContent: ' 점 (자동 채점 가능 문항 기준)' })),
      h('div', {}, h('strong', { className: 'rs-big', textContent: t.percent === null ? '-' : `${t.percent}%` })),
      h('div', {}, h('strong', { className: 'rs-big', textContent: `${t.correct_count}/${t.gradable_count}` }), h('span', { textContent: ' 정답 문항' })),
      h('div', {}, h('strong', { className: 'rs-big', textContent: String(t.ungraded_count + t.self_check_count) }), h('span', { textContent: ' 미채점, 자기 점검' }))),
    h('dl', { className: 'facts' },
      h('div', {}, h('dt', { textContent: '시작' }), h('dd', { textContent: fmt(r.started_at) })),
      h('div', {}, h('dt', { textContent: '제출' }), h('dd', { textContent: `${fmt(r.submitted_at)}${r.submit_reason === 'expired' ? ' (시간 만료 제출)' : ''}` })),
      h('div', {}, h('dt', { textContent: '소요' }), h('dd', { textContent: a.mode === 'exam' ? dur(Date.parse(r.submitted_at) - Date.parse(r.started_at)) : '-' })),
      h('div', {}, h('dt', { textContent: '채점' }), h('dd', { textContent: `${dur(r.grading_ms)}, ${r.grading_version}, 엔진 ${r.engine_version}` }))),
    h('p', { className: 'disclaimer', textContent: r.disclaimer }));
  const rows = r.questions.map((q) => {
    const i = info.get(q.question_id);
    const code = sub?.snapshot.cells.find((c) => c.questionId === q.question_id)?.source ?? '';
    const det = h('details', { className: 'rs-detail' }, h('summary', { textContent: '제출 코드, 정답, 해설' }),
      h('h4', { textContent: '내 제출 코드' }), h('pre', { textContent: code || '(비어 있음)' }),
      ...(q.checks.length ? [h('h4', { textContent: '검사 항목' }), h('ul', {}, ...q.checks.map((c) => h('li', { className: c.passed ? 'ok' : 'fail', textContent: c.passed ? `✔ ${c.label ?? c.id}` : `✘ ${c.label ? `${c.label}: ` : ''}${c.feedback ?? c.id}${c.detail ? ` (${c.detail})` : ''}` })))] : []),
      ...(i?.answer ? [h('h4', { textContent: '정답 코드 (예시)' }), h('pre', { textContent: i.answer })] : []),
      h('p', {}, h('a', { href: i?.url ?? '#', textContent: i?.explanation ? '해설 보기' : '문제 페이지' }), ...(i?.video ? [' | ', h('a', { href: i.video, textContent: '풀이 영상', rel: 'noopener', target: '_blank' })] : [])));
    return h('tr', { dataset: { qid: q.question_id, status: q.status } },
      h('td', { textContent: q.question_id.toUpperCase() }),
      h('td', {}, i?.title ?? '', det),
      h('td', {}, h('span', { className: `rs-badge ${q.status}`, textContent: STATUS_LABEL[q.status] })),
      h('td', { textContent: q.available_points ? `${q.awarded_points}/${q.available_points}` : '-' }),
      h('td', { textContent: [...q.feedback, q.error_summary ? `오류: ${q.error_summary}` : ''].filter(Boolean).join(', ') }));
  });
  const table = h('table', { className: 'qtable rs-table' },
    h('thead', {}, h('tr', {}, ...['번호', '문항', '결과', '점수', '피드백'].map((x) => h('th', { scope: 'col', textContent: x })))), h('tbody', {}, ...rows));
  const dl = h('button', { type: 'button', textContent: '내 제출 노트북 다운로드 (.ipynb)' });
  dl.onclick = async () => { if (sub) downloadBlob(await submissionNotebook(cfg, sub.snapshot.cells), `${cfg.packId}-submission-${a.attempt_id.slice(-6)}.ipynb`); };
  const dj = h('button', { type: 'button', textContent: '결과 JSON 다운로드' });
  dj.onclick = () => downloadBlob(new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' }), `${cfg.packId}-result-${a.attempt_id.slice(-6)}.json`);
  const again = h('p', { className: 'ex-actions' }, h('a', { className: 'btn', href: cfg.urls.exam, textContent: '실전 다시 풀기' }), ' ', h('a', { className: 'btn', href: cfg.urls.practice, textContent: '연습 모드' }), ' ', dl, ' ', dj);
  const reco = cardRecoSection(r);
  return h('div', {}, head, again, ...(reco ? [reco] : []), table);
}

/** 개념 카드 추천 (T-07D): 오답, 부분 정답, 실행 오류, 채점 불가 문항의 연결 카드. 복습 화면으로는 세션 저장소로만 넘긴다 (URL 에 점수, 답안 없음) */
function cardRecoSection(r: AttemptResult): HTMLElement | null {
  const el = document.getElementById('cards-reco-config');
  if (!el) return null;
  const c = JSON.parse(el.textContent || '{}') as { pack_id: string; pack_title: string; links: Record<string, string[]>; cards: Record<string, { f: string; deck: string; deck_id: string }>; review_url: string; cards_url: string };
  const ids = recommendCards(r.questions.map((q) => ({ question_id: q.question_id, status: q.status })), c.links).filter((id) => c.cards[id]);
  if (!ids.length) {
    return h('section', { className: 'rs-cards' }, h('h3', { textContent: '개념 카드' }),
      h('p', { textContent: '틀린 문항이 없어서 따로 추천할 카드가 없어요. 개념 카드에서 전체 주제를 둘러볼 수 있어요.' }),
      h('a', { href: c.cards_url, textContent: '개념 카드 보기' }));
  }
  const shown = ids.slice(0, 8);
  const go = h('button', { type: 'button', className: 'btn', textContent: `추천 카드 ${ids.length}장 복습하기` });
  go.onclick = () => { saveReco({ pack_id: c.pack_id, pack_title: c.pack_title, card_ids: ids }); location.href = c.review_url; };
  return h('section', { className: 'rs-cards', dataset: { recoCount: String(ids.length) } },
    h('h3', { textContent: '틀린 문항과 관련된 개념 카드' }),
    h('p', { className: 'rs-cards-sub', textContent: '오답, 부분 정답, 실행 오류 문항에 연결된 카드예요. 카드로 개념을 다시 확인해 보세요.' }),
    h('ul', { className: 'rs-cards-list' }, ...shown.map((id) => h('li', {}, h('span', { className: 'rel-deck', textContent: c.cards[id].deck }), h('span', { className: 'rel-q', textContent: c.cards[id].f })))),
    ...(ids.length > shown.length ? [h('p', { className: 'rs-cards-sub', textContent: `외 ${ids.length - shown.length}장` })] : []),
    go);
}

async function submissionNotebook(cfg: PageConfig, cells: readonly { cellId: string; source: string }[]) {
  const nb = await (await fetch(cfg.notebookUrl, { cache: 'no-cache' })).json();
  for (const c of nb.cells) if (c.cell_type === 'code') { const s = cells.find((x) => x.cellId === c.id); if (s) c.source = s.source; c.outputs = []; c.execution_count = null; }
  return new Blob([JSON.stringify(nb, null, 1) + '\n'], { type: 'application/x-ipynb+json' });
}
function downloadBlob(b: Blob, name: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
