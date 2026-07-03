// 다국어 오염 스캐너: 한국어+ASCII+기본기호 텍스트에 끼면 안 되는 외국문자를 센다.
// (Q4 blur가 뽑는 키릴/아랍/데바나가리/텔루구/가나/한자). eval/.runs의 big_knows.txt들을 훑는다.
// 사용: node eval/scan-corruption.cjs [디렉터리(기본 eval/.runs)]
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const FOREIGN = /[Ѐ-ӿ؀-ۿऀ-ॿఀ-౿぀-ヿ一-鿿]/g;
const root = process.argv[2] || join(__dirname, ".runs");

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^(big_knows|pip_knows)\.txt$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(root).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
if (!files.length) { console.log("스캔할 산출물 없음"); process.exit(0); }

console.log(`오염 스캔 — ${files.length}개 파일 (오래된→최신)\n`);
for (const f of files) {
  const txt = readFileSync(f, "utf-8");
  const lines = txt.split("\n").filter(Boolean);
  const hits = txt.match(FOREIGN) || [];
  const badLines = lines.filter((l) => FOREIGN.test(l)).length;
  const uniq = [...new Set(hits)].slice(0, 12).join(" ");
  const short = f.replace(root, "").replace(/[\\/]/g, "/").replace(/^\//, "");
  const tag = hits.length === 0 ? "✅ 청정" : `⚠️ 오염`;
  console.log(`${tag}  줄 ${String(lines.length).padStart(3)} | 외국문자 ${String(hits.length).padStart(3)}자·${badLines}줄 ${uniq ? "["+uniq+"]" : ""}`);
  console.log(`        ${short}`);
}
