// 노트북 마크다운 셀용 최소 렌더러. 모든 텍스트를 먼저 HTML 이스케이프하므로 원본의 HTML/스크립트는 실행되지 않는다.
// 지원: #~###### 제목, 문단, - / * 목록, 1. 목록, > 인용, ``` 코드 블록, `인라인 코드`, **굵게**
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  const parts = escapeHtml(s).split(/(`[^`]+`)/g);
  return parts
    .map((p) => (p.startsWith('`') && p.endsWith('`') && p.length > 1 ? `<code>${p.slice(1, -1)}</code>` : p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')))
    .join('');
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara(); flushList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) { flushPara(); flushList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('\n');
}
