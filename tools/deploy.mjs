// 배포지원 대시보드 — 서버(Cloudflare Worker) 배포 자동화
//
// 실행: 프로젝트 폴더의 '배포하기.bat' 더블클릭  (또는 터미널에서  node tools/deploy.mjs)
//
// 순서
//   1) 문법·공통 상수·회귀 테스트 — 하나라도 실패하면 배포하지 않는다
//   2) Cloudflare 로그인 확인 — 만료됐으면 브라우저 로그인 창을 띄운다 (본인이 직접 로그인)
//   3) Worker 배포 (--keep-vars 필수: 빼면 서버 환경변수가 전부 지워진다)
//   4) 회사 주소(TRUSTED_IPS) 등록 확인 — 처음 한 번, 회사 인터넷에서만 (회선 변경 시 --update-ip)
//   5) 서버 응답 확인
//   6) (선택) 사내 서버의 CRM 동기화 스크립트 갱신 — 서버 비밀번호는 본인이 입력
//
// 보안 검토 필요: 이 스크립트는 비밀번호·토큰을 저장하거나 화면에 출력하지 않는다.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_URL = 'https://deploycalendar.hayoung-lee.workers.dev';
const WRANGLER = 'npx --yes wrangler@4';

const C = { cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', off: '\x1b[0m' };
const step = (n, t) => console.log(`\n${C.cyan}[${n}] ${t}${C.off}`);
const ok = t => console.log(`    ${C.green}OK${C.off}  ${t}`);
const warn = t => console.log(`    ${C.yellow}${t}${C.off}`);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}
async function fail(msg) {
  console.log(`\n  ${C.red}[중단] ${msg}${C.off}`);
  await ask('엔터를 누르면 창이 닫힙니다 ');
  process.exit(1);
}
// 화면에 그대로 보여 주는 실행 (로그인·배포처럼 사용자가 봐야 하는 것)
const runLive = cmd => spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' }).status;
// 결과만 받아 보는 실행 (검사용)
const runQuiet = cmd => {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

console.log(`${C.yellow}==============================================`);
console.log('  배포지원 대시보드 — 서버 배포');
console.log(`==============================================${C.off}`);

// ── 1) 사전 검사 ────────────────────────────────────────────────
step(1, '사전 검사 (문법 · 공통 상수 · 회귀 테스트)');
const tmp = path.join(os.tmpdir(), 'worker-check.mjs');
fs.copyFileSync(path.join(ROOT, 'cloudflare-worker.js'), tmp);
let r = runQuiet(`node --check "${tmp}"`);
fs.rmSync(tmp, { force: true });
if (r.code !== 0) { console.log(r.out); await fail('cloudflare-worker.js 문법 오류'); }
ok('Worker 문법');

r = runQuiet('node .github/scripts/check-constants.cjs');
if (r.code !== 0) { console.log(r.out); await fail('화면/서버 공통 상수가 서로 다릅니다'); }
ok('공통 상수 일치');

const testDir = path.join(ROOT, '테스트');
for (const f of fs.readdirSync(testDir).filter(f => f.endsWith('.mjs')).sort()) {
  r = runQuiet(`node "${path.join(testDir, f)}"`);
  if (r.code !== 0) { console.log(r.out); await fail(`테스트 실패: ${f}`); }
  ok(f);
}

// ── 2) Cloudflare 로그인 확인 ───────────────────────────────────
step(2, 'Cloudflare 로그인 확인');
const loggedOut = out => /not authenticated|not logged in|expired/i.test(out);
r = runQuiet(`${WRANGLER} whoami`);
if (r.code !== 0 || loggedOut(r.out)) {
  warn('로그인이 필요합니다. 브라우저 창이 열리면 Cloudflare 에 로그인하고 [Allow] 를 눌러 주세요.');
  runLive(`${WRANGLER} login`);
  r = runQuiet(`${WRANGLER} whoami`);
  if (r.code !== 0 || loggedOut(r.out)) await fail('Cloudflare 로그인에 실패했습니다');
}
ok('Cloudflare 로그인됨');

// ── 3) Worker 배포 ──────────────────────────────────────────────
step(3, 'Worker 배포 (deploycalendar, 환경변수 유지)');
if (runLive(`${WRANGLER} deploy --keep-vars`) !== 0) {
  await fail('Worker 배포 실패 — 위 메시지를 확인하세요 (사내 프록시 문제면 SHIELD Gate 를 잠시 끄고 다시 시도)');
}
ok('Worker 배포 완료');

// ── 4) 회사 주소 등록 (회사 인터넷에서는 비밀번호 없이 접속) ──────
// 서버 시크릿 TRUSTED_IPS 에 회사 공인 주소를 넣는다. 공개 저장소에는 주소를 남기지 않는다.
// 처음 한 번만 묻고, 회선이 바뀌었을 때는  node tools/deploy.mjs --update-ip  로 다시 등록한다.
// ⚠️ 집·외부에서 등록하면 그 주소가 비밀번호 없이 열리므로 반드시 회사 인터넷에서만 등록할 것 — 보안 검토 필요
step(4, '회사 주소 등록 확인 (회사 인터넷에서는 비밀번호 없이 접속)');
let myIp = '';
try {
  const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
  myIp = (t.match(/^ip=(.+)$/m) || [])[1] || '';
} catch (_) { /* 아래에서 안내 */ }
const secrets = runQuiet(`${WRANGLER} secret list`);
const hasTrusted = /"TRUSTED_IPS"/.test(secrets.out);
const wantUpdate = process.argv.includes('--update-ip');
if (hasTrusted && !wantUpdate) {
  ok('회사 주소가 이미 등록돼 있습니다 (회선이 바뀌었으면: node tools/deploy.mjs --update-ip)');
} else if (!myIp) {
  warn('이 PC의 인터넷 주소를 확인하지 못해 등록을 건너뜁니다 (사내 프록시 영향일 수 있음)');
} else {
  console.log(`    이 PC의 인터넷 주소: ${myIp}`);
  const a = await ask('    지금 이 PC가 회사 인터넷(사내망·VPN)에 연결돼 있나요? 이 주소를 회사 주소로 등록합니다 (Y/N) ');
  if (/^[yYㅛ]/.test(a)) {
    const put = spawnSync(`${WRANGLER} secret put TRUSTED_IPS`, { cwd: ROOT, shell: true, input: myIp + '\n', encoding: 'utf8' });
    if (put.status !== 0) { console.log((put.stdout || '') + (put.stderr || '')); await fail('회사 주소 등록 실패'); }
    ok('회사 주소 등록 완료');
  } else {
    warn('건너뜀 — 회사에서 다시 실행하면 등록할 수 있습니다');
  }
}

// ── 5) 응답 확인 ────────────────────────────────────────────────
// 비밀번호 없이 불러 본다: 회사 인터넷이면 200(통과), 밖이면 401(정상 잠금),
// 503 이면 APP_PASSWORD 가 빠진 것(환경변수 삭제 의심)
step(5, '서버 응답 확인');
try {
  const res = await fetch(WORKER_URL, { method: 'POST', headers: { 'X-Action': 'get-roster' } });
  if (res.status === 200) ok('서버 정상 — 이 PC(회사 인터넷)는 비밀번호 없이 접속됩니다');
  else if (res.status === 401) ok('서버 정상 — 이 PC는 회사 주소가 아니라서 비밀번호를 묻습니다');
  else if (res.status === 503) await fail('서버가 503 — APP_PASSWORD 환경변수가 빠졌습니다. Cloudflare 대시보드에서 확인하세요');
  else warn(`응답 코드 ${res.status} — 대시보드에서 직접 확인해 주세요`);
} catch (e) {
  warn(`응답 확인 실패(${e.message}) — 사내 프록시 영향일 수 있습니다. 대시보드에서 직접 확인해 주세요`);
}

// ── 6) 사내 서버 동기화 스크립트 (선택) ─────────────────────────
step(6, '사내 서버 CRM 동기화 스크립트 갱신 (선택)');
console.log('    sync/crm-deploy-tickets-sync.js 를 고쳤을 때만 필요합니다. 파트너센터 서버 비밀번호를 직접 입력합니다.');
const ans = await ask('    지금 갱신할까요? (Y/N) ');
if (/^[yYㅛ]/.test(ans)) {
  if (runQuiet('python -c "import paramiko"').code !== 0) {
    await fail('paramiko 가 없습니다 — 터미널에서  pip install paramiko  (외부 패키지, LGPL 라이선스 확인 필요)');
  }
  if (runLive(`python "${path.join(ROOT, 'sync', '서버_업데이트.py')}"`) !== 0) await fail('사내 서버 갱신 실패 — 위 메시지를 확인하세요');
  ok('사내 서버 갱신 완료');
} else {
  console.log('    건너뜀');
}

console.log(`\n${C.green}모두 끝났습니다. 대시보드(https://emitlight.github.io/deploy-schedule/)를 새로고침해 확인하세요.${C.off}`);
await ask('엔터를 누르면 창이 닫힙니다 ');
