/**
 * Cloudflare Worker – 배포지원 투입관리 대시보드 API 프록시
 *
 * 환경변수 (Settings > Variables, 시크릿은 Encrypt ON):
 *  GRAPH_CLIENT_ID, GRAPH_TENANT_ID, GRAPH_CLIENT_SECRET
 *  MEMBER_EMAILS  예: {"이송민":"a@b.com","이하영":"c@d.com",...}
 *  MEMBER_IDS     예: {"이송민":1,"이하영":2,...}
 *  NOTION_SECRET, SCHEDULES_DB_ID, SPINLOG_DB_ID
 *  VTIGER_URL, VTIGER_USERNAME, VTIGER_ACCESS_KEY
 *  VTIGER_MEMBER_IDS  예: {"이송민":"19x5","이하영":"19x6",...}
 *
 * Cron Triggers (KST 기준, wrangler.toml 참고):
 *  0 22 * * *  → KST 07:00   아웃룩 자동 동기화
 *  30 3 * * *  → KST 12:30   아웃룩 자동 동기화
 *  0 6 * * *   → KST 15:00   아웃룩 자동 동기화
 */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Action',
};
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export default {
  // ── HTTP 요청 핸들러 ──────────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:CORS});
    const url    = new URL(request.url);
    const action = request.headers.get('X-Action') || url.searchParams.get('action');
    const body   = ['POST','PATCH','DELETE'].includes(request.method)
                   ? await request.json().catch(()=>({})) : null;
    try {
      let result;
      switch (action) {

        // ── 이메일 발송 (담당자에게 배포지원 배정 알림) ────────────────
        case 'send-email': {
          const { fromName, toMemberName, date, startTime, endTime, title, note } = body || {};
          if (!toMemberName) throw new Error('toMemberName 필요');

          const memberEmails = JSON.parse(env.MEMBER_EMAILS || '{}');
          const toEmail = memberEmails[toMemberName];
          if (!toEmail) throw new Error(`${toMemberName} 이메일 미설정`);

          const fromEmail = memberEmails[fromName || '이하영'] || 'hayoung.lee@softcamp.co.kr';
          const token = await getGraphToken(env);

          const subject = `[배포지원 배정] ${title || '배포지원'} 담당자로 선정되셨습니다`;
          const bodyHtml = `
            <p>안녕하세요, <b>${toMemberName}</b>님</p>
            <p>아래 배포지원 일정의 담당자로 선정되셨습니다.</p>
            <table style="border-collapse:collapse;margin:12px 0">
              <tr><td style="padding:4px 12px 4px 0;color:#666">배포 내용</td><td><b>${title || '-'}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">날짜</td><td>${date || '-'}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">시간</td><td>${startTime || '-'} ~ ${endTime || '-'}</td></tr>
              ${note ? `<tr><td style="padding:4px 12px 4px 0;color:#666">메모</td><td>${note}</td></tr>` : ''}
            </table>
            <p>일정 확인 후 문의사항은 이하영(hayoung.lee@softcamp.co.kr)에게 연락해 주세요.</p>
            <p style="color:#888;font-size:12px">본 메일은 배포지원 투입관리 시스템에서 자동 발송되었습니다.</p>
          `;

          const mailRes = await fetch(`${GRAPH_BASE}/users/${fromEmail}/sendMail`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                subject,
                body: { contentType: 'HTML', content: bodyHtml },
                toRecipients: [{ emailAddress: { address: toEmail, name: toMemberName } }],
              },
              saveToSentItems: true,
            }),
          });

          if (!mailRes.ok) {
            const err = await mailRes.json().catch(() => ({}));
            throw new Error(err?.error?.message || `메일 발송 오류 ${mailRes.status}`);
          }
          result = { ok: true, message: `${toMemberName}(${toEmail})에게 메일 발송 완료` };
          break;
        }

        // ── 아웃룩 캘린더 이벤트 생성 (배포지원 일정 초대) ─────────────
        case 'create-outlook-event': {
          const { memberName, date, startTime, endTime, title, note } = body || {};
          if (!memberName || !date || !startTime || !endTime)
            throw new Error('memberName, date, startTime, endTime 필요');

          const memberEmails = JSON.parse(env.MEMBER_EMAILS || '{}');
          const email = memberEmails[memberName];
          if (!email) throw new Error(`${memberName} 이메일 미설정 (MEMBER_EMAILS 확인)`);

          const token = await getGraphToken(env);

          // 날짜 + 시간 조합 (KST 기준)
          const startDT = `${date}T${startTime}:00`;
          const endDT   = `${date}T${endTime}:00`;

          const event = {
            subject: `[배포지원 결정] ${title || '배포지원 일정'}`,
            body: {
              contentType: 'HTML',
              content: `<p>배포지원 담당자로 배정되었습니다.</p><p><b>일정:</b> ${date} ${startTime} ~ ${endTime}</p>${note ? `<p><b>내용:</b> ${note}</p>` : ''}`,
            },
            start: { dateTime: startDT, timeZone: 'Korea Standard Time' },
            end:   { dateTime: endDT,   timeZone: 'Korea Standard Time' },
            showAs: 'busy',
            categories: ['배포지원'],
          };

          const res = await fetch(`${GRAPH_BASE}/users/${email}/events`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Graph API 오류 ${res.status}`);
          }

          const created = await res.json();
          result = {
            ok: true,
            eventId: created.id,
            webLink: created.webLink,
            message: `${memberName}(${email}) 아웃룩 일정 생성 완료`,
          };
          break;
        }

        // ── Cron과 동일한 아웃룩 자동 동기화 (수동 트리거) ──────────────
        case 'run-sync': {
          await runScheduledSync(env);
          result = {ok:true, message:'동기화 완료'};
          break;
        }

        // ── 아웃룩 캘린더 동기화 (수동) ─────────────────────────────────
        case 'sync-outlook': {
          const { startDate, endDate } = body||{};
          if (!startDate||!endDate) throw new Error('startDate, endDate 필요');
          result = await syncOutlook(env, startDate, endDate);
          break;
        }

        // ── 캘린더 접근 테스트 ───────────────────────────────────────────
        case 'list-calendars': {
          const token=await getGraphToken(env);
          const memberEmails=JSON.parse(env.MEMBER_EMAILS||'{}');
          const results=[];
          for (const [name,email] of Object.entries(memberEmails)) {
            try {
              const res=await fetch(`${GRAPH_BASE}/users/${email}/calendar`,
                {headers:{'Authorization':`Bearer ${token}`}});
              if (res.ok) results.push({name,email,status:'ok'});
              else {const e=await res.json().catch(()=>({}));
                results.push({name,email,status:'error',error:e?.error?.message||`HTTP ${res.status}`});}
            } catch(e) { results.push({name,email,status:'error',error:e.message}); }
          }
          return new Response(JSON.stringify(results),
            {headers:{...CORS,'Content-Type':'application/json'}});
        }

        // ── Notion에서 일정 불러오기 ─────────────────────────────────────
        case 'load-events': {
          if (!env.NOTION_SECRET||!env.SCHEDULES_DB_ID) throw new Error('Notion 미설정');
          const allPages = [];
          let cursor = undefined;
          while (true) {
            const payload = {page_size:200};
            if (cursor) payload.start_cursor = cursor;
            const res = await notion(env,'POST',`/databases/${env.SCHEDULES_DB_ID}/query`,payload);
            const data = await res.json();
            allPages.push(...(data.results||[]));
            if (!data.has_more) break;
            cursor = data.next_cursor;
          }
          const events = allPages.map(parseNotionSchedule).filter(Boolean);
          result = {ok:true, events, count:events.length};
          break;
        }

        // ── Notion에 일정 저장 (신규/수정) ──────────────────────────────
        case 'save-event': {
          if (!env.NOTION_SECRET||!env.SCHEDULES_DB_ID) throw new Error('Notion 미설정');
          if (body.pageId) {
            // 수정
            const res=await notion(env,'PATCH',`/pages/${body.pageId}`,
              {properties:notionScheduleProps(body)});
            const page=await res.json();
            result={ok:true,pageId:page.id,event:parseNotionSchedule(page)};
          } else {
            // 신규
            const res=await notion(env,'POST','/pages',
              {parent:{database_id:env.SCHEDULES_DB_ID},properties:notionScheduleProps(body)});
            const page=await res.json();
            result={ok:true,pageId:page.id,event:parseNotionSchedule(page)};
          }
          break;
        }

        // ── Notion 일정 삭제 (아카이브) ──────────────────────────────────
        case 'delete-event': {
          if (!env.NOTION_SECRET) throw new Error('Notion 미설정');
          if (!body.pageId) throw new Error('pageId 필요');
          const res=await notion(env,'PATCH',`/pages/${body.pageId}`,{archived:true});
          result=await res.json();
          result={ok:true};
          break;
        }

        // ── 배포지원 분류 수동 설정 (Notion 저장 → 모두에게 공유) ──────────
        // SCHEDULES_DB의 '배포분류' Select에 저장. run-sync는 자기 속성만 PATCH하므로
        // 재동기화해도 이 값은 보존됨. classification: '가능'|'불가'|'긴급' 또는 빈값(해제)
        case 'set-classification': {
          if (!env.NOTION_SECRET||!env.SCHEDULES_DB_ID) throw new Error('Notion 미설정');
          if (!body.pageId) throw new Error('pageId 필요');
          // '배포분류' 속성 보장 (없으면 생성 — idempotent, 실패해도 무시)
          await notion(env,'PATCH',`/databases/${env.SCHEDULES_DB_ID}`,
            {properties:{'배포분류':{select:{options:[{name:'가능'},{name:'불가'},{name:'긴급'}]}}}}).catch(()=>{});
          const val=body.classification;
          await notion(env,'PATCH',`/pages/${body.pageId}`,
            {properties:{'배포분류': val ? {select:{name:val}} : {select:null}}});
          result={ok:true};
          break;
        }

        // ── 스핀 이력 추가 ───────────────────────────────────────────────
        case 'add-spinlog': {
          if (!env.NOTION_SECRET||!env.SPINLOG_DB_ID) throw new Error('Notion 미설정');
          const props={
            'NAME':   {title:[{text:{content:body.name||''}}]},
            'DATE':   {date:{start:body.targetDate||''}},
            'SPUNAT': {rich_text:[{text:{content:body.spunAt||''}}]},
          };
          if (body.memberId) props['MEMBERID']={number:Number(body.memberId)};
          const res=await notion(env,'POST','/pages',
            {parent:{database_id:env.SPINLOG_DB_ID},properties:mapSpinProps(props)});
          const page=await res.json();
          result={ok:true, pageId:page.id}; break;
        }

        // ── 당첨자 초기화 로그 기록 ─────────────────────────────────────
        case 'add-resetlog': {
          if (!env.NOTION_SECRET||!env.SPINLOG_DB_ID) throw new Error('Notion 미설정');
          const props={
            'NAME':   {title:[{text:{content:`[초기화] ${body.name||''}`}}]},
            'DATE':   {date:{start:body.targetDate||new Date().toISOString().slice(0,10)}},
            'SPUNAT': {rich_text:[{text:{content:body.resetAt||''}}]},
            // ⚠️ MEMBERID 의도적으로 제외 → rrOrder 우선순위 계산에 영향 없음
          };
          const res=await notion(env,'POST','/pages',
            {parent:{database_id:env.SPINLOG_DB_ID},properties:mapSpinProps(props)});
          const page=await res.json();
          result={ok:true, pageId:page.id}; break;
        }

        // ── 스핀 이력 조회 ───────────────────────────────────────────────
        // ── 스핀 이력 삭제 (배포 취소/변경 시 우선순위 복구) ────────────
        case 'delete-spinlog': {
          if (!env.NOTION_SECRET) throw new Error('Notion 미설정');
          if (!body?.pageId) throw new Error('pageId 필요');
          await notion(env, 'PATCH', `/pages/${body.pageId}`, {archived: true});
          result = {ok: true};
          break;
        }

        case 'get-spinlog': {
          if (!env.NOTION_SECRET||!env.SPINLOG_DB_ID) throw new Error('Notion 미설정');
          const res=await notion(env,'POST',`/databases/${env.SPINLOG_DB_ID}/query`,
            {sorts:[{timestamp:'created_time',direction:'descending'}],page_size:200});
          const data=await res.json();
          const logs=(data.results||[]).map(p=>{
            const pr=p.properties||{};
            return {
              name:       getNotionText(pr,'이름'),
              targetDate: pr['날짜']?.date?.start||'',
              spunAt:     getNotionRichText(pr,'스핀일'),
              memberId:   pr['멤버ID']?.number??null,
              createdTime:p.created_time,
            };
          });
          result={ok:true,logs}; break;
        }

        // ── vtiger: 티켓 조회 ────────────────────────────────────────────
        case 'vtiger-get-ticket': {
          if (!env.VTIGER_URL||!env.VTIGER_USERNAME||!env.VTIGER_ACCESS_KEY)
            throw new Error('vtiger 미설정: VTIGER_URL/VTIGER_USERNAME/VTIGER_ACCESS_KEY');
          const tid=(body?.ticketId||'').toString().trim();
          if (!tid) throw new Error('ticketId 필요');
          const vId=tid.includes('x')?tid:`HelpDesk:${tid}`;
          const sess=await vtigerAuth(env);
          const data=await vtigerCall(env,sess,'GET',{operation:'retrieve',id:vId});
          if (!data.success) throw new Error(data.error?.message||'티켓 조회 실패');
          const t=data.result;
          result={ok:true,id:t.id,
            title:t.ticket_title||t.title||'',
            status:t.ticketstatus||t.status||'',
            assigneeId:t.assigned_user_id||'',
            ticketUrl:`${env.VTIGER_URL.replace(/\/$/,'')}/index.php?module=HelpDesk&action=DetailView&record=${(t.id||'').split('x')[1]||tid}`};
          break;
        }

        // ── vtiger: 담당자 변경 ──────────────────────────────────────────
        case 'vtiger-update-ticket': {
          if (!env.VTIGER_URL||!env.VTIGER_USERNAME||!env.VTIGER_ACCESS_KEY)
            throw new Error('vtiger 미설정');
          const {ticketId:tId,memberName,vtigerUserId}=body||{};
          if (!tId) throw new Error('ticketId 필요');
          let assignedTo=vtigerUserId||'';
          if (!assignedTo && memberName && env.VTIGER_MEMBER_IDS) {
            const map=JSON.parse(env.VTIGER_MEMBER_IDS||'{}');
            assignedTo=map[memberName]||'';
          }
          if (!assignedTo) throw new Error('vtiger 사용자 ID 미확인 — VTIGER_MEMBER_IDS 환경변수를 설정하세요');
          const vId2=tId.toString().includes('x')?tId:`HelpDesk:${tId}`;
          const sess2=await vtigerAuth(env);
          const cur=await vtigerCall(env,sess2,'GET',{operation:'retrieve',id:vId2});
          if (!cur.success) throw new Error(cur.error?.message||'티켓 조회 실패');
          const updated={...cur.result,assigned_user_id:assignedTo};
          const upRes=await vtigerCall(env,sess2,'POST',
            {operation:'update',element:JSON.stringify(updated)});
          if (!upRes.success) throw new Error(upRes.error?.message||'담당자 변경 실패');
          result={ok:true,ticket:upRes.result}; break;
        }

        // ── vtiger: 연결 테스트 ────────────────────────────────────────────
        case 'vtiger-test': {
          const base = (env.VTIGER_URL||'').replace(/\/$/,'');
          const testUrl = `${base}/webservice.php?operation=getchallenge&username=${encodeURIComponent(env.VTIGER_USERNAME||'')}`;
          const raw = await fetch(testUrl, {headers: VTIGER_HEADERS});
          const text = await raw.text();
          result = {
            ok: true,
            http_status: raw.status,
            url_called: testUrl,
            vtiger_url_env: env.VTIGER_URL,
            username_env: env.VTIGER_USERNAME,
            response_preview: text.slice(0, 300),
            is_json: text.trim().startsWith('{') || text.trim().startsWith('['),
          };
          break;
        }

        // ── vtiger: 사용자 목록 (VTIGER_MEMBER_IDS 설정용) ──────────────
        case 'vtiger-list-users': {
          if (!env.VTIGER_URL||!env.VTIGER_USERNAME||!env.VTIGER_ACCESS_KEY)
            throw new Error('vtiger 미설정');
          const sess3=await vtigerAuth(env);
          const qRes=await vtigerCall(env,sess3,'GET',{
            operation:'query',
            query:'SELECT id,user_name,first_name,last_name,email1 FROM Users;',
          });
          if (!qRes.success) throw new Error(qRes.error?.message||'사용자 조회 실패');
          result={ok:true,users:(qRes.result||[]).map(u=>({
            id:u.id, username:u.user_name,
            name:`${u.last_name}${u.first_name}`, email:u.email1,
          }))};
          break;
        }

        default:
          return new Response(JSON.stringify({error:`Unknown action: ${action}`}),
            {status:400,headers:{...CORS,'Content-Type':'application/json'}});
      }
      return new Response(JSON.stringify(result),
        {headers:{...CORS,'Content-Type':'application/json'}});
    } catch(e) {
      return new Response(JSON.stringify({error:e.message}),
        {status:500,headers:{...CORS,'Content-Type':'application/json'}});
    }
  },

  // ── Cron Trigger 핸들러 (자동 아웃룩 동기화) ──────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};

// ── 자동 동기화: 현재 ±4주 아웃룩 → Notion SCHEDULES_DB ──────────────────
async function runScheduledSync(env) {
  if (!env.GRAPH_CLIENT_ID || !env.NOTION_SECRET || !env.SCHEDULES_DB_ID) return;
  const now   = new Date();
  const start = new Date(now); start.setUTCDate(start.getUTCDate() - 28);
  const end   = new Date(now); end.setUTCDate(end.getUTCDate() + 28);
  const startDate = start.toISOString().slice(0,10);
  const endDate   = end.toISOString().slice(0,10);

  try {
    // 1) 아웃룩에서 새 이벤트 목록 가져오기
    const {events: newEvents} = await syncOutlook(env, startDate, endDate);

    // 2) Notion에서 기간 내 아웃룩 이벤트 기존 목록 가져오기
    const existingPages = await loadNotionEventsByRange(env, startDate, endDate, true);
    const existingMap = {};
    for (const p of existingPages) {
      const oid = getNotionRichText(p.properties,'아웃룩ID');
      if (oid) existingMap[oid] = p.id;
    }

    // 3) Upsert: 새 이벤트 → Notion 저장
    const newOids = new Set();
    for (const ev of newEvents) {
      if (!ev.id) continue;
      newOids.add(ev.id);
      const payload = {...ev, fromOutlook:true};
      if (existingMap[ev.id]) {
        // 업데이트
        await notion(env,'PATCH',`/pages/${existingMap[ev.id]}`,
          {properties:notionScheduleProps(payload)});
      } else {
        // 신규 생성
        await notion(env,'POST','/pages',
          {parent:{database_id:env.SCHEDULES_DB_ID},properties:notionScheduleProps(payload)});
      }
    }

    // 4) 기간 내 Notion에 있지만 아웃룩에 없는 이벤트 → 삭제(아카이브)
    for (const [oid, pageId] of Object.entries(existingMap)) {
      if (!newOids.has(oid)) {
        await notion(env,'PATCH',`/pages/${pageId}`,{archived:true});
      }
    }
  } catch(e) {
    console.error('Scheduled sync error:', e.message);
  }
}

// 기간 내 Notion 이벤트 조회 (아웃룩 여부 필터 선택적)
async function loadNotionEventsByRange(env, startDate, endDate, outlookOnly=false) {
  const filter = {
    and: [
      {property:'날짜', date:{on_or_after:startDate}},
      {property:'날짜', date:{on_or_before:endDate}},
    ]
  };
  if (outlookOnly) {
    filter.and.push({property:'아웃룩여부', checkbox:{equals:true}});
  }
  const pages = [];
  let cursor;
  while (true) {
    const payload = {filter, page_size:200};
    if (cursor) payload.start_cursor = cursor;
    const res  = await notion(env,'POST',`/databases/${env.SCHEDULES_DB_ID}/query`,payload);
    const data = await res.json();
    pages.push(...(data.results||[]));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return pages;
}

// ── 아웃룩 동기화 핵심 로직 ──────────────────────────────────────────────
async function syncOutlook(env, startDate, endDate) {
  const token        = await getGraphToken(env);
  const memberEmails = JSON.parse(env.MEMBER_EMAILS||'{}');
  const memberIds    = JSON.parse(env.MEMBER_IDS||'{}');
  const allEvents    = [];
  for (const [name,email] of Object.entries(memberEmails)) {
    const memberId = memberIds[name];
    if (!memberId) continue;
    try {
      const events = await getCalendarEvents(token,email,startDate,endDate);
      for (const ev of events) {
        const isAllDay   = ev.isAllDay;
        const rawStartDT = ev.start?.dateTime||'';
        const rawEndDT   = ev.end?.dateTime||'';
        if (!rawStartDT) continue;
        const startDT = toKST(rawStartDT, ev.start?.timeZone||'UTC');
        const endDT   = toKST(rawEndDT,   ev.end?.timeZone||'UTC');
        const startDay = startDT.slice(0,10);
        let lastDay = endDT.slice(0,10);
        if (isAllDay && lastDay>startDay) {
          const d=new Date(lastDay+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1);
          lastDay=d.toISOString().slice(0,10);
        }
        const sTime = isAllDay?'09:00':startDT.slice(11,16);
        const eTime = isAllDay?'18:00':endDT.slice(11,16);
        const cur=new Date(startDay+'T00:00:00Z'), fin=new Date(lastDay+'T00:00:00Z');
        let dayIdx=0;
        while (cur<=fin && dayIdx<365) {
          const ds=cur.toISOString().slice(0,10);
          if (ds>=startDate && ds<=endDate)
            allEvents.push({
              id:`ol_${memberId}_${ds}_${ev.id.slice(-16)}`,
              memberId, date:ds,
              title:(isAllDay?'🌐 ':'')+(ev.subject||'(제목 없음)'),
              startTime:sTime, endTime:eTime,
              type:classifyEventType(ev.showAs, ev.subject),
              note:ev.bodyPreview||'',
              fromOutlook:true, isAllDay,
              outlookId:`ol_${memberId}_${ds}_${ev.id.slice(-16)}`,
            });
          cur.setUTCDate(cur.getUTCDate()+1); dayIdx++;
        }
      }
    } catch(e) {
      allEvents.push({id:`err_${name}`,memberId,date:startDate,
        title:`[오류] ${e.message}`,startTime:'00:00',endTime:'00:01',
        type:'meeting',fromOutlook:true});
    }
  }
  return {ok:true, events:allEvents, count:allEvents.length};
}

// ── Graph Token ───────────────────────────────────────────────────────────
async function getGraphToken(env) {
  if (!env.GRAPH_CLIENT_ID||!env.GRAPH_TENANT_ID||!env.GRAPH_CLIENT_SECRET)
    throw new Error('환경변수 미설정: GRAPH_CLIENT_ID/GRAPH_TENANT_ID/GRAPH_CLIENT_SECRET');
  const res=await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
     body:new URLSearchParams({client_id:env.GRAPH_CLIENT_ID,
       client_secret:env.GRAPH_CLIENT_SECRET,
       scope:'https://graph.microsoft.com/.default',
       grant_type:'client_credentials'}).toString()});
  if (!res.ok){const e=await res.json().catch(()=>({}));
    throw new Error(`토큰 취득 실패: ${e.error_description||e.error||res.status}`);}
  return (await res.json()).access_token;
}

// ── Calendar Events ───────────────────────────────────────────────────────
async function getCalendarEvents(token,email,startDate,endDate) {
  const params=new URLSearchParams({
    startDateTime:`${startDate}T00:00:00Z`,endDateTime:`${endDate}T15:00:00Z`,
    $select:'id,subject,start,end,showAs,bodyPreview,isAllDay',$top:'500'});
  const res=await fetch(`${GRAPH_BASE}/users/${email}/calendarView?${params}`,
    {headers:{'Authorization':`Bearer ${token}`,'Prefer':'outlook.timezone="Korea Standard Time"'}});
  if (!res.ok){const e=await res.json().catch(()=>({}));
    throw new Error(e?.error?.message||`HTTP ${res.status}`);}
  return (await res.json()).value||[];
}

function mapShowAs(s){return (s==='oof'||s==='workingElsewhere')?'out':'meeting';}

// 이벤트 제목 기반 타입 분류 (showAs 우선, 키워드 보완)
const OUT_KEYWORDS  = ['연차','반차','휴가','외근','출장','재택','공휴일','경조','병가','조퇴'];
const DEPLOY_KEYWORDS = ['배포','deploy'];

const MEETING_EXCEPTIONS = ['배포회의', '[내부업무]', '[내부]'];  // 배포 키워드가 있어도 회의로 분류

function classifyEventType(showAs, title) {
  const t = (title||'').toLowerCase();
  if (showAs === 'oof' || showAs === 'workingElsewhere') return 'out';
  if (OUT_KEYWORDS.some(k => t.includes(k))) return 'out';
  if (MEETING_EXCEPTIONS.some(k => t.includes(k))) return 'meeting';
  if (DEPLOY_KEYWORDS.some(k => t.includes(k))) return 'deploy';
  return 'meeting';
}

function toKST(dtStr,timeZone){
  if (!dtStr) return '';
  if (timeZone==='Korea Standard Time') return dtStr;
  try {
    const iso=(dtStr.includes('Z')||dtStr.includes('+'))?dtStr:dtStr+'Z';
    const d=new Date(iso); d.setUTCHours(d.getUTCHours()+9);
    return d.toISOString().slice(0,19);
  } catch(_){return dtStr;}
}

// ── Notion Helpers ────────────────────────────────────────────────────────
function notion(env,method,path,body){
  return fetch(`https://api.notion.com/v1${path}`,{method,
    headers:{'Authorization':`Bearer ${env.NOTION_SECRET}`,
      'Notion-Version':'2022-06-28','Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined});
}

// Notion 페이지 → JS 이벤트 객체
function parseNotionSchedule(page) {
  if (!page||!page.properties) return null;
  const p = page.properties;
  return {
    pageId:     page.id,
    id:         getNotionRichText(p,'아웃룩ID') || `notion_${page.id.replace(/-/g,'').slice(0,12)}`,
    memberId:   p['멤버ID']?.number ?? null,
    date:       p['날짜']?.date?.start||'',
    title:      getNotionText(p,'제목'),
    startTime:  getNotionRichText(p,'시작시간'),
    endTime:    getNotionRichText(p,'종료시간'),
    type:       p['타입']?.select?.name||'meeting',
    note:       getNotionRichText(p,'노트'),
    fromOutlook:p['아웃룩여부']?.checkbox||false,
    isAllDay:   p['하루종일']?.checkbox||false,
    outlookId:  getNotionRichText(p,'아웃룩ID'),
    classification: p['배포분류']?.select?.name || null,  // 수동 분류 (가능/불가/긴급) — 모두 공유
  };
}

// JS 이벤트 객체 → Notion 속성
function notionScheduleProps(d) {
  const props = {
    '제목':    {title:[{text:{content:d.title||''}}]},
    '멤버ID':  {number: d.memberId ? Number(d.memberId) : null},
    '날짜':    {date:{start:d.date||''}},
    '시작시간':{rich_text:[{text:{content:d.startTime||''}}]},
    '종료시간':{rich_text:[{text:{content:d.endTime||''}}]},
    '타입':    {select:{name:d.type||'meeting'}},
    '노트':    {rich_text:[{text:{content:d.note||''}}]},
    '아웃룩여부':{checkbox:!!d.fromOutlook},
    '하루종일': {checkbox:!!d.isAllDay},
    '아웃룩ID': {rich_text:[{text:{content:d.outlookId||d.id||''}}]},
  };
  return props;
}

function getNotionText(props,key){return props[key]?.title?.[0]?.text?.content||'';}
function getNotionRichText(props,key){return props[key]?.rich_text?.[0]?.text?.content||'';}

function mapSpinProps(p){
  return {'이름':p['NAME'],'날짜':p['DATE'],'스핀일':p['SPUNAT'],
    ...(p['MEMBERID']?{'멤버ID':p['MEMBERID']}:{})};
}

// ── vtiger Auth ───────────────────────────────────────────────────────────
const VTIGER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://crm.softcamp.co.kr/',
};

async function vtigerAuth(env){
  const base=env.VTIGER_URL.replace(/\/$/,'');
  const ch=await (await fetch(
    `${base}/webservice.php?operation=getchallenge&username=${encodeURIComponent(env.VTIGER_USERNAME)}`,
    {headers: VTIGER_HEADERS}
  )).json();
  if (!ch.success) throw new Error('vtiger challenge failed: '+JSON.stringify(ch.error));
  const ld=await (await fetch(`${base}/webservice.php`,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({operation:'login',username:env.VTIGER_USERNAME,
      accessKey:md5(ch.result.token+env.VTIGER_ACCESS_KEY)}).toString()
  })).json();
  if (!ld.success) throw new Error('vtiger login failed: '+JSON.stringify(ld.error));
  return ld.result.sessionName;
}

async function vtigerCall(env,sessionName,method,params){
  const base=env.VTIGER_URL.replace(/\/$/,'');
  if (method==='GET'){
    const qs=new URLSearchParams({...params,sessionName});
    return (await fetch(`${base}/webservice.php?${qs}`, {headers: VTIGER_HEADERS})).json();
  }
  const body=new URLSearchParams({...params,sessionName});
  return (await fetch(`${base}/webservice.php`,{method:'POST',
    headers:{...VTIGER_HEADERS,'Content-Type':'application/x-www-form-urlencoded'},
    body:body.toString()})).json();
}

// ── MD5 (Workers WebCrypto에 MD5 없으므로 순수 JS 구현) ──────────────────
function md5(str){
  const s=unescape(encodeURIComponent(str));
  function safeAdd(x,y){const l=(x&0xffff)+(y&0xffff);return(((x>>16)+(y>>16)+(l>>16))<<16)|(l&0xffff);}
  function rol(n,c){return(n<<c)|(n>>>(32-c));}
  function cmn(q,a,b,x,ss,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),ss),b);}
  function ff(a,b,c,d,x,ss,t){return cmn((b&c)|(~b&d),a,b,x,ss,t);}
  function gg(a,b,c,d,x,ss,t){return cmn((b&d)|(c&~d),a,b,x,ss,t);}
  function hh(a,b,c,d,x,ss,t){return cmn(b^c^d,a,b,x,ss,t);}
  function ii(a,b,c,d,x,ss,t){return cmn(c^(b|~d),a,b,x,ss,t);}
  const bytes=[];
  for(let i=0;i<s.length;i++) bytes.push(s.charCodeAt(i));
  bytes.push(0x80);
  while(bytes.length%64!==56) bytes.push(0);
  const l=s.length*8;
  bytes.push(l&0xff,(l>>8)&0xff,(l>>16)&0xff,(l>>24)&0xff,0,0,0,0);
  const w=[];
  for(let i=0;i<bytes.length;i+=4)
    w.push(bytes[i]|(bytes[i+1]<<8)|(bytes[i+2]<<16)|(bytes[i+3]<<24));
  let a=0x67452301,b=0xefcdab89,c=0x98badcfe,d=0x10325476;
  for(let i=0;i<w.length;i+=16){
    const k=w.slice(i,i+16),a0=a,b0=b,c0=c,d0=d;
    a=ff(a,b,c,d,k[0],7,-680876936);  d=ff(d,a,b,c,k[1],12,-389564586);
    c=ff(c,d,a,b,k[2],17,606105819);  b=ff(b,c,d,a,k[3],22,-1044525330);
    a=ff(a,b,c,d,k[4],7,-176418897);  d=ff(d,a,b,c,k[5],12,1200080426);
    c=ff(c,d,a,b,k[6],17,-1473231341);b=ff(b,c,d,a,k[7],22,-45705983);
    a=ff(a,b,c,d,k[8],7,1770035416);  d=ff(d,a,b,c,k[9],12,-1958414417);
    c=ff(c,d,a,b,k[10],17,-42063);    b=ff(b,c,d,a,k[11],22,-1990404162);
    a=ff(a,b,c,d,k[12],7,1804603682); d=ff(d,a,b,c,k[13],12,-40341101);
    c=ff(c,d,a,b,k[14],17,-1502002290);b=ff(b,c,d,a,k[15],22,1236535329);
    a=gg(a,b,c,d,k[1],5,-165796510);  d=gg(d,a,b,c,k[6],9,-1069501632);
    c=gg(c,d,a,b,k[11],14,643717713); b=gg(b,c,d,a,k[0],20,-373897302);
    a=gg(a,b,c,d,k[5],5,-701558691);  d=gg(d,a,b,c,k[10],9,38016083);
    c=gg(c,d,a,b,k[15],14,-660478335);b=gg(b,c,d,a,k[4],20,-405537848);
    a=gg(a,b,c,d,k[9],5,568446438);   d=gg(d,a,b,c,k[14],9,-1019803690);
    c=gg(c,d,a,b,k[3],14,-187363961); b=gg(b,c,d,a,k[8],20,1163531501);
    a=gg(a,b,c,d,k[13],5,-1444681467);d=gg(d,a,b,c,k[2],9,-51403784);
    c=gg(c,d,a,b,k[7],14,1735328473); b=gg(b,c,d,a,k[12],20,-1926607734);
    a=hh(a,b,c,d,k[5],4,-378558);     d=hh(d,a,b,c,k[8],11,-2022574463);
    c=hh(c,d,a,b,k[11],16,1839030562);b=hh(b,c,d,a,k[14],23,-35309556);
    a=hh(a,b,c,d,k[1],4,-1530992060); d=hh(d,a,b,c,k[4],11,1272893353);
    c=hh(c,d,a,b,k[7],16,-155497632); b=hh(b,c,d,a,k[10],23,-1094730640);
    a=hh(a,b,c,d,k[13],4,681279174);  d=hh(d,a,b,c,k[0],11,-358537222);
    c=hh(c,d,a,b,k[3],16,-722521979); b=hh(b,c,d,a,k[6],23,76029189);
    a=hh(a,b,c,d,k[9],4,-640364487);  d=hh(d,a,b,c,k[12],11,-421815835);
    c=hh(c,d,a,b,k[15],16,530742520); b=hh(b,c,d,a,k[2],23,-995338651);
    a=ii(a,b,c,d,k[0],6,-198630844);  d=ii(d,a,b,c,k[7],10,1126891415);
    c=ii(c,d,a,b,k[14],15,-1416354905);b=ii(b,c,d,a,k[5],21,-57434055);
    a=ii(a,b,c,d,k[12],6,1700485571); d=ii(d,a,b,c,k[3],10,-1894986606);
    c=ii(c,d,a,b,k[10],15,-1051523);  b=ii(b,c,d,a,k[1],21,-2054922799);
    a=ii(a,b,c,d,k[8],6,1873313359);  d=ii(d,a,b,c,k[15],10,-30611744);
    c=ii(c,d,a,b,k[6],15,-1560198380);b=ii(b,c,d,a,k[13],21,1309151649);
    a=ii(a,b,c,d,k[4],6,-145523070);  d=ii(d,a,b,c,k[11],10,-1120210379);
    c=ii(c,d,a,b,k[2],15,718787259);  b=ii(b,c,d,a,k[9],21,-343485551);
    a=safeAdd(a,a0);b=safeAdd(b,b0);c=safeAdd(c,c0);d=safeAdd(d,d0);
  }
  function hex(n){let s='';for(let i=0;i<4;i++)s+=('0'+((n>>(i*8))&0xff).toString(16)).slice(-2);return s;}
  return hex(a)+hex(b)+hex(c)+hex(d);
}
