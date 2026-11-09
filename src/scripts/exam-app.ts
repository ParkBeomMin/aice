// T-06 실전 모드: 시작, 이어하기, 타이머, 시간 만료, 제출, 채점. 시도 하나는 한 탭에서만 수정 (Web Locks).
// 시간은 브라우저 안에서만 관리된다: 시계를 바꾸거나 브라우저 저장소를 지우면 제한을 우회할 수 있으며, 브라우저가 닫혀 있는 동안 자동 제출되지 않는다.
import { startNotebook, type NotebookController } from './notebook-app.ts';
import { readConfig, runGrading, type PageConfig } from './grading-ui.ts';
import { createExamStore, createFencedDraftStore, StaleOwner, type Attempt } from '../lib/storage/exam-store.ts';
import { IndexedDbStorage } from '../lib/storage/indexeddb-storage.ts';
import { findResumable, staleRevisionAttempts } from '../lib/exam/exam-state.ts';
import { startExamExclusive, type ExclusiveLocks } from '../lib/exam/start.ts';
import { transition, crossedWarnings, formatRemaining, MonotonicDeadline, remainingMs } from '../lib/exam/exam-state.ts';
import { acquireAttemptLock, locksAvailable, type AttemptLock } from '../lib/exam/exam-lock.ts';
import { commitSubmission, SubmitError } from '../lib/grading/grading-runner.ts';
import { track } from '../lib/analytics.ts';
import { expose } from '../lib/debug.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TAB_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function startExamApp() {
  const cfg = readConfig();
  const store = createExamStore();
  const screen = $('ex-screen'); const msg = $('ex-screen-msg'); const actions = $('ex-screen-actions');
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`aice-exam:${cfg.packId}`) : null;
  let owner = false;
  const dbg = { state: 'loading' as string, attempt: null as Attempt | null };
  expose('__acfExam', dbg);

  const say = (text: string, buttons: [string, () => void, boolean?][] = []) => {
    screen.hidden = false; msg.textContent = text;
    actions.replaceChildren(...buttons.map(([label, fn, primary]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (primary) b.className = 'primary'; b.onclick = fn; return b; }));
  };
  bc && (bc.onmessage = () => { if (!owner) void route(); });

  if (!locksAvailable()) { dbg.state = 'unsupported'; say('이 브라우저는 여러 탭 동시 수정 방지(Web Locks)를 지원하지 않아 실전 모드를 사용할 수 없습니다. 최신 Chrome, Edge, Firefox, Safari를 사용하거나 연습 모드를 이용하세요.', [['연습 모드로', () => { location.href = cfg.urls.practice; }]]); return; }

  async function route() {
    let atts: Attempt[];
    try { atts = (await store.listAttempts(cfg.packId)).filter((a) => a.mode === 'exam'); }
    catch (e) { dbg.state = 'storage-error'; say(`브라우저 저장소를 사용할 수 없어 실전 모드를 시작할 수 없습니다 (${(e as Error).message}). 시크릿 모드나 저장소 차단 여부를 확인하세요.`); return; }
    // 문제 노트북이 개정되기 전의 시도는 이어가거나 제출할 수 없음 (fingerprint 불일치) → 대상에서 제외하고 안내만
    const active = findResumable(atts, cfg.fingerprint);
    const stale = staleRevisionAttempts(atts, cfg.fingerprint).length; // 보존만 하고 이어가지 않음 (새 시작을 막지 않음)
    if (!active) return showStart(atts, stale);
    const lock = await acquireAttemptLock(active.attempt_id).catch(() => null);
    if (!lock) {
      dbg.state = 'blocked'; dbg.attempt = active;
      return say('이 시험은 다른 탭(또는 창)에서 진행 중입니다. 같은 시도를 두 곳에서 수정할 수 없어 이 탭은 열람만 막아 두었습니다.', [
        ['이 탭으로 가져오기', async () => {
          const ok = await confirmDialog('다른 탭의 시험을 이 탭으로 가져올까요? 다른 탭에서 아직 저장되지 않은 마지막 몇 초의 입력은 사라질 수 있습니다.', '가져오기');
          if (!ok) return;
          const l = await acquireAttemptLock(active.attempt_id, { steal: true }).catch(() => null);
          if (!l) return say('가져오지 못했습니다. 새로고침 후 다시 시도하세요.');
          await new Promise((r) => setTimeout(r, 800)); // 상대 탭의 마지막 저장을 기다림
          void enter((await store.getAttempt(active.attempt_id)) ?? active, l);
        }, true],
        ['결과 페이지', () => { location.href = cfg.urls.result; }],
      ]);
    }
    return enter(active, lock);
  }

  function showStart(atts: Attempt[], stale = 0) {
    dbg.state = 'start';
    const done = atts.filter((a) => a.status === 'submitted').length;
    say(`제한시간 ${cfg.timeLimitMinutes}분, ${cfg.questionIds.length}문항. 시작하면 타이머가 돌아가며, 시간이 끝나면 편집과 실행이 멈추고 마지막 코드가 제출됩니다. 제출 후에는 수정할 수 없고, 정답과 해설은 제출 후 결과 화면에서 볼 수 있어요. 시간은 이 브라우저 안에서만 관리됩니다 (브라우저를 닫아 두면 자동 제출되지 않고, 다음 방문 때 만료 처리). 자체 연습용 채점이며 공식 AICE 점수가 아닙니다.${done ? ` (이전 제출 ${done}회)` : ''}${stale ? ` 문제 노트북이 개정되어 이전 버전에서 진행하던 시도 ${stale}개는 이어갈 수 없습니다.` : ''}`,
      [['시험 시작', () => void start(), true], ['연습 모드로', () => { location.href = cfg.urls.practice; }], ...(done ? [['지난 결과', () => { location.href = cfg.urls.result; }] as [string, () => void]] : [])]);
  }

  async function start() {
    // 두 탭이 동시에 시작해도 현재 개정판 시도는 하나만 (팩 단위 잠금 안에서 시작 화면과 같은 규칙으로 재확인)
    await startExamExclusive(store, (navigator as unknown as { locks: ExclusiveLocks }).locks, { packId: cfg.packId, fingerprint: cfg.fingerprint, timeLimitMinutes: cfg.timeLimitMinutes });
    bc?.postMessage({ type: 'changed' });
    track('exam_start', { pack_id: cfg.packId });
    void route();
  }

  async function enter(att0: Attempt, lock: AttemptLock) {
    // 소유권 세대(fencing) 획득: 이후 이 탭의 모든 시도, 초안, 제출 쓰기는 이 세대일 때만 성공
    const claimed = await store.claimOwnership(att0.attempt_id, TAB_ID);
    const gen = claimed.generation;
    let att = claimed.attempt;
    const put = (a: Attempt) => store.putAttemptFenced(a, gen);
    owner = true; dbg.attempt = att; (dbg as { generation?: number }).generation = gen;
    if (att.status === 'grading' || att.status === 'grading_failed') return gradeScreen(att, lock, gen);
    if (att.status === 'submitting') {
      const sub = await store.getSubmission(att.attempt_id);
      if (sub) return gradeScreen(await put({ ...att, status: 'grading' }), lock, gen);
      att = await put({ ...att, status: remainingMs(att.deadline_at!, Date.now()) > 0 ? 'in_progress' : 'expired' }); // 제출 도중 중단됨 → 되돌림
    }
    screen.hidden = true; $('ex-shell').hidden = false; $('ex-bar').hidden = false;
    const ctrl = startNotebook({ mode: 'exam', scope: `exam:${att.attempt_id}`, canWrite: () => lock.owned,
      draftStore: createFencedDraftStore(IndexedDbStorage, att.attempt_id, () => gen) });
    await ctrl.ready;
    dbg.state = 'in_progress';
    const deadline = new MonotonicDeadline(att.deadline_at!);
    let submitting: Promise<void> | null = null;
    let lost = false;
    const timerEl = $('ex-timer');
    let prev = deadline.remaining();
    const closedWhileOpen = att.status === 'in_progress' && prev === 0;
    const tick = () => {
      const r = deadline.remaining();
      timerEl.textContent = formatRemaining(r);
      timerEl.dataset.level = r <= 60_000 ? 'critical' : r <= 300_000 ? 'warn' : '';
      for (const w of crossedWarnings(prev, r)) ctrl.notice(`남은 시간 ${w}분입니다.`, w <= 1 ? 'error' : 'warn');
      prev = r;
      if (r === 0 && !submitting && !lost) submitting = finish('expired');
    };
    let timer = setInterval(tick, 500);
    const onLost = () => {
      if (lost) return;
      lost = true; owner = false; clearInterval(timer); dbg.state = 'lost';
      ctrl.setLocked(true, '다른 탭이 이 시험을 가져갔습니다. 이 탭은 더 이상 수정하거나 제출할 수 없습니다. 저장된 제출본과 진행 상태는 다른 탭 기준입니다.');
      ctrl.disposeKernel(); $('ex-submit').setAttribute('disabled', '');
    };
    lock.lost.then(onLost);
    $('ex-submit').onclick = async () => {
      if (submitting || lost) return;
      const running = ctrl.isRunning();
      const ok = await confirmDialog(`${running ? '실행 중인 셀이 있습니다. 실행을 중단하고 ' : ''}지금 제출할까요? 제출 후에는 코드를 수정할 수 없고, 제출한 코드를 새 Python 에서 처음부터 다시 실행해 채점합니다.`, '제출하고 채점');
      if (!ok || submitting || lost) return;
      submitting = finish('manual');
    };

    async function finish(reason: 'manual' | 'expired') {
      clearInterval(timer);
      ctrl.setLocked(true, reason === 'expired' ? (closedWhileOpen ? '시험 시간이 지났습니다. 브라우저가 닫혀 있는 동안에는 자동 제출되지 않았으며, 지금 마지막으로 저장된 코드로 제출합니다.' : '시험 시간이 끝났습니다. 편집과 실행을 멈추고 마지막 코드로 제출합니다.') : '제출 중입니다…');
      if (ctrl.isRunning()) ctrl.interrupt();
      $('ex-submit').setAttribute('disabled', '');
      timerEl.textContent = reason === 'expired' ? '00:00' : timerEl.textContent;
      try {
        await ctrl.flushSave().catch(() => false);
        let cur = (await store.getAttempt(att.attempt_id)) ?? att;
        if (!lock.owned) throw new StaleOwner('이 탭은 시험 소유권이 없습니다');
        if (reason === 'expired' && cur.status === 'in_progress') cur = await put(transition(cur, 'expired'));
        cur = await put(transition(cur, 'submitting'));
        const snap = await ctrl.snapshot();
        dbg.state = 'submitting';
        const { attempt } = await commitSubmission(store, cur, snap, reason, cfg, gen); // 같은 트랜잭션에서 세대 확인
        track('exam_submit', { pack_id: cfg.packId, reason });
        bc?.postMessage({ type: 'changed' });
        ctrl.disposeKernel();
        dbg.state = 'grading';
        await gradeScreen(attempt, lock, gen, ctrl);
      } catch (e) {
        if (e instanceof StaleOwner || !lock.owned) {
          // 소유권을 잃음: 이 탭은 아무것도 확정하지 않는다. 진행 상태, 제출본은 새 소유 탭 기준
          onLost(); submitting = null;
          ctrl.notice(`제출하지 않았습니다: ${(e as Error).message}. 시험은 다른 탭에서 이어집니다.`, 'error');
          return;
        }
        // 제출본 저장 실패: 성공으로 표시하지 않고 되돌림 (만료된 시도는 expired 유지)
        const cur = await store.getAttempt(att.attempt_id).catch(() => undefined);
        if (cur && cur.status === 'submitting') await put({ ...cur, status: remainingMs(cur.deadline_at!, Date.now()) > 0 && reason === 'manual' ? 'in_progress' : 'expired' }).catch(() => {});
        dbg.state = 'submit-failed';
        submitting = null;
        if (reason === 'manual' && lock.owned) { ctrl.setLocked(false); $('ex-submit').removeAttribute('disabled'); timer = setInterval(tick, 500); }
        ctrl.notice(`제출하지 못했습니다: ${(e as Error).message}. 코드를 잃지 않으려면 '내 노트북 다운로드'로 보관하세요.`, 'error', [['다시 제출', () => { if (!submitting) submitting = finish(reason); }]]);
      }
    }
  }

  async function gradeScreen(att: Attempt, lock: AttemptLock, gen: number, ctrl?: NotebookController) {
    owner = true;
    let lostDuringGrading = false;
    lock.lost.then(() => { lostDuringGrading = true; });
    const run = async () => {
      dbg.state = 'grading';
      say('제출 완료. 채점 중입니다… (이 탭을 닫아도 제출본은 저장되어 있어 나중에 다시 채점할 수 있어요)');
      try {
        const gr = await runGrading(store, cfg, att.attempt_id, gen);
        track('exam_graded', { pack_id: cfg.packId, score_percent: gr.totals.percent ?? -1, correct: gr.totals.correct_count, gradable: gr.totals.gradable_count });
        if (lostDuringGrading) { dbg.state = 'lost'; say('채점 도중 다른 탭이 시험을 가져갔습니다. 결과는 그 탭(또는 결과 페이지)에서 확인하세요.', [['결과 페이지', () => { location.href = cfg.urls.result; }]]); return; }
        dbg.state = 'graded'; lock.release(); bc?.postMessage({ type: 'changed' });
        location.href = cfg.urls.result;
      } catch (e) {
        if (e instanceof StaleOwner || lostDuringGrading) {
          dbg.state = 'lost';
          return say('다른 탭이 이 시험을 가져가 이 탭의 채점 결과는 저장하지 않았습니다 (채점 실패가 아님). 같은 제출본으로 그 탭에서 채점이 이어집니다.', [['결과 페이지', () => { location.href = cfg.urls.result; }]]);
        }
        dbg.state = 'grading-failed';
        say(`제출은 저장되었지만 채점에 실패했습니다: ${(e as Error).message}. 같은 제출본으로 다시 채점할 수 있습니다 (오답 처리되지 않음).`, [['다시 채점', () => void run(), true], ['결과 페이지', () => { location.href = cfg.urls.result; }]]);
      }
    };
    if (ctrl) { $('ex-shell').hidden = true; $('ex-bar').hidden = true; }
    return run();
  }

  await route();
}

function confirmDialog(text: string, okLabel: string): Promise<boolean> {
  const d = document.getElementById('ex-dialog') as HTMLDialogElement;
  (document.getElementById('ex-dialog-msg') as HTMLElement).textContent = text;
  const ok = document.getElementById('ex-dialog-ok') as HTMLButtonElement;
  const cancel = document.getElementById('ex-dialog-cancel') as HTMLButtonElement;
  ok.textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v: boolean) => { d.close(); ok.onclick = cancel.onclick = null; resolve(v); };
    ok.onclick = () => done(true); cancel.onclick = () => done(false);
    d.oncancel = () => done(false);
    d.showModal();
  });
}
export type { PageConfig };
