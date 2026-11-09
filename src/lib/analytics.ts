// GA4 사용자 정의 이벤트 (T-07E). GA 태그가 없으면(미리보기, 로컬) 아무 일도 하지 않는다.
// 개인정보 원칙: 작성한 코드, 답안, 시도 ID 같은 식별 값은 보내지 않는다. 회차 ID, 문항 수, 점수 비율처럼 집계용 값만.
type Params = Record<string, string | number | boolean>;
export function track(event: string, params: Params = {}): void {
  try {
    const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
    if (typeof g === 'function') g('event', event, params);
  } catch { /* 통계 실패는 무시 */ }
}
