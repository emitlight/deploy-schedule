// 배정 순번 (2026-10-27) — 오래 배정되지 않은 사람부터, 같은 순번끼리는 동일 확률
//  [서버] 한 번도 안 간 사람 = 0순위 · 오래전 배정 > 최근 배정 · 추첨만/취소는 순번에 영향 없음
//         [긴급]은 같은 순번 안에서 뒤로 · 이력 대조 실패 시 가능 인원 전체(동일 확률)로 폴백
//  [화면] 돌림판에는 이번 순번만 올라간다
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

let p = 0, f = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? p++ : f++; };
const short = s => String(s).replace(/data:text\/javascript,[^\s)]+/g, '<module>');
process.on('uncaughtException', e => { console.error('UNCAUGHT:', short(e.message)); process.exit(1); });

const tmp = path.join(os.tmpdir(), `worker_rot_${Date.now()}.mjs`);
fs.copyFileSync('cloudflare-worker.js', tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const EM = { '이송민': 'a@x', '이하영': 'b@x', '강진혁': 'c@x', '김선우': 'd@x', '김요엘': 'e@x', '윤이나': 'f@x', '이정기': 'g@x', '김정환': 'h@x' };
const IDS = { '이송민': 1, '이하영': 2, '강진혁': 3, '김선우': 4, '김요엘': 5, '윤이나': 6, '이정기': 7, '김정환': 8 };
const EMAIL_ID = Object.fromEntries(Object.entries(EM).map(([n, e]) => [e, IDS[n]]));
const kv = new Map();
const env = { APP_PASSWORD: 'pw', GRAPH_CLIENT_ID: 'x', GRAPH_TENANT_ID: 'x', GRAPH_CLIENT_SECRET: 'x',
  MEMBER_EMAILS: JSON.stringify(EM), MEMBER_IDS: JSON.stringify(IDS), NOTION_SECRET: 'x',
  SCHEDULES_DB_ID: 'sched', SPINLOG_DB_ID: 'spin', INCLUDE_EXTRA: '0',
  SETTINGS: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };

// 가짜 Notion·Graph
const rt = s => ({ rich_text: s ? [{ text: { content: s } }] : [] });
const evPage = (id, e) => ({ id, properties: {
  '제목': { title: [{ text: { content: e.title || '배포지원' } }] }, '멤버ID': { number: e.memberId }, '날짜': { date: { start: e.date } },
  '시작시간': rt('09:00'), '종료시간': rt('18:00'), '타입': { select: { name: 'deploy' } }, '노트': rt(''),
  '아웃룩여부': { checkbox: false }, '하루종일': { checkbox: false }, '아웃룩ID': rt(id),
  '스핀로그ID': rt(e.spin || ''), '티켓번호': rt(e.ticketNo || '') } });
const logPage = (id, name, memberId, date) => ({ id, created_time: `${date}T00:00:00.000Z`, properties: {
  '이름': { title: [{ text: { content: name } }] }, '날짜': { date: { start: date } }, '스핀일': rt(''),
  '멤버ID': { number: memberId } } });
// 서버가 아웃룩 조회를 3분간 캐시하므로, 장면마다 다른 날짜를 쓴다
let sched = [], spin = [], outlookBusy = {}, failDeployQuery = false, DAY = '2026-10-28';
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('login.microsoftonline.com')) return json({ access_token: 't', expires_in: 3600 });
  if (url.includes('graph.microsoft.com')) {
    const email = decodeURIComponent(url.split('/users/')[1].split('/')[0]);
    const subj = outlookBusy[EMAIL_ID[email]];
    return json({ value: subj ? [{ id: `o${email}`, subject: subj, isAllDay: false, showAs: 'busy',
      start: { dateTime: `${DAY}T09:00:00`, timeZone: 'Korea Standard Time' },
      end: { dateTime: `${DAY}T18:00:00`, timeZone: 'Korea Standard Time' } }] : [] });
  }
  if (url.includes('api.notion.com')) {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('/databases/sched/query')) {
      const isDeployQuery = JSON.stringify(body.filter || {}).includes('"타입"');
      if (isDeployQuery && failDeployQuery) return json({ message: 'bad' }, 400);
      return json({ results: sched, has_more: false });
    }
    if (url.includes('/databases/spin/query')) return json({ results: spin, has_more: false });
    return json({});
  }
  throw new Error('예상 밖 호출 ' + url);
};
const DAYS = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
const avail = async () => { DAY = DAYS.shift();
  return (await worker.fetch(new Request('https://w/', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'get-availability', 'X-Auth': 'pw' },
    body: JSON.stringify({ startDate: DAY, endDate: DAY, startTime: '09:00', endTime: '18:00' }) }), env, {})).json(); };
const rank = (r, id) => r.members.find(m => m.id === id).rank;
const pool = r => [...r.drawPool].sort((a, b) => a - b).join(',');
// 10/28 에 바쁘게 만들기 — 고객사 전담 태그
const busy = ids => { outlookBusy = Object.fromEntries(ids.map(id => [id, '[고객사] 현장 지원'])); };

// 기본 이력: 1월 강진혁(3), 2월 이하영(2) — 배포 일정까지 등록된 '배정 완료'
const baseHistory = () => {
  sched = [evPage('E1', { memberId: 3, date: '2026-01-15', spin: 'L1' }), evPage('E2', { memberId: 2, date: '2026-02-10', spin: 'L2' })];
  spin = [logPage('L1', '강진혁', 3, '2026-01-15'), logPage('L2', '이하영', 2, '2026-02-10')];
};

console.log('\n[1] 말씀하신 예시 — 후보 강진혁·이하영·김요엘·윤이나');
baseHistory(); busy([1, 4, 7, 8]);
let r = await avail();
ok('순번 규칙으로 판정', r.drawRule === 'rotation', r.drawRule);
ok('이번 추첨 대상 = 김요엘·윤이나 (배정 이력 없음)', pool(r) === '5,6', pool(r));
ok('강진혁(1월) 대기 1', rank(r, 3) === 1, rank(r, 3));
ok('이하영(2월) 대기 2', rank(r, 2) === 2, rank(r, 2));
ok('불가 인원은 순번 없음', rank(r, 1) === null);
ok('마지막 배정일 표시', r.members.find(m => m.id === 2).lastAssigned?.date === '2026-02-10');
ok('이력 없는 사람은 lastAssigned=null', r.members.find(m => m.id === 5).lastAssigned === null);

console.log('\n[2] 0순위가 모두 불가하면 오래전 배정자부터');
busy([1, 4, 5, 6, 7, 8]);
r = await avail();
ok('강진혁만 추첨 대상', pool(r) === '3', pool(r));
ok('이하영 대기 1', rank(r, 2) === 1);
busy([1, 3, 4, 5, 6, 7, 8]);
r = await avail();
ok('남은 사람이 직전 당첨자뿐이면 그 사람', pool(r) === '2', pool(r));

console.log('\n[3] 추첨만 됨·취소는 순번에 영향 없음');
baseHistory(); busy([1, 4, 7, 8]);
spin.push(logPage('L3', '김요엘', 5, '2026-09-01'));                        // 일정 없음 → 추첨만 됨
spin.push({ ...logPage('L4', '[취소] 윤이나', null, '2026-09-02') });       // 취소 → 멤버ID 없음
r = await avail();
ok('김요엘·윤이나 여전히 0순위', pool(r) === '5,6', pool(r));

console.log('\n[4] 여러 날 배정은 마지막 투입일 기준');
sched = [evPage('E1', { memberId: 3, date: '2026-03-02', spin: 'L1' }), evPage('E1b', { memberId: 3, date: '2026-03-20', spin: 'L1' }),
         evPage('E2', { memberId: 2, date: '2026-03-10', spin: 'L2' })];
spin = [logPage('L1', '강진혁', 3, '2026-03-02'), logPage('L2', '이하영', 2, '2026-03-10')];
busy([1, 4, 5, 6, 7, 8]);
r = await avail();
ok('이하영(3/10 종료)이 강진혁(3/20 종료)보다 앞', pool(r) === '2' && rank(r, 3) === 1, `${pool(r)} / ${rank(r, 3)}`);

console.log('\n[5] [긴급]은 같은 순번 안에서 뒤로');
baseHistory();
outlookBusy = { 1: '[고객사] 현장', 4: '[고객사] 현장', 7: '[고객사] 현장', 8: '[고객사] 현장', 5: '[티켓][긴급] 장애 대응' };
r = await avail();
ok('김요엘은 가능하지만 긴급', r.members.find(m => m.id === 5).urgent === true);
ok('윤이나만 추첨 대상', pool(r) === '6', pool(r));
ok('김요엘 대기 1 · 강진혁 대기 2 · 이하영 대기 3', rank(r, 5) === 1 && rank(r, 3) === 2 && rank(r, 2) === 3,
  `${rank(r, 5)},${rank(r, 3)},${rank(r, 2)}`);

console.log('\n[6] 이력 대조 실패 → 가능 인원 전체 동일 확률');
baseHistory(); busy([1, 4, 7, 8]); failDeployQuery = true;
r = await avail();
ok('폴백 규칙 표시', r.drawRule === 'uniform-fallback', r.drawRule);
ok('가능 인원 전체가 추첨 대상', pool(r) === '2,3,5,6', pool(r));
failDeployQuery = false;

// ════════════════════════════════════════════════════════════════════════
// 화면 — 돌림판에는 이번 순번만
// ════════════════════════════════════════════════════════════════════════
const hsrc = fs.readFileSync('index.html', 'utf8');
const hjs = [...hsrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const els = new Map(), mk = id => ({ id, value: '', textContent: '', innerHTML: '', disabled: false, title: '',
  style: { setProperty() {}, display: '' }, dataset: {}, checked: false,
  classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle() {}, contains(c) { return this._s.has(c); } },
  appendChild() {}, querySelector() { return mk('q'); }, querySelectorAll() { return []; }, addEventListener() {},
  getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; },
  getContext() { return new Proxy({}, { get: () => () => {} }); } });
globalThis.document = { getElementById: id => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  querySelector: () => mk('q'), querySelectorAll: () => [], createElement: () => mk('t'), addEventListener() {}, body: mk('b'), documentElement: mk('h') };
const st = new Map();
globalThis.window = { fetch: (...a) => globalThis.fetch(...a), addEventListener() {}, innerWidth: 1400, open() { return {}; }, location: { reload() {} } };
globalThis.localStorage = { getItem: k => st.has(k) ? st.get(k) : null, setItem: (k, v) => st.set(k, String(v)), removeItem: k => st.delete(k) };
globalThis.alert = () => {}; globalThis.confirm = () => true; globalThis.prompt = () => null;
globalThis.requestAnimationFrame = () => 0; globalThis.marked = { parse: s => s };
const patched = hjs.replace(/const WORKER_URL = [^;]+;/, `const WORKER_URL='http://x/api';`)
  .replace(/\bdocument\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/g, '');
const M = await import('data:text/javascript,' + encodeURIComponent(patched + `
;export const api = { refreshRoulette, renderAvailableMembers, setAvailCtx(v){ availCtx = v; }, get slices(){ return wheelSlices; } };`));
const A = M.api;
const $ = id => document.getElementById(id);

console.log('\n[7] 돌림판 — 이번 순번만 올라가고, 목록엔 대기 순번 표시');
baseHistory(); busy([1, 4, 7, 8]);
r = await avail();
$('rDepDateStart').value = DAY; $('rDepDateEnd').value = DAY; $('rDepStart').value = '09:00'; $('rDepEnd').value = '18:00';
A.setAvailCtx(r);
A.refreshRoulette();
ok('돌림판 = 김요엘·윤이나', A.slices.map(m => m.id).sort().join(',') === '5,6', A.slices.map(m => m.id).join(','));
ok('안내에 이번 순번 인원 표시', /가능 4명.*이번 순번 2명/.test($('rrInfo').textContent), $('rrInfo').textContent);
ok('목록에 이번 추첨·대기 표시', $('rrQueue').innerHTML.includes('이번 추첨') && $('rrQueue').innerHTML.includes('대기 2'));
ok('규칙 안내 문구', $('rrRuleNote').innerHTML.includes('오래 배정되지 않은 사람부터'));
A.setAvailCtx({ ...r, drawPool: undefined, drawRule: undefined });
A.refreshRoulette();
ok('구버전 서버(drawPool 없음)면 가능 인원 전체', A.slices.length === 4, String(A.slices.length));

fs.rmSync(tmp, { force: true });
console.log(`\n결과: ${p} 통과 / ${f} 실패`);
process.exit(f ? 1 : 0);
