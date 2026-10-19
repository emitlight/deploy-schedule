// 2026-10-19 결함 수정 회귀 테스트
//  [화면] XSS 차단 · 티켓/추첨 상태 누수 · 여러 날 배정 취소 · 하루 삭제 · 공유 분류 표시 · 수정 시 정보 보존 · 서버 날짜 사용
//  [서버] 조회 실패 멤버 후보 제외 · 통계에서 '추첨만 됨'·명단 밖 인원 제외
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const hsrc = fs.readFileSync('index.html', 'utf8');
const hjs = [...hsrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// ── 최소 DOM 스텁 ──────────────────────────────────────────────────────────
const els = new Map(), mk = id => ({ id, value: '', textContent: '', innerHTML: '', disabled: false, title: '', placeholder: '',
  style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' }, dataset: {}, children: [],
  classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  appendChild() {}, querySelector() { return mk('q'); }, querySelectorAll() { return []; }, addEventListener() {},
  scrollIntoView() {}, getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; },
  getContext() { return new Proxy({}, { get: () => () => {} }); },
  get className() { return [...this.classList._s].join(' '); }, set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); } });
globalThis.document = { getElementById: id => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  querySelector: () => mk('q'), querySelectorAll: () => [], createElement: () => mk('t'), addEventListener() {}, body: mk('b'), documentElement: mk('h') };
const st = new Map();
globalThis.window = { fetch: (...a) => globalThis.fetch(...a), addEventListener() {}, innerWidth: 1400, open() { return {}; }, location: { reload() {} } };
globalThis.localStorage = { getItem: k => st.has(k) ? st.get(k) : null, setItem: (k, v) => st.set(k, String(v)), removeItem: k => st.delete(k) };
globalThis.alert = () => {}; globalThis.confirm = () => true; globalThis.prompt = () => null;
globalThis.requestAnimationFrame = () => 0; globalThis.marked = { parse: s => s };
const short = s => String(s).replace(/data:text\/javascript,[^\s)]+/g, '<module>');
process.on('uncaughtException', e => { console.error('UNCAUGHT:', short(e.message)); process.exit(1); });
process.on('unhandledRejection', e => { console.error('REJECT:', short(e && e.message || e)); });

// 서버 호출 기록 (화면 테스트용)
const calls = [];
globalThis.fetch = async (u, init) => {
  const a = init?.headers?.['X-Action'];
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ a, body });
  let o = { ok: true };
  if (a === 'add-spinlog') o = { ok: true, pageId: 'spin-new' };
  if (a === 'save-event') o = { ok: true, pageId: body.pageId || ('pg-' + body.id) };
  return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const patched = hjs.replace(/const WORKER_URL = [^;]+;/, `const WORKER_URL='http://x/api';`)
  .replace(/\bdocument\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/g, '');
const M = await import('data:text/javascript,' + encodeURIComponent(patched + `
;export const api = { renderGrid, renderHistory, renderCrmTickets, closeRoulette, closeDeployModal, openDeployModal,
  linkedDeployEvents, cancelAssignment, deleteEvent, openEventModal, saveEvent, saveDeployEvent, selectedDate,
  escHtml, jsArg,
  setEvents(v){ events = v; }, get events(){ return events; },
  setSpinLog(v){ notionSpinLog = v; }, setCrm(v){ crmTickets = v; },
  setEditing(v){ editingId = v; }, setAvailCtx(v){ availCtx = v; },
  setPendingTicket(v){ pendingTicket = v; }, get pendingTicket(){ return pendingTicket; },
  setSpin(p, id){ spinLogPromise = p; lastSpinLogPageId = id; },
  get spinState(){ return { p: spinLogPromise, id: lastSpinLogPageId }; } };`));
const A = M.api;
const $ = id => document.getElementById(id);
const wait = ms => new Promise(r => setTimeout(r, ms));

let p = 0, f = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? p++ : f++; };

// ════════════════════════════════════════════════════════════════════════
console.log('\n[1] 외부 문자열 이스케이프 (보안)');
const EVIL = '<img src=x onerror=alert(1)>';
const today = A.selectedDate();
A.setEvents([
  { id: 'x1', memberId: 1, date: today, title: EVIL, note: '"><script>alert(2)</script>', type: 'meeting', startTime: '10:00', endTime: '11:00', fromOutlook: true },
  { id: 'x2', memberId: 2, date: today, title: EVIL, type: 'out', isAllDay: true, startTime: '09:00', endTime: '18:00', fromOutlook: true },
]);
A.renderGrid();
const g = $('gridContainer').innerHTML;
ok('그리드: 시간 일정 제목이 태그로 들어가지 않음', !g.includes('<img src=x'), g.slice(0, 200));
ok('그리드: 제목이 글자로 표시됨', g.includes('&lt;img src=x onerror=alert(1)&gt;'));
ok('그리드: 메모의 스크립트 차단', !g.includes('<script>alert(2)'));

A.setSpinLog([{ id: "a');alert(3);//", name: `홍길동${EVIL}`, spunAt: '2026. 10. 19.', targetDate: '2026-10-19', memberId: 1 }]);
A.renderHistory();
const hb = $('historyBody').innerHTML;
ok('이력: 이름 이스케이프', !hb.includes('<img src=x') && hb.includes('&lt;img'));
ok('이력: onclick 인자에서 따옴표 탈출 불가', !hb.includes("cancelAssignment('a');alert(3)"), hb.slice(0, 300));
ok('이력: onclick 인자는 JSON 문자열', hb.includes('cancelAssignment(&quot;a&#39;);alert(3);//&quot;'));

A.setCrm([{ ticketNo: "TT1');alert(4);//", title: 't', periodFrom: '2026-10-20', periodTo: '2026-10-21' }]);
A.setEvents([]);
A.renderCrmTickets();
const ct = $('crmTickets').innerHTML;
ok('티켓: onclick 인자에서 따옴표 탈출 불가', !ct.includes("assignFromTicket('TT1');alert(4)"), ct.slice(0, 300));
ok('jsArg 결과를 HTML이 풀면 안전한 JS 문자열', A.jsArg(`a'"<`) === '&quot;a&#39;\\&quot;&lt;&quot;');

// ════════════════════════════════════════════════════════════════════════
console.log('\n[2] 티켓·추첨 상태 누수');
A.setPendingTicket({ ticketNo: 'TT9' });
A.closeRoulette(true);
ok('투입 창으로 넘어갈 때(keep)는 티켓 유지', A.pendingTicket && A.pendingTicket.ticketNo === 'TT9');
A.closeRoulette();
ok('사용자가 돌림판을 닫으면 티켓 정보 삭제', A.pendingTicket === null);

A.setPendingTicket({ ticketNo: 'TT9' }); A.setSpin(Promise.resolve('old'), 'old');
A.closeDeployModal();
ok('투입 창 취소 시 티켓 삭제', A.pendingTicket === null);
ok('투입 창 취소 시 이전 당첨자 기록 ID 삭제', A.spinState.p === null && A.spinState.id === null);

A.setPendingTicket({ ticketNo: 'TT9' }); A.setSpin(Promise.resolve('old'), 'old');
A.openDeployModal();
ok('상단 직접 투입은 이전 배정 정보 없이 시작', A.pendingTicket === null && A.spinState.id === null);

A.setSpin(Promise.resolve('keep'), 'keep');
A.closeDeployModal(true);
ok('저장 직후 닫기(keep)는 기록 유지', A.spinState.id === 'keep');
A.setSpin(null, null);

// ════════════════════════════════════════════════════════════════════════
console.log('\n[3] 여러 날 배정 취소 — 모든 날 삭제');
const mkDeploy = (id, date, extra = {}) => ({ id, memberId: 3, date, title: '배포지원', type: 'deploy', startTime: '09:00', endTime: '18:00', pageId: 'p' + id, ...extra });
A.setEvents([
  mkDeploy('d1', '2026-10-20', { spinLogPageId: 's1' }), mkDeploy('d2', '2026-10-21'), mkDeploy('d3', '2026-10-22'),
  mkDeploy('other', '2026-10-21', { title: '다른 배포' }),                       // 같은 사람·다른 배정
  mkDeploy('later', '2026-11-05'),                                                // 기간 밖
  { id: 'ol', memberId: 3, date: '2026-10-21', title: '배포 회의', type: 'deploy', fromOutlook: true },
]);
A.setSpinLog([{ id: 's1', name: '강진혁', memberId: 3, spunAt: '2026. 10. 19. · 기간 2026-10-20~2026-10-22', confirmedRange: '2026-10-20~2026-10-22' }]);
const linked = A.linkedDeployEvents('s1').map(e => e.id).sort();
ok('배정 기간의 3일을 모두 찾음', JSON.stringify(linked) === '["d1","d2","d3"]', JSON.stringify(linked));
calls.length = 0;
await A.cancelAssignment('s1', '강진혁');
const left = A.events.map(e => e.id).sort();
ok('취소 후 3일 모두 삭제, 다른 일정은 유지', JSON.stringify(left) === '["later","ol","other"]', JSON.stringify(left));
ok('Notion에서 3건 삭제 요청', calls.filter(c => c.a === 'delete-event').length === 3, calls.map(c => c.a).join(','));
ok('스핀 기록은 [취소] 처리', calls.some(c => c.a === 'cancel-spinlog' && c.body.pageId === 's1'));

// ════════════════════════════════════════════════════════════════════════
console.log('\n[4] 여러 날 중 하루만 삭제 — 배정 기록 유지');
A.setEvents([mkDeploy('d1', '2026-10-20', { spinLogPageId: 's1' }), mkDeploy('d2', '2026-10-21'), mkDeploy('d3', '2026-10-22')]);
calls.length = 0;
A.setEditing('d1'); A.deleteEvent(); await wait(20);
const d2 = A.events.find(e => e.id === 'd2');
ok('첫날 삭제 시 기록 ID가 다음 날로 이동', d2 && d2.spinLogPageId === 's1');
ok('배정 기록은 지우지 않음', !calls.some(c => c.a === 'delete-spinlog'));
ok('이동한 연결을 Notion에도 저장', calls.some(c => c.a === 'save-event' && c.body.id === 'd2' && c.body.spinLogPageId === 's1'));
A.setSpinLog([]);
A.setEvents([mkDeploy('a1', '2026-10-20', { spinLogPageId: 'sA' }), mkDeploy('a2', '2026-10-21'),
             mkDeploy('b1', '2026-10-22', { spinLogPageId: 'sB' }), mkDeploy('b2', '2026-10-23')]);
ok('이력 없이도 연달아 있는 다음 배정은 묶지 않음',
   JSON.stringify(A.linkedDeployEvents('sA').map(e => e.id)) === '["a1","a2"]',
   JSON.stringify(A.linkedDeployEvents('sA').map(e => e.id)));
A.setEvents([mkDeploy('solo', '2026-10-20', { spinLogPageId: 's2' })]);
A.setSpinLog([]);
calls.length = 0;
A.setEditing('solo'); A.deleteEvent(); await wait(20);
ok('마지막 남은 날을 지우면 기록 삭제(우선순위 복구)', calls.some(c => c.a === 'delete-spinlog' && c.body.pageId === 's2'));

// ════════════════════════════════════════════════════════════════════════
console.log('\n[5] 다른 PC에서 지정한 분류가 수정 창에 보임');
const shared = { id: 'c1', memberId: 1, date: today, title: '[고객사] 방문', type: 'meeting', startTime: '09:00', endTime: '10:00', classification: '불가', fromOutlook: true };
A.setEvents([shared]);
A.openEventModal(1, today, '09:00', shared);
ok('분류 선택값이 "불가"(blocking)', $('fOverride').value === 'blocking', $('fOverride').value);

// ════════════════════════════════════════════════════════════════════════
console.log('\n[6] 일정 수정 시 입력창에 없는 정보 유지');
A.setEvents([{ id: 'e1', memberId: 4, date: today, title: '배포지원', type: 'deploy', startTime: '09:00', endTime: '18:00',
  ticketNo: 'TT77', isAllDay: true, pageId: 'pg-e1', spinLogPageId: 'sp' }]);
A.setEditing('e1');
$('fTitle').value = '배포지원(수정)'; $('fMember').value = '4'; $('fType').value = 'deploy';
$('fStart').value = '09:00'; $('fEnd').value = '18:00'; $('fNote').value = '';
calls.length = 0;
A.saveEvent(); await wait(20);
const e1 = A.events.find(e => e.id === 'e1');
ok('티켓번호 유지', e1.ticketNo === 'TT77');
ok('하루종일 유지', e1.isAllDay === true);
ok('Notion 저장 본문에도 티켓번호 포함', calls.some(c => c.a === 'save-event' && c.body.ticketNo === 'TT77'));

// ════════════════════════════════════════════════════════════════════════
console.log('\n[7] 여러 날 등록일은 서버 판정을 사용 + 중복 생성 없음');
A.setEvents([]);
A.setAvailCtx({ range: { startDate: '2026-10-20', endDate: '2026-10-23', startTime: '09:00', endTime: '18:00' },
  members: [{ id: 5, name: '김요엘', available: false, availableDates: ['2026-10-20', '2026-10-22'] }] });
$('dMember').value = '5'; $('dTitle').value = '배포지원'; $('dDate').value = '2026-10-20'; $('dEndDate').value = '2026-10-23';
$('dStart').value = '09:00'; $('dEnd').value = '18:00';
calls.length = 0;
A.saveDeployEvent(); await wait(50);
const dates = A.events.filter(e => e.type === 'deploy').map(e => e.date).sort();
ok('서버가 준 날짜(10/20, 10/22)만 등록', JSON.stringify(dates) === '["2026-10-20","2026-10-22"]', JSON.stringify(dates));
const saves = calls.filter(c => c.a === 'save-event');
const firstSaves = saves.filter(c => c.body.id === A.events[0].id);
ok('첫 일정의 두 번째 저장은 pageId를 가진 수정(중복 생성 아님)',
   firstSaves.length === 2 && !firstSaves[0].body.pageId && firstSaves[1].body.pageId, JSON.stringify(firstSaves.map(s => s.body.pageId || null)));
ok('두 번째 저장에 배정 기록 ID 포함', firstSaves[1] && firstSaves[1].body.spinLogPageId === 'spin-new');

// ════════════════════════════════════════════════════════════════════════
console.log('\n[8] 배포 시간 변경도 서버에 다시 물음');
ok('시작 시간 select', /id="rDepStart" onchange="onRouletteRangeChange\(\)"/.test(hsrc));
ok('종료 시간 select', /id="rDepEnd" onchange="onRouletteRangeChange\(\)"/.test(hsrc));

// ════════════════════════════════════════════════════════════════════════
// 서버(Worker) — 실제 코드를 그대로 불러오고 외부 서비스만 흉내 낸다
// ════════════════════════════════════════════════════════════════════════
const tmp = path.join(os.tmpdir(), `worker_${Date.now()}.mjs`);
fs.copyFileSync('cloudflare-worker.js', tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const EM = { '이송민': 'a@x', '이하영': 'b@x', '강진혁': 'c@x', '김선우': 'd@x', '김요엘': 'e@x', '윤이나': 'f@x', '이정기': 'g@x', '김정환': 'h@x' };
const IDS = { '이송민': 1, '이하영': 2, '강진혁': 3, '김선우': 4, '김요엘': 5, '윤이나': 6, '이정기': 7, '김정환': 8 };
const env = { APP_PASSWORD: 'pw', GRAPH_CLIENT_ID: 'x', GRAPH_TENANT_ID: 'x', GRAPH_CLIENT_SECRET: 'x',
  MEMBER_EMAILS: JSON.stringify(EM), MEMBER_IDS: JSON.stringify(IDS), NOTION_SECRET: 'x',
  SCHEDULES_DB_ID: 'sched', SPINLOG_DB_ID: 'spin', INCLUDE_EXTRA: '0' };

const rt = s => ({ rich_text: s ? [{ text: { content: s } }] : [] });
const SPIN_PAGES = [
  { id: 'L1', created_time: '2026-10-10T01:00:00.000Z', properties: { '이름': { title: [{ text: { content: '이송민' } }] }, '날짜': { date: { start: '2026-10-12' } }, '스핀일': rt('x'), '멤버ID': { number: 1 } } },
  { id: 'L2', created_time: '2026-10-11T01:00:00.000Z', properties: { '이름': { title: [{ text: { content: '이하영' } }] }, '날짜': { date: { start: '2026-12-01' } }, '스핀일': rt('x'), '멤버ID': { number: 2 } } },
  { id: 'L3', created_time: '2026-10-12T01:00:00.000Z', properties: { '이름': { title: [{ text: { content: '문병린' } }] }, '날짜': { date: { start: '2026-10-14' } }, '스핀일': rt('x'), '멤버ID': { number: 9 } } },
  { id: 'L4', created_time: '2026-10-13T01:00:00.000Z', properties: { '이름': { title: [{ text: { content: '[취소] 강진혁' } }] }, '날짜': { date: { start: '2026-10-15' } }, '스핀일': rt('x'), '멤버ID': { number: null } } },
];
// L1·L3 은 배포 일정과 연결(확정), L2 는 추첨만 됨
const DEPLOY_PAGES = [
  { id: 'D1', properties: { '제목': { title: [{ text: { content: '배포지원' } }] }, '멤버ID': { number: 1 }, '날짜': { date: { start: '2026-10-12' } }, '타입': { select: { name: 'deploy' } }, '아웃룩여부': { checkbox: false }, '스핀로그ID': rt('L1') } },
  { id: 'D3', properties: { '제목': { title: [{ text: { content: '배포지원' } }] }, '멤버ID': { number: 9 }, '날짜': { date: { start: '2026-10-14' } }, '타입': { select: { name: 'deploy' } }, '아웃룩여부': { checkbox: false }, '스핀로그ID': rt('L3') } },
];
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('login.microsoftonline.com')) return json({ access_token: 't', expires_in: 3600 });
  if (url.includes('graph.microsoft.com')) {
    if (url.includes('/users/c@x/')) return new Response(JSON.stringify({ error: { message: 'Access denied' } }), { status: 403 });
    return json({ value: [] });
  }
  if (url.includes('api.notion.com')) {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('/databases/spin/query')) return json({ results: SPIN_PAGES, has_more: false });
    if (url.includes('/databases/sched/query')) {
      const isDeployFilter = JSON.stringify(body).includes('"deploy"');
      return json({ results: isDeployFilter ? DEPLOY_PAGES : [], has_more: false });
    }
    return json({});
  }
  throw new Error('예상 밖 외부 호출: ' + url);
};
const call = async (action, body = {}) => {
  const res = await worker.fetch(new Request('https://w/', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': action, 'X-Auth': 'pw' }, body: JSON.stringify(body) }), env, {});
  return res.json();
};

console.log('\n[9] 서버 — 아웃룩 조회 실패 멤버는 후보에서 제외');
const av = await call('get-availability', { startDate: '2026-10-20', endDate: '2026-10-20', startTime: '09:00', endTime: '18:00' });
const kang = av.members && av.members.find(m => m.id === 3);
ok('조회 실패 멤버(강진혁) available=false', kang && kang.available === false, JSON.stringify(kang));
ok('사유에 조회 실패 안내', kang && /조회 실패/.test(kang.reasons[0].text));
ok('stale 표시 유지', kang && kang.stale === true);
ok('다른 멤버는 정상 가능', av.members.filter(m => m.id !== 3).every(m => m.available));
ok('failedMembers 에 이름', (av.failedMembers || []).includes('강진혁'));

console.log('\n[10] 서버 — 배정 통계는 확정된 배정·현재 명단만');
const s = await call('get-stats', {});
ok('추첨만 된 1건 제외(unconfirmed=1)', s.unconfirmed === 1, JSON.stringify({ u: s.unconfirmed }));
ok('명단 밖(추가 인원) 1건 제외(outsideRoster=1)', s.outsideRoster === 1, JSON.stringify({ o: s.outsideRoster }));
ok('취소 1건 제외', s.cancelledOrReset === 1);
ok('총 배정 1회(이송민만)', s.total === 1, JSON.stringify({ t: s.total }));
const share = s.members.reduce((a, m) => a + m.share, 0);
ok('비율 합계 100%', Math.round(share) === 100, String(share));
ok('이하영(추첨만 됨)은 0회', s.members.find(m => m.id === 2).count === 0);

fs.unlinkSync(tmp);
console.log(`\n=== 통과 ${p} / 실패 ${f} ===`);
process.exit(f ? 1 : 0);
