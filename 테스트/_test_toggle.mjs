// 추가 인원 토글 복구 검증: 서버 공유 저장(KV) 동작 + 미연결 시 폴백
import fs from 'fs';
const wsrc = fs.readFileSync('cloudflare-worker.js', 'utf8');

const cut = (src, n) => {
  const i = src.indexOf(`function ${n}(`);
  const j = src.indexOf(`async function ${n}(`);
  const start = j >= 0 && (i < 0 || j < i) ? j : i;
  if (start < 0) throw new Error('not found: ' + n);
  let d = 0;
  for (let k = src.indexOf('{', start); k < src.length; k++) {
    if (src[k] === '{') d++;
    if (src[k] === '}' && --d === 0) return src.slice(start, k + 1);
  }
};
const code = [
  wsrc.match(/const SETTINGS_KEY\s*=\s*[^;]*;/)[0],
  wsrc.match(/const EXTRA_MEMBERS = \{[\s\S]*?\};/)[0],
  cut(wsrc, 'readSettings'), cut(wsrc, 'writeSettings'), cut(wsrc, 'buildRoster'),
  'export { readSettings, writeSettings, buildRoster };',
].join('\n');
const W = await import('data:text/javascript,' + encodeURIComponent(code));

// KV 흉내
const mkKV = () => { const m = new Map(); return {
  get: async k => (m.has(k) ? m.get(k) : null),
  put: async (k, v) => { m.set(k, v); },
  _dump: () => Object.fromEntries(m),
}; };

const EM = JSON.stringify({ '이송민':'a@x','이하영':'b@x','강진혁':'c@x','김선우':'d@x',
  '김요엘':'e@x','윤이나':'f@x','이정기':'g@x','김정환':'h@x' });
const IDS = JSON.stringify({ '이송민':1,'이하영':2,'강진혁':3,'김선우':4,
  '김요엘':5,'윤이나':6,'이정기':7,'김정환':8 });

let pass = 0, fail = 0;
const ok = (l, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  ' + x}`); c ? pass++ : fail++; };

console.log('\n[1] KV 연결됨 — 토글이 서버에 저장되고 모두에게 공유');
{
  const env = { MEMBER_EMAILS: EM, MEMBER_IDS: IDS, SETTINGS: mkKV() };
  let cfg = await W.readSettings(env);
  ok('초기 상태 = 기본 8명', W.buildRoster(env, cfg.includeExtra).length === 8);
  ok('편집 가능으로 보고', cfg.editable === true);

  await W.writeSettings(env, { includeExtra: true }, '대시보드');
  cfg = await W.readSettings(env);
  const after = W.buildRoster(env, cfg.includeExtra);
  ok('토글 후 11명', after.length === 11, String(after.length));
  ok('추가 3명 포함', after.filter(m => m.extra).map(m => m.name).join(',') === '문병린,문정일,양창호');
  ok('변경자·시각 기록', !!cfg.updatedAt && cfg.updatedBy === '대시보드');
  ok('출처가 KV', cfg.source === 'kv');

  // 다른 PC(새 요청)가 같은 KV를 읽으면 같은 값
  const cfg2 = await W.readSettings({ MEMBER_EMAILS: EM, MEMBER_IDS: IDS, SETTINGS: env.SETTINGS });
  ok('다른 PC도 동일하게 11명', W.buildRoster(env, cfg2.includeExtra).length === 11);

  await W.writeSettings(env, { includeExtra: false }, '대시보드');
  ok('되돌리면 8명', W.buildRoster(env, (await W.readSettings(env)).includeExtra).length === 8);
}

console.log('\n[2] KV 미연결 — 환경변수를 읽기 전용으로 사용');
{
  const env = { MEMBER_EMAILS: EM, MEMBER_IDS: IDS };            // SETTINGS 없음
  const cfg = await W.readSettings(env);
  ok('편집 불가로 보고(화면이 안내함)', cfg.editable === false);
  ok('기본 8명', W.buildRoster(env, cfg.includeExtra).length === 8);

  const envOn = { ...env, INCLUDE_EXTRA: '1' };
  ok('INCLUDE_EXTRA=1이면 11명',
     W.buildRoster(envOn, (await W.readSettings(envOn)).includeExtra).length === 11);

  let threw = null;
  try { await W.writeSettings(env, { includeExtra: true }); } catch (e) { threw = e; }
  ok('저장 시도 시 명확한 안내와 함께 실패', !!threw && /KV|저장소/.test(threw.message), threw?.message);
  ok('상태코드 501', threw?.status === 501);
}

console.log('\n[3] KV 손상 시에도 서비스는 계속',
);
{
  const broken = { get: async () => '{ 깨진 json', put: async () => {} };
  const env = { MEMBER_EMAILS: EM, MEMBER_IDS: IDS, SETTINGS: broken };
  const cfg = await W.readSettings(env);
  ok('예외 없이 기본값으로 복귀', cfg.includeExtra === false && cfg.editable === false);
  ok('명단 정상 반환', W.buildRoster(env, cfg.includeExtra).length === 8);
}

console.log(`\n=== 통과 ${pass} / 실패 ${fail} ===`);
process.exit(fail ? 1 : 0);
