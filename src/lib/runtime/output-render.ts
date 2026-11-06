// Worker 출력 → DOM. 모든 텍스트는 textContent, 표는 DOM 으로 직접 생성, 이미지는 base64 PNG 만. innerHTML 미사용.
import { isSafeBase64, type Output } from './worker-protocol.ts';

export function renderOutput(o: Output, doc: Document = document): HTMLElement {
  const el = doc.createElement('div');
  el.className = `nb-out nb-out-${o.kind}`;
  if (o.kind === 'stream') {
    const pre = doc.createElement('pre');
    pre.textContent = o.text + (o.truncated ? '\n… (출력이 너무 길어 잘랐습니다)' : '');
    if (o.name === 'stderr') el.classList.add('nb-stderr');
    el.append(pre);
  } else if (o.kind === 'result') {
    const pre = doc.createElement('pre');
    pre.textContent = o.text + (o.truncated ? '\n… (잘림)' : '');
    el.append(pre);
  } else if (o.kind === 'table') {
    const wrap = doc.createElement('div');
    wrap.className = 'nb-table-wrap';
    const table = doc.createElement('table');
    const thead = doc.createElement('thead');
    const hr = doc.createElement('tr');
    hr.append(doc.createElement('th'));
    for (const c of o.columns) { const th = doc.createElement('th'); th.textContent = c; hr.append(th); }
    thead.append(hr);
    const tbody = doc.createElement('tbody');
    o.rows.forEach((r, i) => {
      const tr = doc.createElement('tr');
      const th = doc.createElement('th'); th.textContent = o.index[i] ?? ''; tr.append(th);
      for (const v of r) { const td = doc.createElement('td'); td.textContent = v; tr.append(td); }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    const cap = doc.createElement('div');
    cap.className = 'nb-table-cap';
    cap.textContent = `${o.shape[0]} rows × ${o.shape[1]} columns${o.truncated ? ' (일부만 표시)' : ''}`;
    el.append(wrap, cap);
  } else if (o.kind === 'image') {
    if (isSafeBase64(o.png)) {
      const img = doc.createElement('img');
      img.alt = '그래프 출력';
      img.src = `data:image/png;base64,${o.png}`;
      el.append(img);
    }
  } else if (o.kind === 'error') {
    const pre = doc.createElement('pre');
    pre.textContent = `${o.ename}: ${o.evalue}${o.traceback ? `\n\n${o.traceback}` : ''}`;
    el.append(pre);
  }
  return el;
}
