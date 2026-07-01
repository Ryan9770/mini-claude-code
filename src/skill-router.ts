// 스킬 라우터: harness-100 같은 대규모 스킬 라이브러리를 '프롬프트 기반으로 동적 선택'한다.
//
// 왜 필요한가: 모든 스킬(수백 개)의 설명을 시스템 프롬프트에 주입하면 로컬 소형 모델이
// 과부하(도구/스킬 오버로드)로 반복 붕괴한다. 그래서 매 작업마다 프롬프트를 읽어
// 관련 스킬 상위 K개만 골라 노출한다(RAG over skills). v1은 인프라 없는 '어휘 검색'.
//
// 라이브러리 위치: 환경변수 MCC_SKILL_LIB. 미설정이면 프로젝트 안 harness-100/ko를
// 자동 감지하고, 그마저 없으면 라우터는 비활성(기존 동작 그대로 유지).
//
// 인덱스는 ~/.mcc/skills_index.json에 캐시하며, 라이브러리 경로가 바뀌면 재빌드한다.
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";

export interface LibSkill {
  name: string;
  description: string;
  dir: string;
}

const mccDir = process.env.MCC_HOME ?? join(homedir(), ".mcc");
const indexFile = join(mccDir, "skills_index.json");

// 라이브러리 디렉터리 결정. 기본: 프로젝트 안 harness-100/ko. 미설정+미존재면 undefined → 라우터 비활성.
export function skillLibDir(): string | undefined {
  if (process.env.MCC_SKILL_LIB) return process.env.MCC_SKILL_LIB;
  const inProject = join(config.projectRoot, "harness-100", "ko");
  return existsSync(inProject) ? inProject : undefined;
}

// SKILL.md와 동일한 최소 프론트매터 파서(name, description).
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = val;
  }
  return out;
}

// 재귀로 skill.md / SKILL.md 를 찾는다(대소문자 무관 — Linux는 case-sensitive이므로 필수).
function findSkillFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) findSkillFiles(full, depth + 1, out);
    else if (e.name.toLowerCase() === "skill.md") out.push(full);
  }
  return out;
}

let cache: LibSkill[] | null = null;

// 라이브러리 인덱스 빌드(캐시 우선). force=true면 강제 재스캔.
export function buildIndex(force = false): LibSkill[] {
  const lib = skillLibDir();
  if (!lib) return [];
  if (cache && !force) return cache;
  if (!force && existsSync(indexFile)) {
    try {
      const j = JSON.parse(readFileSync(indexFile, "utf-8"));
      if (j.lib === lib && Array.isArray(j.skills)) return (cache = j.skills);
    } catch {
      /* 손상된 캐시는 무시하고 재빌드 */
    }
  }
  const skills: LibSkill[] = [];
  const seen = new Set<string>();
  for (const file of findSkillFiles(lib)) {
    try {
      const fm = parseFrontmatter(readFileSync(file, "utf-8"));
      const dir = dirname(file);
      const name = fm.name || dir.split(/[\\/]/).pop() || "";
      if (!name || seen.has(name)) continue; // 이름 충돌은 첫 승자(v1 단순화)
      seen.add(name);
      skills.push({ name, description: fm.description || "", dir });
    } catch {
      /* 개별 파일 파싱 실패는 건너뜀 */
    }
  }
  cache = skills;
  try {
    mkdirSync(mccDir, { recursive: true });
    writeFileSync(indexFile, JSON.stringify({ lib, skills }), "utf-8");
  } catch {
    /* 캐시 저장 실패는 치명적이지 않음 */
  }
  return skills;
}

// 캐시 무효화(라이브러리 갱신 후 핫로드용).
export function invalidateIndex(): void {
  cache = null;
}

// 어휘 토큰화: 한국어+영어 혼용 대응.
//  - 영숫자 단어(2자 이상)
//  - 한글은 조사/어미 변화에 강하도록 2-gram 사용
function tokenize(s: string): string[] {
  const t = s.toLowerCase();
  const tokens: string[] = [];
  for (const m of t.matchAll(/[a-z0-9]+/g)) if (m[0].length >= 2) tokens.push(m[0]);
  for (const w of t.replace(/[^가-힣]/g, " ").split(/\s+/).filter(Boolean)) {
    if (w.length <= 2) tokens.push(w);
    else for (let i = 0; i + 2 <= w.length; i++) tokens.push(w.slice(i, i + 2));
  }
  return tokens;
}

export interface Scored extends LibSkill {
  score: number;
}

// 최소 점수 게이트: 이 미만이면 '관련 스킬 없음'으로 보고 아무것도 반환하지 않는다.
// (무관한 작업에 엉뚱한 스킬을 주입해 모델을 오도하는 것을 방지 — 예: 순수 파일처리 작업)
// 실측상 진짜 매칭은 18~32점, 잡음은 ≤7점이라 8을 경계로 둔다. MCC_SKILL_MIN_SCORE로 조정.
const MIN_SCORE = Number(process.env.MCC_SKILL_MIN_SCORE ?? 8);

// 프롬프트와 관련된 스킬 상위 K개를 어휘 점수로 선택.
// name 매치는 가중치 3, description 매치는 1(트리거 문구 빈도까지 반영).
export function selectSkills(prompt: string, k = 5, minScore = MIN_SCORE): Scored[] {
  const skills = buildIndex();
  if (!skills.length) return [];
  const q = new Set(tokenize(prompt));
  if (!q.size) return [];
  const scored: Scored[] = skills.map((s) => {
    let score = 0;
    const nameSet = new Set(tokenize(s.name));
    for (const tok of q) if (nameSet.has(tok)) score += 3;
    for (const tok of tokenize(s.description)) if (q.has(tok)) score += 1;
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score >= minScore).slice(0, k);
}

// 시스템/유저 턴에 주입할 '관련 스킬' 힌트 문자열. 선택 결과가 없으면 빈 문자열.
export function skillHint(prompt: string, k = 5): string {
  const picked = selectSkills(prompt, k);
  if (!picked.length) return "";
  return (
    `\n\n[이 작업에 관련될 수 있는 스킬 — 필요하면 use_skill("이름")으로 전체 지침을 불러와 따르라]\n` +
    picked.map((s) => `- ${s.name}: ${s.description.slice(0, 220)}`).join("\n")
  );
}

// use_skill 폴백: 라이브러리 스킬 본문 로드(skill.md / SKILL.md 둘 다 지원).
export function getLibrarySkillBody(name: string): string | null {
  const s = buildIndex().find((x) => x.name === name);
  if (!s) return null;
  for (const fn of ["skill.md", "SKILL.md"]) {
    const p = join(s.dir, fn);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return null;
}
