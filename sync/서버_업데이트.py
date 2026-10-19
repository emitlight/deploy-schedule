# 파트너센터 서버의 CRM 동기화 스크립트 갱신 + 실행 주기 변경 (10분)
#
# 하는 일
#   1) sync/crm-deploy-tickets-sync.js 를 서버(/opt/deploy-schedule-sync)에 덮어쓰기
#      (서버의 .env 는 건드리지 않는다 — 토큰·경로 설정 유지)
#   2) --dry-run 으로 점검 (CRM 조회 + 담당자 변경 예정 목록만 출력, 쓰기 없음)
#   3) 실제 1회 실행
#   4) cron 을 '평일 07~20시 10분마다'로 변경
#      → 대시보드에서 배정하면 10분 안에 CRM 담당자가 바뀐다
#
# 실행 (이 PC 터미널에서, 직접):
#   python "sync/서버_업데이트.py"
# 서버 비밀번호는 실행 중에 입력받는다(화면에 표시되지 않음). 이전 설치 때 만든
# %TEMP%\.pcsync_cred 파일이 남아 있으면 그것을 쓴다.
import os, sys, posixpath, getpass
try:
    import paramiko
except ImportError:
    print('paramiko 가 없습니다:  pip install paramiko'); sys.exit(1)

HOST, PORT, USER = '211.175.98.24', 22, 'scadmin'
HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = '/opt/deploy-schedule-sync'
SCRIPT = 'crm-deploy-tickets-sync.js'
CRON = f'*/10 7-20 * * 1-5 cd {REMOTE} && /usr/bin/node {SCRIPT} >> {REMOTE}/sync.log 2>&1 # deploy-schedule-sync'

cred_file = os.path.join(os.environ.get('TEMP', ''), '.pcsync_cred')
if os.path.exists(cred_file):
    with open(cred_file, encoding='utf-8') as f:
        PW = f.read().strip()
else:
    PW = getpass.getpass(f'{USER}@{HOST} 비밀번호: ')

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=PORT, username=USER, password=PW, timeout=20, allow_agent=False, look_for_keys=False)

def run(cmd, check=False):
    _, out, err = cli.exec_command(cmd, timeout=180)
    o = out.read().decode('utf-8', 'replace').strip()
    e = err.read().decode('utf-8', 'replace').strip()
    rc = out.channel.recv_exit_status()
    if o: print('   ' + o.replace('\n', '\n   '))
    if e: print('   [stderr] ' + e.replace('\n', '\n   ')[:800])
    if check and rc != 0:
        print(f'   ❌ 종료코드 {rc} — 중단합니다'); cli.close(); sys.exit(1)
    return rc

print('1) 스크립트 업로드 (기존 파일은 .bak 으로 보관)')
run(f'cd {REMOTE} && cp -f {SCRIPT} {SCRIPT}.bak 2>/dev/null; echo 백업 완료', check=True)
sftp = cli.open_sftp()
sftp.put(os.path.join(HERE, SCRIPT), posixpath.join(REMOTE, SCRIPT))
sftp.close()

print('\n2) 점검 실행 (--dry-run: 쓰기 없음)')
if run(f'cd {REMOTE} && /usr/bin/node {SCRIPT} --dry-run 2>&1 | tail -15') != 0:
    print('   ❌ 점검 실패 — 이전 버전으로 되돌립니다')
    run(f'cd {REMOTE} && cp -f {SCRIPT}.bak {SCRIPT}')
    cli.close(); sys.exit(1)

print('\n3) 실제 1회 실행')
run(f'cd {REMOTE} && /usr/bin/node {SCRIPT} 2>&1 | tail -15', check=True)

print('\n4) 실행 주기 변경 → 평일 07~20시 10분마다')
run('crontab -l 2>/dev/null | grep -v "deploy-schedule-sync" > /tmp/ct.$$ ; '
    f'echo "{CRON}" >> /tmp/ct.$$ ; crontab /tmp/ct.$$ && rm -f /tmp/ct.$$ && echo "cron 변경 완료"', check=True)
run('crontab -l | grep deploy-schedule-sync')
cli.close()
print('\n완료. 로그: ' + REMOTE + '/sync.log')
