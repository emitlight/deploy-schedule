// 서버(cloudflare-worker.js)의 '판정용' 키워드 목록과 화면(index.html) 폴백 목록이 같은지 검사한다.
// 과거 두 파일의 목록이 서로 달라져 PC마다 판정이 갈린 적이 있다.
// (서버의 OUT_KEYWORDS 는 색상 분류용이라 판정과 무관 — 판정용은 AVAIL_OUT_KEYWORDS)
const fs = require('fs');

const w = fs.readFileSync('cloudflare-worker.js', 'utf8');
const h = fs.readFileSync('index.html', 'utf8');

const get = (src, name) => {
  const m = src.match(new RegExp(String.raw`const ${name}\s*=\s*(\[[^\]]*\])`));
  return m ? m[1].replace(/\s/g, '') : null;
};

const pairs = [
  ['AVAIL_OUT_KEYWORDS', 'OUT_KEYWORDS'],         // 부재 키워드
  ['AVAILABLE_KEYWORDS', 'AVAILABLE_KEYWORDS'],   // 가능 키워드
];

let bad = false;
for (const [wn, hn] of pairs) {
  const a = get(w, wn), b = get(h, hn);
  if (!a || !b) {
    console.error('❌ 상수를 찾지 못함:', !a ? `worker ${wn}` : `index ${hn}`);
    bad = true;
    continue;
  }
  if (a !== b) {
    console.error(`❌ 서버 ${wn} 와 화면 ${hn} 가 다릅니다. 두 곳을 맞추세요.`);
    console.error('   worker:', a);
    console.error('   index :', b);
    bad = true;
  }
}
if (bad) process.exit(1);
console.log('✅ 판정 상수 일치 (부재·가능 키워드)');
