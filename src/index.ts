// 타코야키 박스 멀티플레이 릴레이 서버 진입점.
// 개발: npm run dev (tsx watch). 기본 포트 8787 (PORT 환경변수로 변경).
// 공개 배포(하이브리드 클라우드)용 환경변수:
//   CORS_ORIGINS 허용 origin 쉼표목록(예: https://app.example.com). 미설정 = 전체(*) — 로컬/개발용.
//   TLS_KEY/TLS_CERT PEM 키·인증서 파일 경로. 둘 다 있으면 wss(https)로 기동. (리버스 프록시 종단이면 불필요)
//   SESSION_TTL_DAYS 세션 토큰 유휴 만료일(기본 30). 활성 사용 시 슬라이딩 연장.
import { readFileSync } from 'node:fs'
import { createRelay } from './relay'
import { createAuthStore } from './auth'
import { createCharacterStore } from './characters'
import { createAssetStore } from './assets'
import { createDmStore } from './dm'
import { createPostStore } from './posts'
import { createSessionLogStore } from './sessionlogs'
import { RoomStore } from './rooms'

const PORT = Number(process.env.PORT ?? 8787)
const SAVE_INTERVAL_MS = 8_000 // 8초마다 변경된 세션 자동저장

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null

// TLS: 키·인증서 둘 다 지정되면 직접 wss 종단. 로드 실패 시 평문으로 떨어지지 않고 종료한다.
let tls: { key: string; cert: string } | undefined
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  try {
    tls = { key: readFileSync(process.env.TLS_KEY, 'utf8'), cert: readFileSync(process.env.TLS_CERT, 'utf8') }
  } catch (e) {
    console.error('[tls] 인증서/키 로드 실패 — 평문으로 시작하지 않고 종료합니다:', e)
    process.exit(1)
  }
}

const sessionTtlMs = process.env.SESSION_TTL_DAYS
  ? Number(process.env.SESSION_TTL_DAYS) * 24 * 60 * 60 * 1000
  : undefined

// 운영: 계정·캐릭터·세션방 영속(<cwd>/data) + 로그인 필수. 누구나 방을 만들 수 있고 생성자가 그 방의 GM(소유자)이 된다.
//   (자가호스팅 배포라 중앙 관리자가 없으므로 전역 admin 역할은 권한에 쓰지 않는다. role 필드는 호환용으로만 둔다.)
// 세션방은 영속(소유자 삭제 전까지 유지) — 유휴 정리(sweep) 없음.
const authStore = createAuthStore({ sessionTtlMs })
const charStore = createCharacterStore()
const roomStore = new RoomStore({ persist: true })
const assetStore = createAssetStore()
const dmStore = createDmStore()
const postStore = createPostStore()
const sessionLogStore = createSessionLogStore()

const { httpServer } = createRelay({
  requireAuth: true,
  auth: authStore,
  characters: charStore,
  rooms: roomStore,
  assets: assetStore,
  dm: dmStore,
  posts: postStore,
  sessionlogs: sessionLogStore,
  corsOrigins,
  tls,
  // 연결 진단: 접속/해제(+사유)·재접속 복구·주기 메모리·소켓 수를 호스트 로그로 남긴다.
  log: (...args) => console.log('[net]', ...args)
})

const save = setInterval(() => {
  void roomStore.flushDirty().then((n) => {
    if (n) console.log(`[rooms] 자동저장 ${n}개 (총 ${roomStore.roomCount})`)
  })
}, SAVE_INTERVAL_MS)
save.unref() // 서버 종료를 막지 않도록

// 미참조(고아) 자산 정리 — 방·이미지·캐릭터·계정이 삭제돼 더 이상 어디서도 참조되지 않는 자산 파일을 회수(디스크 용량 관리).
// 콘텐츠 주소라 자산은 방·캐릭터 간 공유되므로, 전 방·캐릭터·계정에서 라이브 참조를 모은 뒤(mark) 그 집합에 없는 것만 지운다(sweep).
// 막 업로드돼 아직 참조에 박히기 전인 자산은 sweep 내부 유예(파일 mtime 기준)로 보존한다.
const ASSET_GC_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6시간마다
const ASSET_GC_BOOT_DELAY_MS = 5 * 60 * 1000 // 부팅 5분 후 1차(초기 재접속·로드 안정화 대기)

function runAssetGc(): void {
  try {
    const live = new Set<string>()
    roomStore.collectAssetRefs(live)
    charStore.collectAssetRefs(live)
    authStore.collectAssetRefs(live)
    postStore.collectAssetRefs(live)
    sessionLogStore.collectAssetRefs(live)
    const { removed, freed } = assetStore.sweep(live)
    if (removed) {
      console.log(`[assets] 고아 자산 ${removed}개 정리 · ${(freed / 1024 / 1024).toFixed(1)}MB 확보 (참조 ${live.size}개 보존)`)
    }
  } catch (e) {
    console.error('[assets] 자산 GC 실패:', e)
  }
}

const bootGc = setTimeout(runAssetGc, ASSET_GC_BOOT_DELAY_MS)
bootGc.unref()
const gc = setInterval(runAssetGc, ASSET_GC_INTERVAL_MS)
gc.unref() // 서버 종료를 막지 않도록

httpServer.listen(PORT, () => {
  const scheme = tls ? 'wss' : 'ws'
  const cors = corsOrigins ? corsOrigins.join(', ') : '*'
  console.log(
    `타코야키 박스 릴레이 서버 listening on :${PORT} (${scheme} · CORS: ${cors} · health: GET /health, Ctrl+C 종료)`
  )
})
