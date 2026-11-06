// 채점 전용 Pyodide 에 한 번 정의하는 Python 헬퍼 (T-06).
// 채점 프로필은 데이터(JSON)일 뿐이며, 여기 정의된 probe, 비교 연산(allowlist)만 실행한다. 프로필 안의 문자열을 Python 코드로 실행하지 않는다.
export const GRADING_PY = String.raw`
import sys, io, json, math, re, random, traceback, warnings, contextlib
from pyodide.code import eval_code_async, find_imports

_g_ns = {"__name__": "__main__"}
_g_last = {"result": None, "stdout": "", "figures": [], "changed": []}
_g_pre = {}
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_STDOUT = 20000

class _ProbeError(Exception):
    pass

def _g_imports(code):
    try:
        return list(find_imports(code))
    except Exception:
        return []

def _g_seed():
    # 채점 재현성: 전역 난수 고정 (random_state 를 지정하지 않은 코드도 매번 같은 결과)
    random.seed(0)
    try:
        import numpy as np
        np.random.seed(0)
    except Exception:
        pass
    return "ok"

def _var(name):
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise _ProbeError("허용되지 않는 변수 이름")
    if name not in _g_ns:
        raise _ProbeError(f"변수 {name} 가 없습니다")
    return _g_ns[name]

def _is_df(v):
    return type(v).__name__ == "DataFrame" and (type(v).__module__ or "").startswith("pandas")

def _is_series(v):
    return type(v).__name__ == "Series" and (type(v).__module__ or "").startswith("pandas")

def _df(name):
    v = _var(name)
    if not _is_df(v):
        raise _ProbeError(f"{name} 가 DataFrame 이 아닙니다 ({type(v).__name__})")
    return v

def _col(name, column):
    df = _df(name)
    if not isinstance(column, str) or column not in df.columns:
        raise _ProbeError(f"{name} 에 {column} 컬럼이 없습니다")
    return df[column]

def _num(x):
    try:
        f = float(x)
    except Exception:
        return None
    return None if math.isnan(f) else f

def _norm(v):
    """JSON 으로 옮길 수 있는 값으로 정규화"""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return None if math.isnan(v) else v
    t = type(v).__name__
    mod = type(v).__module__ or ""
    if mod.startswith("numpy"):
        if hasattr(v, "tolist"):
            return _norm(v.tolist())
    if _is_series(v):
        return {"__series__": {"index": [str(i) for i in v.index], "values": [_norm(x) for x in v.tolist()]}}
    if _is_df(v):
        return {"__dataframe__": {"shape": [int(v.shape[0]), int(v.shape[1])], "columns": [str(c) for c in v.columns]}}
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _norm(x) for k, x in v.items()}
    n = _num(v)
    if n is not None:
        return n
    return repr(v)[:200]

def _output_text():
    t = _g_last["stdout"]
    r = _g_last["result"]
    if r is not None:
        try:
            t += "\n" + str(r)
        except Exception:
            pass
    return t

# (엔진 1.1.0) 채점기가 학생 상태에서 기대 결과를 독립 계산하는 evaluator — 클래스, 하이퍼파라미터는 allowlist
_MODEL_CLASSES = {"LogisticRegression": ("sklearn.linear_model", "LogisticRegression"),
                  "RandomForestClassifier": ("sklearn.ensemble", "RandomForestClassifier")}
_PARAM_KEYS = {"max_iter", "random_state", "n_estimators", "n_jobs", "C", "max_depth"}

def _model_cls(name):
    import importlib
    if name not in _MODEL_CLASSES:
        raise _ProbeError("허용되지 않는 모델 클래스")
    m, c = _MODEL_CLASSES[name]
    return getattr(importlib.import_module(m), c)

def _params(d):
    d = d or {}
    if not isinstance(d, dict) or not set(d) <= _PARAM_KEYS or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in d.values()):
        raise _ProbeError("허용되지 않는 하이퍼파라미터")
    return dict(d)

def _predict(model, X, threshold=None):
    if threshold is None:
        return model.predict(X)
    t = float(threshold)
    if not 0.0 < t < 1.0:
        raise _ProbeError("임계값 범위 오류")
    import numpy as np
    return (np.asarray(model.predict_proba(X))[:, 1] >= t).astype(int)

_STATS = {"mean", "median", "sum", "min", "max", "std", "nunique", "count"}
_METRICS = {"accuracy", "f1", "precision", "recall", "r2", "mae", "mse"}

def _probe(p):
    k = p.get("kind")
    if k == "var_type":
        name = p.get("var")
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise _ProbeError("허용되지 않는 변수 이름")
        if name not in _g_ns:
            return "missing"
        v = _g_ns[name]
        if _is_df(v): return "DataFrame"
        if _is_series(v): return "Series"
        if isinstance(v, bool): return "bool"
        if isinstance(v, int): return "int"
        if isinstance(v, float): return "float"
        if type(v).__module__.startswith("numpy") and type(v).__name__ == "ndarray": return "ndarray"
        if hasattr(v, "fit") and (hasattr(v, "predict") or hasattr(v, "transform")): return "estimator"
        return type(v).__name__
    if k == "df_shape":
        v = _var(p["var"])
        if not hasattr(v, "shape"):
            raise _ProbeError(f"{p['var']} 에 shape 가 없습니다")
        return [int(x) for x in v.shape]
    if k == "length":
        v = _var(p["var"])
        try:
            return int(len(v))
        except Exception:
            raise _ProbeError(f"{p['var']} 의 길이를 알 수 없습니다")
    if k == "columns":
        return [str(c) for c in _df(p["var"]).columns]
    if k == "null_count":
        if p.get("column") is not None:
            return int(_col(p["var"], p["column"]).isna().sum())
        return int(_df(p["var"]).isna().sum().sum())
    if k == "column_stat":
        stat = p.get("stat")
        if stat not in _STATS:
            raise _ProbeError("허용되지 않는 통계")
        s = _col(p["var"], p["column"])
        return _norm(getattr(s, stat)())
    if k == "non_numeric_columns":
        df = _df(p["var"])
        excl = set(p.get("exclude_columns") or [])
        out = []
        for c in df.columns:
            if str(c) in excl:
                continue
            kind = df[c].dtype.kind
            if kind not in "biuf":
                out.append(str(c))
        return out
    if k == "cell_result":
        return _norm(_g_last["result"])
    if k == "output_numbers":
        # print 출력 + 마지막 표현식 값 (출력 방식이 달라도 같은 결과면 인정)
        return [float(x) for x in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", _output_text())][:500]
    if k == "output_text":
        return _output_text()[:5000]
    if k == "frames":
        # 이 셀이 만든 DataFrame 후보 (마지막 표현식 값 + 이 셀에서 새로 대입된 변수)
        col = p.get("column")
        cands = []
        res = _g_last["result"]
        if _is_df(res):
            cands.append(res)
        for n in _g_last["changed"]:
            v = _g_ns.get(n)
            if _is_df(v) and all(v is not c for c in cands):
                cands.append(v)
        out = []
        for f in cands[:10]:
            d = {"rows": int(f.shape[0]), "columns": sorted(str(c) for c in f.columns)}
            if col is not None:
                d["values"] = [_norm(x) for x in f[col].tolist()] if col in f.columns else None
            out.append(d)
        return out
    if k == "value":
        return _norm(_var(p["var"]))
    if k == "is_fitted":
        v = _var(p["var"])
        try:
            from sklearn.utils.validation import check_is_fitted
            check_is_fitted(v)
            return True
        except Exception:
            return False
    if k == "class_name":
        return type(_var(p["var"])).__name__
    if k == "attr_number":
        # 학습된 객체의 숫자 속성 (예: StandardScaler.n_samples_seen_). 이름은 allowlist
        attr = p.get("attr")
        if attr not in ("n_samples_seen_", "n_features_in_", "n_estimators", "max_iter"):
            raise _ProbeError("허용되지 않는 속성")
        v = getattr(_var(p["var"]), attr, None)
        if v is None:
            raise _ProbeError(f"{p['var']}.{attr} 가 없습니다")
        return _norm(v)
    if k == "metric":
        m = p.get("metric")
        if m not in _METRICS:
            raise _ProbeError("허용되지 않는 지표")
        model, X, y = _var(p["model"]), _var(p["X"]), _var(p["y"])
        from sklearn import metrics as M
        pred = _predict(model, X, p.get("threshold"))
        fn = {"accuracy": M.accuracy_score, "f1": M.f1_score, "precision": M.precision_score, "recall": M.recall_score,
              "r2": M.r2_score, "mae": M.mean_absolute_error, "mse": M.mean_squared_error}[m]
        return float(fn(y, pred))
    if k == "predictions":
        return _norm(_predict(_var(p["model"]), _var(p["X"]), p.get("threshold")))
    if k == "probabilities":
        import numpy as np
        return _norm(np.asarray(_var(p["model"]).predict_proba(_var(p["X"])))[:, 1])
    if k == "refit_predictions":
        # 지정 클래스, 하이퍼파라미터로 학생의 학습 데이터에서 새 모델을 학습해 평가 데이터 예측 (학생 객체는 변경하지 않음)
        cls = _model_cls(p.get("model_class"))
        Xtr, ytr, Xev = _var(p["X_train"]), _var(p["y_train"]), _var(p["X_eval"])
        model = cls(**_params(p.get("params"))).fit(Xtr.copy() if hasattr(Xtr, "copy") else Xtr, ytr)
        return _norm(_predict(model, Xev, p.get("threshold")))
    if k == "model_params":
        keys = p.get("keys") or []
        if not set(keys) <= _PARAM_KEYS:
            raise _ProbeError("허용되지 않는 파라미터 이름")
        gp = _var(p["var"]).get_params()
        return {key: _norm(gp.get(key)) for key in keys}
    if k == "best_model":
        # 후보 모델들의 F1(또는 지정 지표)을 학생 상태로 다시 계산해 가장 높은 이름 (동률이면 tie)
        m = p.get("metric", "f1")
        if m not in ("f1", "accuracy"):
            raise _ProbeError("허용되지 않는 지표")
        from sklearn import metrics as M
        fn = M.f1_score if m == "f1" else M.accuracy_score
        y = _var(p["y"])
        scores = []
        for cnd in (p.get("candidates") or [])[:5]:
            scores.append((cnd["name"], float(fn(y, _var(cnd["model"]).predict(_var(cnd["X"]))))))
        if not scores:
            raise _ProbeError("후보 없음")
        best = max(s for _, s in scores)
        winners = [n for n, s in scores if abs(s - best) <= 1e-12]
        tie = p.get("tie")
        return tie if tie in winners else winners[0]
    if k == "series_index":
        v = _var(p["var"])
        if not hasattr(v, "index"):
            raise _ProbeError(f"{p['var']} 에 index 가 없습니다")
        return [str(i) for i in v.index]
    if k == "imputation_from_source":
        # 실행 전 source(df_raw) 의 결측 위치, 관측 통계를 기록해 두고, var(df_clean) 에서 결측 위치는 통계값, 나머지는 원래 값인지
        key = ("src", p["source"], p["column"])
        pre = _g_pre.get(key)
        if pre is None:
            raise _ProbeError("실행 전 원본 상태를 기록하지 못했습니다")
        s = _col(p["var"], p["column"])
        target = pre["stat"]
        if list(map(str, s.index)) != pre["index"]:
            return {"filled_dev": float("inf"), "kept_dev": float("inf"), "same_rows": False}
        filled = [_num(s.iloc[i]) for i in pre["missing_pos"]]
        kept = [(_num(s.iloc[i]), pre["values"][i]) for i in range(len(pre["values"])) if i not in pre["missing_set"]]
        fd = float("inf") if any(v is None for v in filled) else (max((abs(v - target) for v in filled), default=0.0))
        kd = float("inf") if any(a is None for a, _ in kept) else (max((abs(a - b) for a, b in kept), default=0.0))
        return {"filled_dev": fd, "kept_dev": kd, "same_rows": True}
    if k == "frame_unchanged":
        # (엔진 1.2.0) 셀 실행 전 source 스냅샷과 var 비교: 행(인덱스), 컬럼 순서, dtype, 값 (except_columns 제외). 숫자 abs 1e-9, NaN==NaN
        snap = _g_pre.get(("frame", p["source"]))
        if snap is None:
            raise _ProbeError("실행 전 원본 상태를 기록하지 못했습니다")
        df = _df(p["var"])
        excl = set(p.get("except_columns") or [])
        want_cols = [c for c in snap["columns"]]
        got_cols = [str(c) for c in df.columns]
        out = {"same_rows": [str(i) for i in df.index] == snap["index"], "same_columns": got_cols == want_cols, "changed_columns": []}
        if not out["same_rows"]:
            return out
        for c in want_cols:
            if c in excl or c not in got_cols:
                continue
            col = df[c]
            sv = snap["values"][c]
            if col.dtype.kind != snap["kinds"][c]:
                out["changed_columns"].append(c); continue
            cur = col.tolist()
            for a, b in zip(cur, sv):
                fa, fb = _num(a), _num(b)
                if isinstance(b, float) or isinstance(a, float):
                    if fa is None and fb is None:
                        continue
                    if fa is None or fb is None or abs(fa - fb) > 1e-9:
                        out["changed_columns"].append(c); break
                elif a != b:
                    out["changed_columns"].append(c); break
        return out
    if k == "imputed_values":
        # 셀 실행 전 결측 위치에 채워진 값과 실행 전 통계(stat)의 최대 차이
        key = (p["var"], p["column"])
        pre = _g_pre.get(key)
        if pre is None:
            raise _ProbeError("실행 전 상태를 기록하지 못했습니다")
        stat = p.get("stat")
        if stat not in ("mean", "median"):
            raise _ProbeError("허용되지 않는 통계")
        s = _col(p["var"], p["column"])
        mask, target = pre["mask"], pre[stat]
        idx = [i for i in mask if i in s.index]
        if not idx:
            raise _ProbeError("결측이었던 행이 남아 있지 않습니다 (행 삭제 등)")
        vals = [_num(s.loc[i]) for i in idx]
        if any(v is None for v in vals):
            return float("inf")
        return max(abs(v - target) for v in vals)
    if k == "figure_count":
        return len(_g_last["figures"])
    if k == "bar_count":
        figs = _g_last["figures"]
        return figs[0]["bars"] if figs else 0
    raise _ProbeError(f"허용되지 않는 probe: {k}")

def _close(a, b, abs_tol, rel_tol):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    fa, fb = _num(a), _num(b)
    if fa is None or fb is None:
        return False
    return abs(fa - fb) <= max(abs_tol, rel_tol * abs(fb))

def _approx(a, b, abs_tol, rel_tol):
    if isinstance(b, dict) and "__series__" in b:
        if not (isinstance(a, dict) and "__series__" in a):
            return False
        sa, sb = a["__series__"], b["__series__"]
        da = dict(zip(sa["index"], sa["values"]))
        db = dict(zip(sb["index"], sb["values"]))
        return set(da) == set(db) and all(_close(da[k], db[k], abs_tol, rel_tol) for k in db)
    if isinstance(b, list):
        return isinstance(a, list) and len(a) == len(b) and all(_approx(x, y, abs_tol, rel_tol) for x, y in zip(a, b))
    if isinstance(b, dict):
        return isinstance(a, dict) and set(a) == set(b) and all(_approx(a[k], b[k], abs_tol, rel_tol) for k in b)
    if isinstance(b, str) or b is None:
        return a == b
    return _close(a, b, abs_tol, rel_tol)

def _flat_numbers(x):
    if isinstance(x, dict) and "__series__" in x:
        return [v for v in x["__series__"]["values"] if _num(v) is not None]
    if isinstance(x, list):
        return [v for v in x if _num(v) is not None]
    return [x]

def _expect(actual, e, expected):
    op = e.get("op")
    at, rt = float(e.get("abs_tol", 1e-9)), float(e.get("rel_tol", 1e-9))
    if op == "eq":
        return actual == expected
    if op == "approx":
        return _approx(actual, expected, at, rt)
    if op == "in_range":
        a = _num(actual)
        return a is not None and (e.get("min") is None or a >= e["min"]) and (e.get("max") is None or a <= e["max"])
    if op == "contains_all":
        return isinstance(actual, list) and all(x in actual for x in expected)
    if op == "excludes_all":
        return isinstance(actual, list) and not any(x in actual for x in expected)
    if op == "set_eq":
        return isinstance(actual, list) and set(map(str, actual)) == set(map(str, expected))
    if op == "approx_contains":
        exp = _flat_numbers(expected)
        return isinstance(actual, list) and len(exp) > 0 and all(any(_close(a, x, at, rt) for a in actual) for x in exp)
    if op == "any_approx":
        return isinstance(actual, list) and any(_approx(a, expected, at, rt) for a in actual)
    if op == "text_contains_all":
        return isinstance(actual, str) and all(str(x) in actual for x in (expected or []))
    if op == "truthy":
        return bool(actual) is True
    raise _ProbeError(f"허용되지 않는 비교: {op}")

def _safe(v):
    """JSON 표준 밖의 값(inf, nan) 제거 — JS JSON.parse 가 실패하지 않도록"""
    if isinstance(v, float) and not math.isfinite(v):
        return "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")
    if isinstance(v, list):
        return [_safe(x) for x in v]
    if isinstance(v, dict):
        return {k: _safe(x) for k, x in v.items()}
    return v

def _g_check(profile_json):
    prof = json.loads(profile_json)
    out = []
    for c in prof["checks"]:
        r = {"id": c["id"], "passed": False}
        try:
            actual = _probe(c["probe"])
            e = c["expect"]
            if "ref_probe" in e:
                expected = _probe(e["ref_probe"])
            else:
                expected = e.get("value")
            r["passed"] = bool(_expect(actual, e, expected))
            a = _safe(actual)
            r["actual"] = a if len(json.dumps(a, default=str)) < 2000 else "(값이 너무 큼)"
        except _ProbeError as ex:
            r["detail"] = str(ex)[:300]
        except Exception as ex:
            r["detail"] = f"검사 중 오류: {type(ex).__name__}: {str(ex)[:200]}"
        out.append(r)
    return json.dumps(_safe(out), default=str, allow_nan=False)

def _g_probe_value(probe_json):
    """기대값 계산 도구 전용: probe 값(정규화)을 JSON 으로"""
    try:
        return json.dumps({"ok": True, "value": _safe(_probe(json.loads(probe_json)))}, default=str, allow_nan=False)
    except Exception as ex:
        return json.dumps({"ok": False, "error": f"{type(ex).__name__}: {ex}"})

def _g_pre_capture(profile_json):
    prof = json.loads(profile_json)
    _g_pre.clear()
    for c in prof["checks"]:
        p = c["probe"]
        if p.get("kind") == "imputation_from_source":
            try:
                src = _col(p["source"], p["column"])
                stat = p.get("stat")
                if stat not in ("mean", "median"):
                    continue
                vals = [_num(x) for x in src.tolist()]
                miss = [i for i, x in enumerate(vals) if x is None]
                _g_pre[("src", p["source"], p["column"])] = {"index": list(map(str, src.index)), "values": vals, "missing_pos": miss,
                                                            "missing_set": set(miss), "stat": float(getattr(src, stat)())}
            except Exception:
                pass
        if p.get("kind") == "frame_unchanged":
            try:
                src = _df(p["source"])
                _g_pre[("frame", p["source"])] = {"index": [str(i) for i in src.index], "columns": [str(c) for c in src.columns],
                    "kinds": {str(c): src[c].dtype.kind for c in src.columns}, "values": {str(c): src[c].tolist() for c in src.columns}}
            except Exception:
                pass
        if p.get("kind") == "imputed_values":
            try:
                s = _col(p["var"], p["column"])
                _g_pre[(p["var"], p["column"])] = {"mask": list(s[s.isna()].index), "mean": float(s.mean()), "median": float(s.median())}
            except Exception:
                pass
    return "ok"

def _g_figs():
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import matplotlib.pyplot as plt
    out = []
    for num in plt.get_fignums()[:5]:
        fig = plt.figure(num)
        bars = 0
        for ax in fig.axes:
            bars += sum(1 for p in ax.patches if type(p).__name__ == "Rectangle")
        out.append({"bars": bars})
    plt.close("all")
    return out

async def _g_run(code):
    buf = io.StringIO()
    ok, err = True, None
    _g_last["result"] = None
    before = {k: id(v) for k, v in _g_ns.items()}
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                _g_last["result"] = await eval_code_async(code, globals=_g_ns)
        except BaseException as e:
            ok = False
            err = {"ename": type(e).__name__, "evalue": str(e)[:500]}
    _g_last["stdout"] = buf.getvalue()[:MAX_STDOUT]
    _g_last["changed"] = [k for k, v in _g_ns.items() if not k.startswith("_") and before.get(k) != id(v)]
    try:
        _g_last["figures"] = _g_figs()
    except Exception:
        _g_last["figures"] = []
    return json.dumps({"ok": ok, "error": err, "stdout_chars": len(_g_last["stdout"])}, allow_nan=False)
`;
