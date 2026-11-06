// 모든 내부 링크/리소스는 이 헬퍼로 만든다. 루트(/) 기준 경로를 직접 쓰지 않는다.
const RAW = import.meta.env.BASE_URL;
export const BASE = RAW.endsWith('/') ? RAW : `${RAW}/`;

export function withBase(path = ''): string {
  const p = path.replace(/^\/+/, '');
  return `${BASE}${p}`;
}

export function pageUrl(...segments: string[]): string {
  const p = segments.map((s) => encodeURIComponent(s)).join('/');
  return withBase(p ? `${p}/` : '');
}
