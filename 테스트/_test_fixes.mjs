// 2026-10-14 개선 3건 검증
//  1) 이미 배정된 기간에서도 룰렛을 돌릴 수 있는가 (차단 → 안내로 완화)
//  2) 스핀 이력의 '배정 완료 / 추첨만 됨' 판별
//  3) 추가 인원 토글: 저장 직후 응답이 방금 쓴 값인가 (KV 지연 대응)
import fs from 'fs';

const wsrc = fs.readFileSync('cloudflare-worker.js', 'utf8');
const hsrc = fs.readFileSync('index.html', 'utf8');
const hjs = [...hsrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

let pass = 0, fail = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? pass++ : fail++; };

// ── 1. 룰렛 차단 해제 ────────────────────────────────────────────────────
console.log('\n[1] 이미 배정된 기간에서도 돌릴 수 있는가');
ok('스핀 버튼을 비활성화하지 않음', !/spinBtnEl\.disabled = true;\s*\n\s*spinBtnEl\.textContent = '⛔/.test(hjs));
ok("'⛔ 이미 배정됨 — 취소 후 가능' 문구 제거", !hjs.includes('⛔ 이미 배정됨'));
ok('안내 영역(rrAssignedNotice)으로 대체', hsrc.includes('id="rrAssignedNotice"'));
ok('안내 문구가 추가 투입 가능함을 알림', /추가로 투입하려면 그대로 돌리/.test(hjs));
ok('가용 0명일 때는 별도 안내', /추가로 가능한 인원이 없습니다/.test(hjs));
ok('배정 확정 시 추가 투입 재확인', /추가로 투입할까요/.test(hjs));
ok('안내 스타일 정의됨', hsrc.includes('.rr-assigned-notice'));

// ── 2. 스핀 이력 상태 판별 (서버 로직) ───────────────────────────────────
console.log('\n[2] 배정 완료 / 추첨만 됨 판별');
const cut = (src, n) => {
  const i = src.indexOf(`async function ${n}(`) >= 0 ? src.indexOf(`async function ${n}(`) : src.indexOf(`function ${n}(`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};
const annotate = new Function('notion', 'parseNotionSchedule', 'console',
  cut(wsrc, 'annotateSpinLogs') + '; return annotateSpinLogs;')(
  // notion() 스텁: 배포 일정 2건을 돌려준다
  async () => ({ json: async () => ({ results: [
    { _d: { memberId: 2, date: '2026-07-21', type: 'deploy', title: 'TT 고객사 배포',
            spinLogPageId: 'log-confirmed', fromOutlook: false } },
    { _d: { memberId: 4, date: '2026-08-11', type: 'deploy', title: '구버전 배정(연결없음)',
            spinLogPageId: null, fromOutlook: false } },
  ], has_more: false }) }),
  p => p._d, console);

const logs = [
  { id: 'log-confirmed', name: '이하영', memberId: 2, targetDate: '2026-07-21', spunAt: '배정 완료' },
  { id: 'log-spinonly',  name: '김정환', memberId: 8, targetDate: '2026-09-01', spunAt: '2026. 9. 1.' },
  { id: 'log-legacy',    name: '김선우', memberId: 4, targetDate: '2026-08-11', spunAt: '2026. 8. 11.' },
  { id: 'log-cancel',    name: '[취소] 윤이나', memberId: null, targetDate: '2026-08-24', spunAt: '취소된 배정' },
];
await annotate({ SCHEDULES_DB_ID: 'db' }, logs);
ok('연결된 일정이 있으면 배정 완료', logs[0].confirmed === true);
ok('완료 건의 기간 표기', logs[0].confirmedRange === '2026-07-21', String(logs[0].confirmedRange));
ok('일정 없으면 추첨만 됨', logs[1].confirmed === false);
ok('구 기록도 멤버+날짜로 매칭', logs[2].confirmed === true);
ok('취소 로그는 판정 제외', logs[3].confirmed === undefined);

console.log('\n[2-b] 화면 표시');
ok('✅ 배정 완료 배지', hjs.includes('✅ 배정 완료'));
ok('추첨만 됨 배지', hjs.includes('추첨만 됨'));
ok('완료 배지에 기간 툴팁', /배포 일정이 등록된 건입니다/.test(hjs));

// ── 3. KV 지연 대응 ──────────────────────────────────────────────────────
console.log('\n[3] 추가 인원 토글 — 저장 직후 응답');
const setBlock = wsrc.slice(wsrc.indexOf("case 'set-roster-config'"), wsrc.indexOf("case 'set-roster-config'") + 900);
ok('저장 후 KV 재조회 안 함', !/await readSettings\(env\)/.test(setBlock), setBlock.slice(0, 200));
ok('방금 저장한 값을 응답', /saved\.includeExtra/.test(setBlock));
ok('KV 지연 이유를 주석으로 남김', /최대 1분/.test(setBlock));
ok('안내를 렌더링보다 먼저 표시', hjs.indexOf('모든 PC 반영됨') < hjs.indexOf('applyRosterResponse(r);\n  } catch'));
ok('서버 오류 메시지를 그대로 노출', /r\.error \? r\.error/.test(hjs));

console.log(`\n=== 통과 ${pass} / 실패 ${fail} ===`);
process.exit(fail ? 1 : 0);
