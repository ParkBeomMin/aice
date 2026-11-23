// 브라우저 딥러닝 실습용 Keras 호환 모듈 (numpy). 원본 tf_shim/_acf_keras.py, 생성 tf_shim/build.py
export const TF_SHIM_DIR = '/lib/acf_shims';
export const TF_SHIM_FILES: Record<string, string> = {
  "_acf_keras.py": String.raw`"""AICE 연습용 Keras 호환 모듈 (numpy 구현). 브라우저(Pyodide)에서 TensorFlow 가 돌지 않아,
시험에 나오는 Keras 문법(Sequential, Dense, Dropout, compile, fit, EarlyStopping, ModelCheckpoint, history, predict, evaluate)을
같은 이름과 인자로 쓸 수 있게 한 학습용 구현이다. 실제 TensorFlow 와 결과 숫자는 다를 수 있다."""
import math, pickle, sys
import numpy as np

__version__ = "2.15.0"
ACF_SHIM = True
_RNG = np.random.default_rng(0)


def set_random_seed(seed):
    global _RNG
    _RNG = np.random.default_rng(int(seed))
    np.random.seed(int(seed) % (2 ** 32))


def _arr(x, dtype=np.float32):
    if hasattr(x, "to_numpy"):
        x = x.to_numpy()
    a = np.asarray(x)
    if a.dtype == object or a.dtype == bool:
        a = a.astype(np.float64)
    return a.astype(dtype)


# ---------------- activations ----------------
def _act(name):
    if name is None or name == "linear":
        return "linear"
    if callable(name):
        name = getattr(name, "__name__", "")
    name = str(name).lower()
    if name not in ("relu", "sigmoid", "tanh", "softmax", "linear", "elu", "selu", "swish", "leaky_relu"):
        raise ValueError(f"지원하지 않는 활성화 함수: {name} (relu, sigmoid, tanh, softmax, linear 등)")
    return name


def _fwd_act(name, z):
    if name == "linear":
        return z
    if name == "relu":
        return np.maximum(z, 0)
    if name == "leaky_relu":
        return np.where(z > 0, z, 0.2 * z)
    if name == "elu":
        return np.where(z > 0, z, np.expm1(np.minimum(z, 0)))
    if name == "selu":
        a, s = 1.6732632423543772, 1.0507009873554805
        return s * np.where(z > 0, z, a * np.expm1(np.minimum(z, 0)))
    if name == "sigmoid":
        return 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))
    if name == "swish":
        return z / (1.0 + np.exp(-np.clip(z, -60, 60)))
    if name == "tanh":
        return np.tanh(z)
    if name == "softmax":
        e = np.exp(z - z.max(axis=1, keepdims=True))
        return e / e.sum(axis=1, keepdims=True)
    raise ValueError(name)


def _bwd_act(name, z, a, g):
    if name == "linear":
        return g
    if name == "relu":
        return g * (z > 0)
    if name == "leaky_relu":
        return g * np.where(z > 0, 1.0, 0.2)
    if name == "elu":
        return g * np.where(z > 0, 1.0, a + 1.0)
    if name == "selu":
        al, s = 1.6732632423543772, 1.0507009873554805
        return g * np.where(z > 0, s, a + s * al)
    if name == "sigmoid":
        return g * a * (1 - a)
    if name == "swish":
        sg = 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))
        return g * (sg + z * sg * (1 - sg))
    if name == "tanh":
        return g * (1 - a * a)
    if name == "softmax":
        return a * (g - (g * a).sum(axis=1, keepdims=True))
    raise ValueError(name)


# ---------------- layers ----------------
class Layer:
    trainable = True
    _count = {}

    def __init__(self, name=None):
        k = type(self).__name__.lower()
        Layer._count[k] = Layer._count.get(k, 0) + 1
        self.name = name or (k if Layer._count[k] == 1 else f"{k}_{Layer._count[k] - 1}")
        self.built = False

    def params(self):
        return []

    def count_params(self):
        return int(sum(p.size for p in self.params()))

    def get_weights(self):
        return [p.copy() for p in self.params()]

    def set_weights(self, ws):
        for p, w in zip(self.params(), ws):
            p[...] = w


class InputLayer(Layer):
    def __init__(self, shape=None, input_shape=None, name=None, **kw):
        super().__init__(name or "input_layer")
        s = shape if shape is not None else input_shape
        self.shape = tuple(s) if isinstance(s, (tuple, list)) else (s,)


def Input(shape=None, name=None, **kw):
    return InputLayer(shape=shape, name=name)


class Dense(Layer):
    def __init__(self, units, activation=None, use_bias=True, input_shape=None, input_dim=None,
                 kernel_initializer="glorot_uniform", name=None, **kw):
        super().__init__(name)
        self.units = int(units)
        if self.units < 1:
            raise ValueError("units 는 1 이상이어야 합니다")
        self.activation = _act(activation)
        self.use_bias = use_bias
        self.kernel_initializer = kernel_initializer
        self.input_shape_arg = (input_dim,) if input_dim else (tuple(input_shape) if input_shape else None)

    def build(self, n_in):
        ki = str(self.kernel_initializer).lower()
        if "he" in ki:
            lim = math.sqrt(6.0 / n_in)
        else:
            lim = math.sqrt(6.0 / (n_in + self.units))
        self.W = _RNG.uniform(-lim, lim, size=(n_in, self.units)).astype(np.float32)
        self.b = np.zeros(self.units, dtype=np.float32)
        self.built = True
        return self.units

    def params(self):
        return [self.W, self.b] if self.use_bias else [self.W]

    def forward(self, x, training):
        self._x = x
        self._z = x @ self.W + (self.b if self.use_bias else 0)
        self._a = _fwd_act(self.activation, self._z)
        return self._a

    def backward(self, g, skip_act=False):
        dz = g if skip_act else _bwd_act(self.activation, self._z, self._a, g)
        grads = [self._x.T @ dz]
        if self.use_bias:
            grads.append(dz.sum(axis=0))
        return dz @ self.W.T, grads


class Activation(Layer):
    def __init__(self, activation, name=None, **kw):
        super().__init__(name)
        self.activation = _act(activation)

    def build(self, n_in):
        self.built = True
        return n_in

    def forward(self, x, training):
        self._z = x
        self._a = _fwd_act(self.activation, x)
        return self._a

    def backward(self, g, skip_act=False):
        return (g if skip_act else _bwd_act(self.activation, self._z, self._a, g)), []


class Dropout(Layer):
    def __init__(self, rate, name=None, **kw):
        super().__init__(name)
        self.rate = float(rate)
        if not 0 <= self.rate < 1:
            raise ValueError("Dropout rate 는 0 이상 1 미만이어야 합니다")

    def build(self, n_in):
        self.built = True
        return n_in

    def forward(self, x, training):
        if training and self.rate > 0:
            self._m = (_RNG.random(x.shape) >= self.rate).astype(np.float32) / (1 - self.rate)
            return x * self._m
        self._m = None
        return x

    def backward(self, g, skip_act=False):
        return (g * self._m if self._m is not None else g), []


class Flatten(Layer):
    def build(self, n_in):
        self.built = True
        return n_in

    def forward(self, x, training):
        self._shape = x.shape
        return x.reshape(len(x), -1)

    def backward(self, g, skip_act=False):
        return g.reshape(self._shape), []


class BatchNormalization(Layer):
    def __init__(self, momentum=0.99, epsilon=1e-3, name=None, **kw):
        super().__init__(name)
        self.momentum, self.eps = momentum, epsilon

    def build(self, n_in):
        self.gamma = np.ones(n_in, np.float32); self.beta = np.zeros(n_in, np.float32)
        self.mm = np.zeros(n_in, np.float32); self.mv = np.ones(n_in, np.float32)
        self.built = True
        return n_in

    def params(self):
        return [self.gamma, self.beta]

    def get_weights(self):
        return [self.gamma.copy(), self.beta.copy(), self.mm.copy(), self.mv.copy()]

    def count_params(self):
        return int(4 * self.gamma.size)

    def forward(self, x, training):
        if training:
            mu, var = x.mean(0), x.var(0)
            self.mm = self.momentum * self.mm + (1 - self.momentum) * mu
            self.mv = self.momentum * self.mv + (1 - self.momentum) * var
        else:
            mu, var = self.mm, self.mv
        self._xh = (x - mu) / np.sqrt(var + self.eps); self._std = np.sqrt(var + self.eps)
        return self.gamma * self._xh + self.beta

    def backward(self, g, skip_act=False):
        n = len(g); xh = self._xh
        dxh = g * self.gamma
        dx = (n * dxh - dxh.sum(0) - xh * (dxh * xh).sum(0)) / (n * self._std)
        return dx, [(g * xh).sum(0), g.sum(0)]


# ---------------- optimizers ----------------
class Optimizer:
    def __init__(self, learning_rate=0.001, **kw):
        if "lr" in kw:
            learning_rate = kw["lr"]
        self.learning_rate = float(learning_rate)
        self.t = 0
        self.state = {}

    def apply(self, params, grads):
        self.t += 1
        for i, (p, g) in enumerate(zip(params, grads)):
            p -= self.step(i, p, g.astype(np.float32))


class Adam(Optimizer):
    def __init__(self, learning_rate=0.001, beta_1=0.9, beta_2=0.999, epsilon=1e-7, **kw):
        super().__init__(learning_rate, **kw)
        self.b1, self.b2, self.eps = beta_1, beta_2, epsilon

    def step(self, i, p, g):
        m, v = self.state.get(i, (np.zeros_like(p), np.zeros_like(p)))
        m = self.b1 * m + (1 - self.b1) * g
        v = self.b2 * v + (1 - self.b2) * g * g
        self.state[i] = (m, v)
        mh = m / (1 - self.b1 ** self.t); vh = v / (1 - self.b2 ** self.t)
        return self.learning_rate * mh / (np.sqrt(vh) + self.eps)


class SGD(Optimizer):
    def __init__(self, learning_rate=0.01, momentum=0.0, **kw):
        super().__init__(learning_rate, **kw)
        self.momentum = momentum

    def step(self, i, p, g):
        v = self.momentum * self.state.get(i, np.zeros_like(p)) + self.learning_rate * g
        self.state[i] = v
        return v


class RMSprop(Optimizer):
    def __init__(self, learning_rate=0.001, rho=0.9, epsilon=1e-7, **kw):
        super().__init__(learning_rate, **kw)
        self.rho, self.eps = rho, epsilon

    def step(self, i, p, g):
        s = self.rho * self.state.get(i, np.zeros_like(p)) + (1 - self.rho) * g * g
        self.state[i] = s
        return self.learning_rate * g / (np.sqrt(s) + self.eps)


def _opt(o):
    if isinstance(o, Optimizer):
        return o
    n = str(o).lower()
    return {"adam": Adam, "sgd": SGD, "rmsprop": RMSprop}.get(n, None)() if n in ("adam", "sgd", "rmsprop") else _bad(f"지원하지 않는 optimizer: {o} (adam, sgd, rmsprop)")


def _bad(msg):
    raise ValueError(msg)


# ---------------- losses / metrics ----------------
_LOSS_ALIASES = {"bce": "binary_crossentropy", "mean_squared_error": "mse", "mean_absolute_error": "mae",
                 "categorical_crossentropy": "categorical_crossentropy", "sparse_categorical_crossentropy": "sparse_categorical_crossentropy",
                 "binary_crossentropy": "binary_crossentropy", "mse": "mse", "mae": "mae", "huber": "huber"}


def _loss_name(l):
    if callable(l) and not isinstance(l, str):
        l = getattr(l, "__name__", getattr(l, "name", str(l)))
    n = _LOSS_ALIASES.get(str(l).lower())
    if not n:
        raise ValueError(f"지원하지 않는 loss: {l} (binary_crossentropy, categorical_crossentropy, sparse_categorical_crossentropy, mse, mae)")
    return n


def _prep_y(loss, y, out_units):
    y = _arr(y)
    if loss == "sparse_categorical_crossentropy":
        yi = y.reshape(-1).astype(int)
        oh = np.zeros((len(yi), out_units), np.float32); oh[np.arange(len(yi)), yi] = 1
        return oh
    if y.ndim == 1:
        y = y.reshape(-1, 1)
    return y


def _loss_val_grad(loss, p, y):
    n = len(p); eps = 1e-7
    if loss in ("binary_crossentropy",):
        pc = np.clip(p, eps, 1 - eps)
        return float(-(y * np.log(pc) + (1 - y) * np.log(1 - pc)).mean()), (pc - y) / (pc * (1 - pc)) / p.size
    if loss in ("categorical_crossentropy", "sparse_categorical_crossentropy"):
        pc = np.clip(p, eps, 1 - eps)
        return float(-(y * np.log(pc)).sum(axis=1).mean()), -(y / pc) / n
    if loss == "mse":
        d = p - y
        return float((d * d).mean()), 2 * d / p.size
    if loss == "mae":
        d = p - y
        return float(np.abs(d).mean()), np.sign(d) / p.size
    if loss == "huber":
        d = p - y; a = np.abs(d)
        return float(np.where(a <= 1, 0.5 * d * d, a - 0.5).mean()), np.where(a <= 1, d, np.sign(d)) / p.size
    raise ValueError(loss)


def _metric(name, loss, p, y):
    if name in ("accuracy", "acc"):
        if p.shape[1] == 1:
            return float(((p > 0.5).astype(np.float32) == y).mean())
        return float((p.argmax(1) == y.argmax(1)).mean())
    if name in ("mae", "mean_absolute_error"):
        return float(np.abs(p - y).mean())
    if name in ("mse", "mean_squared_error"):
        return float(((p - y) ** 2).mean())
    if name in ("rmse", "root_mean_squared_error"):
        return float(np.sqrt(((p - y) ** 2).mean()))
    raise ValueError(f"지원하지 않는 metric: {name} (accuracy, mae, mse)")


def _metric_key(m):
    if not isinstance(m, str):
        m = getattr(m, "name", getattr(m, "__name__", str(m)))
    m = str(m).lower()
    return {"acc": "accuracy", "mean_absolute_error": "mae", "mean_squared_error": "mse"}.get(m, m)


# ---------------- callbacks ----------------
class Callback:
    model = None

    def set_model(self, m):
        self.model = m

    def on_train_begin(self, logs=None): pass
    def on_epoch_end(self, epoch, logs=None): pass
    def on_train_end(self, logs=None): pass


def _mode(monitor, mode):
    if mode in ("min", "max"):
        return mode
    return "max" if ("acc" in monitor or "auc" in monitor) else "min"


class EarlyStopping(Callback):
    def __init__(self, monitor="val_loss", min_delta=0, patience=0, verbose=0, mode="auto", baseline=None, restore_best_weights=False, start_from_epoch=0, **kw):
        self.monitor, self.min_delta, self.patience = monitor, abs(min_delta), int(patience)
        self.verbose, self.mode, self.restore_best_weights = verbose, mode, restore_best_weights
        self.stopped_epoch = 0

    def on_train_begin(self, logs=None):
        self.wait = 0; self.best_weights = None; self.stopped_epoch = 0
        self._m = _mode(self.monitor, self.mode)
        self.best = np.inf if self._m == "min" else -np.inf

    def _better(self, v):
        return v < self.best - self.min_delta if self._m == "min" else v > self.best + self.min_delta

    def on_epoch_end(self, epoch, logs=None):
        v = (logs or {}).get(self.monitor)
        if v is None:
            print(f"경고: EarlyStopping 의 monitor '{self.monitor}' 값이 없습니다. 사용 가능한 값: {', '.join(logs or {})}")
            return
        if self._better(v):
            self.best, self.wait = v, 0
            self.best_epoch = epoch
            if self.restore_best_weights:
                self.best_weights = self.model.get_weights()
        else:
            self.wait += 1
            if self.wait >= self.patience:
                self.stopped_epoch = epoch
                self.model.stop_training = True

    def on_train_end(self, logs=None):
        if self.stopped_epoch > 0:
            if self.verbose:
                print(f"Epoch {self.stopped_epoch + 1}: early stopping")
            if self.restore_best_weights and self.best_weights is not None:
                self.model.set_weights(self.best_weights)
                if self.verbose:
                    print(f"Restoring model weights from the end of the best epoch: {self.best_epoch + 1}.")


class ModelCheckpoint(Callback):
    def __init__(self, filepath, monitor="val_loss", verbose=0, save_best_only=False, save_weights_only=False, mode="auto", **kw):
        self.filepath, self.monitor, self.verbose = str(filepath), monitor, verbose
        self.save_best_only, self.save_weights_only, self.mode = save_best_only, save_weights_only, mode

    def on_train_begin(self, logs=None):
        self._m = _mode(self.monitor, self.mode)
        self.best = np.inf if self._m == "min" else -np.inf

    def on_epoch_end(self, epoch, logs=None):
        logs = logs or {}
        path = self.filepath.format(epoch=epoch + 1, **{k: v for k, v in logs.items()})
        if not self.save_best_only:
            self.model.save(path)
            self._acf_saved = {"epoch": epoch, "path": path, "weights": _weights_fp(self.model), "model": _model_fp(self.model)}
            return
        v = logs.get(self.monitor)
        if v is None:
            print(f"경고: ModelCheckpoint 의 monitor '{self.monitor}' 값이 없습니다.")
            return
        if (v < self.best) if self._m == "min" else (v > self.best):
            if self.verbose:
                print(f"Epoch {epoch + 1}: {self.monitor} improved from {self.best:.5f} to {v:.5f}, saving model to {path}")
            self.best = v
            self.model.save(path)
            self._acf_saved = {"epoch": epoch, "path": path, "weights": _weights_fp(self.model), "model": _model_fp(self.model)}
        elif self.verbose:
            print(f"Epoch {epoch + 1}: {self.monitor} did not improve from {self.best:.5f}")


class ReduceLROnPlateau(Callback):
    def __init__(self, monitor="val_loss", factor=0.1, patience=10, min_lr=0.0, verbose=0, mode="auto", **kw):
        self.monitor, self.factor, self.patience, self.min_lr, self.verbose, self.mode = monitor, factor, patience, min_lr, verbose, mode

    def on_train_begin(self, logs=None):
        self._m = _mode(self.monitor, self.mode); self.wait = 0
        self.best = np.inf if self._m == "min" else -np.inf

    def on_epoch_end(self, epoch, logs=None):
        v = (logs or {}).get(self.monitor)
        if v is None:
            return
        if (v < self.best) if self._m == "min" else (v > self.best):
            self.best, self.wait = v, 0
        else:
            self.wait += 1
            if self.wait >= self.patience:
                opt = self.model.optimizer
                opt.learning_rate = max(opt.learning_rate * self.factor, self.min_lr); self.wait = 0
                if self.verbose:
                    print(f"Epoch {epoch + 1}: ReduceLROnPlateau reducing learning rate to {opt.learning_rate}.")


class History(Callback):
    def __init__(self):
        self.history, self.epoch, self.params = {}, [], {}


# ---------------- model ----------------
class Sequential:
    def __init__(self, layers=None, name=None):
        self.name = name or "sequential"
        self.layers = []
        self._input = None
        self.built = False
        self.optimizer = None
        self.stop_training = False
        self.history = None
        for l in layers or []:
            self.add(l)

    def add(self, layer):
        if isinstance(layer, InputLayer):
            self._input = layer.shape
            return
        if not isinstance(layer, Layer):
            raise TypeError(f"Sequential 에는 레이어만 넣을 수 있습니다: {type(layer).__name__}")
        if not self.layers and getattr(layer, "input_shape_arg", None):
            self._input = layer.input_shape_arg
        self.layers.append(layer)
        self.built = False

    def build(self, input_shape=None):
        if input_shape is not None:
            s = tuple(input_shape)
            self._input = s[1:] if len(s) > 1 and s[0] is None else s
        if self._input is None:
            raise ValueError("입력 크기를 알 수 없습니다. 첫 Dense 에 input_shape=(특징 수,) 를 주거나 Input(shape=(특징 수,)) 를 먼저 넣으세요")
        n = int(np.prod(self._input))
        for l in self.layers:
            if not l.built:
                n = l.build(n)
            else:
                n = l.units if isinstance(l, Dense) else n
        self.built = True

    def _ensure(self, x):
        if not self.built:
            if self._input is None:
                self._input = x.shape[1:]
            self.build()

    def compile(self, optimizer="rmsprop", loss=None, metrics=None, **kw):
        if loss is None:
            raise ValueError("compile 에 loss 를 지정하세요")
        self.optimizer = _opt(optimizer)
        self.loss = _loss_name(loss)
        self.compiled_loss = loss
        ms = metrics or []
        if isinstance(ms, (str,)):
            ms = [ms]
        self.metrics_names = [_metric_key(m) for m in ms]
        for m in self.metrics_names:
            _metric(m, self.loss, np.zeros((1, 1), np.float32), np.zeros((1, 1), np.float32)) if m != "accuracy" else None
        self.compiled = True

    def _forward(self, x, training):
        for l in self.layers:
            x = l.forward(x, training)
        return x

    def _params(self):
        return [p for l in self.layers for p in l.params()]

    def _out_units(self):
        for l in reversed(self.layers):
            if isinstance(l, Dense):
                return l.units
        return None

    def _train_step(self, xb, yb):
        p = self._forward(xb, True)
        lv, g = _loss_val_grad(self.loss, p, yb)
        last = self.layers[-1]
        fused = isinstance(last, (Dense, Activation)) and (
            (last.activation == "sigmoid" and self.loss == "binary_crossentropy") or
            (last.activation == "softmax" and self.loss in ("categorical_crossentropy", "sparse_categorical_crossentropy")))
        if fused:
            g = (p - yb) / (p.size if self.loss == "binary_crossentropy" else len(p))
        grads = []
        for i, l in enumerate(reversed(self.layers)):
            g, lg = l.backward(g, skip_act=(fused and i == 0))
            grads = lg + grads
        self.optimizer.apply(self._params(), grads)
        return lv, p

    def _scores(self, p, y):
        lv, _ = _loss_val_grad(self.loss, p, y)
        return lv, {m: _metric(m, self.loss, p, y) for m in self.metrics_names}

    def fit(self, x=None, y=None, batch_size=None, epochs=1, verbose="auto", callbacks=None, validation_split=0.0,
            validation_data=None, shuffle=True, initial_epoch=0, **kw):
        if not getattr(self, "compiled", False):
            raise RuntimeError("fit 전에 compile 을 먼저 호출하세요")
        X = _arr(x); self._ensure(X)
        Y = _prep_y(self.loss, y, self._out_units())
        if len(X) != len(Y):
            raise ValueError(f"x 와 y 의 행 수가 다릅니다: {len(X)} != {len(Y)}")
        if validation_data is not None:
            Xv, Yv = _arr(validation_data[0]), _prep_y(self.loss, validation_data[1], self._out_units())
        elif validation_split:
            k = int(len(X) * (1 - validation_split)); Xv, Yv = X[k:], Y[k:]; X, Y = X[:k], Y[:k]
        else:
            Xv = Yv = None
        bs = int(batch_size or 32)
        # 채점용 기록: fit 에 넘긴 설정, 데이터 지문, 콜백 (학습 결과에는 영향 없음)
        self._acf_fit = {"epochs": epochs, "batch_size": batch_size, "train": [_fingerprint(x), _fingerprint(y)],
                         "valid": ([_fingerprint(validation_data[0]), _fingerprint(validation_data[1])] if validation_data is not None else None),
                         "validation_split": float(validation_split or 0), "callbacks": [id(c) for c in (callbacks or [])],
                         "callback_types": [type(c).__name__ for c in (callbacks or [])]}
        hist = History(); hist.set_model(self)
        hist.params = {"verbose": verbose, "epochs": epochs, "steps": math.ceil(len(X) / bs)}
        cbs = list(callbacks or [])
        for c in cbs:
            c.set_model(self); c.on_train_begin()
        self.stop_training = False
        steps = math.ceil(len(X) / bs)
        for ep in range(initial_epoch, epochs):
            idx = _RNG.permutation(len(X)) if shuffle else np.arange(len(X))
            for s in range(steps):
                b = idx[s * bs:(s + 1) * bs]
                self._train_step(X[b], Y[b])
            lv, ms = self._scores(self._forward(X, False), Y)
            logs = {"loss": lv, **ms}
            if Xv is not None:
                vl, vms = self._scores(self._forward(Xv, False), Yv)
                logs["val_loss"] = vl
                logs.update({"val_" + k: v for k, v in vms.items()})
            for k, v in logs.items():
                hist.history.setdefault(k, []).append(float(v))
            hist.epoch.append(ep)
            if verbose not in (0, False):
                if verbose == 2 or verbose == "auto" or verbose == 1:
                    print(f"Epoch {ep + 1}/{epochs}")
                    print(f"{steps}/{steps} - " + " - ".join(f"{k}: {v:.4f}" for k, v in logs.items()))
            for c in cbs:
                c.on_epoch_end(ep, logs)
            if self.stop_training:
                break
        for c in cbs:
            c.on_train_end()
        self.history = hist
        return hist

    def predict(self, x, batch_size=None, verbose="auto", **kw):
        X = _arr(x); self._ensure(X)
        p = self._forward(X, False)
        if verbose not in (0, False):
            n = math.ceil(len(X) / int(batch_size or 32))
            print(f"{n}/{n} ━━━━━━━━━━━━━━━━━━━━")
        return p.astype(np.float32)

    def __call__(self, x, training=False):
        return self._forward(_arr(x), training)

    def evaluate(self, x=None, y=None, batch_size=None, verbose="auto", return_dict=False, **kw):
        X = _arr(x); self._ensure(X)
        Y = _prep_y(self.loss, y, self._out_units())
        lv, ms = self._scores(self._forward(X, False), Y)
        if verbose not in (0, False):
            print(" - ".join([f"loss: {lv:.4f}"] + [f"{k}: {v:.4f}" for k, v in ms.items()]))
        if return_dict:
            return {"loss": lv, **ms}
        return [lv] + list(ms.values()) if ms else lv

    def get_weights(self):
        return [w for l in self.layers for w in l.get_weights()]

    def set_weights(self, ws):
        i = 0
        for l in self.layers:
            k = len(l.get_weights())
            if isinstance(l, BatchNormalization):
                l.gamma[...], l.beta[...], l.mm[...], l.mv[...] = ws[i:i + 4]
            else:
                l.set_weights(ws[i:i + k])
            i += k

    def count_params(self):
        return sum(l.count_params() for l in self.layers)

    def summary(self, **kw):
        if not self.built:
            if self._input is None:
                print("모델이 아직 만들어지지 않았습니다. 입력 크기를 지정하거나 fit 을 먼저 실행하세요")
                return
            self.build()
        line = "─" * 62
        print(f'Model: "{self.name}"'); print(line)
        print(f"{'Layer (type)':<28}{'Output Shape':<20}{'Param #':>12}"); print(line)
        n = int(np.prod(self._input))
        for l in self.layers:
            if isinstance(l, Dense):
                n = l.units
            print(f"{l.name + ' (' + type(l).__name__ + ')':<28}{str((None, n)):<20}{l.count_params():>12,}")
        print(line); print(f"Total params: {self.count_params():,}"); print(line)

    def save(self, filepath, **kw):
        with open(filepath, "wb") as f:
            pickle.dump(self, f)

    def save_weights(self, filepath, **kw):
        with open(filepath, "wb") as f:
            pickle.dump(self.get_weights(), f)

    def load_weights(self, filepath, **kw):
        with open(filepath, "rb") as f:
            self.set_weights(pickle.load(f))


Model = Sequential


def _fingerprint(a):
    """배열 지문: 모양과 float64 값 바이트의 SHA-256 (값이나 순서가 하나라도 바뀌면 달라짐)"""
    import hashlib
    try:
        v = np.ascontiguousarray(np.asarray(getattr(a, "values", a), dtype=np.float64))
    except Exception:
        return None
    return [list(v.shape), hashlib.sha256(v.tobytes()).hexdigest()]


def _weights_fp(model):
    """모델 가중치 지문 (층 순서대로 모양과 값)"""
    import hashlib
    h = hashlib.sha256()
    try:
        ws = model.get_weights()
    except Exception:
        return None
    for w in ws:
        w = np.ascontiguousarray(np.asarray(w, dtype=np.float64))
        h.update(str(w.shape).encode()); h.update(w.tobytes())
    return h.hexdigest()


def _model_fp(model):
    """모델 동일성 지문: 입력 크기, 층 종류와 순서, 층별 설정(이름 제외 스칼라 속성, 활성화 함수 포함), 가중치 모양과 값"""
    import hashlib, json as _json
    layers = []
    for l in getattr(model, "layers", []):
        cfg = {}
        for k2, v2 in sorted(vars(l).items()):
            if k2 in ("name",) or k2.startswith("_") and k2 not in ("_input",):
                continue
            if v2 is None or isinstance(v2, (bool, int, float, str)):
                cfg[k2] = v2
            elif isinstance(v2, (tuple, list)) and all(isinstance(x, (int, float, str, type(None))) for x in v2):
                cfg[k2] = list(v2)
            elif callable(v2):
                cfg[k2] = getattr(v2, "__name__", type(v2).__name__)
        layers.append([type(l).__name__, cfg])
    inp = getattr(model, "_input", None)
    head = _json.dumps({"input": list(inp) if inp is not None else None, "layers": layers}, sort_keys=True, default=str)
    return hashlib.sha256((head + "|" + str(_weights_fp(model))).encode()).hexdigest()


def load_model(filepath, **kw):
    with open(filepath, "rb") as f:
        return pickle.load(f)


def to_categorical(y, num_classes=None, dtype="float32"):
    y = np.asarray(_arr(y, np.int64)).reshape(-1)
    n = num_classes or int(y.max()) + 1
    out = np.zeros((len(y), n), dtype=dtype); out[np.arange(len(y)), y] = 1
    return out


def clear_session(*a, **k):
    Layer._count.clear()
`,
  "tensorflow/__init__.py": String.raw`from _acf_keras import __version__, ACF_SHIM
from tensorflow import keras, random
from tensorflow.keras import optimizers, losses, metrics, layers, models, callbacks, utils
`,
  "tensorflow/random.py": String.raw`from _acf_keras import set_random_seed as set_seed
`,
  "tensorflow/keras/__init__.py": String.raw`from _acf_keras import Sequential, Model, Input
from tensorflow.keras import layers, models, callbacks, optimizers, losses, metrics, utils, backend
`,
  "tensorflow/keras/layers.py": String.raw`from _acf_keras import Dense, Dropout, Flatten, Activation, BatchNormalization, InputLayer, Input, Layer
`,
  "tensorflow/keras/models.py": String.raw`from _acf_keras import Sequential, Model, load_model
`,
  "tensorflow/keras/callbacks.py": String.raw`from _acf_keras import Callback, EarlyStopping, ModelCheckpoint, ReduceLROnPlateau, History
`,
  "tensorflow/keras/optimizers.py": String.raw`from _acf_keras import Adam, SGD, RMSprop, Optimizer
`,
  "tensorflow/keras/losses.py": String.raw`BinaryCrossentropy = 'binary_crossentropy'
CategoricalCrossentropy = 'categorical_crossentropy'
SparseCategoricalCrossentropy = 'sparse_categorical_crossentropy'
MeanSquaredError = 'mse'
MeanAbsoluteError = 'mae'
`,
  "tensorflow/keras/metrics.py": String.raw`Accuracy = 'accuracy'
MeanAbsoluteError = 'mae'
MeanSquaredError = 'mse'
`,
  "tensorflow/keras/utils.py": String.raw`from _acf_keras import to_categorical, set_random_seed
`,
  "tensorflow/keras/backend.py": String.raw`from _acf_keras import clear_session
`,
  "keras/__init__.py": String.raw`from _acf_keras import Sequential, Model, Input
from keras import layers, models, callbacks, optimizers, losses, metrics, utils, backend
from _acf_keras import __version__
`,
  "keras/layers.py": String.raw`from _acf_keras import Dense, Dropout, Flatten, Activation, BatchNormalization, InputLayer, Input, Layer
`,
  "keras/models.py": String.raw`from _acf_keras import Sequential, Model, load_model
`,
  "keras/callbacks.py": String.raw`from _acf_keras import Callback, EarlyStopping, ModelCheckpoint, ReduceLROnPlateau, History
`,
  "keras/optimizers.py": String.raw`from _acf_keras import Adam, SGD, RMSprop, Optimizer
`,
  "keras/losses.py": String.raw`BinaryCrossentropy = 'binary_crossentropy'
CategoricalCrossentropy = 'categorical_crossentropy'
SparseCategoricalCrossentropy = 'sparse_categorical_crossentropy'
MeanSquaredError = 'mse'
MeanAbsoluteError = 'mae'
`,
  "keras/metrics.py": String.raw`Accuracy = 'accuracy'
MeanAbsoluteError = 'mae'
MeanSquaredError = 'mse'
`,
  "keras/utils.py": String.raw`from _acf_keras import to_categorical, set_random_seed
`,
  "keras/backend.py": String.raw`from _acf_keras import clear_session
`,
};
/** Pyodide 인스턴스에 Keras 호환 모듈 설치 (import tensorflow, import keras 가능) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installTfShim(py: any): void {
  for (const [p, src] of Object.entries(TF_SHIM_FILES)) { const full = `${TF_SHIM_DIR}/${p}`; py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/'))); py.FS.writeFile(full, src); }
  py.runPython(`import sys\nif ${JSON.stringify(TF_SHIM_DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(TF_SHIM_DIR)})`);
}
