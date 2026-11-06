// GitHub Pages 프로젝트 사이트: https://parkbeommin.github.io/<repo>/
// 저장소 이름은 PUBLIC_REPO_NAME 으로 주입 (CI 에서는 github.event.repository.name).
import { defineConfig } from 'astro/config';

const repo = process.env.PUBLIC_REPO_NAME;
if (!repo || !/^[A-Za-z0-9._-]+$/.test(repo)) {
  throw new Error('PUBLIC_REPO_NAME must be set to a valid GitHub repository name (e.g. "aice")');
}

export default defineConfig({
  site: 'https://parkbeommin.github.io',
  base: `/${repo}`,
  trailingSlash: 'always',
  output: 'static',
  build: { format: 'directory' },
  // Aside 샌드박스 전용(ACF_SANDBOX_BUILD=1): 서명 안 된 네이티브 모듈(lightningcss) 로드 불가 → CSS minify 끔. CI(Linux)·일반 Mac 은 기본값
  vite: process.env.ACF_SANDBOX_BUILD === '1' ? { build: { cssMinify: false } } : {},
});
