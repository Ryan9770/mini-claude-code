// 스킬 시스템: SKILL.md(마크다운 + 프론트매터) 묶음을 로드해 에이전트에 제공한다.
//
// Anthropic Skill 형식과 호환: 각 스킬은 하나의 디렉터리이고 그 안에 SKILL.md가 있다.
//   skills/<name>/SKILL.md   ← 프론트매터(name, description) + 지침 본문
//   skills/<name>/...        ← (선택) 번들 스크립트·자료
//
// 점진적 공개:
//   1) 시작 시 모든 스킬의 (name, description)만 시스템 프롬프트에 노출
//   2) 모델이 use_skill(name)을 호출하면 그때 전체 SKILL.md 본문을 컨텍스트에 로드
//
// 스킬 위치: 기본 <프로젝트루트>/skills (MCC_SKILLS_DIR로 변경 가능).
// 받은 스킬 폴더를 이 디렉터리에 넣으면 됩니다.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "./config.js";

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

let cache: Skill[] | null = null;

export function skillsDir(): string {
  // 기본: 프로젝트 안 skills/ (MCC_SKILLS_DIR로 덮어쓰기 가능)
  return process.env.MCC_SKILLS_DIR ?? join(config.projectRoot, "skills");
}

// 아주 단순한 YAML 프론트매터 파서 (name, description만 필요)
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

// 스킬 디렉터리를 스캔해 (name, description, dir) 목록을 반환 (캐시).
export function getSkills(): Skill[] {
  if (cache) return cache;
  const dir = skillsDir();
  const skills: Skill[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const fm = parseFrontmatter(readFileSync(skillMd, "utf-8"));
      skills.push({
        name: fm.name || entry.name,
        description: fm.description || "(설명 없음)",
        dir: join(dir, entry.name),
      });
    }
  }
  cache = skills;
  return skills;
}

// 번들 파일 목록(SKILL.md 제외, 최대 깊이 제한)
function listBundled(dir: string, base = dir, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listBundled(full, base, depth + 1));
    } else if (entry.name !== "SKILL.md") {
      out.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

// use_skill: 전체 SKILL.md 본문 + 번들 파일(절대경로) 안내를 반환.
export function getSkillBody(name: string): string | null {
  const skill = getSkills().find((s) => s.name === name);
  if (!skill) return null;
  let body = readFileSync(join(skill.dir, "SKILL.md"), "utf-8");
  const bundled = statSync(skill.dir).isDirectory() ? listBundled(skill.dir) : [];
  if (bundled.length) {
    body +=
      `\n\n[이 스킬의 번들 파일 — 필요하면 read_file로 읽거나 run_command로 실행하라]\n` +
      bundled.map((f) => `- ${join(skill.dir, f)}`).join("\n");
  }
  return body;
}
