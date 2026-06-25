// 유저 간 DM(다이렉트 메시지) 저장소 — 대화는 두 userId 정렬쌍 키 파일에 영속(<dataDir>/dm/<a__b>.json).
// 계정·캐릭터 저장소와 동일 패턴(원자적 tmp→rename, 지연 로드). 실시간 전달은 relay.ts(소켓 개인룸)에서.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DmMessage } from './protocol'

export interface DmConversationSummary {
  peerId: string
  last: string
  lastFrom: string
  updatedAt: number
}

export interface DmStore {
  /** from→to 메시지 추가. 같은 사람/빈 텍스트면 null. */
  append(from: string, to: string, text: string): DmMessage | null
  /** 두 사람의 전체 대화(시간순). */
  thread(a: string, b: string): DmMessage[]
  /** userId 가 참여한 대화별 요약(상대·마지막 메시지·시각, 최신순). */
  list(userId: string): DmConversationSummary[]
  /** from 의 메시지(msgId) 본문 수정 — 본인 메시지만. 성공 시 갱신된 메시지, 아니면 null. */
  edit(from: string, peer: string, msgId: string, text: string): DmMessage | null
  /** from 의 메시지(msgId) 삭제 — 본인 메시지만. 성공 시 true. */
  remove(from: string, peer: string, msgId: string): boolean
  /**
   * userId 가 자신의 목록에서 peer 와의 대화를 지움(개인 단위 · 현재까지를 가림).
   * 상대 시점은 유지되고 새 메시지는 다시 보인다. 양쪽 모두 지우면 파일을 삭제해 용량을 회수. 처리했으면 true.
   */
  clearFor(userId: string, peer: string): boolean
  /** 한 사용자의 모든 대화 삭제(계정 탈퇴 연쇄) — 상대 쪽 파일에서도 제거. 삭제된 대화 수 반환. */
  removeForUser(userId: string): number
}

const MAX_TEXT = 2000 // 메시지 1건 길이 상한
const MAX_MESSAGES = 1000 // 대화당 보관 메시지 상한(초과 시 오래된 것부터 버림)

/** 두 userId → 파일 키(정렬쌍, 충돌 회피용 구분자 '__'). */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('__')
}

export function createDmStore(opts?: { dataDir?: string; persist?: boolean }): DmStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data', 'dm')
  const cache = new Map<string, DmMessage[]>() // pairKey → messages
  // pairKey → { userId: 가린 기준시각 }. 이 값보다 createdAt 이 작거나 같은 메시지는 그 사용자에게 보이지 않는다(개인 대화 삭제).
  const clearedCache = new Map<string, Record<string, number>>()
  const byUser = new Map<string, Set<string>>() // userId → pairKey 집합(list 색인)
  const flushing = new Map<string, Promise<void>>() // pairKey → 진행 중 플러시(직렬화)
  let indexed = false

  function fileFor(key: string): string {
    return join(dataDir, key + '.json')
  }
  function indexPair(key: string): void {
    const i = key.indexOf('__')
    if (i < 0) return
    const a = key.slice(0, i)
    const b = key.slice(i + 2)
    if (!byUser.has(a)) byUser.set(a, new Set())
    if (!byUser.has(b)) byUser.set(b, new Set())
    byUser.get(a)!.add(key)
    byUser.get(b)!.add(key)
  }
  // 시작 시 파일명만 훑어 색인(본문은 필요할 때 지연 로드).
  function ensureIndex(): void {
    if (indexed) return
    indexed = true
    if (!persist) return
    try {
      if (!existsSync(dataDir)) return
      for (const f of readdirSync(dataDir)) {
        if (f.endsWith('.json') && !f.endsWith('.tmp')) indexPair(f.slice(0, -5))
      }
    } catch {
      /* 무시 */
    }
  }
  function read(key: string): DmMessage[] {
    const hit = cache.get(key)
    if (hit) return hit
    let msgs: DmMessage[] = []
    let cleared: Record<string, number> = {}
    if (persist) {
      try {
        const parsed = JSON.parse(readFileSync(fileFor(key), 'utf8'))
        if (parsed && Array.isArray(parsed.messages)) msgs = parsed.messages as DmMessage[]
        if (parsed && parsed.cleared && typeof parsed.cleared === 'object') {
          cleared = parsed.cleared as Record<string, number>
        }
      } catch {
        /* 없음/손상 → 빈 대화 */
      }
    }
    cache.set(key, msgs)
    if (!clearedCache.has(key)) clearedCache.set(key, cleared)
    return msgs
  }
  /** userId 의 가린 기준시각(없으면 0). read 로 로드 보장 후 조회. */
  function clearedAt(key: string, userId: string): number {
    read(key)
    return clearedCache.get(key)?.[userId] ?? 0
  }
  // 비동기 플러시(이벤트 루프 블로킹 방지) — 같은 대화는 직렬화하고, 쓰기 시점의 cache 전체를 기록(누락 방지).
  function flush(key: string): void {
    if (!persist) return
    const prev = flushing.get(key) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          const tmp = fileFor(key) + '.tmp'
          await writeFile(
            tmp,
            JSON.stringify({ messages: cache.get(key) ?? [], cleared: clearedCache.get(key) ?? {} }),
            'utf8'
          )
          await rename(tmp, fileFor(key))
        } catch (e) {
          console.error('[dm] 저장 실패:', e)
        }
      })
      .finally(() => {
        if (flushing.get(key) === next) flushing.delete(key)
      })
    flushing.set(key, next)
  }
  /** 대화 파일·캐시·색인 통째로 제거(양쪽 모두 삭제했거나 계정 탈퇴 시 — 용량 회수). 삭제는 진행 중 플러시 뒤에 직렬화. */
  function dropThread(key: string): void {
    cache.delete(key)
    clearedCache.delete(key)
    const i = key.indexOf('__')
    if (i >= 0) {
      byUser.get(key.slice(0, i))?.delete(key)
      byUser.get(key.slice(i + 2))?.delete(key)
    }
    if (!persist) return
    const prev = flushing.get(key) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        try {
          await unlink(fileFor(key))
        } catch {
          /* 이미 없음 — 무시 */
        }
      })
      .finally(() => {
        if (flushing.get(key) === next) flushing.delete(key)
      })
    flushing.set(key, next)
  }

  return {
    append(from, to, text) {
      ensureIndex()
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t || !from || !to || from === to) return null
      const key = pairKey(from, to)
      const msgs = read(key)
      const msg: DmMessage = { id: randomUUID(), from, to, text: t, createdAt: Date.now() }
      msgs.push(msg)
      if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES)
      cache.set(key, msgs)
      indexPair(key)
      flush(key)
      return msg
    },
    thread(a, b) {
      ensureIndex()
      const key = pairKey(a, b)
      const msgs = read(key)
      const cut = clearedAt(key, a)
      return cut ? msgs.filter((m) => m.createdAt > cut) : msgs.slice()
    },
    list(userId) {
      ensureIndex()
      const keys = byUser.get(userId)
      if (!keys) return []
      const out: DmConversationSummary[] = []
      for (const key of keys) {
        const msgs = read(key)
        if (!msgs.length) continue
        const cut = clearedCache.get(key)?.[userId] ?? 0
        const visible = cut ? msgs.filter((m) => m.createdAt > cut) : msgs
        if (!visible.length) continue // 이 사용자가 지운 대화(상대가 새 메시지를 보내기 전까지 숨김)
        const i = key.indexOf('__')
        const a = key.slice(0, i)
        const b = key.slice(i + 2)
        const peerId = a === userId ? b : a
        const last = visible[visible.length - 1]
        out.push({ peerId, last: last.text, lastFrom: last.from, updatedAt: last.createdAt })
      }
      out.sort((x, y) => y.updatedAt - x.updatedAt)
      return out
    },
    edit(from, peer, msgId, text) {
      ensureIndex()
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t || !from || !peer || from === peer) return null
      const key = pairKey(from, peer)
      const msgs = read(key)
      const m = msgs.find((x) => x.id === msgId)
      if (!m || m.from !== from) return null // 본인 메시지만
      m.text = t
      cache.set(key, msgs)
      flush(key)
      return m
    },
    remove(from, peer, msgId) {
      ensureIndex()
      if (!from || !peer || from === peer) return false
      const key = pairKey(from, peer)
      const msgs = read(key)
      const i = msgs.findIndex((x) => x.id === msgId)
      if (i < 0 || msgs[i].from !== from) return false // 본인 메시지만
      msgs.splice(i, 1)
      cache.set(key, msgs)
      flush(key)
      return true
    },
    clearFor(userId, peer) {
      ensureIndex()
      if (!userId || !peer || userId === peer) return false
      const key = pairKey(userId, peer)
      const msgs = read(key)
      if (!msgs.length) return false // 대화 없음 — 지울 것 없음
      const last = msgs[msgs.length - 1].createdAt
      const cleared = clearedCache.get(key) ?? {}
      cleared[userId] = Math.max(cleared[userId] ?? 0, last) // 현재까지 가림(이후 새 메시지는 다시 보임)
      clearedCache.set(key, cleared)
      const i = key.indexOf('__')
      const a = key.slice(0, i)
      const b = key.slice(i + 2)
      // 양쪽 모두 마지막 메시지까지 가렸으면 누구에게도 안 보임 → 파일 삭제(용량 회수).
      if ((cleared[a] ?? 0) >= last && (cleared[b] ?? 0) >= last) dropThread(key)
      else flush(key)
      return true
    },
    removeForUser(userId) {
      ensureIndex()
      const keys = byUser.get(userId)
      if (!keys) return 0
      let n = 0
      for (const key of [...keys]) {
        dropThread(key) // 양쪽 색인에서 제거 + 파일 삭제
        n++
      }
      byUser.delete(userId)
      return n
    }
  }
}
