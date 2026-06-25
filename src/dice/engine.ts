// 이 파일은 렌더러 src/renderer/src/lib/dice/engine.ts 의 미러본입니다.
//    다이스 규칙 변경 시 양쪽을 함께 수정하세요.
//    순수 함수 + RNG 주입 구조라 서버 권위 굴림에 그대로 사용합니다.
import type { CheckResult, SanResult, SumResult, SuccessLevel, DiceResult, OpposedResult } from './types'
import { SUCCESS_LABEL } from './types'

/** [0,1) 난수 생성기 (테스트에서 주입 가능) */
export type RNG = () => number

const defaultRng: RNG = Math.random

/** 성공 단계 판정 (목표값=기능치, roll=1d100). BCDice CC 규칙 준수. */
export function successLevel(roll: number, target: number): SuccessLevel {
  if (roll === 1) return 'critical'
  const fumbleMin = target < 50 ? 96 : 100
  if (roll >= fumbleMin) return 'fumble'
  if (roll > target) return 'fail'
  if (roll <= Math.floor(target / 5)) return 'extreme'
  if (roll <= Math.floor(target / 2)) return 'hard'
  return 'regular'
}

function rollD100(rng: RNG): number {
  const v = Math.floor(rng() * 10) * 10 + Math.floor(rng() * 10)
  return v === 0 ? 100 : v
}

export interface CheckOpts {
  bonus?: number // 양수=보너스 다이스, 음수=페널티 다이스
  command?: string
  push?: boolean // 밀어붙이기 재시도 굴림
  rng?: RNG
}

/** 기능/능력 판정 (보너스/페널티 다이스 지원) */
export function rollCheck(target: number, opts: CheckOpts = {}): CheckResult {
  const rng = opts.rng ?? defaultRng
  const bonus = opts.bonus ?? 0
  const units = Math.floor(rng() * 10)
  const tensCount = 1 + Math.abs(bonus)
  const candidates: number[] = []
  for (let i = 0; i < tensCount; i++) {
    const v = Math.floor(rng() * 10) * 10 + units
    candidates.push(v === 0 ? 100 : v)
  }
  let roll: number
  if (bonus > 0) roll = Math.min(...candidates)
  else if (bonus < 0) roll = Math.max(...candidates)
  else roll = candidates[0]
  const level = successLevel(roll, target)
  return {
    kind: 'check',
    command: opts.command ?? `CC<=${target}`,
    roll,
    rolls: candidates.length > 1 ? candidates : undefined,
    target,
    level,
    label: SUCCESS_LABEL[level],
    bonus: bonus !== 0 ? bonus : undefined,
    push: opts.push || undefined
  }
}

/**
 * 주사위 식 굴림 — 재귀 하강 평가기. `+ - * /`(우선순위·괄호), `NdM`, 키프/드롭(kh/kl/dh/dl),
 * 단항 부호 지원. 예) "1d6", "2d6+1", "1d3+1d6", "2d6*2", "(1d6+1)*3", "4d6kh3", "4d6dl1", "1d100/2".
 * 반환 modifier: 순수 가산식(곱/나눗셈·키프드롭 없음)이면 합−주사위합(=상수항), 아니면 0.
 * 흔한 주사위 표기를 폭넓게 수용하되 결과 모델(rolls/modifier/total)은 유지한다.
 */
export function rollExpr(expr: string, rng: RNG = defaultRng): { rolls: number[]; modifier: number; total: number } {
  const s = expr.replace(/\s+/g, '')
  const rolls: number[] = []
  let pos = 0
  let nonAdditive = false // 곱/나눗셈·키프드롭이 쓰였는지(쓰였으면 modifier 표시 생략)

  const peek = (): string => s[pos] ?? ''
  function readInt(): number | null {
    const start = pos
    while (pos < s.length && s[pos] >= '0' && s[pos] <= '9') pos++
    return pos === start ? null : parseInt(s.slice(start, pos), 10)
  }
  function rollDice(count: number, sides: number, mode: string | null, keep: number): number {
    const n = Math.max(0, Math.min(1000, count)) // 폭주 방지(최대 1000개)
    const sd = sides < 1 ? 1 : sides
    const results: number[] = []
    for (let i = 0; i < n; i++) results.push(1 + Math.floor(rng() * sd))
    let kept = results
    if (mode) {
      nonAdditive = true
      const sorted = [...results].sort((a, b) => a - b) // 오름차순
      const k = Math.max(0, Math.min(n, keep))
      if (mode === 'kh') kept = sorted.slice(n - k) // 높은 k개 유지
      else if (mode === 'kl') kept = sorted.slice(0, k) // 낮은 k개 유지
      else if (mode === 'dh') kept = sorted.slice(0, n - k) // 높은 k개 버림
      else if (mode === 'dl') kept = sorted.slice(k) // 낮은 k개 버림
    }
    for (const r of kept) rolls.push(r)
    return kept.reduce((a, b) => a + b, 0)
  }
  function parseFactor(): number {
    const ch = peek()
    if (ch === '+') { pos++; return parseFactor() }
    if (ch === '-') { pos++; return -parseFactor() }
    if (ch === '(') {
      pos++
      const v = parseExpr()
      if (peek() === ')') pos++
      return v
    }
    const n = readInt() // 주사위 개수(없으면 1) 또는 상수
    if (peek() === 'd' || peek() === 'D') {
      pos++
      const sides = readInt() ?? 0
      let mode: string | null = null
      let keep = 0
      const two = s.slice(pos, pos + 2).toLowerCase()
      if (two === 'kh' || two === 'kl' || two === 'dh' || two === 'dl') {
        pos += 2
        mode = two
        keep = readInt() ?? 1 // 개수 생략 시 1(예: 2d20kh = 유리한 1개)
      }
      return rollDice(n ?? 1, sides, mode, keep)
    }
    return n ?? 0
  }
  function parseTerm(): number {
    let v = parseFactor()
    for (;;) {
      const op = peek()
      if (op !== '*' && op !== '/') break
      pos++
      nonAdditive = true
      const r = parseFactor()
      v = op === '*' ? v * r : r === 0 ? 0 : v / r // 0 으로 나누기 = 0(식 오류 방어)
    }
    return v
  }
  function parseExpr(): number {
    let v = parseTerm()
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') break
      pos++
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  let total = parseExpr()
  total = Math.round(total * 1e6) / 1e6 // 나눗셈 부동소수 오차 정리
  const sumRolls = rolls.reduce((a, b) => a + b, 0)
  const modifier = nonAdditive ? 0 : total - sumRolls
  return { rolls, modifier, total }
}

export interface SumOpts {
  rng?: RNG
  command?: string
}

/** 단순 합산 굴림 (피해/혼합 등) */
export function rollSum(expr: string, opts: SumOpts = {}): SumResult {
  const { rolls, modifier, total } = rollExpr(expr, opts.rng ?? defaultRng)
  return { kind: 'sum', command: opts.command ?? expr, rolls, modifier, total }
}

/**
 * 인라인 굴림 [[식]] → 결과 숫자로 치환. 식이 주사위(NdM[+K])면 굴려서
 * [roll=합계|툴팁] 마크업으로 바꾼다(클라가 hover 로 상세 렌더). 주사위 식이 아니면 원문 그대로.
 * 반드시 송신 시 1회만 해석(멀티=서버 권위)해야 모든 화면에 같은 숫자가 고정된다. 채팅·스크립트 공통.
 */
export function resolveInlineRolls(text: string, rng: RNG = defaultRng): string {
  if (!text.includes('[[')) return text
  return text.replace(/\[\[([^[\]]{1,60})\]\]/g, (full, raw: string) => {
    const expr = raw.trim()
    if (!/^[\d\s+\-*/dDkKhHlL()]+$/.test(expr) || !/\d*d[1-9]\d*/i.test(expr)) return full // 주사위 식(안전 문자·1면 이상)만 치환
    const { rolls, modifier, total } = rollExpr(expr, rng)
    if (!rolls.length) return full
    // 순수 가산식이면 주사위 분해(4+1+1=6) 표시, 곱/나눗셈 등이면 합 분해 생략(식 → 결과).
    const sumRolls = rolls.reduce((a, b) => a + b, 0)
    const useBreakdown = sumRolls + modifier === total && (rolls.length > 1 || modifier !== 0)
    const detail = rolls.join('+') + (modifier ? (modifier > 0 ? '+' : '') + modifier : '')
    const tip = (useBreakdown ? `${expr} → ${detail} = ${total}` : `${expr} → ${total}`).replace(/[\]|]/g, '')
    return `[roll=${total}|${tip}]`
  })
}

export interface SanOpts {
  rng?: RNG
  command?: string
}

/** 이성(SAN) 판정. lossExpr = "성공측/실패측" (예: "1/1d6") */
export function rollSan(target: number, lossExpr: string, opts: SanOpts = {}): SanResult {
  const rng = opts.rng ?? defaultRng
  const roll = rollD100(rng)
  const level = successLevel(roll, target)
  const success = roll <= target || roll === 1
  const [sExpr, fExpr] = lossExpr.split('/')
  const expr = success ? sExpr : (fExpr ?? sExpr)
  const loss = rollExpr(expr, rng).total
  return {
    kind: 'san',
    command: opts.command ?? `SC ${lossExpr}<=${target}`,
    roll,
    target,
    level,
    success,
    loss,
    lossExpr
  }
}

/** 성공 단계 우열(클수록 우세) — 대결 승부 판정용. */
const LEVEL_RANK: Record<SuccessLevel, number> = {
  critical: 5,
  extreme: 4,
  hard: 3,
  regular: 2,
  fail: 1,
  fumble: 0
}
function isSuccessLevel(l: SuccessLevel): boolean {
  return l !== 'fail' && l !== 'fumble'
}

export interface OpposedOpts {
  rng?: RNG
  command?: string
}

/**
 * 대결 판정 — 양측이 각자 목표값에 1d100. 성공이 실패를 이기고, 둘 다 성공이면
 * 성공 단계가 높은 쪽, 동급이면 목표값(기능치)이 높은 쪽이 승리. 둘 다 실패·완전 동률은 무승부.
 */
export function rollOpposed(targetA: number, targetB: number, opts: OpposedOpts = {}): OpposedResult {
  const rng = opts.rng ?? defaultRng
  const rollA = rollD100(rng)
  const rollB = rollD100(rng)
  const a = { roll: rollA, target: targetA, level: successLevel(rollA, targetA) }
  const b = { roll: rollB, target: targetB, level: successLevel(rollB, targetB) }
  const sa = isSuccessLevel(a.level)
  const sb = isSuccessLevel(b.level)
  let winner: 'a' | 'b' | 'draw'
  if (sa && !sb) winner = 'a'
  else if (sb && !sa) winner = 'b'
  else if (!sa && !sb) winner = 'draw'
  else if (LEVEL_RANK[a.level] !== LEVEL_RANK[b.level]) winner = LEVEL_RANK[a.level] > LEVEL_RANK[b.level] ? 'a' : 'b'
  else if (targetA !== targetB) winner = targetA > targetB ? 'a' : 'b'
  else winner = 'draw'
  return { kind: 'opposed', command: opts.command ?? `CBR(${targetA},${targetB})`, a, b, winner }
}

/**
 * 채팅 입력을 파싱해 판정 실행. 인식 못하면 null(=평문).
 * 지원: CC[+/-n]<=N, 1d100<=N, SC/SAN s/f<=N, 대결 CBR(a,b)·대결 a vs b, 밀어붙이기 push CC<=N, NdM(+K) 식
 */
export function parseCommand(input: string, rng: RNG = defaultRng): DiceResult | null {
  const s = input.trim()
  let m = s.match(/^(?:SC|SAN)\s+([0-9d+\-/]+)\s*<=\s*(\d+)$/i)
  if (m) return rollSan(parseInt(m[2], 10), m[1], { rng, command: s })
  // 대결: CBR(a,b) / 대결(a,b) / 대결 a vs b
  m = s.match(/^(?:CBR|대결)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i)
  if (m) return rollOpposed(parseInt(m[1], 10), parseInt(m[2], 10), { rng, command: s })
  m = s.match(/^대결\s+(\d+)\s+vs\s+(\d+)$/i)
  if (m) return rollOpposed(parseInt(m[1], 10), parseInt(m[2], 10), { rng, command: s })
  // 밀어붙이기: "밀어붙이기 CC<=N" / "push CC<=N"
  m = s.match(/^(?:밀어붙이기|push)\s+(?:CC|1d100)\s*([+-]\d+)?\s*<=\s*(\d+)$/i)
  if (m) return rollCheck(parseInt(m[2], 10), { bonus: m[1] ? parseInt(m[1], 10) : 0, push: true, rng, command: s })
  m = s.match(/^(?:CC|1d100)\s*([+-]\d+)?\s*<=\s*(\d+)$/i)
  if (m) return rollCheck(parseInt(m[2], 10), { bonus: m[1] ? parseInt(m[1], 10) : 0, rng, command: s })
  // 합산 굴림 식: 안전 문자(숫자·d·키프드롭 kh/kl/dh/dl·+ - * / 괄호)로만 이뤄지고 주사위(NdM)를 포함.
  if (/d[1-9]/i.test(s) && /^[0-9dkhl+\-*/() ]+$/i.test(s)) return rollSum(s, { rng })
  return null
}
