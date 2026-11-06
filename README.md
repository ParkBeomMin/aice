# AICE 실전 모의고사

AICE Associate 시험을 준비하는 사람을 위한 무료 실전 모의고사와 개념 카드 사이트예요.
설치 없이 브라우저에서 바로 Python 코드를 실행하고, 제출하면 자동으로 채점돼요.

**사이트 바로가기: https://parkbeommin.github.io/aice/**

> 이 사이트는 AICE 시험 주관사와 관련 없는 개인 학습 프로젝트예요. 실제 시험 문항을 복제하지 않고, 직접 만든 문제와 합성 데이터만 사용해요. 채점 결과는 자체 연습용이며 공식 점수나 합격 여부와 관계없어요.

## 무엇을 할 수 있나요

| 기능 | 설명 |
|---|---|
| 실전 모드 | 90분 타이머를 켜고 14문항을 실제 시험처럼 풀어요. 시간이 끝나면 마지막 코드가 자동으로 제출돼요. |
| 연습 모드 | 시간 제한 없이 셀 단위로 코드를 작성하고 실행해요. 원할 때 연습 채점을 받아볼 수 있어요. |
| 자동 채점 | 제출한 코드를 새 Python 환경에서 처음부터 다시 실행해 결과로 채점해요. 코드 모양이 달라도 결과가 같으면 정답이에요. 문항마다 어떤 검사를 통과했는지 피드백을 보여줘요. |
| 해설과 정답 코드 | 문항별 해설 페이지에서 풀이 방법과 정답 예시 코드를 볼 수 있어요. |
| 개념 카드 | 7개 주제, 54장의 카드로 핵심 개념을 익혀요. 질문을 보고 떠올린 뒤 뒤집어서 정답과 참고 코드를 확인해요. |
| 오답 복습 | 채점 결과에서 틀린 문항과 연결된 개념 카드를 모아 바로 복습할 수 있어요. |
| 노트북 내려받기 | 내가 푼 코드를 .ipynb 파일로 내려받아 Jupyter나 Colab에서 이어서 풀 수 있어요. |

## 공개 중인 콘텐츠

- **모의고사 1회차: 온라인 교육 수강생 이탈 예측**
  14문항, 제한시간 90분. 수강생 1,400명의 합성 데이터로 데이터 탐색, 전처리, 모델 학습, 평가까지 다뤄요.
- **개념 카드 7개 덱 (54장)**
  Python과 Pandas 기초, 데이터 탐색과 통계, 데이터 전처리, 데이터 시각화, 머신러닝 모델링, 모델 평가 지표, 딥러닝 기초

## 어떻게 동작하나요

- **서버가 없어요.** GitHub Pages에 올린 정적 사이트예요.
- **Python은 브라우저 안에서 실행돼요.** [Pyodide](https://pyodide.org)(WebAssembly 버전 Python)를 Web Worker에서 실행해요. 처음 한 번 실행 환경(수십 MB)을 내려받아요.
- **채점도 브라우저 안에서 해요.** 풀이 환경과 분리된 별도 Worker에서 제출 코드를 다시 실행하고, 미리 정해 둔 검사 항목만 확인해요.
- **기록은 내 브라우저에만 저장돼요.** 작성한 코드, 시험 기록, 채점 결과, 개념 카드 학습 기록은 IndexedDB에만 저장되고 외부로 보내지 않아요. 브라우저 데이터를 지우면 함께 사라져요.

권장 환경은 PC의 최신 Chrome, Edge, Firefox, Safari예요.

## 개인정보

회원 가입이나 로그인이 없고, 운영자가 따로 운영하는 서버도 없어요. 자세한 내용은 [개인정보처리방침](https://parkbeommin.github.io/aice/privacy/)을 확인해 주세요.

## 라이선스

- **개념 카드와 모의고사 합성 데이터셋**: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ko)
  다른 곳에 쓸 때는 출처(ParkBeomMin, AICE 실전 모의고사)를 밝혀 주세요.
- **사이트 코드와 디자인**: 별도 라이선스를 두지 않았어요 (모든 권리 보유).

## 문의

문제 오류, 채점 이의, 사이트 버그는 [GitHub Issues](https://github.com/ParkBeomMin/aice/issues)에 남겨 주세요.
이슈는 누구나 볼 수 있는 공개 게시물이니 이름, 이메일 같은 개인정보는 적지 마세요.

---

## 개발자용 안내

### 저장소 구성

| 경로 | 내용 |
|---|---|
| `src/pages` | Astro 페이지 (모의고사, 개념 카드, 이용 안내, 개인정보처리방침 등) |
| `src/scripts`, `src/lib` | 노트북 실행, 실전 모드, 채점, 개념 카드 학습 로직 |
| `src/data/generated` | 공개 콘텐츠 번들 (직접 수정하지 않음) |
| `public/content` | 데이터셋, 문제 노트북, 공개 채점 규칙 |
| `policy` | 공개 파일 정책과 공개 스키마 (CI 검증에 사용) |
| `scripts` | 콘텐츠 무결성 검사, 빌드 결과 검사 |

`src/data/generated`와 `public/content`는 비공개 원본 저장소의 콘텐츠 파이프라인이 만든 결과물이에요. 승인된 콘텐츠만 들어 있고, 파일마다 SHA-256 해시로 무결성을 검사해요. 이 저장소에서 직접 고치지 않아요.

### 로컬에서 실행하기

Node.js 22 이상이 필요해요.

```bash
npm ci
PUBLIC_REPO_NAME=aice npm run dev            # 개발 서버
PUBLIC_REPO_NAME=aice npm run build          # 정적 빌드 (dist/)
npm run verify:content                       # 공개 콘텐츠 무결성 검사
PUBLIC_REPO_NAME=aice npm run verify:dist    # 링크, noindex, 광고 정책 검사
```

### 배포

`main` 브랜치에 push하면 GitHub Actions가 자동으로 배포해요.

1. `npm ci`
2. `verify-content --production`: 승인된 production 번들만 통과
3. `astro build`
4. `check-dist`: 모든 링크가 `/aice/` 아래인지, 풀이와 결과 화면이 noindex인지, 광고 정책을 지키는지 검사
5. GitHub Pages 배포

저장소 Variables로 바꿀 수 있는 값이에요. 광고는 기본으로 꺼져 있어요.

| 변수 | 설명 |
|---|---|
| `POLICY_DATE` | 개인정보처리방침 시행일 (YYYY-MM-DD) |
| `ADS_ENABLED` | `1`이면 광고 사용 (아래 두 값도 필요) |
| `ADSENSE_CLIENT` | AdSense 게시자 ID |
| `ADS_CMP_READY` | EEA, 영국, 스위스용 Google 인증 동의 관리 설정을 마쳤을 때만 `1` |

광고를 켜도 풀이, 실전, 채점 결과, 개념 카드 학습 화면에는 광고를 넣지 않아요. `ads.txt`는 호스트 루트(`parkbeommin.github.io`)에 있는 파일을 그대로 사용해요.

### 이전 공부 노트

이 저장소에 있던 공부용 노트북(01~03.ipynb, Clean_Dataset.csv)은 [`archive/study-notebooks`](https://github.com/ParkBeomMin/aice/tree/archive/study-notebooks) 브랜치에 보관했어요.
