// 노트북 마크다운 셀용 최소 렌더러. 모든 텍스트를 먼저 HTML 이스케이프하므로 원본의 HTML/스크립트는 실행되지 않는다.
// 지원: #~###### 제목, 문단, - / * 목록, 1. 목록 (들여쓰기로 중첩), > 인용, ``` 코드 블록, `인라인 코드`, **굵게**, | 표 |, --- 구분선
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
  // 목록 스택: 들여쓰기가 더 깊은 항목은 바로 위 항목의 하위 목록이 된다 (객관식 보기 등)
  type List = { indent: number; tag: 'ul' | 'ol'; items: { text: string; sub: string[] }[] };
  const stack: List[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1].indent > indent) {
      const l = stack.pop()!;
      const html = `<${l.tag}>${l.items.map((it) => `<li>${inline(it.text)}${it.sub.join('')}</li>`).join('')}</${l.tag}>`;
      const parent = stack[stack.length - 1];
      if (parent && parent.items.length) parent.items[parent.items.length - 1].sub.push(html);
      else out.push(html);
    }
  };
  const flushList = () => closeTo(-1);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara(); flushList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      const body: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) body.push(cells(lines[i]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const ul = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const ol = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const m = (ul ?? ol)!;
      const tag = ul ? 'ul' : 'ol';
      const indent = m[1].replace(/\t/g, '    ').length;
      closeTo(indent);
      let top = stack[stack.length - 1];
      if (top && top.indent === indent && top.tag !== tag) { closeTo(indent - 1); top = stack[stack.length - 1]; }
      if (!top || top.indent < indent) { stack.push({ indent, tag, items: [] }); top = stack[stack.length - 1]; }
      top.items.push({ text: m[2], sub: [] });
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
