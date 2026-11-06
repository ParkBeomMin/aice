// T-05/T-06 에서 구현할 노트북 런타임 경계. T-04 에서는 타입만 정의한다.
export type CellType = 'markdown' | 'code';
export type ExecutionStatus = 'idle' | 'queued' | 'running' | 'ok' | 'error' | 'interrupted';

export interface CellOutput {
  kind: 'stream' | 'result' | 'error' | 'display';
  text?: string;          // stdout/stderr/repr
  html?: string;          // 표 등 (sanitize 후)
  imagePng?: string;      // base64 (matplotlib)
}

export interface CellState {
  cellId: string;         // 노트북 cell.id (예: q04-attempt)
  questionId: string | null;
  cellType: CellType;
  source: string;
  executionStatus: ExecutionStatus;
  executionCount: number | null;
  outputs: CellOutput[];
}

export interface NotebookState {
  packId: string;
  contentFingerprint: string; // manifest.notebook.sha256 — 개정판이 바뀌면 초안을 덮어쓰지 않기 위한 키
  cells: CellState[];
}

export interface KernelAdapter {
  initialize(): Promise<void>;                       // Pyodide 로드 + 데이터셋을 가상 FS 에 적재
  executeCell(cellId: string, code: string): Promise<CellOutput[]>;
  restartKernel(): Promise<void>;
  dispose(): void;
}

export interface StorageAdapter {
  saveDraft(state: NotebookState): Promise<void>;    // IndexedDB (회차 + fingerprint 별)
  loadDraft(packId: string, fingerprint: string): Promise<NotebookState | null>;
  exportNotebook(state: NotebookState): Blob;        // nbformat 4.5 .ipynb
  clearDraft(packId: string, fingerprint: string): Promise<void>;
}
