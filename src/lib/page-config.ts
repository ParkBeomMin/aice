// 빌드 시 노트북, 시험, 결과 페이지에 넣는 설정 (공개 번들에서만 생성)
import { getQuestion, type Manifest } from './content';
import { pageUrl, withBase } from './paths';

export function pageConfig(m: Manifest) {
  const qs = m.questions.map((mq) => getQuestion(m.pack_id, mq.question_id)!);
  return {
    packId: m.pack_id, title: m.title, fingerprint: m.notebook.sha256, notebookUrl: withBase(m.notebook.url_path),
    timeLimitMinutes: m.time_limit_minutes, questionIds: m.notebook.question_ids,
    questions: qs.map((q) => ({ question_id: q.question_id, runtime: { type: q.runtime.type, max_execution_ms: q.runtime.max_execution_ms }, grading: q.grading, starter_code: q.starter_code })),
    info: qs.map((q) => ({ question_id: q.question_id, title: q.title, url: pageUrl('exams', m.pack_id, q.question_id),
      answer: q.answer.available ? q.answer.code : null, explanation: q.explanation.available,
      video: q.video.youtube_id ? `https://www.youtube.com/watch?v=${q.video.youtube_id}${q.video.start_seconds ? `&t=${q.video.start_seconds}s` : ''}` : null })),
    grading: m.grading ? { url: withBase(m.grading.url_path), sha256: m.grading.sha256, grading_version: m.grading.grading_version, engine_version: m.grading.engine_version } : null,
    datasets: m.datasets.map((d) => ({ name: d.url_path.split('/').pop()!, url: withBase(d.url_path), sha256: d.sha256, size: d.size_bytes })),
    urls: { practice: pageUrl('exams', m.pack_id, 'practice'), exam: pageUrl('exams', m.pack_id, 'exam'), result: pageUrl('exams', m.pack_id, 'result'), pack: pageUrl('exams', m.pack_id) },
  };
}
export type PageConfig = ReturnType<typeof pageConfig>;
/** <script type="application/json"> 안에 안전하게 넣기 */
export const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
