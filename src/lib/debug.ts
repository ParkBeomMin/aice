// 검증용 훅(window.__acf* 전역, ?acf_* URL 파라미터)은 preview 빌드에서만 켠다. production 빌드 HTML 에는 data-acf-debug 가 없다.
export const DEBUG = typeof document !== 'undefined' && document.documentElement.dataset.acfDebug === '1';
export function expose(name: string, value: unknown) { if (DEBUG) (window as unknown as Record<string, unknown>)[name] = value; }
