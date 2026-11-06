// T-06 채점 계약 (TS 측). JSON Schema: content/schemas/public-grading-profile.schema.json, attempt-result.schema.json
export const GRADING_ENGINE_VERSION = '1.2.0'; // 1.2.0: frame_unchanged (원본, 다른 컬럼 보존).  1.1.0: 학생 상태 기반 독립 재계산 evaluator (refit_predictions, predictions, probabilities, best_model, model_params, series_index, imputation_from_source)
export const RESULT_SCHEMA_VERSION = '1.0.0';

export type ProbeKind = 'var_type' | 'df_shape' | 'length' | 'columns' | 'null_count' | 'column_stat' | 'non_numeric_columns'
  | 'cell_result' | 'output_numbers' | 'output_text' | 'frames' | 'value' | 'is_fitted' | 'class_name' | 'attr_number' | 'metric' | 'imputed_values'
  | 'figure_count' | 'bar_count' | 'predictions' | 'probabilities' | 'refit_predictions' | 'model_params' | 'best_model' | 'series_index' | 'imputation_from_source' | 'frame_unchanged';
export interface Probe { kind: ProbeKind; [k: string]: unknown }
export type ExpectOp = 'eq' | 'approx' | 'in_range' | 'contains_all' | 'excludes_all' | 'set_eq' | 'approx_contains' | 'any_approx' | 'text_contains_all' | 'truthy';
export interface Expect { op: ExpectOp; value?: unknown; ref_probe?: Probe; abs_tol?: number; rel_tol?: number; min?: number; max?: number }
export interface Check { id: string; label: string; probe: Probe; expect: Expect; weight: number; feedback: string }
export interface QuestionProfile {
  question_id: string; profile: string; profile_revision: number; review_status: 'tested' | 'approved';
  depends_on: string[]; points: number; checks: Check[];
}
export interface GradingBundle {
  schema_version: '1.3.0'; pack_id: string; engine_version: string; grading_version: string;
  questions: Record<string, QuestionProfile>;
}

/** 채점 대상 문항 메타 (공개 문항 JSON 에서) */
export interface QuestionMeta {
  question_id: string; runtime: { type: 'pyodide' | 'external'; max_execution_ms: number };
  grading: { type: 'result_assertions' | 'self_check' | 'none'; profile: string | null };
  /** 공개 starter_code. 제출 코드가 이것과 같으면(공백 무시) 미작성으로 0점 */
  starter_code?: string;
}

export type QuestionStatus = 'correct' | 'partial' | 'incorrect' | 'execution_error' | 'blocked' | 'ungraded' | 'self_check';
/** label 은 1.1.0 부터. 이전에 저장된 결과에는 없을 수 있음 → UI 는 id 로 대체 */
export interface CheckResult { id: string; passed: boolean; label?: string; feedback?: string; detail?: string; actual?: unknown }
export interface QuestionResult {
  question_id: string; status: QuestionStatus; awarded_points: number; available_points: number;
  feedback: string[]; error_summary: string | null; error_kind: 'exception' | 'timeout' | null;
  checks: CheckResult[]; duration_ms: number;
}
export interface GradingTotals {
  awarded_points: number; available_points: number; gradable_count: number; correct_count: number;
  partial_count: number; ungraded_count: number; self_check_count: number; percent: number | null;
}
export interface AttemptResult {
  schema_version: typeof RESULT_SCHEMA_VERSION; attempt_id: string; pack_id: string; mode: 'practice' | 'exam';
  notebook_fingerprint: string; snapshot_sha256: string; grading_version: string; engine_version: string;
  started_at: string; submitted_at: string; completed_at: string; grading_ms: number;
  submit_reason: 'manual' | 'expired' | 'practice';
  questions: QuestionResult[]; totals: GradingTotals; disclaimer: string;
}
export const DISCLAIMER = '이 점수는 자체 연습용 자동 채점 결과이며 공식 AICE 시험 점수나 합격 여부와 무관합니다. 채점할 수 없는 문항은 점수에서 제외됩니다.';
