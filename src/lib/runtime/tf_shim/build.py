"""_acf_keras.py 와 패키지 래퍼로 ../tf-shim.ts 를 생성한다. 실행: python3 build.py (이 폴더에서)"""
import pathlib, json
here = pathlib.Path(__file__).parent
core = (here / "_acf_keras.py").read_text()
R = "from _acf_keras import "
files = {
 "_acf_keras.py": core,
 "tensorflow/__init__.py": "from _acf_keras import __version__, ACF_SHIM\nfrom tensorflow import keras, random\nfrom tensorflow.keras import optimizers, losses, metrics, layers, models, callbacks, utils\n",
 "tensorflow/random.py": "from _acf_keras import set_random_seed as set_seed\n",
 "tensorflow/keras/__init__.py": "from _acf_keras import Sequential, Model, Input\nfrom tensorflow.keras import layers, models, callbacks, optimizers, losses, metrics, utils, backend\n",
 "tensorflow/keras/layers.py": R + "Dense, Dropout, Flatten, Activation, BatchNormalization, InputLayer, Input, Layer\n",
 "tensorflow/keras/models.py": R + "Sequential, Model, load_model\n",
 "tensorflow/keras/callbacks.py": R + "Callback, EarlyStopping, ModelCheckpoint, ReduceLROnPlateau, History\n",
 "tensorflow/keras/optimizers.py": R + "Adam, SGD, RMSprop, Optimizer\n",
 "tensorflow/keras/losses.py": "BinaryCrossentropy = 'binary_crossentropy'\nCategoricalCrossentropy = 'categorical_crossentropy'\nSparseCategoricalCrossentropy = 'sparse_categorical_crossentropy'\nMeanSquaredError = 'mse'\nMeanAbsoluteError = 'mae'\n",
 "tensorflow/keras/metrics.py": "Accuracy = 'accuracy'\nMeanAbsoluteError = 'mae'\nMeanSquaredError = 'mse'\n",
 "tensorflow/keras/utils.py": R + "to_categorical, set_random_seed\n",
 "tensorflow/keras/backend.py": R + "clear_session\n",
}
for k in list(files):
    if k.startswith("tensorflow/keras/"):
        files["keras/" + k[len("tensorflow/keras/"):]] = files[k].replace("from tensorflow.keras import", "from keras import")
files["keras/__init__.py"] += "from _acf_keras import __version__\n"
for k, v in files.items():
    assert "`" not in v and "${" not in v, k
ts = ("// 브라우저 딥러닝 실습용 Keras 호환 모듈 (numpy). 원본 tf_shim/_acf_keras.py, 생성 tf_shim/build.py\n"
      "export const TF_SHIM_DIR = '/lib/acf_shims';\n"
      "export const TF_SHIM_FILES: Record<string, string> = {\n"
      + "".join(f"  {json.dumps(k)}: String.raw`{v}`,\n" for k, v in files.items()) + "};\n"
      "/** Pyodide 인스턴스에 Keras 호환 모듈 설치 (import tensorflow, import keras 가능) */\n"
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any\n"
      "export function installTfShim(py: any): void {\n"
      "  for (const [p, src] of Object.entries(TF_SHIM_FILES)) { const full = `${TF_SHIM_DIR}/${p}`; py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/'))); py.FS.writeFile(full, src); }\n"
      "  py.runPython(`import sys\\nif ${JSON.stringify(TF_SHIM_DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(TF_SHIM_DIR)})`);\n"
      "}\n")
(here.parent / "tf-shim.ts").write_text(ts)
print(len(files), "files")
