// T-06 공용: 페이지 설정 읽기, 채점 실행(별도 Worker), 진행 표시, 연습 채점
import { workerBackendFactory } from '../lib/grading/worker-backend.ts';
import { gradeSubmission, commitSubmission, type GradingConfig } from '../lib/grading/grading-runner.ts';
import { packagesFor } from '../lib/runtime/worker-protocol.ts';
import { createExamStore, type ExamStore } from '../lib/storage/exam-store.ts';
import { practiceAttempt } from '../lib/exam/exam-state.ts';
import type { AttemptResult } from '../lib/grading/types.ts';
import type { NotebookController } from './notebook-app.ts';
import { expose } from '../lib/debug.ts';

export interface PageConfig extends GradingConfig {
  title: string; notebookUrl: string; timeLimitMinutes: number;
  info: { question_id: string; title: string; url: string; answer: string | null; explanation: boolean; video: string | null }[];
  datasets: { name: string; url: string; sha256: string; size: number }[];
  urls: { practice: string; exam: string; result: string; pack: string };
}
export function readConfig(): PageConfig {
  const el = document.getElementById('acf-config');
  if (!el) throw new Error('페이지 설정 없음');
  return JSON.parse(el.textContent || '{}') as PageConfig;
}

export const LAST_RESULT_KEY = 'aice-last-result'; // sessionStorage (URL 에 기록을 넣지 않음)

function progressEl() { return document.getElementById('grading-progress'); }
export function showProgress(text: string | null) {
  const el = progressEl(); if (!el) return;
  el.hidden = text === null; el.textContent = text ?? '';
}

/** 저장된 제출본을 별도 채점 Worker 로 채점 (학습 커널과 무관) */
export async function runGrading(store: ExamStore, cfg: PageConfig, attemptId: string, gen?: number): Promise<AttemptResult> {
  const t0 = performance.now();
  const tick = setInterval(() => { const el = progressEl(); if (el && !el.hidden) el.dataset.elapsed = String(Math.round((performance.now() - t0) / 1000)); }, 500);
  showProgress('채점 준비 중… (채점용 Python 을 새로 시작하고 제출한 코드를 처음부터 다시 실행합니다)');
  try {
    const factory = workerBackendFactory({
      datasets: cfg.datasets,
      workerFactory: () => new Worker(new URL('../lib/grading/grading.worker.ts', import.meta.url), { type: 'module' }),
    });
    const r = await gradeSubmission(store, attemptId, cfg, factory, packagesFor, (qid, i, n) => showProgress(`채점 중… ${qid.toUpperCase()} (${i + 1}/${n}), ${Math.round((performance.now() - t0) / 1000)}초`), gen);
    expose('__acfLastGrading', { ms: Math.round(performance.now() - t0), attemptId });
    sessionStorage.setItem(LAST_RESULT_KEY, attemptId);
    return r;
  } finally { clearInterval(tick); showProgress(null); }
}

/** 연습 모드: 현재 에디터 코드로 연습 채점 (편집은 계속 가능, 제출본은 따로 보관) */
export function setupPracticeGrading(ctrl: NotebookController) {
  const cfg = readConfig();
  const b = document.getElementById('nb-grade') as HTMLButtonElement | null;
  if (!b) return;
  const store = createExamStore();
  void ctrl.ready.then(() => { b.disabled = !cfg.grading; });
  b.onclick = async () => {
    b.disabled = true;
    try {
      await ctrl.flushSave().catch(() => false);
      const att = await store.putAttempt(practiceAttempt({ packId: cfg.packId, fingerprint: cfg.fingerprint }));
      const snap = await ctrl.snapshot(); // 버튼 누른 시점 코드 고정
      await commitSubmission(store, att, snap, 'practice', cfg);
      const r = await runGrading(store, cfg, att.attempt_id);
      const t = r.totals;
      ctrl.notice(`연습 채점 완료: 자동 채점 ${t.gradable_count}문항 중 정답 ${t.correct_count}, ${t.awarded_points}/${t.available_points}점${t.percent !== null ? ` (${t.percent}%)` : ''}, 미채점 ${t.ungraded_count + t.self_check_count}문항. 공식 점수 아님.`, 'info',
        [['결과와 해설 보기', () => { location.href = cfg.urls.result; }]]);
    } catch (e) {
      ctrl.notice(`연습 채점 실패: ${(e as Error).message}. 결과 페이지에서 같은 제출본으로 다시 채점할 수 있습니다.`, 'error', [['결과 페이지', () => { location.href = cfg.urls.result; }]]);
    } finally { b.disabled = !cfg.grading; }
  };
}
