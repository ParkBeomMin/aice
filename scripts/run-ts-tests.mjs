// 비공개 모노레포 전용 TS 단위 테스트 실행기 (tests-ts 는 공개 저장소로 export 되지 않음).
// Node 22.18+/23.6+ 는 타입 스트리핑 기본, 그 이전 22.6+ 는 --experimental-strip-types 를 붙인다. 22.6 미만은 지원하지 않음.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
const [maj, min] = process.versions.node.split('.').map(Number);
const native = maj > 23 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18);
if (!native && !(maj === 22 && min >= 6) && maj !== 23) { console.error(`Node ${process.versions.node}: TS 테스트에는 Node 22.6 이상 필요`); process.exit(2); }
const dir = new URL('../tests-ts/', import.meta.url).pathname;
if (!existsSync(dir)) { console.log('tests-ts 없음 (공개 저장소) — 건너뜀'); process.exit(0); }
const files = (process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => dir + f));
const r = spawnSync(process.execPath, [...(native ? [] : ['--experimental-strip-types', '--no-warnings']), '--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
