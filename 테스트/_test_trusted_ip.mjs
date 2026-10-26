// 회사 인터넷(TRUSTED_IPS)에서는 비밀번호 없이 접속 (2026-10-26)
//  - 회사 주소 → 비밀번호 없이 통과 / 외부 주소 → 401 / 비밀번호는 어디서나 통과
//  - TRUSTED_IPS 미설정 · 주소 헤더 없음 → 통과시키지 않음 (fail-closed 유지)
//  - 회사 주소여도 APP_PASSWORD 가 없으면 503 (서버 설정 누락 감지 유지)
//  - 기계 토큰 권한 범위는 그대로
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

let p = 0, f = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? p++ : f++; };

const tmp = path.join(os.tmpdir(), `worker_ip_${Date.now()}.mjs`);
fs.copyFileSync('cloudflare-worker.js', tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const kv = new Map();
const base = { APP_PASSWORD: 'pw', INGEST_TOKEN: 'ing', MEMBER_IDS: '{"이하영":2}', MEMBER_EMAILS: '{"이하영":"b@x"}', INCLUDE_EXTRA: '0',
  SETTINGS: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const status = async ({ ip, auth, action = 'get-roster', env = {} }) => {
  const headers = { 'Content-Type': 'application/json', 'X-Action': action };
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (auth) headers['X-Auth'] = auth;
  const res = await worker.fetch(new Request('https://w/', { method: 'POST', headers, body: '{}' }), { ...base, ...env }, {});
  return res.status;
};
const OFFICE = '203.0.113.10', OFFICE2 = '203.0.113.20', HOME = '198.51.100.7';
const trusted = { TRUSTED_IPS: ` ${OFFICE} , ${OFFICE2} ` };

console.log('\n[1] 회사 주소는 비밀번호 없이 통과');
ok('회사 주소 1', await status({ ip: OFFICE, env: trusted }) === 200);
ok('회사 주소 2 (여러 개·공백 허용)', await status({ ip: OFFICE2, env: trusted }) === 200);
ok('회사 주소 + 틀린 비밀번호여도 통과', await status({ ip: OFFICE, auth: 'wrong', env: trusted }) === 200);

console.log('\n[2] 외부 주소는 그대로 잠금');
ok('외부 주소 · 비밀번호 없음 → 401', await status({ ip: HOME, env: trusted }) === 401);
ok('외부 주소 · 틀린 비밀번호 → 401', await status({ ip: HOME, auth: 'wrong', env: trusted }) === 401);
ok('외부 주소 · 맞는 비밀번호 → 200', await status({ ip: HOME, auth: 'pw', env: trusted }) === 200);
ok('비슷한 주소(앞부분만 같음) → 401', await status({ ip: '203.0.113.1', env: trusted }) === 401);

console.log('\n[3] 설정 누락 시 안전하게 잠금');
ok('TRUSTED_IPS 미설정 → 401', await status({ ip: OFFICE }) === 401);
ok('TRUSTED_IPS 빈 값 → 401', await status({ ip: OFFICE, env: { TRUSTED_IPS: ' , ' } }) === 401);
ok('주소 헤더 없음 → 401', await status({ env: trusted }) === 401);
ok('APP_PASSWORD 없음 → 회사 주소여도 503', await status({ ip: OFFICE, env: { ...trusted, APP_PASSWORD: '' } }) === 503);

console.log('\n[4] 기계 토큰 권한 범위 유지');
ok('기계 토큰으로 일반 동작 → 외부에선 401', await status({ ip: HOME, auth: 'ing', env: trusted }) === 401);

fs.rmSync(tmp, { force: true });
console.log(`\n결과: ${p} 통과 / ${f} 실패`);
process.exit(f ? 1 : 0);
