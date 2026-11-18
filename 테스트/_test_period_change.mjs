// 2026-11-18 배정 기간 변경 기능 검증
//  [1] 같은 배정 묶음 찾기 (첫날에만 기록 ID / 기간 메모가 낡은 경우 / 다른 배정과 구분)
//  [2] 기간 변경 — 같은 날 수 · 늘리기 · 줄이기 · 주말 제외 · CRM 자동 일정 차단
//  [3] 일정 수정 시 원래 날짜 유지 (선택된 날짜로 옮겨지던 문제)
//  [4] 서버 — 이력 메모 기간 교체 · 여러 날 배정을 전부 집계
// 실행: node 테스트/_test_period_change.mjs   (프로젝트 폴더에서)
import fs from 'fs';

const wsrc = fs.readFileSync('cloudflare-worker.js', 'utf8');
const hsrc = fs.readFileSync('index.html', 'utf8');
const hjs = [...hsrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

let pass = 0, fail = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? pass++ : fail++; };

const cut = (src, n) => {
  const a = src.indexOf(`async function ${n}(`);
  const i = a >= 0 ? a : src.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('함수 없음: ' + n);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};
const constLine = n => (hjs.match(new RegExp(`const ${n}\\s*=.*`)) || [])[0];

// 화면 코드를 가짜 환경에서 실행
function makeUi(initialEvents, spinLogs = []) {
  const ctx = {
    events: initialEvents, notionSpinLog: spinLogs, editingId: null,
    toasts: [], mails: [], saved: [], deleted: [], spinUpdates: [],
    inputs: { fPeriodStart: { value: '' }, fPeriodEnd: { value: '' } },
  };
  const src = `
    let events = ctx.events, notionSpinLog = ctx.notionSpinLog, editingId = null;
    let selectedDay = null, currentWeekStart = null;
    const WORKER_URL = 'https://stub';
    const document = { getElementById: id => ctx.inputs[id] || { value: '', style: {}, classList: { toggle(){} } } };
    const confirm = () => true;
    const showToast = m => ctx.toasts.push(m);
    const ALL = () => [{ id: 4, name: '김선우' }, { id: 8, name: '김정환' }];
    const saveData = () => {}, saveDataLocal = () => {}, closeModal = () => {}, render = () => {};
    const getMonday = d => d;
    const loadRrOrderFromNotion = () => {};
    const saveEventToNotion = async ev => { ctx.saved.push({ ...ev }); return { ...ev, pageId: ev.pageId || 'new-' + ev.date }; };
    const deleteEventFromNotion = pid => ctx.deleted.push(pid);
    const workerPost = async (a, b) => { ctx.spinUpdates.push({ a, ...b }); return { ok: true }; };
    const openPeriodChangeMail = (...a) => ctx.mails.push(a);
    ${constLine('isOwnDeploy')}
    ${constLine('isCrmAutoEv')}
    ${constLine('byDateAsc')}
    ${cut(hjs, 'weekdaysBetween')}
    ${cut(hjs, 'linkedDeployEvents')}
    ${cut(hjs, 'assignmentGroupOf')}
    ${cut(hjs, 'periodLabel')}
    ${cut(hjs, 'changeAssignmentPeriod')}
    return {
      group: ev => assignmentGroupOf(ev),
      weekdays: weekdaysBetween,
      change: async (id, s, e) => { editingId = id; ctx.inputs.fPeriodStart.value = s; ctx.inputs.fPeriodEnd.value = e; await changeAssignmentPeriod(); },
      get events() { return events; },
    };`;
  return { ui: new Function('ctx', src)(ctx), ctx };
}

const dep = (id, date, extra = {}) => ({ id, memberId: 4, date, title: '배포지원', type: 'deploy',
  startTime: '09:00', endTime: '18:00', note: '', ticketNo: null, fromOutlook: false, pageId: 'p-' + id, ...extra });
// 김선우 11/30~12/04 배정 (기록 ID는 첫날에만) — 실제 데이터와 같은 모양
const week = () => [
  dep('a0', '2026-11-30', { spinLogPageId: 'S1' }), dep('a1', '2026-12-01'), dep('a2', '2026-12-02'),
  dep('a3', '2026-12-03'), dep('a4', '2026-12-04'),
];

// ── [1] 배정 묶음 ────────────────────────────────────────────────────────
console.log('\n[1] 같은 배정 묶음 찾기');
{
  // 서버가 첫날만 세던 값 + 기간 메모가 옛 기간(11/23~27)으로 낡은 경우
  const logs = [{ id: 'S1', memberId: 4, confirmedRange: '2026-11-30', spunAt: '2026. 11. 16. · 기간 2026-11-23~2026-11-27' }];
  const { ui } = makeUi([...week(), dep('b0', '2026-12-14', { spinLogPageId: 'S2' }), dep('b1', '2026-12-15'),
    dep('x', '2026-12-01', { memberId: 8 }), dep('o', '2026-12-02', { fromOutlook: true })], logs);
  const ev = n => ui.events.find(e => e.id === n);
  const g1 = ui.group(ev('a0'));
  ok('첫날에서 열면 5일 전체', g1.events.map(e => e.id).join() === 'a0,a1,a2,a3,a4', g1.events.map(e => e.id).join());
  ok('기록 ID 확인', g1.spinId === 'S1');
  const g2 = ui.group(ev('a3'));
  ok('중간 날에서 열어도 같은 묶음', g2.events.length === 5 && g2.spinId === 'S1', JSON.stringify(g2.events.map(e => e.id)));
  ok('다음 배정(12/14~)은 섞이지 않음', !g1.events.some(e => e.id.startsWith('b')));
  ok('다른 사람·아웃룩 일정 제외', !g1.events.some(e => e.id === 'x' || e.id === 'o'));
  const g3 = ui.group(ev('b1'));
  ok('두 번째 배정도 따로 묶임', g3.spinId === 'S2' && g3.events.map(e => e.id).join() === 'b0,b1', g3.events.map(e => e.id).join());
}
{
  // 기록 없이 등록된 옛 배정: 주말을 사이에 둔 이어진 날짜만 묶는다
  const { ui } = makeUi([dep('c0', '2026-11-26'), dep('c1', '2026-11-27'), dep('c2', '2026-11-30'), dep('c3', '2026-12-10')]);
  const g = ui.group(ui.events.find(e => e.id === 'c1'));
  ok('기록 없는 배정 — 주말 건너 이어진 날짜까지', g.events.map(e => e.id).join() === 'c0,c1,c2', g.events.map(e => e.id).join());
  ok('멀리 떨어진 날은 다른 배정', !g.events.some(e => e.id === 'c3'));
}

// ── [2] 기간 변경 ────────────────────────────────────────────────────────
console.log('\n[2] 기간 변경');
ok('평일 계산 — 주말 제외', makeUi([]).ui.weekdays('2026-11-27', '2026-12-01').join() === '2026-11-27,2026-11-30,2026-12-01');
{
  // 같은 날 수: 한 주 뒤로
  const { ui, ctx } = makeUi(week());
  await ui.change('a2', '2026-12-07', '2026-12-11');
  const mine = ui.events.filter(e => e.memberId === 4).sort((a, b) => a.date < b.date ? -1 : 1);
  ok('5일 → 5일, 날짜만 이동', mine.map(e => e.date).join() === '2026-12-07,2026-12-08,2026-12-09,2026-12-10,2026-12-11', mine.map(e => e.date).join());
  ok('기존 일정 재사용(새로 만들지 않음)', mine.every(e => e.pageId.startsWith('p-')));
  ok('기록 ID는 새 첫날에만', mine[0].spinLogPageId === 'S1' && mine.slice(1).every(e => !e.spinLogPageId));
  ok('Notion 5건 저장', ctx.saved.length === 5, ctx.saved.length);
  ok('삭제 없음', ctx.deleted.length === 0);
  ok('배정 기록 기간 갱신 요청', ctx.spinUpdates.length === 1 && ctx.spinUpdates[0].a === 'update-spinlog' &&
     ctx.spinUpdates[0].from === '2026-12-07' && ctx.spinUpdates[0].to === '2026-12-11', JSON.stringify(ctx.spinUpdates));
  ok('변경 안내 메일 창', ctx.mails.length === 1 && /2026-11-30/.test(ctx.mails[0][1]) && /2026-12-07/.test(ctx.mails[0][2]));
}
{
  // 늘리기: 5일 → 7일 (주말 포함 선택)
  const { ui, ctx } = makeUi(week());
  await ui.change('a0', '2026-11-30', '2026-12-08');
  const mine = ui.events.filter(e => e.memberId === 4).sort((a, b) => a.date < b.date ? -1 : 1);
  ok('5일 → 7일 (주말 제외)', mine.length === 7 && !mine.some(e => ['2026-12-05', '2026-12-06'].includes(e.date)), mine.map(e => e.date).join());
  const added = mine.filter(e => !e.pageId.startsWith('p-'));
  ok('늘어난 2일은 새로 저장', added.length === 2 && added.every(e => e.type === 'deploy' && e.title === '배포지원' && !e.spinLogPageId));
  ok('새 일정에 Notion 페이지 연결', added.every(e => e.pageId.startsWith('new-')));
}
{
  // 줄이기: 5일 → 2일
  const { ui, ctx } = makeUi(week());
  await ui.change('a0', '2026-12-01', '2026-12-02');
  const mine = ui.events.filter(e => e.memberId === 4).sort((a, b) => a.date < b.date ? -1 : 1);
  ok('5일 → 2일', mine.map(e => e.date).join() === '2026-12-01,2026-12-02', mine.map(e => e.date).join());
  ok('남는 3일은 Notion에서 삭제', ctx.deleted.length === 3, JSON.stringify(ctx.deleted));
  ok('첫날 기록 ID 유지', mine[0].spinLogPageId === 'S1');
}
{
  // 잘못된 입력
  const { ui, ctx } = makeUi(week());
  await ui.change('a0', '2026-12-05', '2026-12-06');
  ok('주말만 고르면 거부', ctx.toasts.some(t => t.includes('평일이 없습니다')) && ui.events.filter(e => e.memberId === 4)[0].date === '2026-11-30');
  await ui.change('a0', '2026-12-04', '2026-12-01');
  ok('종료일이 빠르면 거부', ctx.toasts.some(t => t.includes('종료일은')));
  await ui.change('a0', '2026-11-30', '2026-12-04');
  ok('같은 기간이면 아무것도 안 함', ctx.toasts.some(t => t.includes('그대로')) && ctx.saved.length === 0);
}
{
  // CRM 자동 일정은 CRM 기간을 따라가므로 여기서 바꾸지 않는다
  const auto = [dep('k0', '2026-12-01', { note: 'CRM 담당자 자동 반영 · TT1', ticketNo: 'TT1' }),
                dep('k1', '2026-12-02', { note: 'CRM 담당자 자동 반영 · TT1', ticketNo: 'TT1' })];
  const { ui, ctx } = makeUi(auto);
  await ui.change('k0', '2026-12-08', '2026-12-09');
  ok('CRM 자동 일정은 차단 + 안내', ctx.saved.length === 0 && ctx.toasts.some(t => t.includes('CRM')));
}

// ── [3] 일정 수정 시 날짜 유지 ───────────────────────────────────────────
console.log('\n[3] 일정 수정 시 원래 날짜 유지');
const se = cut(hjs, 'saveEvent');
ok('수정이면 원래 일정의 날짜 사용', /date:\s*editingEv \? editingEv\.date/.test(se));
ok('신규는 기존 방식(추가 위치/선택 날짜)', /addContext \? addContext\.date : selectedDate\(\)/.test(se));
ok('수정 창에 기간 변경 영역', hsrc.includes('id="periodGroup"') && hsrc.includes('changeAssignmentPeriod()'));
ok('수정 창 열 때 기간 영역 갱신', /renderPeriodGroup\(ev\)/.test(cut(hjs, 'openEventModal')));
ok('아웃룩 일정에는 기간 변경 숨김', /!isOwnDeploy\(ev\)\) \{ box\.style\.display = 'none'/.test(cut(hjs, 'renderPeriodGroup')));

// ── [4] 서버 ─────────────────────────────────────────────────────────────
console.log('\n[4] 서버 — 이력 기간 메모 · 여러 날 집계');
const periodMemo = new Function(cut(wsrc, 'periodMemo') + '; return periodMemo;')();
ok('기존 기간 교체', periodMemo('2026. 11. 16. 오후 3:55:52 · 기간 2026-11-23~2026-11-27', '2026-11-30', '2026-12-04')
   === '2026. 11. 16. 오후 3:55:52 · 기간 2026-11-30~2026-12-04');
ok('기간 없으면 덧붙임', periodMemo('2026. 6. 4. 오후 1:13:40', '2026-12-01', '2026-12-01') === '2026. 6. 4. 오후 1:13:40 · 기간 2026-12-01~2026-12-01');
ok('빈 메모', periodMemo('', '2026-12-01', '2026-12-02') === '기간 2026-12-01~2026-12-02');
ok('update-spinlog 액션 존재', /case 'update-spinlog'/.test(wsrc));
ok('update-spinlog 은 이력 DB 소속 확인', /case 'update-spinlog'[\s\S]{0,200}assertPageInDb\(env, body\?\.pageId, env\.SPINLOG_DB_ID\)/.test(wsrc));
ok('update-spinlog 날짜 형식 검사', /case 'update-spinlog'[\s\S]{0,500}기간 형식 오류/.test(wsrc));

const annotate = new Function('notion', 'parseNotionSchedule', 'console',
  cut(wsrc, 'annotateSpinLogs') + '; return annotateSpinLogs;')(
  async () => ({ json: async () => ({ results: [
    ...['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'].map((d, i) => ({ _d: {
      memberId: 4, date: d, type: 'deploy', title: '배포지원', ticketNo: null, fromOutlook: false,
      spinLogPageId: i === 0 ? 'S1' : null } })),
    { _d: { memberId: 4, date: '2026-12-02', type: 'deploy', title: '다른 업무', ticketNo: null, fromOutlook: false, spinLogPageId: null } },
    { _d: { memberId: 8, date: '2026-12-01', type: 'deploy', title: '배포지원', ticketNo: null, fromOutlook: false, spinLogPageId: null } },
    { _d: { memberId: 2, date: '2026-10-01', type: 'deploy', title: '단일', ticketNo: null, fromOutlook: false, spinLogPageId: 'S3' } },
  ], has_more: false }) }),
  p => p._d, console);
const logs = [
  { id: 'S1', memberId: 4, targetDate: '2026-11-30', spunAt: '2026. 11. 16. · 기간 2026-11-30~2026-12-04' },
  { id: 'S3', memberId: 2, targetDate: '2026-10-01', spunAt: '2026. 9. 30.' },
];
await annotate({ SCHEDULES_DB_ID: 'db' }, logs);
ok('여러 날 배정을 전부 집계 (5일)', logs[0].confirmedDays === 5 && logs[0].confirmedRange === '2026-11-30~2026-12-04',
   `${logs[0].confirmedDays} ${logs[0].confirmedRange}`);
ok('다른 업무·다른 사람 일정은 미포함', logs[0].confirmedDays === 5);
ok('기간 메모 없는 기록은 기존대로', logs[1].confirmedDays === 1 && logs[1].confirmedRange === '2026-10-01');

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
