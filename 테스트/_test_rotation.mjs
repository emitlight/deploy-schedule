// 추첨 대상 규칙 (2026-11-16 개정)
//  [서버] 가능 인원 전원 동일 확률 · 직전 선정자만 맨 뒤로 · 그 선정이 3개월보다 오래됐으면 다시 동일 확률
//         직전 선정 = 투입 시작일이 가장 늦은 '배정 완료' 건 (추첨만/취소 제외, 같은 날 시작한 2명이면 모두)
//         [긴급]은 뒤로 · 이력 대조 실패 시 가능 인원 전체(동일 확률)로 폴백
//  [화면] 돌림판에는 이번 추첨 대상만, 직전 선정자는 '직전 선정 · 후순위'로 표시
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
const DAYS = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
  '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
const avail = async () => { DAY = DAYS.shift();
  return (await worker.fetch(new Request('https://w/', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'get-availability', 'X-Auth': 'pw' },
    body: JSON.stringify({ startDate: DAY, endDate: DAY, startTime: '09:00', endTime: '18:00' }) }), env, {})).json(); };
const rank = (r, id) => r.members.find(m => m.id === id).rank;
const pool = r => [...r.drawPool].sort((a, b) => a - b).join(',');
// 그날 바쁘게 만들기 — 고객사 전담 태그
const busy = ids => { outlookBusy = Object.fromEntries(ids.map(id => [id, '[고객사] 현장 지원'])); };

// 날짜는 서버가 '오늘(한국 시간)' 기준으로 3개월을 계산하므로 오늘에서 거꾸로 만든다
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ago = n => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const monthsAgo = n => { const [y, m, d] = TODAY.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10); };
const dayBefore = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
// 배정 완료 이력 만들기: [멤버ID, 이름, 투입일들]
const history = (...rows) => {
  sched = []; spin = [];
  rows.forEach(([id, name, dates], i) => {
    dates.forEach((dt, j) => sched.push(evPage(`E${i}_${j}`, { memberId: id, date: dt, spin: `L${i}` })));
    spin.push(logPage(`L${i}`, name, id, dates[0]));
  });
};
const recentNames = r => (r.recentPick ? r.recentPick.names.slice().sort().join(',') : '');

console.log('\n[1] 기본 — 가능 인원 동일 확률, 직전 선정자(이하영 10일 전)만 맨 뒤');
history([3, '강진혁', [ago(40)]], [2, '이하영', [ago(10)]]); busy([1, 4, 7, 8]);
let r = await avail();
ok('규칙 표시', r.drawRule === 'recent-last', r.drawRule);
ok('강진혁·김요엘·윤이나가 동일 확률 추첨 대상', pool(r) === '3,5,6', pool(r));
ok('이하영은 후순위', rank(r, 2) === 1, rank(r, 2));
ok('직전 선정자 안내 = 이하영, 뒤로 미룸', recentNames(r) === '이하영' && r.recentPick.behind === true, JSON.stringify(r.recentPick));
ok('예전 배정자(강진혁)는 순서 영향 없음', rank(r, 3) === 0);
ok('불가 인원은 순위 없음', rank(r, 1) === null);
ok('마지막 배정 정보', r.members.find(m => m.id === 2).lastAssigned?.start === ago(10));
ok('직전 선정자 표시', r.members.find(m => m.id === 2).recentPick === true && r.members.find(m => m.id === 3).recentPick === false);

console.log('\n[2] 다른 가능 인원이 없으면 직전 선정자가 뽑힌다');
busy([1, 3, 4, 5, 6, 7, 8]);
r = await avail();
ok('이하영만 추첨 대상', pool(r) === '2', pool(r));

console.log('\n[3] 직전 선정이 3개월보다 오래됐으면 다시 동일 확률');
history([3, '강진혁', [ago(130)]], [2, '이하영', [ago(100)]]); busy([1, 4, 7, 8]);
r = await avail();
ok('이하영도 추첨 대상 (3개월 경과)', pool(r) === '2,3,5,6', pool(r));
ok('안내: 직전 선정자지만 뒤로 미루지 않음', recentNames(r) === '이하영' && r.recentPick.behind === false, JSON.stringify(r.recentPick));
history([2, '이하영', [monthsAgo(3)]]); busy([1, 4, 7, 8]);
r = await avail();
ok('정확히 3개월 전 선정은 아직 뒤로 (경계)', pool(r) === '3,5,6', pool(r));
history([2, '이하영', [dayBefore(monthsAgo(3))]]); busy([1, 4, 7, 8]);
r = await avail();
ok('3개월하고 하루 지난 선정은 동일 확률', pool(r) === '2,3,5,6', pool(r));

console.log('\n[4] 추첨만 됨·취소는 선정으로 치지 않음');
history([2, '이하영', [ago(10)]]); busy([1, 4, 7, 8]);
spin.push(logPage('LX', '김요엘', 5, ago(2)));            // 일정 없음 → 추첨만 됨
spin.push(logPage('LY', '[취소] 윤이나', null, ago(1)));  // 취소 → 멤버ID 없음
r = await avail();
ok('직전 선정자는 여전히 이하영', recentNames(r) === '이하영', recentNames(r));
ok('김요엘·윤이나는 동일 확률 대상', pool(r) === '3,5,6', pool(r));

console.log('\n[5] 직전 선정 = 투입 시작일이 가장 늦은 배정 (긴 배정이 더 늦게 끝나도)');
history([3, '강진혁', [ago(30), ago(1)]], [2, '이하영', [ago(5)]]); busy([1, 4, 7, 8]);
r = await avail();
ok('직전 선정자 = 이하영 (5일 전 시작)', recentNames(r) === '이하영', recentNames(r));
ok('강진혁은 동일 확률 대상', pool(r) === '3,5,6', pool(r));

console.log('\n[6] 같은 날 2명 투입이면 둘 다 뒤로');
history([3, '강진혁', [ago(7)]], [2, '이하영', [ago(7)]]); busy([1, 4, 7, 8]);
r = await avail();
ok('김요엘·윤이나만 대상', pool(r) === '5,6', pool(r));
ok('안내에 두 사람', recentNames(r) === ['강진혁', '이하영'].sort().join(','), recentNames(r));

console.log('\n[7] [긴급]은 뒤로 (직전 선정자보다는 앞)');
history([2, '이하영', [ago(10)]]);
outlookBusy = { 1: '[고객사] 현장', 4: '[고객사] 현장', 7: '[고객사] 현장', 8: '[고객사] 현장', 5: '[티켓][긴급] 장애 대응' };
r = await avail();
ok('김요엘은 가능하지만 긴급', r.members.find(m => m.id === 5).urgent === true);
ok('강진혁·윤이나만 대상', pool(r) === '3,6', pool(r));
ok('김요엘 대기 1 · 이하영 대기 2', rank(r, 5) === 1 && rank(r, 2) === 2, `${rank(r, 5)},${rank(r, 2)}`);

console.log('\n[8] 배정 이력이 전혀 없으면 가능 인원 전체 동일 확률');
history(); busy([1, 4, 7, 8]);
r = await avail();
ok('가능 인원 전체', pool(r) === '2,3,5,6', pool(r));
ok('직전 선정자 없음', r.recentPick === null);

console.log('\n[9] 이력 대조 실패 → 가능 인원 전체 동일 확률');
history([2, '이하영', [ago(10)]]); busy([1, 4, 7, 8]); failDeployQuery = true;
r = await avail();
ok('폴백 규칙 표시', r.drawRule === 'uniform-fallback', r.drawRule);
ok('가능 인원 전체가 추첨 대상', pool(r) === '2,3,5,6', pool(r));
failDeployQuery = false;

// ════════════════════════════════════════════════════════════════════════
// 화면 — 돌림판에는 이번 추첨 대상만
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
const setRange = () => { $('rDepDateStart').value = DAY; $('rDepDateEnd').value = DAY; $('rDepStart').value = '09:00'; $('rDepEnd').value = '18:00'; };

console.log('\n[10] 돌림판 — 이번 추첨 대상만, 직전 선정자는 후순위 표시');
history([3, '강진혁', [ago(40)]], [2, '이하영', [ago(10)]]); busy([1, 4, 7, 8]);
r = await avail(); setRange();
A.setAvailCtx(r);
A.refreshRoulette();
ok('돌림판 = 강진혁·김요엘·윤이나', A.slices.map(m => m.id).sort().join(',') === '3,5,6', A.slices.map(m => m.id).join(','));
ok('안내에 이번 추첨 인원 표시', /가능 4명.*이번 추첨 3명/.test($('rrInfo').textContent), $('rrInfo').textContent);
ok('목록에 직전 선정 후순위 표시', $('rrQueue').innerHTML.includes('직전 선정 · 후순위'));
ok('규칙 안내에 직전 선정자 이름', $('rrRuleNote').innerHTML.includes('직전 선정자') && $('rrRuleNote').innerHTML.includes('이하영'),
  $('rrRuleNote').innerHTML);
history([2, '이하영', [ago(100)]]); busy([1, 4, 7, 8]);
r = await avail(); setRange();
A.setAvailCtx(r); A.refreshRoulette();
ok('3개월 지난 경우 안내 문구', $('rrRuleNote').innerHTML.includes('다시 같은 확률로 참여'), $('rrRuleNote').innerHTML);
ok('3개월 지난 경우 돌림판 = 가능 인원 전체', A.slices.length === 4, String(A.slices.length));
A.setAvailCtx({ ...r, drawPool: undefined, drawRule: undefined, recentPick: undefined });
A.refreshRoulette();
ok('구버전 서버(drawPool 없음)면 가능 인원 전체', A.slices.length === 4, String(A.slices.length));

fs.rmSync(tmp, { force: true });
console.log(`\n결과: ${p} 통과 / ${f} 실패`);
process.exit(f ? 1 : 0);
