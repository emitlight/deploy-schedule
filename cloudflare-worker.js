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
 *  TRUSTED_IPS    회사 공인 IP(쉼표 구분, 시크릿) — 이 주소에서는 비밀번호 없이 접속. 배포하기.bat 이 등록
 *
 * Cron Triggers (KST 기준, wrangler.toml 참고):
 *  0 22 * * *  → KST 07:00   아웃룩 자동 동기화
 *  30 3 * * *  → KST 12:30   아웃룩 자동 동기화
 *  0 6 * * *   → KST 15:00   아웃룩 자동 동기화
 */
const CORS = {
  'Access-Control-Allow-Origin':  'https://emitlight.github.io',  // 대시보드 도메인만 허용 (브라우저 교차출처 남용 차단)
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Action, X-Auth',
};
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export default {
  // ── HTTP 요청 핸들러 ──────────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:CORS});

    // ── 접근 게이트 (fail-closed) ───────────────────────────────────────
    // ⚠️ 보안 검토 필요: 프론트가 공개(GitHub Pages)이므로 공유 비밀번호는 '캐주얼 차단' 수준.
    //    완전한 인증은 Cloudflare Access(SSO) 권장. 단, 미설정 시 전면 공개되던 fail-open은 제거함.
    if (!env.APP_PASSWORD) {
      return new Response(JSON.stringify({ ok:false, error:'server_not_configured',
        message:'APP_PASSWORD 미설정 — 관리자가 `wrangler secret put APP_PASSWORD` 실행 필요' }),
        { status:503, headers:{ ...CORS, 'Content-Type':'application/json' } });
    }
    // 액션은 헤더로만 수신 — ?action= 쿼리 경로 제거(주소창 GET 한 번으로 호출되던 문제 차단)
    const action = request.headers.get('X-Action');
    const auth   = request.headers.get('X-Auth') || '';

    // 사람(대시보드)은 APP_PASSWORD, 기계(사내 동기화 스크립트)는 INGEST_TOKEN.
    // 기계 토큰은 CRM 연동 동작만 할 수 있다(최소 권한) — 유출돼도 일정·이력을 건드릴 수 없다.
    //   티켓 적재 / CRM 담당자 변경 요청 가져가기 / 처리 결과 보고
    // 회사 인터넷(TRUSTED_IPS)에서 온 요청은 비밀번호 없이 사람으로 인정한다 (2026-10-26 운영자 결정).
    //   CF-Connecting-IP 는 Cloudflare 가 붙이는 값이라 외부에서 위조할 수 없다.
    //   ⚠️ 보안 검토 필요: 같은 회사 주소로 나가는 손님용 와이파이가 있으면 방문객도 접근 가능.
    const isUser    = safeEqual(auth, env.APP_PASSWORD) || isTrustedIp(request, env);
    const isIngest  = !!env.INGEST_TOKEN && safeEqual(auth, env.INGEST_TOKEN);
    const INGEST_ONLY_ACTIONS = new Set(['ingest-crm-tickets', 'get-crm-assign-queue', 'ack-crm-assign']);
    if (!isUser && !(isIngest && INGEST_ONLY_ACTIONS.has(action))) {
      return new Response(JSON.stringify({ ok:false, error:'unauthorized' }),
        { status:401, headers:{ ...CORS, 'Content-Type':'application/json' } });
    }
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
            <p>안녕하세요, <b>${esc(toMemberName)}</b>님</p>
            <p>아래 배포지원 일정의 담당자로 선정되셨습니다.</p>
            <table style="border-collapse:collapse;margin:12px 0">
              <tr><td style="padding:4px 12px 4px 0;color:#666">배포 내용</td><td><b>${esc(title || '-')}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">날짜</td><td>${esc(date || '-')}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">시간</td><td>${esc(startTime || '-')} ~ ${esc(endTime || '-')}</td></tr>
              ${note ? `<tr><td style="padding:4px 12px 4px 0;color:#666">메모</td><td>${esc(note)}</td></tr>` : ''}
            </table>
            <p>일정 확인 후 문의사항은 파트너프로그램팀(ps2@softcamp.co.kr)에게 연락해 주세요.</p>
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
              content: `<p>배포지원 담당자로 배정되었습니다.</p><p><b>일정:</b> ${esc(date)} ${esc(startTime)} ~ ${esc(endTime)}</p>${note ? `<p><b>내용:</b> ${esc(note)}</p>` : ''}`,
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
          // 실제 결과(생성/수정/생략/아카이브/오류/실패멤버)를 그대로 반환 —
          // 과거엔 실패해도 무조건 '동기화 완료'를 돌려줘 장애가 보이지 않았다.
          result = await runScheduledSync(env);
          break;
        }

        // ── 배정 컨텍스트 (가용 판정) — 모든 PC가 같은 답을 보는 단일 경로 ──
        case 'get-availability': {
          result = await buildAvailability(env, body || {});
          break;
        }

        // ── CRM 배포지원요청 티켓 적재 (사내 동기화 스크립트가 호출) ─────
        // Cloudflare에서 CRM(사내 10.x)에 직접 붙을 수 없어, 사내 서버가 밀어 넣는다.
        case 'ingest-crm-tickets': {
          if (!env.SETTINGS) throw Object.assign(new Error('KV(SETTINGS) 미설정'), { status: 501 });
          const list = Array.isArray(body?.tickets) ? body.tickets : null;
          if (!list) throw new Error('tickets 배열 필요');
          if (list.length > 500) throw new Error('한 번에 500건까지');
          const clean = list.map(t => ({
            ticketId:   String(t.ticketId ?? ''),
            ticketNo:   String(t.ticketNo ?? '').slice(0, 30),
            title:      String(t.title ?? '').slice(0, 300),
            status:     String(t.status ?? '').slice(0, 50),
            assignee:   String(t.assignee ?? '').slice(0, 40),
            account:    String(t.account ?? '').slice(0, 100),
            requester:  String(t.requester ?? '').slice(0, 40),
            projectCode:String(t.projectCode ?? '').slice(0, 50),
            periodFrom: /^\d{4}-\d{2}-\d{2}$/.test(t.periodFrom || '') ? t.periodFrom : null,
            periodTo:   /^\d{4}-\d{2}-\d{2}$/.test(t.periodTo   || '') ? t.periodTo   : null,
            createdKst: String(t.createdKst ?? '').slice(0, 20),
            url:        /^https?:\/\//.test(t.url || '') ? String(t.url).slice(0, 300) : '',
          })).filter(t => t.ticketNo);
          const payload = { tickets: clean, syncedAt: new Date().toISOString(),
                            source: String(body.source || 'partnercenter').slice(0, 40) };
          await env.SETTINGS.put(CRM_TICKETS_KEY, JSON.stringify(payload));
          console.log(`[crm-tickets] ${clean.length}건 적재 (from ${payload.source})`);
          // 담당자가 정해진 티켓은 대시보드 배정으로 곧바로 반영 (실패해도 티켓 적재는 유지)
          let assignments;
          try { assignments = await applyCrmAssignments(env, clean, { maxWrites: 40 }); }
          catch (e) { console.error('[crm-assign] 실패:', e.message); assignments = { ok: false, error: e.message }; }
          result = { ok: true, stored: clean.length, syncedAt: payload.syncedAt, assignments };
          break;
        }

        // ── CRM 담당자 변경 요청 (대시보드에서 티켓으로 배정 확정 시) ─────
        // Cloudflare에서는 CRM에 닿지 않으므로 요청을 쌓아 두고, 사내 동기화 스크립트가
        // 가져가 파트너센터와 같은 방식(CRM API vtws_revise)으로 담당자를 바꾼다.
        case 'queue-crm-assign': {
          if (!env.SETTINGS) throw Object.assign(new Error('KV(SETTINGS) 미설정'), { status: 501 });
          const ticketNo = String(body?.ticketNo || '').slice(0, 30);
          const memberName = String(body?.memberName || '').trim();
          if (!ticketNo || !memberName) throw new Error('ticketNo, memberName 필요');
          if (!buildRoster(env, true).some(m => m.name === memberName))
            throw Object.assign(new Error('명단에 없는 멤버입니다'), { status: 400 });
          const q = await readAssignQueue(env);
          const item = { ticketNo, ticketId: String(body?.ticketId || '').slice(0, 20), memberName,
            requestedAt: new Date().toISOString(), by: String(body?.by || '대시보드').slice(0, 40),
            status: 'pending', attempts: 0, error: null };
          // 같은 티켓은 마지막 요청만 유지
          const next = q.filter(x => x.ticketNo !== ticketNo).concat(item).slice(-100);
          await env.SETTINGS.put(CRM_ASSIGN_QUEUE_KEY, JSON.stringify(next));
          result = { ok: true, queued: item };
          break;
        }

        // ── 사내 스크립트가 처리할 요청 목록 (INGEST_TOKEN) ─────────────────
        case 'get-crm-assign-queue': {
          const q = await readAssignQueue(env);
          result = { ok: true, items: q.filter(x => x.status === 'pending') };
          break;
        }

        // ── 사내 스크립트의 처리 결과 보고 (INGEST_TOKEN) ──────────────────
        // 성공 → 'done'(최근 기록으로 7일 보관), 실패 → 3회까지 재시도 후 'failed'
        case 'ack-crm-assign': {
          if (!env.SETTINGS) throw Object.assign(new Error('KV(SETTINGS) 미설정'), { status: 501 });
          const results = Array.isArray(body?.results) ? body.results : [];
          const q = await readAssignQueue(env);
          const now = new Date().toISOString();
          for (const r of results) {
            const it = q.find(x => x.ticketNo === r.ticketNo && x.status === 'pending' &&
                                   (!r.requestedAt || x.requestedAt === r.requestedAt));
            if (!it) continue;
            if (r.ok) { it.status = 'done'; it.doneAt = now; it.error = null; }
            else {
              it.attempts = (it.attempts || 0) + 1;
              it.error = String(r.error || '알 수 없는 오류').slice(0, 200);
              if (it.attempts >= 3) it.status = 'failed';
            }
          }
          const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
          const kept = q.filter(x => x.status !== 'done' || (x.doneAt || '') >= weekAgo);
          await env.SETTINGS.put(CRM_ASSIGN_QUEUE_KEY, JSON.stringify(kept));
          result = { ok: true, pending: kept.filter(x => x.status === 'pending').length };
          break;
        }

        // ── CRM 담당자 → 배정 반영 수동 실행 (관리용) ───────────────────
        case 'apply-crm-assignments': {
          const cur = await readCrmTickets(env);
          result = await applyCrmAssignments(env, cur.tickets || [], { maxWrites: 40 });
          break;
        }

        // ── CRM 배포지원요청 티켓 조회 (대시보드가 호출) ─────────────────
        case 'get-crm-tickets': {
          result = await readCrmTickets(env);
          break;
        }

        // ── 멤버 명단 + 공유 설정 (가벼움 — 외부 API 호출 없음) ──────────
        case 'get-roster': {
          const cfg = await readSettings(env);
          result = { ok:true, members: buildRoster(env, cfg.includeExtra), config: cfg };
          break;
        }

        // ── 후보 명단 설정 변경 (모든 PC 공유) ───────────────────────────
        case 'set-roster-config': {
          const saved = await writeSettings(env, { includeExtra: !!body?.includeExtra }, body?.by);
          // ⚠️ 저장 직후 KV를 다시 읽으면 안 된다 — KV는 쓰기 반영에 최대 1분이 걸려
          //    방금 쓴 값 대신 이전 값이 돌아오고, 화면이 되돌아간 것처럼 보인다.
          //    방금 저장한 값을 그대로 응답한다.
          result = { ok:true, members: buildRoster(env, saved.includeExtra),
                     config: { includeExtra: saved.includeExtra, editable: true, source: 'kv',
                               updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } };
          break;
        }

        // ── 멤버별 배정 통계 (공정성 증명용) ────────────────────────────
        case 'get-stats': {
          result = await buildStats(env, body || {});
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
            const payload = {page_size:100};
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
          await ensureSpinLogProp(env);
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
          // 대상이 우리 일정 DB 소속인지 확인 — 임의 pageId로 다른 Notion 페이지를 지우지 못하게
          await assertPageInDb(env, body?.pageId, env.SCHEDULES_DB_ID);
          await notion(env,'PATCH',`/pages/${body.pageId}`,{archived:true});
          result={ok:true};
          break;
        }

        // ── 배포지원 분류 수동 설정 (Notion 저장 → 모두에게 공유) ──────────
        // SCHEDULES_DB의 '배포분류' Select에 저장. run-sync는 자기 속성만 PATCH하므로
        // 재동기화해도 이 값은 보존됨. classification: '가능'|'불가'|'긴급' 또는 빈값(해제)
        case 'set-classification': {
          if (!env.NOTION_SECRET||!env.SCHEDULES_DB_ID) throw new Error('Notion 미설정');
          await assertPageInDb(env, body?.pageId, env.SCHEDULES_DB_ID);
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
          await assertPageInDb(env, body?.pageId, env.SPINLOG_DB_ID);
          await notion(env, 'PATCH', `/pages/${body.pageId}`, {archived: true});
          result = {ok: true};
          break;
        }

        case 'get-spinlog': {
          if (!env.NOTION_SECRET||!env.SPINLOG_DB_ID) throw new Error('Notion 미설정');
          // 전체 이력을 커서로 끝까지 조회. 과거엔 1페이지만 읽어, 이력이 쌓이면
          // 오래된 기록이 창 밖으로 밀려 "한 번도 안 뽑힌 사람"으로 오분류됐다.
          const rows=[]; let cursor;
          for (let page=0; page<50; page++) {
            const payload={sorts:[{timestamp:'created_time',direction:'descending'}],page_size:100};
            if (cursor) payload.start_cursor=cursor;
            const res=await notion(env,'POST',`/databases/${env.SPINLOG_DB_ID}/query`,payload);
            const d=await res.json();
            rows.push(...(d.results||[]));
            if (!d.has_more || !d.next_cursor) break;
            cursor=d.next_cursor;
          }
          const data={results:rows};
          const logs=(data.results||[]).map(p=>{
            const pr=p.properties||{};
            return {
              id:         p.id,
              name:       getNotionText(pr,'이름'),
              targetDate: pr['날짜']?.date?.start||'',
              spunAt:     getNotionRichText(pr,'스핀일'),
              memberId:   pr['멤버ID']?.number??null,
              createdTime:p.created_time,
            };
          });
          // 각 이력이 '실제 배정'까지 갔는지 확인 — 연결된 배포 일정이 있으면 완료로 본다.
          // (추첨만 하고 저장하지 않은 건과 구분하기 위함)
          await annotateSpinLogs(env, logs);
          result={ok:true,logs}; break;
        }

        // ── 배정 취소: 스핀 이력을 [취소]로 표시(삭제 X) + 멤버ID 제거 → 우선순위 계산서 제외 ──
        case 'cancel-spinlog': {
          if (!env.NOTION_SECRET) throw new Error('Notion 미설정');
          await assertPageInDb(env, body?.pageId, env.SPINLOG_DB_ID);
          const nm = (body.name||'').replace(/^\[취소\]\s*/,'');
          await notion(env,'PATCH',`/pages/${body.pageId}`,{properties:mapSpinProps({
            'NAME':     {title:[{text:{content:`[취소] ${nm}`}}]},
            'MEMBERID': {number:null},
          })});
          result={ok:true}; break;
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
          if (!env.VTIGER_URL||!env.VTIGER_USERNAME||!env.VTIGER_ACCESS_KEY)
            throw new Error('vtiger 미설정: VTIGER_URL/VTIGER_USERNAME/VTIGER_ACCESS_KEY');
          const base = (env.VTIGER_URL||'').replace(/\/$/,'');
          const testUrl = `${base}/webservice.php?operation=getchallenge&username=${encodeURIComponent(env.VTIGER_USERNAME||'')}`;
          const raw = await fetch(testUrl, {headers: VTIGER_HEADERS});
          const text = await raw.text();
          // 설정값(URL·관리자 계정명)과 응답 원문은 노출하지 않는다 — 연결 가능 여부만 반환
          result = {
            ok: raw.ok,
            http_status: raw.status,
            reachable: raw.ok,
            is_json: text.trim().startsWith('{') || text.trim().startsWith('['),
            hint: raw.ok ? 'vtiger 연결 정상'
                         : 'vtiger 연결 실패 — Cloudflare IP 화이트리스트 등록 여부를 확인하세요',
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
      // 상세 원인은 로그로(관측성), 응답에는 메시지만. 인증 게이트 통과자만 도달하므로 원문 노출 허용.
      console.error(`[action:${action}]`, e && e.stack || e);
      return new Response(JSON.stringify({ok:false, error:String(e && e.message || e)}),
        {status:(e && e.status) || 500, headers:{...CORS,'Content-Type':'application/json'}});
    }
  },

  // ── Cron Trigger 핸들러 (자동 아웃룩 동기화) ──────────────────────────
  async scheduled(event, env, ctx) {
    // 결과를 로그로 남긴다 — 과거엔 실패해도 아무 흔적이 없어 Cron이 멈춘 걸 아무도 몰랐다.
    ctx.waitUntil((async () => {
      // CRM 담당자 반영을 먼저(작은 쓰기 상한) — 남은 건 다음 실행에서 이어서 한다
      try {
        const cur = await readCrmTickets(env);
        const a = await applyCrmAssignments(env, cur.tickets || [], { maxWrites: 15 });
        console.log('[cron] CRM 배정 반영:', JSON.stringify(a));
      } catch (e) { console.error('[cron] CRM 배정 반영 실패:', e.message); }
      const r = await runScheduledSync(env);
      if (!r || !r.ok) console.error('[cron] 동기화 실패/부분실패:', JSON.stringify(r));
      else             console.log('[cron] 동기화 정상:', JSON.stringify(r));
    })());
  },
};

// ── 자동 동기화: 아웃룩 → Notion SCHEDULES_DB ────────────────────────────
// 창(window): 과거 28일 ~ 미래 90일. 대시보드 표시 범위(-7 ~ +90일)와 맞춤.
//   (과거엔 ±28일이라 +29~+90일 구간이 Notion에 아예 쌓이지 않았다)
const SYNC_PAST_DAYS   = 28;
const SYNC_FUTURE_DAYS = 90;
let   syncInFlight     = false;   // 같은 isolate 내 중복 실행 방지 (Cron 3개 + 수동 트리거 겹침 완화)

async function runScheduledSync(env) {
  if (!env.GRAPH_CLIENT_ID || !env.NOTION_SECRET || !env.SCHEDULES_DB_ID) {
    console.error('[sync] 환경변수 미설정으로 중단 — GRAPH_CLIENT_ID/NOTION_SECRET/SCHEDULES_DB_ID 확인 필요');
    return {ok:false, reason:'env_missing'};
  }
  if (syncInFlight) { console.log('[sync] 이미 실행 중 — 건너뜀'); return {ok:false, reason:'in_flight'}; }
  syncInFlight = true;

  const kstToday = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);  // KST 기준 오늘
  const startDate = addDaysISO(kstToday, -SYNC_PAST_DAYS);
  const endDate   = addDaysISO(kstToday,  SYNC_FUTURE_DAYS);
  const stat = {created:0, updated:0, skipped:0, archived:0, errors:0, failedMembers:[]};

  try {
    // 1) 아웃룩 조회 (실패한 멤버는 failedMemberIds로 따로 추적)
    const {events: newEvents, failed} = await syncOutlook(env, startDate, endDate);
    stat.failedMembers = failed.map(f => f.name);
    const failedIds = new Set(failed.map(f => f.memberId));

    // 2) 기간 내 기존 아웃룩 사본 수집
    const existingPages = await loadNotionEventsByRange(env, startDate, endDate, true);
    const existing = {};   // 아웃룩ID → {pageId, parsed}
    for (const p of existingPages) {
      const oid = getNotionRichText(p.properties,'아웃룩ID');
      if (!oid) continue;
      if (existing[oid]) {            // 과거 동시 실행으로 생긴 중복 페이지 → 하나만 남기고 정리
        try { await notion(env,'PATCH',`/pages/${p.id}`,{archived:true}); stat.archived++; }
        catch(e){ stat.errors++; console.error('[sync] 중복 정리 실패', e.message); }
        continue;
      }
      existing[oid] = {pageId: p.id, parsed: parseNotionSchedule(p)};
    }

    // 3) Upsert — 내용이 같으면 쓰지 않는다(변경 감지). Notion 호출량이 1/10 이하로 줄어
    //    레이트리밋(초당 3건) 초과로 뒷부분이 통째로 유실되던 문제를 완화한다.
    const newOids = new Set();
    for (const ev of newEvents) {
      if (!ev.id) continue;
      newOids.add(ev.id);
      const payload = {...ev, fromOutlook:true};
      const hit = existing[ev.id];
      try {
        if (hit) {
          if (scheduleUnchanged(hit.parsed, payload)) { stat.skipped++; continue; }
          await notion(env,'PATCH',`/pages/${hit.pageId}`,{properties:notionScheduleProps(payload)});
          stat.updated++;
        } else {
          await notion(env,'POST','/pages',
            {parent:{database_id:env.SCHEDULES_DB_ID},properties:notionScheduleProps(payload)});
          stat.created++;
        }
      } catch(e) { stat.errors++; console.error(`[sync] 저장 실패 ${ev.id}: ${e.message}`); }
    }

    // 4) 아웃룩에서 사라진 일정 아카이브
    //    ⚠️ 조회 실패한 멤버는 건너뛴다. 과거엔 이 단계가 실패 멤버의 일정을
    //       수동 분류(배포분류)까지 통째로 지웠다.
    for (const [oid, {pageId, parsed}] of Object.entries(existing)) {
      if (newOids.has(oid)) continue;
      if (failedIds.has(parsed?.memberId)) { stat.skipped++; continue; }
      try { await notion(env,'PATCH',`/pages/${pageId}`,{archived:true}); stat.archived++; }
      catch(e) { stat.errors++; console.error(`[sync] 아카이브 실패 ${oid}: ${e.message}`); }
    }

    console.log(`[sync] ${startDate}~${endDate} 완료`, JSON.stringify(stat));
    return {ok: stat.errors === 0 && failed.length === 0, range:{startDate,endDate}, ...stat};
  } catch(e) {
    console.error('[sync] 중단:', e && e.stack || e.message);
    return {ok:false, reason:'exception', error:e.message, ...stat};
  } finally {
    syncInFlight = false;
  }
}

// 날짜 문자열(YYYY-MM-DD)에 일수 가감 — UTC 기준 계산으로 타임존 밀림 방지
function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}

// 저장된 Notion 값과 새 아웃룩 값이 같은지 — 같으면 쓰기 생략
function scheduleUnchanged(prev, next) {
  if (!prev) return false;
  return prev.title      === (next.title || '')
      && prev.date       === (next.date || '')
      && prev.startTime  === (next.startTime || '')
      && prev.endTime    === (next.endTime || '')
      && prev.type       === (next.type || 'meeting')
      && prev.note       === (next.note || '')
      && !!prev.isAllDay === !!next.isAllDay
      && prev.memberId   === (next.memberId ?? null);
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
    const payload = {filter, page_size:100};
    if (cursor) payload.start_cursor = cursor;
    const res  = await notion(env,'POST',`/databases/${env.SCHEDULES_DB_ID}/query`,payload);
    const data = await res.json();
    pages.push(...(data.results||[]));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return pages;
}

// ════════════════════════════════════════════════════════════════════════
// 배포지원 가용 판정 — 이 시스템의 단일 판단 주체
// ════════════════════════════════════════════════════════════════════════
// ⚠️ 과거엔 이 규칙이 index.html(브라우저)에만 있어, PC마다 가진 데이터가 다르면
//    같은 질문에 다른 답이 나왔다. 이제 서버가 한 번 계산해 모두에게 같은 답을 내려준다.
//    규칙을 바꿀 때는 반드시 이 파일만 고칠 것(프론트에는 사본을 두지 않는다).

const AVAILABLE_KEYWORDS = ['티켓','파트너','내부','교육','대기'];  // 대괄호 안 토큰이 이 중 하나면 가용
const TAG_SYNONYMS       = { '[내부업무]':'[내부]', '[내부 업무]':'[내부]' };
const URGENT_TAG         = '[긴급]';
const AVAIL_OUT_KEYWORDS = ['연차','반차','휴가','외근','출장','재택','공휴일','경조','병가','조퇴','OOF','부재중'];
const CLS_FROM_KR        = { '가능':'available', '불가':'blocking', '긴급':'urgent' };

function normalizeTitle(title) {
  let t = title || '';
  for (const k in TAG_SYNONYMS) t = t.split(k).join(TAG_SYNONYMS[k]);
  return t;
}

// 대괄호 태그 안을 구분자로 쪼개 토큰 하나라도 가용 키워드면 true
// 예: [티켓] · [티켓 한국산업진흥원] · [티켓_고객사] · [완료/티켓] · [내부/LMS]
function titleHasAvailableTag(title) {
  const tags = (title || '').match(/\[([^\]]+)\]/g) || [];
  return tags.some(raw => raw.slice(1,-1).split(/[\/_\s·:,\-]+/)
    .some(tok => AVAILABLE_KEYWORDS.includes(tok)));
}

// 일정 1건의 배포지원 분류: 'available' | 'urgent' | 'blocking'
function classifyAvailability(e) {
  const nc = CLS_FROM_KR[e.classification];
  if (nc) return nc;                                            // 1. 매니저 수동 분류 최우선(공유)
  if (e.type === 'deploy' && !e.fromOutlook) return 'blocking'; // 2. 이미 배포지원 투입 중
  const title = normalizeTitle(e.title);
  if (titleHasAvailableTag(title)) {                            // 3. 가용 키워드
    if (!e.isAllDay && title.includes('원격')) return 'blocking';  //    시간제 원격 지원 중 = 불가
    if (title.includes(URGENT_TAG)) return 'urgent';               //    가용 + 긴급 = 주의
    return 'available';
  }
  if (e.type === 'out' || AVAIL_OUT_KEYWORDS.some(k => title.includes(k))) return 'blocking'; // 4. 부재
  if (/\[[^\]]+\]/.test(title)) return 'blocking';              // 5. 가용 키워드 없는 태그 = 전담 업무
  return 'available';                                            // 6. 태그 없는 일반 회의 = 가능
}

const isFreeTimeEvent = e => {
  const c = classifyAvailability(e);
  return c === 'available' || c === 'urgent';
};

function timeToMinutes(t) {
  const [h,m] = String(t||'').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function eventsOverlap(aS,aE,bS,bE) {
  return timeToMinutes(aS) < timeToMinutes(bE) && timeToMinutes(bS) < timeToMinutes(aE);
}

// 기간 내 평일 목록 (주말 제외 — 배포지원은 평일만 운영)
function weekdayRange(startDate, endDate) {
  const out = [];
  for (let d = startDate, i = 0; d <= endDate && i < 400; d = addDaysISO(d,1), i++) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

// 멤버가 그 날 그 시간대에 가능한지
function isMemberAvailableOn(events, memberId, date, startTime, endTime) {
  return !events.some(e =>
    e.memberId === memberId && e.date === date &&
    (e.isAllDay || eventsOverlap(startTime, endTime, e.startTime, e.endTime)) &&
    !isFreeTimeEvent(e));
}

// 불가 사유 한 줄 라벨
function unavailReasonLabel(e) {
  if (CLS_FROM_KR[e.classification] === 'blocking') return '매니저 수동 분류(불가)';
  if (e.type === 'deploy' && !e.fromOutlook) return '이미 배포지원 투입 중';
  const title = normalizeTitle(e.title);
  if (titleHasAvailableTag(title) && !e.isAllDay && title.includes('원격')) return '원격 지원 중';
  const out = AVAIL_OUT_KEYWORDS.find(k => title.includes(k));
  if (e.type === 'out' || out) return `부재(${out || '휴가·외근'})`;
  const tag = (title.match(/\[[^\]]+\]/) || [])[0];
  if (tag) return `고객사·전담 업무 ${tag}`;
  return '일정 충돌';
}

// 멤버별 불가 사유 — 연속된 날짜 중 사유가 같으면 하나로 묶는다
function buildUnavailReasons(events, memberId, days, startTime, endTime) {
  const blocked = days.map(d => {
    const e = events.find(ev => ev.memberId === memberId && ev.date === d &&
      (ev.isAllDay || eventsOverlap(startTime, endTime, ev.startTime, ev.endTime)) &&
      !isFreeTimeEvent(ev));
    return e ? { d, e } : null;
  }).filter(Boolean);
  if (blocked.length === 0) return [{ dates:'', text:'해당 기간에 평일이 없음' }];
  const md = d => d.slice(5).replace('-','/');
  const groups = [];
  blocked.forEach(({d,e}) => {
    const text = `${e.isAllDay ? '종일' : `${e.startTime}~${e.endTime}`} · ${unavailReasonLabel(e)}`;
    const g = groups[groups.length-1];
    if (g && g.text === text && days.indexOf(d) === days.indexOf(g.end) + 1) g.end = d;
    else groups.push({ start:d, end:d, text });
  });
  return groups.map(g => ({
    dates: g.end !== g.start ? `${md(g.start)}~${md(g.end)}` : md(g.start),
    text:  g.text,
  }));
}

// 서버가 내려주는 배정 컨텍스트 — 모든 PC가 이 응답 하나만 보고 화면을 그린다
async function buildAvailability(env, { startDate, endDate, startTime, endTime }) {
  if (!startDate || !endDate) throw new Error('startDate, endDate 필요');
  const sT = startTime || '09:00', eT = endTime || '18:00';
  const days = weekdayRange(startDate, endDate);

  const cfg = await readSettings(env);
  const roster = buildRoster(env, cfg.includeExtra);
  // 아웃룩(원천) + Notion(배정·수동분류)을 합쳐 판정 입력을 만든다
  const [outlook, notionRows] = await Promise.all([
    cachedSyncOutlook(env, startDate, endDate),
    loadNotionEventsByRange(env, startDate, endDate, false).then(ps => ps.map(parseNotionSchedule).filter(Boolean)),
  ]);
  const clsByOid = new Map();
  notionRows.filter(r => r.fromOutlook).forEach(r => clsByOid.set(r.outlookId || r.id, r.classification));
  const outlookEvents = outlook.events.map(e =>
    clsByOid.has(e.outlookId) ? { ...e, classification: clsByOid.get(e.outlookId) } : e);
  const assignments = notionRows.filter(r => !r.fromOutlook);   // 배정·직접 등록 일정
  const events = outlookEvents.concat(assignments);

  const failedIds = new Set(outlook.failedMemberIds || []);
  const members = roster.map(m => {
    // 아웃룩 조회에 실패한 멤버는 일정이 0건으로 보여 '가능'으로 오판된다.
    // 바쁜 사람이 뽑히는 것을 막기 위해, 확인되기 전까지 후보에서 제외한다.
    const stale = failedIds.has(m.id);
    const availDays = stale ? [] : days.filter(d => isMemberAvailableOn(events, m.id, d, sT, eT));
    const available = !stale && days.length > 0 && availDays.length === days.length;
    const urgent = available && days.some(d => events.some(e =>
      e.memberId === m.id && e.date === d &&
      (e.isAllDay || eventsOverlap(sT, eT, e.startTime || '09:00', e.endTime || '18:00')) &&
      classifyAvailability(e) === 'urgent'));
    return {
      ...m, available, urgent,
      availableDates: availDays,
      reasons: available ? []
        : stale ? [{ dates: '', text: '아웃룩 일정 조회 실패 — 확인 전까지 후보에서 제외' }]
        : buildUnavailReasons(events, m.id, days, sT, eT),
      stale,
    };
  });

  // 이 기간에 이미 배정된 사람 / 기간 전체가 배정된 사람(= 룰렛 잠금 대상)
  const byMember = {};
  assignments.filter(e => e.type === 'deploy' && days.includes(e.date))
    .forEach(e => { (byMember[e.memberId] = byMember[e.memberId] || new Set()).add(e.date); });
  const assigned = Object.entries(byMember).map(([id, set]) => ({
    memberId: Number(id),
    name: (roster.find(r => r.id === Number(id)) || {}).name || `#${id}`,
    dates: [...set].sort(),
    full: days.length > 0 && days.every(d => set.has(d)),
  }));

  return {
    ok: true,
    range: { startDate, endDate, startTime: sT, endTime: eT },
    weekdays: days,
    members,
    assigned,
    fullyAssignedBy: assigned.filter(a => a.full).map(a => a.name),
    failedMembers: (outlook.failed || []).map(f => f.name),
    computedAt: new Date().toISOString(),
  };
}

// 아웃룩 조회 결과 단기 캐시 — 날짜/시간을 바꿔가며 여러 번 조회할 때 Graph 왕복을 줄인다.
// 같은 isolate 안에서만 유효하고 TTL이 짧아, 최신성이 크게 떨어지지 않는다.
const OUTLOOK_TTL_MS = 3 * 60 * 1000;
const outlookCache = new Map();   // "start~end" → {at, data}

async function cachedSyncOutlook(env, startDate, endDate) {
  const key = `${startDate}~${endDate}`;
  const hit = outlookCache.get(key);
  if (hit && Date.now() - hit.at < OUTLOOK_TTL_MS) return hit.data;
  const data = await syncOutlook(env, startDate, endDate);
  outlookCache.set(key, { at: Date.now(), data });
  if (outlookCache.size > 20) outlookCache.delete(outlookCache.keys().next().value);
  return data;
}

// ── 공유 설정 (KV) ────────────────────────────────────────────────────────
// 운영자가 화면에서 바꾸는 설정을 모든 PC가 함께 보도록 서버에 보관한다.
// KV 바인딩(SETTINGS)이 없으면 환경변수 INCLUDE_EXTRA 를 읽기 전용으로 사용한다.
const SETTINGS_KEY    = 'roster-config';
const CRM_TICKETS_KEY = 'crm-tickets';

// CRM 티켓 목록 읽기 — 사내 동기화 스크립트가 넣어 둔 값을 그대로 돌려준다.
// 동기화가 멈춰도 마지막 값은 남으므로, 얼마나 오래됐는지(ageHours)를 함께 알려 준다.
// CRM 담당자 변경 요청 대기열 (KV)
const CRM_ASSIGN_QUEUE_KEY = 'crm-assign-queue';
async function readAssignQueue(env) {
  if (!env.SETTINGS) return [];
  try { const raw = await env.SETTINGS.get(CRM_ASSIGN_QUEUE_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; }
  catch (e) { console.error('[crm-assign-queue] 읽기 실패:', e.message); return []; }
}

async function readCrmTickets(env) {
  if (!env.SETTINGS) return { ok: true, tickets: [], syncedAt: null, configured: false };
  try {
    const raw = await env.SETTINGS.get(CRM_TICKETS_KEY);
    const assignQueue = await readAssignQueue(env);   // 카드에 'CRM 변경 대기/실패' 표시용
    if (!raw) return { ok: true, tickets: [], syncedAt: null, configured: true, assignQueue };
    const d = JSON.parse(raw);
    const ageHours = d.syncedAt
      ? Math.round((Date.now() - new Date(d.syncedAt).getTime()) / 36e5 * 10) / 10 : null;
    return { ok: true, tickets: d.tickets || [], syncedAt: d.syncedAt || null,
             source: d.source || null, ageHours, configured: true, assignQueue };
  } catch (e) {
    console.error('[crm-tickets] 읽기 실패:', e.message);
    return { ok: true, tickets: [], syncedAt: null, configured: true, error: '읽기 실패' };
  }
}

// ════════════════════════════════════════════════════════════════════════
// CRM 담당자 → 대시보드 배정 자동 반영
// ════════════════════════════════════════════════════════════════════════
// CRM이 '누가 맡았는가'의 원천이다. 배포지원요청 티켓은 접수 큐(오정훈 상무)로 들어왔다가
// 담당 엔지니어에게 재할당된다. 따라서 티켓 담당자가 명단 멤버이면 '배정 완료'로 보고,
// 요청 기간의 평일마다 배포지원 일정을 만들어 가용 판정·달력·통계에 그대로 반영한다.
//
// 원칙
//  - 이미 같은 사람에게 수동 등록돼 있으면(티켓번호 없음) 티켓번호만 연결 — 중복 생성 안 함
//  - 자동으로 만든 일정(노트가 CRM_AUTO_NOTE로 시작)은 CRM 변경(담당자·기간)을 따라간다
//  - 사람이 등록한 일정은 덮어쓰지 않는다 — 담당자가 다르면 '불일치'로만 보고한다
//  - 지난 날짜는 지우지 않는다(이력 보존). 티켓이 목록에서 빠져도(종료) 아무것도 지우지 않는다
//  - 쓰기 횟수 상한(budget)을 둔다 — 남은 작업은 다음 실행에 이어서 한다(멱등)
const CRM_AUTO_NOTE = 'CRM 담당자 자동 반영';

// 배포지원요청 티켓이 처음 들어오는 '접수 담당자' — 이 사람이 담당이면 아직 배정 전으로 본다.
// (CRM 설정상 기본 담당자가 이하영, 예전 접수 큐가 오정훈 상무)
// ⚠️ 이하영은 배정 대상 멤버이기도 하다. 그래서 CRM 담당이 이하영이면 '자동 배정'하지 않고
//    대시보드에서 실제로 배정한 기록(일정)이 있을 때만 배정된 것으로 본다.
// 환경변수 CRM_QUEUE_OWNERS="이하영,오정훈" 으로 바꿀 수 있다. index.html 의 같은 목록과 맞출 것.
const DEFAULT_CRM_QUEUE_OWNERS = ['이하영', '오정훈'];
function crmQueueOwners(env) {
  const v = String(env.CRM_QUEUE_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set(v.length ? v : DEFAULT_CRM_QUEUE_OWNERS);
}

async function applyCrmAssignments(env, tickets, opts = {}) {
  const stat = { linked: 0, created: 0, moved: 0, extended: 0, removed: 0, mismatch: [], waiting: 0, noPeriod: 0, budgetHit: false };
  if (!env.NOTION_SECRET || !env.SCHEDULES_DB_ID || !env.SPINLOG_DB_ID) return { ok: false, reason: 'env', ...stat };
  if (!Array.isArray(tickets) || tickets.length === 0) return { ok: true, ...stat };

  let budget = opts.maxWrites ?? 40;
  const spend = () => { if (budget <= 0) { stat.budgetHit = true; return false; } budget--; return true; };

  // CRM 배정은 사실이므로 '추가 인원' 설정과 무관하게 전원 명단으로 매칭한다
  const nameToId = new Map(buildRoster(env, true).map(m => [m.name, m.id]));
  const idToName = new Map([...nameToId].map(([n, i]) => [i, n]));
  const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  await ensureSpinLogProp(env);   // '스핀로그ID'·'티켓번호' 속성 보장
  // 이 시스템이 만든 배포 일정 전체 (1회 조회)
  const pages = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const payload = { page_size: 100, filter: { and: [
      { property: '타입', select: { equals: 'deploy' } },
      { property: '아웃룩여부', checkbox: { equals: false } },
    ] } };
    if (cursor) payload.start_cursor = cursor;
    const d = await (await notion(env, 'POST', `/databases/${env.SCHEDULES_DB_ID}/query`, payload)).json();
    pages.push(...(d.results || []));
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  const deploys = pages.map(parseNotionSchedule).filter(Boolean);
  const isAuto = e => String(e.note || '').startsWith(CRM_AUTO_NOTE);

  const createDay = async (t, memberId, date, spinId) => {
    if (!spend()) return false;
    const ev = { memberId, date, type: 'deploy', startTime: '09:00', endTime: '18:00',
      title: `${t.account ? t.account + ' ' : ''}배포지원`, note: `${CRM_AUTO_NOTE} · ${t.ticketNo}`,
      fromOutlook: false, isAllDay: false, outlookId: `crm_${t.ticketNo}_${date}`,
      ticketNo: t.ticketNo, spinLogPageId: spinId || '' };
    await notion(env, 'POST', '/pages', { parent: { database_id: env.SCHEDULES_DB_ID }, properties: notionScheduleProps(ev) });
    return true;
  };
  const archive = async e => {
    if (!spend()) return false;
    await notion(env, 'PATCH', `/pages/${e.pageId}`, { archived: true });
    return true;
  };

  const queueOwners = crmQueueOwners(env);
  for (const t of tickets) {
    const owner = String(t.assignee || '').trim();
    const memberId = queueOwners.has(owner) ? null : nameToId.get(owner);
    if (!memberId) { stat.waiting++; continue; }            // 접수 담당자(이하영·오정훈)·명단 밖 → 아직 배정 전
    if (!t.periodFrom) { stat.noPeriod++; continue; }        // 기간을 모르면 일정을 만들 수 없음
    if (stat.budgetHit) break;
    const from = t.periodFrom, to = t.periodTo && t.periodTo >= t.periodFrom ? t.periodTo : t.periodFrom;
    const wanted = weekdayRange(from, to);
    const mine = deploys.filter(e => e.ticketNo === t.ticketNo);

    if (mine.length) {
      const owners = [...new Set(mine.map(e => e.memberId))];
      if (owners.length === 1 && owners[0] === memberId) {
        // 이미 같은 사람 — 자동 생성분만 기간 변경을 따라간다
        const auto = mine.filter(isAuto);
        if (auto.length === mine.length) {
          const have = new Set(auto.map(e => e.date));
          for (const d of wanted) if (!have.has(d)) { if (!await createDay(t, memberId, d, null)) break; stat.extended++; }
          for (const e of auto) if (!wanted.includes(e.date) && e.date >= kstToday && !e.spinLogPageId) {
            if (!await archive(e)) break; stat.removed++;
          }
        }
        continue;
      }
      // 다른 사람에게 배정돼 있음
      if (!mine.every(isAuto)) {                             // 사람이 등록한 배정은 덮어쓰지 않는다
        stat.mismatch.push({ ticketNo: t.ticketNo, crm: t.assignee,
          dashboard: owners.map(id => idToName.get(id) || `#${id}`) });
        continue;
      }
      // 자동 생성분 → CRM을 따라 새 담당자로 옮긴다 (지난 날짜는 이력으로 남김)
      for (const e of mine) if (e.date >= kstToday) { if (!await archive(e)) break; }
      for (const sp of [...new Set(mine.map(e => e.spinLogPageId).filter(Boolean))]) {
        if (!spend()) break;
        const oldName = idToName.get(mine[0].memberId) || '';
        await notion(env, 'PATCH', `/pages/${sp}`, { properties: mapSpinProps({
          'NAME': { title: [{ text: { content: `[취소] ${oldName}` } }] }, 'MEMBERID': { number: null } }) });
      }
      if (stat.budgetHit) break;
      stat.moved++;
    } else {
      // 티켓번호 없이 같은 사람에게 수동 등록된 일정이 기간 안에 있으면 연결만 한다
      const manual = deploys.filter(e => !e.ticketNo && e.memberId === memberId && e.date >= from && e.date <= to);
      if (manual.length) {
        for (const e of manual) {
          if (!spend()) break;
          await notion(env, 'PATCH', `/pages/${e.pageId}`, { properties: { '티켓번호': { rich_text: [{ text: { content: t.ticketNo } }] } } });
          e.ticketNo = t.ticketNo;
        }
        if (!stat.budgetHit) stat.linked++;
        continue;
      }
    }

    // 새로 만든다: 배정 기록 1건(통계·이력용) + 기간 평일마다 일정 1건(첫날에 기록 연결)
    if (wanted.length === 0) continue;
    if (budget < wanted.length + 1) { stat.budgetHit = true; break; }   // 반쪽 생성 대신 다음 실행으로
    spend();
    const spin = await (await notion(env, 'POST', '/pages', { parent: { database_id: env.SPINLOG_DB_ID },
      properties: mapSpinProps({
        'NAME':     { title: [{ text: { content: idToName.get(memberId) || t.assignee } }] },
        'DATE':     { date: { start: from } },
        'SPUNAT':   { rich_text: [{ text: { content: `CRM 담당자 지정 · ${t.ticketNo} · 기간 ${from}~${to}` } }] },
        'MEMBERID': { number: memberId },
      }) })).json();
    let first = true;
    for (const d of wanted) {
      if (!await createDay(t, memberId, d, first ? spin.id : null)) break;
      first = false;
    }
    stat.created++;
  }
  console.log('[crm-assign]', JSON.stringify(stat));
  return { ok: true, ...stat };
}

async function readSettings(env) {
  const fallback = { includeExtra: String(env.INCLUDE_EXTRA ?? '0') === '1' };
  if (!env.SETTINGS) return { ...fallback, editable: false, source: 'env' };
  try {
    const raw = await env.SETTINGS.get(SETTINGS_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return {
      includeExtra: saved && typeof saved.includeExtra === 'boolean'
        ? saved.includeExtra : fallback.includeExtra,
      editable: true, source: saved ? 'kv' : 'env',
      updatedAt: saved?.updatedAt || null, updatedBy: saved?.updatedBy || null,
    };
  } catch (e) {
    console.error('[settings] 읽기 실패:', e.message);
    return { ...fallback, editable: false, source: 'env' };
  }
}

async function writeSettings(env, patch, who) {
  if (!env.SETTINGS) {
    const err = new Error('서버에 공유 설정 저장소(KV)가 연결돼 있지 않습니다. 관리자 설정 필요: wrangler kv namespace create SETTINGS');
    err.status = 501;
    throw err;
  }
  const cur = await readSettings(env);
  const next = {
    includeExtra: typeof patch.includeExtra === 'boolean' ? patch.includeExtra : cur.includeExtra,
    updatedAt: new Date().toISOString(),
    updatedBy: (who || '').slice(0, 40),
  };
  await env.SETTINGS.put(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// 멤버 명단 — 서버가 유일한 기준.
// ⚠️ 과거엔 프론트의 '추가 인원' 토글이 PC별 localStorage에 저장돼,
//    같은 날 운영자마다 후보군(8명/11명)이 달랐다. 이제 서버 공유 설정을 따른다.
function buildRoster(env, includeExtraOverride) {
  const emails = JSON.parse(env.MEMBER_EMAILS || '{}');
  const ids    = JSON.parse(env.MEMBER_IDS    || '{}');
  const includeExtra = typeof includeExtraOverride === 'boolean'
    ? includeExtraOverride : String(env.INCLUDE_EXTRA ?? '0') === '1';
  const extraIds = new Set(Object.values(EXTRA_MEMBERS).map(([, id]) => id));
  for (const [nm,[em,eid]] of Object.entries(EXTRA_MEMBERS)) {
    if (!emails[nm]) emails[nm] = em;
    if (!ids[nm])    ids[nm]    = eid;
  }
  return Object.keys(emails)
    .filter(nm => ids[nm])
    .map(nm => ({ id: ids[nm], name: nm, extra: extraIds.has(ids[nm]) }))
    .filter(m => includeExtra || !m.extra)
    .sort((a,b) => a.id - b.id);
}

// ── 스핀 이력에 '실제 배정 완료' 여부 표시 ────────────────────────────────
// 스핀 이력(SPINLOG)은 '추첨했다'는 기록일 뿐이라, 배정 모달에서 저장을 누르지 않으면
// 일정이 만들어지지 않는다. 운영자가 둘을 구분할 수 있도록 배포 일정과 대조한다.
//   · 1순위: 배포 일정의 '스핀로그ID' 가 이력 id 와 일치
//   · 2순위(구 기록 호환): 같은 멤버 + 이력의 대상 기간 안에 배포 일정이 존재
async function annotateSpinLogs(env, logs) {
  if (!env.SCHEDULES_DB_ID || logs.length === 0) return logs;
  let deploys = [];
  try {
    const pages = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const payload = { page_size: 100, filter: { and: [
        { property: '타입',     select:   { equals: 'deploy' } },
        { property: '아웃룩여부', checkbox: { equals: false } },
      ] } };
      if (cursor) payload.start_cursor = cursor;
      const res = await notion(env, 'POST', `/databases/${env.SCHEDULES_DB_ID}/query`, payload);
      const d = await res.json();
      pages.push(...(d.results || []));
      if (!d.has_more || !d.next_cursor) break;
      cursor = d.next_cursor;
    }
    deploys = pages.map(parseNotionSchedule).filter(Boolean);
  } catch (e) {
    console.error('[spinlog] 배포 일정 대조 실패:', e.message);
    return logs;   // 대조 실패 시 표시를 생략할 뿐, 이력 자체는 그대로 반환
  }

  const bySpinId = new Map();
  for (const ev of deploys) {
    if (!ev.spinLogPageId) continue;
    const k = ev.spinLogPageId.replace(/-/g, '');
    (bySpinId.get(k) || bySpinId.set(k, []).get(k)).push(ev);
  }

  for (const log of logs) {
    if (log.memberId == null) continue;                    // [취소]·[초기화] 는 대상 아님
    let matched = bySpinId.get(String(log.id).replace(/-/g, '')) || [];
    if (matched.length === 0) {
      // 구 기록 호환: 멤버와 기간으로 추정
      const m = (log.spunAt || '').match(/기간\s+(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
      const from = m ? m[1] : log.targetDate;
      const to   = m ? m[2] : log.targetDate;
      if (from) matched = deploys.filter(ev =>
        ev.memberId === log.memberId && ev.date >= from && ev.date <= to);
    }
    if (matched.length > 0) {
      const dates = matched.map(e => e.date).sort();
      log.confirmed      = true;
      log.confirmedDays  = dates.length;
      log.confirmedRange = dates[0] === dates[dates.length - 1]
        ? dates[0] : `${dates[0]}~${dates[dates.length - 1]}`;
      log.eventTitle     = matched[0].title || '';
      log.ticketNo       = (matched.find(e => e.ticketNo) || {}).ticketNo || null;
    } else {
      log.confirmed = false;
    }
  }
  return logs;
}

// ── 배정 통계 (요구사항 §4-3 "공정성을 수치로 증명") ──────────────────────
// [취소]·[초기화] 로그는 멤버ID가 없어 자연히 제외된다.
// from/to로 기간을 좁히면 초기 테스트 스핀을 걸러낼 수 있다.
async function buildStats(env, { from, to } = {}) {
  if (!env.NOTION_SECRET || !env.SPINLOG_DB_ID) throw new Error('Notion 미설정');
  const rows = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const payload = { sorts:[{timestamp:'created_time',direction:'descending'}], page_size:100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await notion(env,'POST',`/databases/${env.SPINLOG_DB_ID}/query`,payload);
    const d = await res.json();
    rows.push(...(d.results||[]));
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  const logs = rows.map(p => {
    const pr = p.properties || {};
    return {
      id: p.id,
      name: getNotionText(pr,'이름'),
      targetDate: pr['날짜']?.date?.start || '',
      memberId: pr['멤버ID']?.number ?? null,
      spunAt: getNotionRichText(pr,'스핀일'),
      createdTime: p.created_time,
    };
  });

  // 추첨만 하고 일정 등록을 안 한 건(confirmed:false)은 '배정'이 아니므로 집계에서 뺀다.
  // (배포 일정 대조에 실패하면 confirmed 가 비어 있고, 그때는 보수적으로 집계에 포함)
  await annotateSpinLogs(env, logs);

  const roster = buildRoster(env, (await readSettings(env)).includeExtra);
  const rosterIds = new Set(roster.map(m => m.id));
  const inRange = l => (!from || l.createdTime.slice(0,10) >= from)
                    && (!to   || l.createdTime.slice(0,10) <= to);
  const assignedLogs = logs.filter(l => l.memberId != null && inRange(l));
  const unconfirmed  = assignedLogs.filter(l => l.confirmed === false).length;
  const confirmedLogs = assignedLogs.filter(l => l.confirmed !== false);
  // 비율·평균은 현재 후보 명단 기준 (명단 밖 인원 기록이 섞이면 비율 합이 100%가 안 됨)
  const outsideRoster = confirmedLogs.filter(l => !rosterIds.has(l.memberId)).length;
  const valid = confirmedLogs.filter(l => rosterIds.has(l.memberId));

  const byId = {};
  valid.forEach(l => {
    const s = byId[l.memberId] = byId[l.memberId] || { count:0, last:null, dates:[], items:[] };
    s.count++;
    s.dates.push(l.targetDate || l.createdTime.slice(0,10));
    if (!s.last || l.createdTime > s.last) s.last = l.createdTime;
    // 통계에서 멤버를 누르면 보여줄 '어떤 건에 배정됐는가' 목록
    const spun = String(l.spunAt || '');
    const periodM = spun.match(/기간\s+(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
    s.items.push({
      period:   l.confirmedRange || (periodM ? `${periodM[1]}~${periodM[2]}` : (l.targetDate || '')),
      days:     l.confirmedDays || null,
      title:    l.eventTitle || '',
      ticketNo: l.ticketNo || (spun.match(/\b(TT\d+)\b/) || [])[1] || null,
      source:   spun.startsWith('CRM 담당자 지정') ? 'CRM' : (spun.startsWith('복원 배정') ? '복원' : '대시보드'),
      recordedAt: l.createdTime.slice(0,10),
    });
  });

  const total = valid.length;
  const members = roster.map(m => {
    const s = byId[m.id] || { count:0, last:null, dates:[], items:[] };
    return {
      id:m.id, name:m.name, extra:m.extra,
      count:s.count,
      share: total ? Math.round(s.count / total * 1000) / 10 : 0,   // 비율(%) 소수 1자리
      lastAssigned: s.last ? s.last.slice(0,10) : null,
      dates: s.dates.sort(),
      items: s.items.sort((a, b) => (b.period || '').localeCompare(a.period || '')),   // 최근 배정 먼저
    };
  }).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name,'ko'));

  // 쏠림 지표: 최다/최소 격차와 평균 대비 편차
  const counts = members.map(m => m.count);
  const avg = counts.length ? total / counts.length : 0;
  return {
    ok:true,
    range: { from: from || null, to: to || null },
    total,
    cancelledOrReset: logs.filter(l => l.memberId == null && inRange(l)).length,
    unconfirmed,      // 추첨만 되고 일정 미등록 → 제외
    outsideRoster,    // 현재 후보 명단 밖 인원 → 제외
    members,
    fairness: {
      average: Math.round(avg * 10) / 10,
      max: counts.length ? Math.max(...counts) : 0,
      min: counts.length ? Math.min(...counts) : 0,
      neverAssigned: members.filter(m => m.count === 0).map(m => m.name),
    },
    computedAt: new Date().toISOString(),
  };
}

// 추가 후보 3명 (ID 9·10·11) — 명단은 여기 한 곳에서만 관리
const EXTRA_MEMBERS = {
  '문병린': ['brmun@softcamp.co.kr', 9],
  '문정일': ['jungil.moon@softcamp.co.kr', 10],
  '양창호': ['chh.yang@softcamp.co.kr', 11],
};

// ── 아웃룩 동기화 핵심 로직 ──────────────────────────────────────────────
async function syncOutlook(env, startDate, endDate) {
  const token        = await getGraphToken(env);
  const memberEmails = JSON.parse(env.MEMBER_EMAILS||'{}');
  const memberIds    = JSON.parse(env.MEMBER_IDS||'{}');
  // 추가 후보 3명 (ID 9·10·11) — env에 없어도 하드코딩으로 동기화에 포함
  const EXTRA = { '문병린': ['brmun@softcamp.co.kr', 9], '문정일': ['jungil.moon@softcamp.co.kr', 10], '양창호': ['chh.yang@softcamp.co.kr', 11] };
  for (const [nm, [em, eid]] of Object.entries(EXTRA)) {
    if (!memberEmails[nm]) memberEmails[nm] = em;
    if (!memberIds[nm])    memberIds[nm]    = eid;
  }
  const allEvents    = [];
  const failed       = [];   // 조회 실패한 멤버 — 아카이브 대상에서 제외하기 위해 추적
  for (const [name,email] of Object.entries(memberEmails)) {
    const memberId = memberIds[name];
    if (!memberId) continue;
    try {
      const events = await getCalendarEvents(token,email,startDate,endDate);
      for (const ev of events) {
        const isAllDay   = ev.isAllDay;
        const rawStartDT = ev.start?.dateTime||'';
        const rawEndDT   = ev.end?.dateTime||'';
        if (!rawStartDT || !ev.id) continue;
        const startDT = toKST(rawStartDT, ev.start?.timeZone||'UTC');
        // 종료시각이 없거나 깨진 경우 시작일 기준으로 보정 (과거엔 이벤트가 통째로 누락됐다)
        const endDT   = rawEndDT ? toKST(rawEndDT, ev.end?.timeZone||'UTC') : startDT;
        const startDay = startDT.slice(0,10);
        let lastDay = (endDT.slice(0,10) || startDay);
        if (isAllDay && lastDay>startDay) {
          // 종일 일정의 end는 exclusive(다음 날 00:00) → 하루 빼서 실제 마지막 날로
          lastDay=addDaysISO(lastDay,-1);
        } else if (!isAllDay && lastDay>startDay && endDT.slice(11,16)==='00:00') {
          // 자정에 끝나는 시간제 일정이 다음 날까지 유령으로 번지던 문제 보정
          lastDay=addDaysISO(lastDay,-1);
        }
        if (lastDay<startDay) lastDay=startDay;
        const sTime = isAllDay?'09:00':startDT.slice(11,16);
        const eTime = isAllDay?'18:00':endDT.slice(11,16);
        const multiDay = lastDay>startDay;
        // 조회 창 안쪽만 순회 — 과거엔 아주 오래 전에 시작한 장기 일정이
        // 365회 가드를 다 쓰고도 창에 도달하지 못해 통째로 사라졌다.
        let ds = startDay < startDate ? startDate : startDay;
        const until = lastDay > endDate ? endDate : lastDay;
        for (let i=0; ds<=until && i<400; i++, ds=addDaysISO(ds,1)) {
          // ⚠️ 아웃룩ID 뒤 16자만 사용 — 기존 Notion 페이지와의 호환을 위해 유지한다.
          //    (형식을 바꾸면 기존 사본이 전부 아카이브되고 수동 분류가 소실됨)
          //    같은 멤버·같은 날 뒤 16자가 겹치면 충돌 가능하나 확률은 매우 낮음.
          const oid=`ol_${memberId}_${ds}_${ev.id.slice(-16)}`;
          allEvents.push({
            id:oid,
            memberId, date:ds,
            title:(isAllDay?'🌐 ':'')+(ev.subject||'(제목 없음)'),
            // 여러 날에 걸친 시간제 일정은 중간 날의 시간대를 알 수 없다.
            // 과거엔 첫날 시간(예: 14:00~18:00)을 모든 날에 복제해, 중간 날 오전이
            // 비어 보여 "가능"으로 오판됐다. 이제 중간 날은 하루 전체로 처리한다.
            startTime: multiDay && !isAllDay ? (ds===startDay ? sTime : '09:00') : sTime,
            endTime:   multiDay && !isAllDay ? (ds===until    ? eTime : '18:00') : eTime,
            isAllDay:  isAllDay || (multiDay && !isAllDay && ds!==startDay && ds!==until),
            type:classifyEventType(ev.showAs, ev.subject),
            note:ev.bodyPreview||'',
            fromOutlook:true,
            outlookId:oid,
          });
        }
      }
    } catch(e) {
      // ⚠️ 과거엔 가짜 '[오류]' 이벤트를 넣었다. 그러면 이 멤버의 실제 일정 ID가 newOids에 없어
      //    동기화 4단계가 그 사람의 기존 Notion 일정을 전부 아카이브(= 수동 분류까지 삭제)했다.
      //    이제는 실패한 멤버를 기록해 두고, 아카이브 대상에서 통째로 제외한다.
      console.error(`[syncOutlook] ${name}(${email}) 조회 실패: ${e.message}`);
      failed.push({ memberId, name, error: e.message });
    }
  }
  return {ok:true, events:allEvents, count:allEvents.length,
          failed, failedMemberIds:failed.map(f=>f.memberId)};
}

// ── Graph Token ───────────────────────────────────────────────────────────
// 토큰은 보통 1시간 유효. 과거엔 요청마다 재발급해 외부 호출 1건과 지연을 낭비했다.
let graphTokenCache = { token: null, expiresAt: 0 };

async function getGraphToken(env) {
  if (graphTokenCache.token && Date.now() < graphTokenCache.expiresAt) return graphTokenCache.token;
  const token = await fetchGraphToken(env);
  return token;
}

async function fetchGraphToken(env) {
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
  const data=await res.json();
  // 만료 60초 전에 갱신되도록 여유를 둔다
  graphTokenCache={token:data.access_token,
    expiresAt:Date.now()+Math.max(0,(Number(data.expires_in)||3600)-60)*1000};
  return data.access_token;
}

// ── Calendar Events ───────────────────────────────────────────────────────
// 기간 내 캘린더 일정 전체 조회.
// ⚠️ calendarView는 $top을 넘으면 @odata.nextLink로 이어진다. 과거엔 이를 따라가지 않아
//    500건 초과 시 뒷날짜가 조용히 잘렸고 → "일정 없음 = 가용"으로 오판하는 원인이었다.
async function getCalendarEvents(token,email,startDate,endDate) {
  const params=new URLSearchParams({
    // KST 오프셋을 명시 — 과거 'T00:00:00Z'는 KST 09:00이라 첫날 오전 일정이 누락됐다
    startDateTime:`${startDate}T00:00:00+09:00`,
    endDateTime:`${endDate}T23:59:59+09:00`,
    $select:'id,subject,start,end,showAs,bodyPreview,isAllDay',$top:'250'});
  let url=`${GRAPH_BASE}/users/${email}/calendarView?${params}`;
  const all=[];
  for (let page=0; url && page<40; page++) {   // 최대 1만 건 가드 (무한 루프 방지)
    // 일시적 오류(요청 과다 429, 서버 5xx, 네트워크)는 자동 재시도 — 한 번 실패로
    // 그 사람이 '조회 실패 → 후보 제외'되지 않게 한다. 권한 오류(401/403/404)는 재시도해도 같으므로 바로 실패.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url,
          {headers:{'Authorization':`Bearer ${token}`,'Prefer':'outlook.timezone="Korea Standard Time"'}});
      } catch (netErr) {
        if (attempt >= 2) throw new Error(`네트워크 오류: ${netErr.message}`);
        await sleep(500 * 2 ** attempt); continue;
      }
      if (res.ok || attempt >= 2 || !(res.status === 429 || res.status >= 500)) break;
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(ra > 0 ? Math.min(ra, 5) * 1000 : 500 * 2 ** attempt);
    }
    if (!res.ok){const e=await res.json().catch(()=>({}));
      throw new Error(e?.error?.message||`HTTP ${res.status}`);}
    const data=await res.json();
    all.push(...(data.value||[]));
    url=data['@odata.nextLink']||null;
  }
  return all;
}

// 이벤트 제목 기반 타입 분류 (화면 색상용). 가용/불가 판정은 프론트의 classifyAvailability가 담당.
// ⚠️ OUT_KEYWORDS는 index.html과 동일하게 유지할 것 — 과거 두 파일의 목록이 달라 규칙이 갈렸다.
const OUT_KEYWORDS  = ['연차','반차','휴가','외근','출장','재택','공휴일','경조','병가','조퇴','OOF','부재중'];
const DEPLOY_KEYWORDS = ['배포','deploy'];

const MEETING_EXCEPTIONS = ['배포회의', '[내부업무]', '[내부]'];  // 배포/부재 키워드가 있어도 회의로 분류

function classifyEventType(showAs, title) {
  const t = (title||'').toLowerCase();
  if (showAs === 'oof' || showAs === 'workingElsewhere') return 'out';
  // 예외 먼저 — '[내부업무] 재택 코드리뷰'가 '재택'에 걸려 out이 되던 순서 역전 수정
  if (MEETING_EXCEPTIONS.some(k => t.includes(k))) return 'meeting';
  if (OUT_KEYWORDS.some(k => t.includes(k.toLowerCase()))) return 'out';
  if (DEPLOY_KEYWORDS.some(k => t.includes(k))) return 'deploy';
  return 'meeting';
}

// Graph 응답 시각을 KST 벽시계 문자열로 변환.
// Prefer 헤더로 KST를 요청하므로 대개 'Korea Standard Time'으로 돌아온다.
// ⚠️ 그 외 타임존 이름(예: 'Pacific Standard Time')이 오면 오프셋을 알 수 없어
//    UTC로 간주하던 과거 동작은 시각을 어긋나게 만든다 → 이제 명시적으로 처리한다.
function toKST(dtStr,timeZone){
  if (!dtStr) return '';
  if (timeZone==='Korea Standard Time') return dtStr;
  try {
    const hasOffset = dtStr.includes('Z') || /[+-]\d{2}:\d{2}$/.test(dtStr);
    if (hasOffset) {                       // 절대시각이므로 정확히 KST로 환산 가능
      const d=new Date(dtStr); d.setUTCHours(d.getUTCHours()+9);
      return d.toISOString().slice(0,19);
    }
    if (timeZone==='UTC' || !timeZone) {   // 오프셋 없는 UTC 표기
      const d=new Date(dtStr+'Z'); d.setUTCHours(d.getUTCHours()+9);
      return d.toISOString().slice(0,19);
    }
    // 오프셋도 없고 KST/UTC도 아닌 타임존 → 변환 불가. 원문을 그대로 쓰고 경고만 남긴다
    // (임의로 +9를 더하면 그 오프셋만큼 일정이 어긋난다)
    console.warn(`[toKST] 변환 불가 타임존: ${timeZone} — 원문 사용`);
    return dtStr;
  } catch(_){return dtStr;}
}

// ── 공통 유틸 ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 길이 노출을 줄인 상수시간 비교 (타이밍 공격 완화)
// TRUSTED_IPS: 쉼표로 구분한 회사 공인 IP 목록 (시크릿 — 공개 저장소에 주소를 남기지 않는다)
function isTrustedIp(request, env) {
  const ip = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return false;
  return String(env.TRUSTED_IPS || '').split(',').map(s => s.trim()).filter(Boolean).includes(ip);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// 메일/캘린더 본문에 들어가는 사용자 입력 이스케이프 (HTML 인젝션 차단)
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ── Notion Helpers ────────────────────────────────────────────────────────
// Notion은 평균 초당 3요청 제한. 429/5xx는 Retry-After를 존중해 지수 백오프 재시도하고,
// 그 외 실패는 throw → 호출부가 "조용히 성공한 것처럼" 넘어가지 않도록 한다.
async function notion(env, method, path, body, opts = {}) {
  const maxRetry = opts.maxRetry ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.notion.com/v1${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${env.NOTION_SECRET}`,
          'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      if (attempt >= maxRetry) throw new Error(`Notion 네트워크 오류: ${netErr.message}`);
      await sleep(Math.min(4000, 300 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
    if (retryable && attempt < maxRetry) {
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(ra > 0 ? ra * 1000 : Math.min(4000, 300 * 2 ** attempt));
      continue;
    }
    const detail = await res.json().catch(() => ({}));
    const err = new Error(`Notion ${method} ${path} 실패 (${res.status}) ${detail.message || ''}`.trim());
    err.status = res.status;
    throw err;
  }
}

// 페이지가 지정한 데이터베이스 소속인지 확인 — 임의 pageId 삭제/변조 방지
async function assertPageInDb(env, pageId, dbId) {
  if (!pageId) throw new Error('pageId 필요');
  if (!dbId)   throw new Error('대상 DB 미설정');
  const res  = await notion(env, 'GET', `/pages/${pageId}`);
  const page = await res.json();
  const parent = page?.parent?.database_id || '';
  if (parent.replace(/-/g, '') !== String(dbId).replace(/-/g, '')) {
    const err = new Error('이 시스템이 관리하지 않는 페이지입니다');
    err.status = 403;
    throw err;
  }
  return page;
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
    spinLogPageId:  getNotionRichText(p,'스핀로그ID') || null,  // 배정↔스핀이력 연결(모든 PC 공유)
    ticketNo:       getNotionRichText(p,'티켓번호')   || null,  // 배정↔CRM 티켓 연결
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
  // 배정↔스핀이력 연결 고리. 과거엔 이 값이 각 PC의 localStorage에만 있어서,
  // 다른 PC에서 배정을 취소하면 우선순위가 복구되지 않았다.
  if (d.spinLogPageId !== undefined) {
    props['스핀로그ID'] = {rich_text:[{text:{content:d.spinLogPageId||''}}]};
  }
  // CRM 배포지원요청 티켓 번호 — 티켓 목록에서 '배정 완료'를 판별하는 연결 고리
  if (d.ticketNo !== undefined) {
    props['티켓번호'] = {rich_text:[{text:{content:d.ticketNo||''}}]};
  }
  return props;
}

// SCHEDULES_DB에 '스핀로그ID' 속성이 없으면 1회 추가 (nullable 텍스트 — 기존 데이터 영향 없음)
let spinLogPropEnsured = false;
async function ensureSpinLogProp(env) {
  if (spinLogPropEnsured || !env.SCHEDULES_DB_ID) return;
  try {
    await notion(env,'PATCH',`/databases/${env.SCHEDULES_DB_ID}`,
      {properties:{'스핀로그ID':{rich_text:{}}, '티켓번호':{rich_text:{}}}});
    spinLogPropEnsured = true;
  } catch(e) { console.error('[schema] 속성 추가 실패:', e.message); }
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
