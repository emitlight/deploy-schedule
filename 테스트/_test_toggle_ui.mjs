// 화면의 '추가 인원' 버튼 동작 검증 — 최소 DOM 스텁 위에서 실제 index.html 함수 실행
import fs from 'fs';

const hsrc = fs.readFileSync('index.html', 'utf8');
const hjs = [...hsrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

const els = new Map();
const mkEl = id => ({
  id, value: '', textContent: '', innerHTML: '', disabled: false, title: '',
  style: { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } },
  dataset: {}, children: [], offsetWidth: 800, offsetHeight: 600,
  classList: { _s: new Set(), add(...c){c.forEach(x=>this._s.add(x));},
    remove(...c){c.forEach(x=>this._s.delete(x));},
    toggle(c,f){ f ? this._s.add(c) : this._s.delete(c); }, contains(c){return this._s.has(c);} },
  appendChild(){}, querySelector(){ return null; }, querySelectorAll(){ return []; },
  addEventListener(){}, getBoundingClientRect(){ return {width:800,height:600,top:0,left:0}; },
  getContext(){ return new Proxy({}, { get: () => () => {} }); },
  get className(){ return [...this.classList._s].join(' '); },
  set className(v){ this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
});
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl('t'),
  addEventListener: () => {}, body: mkEl('body'), documentElement: mkEl('html'),
};
const store = new Map();
globalThis.window = { fetch: (...a) => globalThis.fetch(...a), addEventListener(){},
  innerWidth: 1400, open(){ return {}; }, location: { reload(){} } };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) };
globalThis.alert = () => {}; globalThis.confirm = () => true; globalThis.prompt = () => null;
globalThis.requestAnimationFrame = () => 0; globalThis.marked = { parse: s => s };
const shorten = s => String(s).replace(/data:text\/javascript,[^\s)]+/g, '<module>');
process.on('uncaughtException', e => { console.error('UNCAUGHT:', shorten(e.message)); process.exit(1); });

// ── 가짜 서버 (KV 있음 / 없음 전환 가능) ────────────────────────────────
const ROSTER8 = [1,2,3,4,5,6,7,8].map(id => ({ id, name: `M${id}`, extra: false }));
const EXTRA3  = [9,10,11].map(id => ({ id, name: `E${id}`, extra: true }));
let kvConnected = true, includeExtraSrv = false, toasts = [];
globalThis.fetch = async (url, init) => {
  const action = init?.headers?.['X-Action'];
  const body = init?.body ? JSON.parse(init.body) : {};
  const members = includeExtraSrv ? ROSTER8.concat(EXTRA3) : ROSTER8;
  const config = { includeExtra: includeExtraSrv, editable: kvConnected,
                   source: kvConnected ? 'kv' : 'env', updatedAt: '2026-10-13T08:00:00Z', updatedBy: '대시보드' };
  let out = { ok: true };
  if (action === 'get-roster') out = { ok: true, members, config };
  else if (action === 'set-roster-config') {
    if (!kvConnected) return new Response(JSON.stringify({ ok:false,
      error:'서버에 공유 설정 저장소(KV)가 연결돼 있지 않습니다.' }), { status: 501 });
    includeExtraSrv = !!body.includeExtra;
    const m2 = includeExtraSrv ? ROSTER8.concat(EXTRA3) : ROSTER8;
    out = { ok:true, members: m2, config: { ...config, includeExtra: includeExtraSrv } };
  }
  else if (action === 'get-spinlog') out = { ok:true, logs: [] };
  else if (action === 'load-events') out = { ok:true, events: [] };
  else if (action === 'sync-outlook') out = { ok:true, events: [] };
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type':'application/json' } });
};

const patched = hjs
  .replace(/const WORKER_URL = [^;]+;/, `const WORKER_URL = 'http://x/api';`)
  .replace(/\bdocument\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/g, '')
  .replace(/function showToast\(msg\) \{/, 'function showToast(msg) { globalThis.__toast(msg);');
globalThis.__toast = m => toasts.push(m);

const M = await import('data:text/javascript,' + encodeURIComponent(patched + `
;export const api = { toggleExtra, loadServerRoster, updateExtraBtn, pool,
  get includeExtra(){return includeExtra;}, get serverRoster(){return serverRoster;},
  get rosterConfig(){return rosterConfig;} };`));
const A = M.api;
const btn = () => document.getElementById('extraBtn');

let pass = 0, fail = 0;
const ok = (l, c, x='') => { console.log(`  ${c?'✅':'❌'} ${l}${c?'':'  '+x}`); c?pass++:fail++; };

console.log('\n[1] 서버 공유 저장소 연결됨 — 버튼이 실제로 동작');
await A.loadServerRoster();
ok('초기 8명', A.pool().length === 8, String(A.pool().length));
ok('버튼 라벨이 "포함"을 안내', /포함/.test(btn().textContent), btn().textContent);
ok('툴팁에 "모든 PC에 반영" 명시', /모든 PC에 반영/.test(btn().title), btn().title);

toasts = [];
await A.toggleExtra();
ok('토글 후 11명', A.pool().length === 11, String(A.pool().length));
ok('서버에 저장됨', includeExtraSrv === true);
ok('버튼 라벨이 "제외"로 전환', /제외/.test(btn().textContent), btn().textContent);
ok('토스트에 "모든 PC 반영"', toasts.some(t => /모든 PC 반영/.test(t)), JSON.stringify(toasts));
ok('버튼 다시 활성화', btn().disabled === false);

toasts = [];
await A.toggleExtra();
ok('되돌리면 8명', A.pool().length === 8, String(A.pool().length));
ok('서버도 되돌아감', includeExtraSrv === false);

console.log('\n[2] 다른 PC가 열면 같은 설정이 보인다');
includeExtraSrv = true;
await A.loadServerRoster();
ok('새로 열어도 11명', A.pool().length === 11, String(A.pool().length));

console.log('\n[3] 저장소 미연결 — 기능은 되되 "이 PC만"이라고 알린다');
kvConnected = false; includeExtraSrv = false;
await A.loadServerRoster();
ok('편집 불가로 인식', A.rosterConfig?.editable === false);
ok('툴팁에 미연결 안내', /이 PC에만 적용/.test(btn().title), btn().title);
toasts = [];
await A.toggleExtra();
ok('그래도 토글은 동작', A.pool().length === 11, String(A.pool().length));
ok('"이 PC에만 적용" 경고', toasts.some(t => /이 PC에만 적용/.test(t)), JSON.stringify(toasts));

console.log(`\n=== 통과 ${pass} / 실패 ${fail} ===`);
process.exit(fail ? 1 : 0);
