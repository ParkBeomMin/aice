// 채점 전용 Pyodide 에 한 번 정의하는 Python 헬퍼 (T-06).
// 채점 프로필은 데이터(JSON)일 뿐이며, 여기 정의된 probe, 비교 연산(allowlist)만 실행한다. 프로필 안의 문자열을 Python 코드로 실행하지 않는다.
export const GRADING_PY = String.raw`
import sys, io, json, math, re, random, traceback, warnings, contextlib
import os
# (엔진 1.5.0) 채점 Worker 에는 window 가 없으므로 matplotlib 은 항상 Agg (plt.show() 가 오류 없이 지나가도록, 연습 런타임과 동일)
os.environ.setdefault("MPLBACKEND", "Agg")
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
                  "RandomForestClassifier": ("sklearn.ensemble", "RandomForestClassifier"),
                  # (엔진 1.3.0) 회귀
                  "LinearRegression": ("sklearn.linear_model", "LinearRegression"),
                  "Ridge": ("sklearn.linear_model", "Ridge"),
                  "RandomForestRegressor": ("sklearn.ensemble", "RandomForestRegressor"),
                  "DecisionTreeRegressor": ("sklearn.tree", "DecisionTreeRegressor")}
_PARAM_KEYS = {"max_iter", "random_state", "n_estimators", "n_jobs", "C", "max_depth", "alpha", "min_samples_leaf"}
_PARAM_LIMITS = {"n_estimators": (1, 300), "max_depth": (1, 50), "n_jobs": (1, 1), "max_iter": (1, 10000), "min_samples_leaf": (1, 200)}

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
    for k, (lo, hi) in _PARAM_LIMITS.items():
        if k in d and not (lo <= d[k] <= hi):
            raise _ProbeError("하이퍼파라미터 범위 초과")
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
_METRICS = {"accuracy", "f1", "precision", "recall", "r2", "mae", "mse", "rmse"}
_LOWER_IS_BETTER = {"mae", "mse", "rmse"}

def _metric_value(m, y, pred):
    if m not in _METRICS:
        raise _ProbeError("허용되지 않는 지표")
    from sklearn import metrics as M
    import math
    if m == "rmse":
        return math.sqrt(float(M.mean_squared_error(y, pred)))
    fn = {"accuracy": M.accuracy_score, "f1": M.f1_score, "precision": M.precision_score, "recall": M.recall_score,
          "r2": M.r2_score, "mae": M.mean_absolute_error, "mse": M.mean_squared_error}[m]
    return float(fn(y, pred))

_CLS_METRICS = {"precision", "recall", "f1", "accuracy"}

def _cls_metric(m, y, pred):
    """(엔진 1.4.0) 이진 분류 지표, 양성 1, zero_division=0"""
    from sklearn import metrics as M
    if m == "accuracy":
        return float(M.accuracy_score(y, pred))
    fn = {"precision": M.precision_score, "recall": M.recall_score, "f1": M.f1_score}[m]
    return float(fn(y, pred, pos_label=1, zero_division=0))

def _same_data(a, b):
    """(엔진 1.4.0) 학생 값 a 가 기대 DataFrame/Series b 와 인덱스, (DataFrame 이면) 컬럼 순서, 컬럼별 dtype 종류, 값이 같은지. 숫자 abs 1e-9, NaN==NaN"""
    if a is None or type(a).__name__ != type(b).__name__:
        return False
    if [str(i) for i in a.index] != [str(i) for i in b.index]:
        return False
    if _is_df(b):
        if [str(c) for c in a.columns] != [str(c) for c in b.columns]:
            return False
        pairs = [(a[c], b[c]) for c in b.columns]
    else:
        pairs = [(a, b)]
    for sa, sb in pairs:
        if sa.dtype.kind != sb.dtype.kind:
            return False
        for x, z in zip(sa.tolist(), sb.tolist()):
            fx, fz = _num(x), _num(z)
            if isinstance(x, float) or isinstance(z, float):
                if fx is None and fz is None:
                    continue
                if fx is None or fz is None or abs(fx - fz) > 1e-9:
                    return False
            elif x != z:
                return False
    return True

def _select_candidate(p):
    """(엔진 1.3.0) 후보 모델들의 지표를 학생 상태로 다시 계산해 최선 후보 (오차 지표는 작을수록, 나머지는 클수록). 동률이면 tie"""
    m = p.get("metric", "f1")
    if m not in _METRICS:
        raise _ProbeError("허용되지 않는 지표")
    y = _var(p["y"])
    scores = []
    for cnd in (p.get("candidates") or [])[:5]:
        mdl, X = _var(cnd["model"]), _var(cnd["X"])
        scores.append((cnd["name"], _metric_value(m, y, mdl.predict(X)), mdl, X))
    if not scores:
        raise _ProbeError("후보 없음")
    lower = (p.get("goal") == "min") if p.get("goal") in ("min", "max") else (m in _LOWER_IS_BETTER)
    best = (min if lower else max)(s for _, s, _, _ in scores)
    winners = [c for c in scores if abs(c[1] - best) <= 1e-12]
    tie = p.get("tie")
    return next((c for c in winners if c[0] == tie), winners[0])

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
        return _metric_value(m, y, _predict(model, X, p.get("threshold")))
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
        # 후보 모델 지표를 학생 상태로 다시 계산해 최선 이름 (1.1.0: f1, accuracy / 1.3.0: 회귀 오차는 최소)
        return _select_candidate(p)[0]
    if k == "selected_predictions":
        # (엔진 1.3.0) best_model 과 같은 규칙으로 고른 후보의 예측
        _, _, mdl, X = _select_candidate(p)
        return _norm(mdl.predict(X))
    if k == "group_metric":
        # (엔진 1.3.0) 그룹별 지표: 예측(model, X 또는 candidates 선택)과 y 를 y 의 인덱스로 frame[column] 그룹에 맞춰 계산
        if p.get("candidates"):
            _, _, mdl, X = _select_candidate({**p, "metric": p.get("select_metric", "rmse")})
        else:
            mdl, X = _var(p["model"]), _var(p["X"])
        import pandas as pd
        y = _var(p["y"])
        if not _is_series(y):
            raise _ProbeError(f"{p['y']} 가 Series 가 아닙니다")
        pred = pd.Series(list(mdl.predict(X)), index=y.index)
        groups = _df(p["frame"]).loc[y.index, p["column"]]
        out = {}
        for g in sorted(set(map(str, groups))):
            mask = (groups.astype(str) == g).to_numpy()
            out[g] = _metric_value(p.get("metric", "mae"), y[mask], pred[mask])
        red = p.get("reduce")
        if red in ("argmax", "argmin"):
            target = (max if red == "argmax" else min)(out.values())
            return next(g for g, v in out.items() if abs(v - target) <= 1e-12)
        # 학생의 groupby 결과(Series)와 같은 형식으로 비교 (인덱스 = 그룹 이름 오름차순)
        return {"__series__": {"index": list(out.keys()), "values": list(out.values())}}
    if k == "figure_data_match":
        # (엔진 1.6.0) Figure 첫 축의 실제 데이터가 학생 현재 source 와 같은지. histogram: numpy.histogram(결측 제외, bins) 의 구간 경계와 빈도를 막대 x, width, height 와 비교.
        # scatter: 축의 모든 점 (x, y) 쌍을 source 의 같은 행 (x_column, y_column) 쌍과 순서 무관(multiset) 비교. 최대 20000 점, 숫자 abs 1e-6 + rel 1e-9
        import numpy as np
        f = _var(p["var"])
        if type(f).__name__ != "Figure" or not (type(f).__module__ or "").startswith("matplotlib") or len(f.axes) != 1:
            return False
        ax = f.axes[0]
        df = _df(p["source"])
        def _closearr(a, b):
            a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
            return a.shape == b.shape and bool(np.all(np.isfinite(a))) and bool(np.allclose(a, b, rtol=1e-9, atol=1e-6))
        if p.get("plot") == "histogram":
            col = p.get("column"); bins = p.get("bins")
            if col not in df.columns or not isinstance(bins, int) or isinstance(bins, bool) or not 1 <= bins <= 40:
                raise _ProbeError("히스토그램 설정 오류")
            vals = df[col].dropna().to_numpy(dtype=float)
            if len(vals) == 0 or len(vals) > 200000:
                raise _ProbeError("데이터 크기 오류")
            counts, edges = np.histogram(vals, bins=bins)
            rects = sorted([q for q in ax.patches if type(q).__name__ == "Rectangle"], key=lambda q: q.get_x())
            if len(rects) != bins:
                return False
            xs = [q.get_x() for q in rects]; ws = [q.get_width() for q in rects]; hs = [q.get_height() for q in rects]
            return _closearr(xs, edges[:-1]) and _closearr(np.add(xs, ws), edges[1:]) and _closearr(hs, counts)
        if p.get("plot") == "scatter":
            xc, yc = p.get("x_column"), p.get("y_column")
            if xc not in df.columns or yc not in df.columns:
                raise _ProbeError("산점도 컬럼이 없습니다")
            pts = [np.asarray(c.get_offsets(), dtype=float) for c in ax.collections if hasattr(c, "get_offsets") and len(c.get_offsets())]
            if not pts:
                return False
            got = np.concatenate(pts)
            if got.ndim != 2 or got.shape[1] != 2 or len(got) > 20000:
                return False
            exp = df[[xc, yc]].dropna().to_numpy(dtype=float)
            if len(got) != len(exp):
                return False
            got = got[np.lexsort((got[:, 1], got[:, 0]))]; exp = exp[np.lexsort((exp[:, 1], exp[:, 0]))]
            return _closearr(got, exp)
        if p.get("plot") == "bar":
            # (엔진 1.7.0) 막대 높이(x 위치 순)가 학생 series 값(순서대로)과 같은지, 막대 수 일치. check_labels 면 눈금 글자도 str(index) 와 비교
            sv = _var(p["series"])
            if not _is_series(sv) or len(sv) == 0 or len(sv) > 200:
                raise _ProbeError("series 오류")
            rects = sorted([q for q in ax.patches if type(q).__name__ == "Rectangle"], key=lambda q: q.get_x())
            vals = sv.to_numpy(dtype=float)
            ok = np.isfinite(vals)
            if len(rects) != int(ok.sum()):
                return False
            if not _closearr([q.get_height() for q in rects], vals[ok]):
                return False
            if p.get("check_labels") is True:
                f.canvas.draw()
                labs = [t.get_text() for t in ax.get_xticklabels()]
                want = [str(i) for i, k in zip(sv.index, ok) if k]
                if labs != want:
                    return False
            return True
        raise _ProbeError("plot 은 histogram, scatter, bar")
    if k == "scaled_with":
        # (엔진 1.6.0) var[scale_columns] 가 학생 scaler 로 source[scale_columns] 를 transform 한 값과 같고, 나머지 컬럼은 source 와 같은지 (인덱스, 컬럼 순서 포함)
        import numpy as np
        import pandas as pd
        got, src = _df(p["var"]), _df(p["source"])
        sc = _var(p["scaler"])
        cols = list(p.get("scale_columns") or [])
        if not cols or any(c not in src.columns for c in cols) or not hasattr(sc, "transform"):
            raise _ProbeError("표준화 설정 오류")
        exp = src.copy()
        try:
            exp[cols] = sc.transform(src[cols])
        except Exception:
            return False
        return _same_data(got, exp.astype({c: got[c].dtype for c in cols if c in got.columns}) if set(cols) <= set(got.columns) else exp)
    if k == "cost_selection":
        # (엔진 1.7.0) 이진 분류 후보별 비용 fp*FP + fn*FN (labels [0, 1]) 을 학생 상태로 재계산. output scores 면 {이름: 비용}, selected 면 최소 비용 (동률 이름 오름차순)
        import numpy as np
        from sklearn.metrics import confusion_matrix as _cm
        cands = p.get("candidates") or []
        names = [c.get("name") for c in cands]
        if not 1 <= len(cands) <= 5 or len(set(names)) != len(names):
            raise _ProbeError("후보 구성 오류")
        costs = p.get("costs") or {}
        cfp, cfn = costs.get("fp"), costs.get("fn")
        if not all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 100 for v in (cfp, cfn)):
            raise _ProbeError("비용은 0~100 정수")
        y = _var(p["y"]); yv = np.asarray(y)
        if yv.ndim != 1 or not set(np.unique(yv).tolist()) <= {0, 1}:
            raise _ProbeError("이진(0/1) 레이블만 지원합니다")
        scores = {}
        for c in cands:
            X = _var(c["X"])
            if hasattr(X, "index") and hasattr(y, "index") and list(map(str, X.index)) != list(map(str, y.index)):
                raise _ProbeError(f"{c['X']} 와 {p['y']} 의 인덱스가 다릅니다")
            pred = np.asarray(_predict(_var(c["model"]), X, c.get("threshold")))
            if pred.shape != yv.shape:
                raise _ProbeError("예측 길이가 레이블과 다릅니다")
            tn, fp, fn, tp = _cm(yv, pred, labels=[0, 1]).ravel()
            scores[c["name"]] = int(cfp * fp + cfn * fn)
        if p.get("output") == "scores":
            return scores
        if p.get("output") != "selected":
            raise _ProbeError("output 은 selected 또는 scores")
        return sorted(names, key=lambda n: (scores[n], n))[0]
    if k == "time_split_reproduced":
        # (엔진 1.7.0) 학생 현재 frame 에서 date_column < cutoff 를 훈련, 나머지를 평가로 다시 나눠 outputs 와 비교 (output match).
        # output train_period / test_period 는 학생 outputs X_train / X_test 인덱스의 frame 날짜 (최소, 최대) 를 YYYY-MM-DD 로 반환
        import pandas as pd
        df = _df(p["frame"])
        dc, tgt = p.get("date_column"), p.get("target")
        drop = list(p.get("drop") or [])
        if dc not in df.columns or tgt not in drop or dc not in drop or any(c not in df.columns for c in drop):
            raise _ProbeError("분할 기준 컬럼이 없습니다")
        if df[dc].dtype.kind != "M":
            raise _ProbeError(f"{dc} 가 날짜(datetime) 형식이 아닙니다")
        try:
            cut = pd.Timestamp(str(p.get("cutoff")))
        except Exception:
            raise _ProbeError("cutoff 형식 오류")
        outs = p.get("outputs") or {}
        mode = p.get("output", "match")
        if mode in ("train_period", "test_period"):
            vn = outs.get("X_train" if mode == "train_period" else "X_test")
            part = _var(vn)
            if not hasattr(part, "index") or len(part) == 0 or not set(part.index) <= set(df.index):
                raise _ProbeError("분할 결과의 인덱스를 원본에서 찾을 수 없습니다")
            dts = df.loc[part.index, dc]
            return [dts.min().strftime("%Y-%m-%d"), dts.max().strftime("%Y-%m-%d")]
        if mode != "match":
            raise _ProbeError("output 오류")
        m = df[dc] < cut
        X = df.drop(columns=drop); y = df[tgt]
        exp = {"X_train": X[m], "X_test": X[~m], "y_train": y[m], "y_test": y[~m]}
        return {k2: _same_data(_g_ns.get(vn) if isinstance(vn, str) and _NAME_RE.match(vn) else None, exp[k2]) for k2, vn in outs.items() if k2 in exp}
    if k == "subset_metric":
        # (엔진 1.7.0) 모델 예측을 y 인덱스에 맞추고 frame.loc[y.index, column] >= value 인 행만의 지표
        import numpy as np
        import pandas as pd
        y = _var(p["y"])
        if not _is_series(y):
            raise _ProbeError(f"{p['y']} 가 Series 가 아닙니다")
        X = _var(p["X"])
        if hasattr(X, "index") and list(map(str, X.index)) != list(map(str, y.index)):
            raise _ProbeError(f"{p['X']} 와 {p['y']} 의 인덱스가 다릅니다")
        pred = pd.Series(np.asarray(_predict(_var(p["model"]), X, p.get("threshold"))), index=y.index)
        w = p.get("where") or {}
        fr = _df(p["frame"])
        if w.get("op") != "ge" or w.get("column") not in fr.columns or not set(y.index) <= set(fr.index):
            raise _ProbeError("조건 오류")
        mask = (fr.loc[y.index, w["column"]] >= float(w["value"])).to_numpy()
        if not mask.any():
            raise _ProbeError("조건에 맞는 행이 없습니다")
        return _metric_value(p.get("metric", "mae"), y[mask], pred[mask])
    if k == "transformer_check":
        # (엔진 1.7.0) ColumnTransformer 구조 (순서대로 단계 클래스, 컬럼, OneHotEncoder 옵션. 이름은 비교하지 않음) 와 source 로 fit 했는지 (imputer 중앙값, scaler 평균, 학습 행 수)
        import numpy as np
        ct = _var(p["var"])
        if type(ct).__name__ != "ColumnTransformer" or not hasattr(ct, "transformers_"):
            raise _ProbeError(f"{p['var']} 가 fit 된 ColumnTransformer 가 아닙니다")
        allowed = {"Pipeline", "SimpleImputer", "StandardScaler", "OneHotEncoder"}
        src = _df(p["source"])
        struct, fit_ok = [], True
        for name, tr, cols in ct.transformers_:
            if name == "remainder":
                if len(cols):
                    struct.append(["remainder", str(tr), [str(c) for c in cols], {}])
                continue
            steps = [s2 for _, s2 in tr.steps] if type(tr).__name__ == "Pipeline" else [tr]
            cls = [type(s2).__name__ for s2 in steps]
            if not set(cls) <= allowed:
                raise _ProbeError("허용되지 않는 변환기")
            info = {}
            for s2 in steps:
                if type(s2).__name__ == "OneHotEncoder":
                    info = {"handle_unknown": s2.handle_unknown, "sparse_output": bool(s2.sparse_output)}
            struct.append([cls, [str(c) for c in cols], info])  # 이름은 풀이마다 달라도 됨 (make_column_transformer 등)
            part = src[list(cols)]
            for s2 in steps:
                t = type(s2).__name__
                if t == "SimpleImputer":
                    if getattr(s2, "strategy", None) == "median":
                        fit_ok &= bool(np.allclose(s2.statistics_, part.median().to_numpy(dtype=float), atol=1e-9, equal_nan=True))
                    part = part.fillna(dict(zip(part.columns, s2.statistics_)))
                elif t == "StandardScaler":
                    fit_ok &= int(s2.n_samples_seen_ if np.ndim(s2.n_samples_seen_) == 0 else np.max(s2.n_samples_seen_)) == len(src)
                    fit_ok &= bool(np.allclose(s2.mean_, part.to_numpy(dtype=float).mean(axis=0), atol=1e-6))
        return {"structure": struct, "fit_on_source": bool(fit_ok)}
    if k == "transformed_with":
        # (엔진 1.7.0) var 가 학생 transformer.transform(source) 결과와 모양, 값이 같은지 (학생 객체는 바꾸지 않음)
        import numpy as np
        tr = _var(p["transformer"])
        if type(tr).__name__ not in ("ColumnTransformer", "Pipeline", "StandardScaler", "OneHotEncoder", "SimpleImputer"):
            raise _ProbeError("허용되지 않는 변환기")
        try:
            exp = np.asarray(tr.transform(_df(p["source"])), dtype=float)
            got = np.asarray(_var(p["var"]), dtype=float)
        except Exception:
            return False
        return got.shape == exp.shape and bool(np.allclose(got, exp, rtol=1e-9, atol=1e-9))
    if k == "stratified_cv_scores":
        # (엔진 1.7.0) Pipeline([clone(transformer), LogisticRegression(params)]) 를 StratifiedKFold 로 교차 검증한 fold 별 f1 (폴드마다 전처리 재학습)
        import numpy as np
        from sklearn.base import clone
        from sklearn.pipeline import Pipeline
        from sklearn.model_selection import StratifiedKFold, cross_val_score
        if p.get("model_class") != "LogisticRegression" or p.get("scoring", "f1") != "f1":
            raise _ProbeError("교차 검증은 LogisticRegression, f1 만")
        tr = _var(p["transformer"])
        if type(tr).__name__ not in ("ColumnTransformer", "Pipeline"):
            raise _ProbeError("허용되지 않는 변환기")
        X, y = _df(p["X"]), _var(p["y"])
        ns_ = p.get("n_splits", 5)
        if len(X) > 5000 or not isinstance(ns_, int) or not 2 <= ns_ <= 5 or len(X) != len(y):
            raise _ProbeError("교차 검증 범위 초과")
        rs = p.get("random_state")
        cv = StratifiedKFold(n_splits=ns_, shuffle=bool(p.get("shuffle")), random_state=(rs if p.get("shuffle") else None))
        pipe = Pipeline([("preprocessor", clone(tr)), ("model", _model_cls("LogisticRegression")(**_params(p.get("params"))))])
        return [float(v) for v in cross_val_score(pipe, X, y, cv=cv, scoring="f1", n_jobs=1)]
    if k == "onehot_reproduced":
        # (엔진 1.5.0) 학생의 현재 source (assign 으로 Series 컬럼 추가 가능) 에 pd.get_dummies(columns=onehot_columns, dtype=int) 를 다시 적용한 결과와 var 비교 (컬럼 집합, 인덱스, 컬럼별 dtype 종류와 값)
        import pandas as pd
        src = _df(p["source"])
        cols = list(p.get("onehot_columns") or [])
        if not cols or any(c not in src.columns for c in cols):
            raise _ProbeError("인코딩할 컬럼이 없습니다")
        extra = p.get("assign") or {}
        if len(extra) > 3:
            raise _ProbeError("assign 은 3개까지")
        if extra:
            src = src.copy()
            for name, vn in extra.items():
                if not _NAME_RE.match(str(name)):
                    raise _ProbeError("허용되지 않는 컬럼 이름")
                sv = _var(vn)
                if not _is_series(sv) or [str(i) for i in sv.index] != [str(i) for i in src.index]:
                    raise _ProbeError(f"{vn} 가 같은 인덱스의 Series 가 아닙니다")
                src[name] = sv
        exp = pd.get_dummies(src, columns=cols, dtype=int)
        got = _var(p["var"])
        if not _is_df(got) or set(map(str, got.columns)) != set(map(str, exp.columns)):
            return False
        return _same_data(got[list(exp.columns)], exp)
    if k == "confusion_matrix":
        # (엔진 1.5.0) 이진 혼동행렬 [[TN, FP], [FN, TP]] (labels 순서), 예측은 pred 변수 또는 model+X(+threshold) 로 학생 상태에서 계산
        import numpy as np
        from sklearn.metrics import confusion_matrix as _cm
        yv = np.asarray(_var(p["y"]))
        if p.get("pred"):
            pv = np.asarray(_var(p["pred"]))
        else:
            pv = np.asarray(_predict(_var(p["model"]), _var(p["X"]), p.get("threshold")))
        if yv.shape != pv.shape or yv.ndim != 1:
            raise _ProbeError("예측 길이가 레이블과 다릅니다")
        labels = p.get("labels") or [0, 1]
        if sorted(labels) != [0, 1]:
            raise _ProbeError("labels 는 0, 1")
        cmx = _cm(yv, pv, labels=labels)
        cell = p.get("cell")
        if cell is not None:
            # (엔진 1.7.0) labels [0, 1] 기준 한 칸: tn, fp, fn, tp
            if cell not in ("tn", "fp", "fn", "tp") or labels != [0, 1]:
                raise _ProbeError("cell 은 tn, fp, fn, tp (labels [0, 1])")
            return int(cmx.ravel()[["tn", "fp", "fn", "tp"].index(cell)])
        return cmx.tolist()
    if k == "metric_gap":
        # (엔진 1.5.0) 같은 모델의 두 데이터 지표 차이 metric(X_a, y_a) - metric(X_b, y_b) (예: 훈련 R2 - 평가 R2)
        m = p.get("metric")
        if m not in _METRICS:
            raise _ProbeError("허용되지 않는 지표")
        model = _var(p["model"])
        a = _metric_value(m, _var(p["y_a"]), _predict(model, _var(p["X_a"])))
        b = _metric_value(m, _var(p["y_b"]), _predict(model, _var(p["X_b"])))
        return a - b
    if k == "column_values":
        # (엔진 1.4.0) DataFrame 컬럼 값 (minus_column 이 있으면 column - minus_column). as_list 면 위치 순서 리스트, 아니면 인덱스 포함 Series 형식
        df = _df(p["var"])
        c, mc = p.get("column"), p.get("minus_column")
        if c not in df.columns or (mc is not None and mc not in df.columns):
            raise _ProbeError("컬럼이 없습니다")
        s = df[c] - df[mc] if mc is not None else df[c]
        return [_norm(x) for x in s.tolist()] if p.get("as_list") is True else _norm(s)
    if k == "figure_info":
        # (엔진 1.4.0) 학생이 변수에 저장한 matplotlib Figure 의 구조 정보 하나 (axes 수, 첫 축의 xlabel, ylabel, 막대 수, 산점도 점 수)
        f = _var(p["var"])
        if type(f).__name__ != "Figure" or not (type(f).__module__ or "").startswith("matplotlib"):
            raise _ProbeError(f"{p['var']} 가 matplotlib Figure 가 아닙니다")
        field = p.get("field")
        axes = list(f.axes)
        if field == "axes":
            return len(axes)
        if not axes:
            raise _ProbeError("그림에 축이 없습니다")
        ax = axes[0]
        if field == "xlabel":
            return str(ax.get_xlabel())
        if field == "ylabel":
            return str(ax.get_ylabel())
        if field == "bars":
            return sum(1 for q in ax.patches if type(q).__name__ == "Rectangle")
        if field == "points":
            return int(sum(len(c.get_offsets()) for c in ax.collections if hasattr(c, "get_offsets")))
        if field == "bar_total":
            return float(sum(q.get_height() for q in ax.patches if type(q).__name__ == "Rectangle"))
        if field in ("x_mean", "y_mean"):
            import numpy as np
            offs = [np.asarray(c.get_offsets()) for c in ax.collections if hasattr(c, "get_offsets") and len(c.get_offsets())]
            if not offs:
                raise _ProbeError("산점도 점이 없습니다")
            allp = np.concatenate(offs)
            return float(np.nanmean(allp[:, 0 if field == "x_mean" else 1]))
        raise _ProbeError("허용되지 않는 field")
    if k == "split_reproduced":
        # (엔진 1.4.0) 학생의 현재 frame 에서 drop 컬럼을 뺀 X 와 target 을 지정 설정으로 다시 나눠 학생 분할 변수와 인덱스, 컬럼 순서, dtype 종류, 값 비교
        df = _df(p["frame"])
        tgt = p.get("target")
        drop = list(p.get("drop") or [])
        if tgt not in drop or not all(isinstance(c, str) for c in drop) or any(c not in df.columns for c in drop):
            raise _ProbeError("분할 기준 컬럼이 없습니다")
        ts, rs = p.get("test_size"), p.get("random_state")
        if not isinstance(ts, (int, float)) or isinstance(ts, bool) or not (0.0 < float(ts) < 1.0):
            raise _ProbeError("test_size 범위 오류")
        if not isinstance(rs, int) or isinstance(rs, bool) or not (0 <= rs <= 2147483647):
            raise _ProbeError("random_state 범위 오류")
        from sklearn.model_selection import train_test_split
        X = df.drop(columns=drop)
        y = df[tgt]
        parts = train_test_split(X, y, test_size=float(ts), random_state=rs, stratify=(y if p.get("stratify") is True else None))
        outs = p.get("outputs") or {}
        res = {}
        for key, exp in zip(("X_train", "X_test", "y_train", "y_test"), parts):
            vn = outs.get(key)
            if not vn:
                continue
            res[key] = _same_data(_g_ns.get(vn) if isinstance(vn, str) and _NAME_RE.match(vn) else None, exp)
        return res
    if k == "constrained_selection":
        # (엔진 1.4.0) 이진 분류 후보를 학생 상태로 다시 예측해 제약(constraint) 통과 후보 중 objective 최적, 없으면 fallback 최적, 동률은 이름 오름차순
        import math
        import numpy as np
        cands = p.get("candidates") or []
        names = [c.get("name") for c in cands]
        if not 1 <= len(cands) <= 5 or len(set(names)) != len(names):
            raise _ProbeError("후보 구성 오류")
        cons, obj, fb = p.get("constraint") or {}, p.get("objective") or {}, p.get("fallback") or {}
        for part in (cons, obj, fb):
            if part.get("metric") not in _CLS_METRICS:
                raise _ProbeError("허용되지 않는 지표")
        cv = cons.get("value")
        if cons.get("op") != "ge" or not isinstance(cv, (int, float)) or isinstance(cv, bool) or not (0.0 <= float(cv) <= 1.0):
            raise _ProbeError("제약 조건 오류")
        if obj.get("goal") not in ("max", "min") or fb.get("goal") not in ("max", "min") or p.get("tie", "name_asc") != "name_asc":
            raise _ProbeError("선택 규칙 오류")
        y = _var(p["y"])
        yv = np.asarray(y)
        if yv.ndim != 1 or not set(np.unique(yv).tolist()) <= {0, 1}:
            raise _ProbeError("이진(0/1) 레이블만 지원합니다")
        need = list(dict.fromkeys([cons["metric"], obj["metric"], fb["metric"]]))
        scores = {}
        for c in cands:
            X = _var(c["X"])
            if hasattr(X, "index") and hasattr(y, "index") and list(map(str, X.index)) != list(map(str, y.index)):
                raise _ProbeError(f"{c['X']} 와 {p['y']} 의 인덱스가 다릅니다")
            pred = np.asarray(_predict(_var(c["model"]), X, c.get("threshold")))
            if pred.shape != yv.shape:
                raise _ProbeError("예측 길이가 레이블과 다릅니다")
            sc = {m: _cls_metric(m, yv, pred) for m in need}
            if not all(math.isfinite(v) for v in sc.values()):
                raise _ProbeError("지표 계산 오류")
            scores[c["name"]] = sc
        if p.get("output") == "scores":
            return scores
        if p.get("output") != "selected":
            raise _ProbeError("output 은 selected 또는 scores")
        passed = [n for n in names if scores[n][cons["metric"]] >= float(cv) - 1e-12]
        pool, rule = (passed, obj) if passed else (names, fb)
        sign = -1.0 if rule["goal"] == "max" else 1.0
        return sorted(pool, key=lambda n: (round(sign * scores[n][rule["metric"]], 12), n))[0]
    if k == "imputed_against":
        # (엔진 1.3.0) var[column] 이 raw[column] 의 결측 위치에서 stat_var[column] 의 통계값, 나머지는 raw 와 같은지 (인덱스 기준)
        raw = _col(p["raw"], p["column"])
        cur = _col(p["var"], p["column"])
        st = p.get("stat", "median")
        if st not in ("median", "mean"):
            raise _ProbeError("허용되지 않는 통계")
        src = _col(p["stat_var"], p["column"])
        target = float(getattr(src, st)())
        if list(map(str, cur.index)) != list(map(str, raw.index)):
            return {"filled_dev": float("inf"), "kept_dev": float("inf"), "same_rows": False}
        miss = raw.isna().to_numpy()
        fd = kd = 0.0
        for a, b, mm in zip(cur.tolist(), raw.tolist(), miss):
            va = _num(a)
            if va is None:
                return {"filled_dev": float("inf"), "kept_dev": float("inf"), "same_rows": True}
            if mm:
                fd = max(fd, abs(va - target))
            else:
                kd = max(kd, abs(va - _num(b)))
        return {"filled_dev": fd, "kept_dev": kd, "same_rows": True}
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
