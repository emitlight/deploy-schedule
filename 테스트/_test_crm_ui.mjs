// CRM 티켓 리스트 UI 검증 — 최소 DOM 스텁 위에서 실제 index.html 함수 실행
import fs from 'fs';
const hjs=[...fs.readFileSync('index.html','utf8').matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const els=new Map(), mk=id=>({id,value:'',textContent:'',innerHTML:'',disabled:false,title:'',
 style:{setProperty(){},removeProperty(){},getPropertyValue(){return''},display:''},dataset:{},children:[],
 classList:{_s:new Set(),add(...c){c.forEach(x=>this._s.add(x))},remove(...c){c.forEach(x=>this._s.delete(x))},
 toggle(c,f){f?this._s.add(c):this._s.delete(c)},contains(c){return this._s.has(c)}},
 appendChild(){},querySelector(){return null},querySelectorAll(){return[]},addEventListener(){},
 getBoundingClientRect(){return{width:800,height:600,top:0,left:0}},getContext(){return new Proxy({},{get:()=>()=>{}})},
 get className(){return[...this.classList._s].join(' ')},set className(v){this.classList._s=new Set(String(v).split(/\s+/).filter(Boolean))}});
globalThis.document={getElementById:id=>{if(!els.has(id))els.set(id,mk(id));return els.get(id)},
 querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>mk('t'),addEventListener(){},body:mk('b'),documentElement:mk('h')};
const st=new Map();
globalThis.window={fetch:(...a)=>globalThis.fetch(...a),addEventListener(){},innerWidth:1400,open(){return{}},location:{reload(){}}};
globalThis.localStorage={getItem:k=>st.has(k)?st.get(k):null,setItem:(k,v)=>st.set(k,String(v)),removeItem:k=>st.delete(k)};
globalThis.alert=()=>{};globalThis.confirm=()=>true;globalThis.prompt=()=>null;
globalThis.requestAnimationFrame=()=>0;globalThis.marked={parse:s=>s};
const short=s=>String(s).replace(/data:text\/javascript,[^\s)]+/g,'<module>');
process.on('uncaughtException',e=>{console.error('UNCAUGHT:',short(e.message));process.exit(1)});

const TICKET={ticketId:'1796791',ticketNo:'TT125192',
 title:'배포관리요청서_1-25080435_KB국민은행_문서암호화솔루션_업그레이드구매_061012',
 status:'담당할당',assignee:'김정환',account:'KB국민은행',requester:'이광진',
 projectCode:'1-25080435',periodFrom:'2026-10-19',periodTo:'2026-11-16',
 createdKst:'2026-10-13',url:'https://crm.softcamp.co.kr/index.php?module=HelpDesk&action=DetailView&record=1796791'};
globalThis.fetch=async(u,init)=>{
 const a=init?.headers?.['X-Action'];
 let o={ok:true};
 if(a==='get-crm-tickets')o={ok:true,tickets:[TICKET],syncedAt:new Date().toISOString(),ageHours:0.1,source:'partnercenter-cron',configured:true};
 else if(a==='get-roster')o={ok:true,members:[{id:8,name:'김정환',extra:false}],config:{includeExtra:false,editable:true}};
 return new Response(JSON.stringify(o),{status:200,headers:{'Content-Type':'application/json'}});};

const patched=hjs.replace(/const WORKER_URL = [^;]+;/,`const WORKER_URL='http://x/api';`)
 .replace(/\bdocument\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/g,'');
const M=await import('data:text/javascript,'+encodeURIComponent(patched+`
;export const api={loadCrmTickets,renderCrmTickets,ticketAssignment,assignFromTicket,openMailtoLink,
 get crmTickets(){return crmTickets},setEvents(v){events=v},get pendingTicket(){return pendingTicket},
 setPendingTicket(v){pendingTicket=v}};`));
const A=M.api;
let p=0,f=0;const ok=(l,c,x='')=>{console.log(`  ${c?'✅':'❌'} ${l}${c?'':'  '+x}`);c?p++:f++};

console.log('\n[1] 티켓 로드·렌더');
A.setEvents([]);
await A.loadCrmTickets();
ok('티켓 1건 수신',A.crmTickets.length===1);
const box=document.getElementById('crmTickets');
ok('영역 표시',box.style.display==='block',box.style.display);
ok('티켓번호 표시',/TT125192/.test(box.innerHTML));
ok('고객사 표시',/KB국민은행/.test(box.innerHTML));
ok('요청 기간 표시',/2026-10-19 ~ 2026-11-16/.test(box.innerHTML));
ok('프로젝트코드 표시',/1-25080435/.test(box.innerHTML));
ok('CRM 링크',/crm\.softcamp\.co\.kr/.test(box.innerHTML));
ok('미배정이면 "배정 필요"',/배정 필요/.test(box.innerHTML));
ok('배정 버튼 노출',/이 티켓으로 배정/.test(box.innerHTML));

console.log('\n[2] 배정 후 상태 전환');
A.setEvents([{id:'e1',type:'deploy',fromOutlook:false,memberId:8,date:'2026-10-19',ticketNo:'TT125192'},
             {id:'e2',type:'deploy',fromOutlook:false,memberId:8,date:'2026-11-16',ticketNo:'TT125192'}]);
A.renderCrmTickets();
const h2=document.getElementById('crmTickets').innerHTML;
ok('배정됨 배지',/배정됨/.test(h2));
ok('담당자 이름 표시',/김정환/.test(h2));
ok('배정 버튼 사라짐',!/이 티켓으로 배정/.test(h2));
const a=A.ticketAssignment('TT125192');
ok('배정 기간 집계',a&&a.from==='2026-10-19'&&a.to==='2026-11-16'&&a.days===2,JSON.stringify(a));
ok('다른 티켓은 미배정',A.ticketAssignment('TT999999')===null);

console.log('\n[3] 메일에 티켓 정보 포함');
let captured='';
globalThis.window.open=(u)=>{captured=decodeURIComponent(u);return{}};
A.openMailtoLink('김정환','2026-10-19 ~ 2026-11-16','09:00','18:00','배포지원','',TICKET);
ok('제목에 고객사',/KB국민은행/.test(captured));
ok('본문에 티켓번호',/배포지원요청티켓: TT125192/.test(captured));
ok('본문에 프로젝트코드',/프로젝트코드: 1-25080435/.test(captured));
ok('본문에 티켓 링크',/crm\.softcamp\.co\.kr/.test(captured));
captured='';
A.openMailtoLink('김정환','2026-10-19','09:00','18:00','배포지원');
ok('티켓 없으면 기존 형식 유지',!/배포지원요청티켓/.test(captured)&&/배포 내용/.test(captured));

console.log('\n[4] 동기화가 오래됐을 때 경고');
globalThis.fetch=async(u,init)=>new Response(JSON.stringify(
 init?.headers?.['X-Action']==='get-crm-tickets'
  ?{ok:true,tickets:[],syncedAt:'2026-10-01T00:00:00Z',ageHours:320,configured:true}:{ok:true}),
 {status:200,headers:{'Content-Type':'application/json'}});
await A.loadCrmTickets();
const h4=document.getElementById('crmTickets').innerHTML;
ok('오래됨 경고 표시',/경과/.test(h4),h4.slice(0,160));
ok('빈 목록 안내',/티켓이 없습니다/.test(h4));

console.log(`\n=== 통과 ${p} / 실패 ${f} ===`);process.exit(f?1:0);
