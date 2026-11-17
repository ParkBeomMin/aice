// Jupyter 처럼 Tab 자동 완성, Shift+Tab 함수 설명 (시그니처와 docstring). 커널(Pyodide) 의 현재 변수 상태를 jedi 로 조회한다.
import { autocompletion, startCompletion, acceptCompletion, completionStatus, closeCompletion, type CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete';
import { indentMore, indentLess } from '@codemirror/commands';
import { localCompletionSource, globalCompletion } from '@codemirror/lang-python';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { StateField, StateEffect, Prec, type Extension, type EditorState } from '@codemirror/state';
import type { AssistResult } from '../runtime/worker-protocol.ts';

export type AssistFn = (mode: 'complete' | 'inspect', code: string, line: number, col: number) => Promise<{ status: 'ok'; result: AssistResult } | { status: string; error?: string }>;

const TYPE_MAP: Record<string, string> = { module: 'namespace', class: 'class', instance: 'variable', function: 'function', param: 'variable', keyword: 'keyword', property: 'property', statement: 'variable', path: 'text' };

function pos(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { head, line: line.number, col: head - line.from, before: line.text.slice(0, head - line.from) };
}

export function editorAssist(call: AssistFn, notify: (msg: string) => void): Extension {
  // 입력 중 자동 팝업은 기존처럼 셀 안 이름과 내장 이름. Tab(명시적 요청)일 때만 커널에 묻는다
  const local = [localCompletionSource, globalCompletion];
  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!ctx.explicit) {
      for (const s of local) { const r = await s(ctx); if (r && r.options.length) return r; }
      return null;
    }
    const { line, col } = pos(ctx.state);
    const slow = setTimeout(() => notify('자동 완성에 필요한 패키지를 처음 불러오는 중이에요. 잠시만 기다려 주세요'), 1500);
    const res = await call('complete', ctx.state.doc.toString(), line, col).finally(() => clearTimeout(slow));
    if (ctx.aborted) return null;
    if (res.status !== 'ok') {
      if (res.status === 'not_ready') notify('Python 준비 중이에요. 준비가 끝나면 Tab 자동 완성을 쓸 수 있어요');
      else if (res.status === 'busy') notify('셀 실행 중에는 자동 완성을 쓸 수 없어요');
      for (const s of local) { const r = await s(ctx); if (r && r.options.length) return r; }
      return null;
    }
    const r = (res as { result: AssistResult }).result as { items: { label: string; type: string }[]; prefix: number };
    if (!r.items || !r.items.length) return null;
    const options: Completion[] = r.items.map((it, i) => ({ label: it.label, type: TYPE_MAP[it.type] ?? 'variable', detail: it.type === 'param' ? '매개변수' : undefined, boost: -i / 1000 }));
    return { from: ctx.pos - r.prefix, options, validFor: /^[\w]*$/ };
  };

  const setDoc = StateEffect.define<Tooltip | null>();
  const docField = StateField.define<Tooltip | null>({
    create: () => null,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setDoc)) return e.value;
      return tr.docChanged || tr.selection ? null : v;
    },
    provide: (f) => showTooltip.from(f),
  });

  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const showDoc = (view: EditorView) => {
    const { head, line, col } = pos(view.state);
    call('inspect', view.state.doc.toString(), line, col).then((res) => {
      if (view.state.selection.main.head !== head) return; // 그 사이 커서가 움직였으면 무시
      let html: string;
      if (res.status !== 'ok') html = res.status === 'not_ready' ? 'Python 준비 중이에요. 준비가 끝나면 다시 눌러 주세요' : res.status === 'busy' ? '셀 실행 중이에요. 끝난 뒤 다시 눌러 주세요' : '설명을 가져오지 못했어요';
      else {
        const r = (res as { result: AssistResult }).result as Extract<AssistResult, { found: boolean }>;
        if (!('found' in r) || !r.found) html = '설명을 찾지 못했어요. 함수 이름 위나 괄호 안에서 Shift+Tab 을 눌러 보세요';
        else {
          const sig = r.signatures.length ? `<pre class="nb-doc-sig">${esc(r.signatures.join('\n'))}</pre>` : '';
          const tn = r.type_name ? `<div class="nb-doc-type">${esc(r.type_name)}</div>` : '';
          const doc = r.doc ? `<pre class="nb-doc-body">${esc(r.doc)}${r.truncated ? '\n…' : ''}</pre>` : '';
          html = `<div class="nb-doc-title">${esc(r.title)}</div>${tn}${sig}${doc}`;
        }
      }
      view.dispatch({ effects: setDoc.of({ pos: head, above: false, strictSide: true, arrow: false, create: () => {
        const dom = document.createElement('div'); dom.className = 'nb-doc'; dom.innerHTML = html; return { dom };
      } }) });
    });
    return true;
  };

  const tabKeys = Prec.highest(keymap.of([
    { key: 'Tab', run: (view) => {
      if (completionStatus(view.state) === 'active') return acceptCompletion(view);
      const { before } = pos(view.state);
      if (view.state.selection.main.empty && /[\w.]$|\[\s*['"][^'"]*$/.test(before)) return startCompletion(view);
      return indentMore(view);
    } },
    { key: 'Shift-Tab', run: (view) => {
      const { before } = pos(view.state);
      if (view.state.selection.main.empty && /[\w(,=\s]$/.test(before) && before.trim()) { closeCompletion(view); return showDoc(view); }
      return indentLess(view);
    } },
    { key: 'Escape', run: (view) => { if (view.state.field(docField)) { view.dispatch({ effects: setDoc.of(null) }); return true; } return false; } },
  ]));

  return [tabKeys, docField, autocompletion({ override: [source], activateOnTyping: true, defaultKeymap: true, icons: true }),
    EditorView.baseTheme({
      '.nb-doc': { maxWidth: 'min(720px, 90vw)', maxHeight: '320px', overflow: 'auto', padding: '8px 10px', fontSize: '12.5px', lineHeight: '1.45', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', boxShadow: '0 4px 14px rgba(15,23,42,.15)' },
      '.nb-doc-title': { fontWeight: '700', marginBottom: '4px' },
      '.nb-doc-type': { color: '#475569', marginBottom: '4px' },
      '.nb-doc-sig': { margin: '0 0 6px', padding: '6px 8px', background: '#f1f5f9', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px' },
      '.nb-doc-body': { margin: '0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#1e293b' },
    })];
}
