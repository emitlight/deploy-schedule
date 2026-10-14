#!/usr/bin/env node
/**
 * CRM 배포지원요청 티켓 → 배포지원 대시보드 동기화
 *
 * 왜 이 스크립트가 사내 서버에서 도는가:
 *   CRM DB는 사내 사설망(10.10.200.86)에 있어 Cloudflare Worker에서 직접 붙을 수 없다.
 *   (사설 IP + Workers의 TCP 제약 + 공인 DNS 404 — 세 겹으로 막힘)
 *   그래서 사내망과 인터넷에 모두 닿는 이 서버가 CRM을 읽어 Worker로 "밀어 넣는다".
 *   방향이 '안 → 밖'이라 인바운드 방화벽을 열 필요가 없다.
 *
 * 하는 일:
 *   1) CRM에서 지원유형=배포지원요청 + 담당자가 커뮤니케이션본부인 미종료 티켓 조회 (SELECT만)
 *   2) 본문에서 '배포관리 요청일' 기간을 추출
 *   3) Worker의 ingest-crm-tickets 로 POST
 *
 * 실행: node crm-deploy-tickets-sync.js [--dry-run]
 * 설정: 같은 폴더의 .env (CRM_DB_* 는 파트너센터 .env 에서 자동으로 읽어옴)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');

// ── 설정 ────────────────────────────────────────────────────────────────
const HERE = __dirname;
const PARTNERCENTER_ENV = process.env.PARTNERCENTER_ENV
  || '/var/lib/jenkins/deploy/partnercenter/backend/.env';

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const localEnv = readEnvFile(path.join(HERE, '.env'));
const pcEnv    = readEnvFile(PARTNERCENTER_ENV);   // CRM 접속정보의 단일 출처
const cfg = key => process.env[key] || localEnv[key] || pcEnv[key] || '';

const WORKER_URL   = cfg('WORKER_URL');
const INGEST_TOKEN = cfg('INGEST_TOKEN');
const DRY = process.argv.includes('--dry-run');

// 커뮤니케이션본부 — 파트너센터 config 와 같은 목록을 유지할 것
const COMM_MEMBERS = (cfg('COMMUNICATION_DIVISION_MEMBER_NAMES') ||
  '오정훈,문정일,이정기,강진혁,김선우,양창호,구경완,김요엘,문병린,윤이나,이하영,이송민,김정환')
  .split(',').map(s => s.trim()).filter(Boolean);

// ⚠️ CRM에 저장된 지원유형 '원문'은 영문이다. 한글 '배포지원요청'은 번역 테이블의 라벨일 뿐이라
//    한글로 조회하면 조용히 0건이 나온다 (2026-10-14 실측 확인).
const CATEGORY_RAW = cfg('CRM_DEPLOY_CATEGORY') || 'Distribute Support Request';
const CATEGORY_KO  = '배포지원요청';
const CLOSED_STATUSES = ['Closed', '닫힘'];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── 본문에서 배포 기간 추출 ──────────────────────────────────────────────
// 배포관리요청서 양식의 '배포관리 요청일  2026.10.19 ~ 2026.11.16' 을 읽는다.
// 제품 버전(DS 6.0/15.2 등)을 날짜로 오인하지 않도록 연도 4자리를 요구한다.
function parsePeriod(desc) {
  if (!desc) return { from: null, to: null };
  const s = String(desc).replace(/\s+/g, ' ');
  const D = '([0-9]{4})[.\\-\\/]\\s*([0-9]{1,2})[.\\-\\/]\\s*([0-9]{1,2})';
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let m = s.match(new RegExp(`배포관리\\s*요청일\\s*${D}\\s*~\\s*${D}`));
  if (m) return { from: iso(m[1], m[2], m[3]), to: iso(m[4], m[5], m[6]) };
  m = s.match(new RegExp(`배포관리\\s*요청일\\s*${D}`));
  if (m) return { from: iso(m[1], m[2], m[3]), to: null };
  return { from: null, to: null };
}

function parseField(desc, label) {
  if (!desc) return '';
  const m = String(desc).replace(/\r/g, '').match(new RegExp(label + '\\s*\\t*([^\\t\\n]{1,60})'));
  return m ? m[1].trim() : '';
}

// ── 메인 ─────────────────────────────────────────────────────────────────
(async () => {
  for (const k of ['CRM_DB_HOST', 'CRM_DB_USER', 'CRM_DB_PASSWORD']) {
    if (!cfg(k)) { console.error(`설정 누락: ${k} (파트너센터 .env 경로 확인: ${PARTNERCENTER_ENV})`); process.exit(2); }
  }
  if (!DRY && (!WORKER_URL || !INGEST_TOKEN)) {
    console.error('설정 누락: WORKER_URL / INGEST_TOKEN (sync/.env 확인)'); process.exit(2);
  }

  const pool = mariadb.createPool({
    host: cfg('CRM_DB_HOST'), port: Number(cfg('CRM_DB_PORT')) || 3306,
    user: cfg('CRM_DB_USER'), password: cfg('CRM_DB_PASSWORD'),
    database: cfg('CRM_DB_DATABASE') || 'vtigercrm',
    charset: 'utf8mb4', connectionLimit: 2, connectTimeout: 15000,
    acquireTimeout: 20000, bigIntAsNumber: true, allowPublicKeyRetrieval: true,
  });

  // 지원유형은 원문·번역값 어느 쪽이 저장돼 있어도 잡히도록 둘 다 본다.
  // 상태는 종료(Closed/닫힘)만 제외 — 미종료 건이 전체의 1% 미만이라 범위가 작다.
  const SQL = `
    SELECT a.ticketid, a.ticket_no, a.title,
           TRIM(CAST(a.status AS CHAR))                               AS status,
           COALESCE(n.ko_kr, a.status)                                AS status_ko,
           f.last_name                                                AS assignee,
           COALESCE(NULLIF(TRIM(g.accountname),''), c.cf_2184)        AS account,
           d.last_name                                                AS requester,
           DATE_FORMAT(b.createdtime + INTERVAL 9 HOUR,'%Y-%m-%d')    AS created_kst,
           b.description                                              AS description
      FROM vtiger_troubletickets a
      JOIN      vtiger_crmentity b ON b.crmid     = a.ticketid AND b.deleted <> 1
      LEFT JOIN vtiger_ticketcf  c ON c.ticketid  = a.ticketid
      LEFT JOIN vtiger_users     f ON f.id        = b.smownerid
      LEFT JOIN vtiger_users     d ON d.id        = b.smcreatorid
      LEFT JOIN vtiger_account   g ON g.accountid = a.parent_id
      LEFT JOIN (SELECT value, MAX(ko_kr) AS ko_kr FROM sc_translation_table
                  WHERE moduleid = 13 GROUP BY value) k ON k.value = a.category
      LEFT JOIN (SELECT value, MAX(ko_kr) AS ko_kr FROM sc_translation_table
                  WHERE moduleid = 13 GROUP BY value) n
             ON TRIM(CAST(n.value AS CHAR)) = TRIM(CAST(a.status AS CHAR))
     WHERE (TRIM(CAST(a.category AS CHAR)) = ? OR TRIM(COALESCE(k.ko_kr,'')) = ?)
       AND TRIM(IFNULL(f.last_name,'')) IN (${COMM_MEMBERS.map(() => '?').join(',')})
       AND TRIM(CAST(a.status AS CHAR)) NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})
       AND b.createdtime >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY)
     ORDER BY b.createdtime DESC
     LIMIT 200`;

  let rows;
  try {
    const t0 = Date.now();
    rows = await pool.query({ sql: SQL, timeout: 30000 },
      [CATEGORY_RAW, CATEGORY_KO, ...COMM_MEMBERS, ...CLOSED_STATUSES]);
    log(`CRM 조회 완료 — ${rows.length}건 (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error('CRM 조회 실패:', e.code || '', e.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  await pool.end().catch(() => {});

  const crmBase = (cfg('VTIGER_URL') || 'https://crm.softcamp.co.kr').replace(/\/$/, '');
  const tickets = rows.map(r => {
    const p = parsePeriod(r.description);
    return {
      ticketId: String(r.ticketid),
      ticketNo: r.ticket_no || '',
      title: r.title || '',
      status: r.status_ko || r.status || '',
      assignee: r.assignee || '',
      account: r.account || '',
      requester: r.requester || '',
      projectCode: parseField(r.description, '프로젝트코드'),
      periodFrom: p.from, periodTo: p.to,
      createdKst: r.created_kst || '',
      url: `${crmBase}/index.php?module=HelpDesk&action=DetailView&record=${r.ticketid}`,
    };
  });

  for (const t of tickets) {
    log(`  [${t.ticketNo}] ${t.status} 담당:${t.assignee} 고객사:${t.account || '-'} ` +
        `기간:${t.periodFrom ? `${t.periodFrom}~${t.periodTo || '?'}` : '미기재'}`);
  }

  if (DRY) { log('--dry-run 이므로 전송하지 않고 종료합니다.'); return; }

  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               'X-Action': 'ingest-crm-tickets', 'X-Auth': INGEST_TOKEN },
    body: JSON.stringify({ tickets, source: 'partnercenter-cron' }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) {
    console.error(`전송 실패 HTTP ${res.status}:`, out.error || '(응답 없음)');
    process.exit(1);
  }
  log(`전송 완료 — ${out.stored}건 적재`);
})().catch(e => { console.error('예외:', e && e.stack || e); process.exit(1); });
