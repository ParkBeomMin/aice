// 사이트 운영 설정 (T-07A). 광고는 production 빌드 + PUBLIC_ADS_ENABLED=1 + 게시자 ID 가 있을 때만, 허용된 페이지 유형에서만.
import { isProduction } from './content';

export const SITE_NAME = 'AICE 실전 모의고사';
export const CONTACT_URL = 'https://github.com/ParkBeomMin/aice/issues';
export const ADSENSE_CLIENT = (import.meta.env.PUBLIC_ADSENSE_CLIENT ?? '') as string;
/** 광고는 기본 OFF. 켜려면 게시자 ID + PUBLIC_ADS_ENABLED=1 + PUBLIC_ADS_CMP_READY=1 (EEA, UK, 스위스 대상 Google 인증 CMP 설정을 운영자가 확인) 모두 필요 */
export const ADS_ENABLED = isProduction && import.meta.env.PUBLIC_ADS_ENABLED === '1' && import.meta.env.PUBLIC_ADS_CMP_READY === '1' && /^ca-pub-\d{10,20}$/.test(ADSENSE_CLIENT);
export const OPERATOR = 'ParkBeomMin (GitHub)';
/** 정책 시행일 (공개 시 CI 변수로 지정). 없으면 '공개 전 초안' */
export const POLICY_DATE = (import.meta.env.PUBLIC_POLICY_DATE ?? '') as string;

/** 광고를 둘 수 있는 페이지 유형: 학습 콘텐츠(홈, 목록, 회차 소개, 문제 해설)만. 풀이, 실전, 결과, 정책, 404 는 금지 */
export type PageKind = 'home' | 'list' | 'pack' | 'question' | 'practice' | 'exam' | 'result' | 'policy' | 'error'
  | 'cardlist' | 'carddeck' | 'cardstudy' | 'cardreview'; // T-07D 개념 카드: 목록, 덱 소개만 광고 후보, 학습, 복습 화면은 금지
export const AD_PAGE_KINDS: PageKind[] = ['home', 'list', 'pack', 'question', 'cardlist', 'carddeck'];
export const adsAllowed = (kind: PageKind) => ADS_ENABLED && AD_PAGE_KINDS.includes(kind);
