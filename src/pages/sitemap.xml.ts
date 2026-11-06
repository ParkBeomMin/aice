import type { APIRoute } from 'astro';
import { getManifests, isProduction } from '../lib/content';
import { pageUrl } from '../lib/paths';
import { getDecks } from '../lib/cards';

// GitHub Pages 프로젝트 사이트는 호스트 루트 robots.txt 를 둘 수 없으므로 sitemap 은 Search Console 에 직접 제출한다.
// preview 빌드는 빈 sitemap.
export const GET: APIRoute = ({ site }) => {
  const paths: string[] = [];
  if (isProduction) {
    paths.push(pageUrl(), pageUrl('exams'), pageUrl('about'), pageUrl('guide'), pageUrl('privacy'), pageUrl('contact'));
    const decks = getDecks().filter((d) => d.publication_status === 'approved');
    if (decks.length) paths.push(pageUrl('cards'));
    for (const d of decks) paths.push(pageUrl('cards', d.deck_id)); // 학습, 복습 화면은 제외 (noindex)
    for (const m of getManifests()) {
      paths.push(pageUrl('exams', m.pack_id));
      for (const q of m.questions) paths.push(pageUrl('exams', m.pack_id, q.question_id));
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
    .map((p) => `  <url><loc>${new URL(p, site).toString()}</loc></url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
