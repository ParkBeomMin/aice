// 공개 번들 검사 (CI). Python `acf content verify` 와 같은 정책 파일(policy/public-files.policy.json)·같은 규칙.
// 사용: node scripts/verify-content.mjs [--production] [--root DIR]
//  - bank-index → manifest → 문항/데이터셋 SHA-256
//  - 실제 파일 집합 == manifest 허용 집합 (+ public_dir_allowlist)
//  - 금지 확장자/이름, 비밀키 패턴, 심볼릭 링크, 최대 크기
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const args = process.argv.slice(2);
const production = args.includes('--production');
const ri = args.indexOf('--root');
const root = ri >= 0 ? args[ri + 1] : fileURLToPath(new URL('..', import.meta.url));
const policyPath = process.env.ACF_POLICY_PATH || join(root, 'policy/public-files.policy.json');
const pol = JSON.parse(readFileSync(policyPath, 'utf8'));
const secretRes = pol.secret_patterns.map((p) => new RegExp(p));
const gen = join(root, pol.generated_dir);
const pub = join(root, 'public');
const errors = [];
// 공개 스키마 (정본 content/schemas 의 사본, acf content build 가 배치) — 해시가 맞아도 스키마 위반이면 차단 (FIX-D)
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = {};
for (const n of pol.public_schemas) {
  const sp = join(root, pol.public_schema_dir, `${n}.schema.json`);
  if (!existsSync(sp)) { console.error(`[ERROR] ${pol.public_schema_dir}/${n}.schema.json 없음`); process.exit(2); }
  validators[n] = ajv.compile(JSON.parse(readFileSync(sp, 'utf8')));
}
const schemaErrs = (name, data, label) => (validators[name](data) ? [] : validators[name].errors.map((e) => `${label} ${e.instancePath || '/'}: ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const posix = (p) => p.split(sep).join('/');
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$');
const allowGlobs = pol.public_dir_allowlist.map(globToRe);

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push({ p, link: true });
      else if (st.isDirectory()) walk(p);
      else out.push({ p, link: false, size: st.size });
    }
  })(dir);
  return out;
}

const bankPath = join(gen, 'bank-index.json');
if (!existsSync(bankPath)) { console.error('[ERROR] bank-index.json 없음'); process.exit(2); }
const bank = JSON.parse(readFileSync(bankPath, 'utf8'));
const bankErrs = schemaErrs('public-bank', bank, 'bank-index.json');
if (bankErrs.length) { for (const e of bankErrs) console.error(`[ERROR] ${e}`); process.exit(2); }
if (production && bank.mode !== 'production') errors.push('운영 배포에는 production 번들만 허용 (현재 preview/mock 포함)');
if (!Array.isArray(bank.packs) || bank.packs.length === 0) errors.push('공개 팩이 없음');
const allowedGen = new Set(['bank-index.json']);
const allowedPub = new Set();
const allowedNb = new Set();
const NB = pol.notebook;
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const promptMd = (q) => NB.prompt_template.replace('{n}', q.question_id.slice(1)).replace('{title}', q.title).replace('{prompt}', q.prompt);
function validateNotebook(buf, m, qdocs) {
  const nbm = m.notebook; const label = nbm.url_path; const out = [];
  let nb;
  try { nb = JSON.parse(buf.toString('utf8')); } catch (e) { return [`${label}: JSON 아님`]; }
  if (!nb || nb.nbformat !== NB.nbformat || nb.nbformat_minor !== NB.nbformat_minor) return [`${label}: nbformat ${NB.nbformat}.${NB.nbformat_minor} 아님`];
  const top = Object.keys(nb).sort();
  if (!sameJson(top, ['cells', 'metadata', 'nbformat', 'nbformat_minor'])) out.push(`${label}: 허용되지 않은 최상위 키`);
  const md = nb.metadata;
  if (!md || typeof md !== 'object' || Object.keys(md).some((k) => !NB.allowed_metadata_keys.includes(k))) out.push(`${label}: 허용되지 않은 metadata 키`);
  else if (!sameJson(md.acf_public, { pack_id: m.pack_id, kind: 'question_notebook' })) out.push(`${label}: metadata.acf_public 불일치`);
  const qids = m.questions.map((q) => q.question_id);
  if (!sameJson(nbm.question_ids, qids)) out.push(`${label}: notebook.question_ids 가 manifest 문항 순서와 다름`);
  const expected = NB.fixed_cells.map((t) => [t, 'markdown']);
  for (const qid of nbm.question_ids) expected.push([`${qid}-prompt`, 'markdown'], [`${qid}-attempt`, 'code']);
  if (!Array.isArray(nb.cells) || nb.cells.length !== expected.length) return [...out, `${label}: 셀 수 ${Array.isArray(nb.cells) ? nb.cells.length : '?'} != 기대 ${expected.length}`];
  nb.cells.forEach((c, i) => {
    const [tag, ctype] = expected[i]; const where = `${label} cells[${i}]`;
    if (!c || typeof c !== 'object') { out.push(`${where}: 객체 아님`); return; }
    const keys = ctype === 'code' ? NB.code_keys : NB.markdown_keys;
    if (!sameJson(Object.keys(c).sort(), [...keys].sort())) out.push(`${where}: 허용되지 않은 셀 키 ${JSON.stringify(Object.keys(c).sort())}`);
    if (c.cell_type !== ctype || c.id !== tag || !sameJson(c.metadata, { tags: [tag] })) { out.push(`${where}: 셀 타입/ID/태그 불일치 (기대 ${ctype} ${tag})`); return; }
    if (typeof c.source !== 'string') { out.push(`${where}: source 는 문자열이어야 함`); return; }
    const qid = tag.split('-')[0];
    if (ctype === 'code') {
      if (c.execution_count !== null || !sameJson(c.outputs, [])) out.push(`${where}: 실행 결과/번호가 남아 있음`);
      if (qdocs[qid] && c.source !== qdocs[qid].starter_code) out.push(`${where}: 코드 셀이 공개 starter_code 와 다름 (정답 유출 가능성)`);
    } else if (tag.endsWith('-prompt') && qdocs[qid] && c.source !== promptMd(qdocs[qid])) out.push(`${where}: 문제 설명이 공개 문항 JSON 과 다름`);
  });
  return out;
}
function validateGrading(buf, m, qdocs) {
  const g = m.grading; const label = g.url_path; const out = [];
  let b;
  try { b = JSON.parse(buf.toString('utf8')); } catch { return [`${label}: JSON 아님`]; }
  const sErrs = schemaErrs('public-grading-profile', b, label);
  if (sErrs.length) return sErrs;
  if (b.pack_id !== m.pack_id || b.engine_version !== g.engine_version || b.grading_version !== g.grading_version) out.push(`${label}: pack_id/engine_version/grading_version 가 manifest 와 다름`);
  if (b.engine_version !== pol.grading.engine_version) out.push(`${label}: 지원하지 않는 채점 엔진 버전 ${b.engine_version}`);
  if (!sameJson(Object.keys(b.questions).sort(), [...g.question_ids].sort())) out.push(`${label}: 문항 목록이 manifest.grading.question_ids 와 다름`);
  const mq = m.questions.map((q) => q.question_id);
  for (const [qid, pq] of Object.entries(b.questions)) {
    if (!mq.includes(qid) || pq.question_id !== qid) { out.push(`${label}: manifest 에 없는 문항 ${qid}`); continue; }
    const qd = qdocs[qid];
    if (qd && (qd.grading.type !== 'result_assertions' || qd.grading.profile !== pq.profile || qd.runtime.type !== 'pyodide')) out.push(`${label}: ${qid} 프로필이 공개 문항 grading/runtime 과 맞지 않음`);
    for (const d of pq.depends_on) if (!mq.includes(d) || mq.indexOf(d) >= mq.indexOf(qid)) out.push(`${label}: ${qid}.depends_on ${d} 가 앞선 문항이 아님`);
    if (m.mode === 'production' && pq.review_status !== 'approved') out.push(`${label}: production 에는 approved 프로필만 허용 (${qid})`);
  }
  return out;
}
for (const p of bank.packs ?? []) {
  if (p.manifest_file !== `${p.pack_id}/manifest.json`) { errors.push(`${p.pack_id}: manifest_file 경로 규칙 위반`); continue; }
  allowedGen.add(p.manifest_file);
  const mp = join(gen, p.manifest_file);
  if (!existsSync(mp)) { errors.push(`${p.manifest_file} 없음`); continue; }
  if (sha(mp) !== p.manifest_sha256) errors.push(`${p.manifest_file} 해시 불일치`);
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  if (production && (m.mock || m.mode !== 'production')) errors.push(`${p.pack_id}: mock/preview 팩은 운영 배포 불가`);
  if (m.schema_version !== '1.3.0') { errors.push(`${p.manifest_file}: manifest 계약 ${m.schema_version}, 1.3.0 필요 (acf content build 로 재생성)`); continue; }
  const mErrs = schemaErrs('publish-manifest', m, p.manifest_file);
  if (mErrs.length) { errors.push(...mErrs); continue; }
  if (m.pack_id !== p.pack_id || m.question_count !== m.questions.length) errors.push(`${p.manifest_file}: pack_id/question_count 가 bank-index·문항 목록과 불일치`);
  const qdocs = {};
  for (const q of m.questions ?? []) {
    if (q.file !== `${q.question_id}.json`) { errors.push(`${p.pack_id}: 문항 파일명 규칙 위반 (${q.file})`); continue; }
    allowedGen.add(`${p.pack_id}/${q.file}`);
    const qp = join(gen, p.pack_id, q.file);
    if (!existsSync(qp) || sha(qp) !== q.sha256) errors.push(`${p.pack_id}/${q.file} 없음 또는 해시 불일치`);
    else {
      const qd = JSON.parse(readFileSync(qp, 'utf8'));
      const qErrs = schemaErrs('public-question', qd, `${p.pack_id}/${q.file}`);
      errors.push(...qErrs);
      if (!qErrs.length) {
        if (qd.question_id !== q.question_id || qd.pack_id !== p.pack_id || qd.public_id !== q.public_id || qd.revision !== q.revision || q.public_id !== `${p.pack_id}-${q.question_id}`)
          errors.push(`${p.pack_id}/${q.file}: question_id/pack_id/public_id/revision 가 manifest 와 불일치`);
        qdocs[q.question_id] = qd;
      }
    }
  }
  const nbm = m.notebook;
  if (!nbm || !nbm.url_path.startsWith(`content/${p.pack_id}/notebooks/`) || !new RegExp(NB.name_regex).test(nbm.url_path.split('/').pop())) {
    errors.push(`${p.pack_id}: 노트북 경로/이름 규칙 위반`);
  } else {
    allowedPub.add(nbm.url_path); allowedNb.add(nbm.url_path);
    const fp = join(pub, nbm.url_path);
    if (!existsSync(fp)) errors.push(`${nbm.url_path} 없음`);
    else {
      const b = readFileSync(fp);
      if (createHash('sha256').update(b).digest('hex') !== nbm.sha256 || b.length !== nbm.size_bytes) errors.push(`${nbm.url_path} 해시/크기 불일치`);
      errors.push(...validateNotebook(b, m, qdocs));
    }
  }
  const gm = m.grading;
  if (gm) {
    if (!gm.url_path.startsWith(`content/${p.pack_id}/grading/`) || !new RegExp(pol.grading.name_regex).test(gm.url_path.split('/').pop())) errors.push(`${gm.url_path}: 채점 묶음 경로/이름 규칙 위반`);
    else {
      allowedPub.add(gm.url_path);
      const fp = join(pub, gm.url_path);
      if (!existsSync(fp)) errors.push(`${gm.url_path} 없음`);
      else {
        const b = readFileSync(fp);
        if (createHash('sha256').update(b).digest('hex') !== gm.sha256 || b.length !== gm.size_bytes) errors.push(`${gm.url_path} 해시/크기 불일치`);
        else errors.push(...validateGrading(b, m, qdocs));
      }
    }
  }
  for (const d of m.datasets ?? []) {
    const prefix = `content/${p.pack_id}/datasets/`;
    if (!d.url_path.startsWith(prefix) || d.url_path.slice(prefix.length).includes('/')) { errors.push(`${d.url_path}: 데이터셋 경로 규칙 위반`); continue; }
    allowedPub.add(d.url_path);
    const fp = join(pub, d.url_path);
    if (!existsSync(fp) || sha(fp) !== d.sha256) errors.push(`${d.url_path} 없음 또는 해시 불일치`);
  }
}
// 개념 카드 산출물 (T-07D). Python acf.cards.verify_cards 와 같은 규칙. cards/ 가 없으면 기능 꺼짐.
const CARD_KEYS = ['card_id', 'deck_id', 'front', 'back', 'code_example', 'code_language', 'code_runtime', 'tags', 'difficulty'];
const cardDigest = (c) => createHash('sha256').update(JSON.stringify(Object.fromEntries(CARD_KEYS.map((k) => [k, c[k] ?? null])), null, 2) + '\n').digest('hex').slice(0, 16);
const strs = (o) => (typeof o === 'string' ? [o] : Array.isArray(o) ? o.flatMap(strs) : o && typeof o === 'object' ? Object.values(o).flatMap(strs) : []);
const cardsDir = join(gen, 'cards');
if (existsSync(cardsDir)) {
  const ip = join(cardsDir, 'index.json');
  if (!existsSync(ip)) errors.push('cards/index.json 없음');
  else {
    allowedGen.add('cards/index.json');
    const index = JSON.parse(readFileSync(ip, 'utf8'));
    const ie = schemaErrs('public-cards-index', index, 'cards/index.json');
    errors.push(...ie);
    if (!ie.length) {
      if (production && index.mode !== 'production') errors.push('cards: 운영 배포에는 production 카드 산출물만 허용');
      if (index.mode !== bank.mode) errors.push(`cards: 모드(${index.mode}) 가 문제은행 모드(${bank.mode}) 와 다름`);
      const cardIds = new Set();
      for (const d of index.decks) {
        if (d.file !== `decks/${d.deck_id}.json` || ['review', 'study'].includes(d.deck_id)) { errors.push(`cards/${d.file}: 경로 규칙 위반`); continue; }
        allowedGen.add(`cards/${d.file}`);
        const fp = join(cardsDir, d.file);
        if (!existsSync(fp) || sha(fp) !== d.sha256) { errors.push(`cards/${d.file} 없음 또는 해시 불일치`); continue; }
        const doc = JSON.parse(readFileSync(fp, 'utf8'));
        const de = schemaErrs('public-card-deck', doc, `cards/${d.file}`);
        errors.push(...de);
        if (de.length) continue;
        if (doc.deck_id !== d.deck_id || doc.revision !== d.revision || doc.cards.length !== d.card_count || doc.publication_status !== d.publication_status) errors.push(`cards/${d.file}: index 와 덱 정보 불일치`);
        if (production && doc.publication_status !== 'approved') errors.push(`cards/${d.file}: 미승인 덱은 운영 배포 불가`);
        for (const c of doc.cards) {
          if (cardIds.has(c.card_id)) errors.push(`cards: 카드 ID 중복 ${c.card_id}`);
          cardIds.add(c.card_id);
          if (cardDigest({ ...c, deck_id: doc.deck_id }) !== c.content_digest) errors.push(`cards/${d.file}: ${c.card_id} content_digest 불일치`);
        }
        if (strs(doc).some((x) => x.includes('\u2014'))) errors.push(`cards/${d.file}: em dash 문자 사용 금지`);
        if (strs(doc).some((x) => x.includes('\u00b7'))) errors.push(`cards/${d.file}: 가운뎃점(·) 사용 금지`);
      }
      const packIds = new Map(bank.packs.map((p) => [p.pack_id, p]));
      for (const l of index.question_links) {
        if (l.file !== `question-links/${l.pack_id}.json`) { errors.push(`cards/${l.file}: 경로 규칙 위반`); continue; }
        allowedGen.add(`cards/${l.file}`);
        const fp = join(cardsDir, l.file);
        if (!existsSync(fp) || sha(fp) !== l.sha256) { errors.push(`cards/${l.file} 없음 또는 해시 불일치`); continue; }
        const doc = JSON.parse(readFileSync(fp, 'utf8'));
        const le = schemaErrs('public-question-card-links', doc, `cards/${l.file}`);
        errors.push(...le);
        if (le.length) continue;
        if (doc.pack_id !== l.pack_id) errors.push(`cards/${l.file}: pack_id 불일치`);
        const p = packIds.get(doc.pack_id);
        if (!p) errors.push(`cards/${l.file}: 공개 번들에 없는 팩`);
        else {
          const m = JSON.parse(readFileSync(join(gen, p.manifest_file), 'utf8'));
          const qids = new Set(m.questions.map((q) => q.question_id));
          for (const x of doc.links) if (!qids.has(x.question_id)) errors.push(`cards/${l.file}: 공개 번들에 없는 문항 ${x.question_id}`);
        }
        for (const x of doc.links) for (const cid of x.card_ids) if (!cardIds.has(cid)) errors.push(`cards/${l.file}: 공개 덱에 없는 카드 ${cid}`);
      }
    }
  }
}
for (const f of listFiles(gen)) {
  const rel = posix(relative(gen, f.p));
  if (f.link) errors.push(`src/data/generated/${rel}: 심볼릭 링크 금지`);
  else if (!allowedGen.has(rel)) errors.push(`src/data/generated/${rel}: manifest 에 없는 파일 (공개 금지)`);
}
for (const f of listFiles(pub)) {
  const rel = posix(relative(pub, f.p));
  if (f.link) errors.push(`public/${rel}: 심볼릭 링크 금지`);
  else if (!allowedPub.has(rel) && !allowGlobs.some((r) => r.test(rel))) errors.push(`public/${rel}: manifest/정책 allowlist 에 없는 파일 (공개 금지)`);
}
function scan(dir, allowNb = new Set()) {
  for (const f of listFiles(dir)) {
    const rel = posix(relative(dir, f.p));
    const n = basename(f.p);
    if (f.link) continue;
    if (allowNb.has(rel)) { /* manifest 등록·구조 검증된 공개 문제 노트북 */ }
    else if (pol.forbidden_suffixes.includes(extname(n).toLowerCase()) || pol.forbidden_names.includes(n) || pol.forbidden_name_prefixes.some((x) => n.startsWith(x))) { errors.push(`${rel}: 공개 금지 파일 형식/이름`); continue; }
    if (f.size > pol.max_file_bytes) { errors.push(`${rel}: 최대 크기 초과`); continue; }
    if (pol.text_suffixes.includes(extname(n).toLowerCase())) {
      const text = readFileSync(f.p, 'utf8');
      const hit = secretRes.find((r) => r.test(text));
      if (hit) errors.push(`${rel}: 비밀키로 보이는 문자열 (${hit.source.slice(0, 20)}…)`);
    }
  }
}
scan(pub, allowedNb);
scan(gen);
// 공개 저장소에 들어가는 소스 전체 (FIX-E)
const skip = new Set(pol.export_skip_dirs);
for (const d of pol.source_scan_paths) {
  if (d === 'public') continue;
  const dir = join(root, d);
  if (!existsSync(dir)) continue;
  for (const f of listFiles(dir)) {
    const rel = posix(relative(root, f.p));
    if (rel.split('/').some((x) => skip.has(x))) continue;
    const n = basename(f.p);
    if (f.link) { errors.push(`${rel}: 심볼릭 링크 금지`); continue; }
    if (pol.forbidden_suffixes.includes(extname(n).toLowerCase()) || pol.forbidden_names.includes(n) || pol.forbidden_name_prefixes.some((x) => n.startsWith(x))) { errors.push(`${rel}: 공개 금지 파일 형식/이름`); continue; }
    if (f.size > pol.max_file_bytes) { errors.push(`${rel}: 최대 크기 초과`); continue; }
    if ([...pol.text_suffixes, '.mjs', '.ts', '.tsx', '.jsx'].includes(extname(n).toLowerCase())) {
      const hit = secretRes.find((r) => r.test(readFileSync(f.p, 'utf8')));
      if (hit) errors.push(`${rel}: 비밀키로 보이는 문자열 (${hit.source.slice(0, 20)}…)`);
    }
  }
}
for (const f of pol.export_files) {
  const fp = join(root, f);
  if (existsSync(fp) && secretRes.some((r) => r.test(readFileSync(fp, 'utf8')))) errors.push(`${f}: 비밀키로 보이는 문자열`);
}
for (const n of pol.public_schemas) {
  const sp = join(root, pol.public_schema_dir, `${n}.schema.json`);
  if (process.env.ACF_CANONICAL_SCHEMA_DIR) {
    const canon = join(process.env.ACF_CANONICAL_SCHEMA_DIR, `${n}.schema.json`);
    if (!readFileSync(sp).equals(readFileSync(canon))) errors.push(`${pol.public_schema_dir}/${n}.schema.json: 정본 스키마와 다름`);
  }
}
if (errors.length) {
  for (const e of [...new Set(errors)]) console.error(`[ERROR] ${e}`);
  process.exit(2);
}
console.log(`content OK (mode=${bank.mode}, packs=${bank.packs.length}${production ? ', production required' : ''}, policy=${pol.policy_version})`);
