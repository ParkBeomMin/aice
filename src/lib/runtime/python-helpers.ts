// Worker 안 Pyodide 에 한 번 정의하는 Python 헬퍼. 사용자 코드는 _acf_ns 네임스페이스(셀 간 공유)에서 실행된다.
export const PY_HELPERS = String.raw`
import os, sys, io, json, base64, traceback, warnings
os.environ.setdefault("MPLBACKEND", "Agg")
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
`;
