// 바이너리 자산 저장소 — 이미지·음원을 base64 data URL 로 방 상태에 박아 넣는 대신, 콘텐츠 해시로 한 번만 저장하고
// 'asset:<sha256>' 짧은 참조만 상태·스냅샷·방송에 싣는다. 디스크 기반 + 스트리밍 서빙이라 호스트 메모리도 크게 준다.
// (예전: 방 상태가 120MB data URL 들을 메모리에 들고, 재접속마다 통째로 재직렬화·재전송 → PL 튕김의 핵심 원인.)
//
// 접근 제어: 해시 자체가 추측 불가한 '캐퍼빌리티'라 별도 인증 없이 GET 으로 제공(기존 data URL 도 수신자 한정 외엔 비통제였음).
// 콘텐츠 주소(불변)라 GET 응답에 영구 캐시 헤더를 붙여 클라가 한 번만 받아 캐시한다.
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 자산 바이너리 단일 최대 크기(바이트). 120MB data URL(base64)의 원본 바이트(~90MB)에 여유. */
export const MAX_ASSET_BYTES = 130 * 1024 * 1024
/** sha256 16진수 해시 형식(경로 탈출·잘못된 키 차단). */
const HASH_RE = /^[a-f0-9]{64}$/
/** 상태·스냅샷에 박히는 'asset:<sha256>' 참조 추출용(자산 GC 라이브 집합 수집). */
const ASSET_REF_RE = /asset:([a-f0-9]{64})/g
/** 미참조 자산 청소 시, 막 업로드돼 아직 어디에도 박히지 않은 자산을 지우지 않기 위한 유예(기본 1시간). */
const DEFAULT_SWEEP_GRACE_MS = 60 * 60 * 1000

/** 임의 직렬화 문자열에서 'asset:<해시>' 참조를 모두 뽑아 into 에 추가(GC 라이브 집합 수집 — 방·캐릭터·계정 공용). */
export function collectAssetRefs(text: string, into: Set<string>): void {
  if (!text) return
  for (const m of text.matchAll(ASSET_REF_RE)) into.add(m[1])
}

export interface AssetStore {
  /** 바이트 저장(콘텐츠 해시·중복 제거) → 해시 반환. 디스크 쓰기는 비동기(이벤트 루프 비블로킹). */
  put(bytes: Buffer, mime: string): Promise<string>
  /** 서빙용 — 영속이면 {mime, path}(스트림), 인메모리면 {mime, bytes}. 없으면 null. */
  resolve(hash: string): { mime: string; path?: string; bytes?: Buffer } | null
  /** 테스트/검증용 — 바이트 직접 반환(영속이면 동기 읽기). 없으면 null. */
  read(hash: string): { bytes: Buffer; mime: string } | null
  /** 해시가 유효 형식인지(라우팅 방어). */
  isHash(hash: string): boolean
  /** 단일 자산 삭제(파일 + 색인). 삭제됐으면 true. */
  remove(hash: string): boolean
  /**
   * 미참조 자산 일괄 청소(mark-and-sweep). live=지금 어디서든 참조 중인 해시 집합(상위가 전 방·캐릭터·계정에서 수집).
   * 콘텐츠 주소라 자산은 방·캐릭터 간 공유되므로 '한 곳에서 지웠다'고 바로 지우면 안 됨 — 전역 라이브 집합에 없을 때만 회수.
   * graceMs 이내 생성(파일 mtime)된 자산은 '업로드 직후 아직 미참조' 가능성으로 보존(레이스 방지).
   * 반환: 삭제 개수·확보 바이트.
   */
  sweep(live: Set<string>, opts?: { graceMs?: number; now?: number }): { removed: number; freed: number }
  /** 현재 보관 중인 전체 자산 해시(진단/테스트). */
  hashes(): string[]
  maxBytes: number
}

/** persist:false 면 인메모리(테스트). dataDir 기본 = <cwd>/data. mime 은 index.json 에 별도 기록. */
export function createAssetStore(opts?: { dataDir?: string; persist?: boolean }): AssetStore {
  const persist = opts?.persist !== false
  const dir = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'assets')
  const indexPath = join(dir, 'index.json')
  // 해시 → mime. 영속 모드에서도 메모리에 들고(서빙 시 빠른 조회), index.json 으로 영속.
  const mimes = new Map<string, string>()
  // 인메모리 모드 전용 바이트 보관.
  const memBytes = new Map<string, Buffer>()

  if (persist) {
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(indexPath)) {
        const obj = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
        for (const [h, m] of Object.entries(obj)) if (HASH_RE.test(h) && typeof m === 'string') mimes.set(h, m)
      }
    } catch (e) {
      console.error('[assets] index.json 로드 실패 — 빈 색인으로 시작:', e)
    }
  }

  /** mime 색인 영속(원자적). 자산 추가는 드물어 전체 재기록 허용. */
  function saveIndex(): void {
    if (!persist) return
    try {
      const tmp = indexPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(mimes)), 'utf8')
      renameSync(tmp, indexPath)
    } catch (e) {
      console.error('[assets] index.json 저장 실패:', e)
    }
  }

  return {
    maxBytes: MAX_ASSET_BYTES,
    isHash: (h) => typeof h === 'string' && HASH_RE.test(h),

    async put(bytes, mime) {
      const hash = createHash('sha256').update(bytes).digest('hex')
      const safeMime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream'
      if (mimes.has(hash)) {
        // 디스크 폴백으로 octet-stream 으로 잡혀 있던 항목을, 더 구체적인 MIME 으로 재업로드하면 승격(색인 보강).
        if (mimes.get(hash) === 'application/octet-stream' && safeMime !== 'application/octet-stream') {
          mimes.set(hash, safeMime)
          saveIndex()
        }
        return hash // 이미 있음(콘텐츠 동일) — 바이트 재기록 생략
      }
      if (persist) {
        const f = join(dir, hash)
        try {
          await mkdir(dir, { recursive: true })
          if (!existsSync(f)) {
            const tmp = `${f}.tmp`
            await writeFile(tmp, bytes)
            await rename(tmp, f)
          }
        } catch (e) {
          console.error(`[assets] ${hash.slice(0, 8)} 저장 실패:`, e)
          throw e
        }
      } else {
        memBytes.set(hash, bytes)
      }
      mimes.set(hash, safeMime)
      saveIndex()
      return hash
    },

    resolve(hash) {
      if (!HASH_RE.test(hash)) return null
      const mime = mimes.get(hash)
      if (persist) {
        const path = join(dir, hash)
        if (!existsSync(path)) return null
        // mime 색인이 (재시작·index.json 쓰기 실패로) 비어도 파일이 있으면 404 대신 서빙 — 색인도 보강한다.
        // (octet-stream 으로 내려가도 브라우저/Electron 의 콘텐츠 스니핑으로 대개 재생·표시되며, 404 무음보다 낫다.)
        if (!mime) {
          mimes.set(hash, 'application/octet-stream')
          return { mime: 'application/octet-stream', path }
        }
        return { mime, path }
      }
      if (!mime) return null
      const bytes = memBytes.get(hash)
      return bytes ? { mime, bytes } : null
    },

    read(hash) {
      if (!HASH_RE.test(hash)) return null
      const mime = mimes.get(hash)
      if (!mime) return null
      if (persist) {
        const path = join(dir, hash)
        try {
          if (!existsSync(path) || !statSync(path).isFile()) return null
          return { bytes: readFileSync(path), mime }
        } catch {
          return null
        }
      }
      const bytes = memBytes.get(hash)
      return bytes ? { bytes, mime } : null
    },

    remove(hash) {
      if (!HASH_RE.test(hash)) return false
      let existed = mimes.delete(hash)
      if (memBytes.delete(hash)) existed = true
      if (persist) {
        const f = join(dir, hash)
        try {
          if (existsSync(f)) {
            unlinkSync(f)
            existed = true
          }
        } catch (e) {
          console.error(`[assets] ${hash.slice(0, 8)} 삭제 실패:`, e)
        }
      }
      if (existed) saveIndex()
      return existed
    },

    sweep(live, opts) {
      const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS
      const cutoff = (opts?.now ?? Date.now()) - graceMs
      // 디스크의 모든 자산 파일을 진실원본으로 — 색인에 없어도(쓰기 실패 등) 회수 대상에 포함.
      const all = new Set<string>(mimes.keys())
      for (const h of memBytes.keys()) all.add(h)
      if (persist) {
        try {
          for (const f of readdirSync(dir)) if (HASH_RE.test(f)) all.add(f)
        } catch {
          /* 디렉터리 없음 — 회수할 것 없음 */
        }
      }
      let removed = 0
      let freed = 0
      let indexDirty = false
      for (const hash of all) {
        if (live.has(hash)) continue
        if (persist) {
          const f = join(dir, hash)
          try {
            const st = statSync(f)
            if (st.mtimeMs > cutoff) continue // 유예 — 막 올라온 자산은 보존(아직 참조에 박히기 전)
            unlinkSync(f)
            freed += st.size
          } catch {
            /* 이미 없음 — 색인만 정리 */
          }
        }
        if (mimes.delete(hash)) indexDirty = true
        memBytes.delete(hash)
        removed++
      }
      if (indexDirty) saveIndex()
      return { removed, freed }
    },

    hashes() {
      return [...mimes.keys()]
    }
  }
}
