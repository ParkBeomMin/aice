// Worker 안 Pyodide 에 한 번 정의하는 Python 헬퍼. 사용자 코드는 _acf_ns 네임스페이스(셀 간 공유)에서 실행된다.
export const PY_HELPERS = String.raw`
import os, sys, io, json, base64, traceback, warnings
os.environ.setdefault("MPLBACKEND", "Agg")
# plt.show() 는 그림을 셀 출력으로 보여 주므로 Agg 백엔드의 "non-interactive" 경고는 숨긴다 (학습자 혼란 방지)
warnings.filterwarnings("ignore", message=".*non-interactive, and thus cannot be shown.*")
from pyodide.code import eval_code_async, find_imports

_acf_ns = {"__name__": "__main__"}
MAX_ROWS = 50
MAX_COLS = 30
MAX_TEXT = 20000

def _acf_imports(code):
    try:
        return list(find_imports(code))
    except Exception:
        return []

def _acf_table(obj):
    import pandas as pd
    df = obj.to_frame() if isinstance(obj, pd.Series) else obj
    shape = [int(df.shape[0]), int(df.shape[1])]
    sub = df.iloc[:MAX_ROWS, :MAX_COLS]
    rows = [[str(v) for v in r] for r in sub.astype(object).itertuples(index=False, name=None)]
    return {"kind": "table", "columns": [str(c) for c in sub.columns], "index": [str(i) for i in sub.index],
            "rows": rows, "shape": shape, "truncated": shape[0] > MAX_ROWS or shape[1] > MAX_COLS}

def _acf_result(obj):
    if obj is None:
        return None
    mod = type(obj).__module__ or ""
    if mod.startswith("pandas") and type(obj).__name__ in ("DataFrame", "Series"):
        try:
            return _acf_table(obj)
        except Exception:
            pass
    text = repr(obj)
    return {"kind": "result", "text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT}

def _acf_figures():
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import matplotlib.pyplot as plt
    out = []
    for num in plt.get_fignums()[:5]:
        fig = plt.figure(num)
        buf = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fig.savefig(buf, format="png", dpi=90, bbox_inches="tight")
        out.append({"kind": "image", "png": base64.b64encode(buf.getvalue()).decode("ascii")})
    plt.close("all")
    return out

async def _acf_run(code):
    outs = []
    ok = True
    try:
        res = await eval_code_async(code, globals=_acf_ns)
        r = _acf_result(res)
        if r is not None:
            outs.append(r)
    except BaseException as e:
        ok = False
        te = traceback.TracebackException.from_exception(e)
        # 래퍼(_acf_*), Pyodide 내부 프레임 제거 → 사용자 코드 프레임만
        te.stack = traceback.StackSummary.from_list(
            [f for f in te.stack if f.filename == "<exec>" and not f.name.startswith("_acf")])
        outs.append({"kind": "error", "ename": type(e).__name__, "evalue": str(e)[:2000],
                     "traceback": "".join(te.format())[-MAX_TEXT:]})
    try:
        outs.extend(_acf_figures())
    except Exception as e:
        outs.append({"kind": "error", "ename": type(e).__name__, "evalue": "그래프 변환 실패: " + str(e), "traceback": ""})
    return json.dumps({"ok": ok, "outputs": outs})

# --- 편집 도우미 (Tab 자동 완성, Shift+Tab 설명). Jupyter 처럼 현재 셀 코드와 커널 상태(_acf_ns)를 함께 본다
import re as _acf_re
_ACF_KEY_RE = _acf_re.compile(r"\[\s*(['\"])([^'\"]*)$")
_ACF_LEAD_RE = _acf_re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")

def _acf_expr_before(text, end):
    # text[:end] 끝에 있는 식의 시작 위치 (괄호 균형을 맞추며 뒤로). 예: "x = df.groupby('a')" -> "df.groupby('a')"
    depth, i = 0, end - 1
    while i >= 0:
        ch = text[i]
        if ch in ")]":
            depth += 1
        elif ch in "([":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and not (ch.isalnum() or ch in "_."):
            break
        i -= 1
    return text[i + 1:end]

def _acf_key_owner(expr):
    # 식 전체가 점 이름이면 그 객체, 아니면 맨 앞 이름 (df.groupby('a')['  -> df 의 컬럼)
    try:
        if _ACF_LEAD_RE.fullmatch(expr):
            return _acf_resolve(expr)
        m = _ACF_LEAD_RE.match(expr)
        if not m:
            return None
        lead = m.group(0)
        # 맨 앞 이름 뒤가 메서드 호출이면 그 앞까지만 (df.groupby -> df)
        parts = lead.split(".")
        for k in range(len(parts), 0, -1):
            try:
                obj = _acf_resolve(".".join(parts[:k]))
            except Exception:
                continue
            if obj is not None and hasattr(obj, "columns") and hasattr(obj, "iloc"):
                return obj
        return None
    except Exception:
        return None
_ACF_DOC_MAX = 6000

def _acf_resolve(expr):
    # 점으로 이어진 이름만 getattr 로 따라감 (호출이나 임의 코드 평가 없음)
    parts = expr.split(".")
    if parts[0] in _acf_ns:
        obj = _acf_ns[parts[0]]
    else:
        import builtins
        if not hasattr(builtins, parts[0]):
            return None
        obj = getattr(builtins, parts[0])
    for a in parts[1:]:
        obj = getattr(obj, a)
    return obj

def _acf_complete(code, line, col):
    out = {"items": [], "prefix": 0}
    cur = code.split("\n")[line - 1][:col]
    m = _ACF_KEY_RE.search(cur)
    if m:
        obj = _acf_key_owner(_acf_expr_before(cur, m.start()))
        keys = None
        if obj is not None and hasattr(obj, "columns") and hasattr(obj, "iloc"):
            keys = [str(c) for c in obj.columns]
        elif isinstance(obj, dict):
            keys = [k for k in obj.keys() if isinstance(k, str)]
        if keys is not None:
            pre = m.group(2)
            out["items"] = [{"label": k, "type": "property"} for k in keys if k.startswith(pre)][:300]
            out["prefix"] = len(pre)
            return json.dumps(out)
    import jedi
    cs = jedi.Interpreter(code, [_acf_ns]).complete(line, col)
    if not cs:
        return json.dumps(out)
    plen = len(cs[0].name_with_symbols) - len(cs[0].complete or "")
    typed = cs[0].name_with_symbols[:plen]
    items = []
    for c in cs:
        n = c.name_with_symbols
        if n.startswith("_") and not typed.startswith("_"):
            continue
        items.append({"label": n, "type": c.type})
        if len(items) >= 300:
            break
    out["items"] = items
    out["prefix"] = plen
    return json.dumps(out)

def _acf_sig_text(name, sig):
    t = sig.to_string()
    i = t.find("(")
    return (name + t[i:]) if i >= 0 else t

def _acf_describe(n, sig_from=None):
    title = n.name
    try:
        kind = n.type
    except Exception:
        kind = ""
    sigs = []
    try:
        sigs = [_acf_sig_text(n.name, s) for s in (sig_from or n.get_signatures())][:3]
    except Exception:
        pass
    try:
        doc = n.docstring(raw=True) or ""
    except Exception:
        doc = ""
    tname = ""
    if kind == "instance":
        try:
            obj = _acf_resolve(n.name) if n.name in _acf_ns else None
            if obj is not None:
                tname = type(obj).__module__.split(".")[0] + "." + type(obj).__name__
                if hasattr(obj, "shape"):
                    tname += f", shape {tuple(obj.shape)}"
        except Exception:
            pass
    trunc = len(doc) > _ACF_DOC_MAX
    return {"found": True, "title": title, "kind": kind, "type_name": tname, "signatures": sigs, "doc": doc[:_ACF_DOC_MAX], "truncated": trunc}

def _acf_inspect(code, line, col):
    import jedi
    sc = jedi.Interpreter(code, [_acf_ns])
    cur = code.split("\n")[line - 1][:col]
    on_name = bool(cur) and (cur[-1].isalnum() or cur[-1] == "_")
    if on_name:
        hs = sc.help(line, col)
        hs = [h for h in hs if h.type != "keyword"] or hs
        if hs:
            return json.dumps(_acf_describe(hs[0]))
    sigs = sc.get_signatures(line, col)
    if sigs:
        bl, bc = sigs[0].bracket_start
        hs = sc.help(bl, bc)
        if hs:
            d = _acf_describe(hs[0], sig_from=sigs)
            d["param_index"] = sigs[0].index
            return json.dumps(d)
        return json.dumps({"found": True, "title": sigs[0].name, "kind": "function", "type_name": "", "signatures": [s.to_string() for s in sigs[:3]], "doc": "", "truncated": False, "param_index": sigs[0].index})
    return json.dumps({"found": False})
`;
