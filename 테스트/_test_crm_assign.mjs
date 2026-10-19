// CRM 담당자 → 대시보드 배정 자동 반영 + 통계 배정 내역 + 아웃룩 조회 재시도
//  [서버] applyCrmAssignments: 신규 생성 · 수동 일정 연결 · 불일치 보고 · 자동분 담당자 이동 · 기간 연장 · 쓰기 상한
//  [서버] 아웃룩 일시 오류(503) 자동 재시도
//  [화면] 티켓 카드 상태(CRM 담당·불일치·CRM 연동) · 통계에서 멤버를 누르면 배정 내역
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

let p = 0, f = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? p++ : f++; };
const short = s => String(s).replace(/data:text\/javascript,[^\s)]+/g, '<module>');
process.on('uncaughtException', e => { console.error('UNCAUGHT:', short(e.message)); process.exit(1); });

// ════════════════════════════════════════════════════════════════════════
// 서버 — 실제 Worker 코드 + 가짜 Notion/Graph
// ════════════════════════════════════════════════════════════════════════
const tmp = path.join(os.tmpdir(), `worker_crm_${Date.now()}.mjs`);
fs.copyFileSync('cloudflare-worker.js', tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const EM = { '이송민': 'a@x', '이하영': 'b@x', '강진혁': 'c@x', '김선우': 'd@x', '김요엘': 'e@x', '윤이나': 'f@x', '이정기': 'g@x', '김정환': 'h@x' };
const IDS = { '이송민': 1, '이하영': 2, '강진혁': 3, '김선우': 4, '김요엘': 5, '윤이나': 6, '이정기': 7, '김정환': 8 };
const kv = new Map();
const env = { APP_PASSWORD: 'pw', INGEST_TOKEN: 'ing', GRAPH_CLIENT_ID: 'x', GRAPH_TENANT_ID: 'x', GRAPH_CLIENT_SECRET: 'x',
  MEMBER_EMAILS: JSON.stringify(EM), MEMBER_IDS: JSON.stringify(IDS), NOTION_SECRET: 'x',
  SCHEDULES_DB_ID: 'sched', SPINLOG_DB_ID: 'spin', INCLUDE_EXTRA: '0',
  SETTINGS: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };

// 가짜 Notion — 배포 일정(SCHEDULES)·스핀 기록(SPINLOG)을 메모리에 둔다
const rt = s => ({ rich_text: s ? [{ text: { content: s } }] : [] });
let sched = [], spinPages = [], writes = [], nextId = 1;
const mkPage = (id, e) => ({ id, parent: { database_id: 'sched' }, properties: {
  '제목': { title: [{ text: { content: e.title || '' } }] }, '멤버ID': { number: e.memberId }, '날짜': { date: { start: e.date } },
  '시작시간': rt('09:00'), '종료시간': rt('18:00'), '타입': { select: { name: 'deploy' } }, '노트': rt(e.note || ''),
  '아웃룩여부': { checkbox: false }, '하루종일': { checkbox: false }, '아웃룩ID': rt(e.outlookId || id),
  '스핀로그ID': rt(e.spinLogPageId || ''), '티켓번호': rt(e.ticketNo || '') } });
const reset = (initial = []) => { sched = initial.map((e, i) => mkPage(e.pageId || `S${i}`, e)); spinPages = []; writes = []; nextId = 1; };
let graphFailOnce = new Set();   // 이 이메일은 첫 요청에 503을 돌려준다
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('login.microsoftonline.com')) return json({ access_token: 't', expires_in: 3600 });
  if (url.includes('graph.microsoft.com')) {
    const email = decodeURIComponent(url.split('/users/')[1].split('/')[0]);
    if (graphFailOnce.has(email)) { graphFailOnce.delete(email); return json({ error: { message: 'busy' } }, 503); }
    return json({ value: [] });
  }
  if (url.includes('api.notion.com')) {
    const body = init.body ? JSON.parse(init.body) : {};
    const m = init.method || 'GET';
    if (url.includes('/databases/sched/query')) return json({ results: sched.filter(p => !p.archived), has_more: false });
    if (url.includes('/databases/spin/query')) return json({ results: spinPages, has_more: false });
    if (m === 'PATCH' && url.match(/\/databases\//)) return json({});
    if (m === 'POST' && url.endsWith('/pages')) {
      const id = `N${nextId++}`;
      writes.push({ op: 'create', db: body.parent.database_id, id, props: body.properties });
      const page = { id, parent: body.parent, properties: body.properties, created_time: '2026-10-19T00:00:00.000Z' };
      (body.parent.database_id === 'spin' ? spinPages : sched).push(page);
      return json(page);
    }
    if (m === 'PATCH' && url.includes('/pages/')) {
      const id = url.split('/pages/')[1];
      const pg = sched.find(x => x.id === id) || spinPages.find(x => x.id === id);
      writes.push({ op: body.archived ? 'archive' : 'patch', id, props: body.properties });
      if (pg) { if (body.archived) pg.archived = true; if (body.properties) Object.assign(pg.properties, body.properties); }
      return json(pg || {});
    }
    return json({});
  }
  throw new Error('예상 밖 호출 ' + url);
};
const call = async (action, body = {}, auth = 'pw') => (await worker.fetch(new Request('https://w/', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Action': action, 'X-Auth': auth }, body: JSON.stringify(body) }), env, {})).json();
const T = (no, assignee, from, to, account = '[고객사]') => ({ ticketNo: no, assignee, periodFrom: from, periodTo: to, account, title: 't' });
const live = () => sched.filter(x => !x.archived);
const prop = (pg, k) => pg.properties[k]?.rich_text?.[0]?.text?.content ?? pg.properties[k]?.number ?? pg.properties[k]?.date?.start;

console.log('\n[1] CRM 담당자가 명단 멤버 → 요청 기간 평일마다 배정 일정 생성');
reset();
let r = await call('ingest-crm-tickets', { tickets: [T('TT1', '김정환', '2026-10-19', '2026-10-23'), T('TT2', '오정훈', '2026-10-19', '2026-10-20')] }, 'ing');
ok('적재 응답에 반영 결과 포함', r.ok && r.assignments && r.assignments.ok, JSON.stringify(r));
ok('평일 5일 일정 생성', live().length === 5, String(live().length));
ok('모두 김정환(8)·티켓 TT1', live().every(x => prop(x, '멤버ID') === 8 && prop(x, '티켓번호') === 'TT1'));
ok('자동 반영 표시(노트)', live().every(x => String(prop(x, '노트')).startsWith('CRM 담당자 자동 반영')));
ok('배정 기록 1건(통계·이력용)', spinPages.length === 1 && prop(spinPages[0], '멤버ID') === 8);
ok('첫날에만 기록 연결', live().filter(x => prop(x, '스핀로그ID')).length === 1);
ok('접수 큐(오정훈) 티켓은 대기로 분류', r.assignments.waiting === 1);

console.log('\n[2] 다시 실행해도 중복 생성 없음(멱등)');
writes = [];
r = await call('apply-crm-assignments');
ok('쓰기 0건', writes.length === 0, JSON.stringify(writes.map(w => w.op)));

console.log('\n[3] CRM에서 기간이 늘어나면 자동분은 따라감');
kv.set('crm-tickets', JSON.stringify({ tickets: [T('TT1', '김정환', '2026-10-19', '2026-10-27')], syncedAt: new Date().toISOString() }));
r = await call('apply-crm-assignments');
ok('늘어난 평일 2일 추가', live().length === 7 && r.extended === 2, JSON.stringify({ n: live().length, ext: r.extended }));

console.log('\n[4] 수동으로 등록된 같은 사람 일정은 연결만 (중복 생성 X)');
reset([{ pageId: 'M1', memberId: 6, date: '2026-10-21', title: '배포지원', note: '' },
       { pageId: 'M2', memberId: 6, date: '2026-10-22', title: '배포지원', note: '' }]);
r = await call('ingest-crm-tickets', { tickets: [T('TT3', '윤이나', '2026-10-21', '2026-10-22', 'KB국민카드')] }, 'ing');
ok('새 일정 생성 없음', live().length === 2);
ok('기존 2건에 티켓번호 연결', live().every(x => prop(x, '티켓번호') === 'TT3'));
ok('연결로 집계', r.assignments.linked === 1);

console.log('\n[5] 사람이 등록한 배정과 CRM 담당자가 다르면 덮어쓰지 않고 불일치 보고');
reset([{ pageId: 'H1', memberId: 4, date: '2026-10-21', title: '배포지원', note: '', ticketNo: 'TT4' }]);
r = await call('ingest-crm-tickets', { tickets: [T('TT4', '이하영', '2026-10-21', '2026-10-21')] }, 'ing');
ok('기존 일정 그대로', live().length === 1 && prop(live()[0], '멤버ID') === 4);
ok('불일치 보고', r.assignments.mismatch.length === 1 && r.assignments.mismatch[0].crm === '이하영', JSON.stringify(r.assignments.mismatch));

console.log('\n[6] 자동 생성분은 CRM 담당자 변경을 따라 이동 (지난 날짜는 이력으로 남김)');
reset([{ pageId: 'A0', memberId: 8, date: '2020-01-06', title: '배포지원', note: 'CRM 담당자 자동 반영 · TT5', ticketNo: 'TT5', spinLogPageId: 'SPOLD' },
       { pageId: 'A1', memberId: 8, date: '2099-01-05', title: '배포지원', note: 'CRM 담당자 자동 반영 · TT5', ticketNo: 'TT5' }]);
spinPages.push({ id: 'SPOLD', parent: { database_id: 'spin' }, created_time: '2020-01-01T00:00:00.000Z',
  properties: { '이름': { title: [{ text: { content: '김정환' } }] }, '멤버ID': { number: 8 } } });
r = await call('ingest-crm-tickets', { tickets: [T('TT5', '윤이나', '2099-01-05', '2099-01-06')] }, 'ing');
ok('미래 일정은 보관 처리', sched.find(x => x.id === 'A1').archived === true);
ok('지난 일정은 남김', !sched.find(x => x.id === 'A0').archived);
ok('이전 담당자 기록은 [취소]', /\[취소\]/.test(spinPages.find(x => x.id === 'SPOLD').properties['이름'].title[0].text.content));
ok('새 담당자(윤이나) 일정 2일 생성', live().filter(x => prop(x, '멤버ID') === 6).length === 2);
ok('이동으로 집계', r.assignments.moved === 1);

console.log('\n[7] 쓰기 상한 — 반쪽 생성 대신 다음 실행으로 미룸');
reset();
kv.set('crm-tickets', JSON.stringify({ tickets: [T('TT6', '이송민', '2026-10-19', '2026-11-13')], syncedAt: new Date().toISOString() }));
const scheduledPromises = [];
await worker.scheduled({}, env, { waitUntil: pr => scheduledPromises.push(pr) });
await Promise.all(scheduledPromises);
ok('Cron(상한 15)에서는 20일짜리를 만들지 않음', live().filter(x => prop(x, '티켓번호') === 'TT6').length === 0);
r = await call('apply-crm-assignments');
ok('상한 40인 실행에서 20일 생성', live().filter(x => prop(x, '티켓번호') === 'TT6').length === 20, String(live().length));

console.log('\n[8] 아웃룩 일시 오류는 자동 재시도 → 후보에서 빠지지 않음');
graphFailOnce = new Set(['c@x']);
const av = await call('get-availability', { startDate: '2026-12-01', endDate: '2026-12-01' });
const kang = av.members.find(m => m.id === 3);
ok('503 한 번 뒤 성공 → 정상 판정', kang && kang.stale === false && kang.available === true, JSON.stringify(kang));

fs.unlinkSync(tmp);

// ════════════════════════════════════════════════════════════════════════
// 화면 — 티켓 카드 상태 · 통계 배정 내역
// ════════════════════════════════════════════════════════════════════════
const hjs = [...fs.readFileSync('index.html', 'utf8').matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const els = new Map(), mk = id => ({ id, value: '', textContent: '', innerHTML: '', disabled: false, title: '',
  style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }, display: '' }, dataset: {}, children: [],
  classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  _attr: {}, setAttribute(k, v) { this._attr[k] = v; }, getAttribute(k) { return this._attr[k]; },
  appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
  getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; }, getContext() { return new Proxy({}, { get: () => () => {} }); } });
globalThis.document = { getElementById: id => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  querySelector: () => null, querySelectorAll: () => [], createElement: () => mk('t'), addEventListener() {}, body: mk('b'), documentElement: mk('h') };
const st = new Map();
globalThis.window = { fetch: (...a) => globalThis.fetch(...a), addEventListener() {}, innerWidth: 1400, open() { return {}; }, location: { reload() {} } };
globalThis.localStorage = { getItem: k => st.has(k) ? st.get(k) : null, setItem: (k, v) => st.set(k, String(v)), removeItem: k => st.delete(k) };
globalThis.alert = () => {}; globalThis.confirm = () => true; globalThis.prompt = () => null; globalThis.requestAnimationFrame = () => 0;

let statsResp = null;
globalThis.fetch = async (u, init) => new Response(JSON.stringify(
  init?.headers?.['X-Action'] === 'get-stats' ? statsResp : { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const patched = hjs.replace(/const WORKER_URL = [^;]+;/, `const WORKER_URL='http://x/api';`)
  .replace(/\bdocument\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/g, '');
const M = await import('data:text/javascript,' + encodeURIComponent(patched + `
;export const api = { renderCrmTickets, loadStats, toggleStatDetail, statItemsFromLog,
  setEvents(v){ events = v; }, setCrm(v, info){ crmTickets = v; crmSyncInfo = info; }, setSpinLog(v){ notionSpinLog = v; } };`));
const A = M.api;
const $ = id => document.getElementById(id);

console.log('\n[9] 티켓 카드 — CRM 담당자 상태');
A.setCrm([
  { ticketNo: 'TT1', assignee: '김정환', account: 'KB국민은행', periodFrom: '2026-10-19', periodTo: '2026-11-16', title: 'a' },
  { ticketNo: 'TT2', assignee: '윤이나', account: 'KB국민카드', periodFrom: '2026-10-20', periodTo: '2026-10-21', title: 'b' },
  { ticketNo: 'TT3', assignee: '오정훈', account: '[고객사]', periodFrom: '2026-10-22', periodTo: '2026-10-22', title: 'c' },
  { ticketNo: 'TT4', assignee: '이하영', account: '[고객사]', periodFrom: '2026-10-23', periodTo: '2026-10-23', title: 'd' },
], { configured: true, syncedAt: new Date().toISOString(), ageHours: 0 });
A.setEvents([
  { id: 'e1', type: 'deploy', memberId: 6, date: '2026-10-20', ticketNo: 'TT2', note: 'CRM 담당자 자동 반영 · TT2' },
  { id: 'e2', type: 'deploy', memberId: 4, date: '2026-10-23', ticketNo: 'TT4', note: '' },
]);
A.renderCrmTickets();
const html = $('crmTickets').innerHTML;
const card = no => html.split('class="ct-card').find(c => c.includes(`>${no}<`)) || '';
ok('TT1: CRM 담당 김정환 · 자동 반영 대기', /CRM 담당 김정환 · 자동 반영 대기/.test(card('TT1')));
ok('TT1: 돌림판 버튼 숨김', !/이 티켓으로 배정/.test(card('TT1')));
ok('TT2: 윤이나 배정됨 · CRM 연동', /윤이나 배정됨 · CRM 연동/.test(card('TT2')));
ok('TT3: 접수 큐 → 배정 필요 + 버튼', /배정 필요/.test(card('TT3')) && /이 티켓으로 배정/.test(card('TT3')));
ok('TT4: 담당 불일치 경고', /담당 불일치 · CRM 이하영 \/ 대시보드 김선우/.test(card('TT4')), card('TT4').slice(0, 300));

console.log('\n[10] 배정 통계 — 멤버를 누르면 배정 내역');
A.setEvents([{ id: 'd1', type: 'deploy', memberId: 8, date: '2026-10-19', ticketNo: 'TT1', spinLogPageId: 'L1' }]);
A.setSpinLog([
  { id: 'L1', memberId: 8, createdTime: '2026-10-15T00:00:00Z', spunAt: 'CRM 담당자 지정 · TT1 · 기간 2026-10-19~2026-11-16', confirmed: true, confirmedRange: '2026-10-19~2026-11-16', confirmedDays: 20, eventTitle: 'KB국민은행 배포지원' },
  { id: 'L2', memberId: 8, createdTime: '2026-09-01T00:00:00Z', spunAt: '2026. 9. 1.', confirmed: false, targetDate: '2026-09-02' },
]);
// (a) 구버전 서버 — items 없음 → 화면이 이력에서 만든다
statsResp = { ok: true, total: 2, members: [{ id: 8, name: '김정환', count: 2, share: 100, lastAssigned: '2026-10-15' }],
  fairness: { average: 2, max: 2, min: 2, neverAssigned: [] } };
await A.loadStats();
let sb = $('statsBody').innerHTML;
ok('행을 누를 수 있음(role=button)', /class="stat-row" role="button"/.test(sb));
ok('내역 행은 처음엔 접힘', /id="statDetail-8" class="stat-detail" style="display:none;"/.test(sb));
ok('내역에 기간(10/19~11/16)과 일수', /10\/19~11\/16/.test(sb) && /20일/.test(sb));
ok('내역에 고객사·티켓번호(CRM 링크용)', /KB국민은행/.test(sb) && /TT1/.test(sb));
ok('CRM 출처 표시', /si-src-crm">CRM</.test(sb));
ok('구버전 서버 횟수와 맞추려 "추첨만 됨"도 표시', /추첨만 됨/.test(sb));
const row = mk('row'); row.querySelector = () => ({ textContent: '▸' });
$('statDetail-8').style.display = 'none';   // 스텁 DOM은 HTML을 해석하지 않으므로 렌더 직후 상태(접힘)를 맞춰 준다
A.toggleStatDetail(8, row);
ok('누르면 펼쳐짐', $('statDetail-8').style.display === '' && row.getAttribute('aria-expanded') === 'true');
A.toggleStatDetail(8, row);
ok('다시 누르면 접힘', $('statDetail-8').style.display === 'none');
// (b) 신버전 서버 — items 제공 → 그대로 사용
statsResp = { ok: true, total: 1, unconfirmed: 1, outsideRoster: 0, members: [{ id: 8, name: '김정환', count: 1, share: 100, lastAssigned: '2026-10-15',
  items: [{ period: '2026-10-19~2026-11-16', days: 20, title: 'KB국민은행 배포지원', ticketNo: 'TT1', source: 'CRM' }] }],
  fairness: { average: 1, max: 1, min: 1, neverAssigned: [] } };
await A.loadStats();
sb = $('statsBody').innerHTML;
ok('서버 내역 사용 — 추첨만 된 건은 빠짐', !/추첨만 됨/.test(sb) && /TT1/.test(sb));
ok('0회 멤버는 "배정된 건이 없습니다"', (() => { statsResp.members.push({ id: 7, name: '이정기', count: 0, share: 0, items: [] }); return true; })());
await A.loadStats();
ok('…표시 확인', /이 기간에 배정된 건이 없습니다/.test($('statsBody').innerHTML));

console.log(`\n=== 통과 ${p} / 실패 ${f} ===`);
process.exit(f ? 1 : 0);
