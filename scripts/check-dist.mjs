// 빌드 산출물 검사: 모든 내부 링크·리소스가 base(/<repo>/) 를 포함하는지, 필수 페이지 존재, preview 는 noindex.
// 사용: PUBLIC_REPO_NAME=aice node scripts/check-dist.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.PUBLIC_REPO_NAME;
if (!repo) { console.error('PUBLIC_REPO_NAME 필요'); process.exit(2); }
const base = `/${repo}/`;
const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const gen = join(root, 'src/data/generated');
const bank = JSON.parse(readFileSync(join(gen, 'bank-index.json'), 'utf8'));
const errors = [];
const must = ['index.html', 'exams/index.html', 'sitemap.xml', '404.html', 'about/index.html', 'guide/index.html', 'privacy/index.html', 'contact/index.html'];
for (const p of bank.packs) {
  must.push(`exams/${p.pack_id}/index.html`);
  const m = JSON.parse(readFileSync(join(gen, p.manifest_file), 'utf8'));
  for (const q of m.questions) must.push(`exams/${p.pack_id}/${q.question_id}/index.html`);
  for (const d of m.datasets) must.push(d.url_path);
  must.push(`exams/${p.pack_id}/practice/index.html`, m.notebook.url_path);
  must.push(`exams/${p.pack_id}/exam/index.html`, `exams/${p.pack_id}/result/index.html`);
  if (m.grading) must.push(m.grading.url_path);
}
// 개념 카드 (T-07D): 산출물이 있으면 목록·덱·학습·복습 페이지 필수
const cardsIdx = join(gen, 'cards/index.json');
const cards = existsSync(cardsIdx) ? JSON.parse(readFileSync(cardsIdx, 'utf8')) : { decks: [] };
if (cards.decks.length) {
  must.push('cards/index.html', 'cards/review/index.html');
  for (const d of cards.decks) must.push(`cards/${d.deck_id}/index.html`, `cards/${d.deck_id}/study/index.html`);
}
const AD_KINDS = ['home', 'list', 'pack', 'question', 'cardlist', 'carddeck'];
const NOINDEX_RE = /^(exams\/[^/]+\/(exam|result|practice)|cards\/(review|[^/]+\/study))\//;
for (const f of must) if (!existsSync(join(dist, f))) errors.push(`dist/${f} 없음`);

const htmls = [];
// Search Console 소유권 확인 파일(google<hex>.html, 루트)은 사이트 페이지가 아니라 검사 제외
const isVerifyFile = (p) => /^google[0-9a-f]{16}\.html$/.test(p.slice(dist.length + 1));
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.endsWith('.html') && !isVerifyFile(p) && htmls.push(p); } })(dist);
let links = 0;
for (const h of htmls) {
  const html = readFileSync(h, 'utf8');
  const rel = h.slice(dist.length + 1);
  for (const [, attr, url] of html.matchAll(/\s(href|src|data-notebook-url)="([^"]*)"/g)) {
    if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
    links++;
    if (!url.startsWith(base)) { errors.push(`${rel}: ${attr}="${url}" 가 base ${base} 로 시작하지 않음`); continue; }
    const target = url.slice(base.length).split('#')[0].split('?')[0];
    const file = target === '' || target.endsWith('/') ? join(dist, target, 'index.html') : join(dist, target);
    if (!existsSync(file)) errors.push(`${rel}: 깨진 내부 링크 ${url}`);
  }
  // 광고 정책 (T-07A): 풀이·실전·결과·정책·404 페이지에는 광고 스크립트 금지, 허용 페이지도 ADS 활성 빌드에서만
  const kind = (html.match(/data-page-kind="([a-z]+)"/) || [])[1];
  const hasAd = /adsbygoogle|pagead2\.googlesyndication/.test(html);
  if (!kind) errors.push(`${rel}: data-page-kind 없음`);
  if (hasAd && !AD_KINDS.includes(kind)) errors.push(`${rel}: ${kind} 페이지에 광고 스크립트 (금지)`);
  if (html.includes('\u2014')) errors.push(`${rel}: em dash 문자 사용 금지`);
  if (html.includes('\u00b7')) errors.push(`${rel}: 가운뎃점(·) 사용 금지`);
  if (hasAd && bank.mode !== 'production') errors.push(`${rel}: preview 빌드에 광고 스크립트`);
  if (hasAd !== html.includes('data-ads="1"')) errors.push(`${rel}: 광고 표시 플래그와 스크립트 불일치`);
  if (process.env.EXPECT_ADS === '1' && AD_KINDS.includes(kind) && !hasAd) errors.push(`${rel}: 광고 허용 페이지인데 스크립트 없음 (EXPECT_ADS=1)`);
  if (bank.mode === 'production' && /data-acf-debug=/.test(html)) errors.push(`${rel}: production 에 디버그 훅 표시`);
  if (rel === '404.html' || NOINDEX_RE.test(rel)) { if (!html.includes('name="robots" content="noindex')) errors.push(`${rel}: noindex 필요`); }
  if (bank.mode === 'production' && rel === 'privacy/index.html') {
    const d = (html.match(/data-policy-date="([^"]*)"/) || [])[1] || '';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d; // 2026-02-30 같은 없는 날짜 거부
    if (!valid) errors.push('privacy: production 에는 실제 존재하는 시행일(POLICY_DATE=YYYY-MM-DD) 필수');
  }
  const canon = html.match(/<link rel="canonical" href="([^"]+)"/);
  if (!canon || !canon[1].startsWith(`https://parkbeommin.github.io${base}`)) errors.push(`${rel}: canonical 누락 또는 base 불일치`);
  const noindex = html.includes('name="robots" content="noindex');
  if (bank.mode !== 'production' && !noindex) errors.push(`${rel}: preview 인데 noindex 없음`);
  const emptyCards = !cards.decks.length && rel === 'cards/index.html'; // 승인된 덱이 없으면 준비 중 안내만 (noindex)
  if (bank.mode === 'production' && noindex && !(rel === '404.html' || NOINDEX_RE.test(rel) || emptyCards)) errors.push(`${rel}: production 인데 noindex 있음`);
}
if (errors.length) { for (const e of errors) console.error(`[ERROR] ${e}`); process.exit(2); }
console.log(`dist OK: ${htmls.length} pages, ${links} internal links/resources under ${base}, mode=${bank.mode}`);
