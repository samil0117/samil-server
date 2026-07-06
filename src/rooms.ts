// 방 스토어 — 서버가 방/참가자/메시지의 진실원본.
// 세션방 영속: persist 모드면 방을 <dataDir>/rooms/<id>.json 에 저장(장면·메타·멤버·전체 채팅).
// 시작 시 로드, 변경 시 주기적 자동저장(lastActivityAt 기준 dirty flush). 방은 소유자 삭제 전까지 유지(유휴 정리 안 함).
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { capImage, capImageList, capId, clampCoord } from './limits'
import { collectAssetRefs as scanAssetRefs } from './assets'
import type {
  Appearance,
  BgmState,
  Channel,
  Combatant,
  CombatState,
  ChatMessage,
  Handout,
  GameMap,
  GridConfig,
  HandoutScope,
  HandoutUpsertReq,
  MadnessTables,
  MapBackground,
  MapText,
  MapTextUpsertReq,
  Participant,
  RoomLoadReq,
  RoomState,
  SharedCharacter,
  Stroke,
  Token,
  TokenLayer,
  TokenUpsertReq,
  TokenZOp,
  VnLayer
} from './protocol'
import type { SuccessLevel } from './dice/types'

/** 방당 메시지 보관 상한. 세션방 영속(전체 채팅 보관, 소유자가 비울 때까지) — 폭주 방지용 큰 상한. */
const MAX_HISTORY = 20000

/** 서버 내부 맵(씬) — 토큰은 빠른 조회 위해 Map. 와이어 전송 시 toWireMap 으로 배열화. */
export interface RoomMap {
  id: string
  name: string
  background: MapBackground | null
  grid: GridConfig
  tokens: Map<string, Token> // key: token id
  drawings: Map<string, Stroke> // key: stroke id (자유 드로잉, 삽입 순서 = z 순서)
  texts: Map<string, MapText> // key: text id (맵 텍스트 라벨)
  vnBackground?: string // 비주얼 노벨 무대 배경(data URL) — 맵(씬)별, 전술 배경과 별개
  vnLayers?: VnLayer[] // 비주얼 노벨 무대 레이어 스택 — vnBackground 위에 z순
  bgColor?: string // 맵 배경 단색(여백 전체) — 캔버스 전체 채움. hex. 없으면 투명
}

export interface Room {
  id: string
  code: string
  title: string // 세션방 이름(목록 표시)
  ownerId: string // 소유자 계정 id(목록·삭제·복사·메타 권한). 비인증이면 playerId 폴백
  members: Set<string> // 참여한 적 있는 계정 id(목록용 · 소유자 포함)
  cardImage?: string // 세션 카드 이미지(1200×600 data URL)
  participants: Map<string, Participant> // key: playerId
  characters: Map<string, SharedCharacter> // key: playerId (프레즌스 서브셋)
  handouts: Map<string, Handout> // key: handout id (GM 자료)
  maps: Map<string, RoomMap> // key: map id (씬)
  activeMapId: string // 전원이 보는 활성 맵
  appearance: Appearance // 방 GM 강제 테마·다이스 카드
  cutInImage?: string // 방 주사위 컷인 이미지(data URL · GM 설정 · 레벨별 미설정 시 공통 폴백)
  cutInImages?: Partial<Record<SuccessLevel, string>> // 성공 단계별 컷인(GM 설정 · 전원 동기화)
  dimColor?: string // ~문장~ 행동지문 색(GM 설정 · 전원 동기화 · hex)
  madnessTables?: MadnessTables // GM 커스텀 광기표 — 미설정이면 클라 기본 표. 전원 동기화·영속.
  luckEnabled?: boolean // 행운 깎기(CoC7 하우스룰) 사용 여부 — GM 토글·전원 동기화·영속. 미설정=사용(기본).
  bgm: BgmState[] // 방 BGM 트랙들 (다중, GM 제어·전원 동기화 · 최대 5)
  combat: CombatState | null // 방 전투 상태 (GM 제어·전원 동기화 · in-memory, 비영속)
  channels: Map<string, Channel> // 그룹 채널(GM 개설·영속). key=channelId
  messages: ChatMessage[]
  /** 방별 캐릭터 시트 멤버십 — playerId(=계정) → 이 방에 속한 charId[]. 영속. 시트 데이터는 계정 라이브러리에. */
  charRooms: Map<string, string[]>
  createdAt: number
  lastActivityAt: number
}

/** 세션방 목록 항목(room:list). 카드·메타만 — 장면/채팅 본문은 입장 시 스냅샷으로. 클라 protocol 과 미러. */
export interface RoomSummary {
  id: string
  code: string
  title: string
  cardImage?: string
  owner: boolean // 요청 계정이 소유자(=GM)인지
  memberCount: number
  online: number // 현재 접속 인원
  updatedAt: number
}

// 코드 알파벳: 혼동 쉬운 문자(I, O, 0, 1) 제외.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function genSegment(): string {
  let s = ''
  for (let i = 0; i < 3; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

function genCode(): string {
  return `${genSegment()}-${genSegment()}-${genSegment()}`
}

const DEFAULT_GM_COLOR = '#e7a33e'
const DEFAULT_PL_COLOR = '#7c9cff'
const DEFAULT_GRID: GridConfig = { size: 64, visible: true }

// ===== 레이어·z순서 =====
/** 레이어 렌더 순서(작을수록 뒤). 와이어 토큰 정렬·신규 z 계산에 사용. */
const LAYER_ORDER: Record<TokenLayer, number> = { bg: 0, token: 1, standing: 2 }
/** 알 수 없는 값은 token 레이어로 정규화. */
function coerceLayer(v: unknown): TokenLayer {
  return v === 'bg' || v === 'standing' ? v : 'token'
}
/** 해당 레이어에서 가장 앞(최대 z). 비었으면 0 → 다음 신규 토큰 z=1. */
function topZ(tokens: Iterable<Token>, layer: TokenLayer): number {
  let max = 0
  for (const t of tokens) {
    if ((t.layer ?? 'token') === layer && (t.z ?? 0) > max) max = t.z ?? 0
  }
  return max
}

// 외형 강제 — 허용값(렌더러 useUIStore 와 동일). 와이어 문자열을 서버가 이 목록으로 검증.
const ACCENT_VALUES = ['indigo', 'teal', 'purple', 'amber', 'rose']
const DICE_STYLE_VALUES = ['editorial', 'medallion', 'ticket', 'cjk', 'classic']
const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  accent: 'indigo',
  uiAccent: '',
  diceStyle: 'editorial'
}

/** 외형 페이로드 방어적 정규화(허용값 밖이면 기본값으로). uiAccent 는 hex 길이만 제한. */
function normalizeAppearance(ap: Partial<Appearance> | undefined): Appearance {
  return {
    theme: ap?.theme === 'light' ? 'light' : 'dark',
    accent: typeof ap?.accent === 'string' && ACCENT_VALUES.includes(ap.accent) ? ap.accent : 'indigo',
    uiAccent: typeof ap?.uiAccent === 'string' ? ap.uiAccent.trim().slice(0, 32) : '',
    diceStyle:
      typeof ap?.diceStyle === 'string' && DICE_STYLE_VALUES.includes(ap.diceStyle)
        ? ap.diceStyle
        : 'editorial'
  }
}

// BGM 음원 종류 허용값(렌더러 protocol BgmKind 와 동일).
const BGM_KINDS = ['file', 'youtube']
/** 동시 재생 BGM 트랙 최대 수(환경음+배경음 등 레이어드). */
export const MAX_BGM_TRACKS = 5
/** 볼륨 0~1 클램프(유한·기본값 처리). */
function clampVol(v: unknown, fallback = 1): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

/**
 * BGM set 페이로드 방어적 정규화. 소스 없거나 kind 가 허용값 밖이면 null(무시).
 * title 은 200자 제한, loop 기본 true(앰비언트), volume 0~1(기본 1), playing 은 서버가 true 로 스탬프.
 */
function normalizeBgm(
  req:
    | { trackId?: unknown; kind?: unknown; src?: unknown; title?: unknown; loop?: unknown; volume?: unknown }
    | undefined
): BgmState | null {
  if (!req || typeof req.src !== 'string' || !req.src) return null
  if (typeof req.kind !== 'string' || !BGM_KINDS.includes(req.kind)) return null
  return {
    trackId: typeof req.trackId === 'string' && req.trackId ? req.trackId : 'bgm',
    kind: req.kind as BgmState['kind'],
    src: req.src,
    title: typeof req.title === 'string' ? req.title.slice(0, 200) : '',
    loop: req.loop !== false,
    playing: true,
    volume: clampVol(req.volume)
  }
}

// ===== 방 불러오기 방어적 정규화 — 신뢰할 수 없는 .orpg 페이로드를 안전한 서버 모델로. =====
/** 이동 권한 playerId 목록 정규화 — 문자열만·각 캡·최대 64개. 빈/무효는 undefined. */
function coercePlayerIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    const id = capId(x)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= 64) break
  }
  return out.length ? out : undefined
}
/** 맵 텍스트 라벨 정규화 — 텍스트 200자·크기 8~200·색 캡. 무효면 null. */
function coerceMapText(t: unknown): MapText | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const text = typeof o.text === 'string' ? o.text.slice(0, 200) : ''
  if (!text) return null
  return {
    id: o.id,
    playerId: typeof o.playerId === 'string' ? o.playerId : '',
    x: clampCoord(o.x),
    y: clampCoord(o.y),
    text,
    color: typeof o.color === 'string' && o.color ? o.color.slice(0, 32) : '#ffffff',
    size: typeof o.size === 'number' && Number.isFinite(o.size) ? Math.max(8, Math.min(200, o.size)) : 28,
    bold: o.bold === true ? true : undefined
  }
}
function coerceToken(t: unknown): Token | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  return {
    id: o.id,
    x: clampCoord(o.x),
    y: clampCoord(o.y),
    size: typeof o.size === 'number' && Number.isFinite(o.size) && o.size > 0 ? Math.min(o.size, 64) : 1,
    rotation: typeof o.rotation === 'number' && Number.isFinite(o.rotation) ? o.rotation : undefined,
    charPlayerId: capId(o.charPlayerId),
    label: typeof o.label === 'string' ? o.label.slice(0, 200) : undefined,
    color: typeof o.color === 'string' ? o.color.slice(0, 32) : undefined,
    image: capImage(o.image),
    layer: coerceLayer(o.layer),
    z: typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : 0,
    flipX: o.flipX === true ? true : undefined,
    hideName: o.hideName === true ? true : undefined,
    hideUI: o.hideUI === true ? true : undefined,
    allowedPlayers: coercePlayerIds(o.allowedPlayers),
    // 이미지 카드 — 디스크 로드 시에도 보존(없으면 undefined). 최대 20장.
    images: Array.isArray(o.images) ? capImageList(o.images, 20) : undefined,
    currentIndex:
      typeof o.currentIndex === 'number' && Number.isInteger(o.currentIndex) && o.currentIndex >= 0
        ? o.currentIndex
        : undefined
  }
}
function coerceStroke(s: unknown): Stroke | null {
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const pts: number[] = []
  for (const v of Array.isArray(o.points) ? o.points : []) {
    if (typeof v === 'number' && Number.isFinite(v)) pts.push(v)
    if (pts.length >= 4000) break
  }
  if (pts.length % 2 !== 0) pts.pop()
  if (pts.length < 2) return null
  return {
    id: o.id,
    playerId: typeof o.playerId === 'string' ? o.playerId : '',
    color: typeof o.color === 'string' ? o.color : '#ffffff',
    width: typeof o.width === 'number' && Number.isFinite(o.width) ? Math.max(1, Math.min(40, o.width)) : 4,
    points: pts
  }
}
function coerceBackground(bg: unknown): MapBackground | null {
  if (!bg || typeof bg !== 'object') return null
  const o = bg as Record<string, unknown>
  return {
    image: capImage(o.image),
    w: clampCoord(o.w),
    h: clampCoord(o.h)
  }
}
/** VN 레이어 배열 정규화 — 이미지 캡, 개수 상한(16), z/opacity 클램프. 무효/캡초과는 제외. 빈 결과는 undefined. */
function coerceVnLayers(arr: unknown): VnLayer[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const out: VnLayer[] = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const image = capImage(o.image)
    if (!image) continue // 이미지 없음 또는 캡 초과(드롭) → 레이어 아님
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 200) : randomUUID(),
      image,
      z: typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : out.length,
      opacity:
        typeof o.opacity === 'number' && Number.isFinite(o.opacity)
          ? Math.max(0, Math.min(1, o.opacity))
          : undefined,
      fit: o.fit === 'contain' ? 'contain' : o.fit === 'cover' ? 'cover' : undefined,
      front: o.front === true ? true : undefined
    })
    if (out.length >= 16) break
  }
  return out.length ? out : undefined
}
function coerceLoadedMap(gm: unknown): RoomMap | null {
  if (!gm || typeof gm !== 'object') return null
  const o = gm as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const tokens = new Map<string, Token>()
  for (const t of Array.isArray(o.tokens) ? o.tokens : []) {
    const c = coerceToken(t)
    if (c) tokens.set(c.id, c)
  }
  const drawings = new Map<string, Stroke>()
  for (const s of Array.isArray(o.drawings) ? o.drawings : []) {
    const c = coerceStroke(s)
    if (c) drawings.set(c.id, c)
  }
  const texts = new Map<string, MapText>()
  for (const t of Array.isArray(o.texts) ? o.texts : []) {
    const c = coerceMapText(t)
    if (c) texts.set(c.id, c)
  }
  const grid = o.grid && typeof o.grid === 'object' ? (o.grid as Record<string, unknown>) : {}
  const size =
    typeof grid.size === 'number' ? Math.round(Math.max(8, Math.min(512, grid.size))) : DEFAULT_GRID.size
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name ? o.name : '맵',
    background: coerceBackground(o.background),
    grid: { size, visible: grid.visible !== false },
    tokens,
    drawings,
    texts,
    vnBackground: capImage(o.vnBackground),
    vnLayers: coerceVnLayers(o.vnLayers),
    bgColor: coerceDimColor(o.bgColor)
  }
}
function coerceLoadedHandout(h: unknown): Handout | null {
  if (!h || typeof h !== 'object') return null
  const o = h as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const scope: HandoutScope = o.scope === 'all' || o.scope === 'targeted' ? o.scope : 'private'
  const now = Date.now()
  return {
    id: o.id,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    body: typeof o.body === 'string' ? o.body.slice(0, 20000) : '',
    image: capImage(o.image),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 40) : [],
    scope,
    targets:
      scope === 'targeted' && Array.isArray(o.targets)
        ? o.targets.filter((t): t is string => typeof t === 'string')
        : [],
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now
  }
}
/** 불러온 BGM 트랙 1개 정규화 — set 요청과 달리 저장된 playing 상태를 보존. 무효면 null. */
function coerceLoadedBgm(b: unknown): BgmState | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  if (typeof o.src !== 'string' || !o.src) return null
  if (typeof o.kind !== 'string' || !BGM_KINDS.includes(o.kind)) return null
  return {
    trackId: typeof o.trackId === 'string' && o.trackId ? o.trackId : 'bgm',
    kind: o.kind as BgmState['kind'],
    src: o.src,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    loop: o.loop !== false,
    playing: o.playing === true,
    volume: clampVol(o.volume)
  }
}

/**
 * 불러온 BGM 트랙 목록 정규화. 배열이면 각 트랙 정규화(최대 5), 구버전 단일 객체면 배열로 마이그레이션,
 * null/없음이면 빈 배열. 중복 trackId 는 뒤엣것 우선.
 */
function coerceLoadedBgmList(b: unknown): BgmState[] {
  const raw = Array.isArray(b) ? b : b && typeof b === 'object' ? [b] : []
  const out: BgmState[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const t = coerceLoadedBgm(item)
    if (!t) continue
    if (seen.has(t.trackId)) {
      out[out.findIndex((x) => x.trackId === t.trackId)] = t
    } else if (out.length < MAX_BGM_TRACKS) {
      seen.add(t.trackId)
      out.push(t)
    }
  }
  return out
}

/** ~문장~ 행동지문 색 정규화 — #rgb/#rrggbb hex 만 허용, 그 외/빈값이면 undefined(해제). */
function coerceDimColor(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const s = v.trim().toLowerCase()
  return /^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s) ? s : undefined
}

/** 성공 단계별 컷인 키 — 와이어/디스크 무효 키 방어용 화이트리스트. */
const CUTIN_LEVELS: SuccessLevel[] = ['critical', 'extreme', 'hard', 'regular', 'fail', 'fumble']

/** 성공 단계별 컷인 맵 정규화 — 유효 단계 키 + 캡 이하 이미지만. 빈 맵이면 undefined. */
function coerceCutInImages(v: unknown): Partial<Record<SuccessLevel, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const src = v as Record<string, unknown>
  const out: Partial<Record<SuccessLevel, string>> = {}
  for (const lv of CUTIN_LEVELS) {
    const img = capImage(src[lv])
    if (img) out[lv] = img
  }
  return Object.keys(out).length ? out : undefined
}

/** GM 커스텀 광기표 정규화 — realtime/summary 각 문자열 배열(최대 10개·각 500자). 둘 다 비면 undefined. */
function coerceMadnessTables(v: unknown): MadnessTables | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  // 항목 수 가변 — 40개·500자 캡. 빈 행은 보존(클라가 빈 표면 기본표 폴백).
  const norm = (a: unknown): string[] =>
    (Array.isArray(a) ? a : [])
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 40)
      .map((s) => s.slice(0, 500))
  // 구버전 키(realtime 단일) → realtimeTemp 로 마이그레이션.
  const realtimeTemp = norm(o.realtimeTemp ?? o.realtime)
  const realtimeIndef = norm(o.realtimeIndef)
  const summary = norm(o.summary)
  if (realtimeTemp.length === 0 && realtimeIndef.length === 0 && summary.length === 0) return undefined
  return { realtimeTemp, realtimeIndef, summary }
}

/**
 * 채팅 두상 풀 분리 — 같은 두상이 여러 메시지에 반복되므로 풀(avatarPool)로 묶고 메시지는 avatarRef(인덱스)만 보관.
 * 디스크 저장·입장 스냅샷에서 사용(메시지 수 비례 두상 중복 폭증 방지). 런타임·증분(chat:new)은 avatar 인라인 유지.
 */
function packAvatars(messages: ChatMessage[]): { messages: ChatMessage[]; avatarPool: string[] } {
  const pool: string[] = []
  const idx = new Map<string, number>()
  const out = messages.map((m): ChatMessage => {
    if (!m.avatar) return m
    let i = idx.get(m.avatar)
    if (i === undefined) {
      i = pool.length
      pool.push(m.avatar)
      idx.set(m.avatar, i)
    }
    const copy: ChatMessage = { ...m, avatarRef: i }
    delete copy.avatar
    return copy
  })
  return { messages: out, avatarPool: pool }
}

/** packAvatars 역연산 — avatarRef 를 풀에서 찾아 avatar 인라인으로 복원(런타임 메시지로). */
function unpackAvatars(messages: ChatMessage[], pool: string[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (typeof m.avatarRef !== 'number') return m
    const copy: ChatMessage = { ...m }
    const avatar = pool[m.avatarRef]
    delete copy.avatarRef
    if (avatar) copy.avatar = avatar
    return copy
  })
}

/** 새 빈 맵 생성(서버 내부). */
function makeMap(name: string): RoomMap {
  return {
    id: randomUUID(),
    name,
    background: null,
    grid: { ...DEFAULT_GRID },
    tokens: new Map(),
    drawings: new Map(),
    texts: new Map()
  }
}
/** 서버 내부 RoomMap → 와이어 GameMap(토큰·드로잉·텍스트 배열화). */
function toWireMap(m: RoomMap): GameMap {
  return {
    id: m.id,
    name: m.name,
    background: m.background,
    grid: m.grid,
    tokens: [...m.tokens.values()].sort(
      (a, b) => LAYER_ORDER[a.layer ?? 'token'] - LAYER_ORDER[b.layer ?? 'token'] || (a.z ?? 0) - (b.z ?? 0)
    ),
    drawings: [...m.drawings.values()],
    texts: [...m.texts.values()],
    vnBackground: m.vnBackground,
    vnLayers: m.vnLayers,
    bgColor: m.bgColor
  }
}

/** 핸드아웃 가시성(서버 권위). GM=전부 / private=GM만 / all=전체 / targeted=대상만. */
export function canViewHandout(h: Handout, viewer: { playerId: string; role: Participant['role'] }): boolean {
  if (viewer.role === 'GM') return true
  if (h.scope === 'private') return false
  if (h.scope === 'all') return true
  return h.targets.includes(viewer.playerId)
}

/** 방 → 영속 파일(JSON). 장면·메타·멤버·전체 채팅. 참가자/프레즌스는 런타임이라 제외. */
function roomToFile(room: Room): Record<string, unknown> {
  const { messages, avatarPool } = packAvatars(room.messages) // 채팅 두상 풀 분리 — 파일 크기 절감
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    ownerId: room.ownerId,
    members: [...room.members],
    // 세션 멤버 명단(playerId 기준 · 이미지 없는 경량) — 재시작에도 '한번 접속한 멤버'를 권한 대상으로 유지.
    // connected 는 런타임 상태라 저장 안 함(로드 시 전부 오프라인 → 재접속하면 admit 이 갱신).
    participantList: [...room.participants.values()].map((p) => ({
      playerId: p.playerId,
      nick: p.nick,
      color: p.color,
      role: p.role
    })),
    cardImage: room.cardImage,
    maps: [...room.maps.values()].map(toWireMap),
    activeMapId: room.activeMapId,
    handouts: [...room.handouts.values()],
    appearance: room.appearance,
    cutInImage: room.cutInImage,
    cutInImages: room.cutInImages,
    dimColor: room.dimColor,
    madnessTables: room.madnessTables, // GM 커스텀 광기표
    luckEnabled: room.luckEnabled, // 행운 깎기 사용 여부
    bgm: room.bgm,
    channels: [...room.channels.values()],
    messages,
    avatarPool, // 채팅 두상 풀
    charRooms: Object.fromEntries(room.charRooms), // 방별 시트 멤버십
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt
  }
}

/** 영속 파일 → 방(방어적 정규화). 참가자/프레즌스는 빈 상태(재입장 시 재구성). */
function roomFromFile(data: unknown): Room | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || typeof o.code !== 'string' || !o.code) return null
  const maps = new Map<string, RoomMap>()
  for (const gm of Array.isArray(o.maps) ? o.maps : []) {
    const m = coerceLoadedMap(gm)
    if (m) maps.set(m.id, m)
  }
  if (maps.size === 0) {
    const m = makeMap('맵 1')
    maps.set(m.id, m)
  }
  const handouts = new Map<string, Handout>()
  for (const h of Array.isArray(o.handouts) ? o.handouts : []) {
    const c = coerceLoadedHandout(h)
    if (c) handouts.set(c.id, c)
  }
  // 채팅 두상 풀 복원 — avatarRef 를 풀에서 avatar 인라인으로 되돌림(런타임 메시지).
  const avatarPool = Array.isArray(o.avatarPool)
    ? o.avatarPool.filter((x): x is string => typeof x === 'string')
    : []
  const messages = unpackAvatars(
    Array.isArray(o.messages) ? (o.messages.filter((m) => m && typeof m === 'object') as ChatMessage[]) : [],
    avatarPool
  )
  // 방별 시트 멤버십 복원 — { playerId: charId[] } 객체.
  const charRooms = new Map<string, string[]>()
  if (o.charRooms && typeof o.charRooms === 'object') {
    for (const [pid, ids] of Object.entries(o.charRooms as Record<string, unknown>)) {
      if (Array.isArray(ids))
        charRooms.set(
          pid,
          ids.filter((x): x is string => typeof x === 'string')
        )
    }
  }
  // 세션 멤버 명단 복원 — 재시작에도 한번 접속한 멤버를 권한 대상으로 유지. 전부 오프라인(connected:false)으로 시작.
  const participants = new Map<string, Participant>()
  for (const p of Array.isArray(o.participantList) ? o.participantList : []) {
    if (!p || typeof p !== 'object') continue
    const pp = p as Record<string, unknown>
    if (typeof pp.playerId !== 'string' || !pp.playerId) continue
    participants.set(pp.playerId, {
      playerId: pp.playerId,
      nick: typeof pp.nick === 'string' && pp.nick ? pp.nick.slice(0, 80) : '탐사자',
      color: typeof pp.color === 'string' && pp.color ? pp.color.slice(0, 32) : DEFAULT_PL_COLOR,
      role: pp.role === 'GM' ? 'GM' : 'PL',
      connected: false
    })
  }
  const now = Date.now()
  return {
    id: o.id,
    code: o.code,
    title: typeof o.title === 'string' && o.title ? o.title : '세션',
    ownerId: typeof o.ownerId === 'string' ? o.ownerId : '',
    members: new Set(
      Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : []
    ),
    cardImage: typeof o.cardImage === 'string' && o.cardImage ? o.cardImage : undefined,
    participants, // 영속 복원된 세션 멤버(전부 오프라인) — 재접속 시 admit 이 connected 갱신
    characters: new Map(),
    handouts,
    maps,
    activeMapId:
      typeof o.activeMapId === 'string' && maps.has(o.activeMapId)
        ? o.activeMapId
        : (maps.keys().next().value as string),
    appearance: normalizeAppearance(o.appearance as Partial<Appearance> | undefined),
    cutInImage: capImage(o.cutInImage),
    cutInImages: coerceCutInImages(o.cutInImages),
    dimColor: coerceDimColor(o.dimColor),
    madnessTables: coerceMadnessTables(o.madnessTables), // GM 커스텀 광기표
    luckEnabled: typeof o.luckEnabled === 'boolean' ? o.luckEnabled : undefined, // 행운 깎기 사용 여부(미설정=기본 사용)
    bgm: coerceLoadedBgmList(o.bgm),
    combat: null, // 전투는 in-memory(비영속) — 재시작 시 초기화
    channels: coerceChannels(o.channels),
    messages,
    charRooms,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : now
  }
}

/** 그룹 채널 정규화(로드용) — id 필수, 이름 80·멤버 64 캡. */
function normalizeChannel(c: unknown): Channel | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 200) : ''
  if (!id) return null
  const members = Array.isArray(o.members)
    ? o.members.filter((m): m is string => typeof m === 'string').slice(0, 64)
    : []
  return { id, name: typeof o.name === 'string' ? o.name.slice(0, 80) : '', members }
}
function coerceChannels(arr: unknown): Map<string, Channel> {
  const m = new Map<string, Channel>()
  for (const c of Array.isArray(arr) ? arr : []) {
    const n = normalizeChannel(c)
    if (n) m.set(n.id, n)
  }
  return m
}

/** 전투 상태 방어적 정규화(GM 입력). null/무효/빈 목록=전투 종료. 항목 64·이름 80·id 200 캡, 수치 클램프. */
function normalizeCombat(state: unknown): CombatState | null {
  if (!state || typeof state !== 'object') return null
  const o = state as Record<string, unknown>
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(-100000, Math.min(100000, Math.round(v))) : d
  const list = Array.isArray(o.combatants) ? o.combatants.slice(0, 64) : []
  const combatants: Combatant[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 200) : ''
    if (!id) continue
    const cc: Combatant = {
      id,
      name: typeof r.name === 'string' ? r.name.slice(0, 80) : '',
      initiative: num(r.initiative, 0)
    }
    if (typeof r.charPlayerId === 'string' && r.charPlayerId) cc.charPlayerId = r.charPlayerId.slice(0, 200)
    if (typeof r.hp === 'number') cc.hp = num(r.hp, 0)
    if (typeof r.hpMax === 'number') cc.hpMax = num(r.hpMax, 0)
    combatants.push(cc)
  }
  if (combatants.length === 0) return null // 빈 전투 = 종료
  const round = Math.max(1, num(o.round, 1))
  const turn = Math.max(0, Math.min(combatants.length - 1, num(o.turn, 0)))
  return { round, turn, combatants }
}

export class RoomStore {
  private rooms = new Map<string, Room>() // key: roomId
  // GM 선택지 서버 보관 — key=`${roomId}:${messageId}`. 옵션(스크립트 포함·비공개) + 응답자(1회 제한). 휘발(비영속).
  private choices = new Map<
    string,
    { options: { id: string; label: string; script?: string }[]; responders: Set<string> }
  >()
  private codeToId = new Map<string, string>() // 정규화 코드 -> roomId
  private persist: boolean
  private roomDir: string
  private savedAt = new Map<string, number>() // roomId -> 마지막 저장 시점의 lastActivityAt
  private flushing = new Set<string>() // 비동기 저장 진행 중인 roomId — 겹쳐쓰기 방지(직전 쓰기 끝나기 전 재진입 차단)

  /** persist:true 면 <dataDir>/rooms/*.json 로드·자동저장. 기본 비영속(테스트 안전). */
  constructor(opts?: { persist?: boolean; dataDir?: string }) {
    this.persist = opts?.persist === true
    this.roomDir = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'rooms')
    if (this.persist) this.loadAll()
  }

  private loadAll(): void {
    try {
      if (!existsSync(this.roomDir)) return
      for (const f of readdirSync(this.roomDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const room = roomFromFile(JSON.parse(readFileSync(join(this.roomDir, f), 'utf8')))
          if (room) {
            this.rooms.set(room.id, room)
            this.codeToId.set(room.code, room.id)
            this.savedAt.set(room.id, room.lastActivityAt)
          }
        } catch (e) {
          console.error(`[rooms] ${f} 로드 실패:`, e)
        }
      }
      console.log(`[rooms] 영속 세션 ${this.rooms.size}개 로드`)
    } catch (e) {
      console.error('[rooms] 로드 실패:', e)
    }
  }

  /**
   * 방 1개 파일 저장(원자적 tmp→rename). 직렬화는 동기로 '그 시점 상태'를 캡처하고, 디스크 I/O 는 비동기로 처리한다.
   * 동기 직렬화 후 비동기 쓰기로 이벤트 루프 블로킹을 피한다.
   * flushing 가드로 이전 쓰기가 끝나기 전 같은 방을 다시 쓰지 않게 한다(겹쳐쓰기·tmp 경합 방지).
   */
  private flush(room: Room): Promise<void> {
    if (!this.persist || this.flushing.has(room.id)) return Promise.resolve()
    let json: string
    let at: number
    try {
      at = room.lastActivityAt
      json = JSON.stringify(roomToFile(room)) // 동기 직렬화 — 일관 스냅샷 캡처(이후 방이 바뀌어도 안전)
    } catch (e) {
      console.error(`[rooms] ${room.id} 직렬화 실패:`, e)
      return Promise.resolve()
    }
    this.flushing.add(room.id)
    const f = join(this.roomDir, room.id + '.json')
    const tmp = f + '.tmp'
    return (async () => {
      try {
        await mkdir(this.roomDir, { recursive: true })
        await writeFile(tmp, json, 'utf8')
        await rename(tmp, f)
        this.savedAt.set(room.id, at) // 캡처 시점 변경분까지 저장됨 — 이후 변경은 다음 주기에 flushDirty 가 처리
      } catch (e) {
        console.error(`[rooms] ${room.id} 저장 실패:`, e)
        try {
          await unlink(tmp)
        } catch {
          /* tmp 없음/이미 정리 — 무시 */
        }
      } finally {
        this.flushing.delete(room.id)
      }
    })()
  }

  /** 변경된 방(lastActivityAt > 마지막 저장) 자동 저장(비동기 쓰기). 시작한 저장이 모두 끝나면 그 개수로 resolve. */
  async flushDirty(): Promise<number> {
    if (!this.persist) return 0
    const pending: Promise<void>[] = []
    for (const room of this.rooms.values()) {
      if (room.lastActivityAt > (this.savedAt.get(room.id) ?? 0)) pending.push(this.flush(room))
    }
    await Promise.all(pending)
    return pending.length
  }

  private removeFile(id: string): void {
    if (!this.persist) return
    try {
      const f = join(this.roomDir, id + '.json')
      if (existsSync(f)) unlinkSync(f)
    } catch (e) {
      console.error(`[rooms] ${id} 파일 삭제 실패:`, e)
    }
  }

  /** 세션 목록 항목(요청 계정 기준 owner 플래그). */
  private summaryFor(room: Room, accountId: string): RoomSummary {
    return {
      id: room.id,
      code: room.code,
      title: room.title,
      cardImage: room.cardImage,
      owner: room.ownerId === accountId,
      memberCount: room.members.size,
      online: [...room.participants.values()].filter((p) => p.connected).length,
      updatedAt: room.lastActivityAt
    }
  }

  private normalize(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '')
  }

  /** 방 생성 — 생성자는 GM·소유자. 고유 초대 코드 발급. accountId=소유자 계정(목록·권한), title/cardImage=세션 메타. */
  createRoom(host: {
    playerId: string
    nick: string
    color: string
    accountId?: string
    title?: string
    cardImage?: string
  }): { room: Room; self: Participant } {
    const id = randomUUID()
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    const self: Participant = {
      playerId: host.playerId,
      nick: host.nick.trim() || 'GM',
      color: host.color || DEFAULT_GM_COLOR,
      role: 'GM',
      connected: true
    }
    const now = Date.now()
    const firstMap = makeMap('맵 1')
    const ownerId = host.accountId || host.playerId
    const room: Room = {
      id,
      code,
      title: (host.title ?? '').trim().slice(0, 80) || '새 세션',
      ownerId,
      members: new Set([ownerId]),
      cardImage: capImage(host.cardImage),
      participants: new Map([[self.playerId, self]]),
      characters: new Map(),
      handouts: new Map(),
      maps: new Map([[firstMap.id, firstMap]]),
      activeMapId: firstMap.id,
      appearance: { ...DEFAULT_APPEARANCE },
      bgm: [],
      combat: null,
      channels: new Map(),
      messages: [],
      charRooms: new Map(),
      createdAt: now,
      lastActivityAt: now
    }
    this.rooms.set(id, room)
    this.codeToId.set(code, id)
    // 디스크 저장은 자동저장 인터벌(flushDirty)에 위임 — savedAt 은 flushDirty 만 설정해 동일 ms 변경도 누락되지 않게.
    return { room, self }
  }

  /**
   * 초대 코드로 입장. 이미 같은 playerId 가 있으면 재접속으로 처리(역할 유지, 닉/색 갱신).
   * 신규면 PL 로 추가.
   */
  joinByCode(
    code: string,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } | { error: string } {
    const roomId = this.codeToId.get(this.normalize(code))
    if (!roomId) return { error: '존재하지 않는 초대 코드입니다.' }
    const room = this.rooms.get(roomId)
    if (!room) return { error: '방을 찾을 수 없습니다.' }
    return this.admit(room, player)
  }

  /** roomId 로 직접 입장(세션 목록 클릭) — 소유자/멤버만. 코드 없이 재입장. */
  enterRoom(
    roomId: string,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } | { error: string } {
    const room = this.rooms.get(roomId)
    if (!room) return { error: '세션을 찾을 수 없습니다.' }
    const acct = player.accountId
    if (acct && room.ownerId !== acct && !room.members.has(acct)) {
      return { error: '이 세션의 멤버가 아닙니다. 초대 코드로 입장하세요.' }
    }
    return this.admit(room, player)
  }

  /** 공통 입장 처리: 멤버 등록 + 재접속/신규 참가자(소유자=GM, 그 외 PL). */
  private admit(
    room: Room,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } {
    room.lastActivityAt = Date.now()
    if (player.accountId) room.members.add(player.accountId)
    const existing = room.participants.get(player.playerId)
    if (existing) {
      existing.connected = true
      if (player.nick.trim()) existing.nick = player.nick.trim()
      if (player.color) existing.color = player.color
      return { room, self: existing }
    }
    const isOwner = !!player.accountId && room.ownerId === player.accountId
    const self: Participant = {
      playerId: player.playerId,
      nick: player.nick.trim() || (isOwner ? 'GM' : '탐사자'),
      color: player.color || (isOwner ? DEFAULT_GM_COLOR : DEFAULT_PL_COLOR),
      role: isOwner ? 'GM' : 'PL', // 소유자는 재입장 시에도 GM 복원(릴레이 재시작 후 participants 비어도)
      connected: true
    }
    room.participants.set(self.playerId, self)
    return { room, self }
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  /** 연결 끊김 표시 — 참가자는 유지(재접속 대기). 방은 sweep 전까지 보존. */
  markDisconnected(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const p = room.participants.get(playerId)
    if (p) p.connected = false
    // connected 는 런타임 상태(디스크에 저장하지 않음)라 lastActivityAt 을 갱신하지 않는다. 갱신하면 끊김/재접속마다
    // 방이 dirty 로 잡혀 8초 자동저장이 방 전체 히스토리를 동기 재직렬화(이벤트 루프 블록)→핑 타임아웃→끊김 가속 루프가 된다.
    return room
  }

  /** 세션 복구 재접속 시 온라인 표시 복원 — 브리프 끊김으로 connected=false 였던 참가자를 다시 true 로. 변경된 방 반환. */
  markConnected(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const p = room.participants.get(playerId)
    if (!p || p.connected) return room // 없거나 이미 온라인이면 그대로
    p.connected = true
    // connected 는 런타임 상태라 dirty 로 잡지 않는다(markDisconnected 와 동일 — 재접속마다 전체 재직렬화 방지).
    return room
  }

  /** 명시적 퇴장 — 참가자·캐릭터 제거. 빈 방이면 즉시 정리. */
  leave(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.participants.delete(playerId)
    room.characters.delete(playerId)
    room.lastActivityAt = Date.now()
    if (room.participants.size === 0 && !this.persist) {
      // 비영속: 빈 방 즉시 정리. 영속 모드는 방 유지(재입장 대기 · 소유자 삭제만 제거).
      this.rooms.delete(room.id)
      this.codeToId.delete(room.code)
      return undefined
    }
    return room
  }

  /** 초대 코드 재발급(추방 시). 옛 코드 무효화 → 새 고유 코드 설정·반환. */
  reissueCode(roomId: string): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    this.codeToId.delete(room.code)
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    room.code = code
    this.codeToId.set(code, roomId)
    room.lastActivityAt = Date.now()
    return code
  }

  /** 방 외형 설정(방 GM 강제 — 권한 검증은 호출 측 relay). 정규화된 저장본 반환, 방 없으면 undefined. */
  setAppearance(roomId: string, ap: Partial<Appearance> | undefined): Appearance | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.appearance = normalizeAppearance(ap)
    room.lastActivityAt = Date.now()
    return room.appearance
  }

  /**
   * 방 주사위 컷인 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). image 빈값이면 해제.
   * level 지정 시 그 성공 단계 컷인, 없으면 공통 컷인(레벨 미설정 폴백).
   * {ok,image,level} 반환(ok=false면 방 없음/무효 레벨). 크기 캡(애니 GIF/APNG/WebP 보존 — 재인코딩 안 함).
   */
  setCutIn(
    roomId: string,
    image: string | undefined,
    level?: SuccessLevel
  ): { ok: boolean; image?: string; level?: SuccessLevel } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    const capped = capImage(image)
    if (level !== undefined) {
      if (!CUTIN_LEVELS.includes(level)) return { ok: false } // 무효 레벨 무시
      const imgs = room.cutInImages ?? (room.cutInImages = {})
      if (capped) imgs[level] = capped
      else delete imgs[level]
      if (Object.keys(imgs).length === 0) room.cutInImages = undefined
      room.lastActivityAt = Date.now()
      return { ok: true, image: capped, level }
    }
    room.cutInImage = capped
    room.lastActivityAt = Date.now()
    return { ok: true, image: room.cutInImage }
  }

  /** ~문장~ 행동지문 색 설정/해제(GM 전용 · — 권한 검증은 호출 측 relay). 빈/무효값이면 해제. {ok,color} 반환. */
  setDimColor(roomId: string, color: string | undefined): { ok: boolean; color?: string } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    room.dimColor = coerceDimColor(color)
    room.lastActivityAt = Date.now()
    return { ok: true, color: room.dimColor }
  }

  /** GM 커스텀 광기표 설정/해제(GM 전용 · — 권한 검증은 호출 측 relay). 빈/무효면 해제(기본표). {ok,tables} 반환. */
  setMadnessTables(roomId: string, tables: unknown): { ok: boolean; tables?: MadnessTables } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    room.madnessTables = coerceMadnessTables(tables)
    room.lastActivityAt = Date.now()
    return { ok: true, tables: room.madnessTables }
  }

  /** 행운 깎기(CoC7 하우스룰) 사용 여부 설정(GM 전용 — 권한 검증은 호출 측 relay). {ok,enabled} 반환. */
  setLuckEnabled(roomId: string, enabled: boolean): { ok: boolean; enabled: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, enabled: true }
    room.luckEnabled = enabled
    room.lastActivityAt = Date.now()
    return { ok: true, enabled }
  }

  // ===== BGM (다중, GM 제어·전원 동기화 — 권한 검증은 호출 측 relay) =====
  /** BGM 트랙 추가/교체(trackId 멱등 upsert · playing=true 스탬프). 갱신된 트랙 목록 반환, 무효/방 없으면 null. */
  setBgm(
    roomId: string,
    req:
      | {
          trackId?: unknown
          kind?: unknown
          src?: unknown
          title?: unknown
          loop?: unknown
          volume?: unknown
        }
      | undefined
  ): BgmState[] | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const next = normalizeBgm(req)
    if (!next) return null // 무효 페이로드는 기존 상태 보존(무시)
    const i = room.bgm.findIndex((t) => t.trackId === next.trackId)
    if (i >= 0)
      room.bgm[i] = next // 같은 트랙 재로드(소스·볼륨 교체)
    else if (room.bgm.length < MAX_BGM_TRACKS)
      room.bgm.push(next) // 신규(최대 5)
    else return null // 5개 가득 — 무시(클라가 막지만 서버도 방어)
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  /** 특정 BGM 트랙 재생/반복·볼륨 토글(소스 유지). 변경된 트랙 상태 반환, 해당 트랙 없으면 undefined. */
  controlBgm(
    roomId: string,
    req: { trackId?: unknown; playing?: unknown; loop?: unknown; volume?: unknown } | undefined
  ): { trackId: string; playing: boolean; loop: boolean; volume: number } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || typeof req?.trackId !== 'string') return undefined
    const t = room.bgm.find((x) => x.trackId === req.trackId)
    if (!t) return undefined
    if (typeof req.playing === 'boolean') t.playing = req.playing
    if (typeof req.loop === 'boolean') t.loop = req.loop
    if (typeof req.volume === 'number' && Number.isFinite(req.volume))
      t.volume = Math.max(0, Math.min(1, req.volume))
    room.lastActivityAt = Date.now()
    return { trackId: t.trackId, playing: t.playing, loop: t.loop, volume: t.volume }
  }

  /** BGM 정지·해제 — trackId 지정 시 그 트랙만, 없으면 전체. 갱신된 트랙 목록 반환, 방 없으면 undefined. */
  clearBgm(roomId: string, trackId?: string): BgmState[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.bgm = trackId ? room.bgm.filter((t) => t.trackId !== trackId) : []
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  /**
   * 전체 트랙을 권위적으로 교체 — GM '나만 듣기'→'전체 동기화' 전환 시 GM 로컬 트랙으로 방을 정확히 맞춰
   * 고아 트랙(이전에 멈췄지만 동기 누락된)으로 인한 PL 혼선을 제거. 로드 정규화(playing 보존·최대 5) 재사용.
   */
  replaceBgm(roomId: string, tracks: unknown): BgmState[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.bgm = coerceLoadedBgmList(tracks)
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  // ===== GM 선택지 — 옵션 스크립트는 서버만 보관(비공개), 응답은 플레이어당 1회 =====
  /** 선택지 보관(GM 게시 시). 옵션엔 스크립트 포함(브로드캐스트본은 relay 가 제거). */
  setChoice(
    roomId: string,
    messageId: string,
    options: { id: string; label: string; script?: string }[]
  ): void {
    this.choices.set(`${roomId}:${messageId}`, { options, responders: new Set() })
  }
  /** 플레이어 선택 처리 — 1회만 허용. 통과 시 해당 옵션(스크립트 포함) 반환, 중복/무효면 null. */
  selectChoice(
    roomId: string,
    messageId: string,
    optionId: string,
    playerId: string
  ): { option: { id: string; label: string; script?: string } } | null {
    const c = this.choices.get(`${roomId}:${messageId}`)
    if (!c) return null
    if (c.responders.has(playerId)) return null // 이미 응답
    const option = c.options.find((o) => o.id === optionId)
    if (!option) return null
    c.responders.add(playerId)
    return { option }
  }

  // ===== 전투 (GM 제어·전원 동기화 — 권한 검증은 호출 측 relay) =====
  /** 전투 상태 전체 교체(GM). null/빈 목록=종료. 정규화 저장본 반환(종료면 null), 방 없으면 undefined. */
  setCombat(roomId: string, state: unknown): CombatState | null | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const next = normalizeCombat(state)
    room.combat = next
    room.lastActivityAt = Date.now()
    return next
  }

  // ===== 그룹 채널 (GM 개설·멤버 라우팅 — 권한 검증은 호출 측 relay) =====
  /** 그룹 채널 개설(GM). id 서버 생성, 멤버는 현재 참가자만. 생성 채널 반환, 방 없거나 이름 빈값이면 undefined. */
  createChannel(roomId: string, req: { name?: unknown; members?: unknown } | undefined): Channel | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const name = typeof req?.name === 'string' ? req.name.trim().slice(0, 80) : ''
    if (!name) return undefined
    const members = Array.isArray(req?.members)
      ? [
          ...new Set(
            req!.members.filter((m): m is string => typeof m === 'string' && room.participants.has(m))
          )
        ].slice(0, 64)
      : []
    const ch: Channel = { id: randomUUID(), name, members }
    room.channels.set(ch.id, ch)
    room.lastActivityAt = Date.now()
    return ch
  }

  /** 그룹 채널 삭제(GM). 있었으면 true. */
  removeChannel(roomId: string, id: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false
    const had = room.channels.delete(id)
    if (had) room.lastActivityAt = Date.now()
    return had
  }

  /** viewer 가 멤버이거나 GM 인 채널만(viewer 없으면 전체 — 테스트/하위호환). */
  channelsFor(room: Room, viewer?: { playerId: string; role: Participant['role'] }): Channel[] {
    const all = [...room.channels.values()]
    if (!viewer || viewer.role === 'GM') return all
    return all.filter((c) => c.members.includes(viewer.playerId))
  }

  /** 채널 메시지 전달 대상 playerId(멤버 + 모든 GM). 채널 없으면 빈 배열. */
  channelRecipients(roomId: string, channelId: string): string[] {
    const room = this.rooms.get(roomId)
    const ch = room?.channels.get(channelId)
    if (!room || !ch) return []
    const set = new Set<string>(ch.members)
    for (const p of room.participants.values()) if (p.role === 'GM') set.add(p.playerId)
    return [...set]
  }

  /** 채널 접근(발신) 권한: GM 또는 멤버. 채널 없으면 false. */
  canAccessChannel(roomId: string, channelId: string, playerId: string): boolean {
    const room = this.rooms.get(roomId)
    const ch = room?.channels.get(channelId)
    if (!room || !ch) return false
    return room.participants.get(playerId)?.role === 'GM' || ch.members.includes(playerId)
  }

  // ===== 방 불러오기 (GM 전용 — 권한 검증은 호출 측 relay) =====
  /**
   * .orpg 스냅샷의 장면(맵·자료·외형·BGM)을 방에 적용(전부 방어적 정규화).
   * 참가자·채팅은 라이브 상태라 건드리지 않음. 맵이 비면 빈 맵 1개 보장. 성공 시 true.
   */
  loadSnapshot(roomId: string, data: RoomLoadReq | undefined): boolean {
    const room = this.rooms.get(roomId)
    if (!room || !data || typeof data !== 'object') return false
    const maps = new Map<string, RoomMap>()
    for (const gm of Array.isArray(data.maps) ? data.maps : []) {
      const m = coerceLoadedMap(gm)
      if (m) maps.set(m.id, m)
    }
    if (maps.size === 0) {
      const m = makeMap('맵 1')
      maps.set(m.id, m)
    }
    room.maps = maps
    room.activeMapId =
      typeof data.activeMapId === 'string' && maps.has(data.activeMapId)
        ? data.activeMapId
        : (maps.keys().next().value as string)
    const handouts = new Map<string, Handout>()
    for (const h of Array.isArray(data.handouts) ? data.handouts : []) {
      const c = coerceLoadedHandout(h)
      if (c) handouts.set(c.id, c)
    }
    room.handouts = handouts
    room.appearance = normalizeAppearance(data.appearance)
    room.bgm = coerceLoadedBgmList(data.bgm)
    room.lastActivityAt = Date.now()
    return true
  }

  /** 서버 권위 메시지 누적 (id/time 은 호출 측에서 이미 스탬프). */
  addMessage(roomId: string, message: ChatMessage): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    room.messages.push(message)
    if (room.messages.length > MAX_HISTORY) {
      room.messages.splice(0, room.messages.length - MAX_HISTORY)
    }
    room.lastActivityAt = Date.now()
  }

  /**
   * 채팅 메시지 수정 — 작성자 본인 또는 GM. 텍스트 메시지(speech/narration/script)만 수정 가능.
   * 성공 시 갱신된 메시지 반환(브로드캐스트용), 미존재·권한 없음·비텍스트면 undefined.
   */
  editMessage(
    roomId: string,
    id: string,
    text: string,
    byPlayerId: string,
    isGM: boolean
  ): ChatMessage | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const msg = room.messages.find((m) => m.id === id)
    if (!msg || msg.deleted) return undefined
    if (msg.playerId !== byPlayerId && !isGM) return undefined // 작성자 또는 GM 만
    if (msg.kind !== 'speech' && msg.kind !== 'narration' && msg.kind !== 'script') return undefined // 텍스트만
    msg.text = text
    msg.edited = true
    room.lastActivityAt = Date.now()
    return msg
  }

  /** 채팅 메시지 삭제 — GM 만. 툼스톤("삭제된 메시지") 없이 히스토리에서 완전 제거(깔끔 삭제). 성공 시 id 반환. */
  deleteMessage(roomId: string, id: string, isGM: boolean): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !isGM) return undefined
    const i = room.messages.findIndex((m) => m.id === id)
    if (i < 0) return undefined
    room.messages.splice(i, 1) // 완전 제거(스냅샷·히스토리에 흔적 없음)
    room.lastActivityAt = Date.now()
    return id
  }

  /**
   * 캐릭터 프레즌스 서브셋 보관/갱신(char 의 playerId 는 호출 측에서 서버 권위로 스탬프됨).
   * 표정 인덱스는 standings 범위로 보정해 저장. 저장본 반환.
   */
  setCharacter(roomId: string, char: SharedCharacter): SharedCharacter | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    // 이미지 필드 캡(개수·크기) + 텍스트 길이 바운드 — 신뢰 못 할 클라 페이로드 방어.
    const standings = capImageList(char.standings)
    const headshots = char.headshots ? capImageList(char.headshots) : undefined
    const max = Math.max(0, standings.length - 1)
    const currentExpression = Math.min(Math.max(0, char.currentExpression), max)
    const stored: SharedCharacter = {
      ...char,
      charId: capId(char.charId) ?? '',
      name: typeof char.name === 'string' ? char.name.slice(0, 100) : '',
      color: typeof char.color === 'string' ? char.color.slice(0, 32) : '#7c9cff',
      nameColor: typeof char.nameColor === 'string' ? char.nameColor.slice(0, 32) : undefined,
      headshot: capImage(char.headshot),
      standings,
      headshots,
      currentExpression,
      // 스탠딩 표시 높이(px) — 유한수만, 40~4000 으로 클램프. 비유한/미설정은 undefined(기본 92%).
      standingHeight:
        typeof char.standingHeight === 'number' && Number.isFinite(char.standingHeight)
          ? Math.min(4000, Math.max(40, Math.round(char.standingHeight)))
          : undefined,
      bio: typeof char.bio === 'string' ? char.bio.slice(0, 500) : undefined // 자기소개 길이 바운드
    }
    room.characters.set(char.playerId, stored)
    room.lastActivityAt = Date.now()
    return stored
  }

  /** 표정 인덱스만 갱신(잦은 변경). 보정된 인덱스 반환, 보관된 캐릭터 없으면 undefined. */
  setExpression(roomId: string, playerId: string, index: number): number | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const char = room.characters.get(playerId)
    if (!char) return undefined
    const max = Math.max(0, char.standings.length - 1)
    char.currentExpression = Math.min(Math.max(0, index), max)
    room.lastActivityAt = Date.now()
    return char.currentExpression
  }

  // ===== 핸드아웃 =====
  /**
   * 핸드아웃 생성/갱신. id 없으면 신규(randomUUID·createdAt), 있으면 기존 갱신(updatedAt 만 새로).
   * 저장본과 갱신 전 스냅샷(prev, 신규면 undefined)을 함께 반환 — 라우팅 대상 diff(가시성 변화)용.
   */
  upsertHandout(roomId: string, req: HandoutUpsertReq): { handout: Handout; prev?: Handout } | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const now = Date.now()
    const existing = typeof req.id === 'string' ? room.handouts.get(req.id) : undefined
    const scope: HandoutScope = req.scope === 'all' || req.scope === 'targeted' ? req.scope : 'private'
    const handout: Handout = {
      // 기존이면 그 id 유지, 신규면 클라 제공 id 존중(GM 전용 경로 — 낙관적 선택용), 없으면 생성.
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      title: typeof req.title === 'string' ? req.title.slice(0, 200) : '',
      body: typeof req.body === 'string' ? req.body.slice(0, 20000) : '',
      image: capImage(req.image),
      imageAlign: req.imageAlign === 'center' || req.imageAlign === 'right' ? req.imageAlign : undefined,
      tags: Array.isArray(req.tags) ? req.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
      scope,
      targets:
        scope === 'targeted' && Array.isArray(req.targets)
          ? req.targets.filter((t) => typeof t === 'string').slice(0, 200)
          : [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const prev = existing ? { ...existing } : undefined
    room.handouts.set(handout.id, handout)
    room.lastActivityAt = now
    return { handout, prev }
  }

  /** 핸드아웃 삭제. 삭제된 핸드아웃(라우팅용 prev) 반환, 없으면 undefined. */
  deleteHandout(roomId: string, id: string): Handout | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const prev = room.handouts.get(id)
    if (!prev) return undefined
    room.handouts.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getHandout(roomId: string, id: string): Handout | undefined {
    return this.rooms.get(roomId)?.handouts.get(id)
  }

  /** viewer 가 볼 수 있는 핸드아웃만 반환. */
  handoutsFor(room: Room, viewer: { playerId: string; role: Participant['role'] }): Handout[] {
    return [...room.handouts.values()].filter((h) => canViewHandout(h, viewer))
  }

  // ===== 맵·토큰 (다중 맵) =====
  getMap(roomId: string, mapId: string): RoomMap | undefined {
    return this.rooms.get(roomId)?.maps.get(mapId)
  }

  /** 새 맵 생성. 저장본(와이어) 반환, 방 없으면 undefined. */
  createMap(roomId: string, name?: string): GameMap | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const m = makeMap((name ?? '').trim() || `맵 ${room.maps.size + 1}`)
    room.maps.set(m.id, m)
    room.lastActivityAt = Date.now()
    return toWireMap(m)
  }

  /** 맵 삭제(마지막 1개는 삭제 불가). 활성 맵 삭제 시 다른 맵으로 전환. {removed,activeMapId} 반환. */
  deleteMap(roomId: string, mapId: string): { removed: string; activeMapId: string } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !room.maps.has(mapId) || room.maps.size <= 1) return undefined
    room.maps.delete(mapId)
    if (room.activeMapId === mapId) room.activeMapId = room.maps.keys().next().value as string
    room.lastActivityAt = Date.now()
    return { removed: mapId, activeMapId: room.activeMapId }
  }

  /** 맵 이름 변경. {mapId,name} 반환, 맵 없으면 undefined. */
  renameMap(roomId: string, mapId: string, name: string): { mapId: string; name: string } | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    m.name = (typeof name === 'string' ? name.trim() : '') || m.name
    room.lastActivityAt = Date.now()
    return { mapId, name: m.name }
  }

  /** 활성 맵 전환. 새 활성 id 반환, 맵 없으면 undefined. */
  setActiveMap(roomId: string, mapId: string): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !room.maps.has(mapId)) return undefined
    room.activeMapId = mapId
    room.lastActivityAt = Date.now()
    return mapId
  }

  /** 맵 배경 설정/해제(방어적 정규화). 저장본 반환, 맵 없으면 undefined. */
  setBackground(roomId: string, mapId: string, bg: MapBackground | null): MapBackground | null | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    m.background =
      bg && typeof bg === 'object'
        ? {
            image: capImage(bg.image),
            w: clampCoord(bg.w),
            h: clampCoord(bg.h)
          }
        : null
    room.lastActivityAt = Date.now()
    return m.background
  }

  /**
   * 비주얼 노벨 무대 배경 설정/해제(GM 전용 — 권한 검증은 호출 측 relay).
   * image 빈값이면 해제. {ok,image} 반환(ok=false 면 맵 없음 → 미동작).
   */
  setVnBackground(roomId: string, mapId: string, image: string | undefined): { ok: boolean; image?: string } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.vnBackground = capImage(image)
    room.lastActivityAt = Date.now()
    return { ok: true, image: m.vnBackground }
  }

  /** 맵 배경 단색 설정/해제(GM 전용 · — 권한 검증은 호출 측 relay). 빈/무효(비-hex)면 해제. {ok,color} 반환. */
  setMapBgColor(roomId: string, mapId: string, color: string | undefined): { ok: boolean; color?: string } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.bgColor = coerceDimColor(color)
    room.lastActivityAt = Date.now()
    return { ok: true, color: m.bgColor }
  }

  /**
   * VN 무대 레이어 스택 전체 교체(GM 전용 — 권한 검증은 호출 측 relay).
   * 방어적 정규화(이미지 캡·개수 상한·z/opacity 클램프). {ok,layers} 반환(ok=false면 맵 없음).
   */
  setVnLayers(roomId: string, mapId: string, layers: unknown): { ok: boolean; layers?: VnLayer[] } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.vnLayers = coerceVnLayers(layers)
    room.lastActivityAt = Date.now()
    return { ok: true, layers: m.vnLayers ?? [] }
  }

  /** 맵 그리드 설정(방어적 정규화: size 8~512 클램프). 저장본 반환, 맵 없으면 undefined. */
  setGrid(roomId: string, mapId: string, grid: GridConfig): GridConfig | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const size =
      typeof grid?.size === 'number' ? Math.round(Math.max(8, Math.min(512, grid.size))) : m.grid.size
    m.grid = { size, visible: grid?.visible !== false }
    room.lastActivityAt = Date.now()
    return m.grid
  }

  /** 토큰 생성/갱신. id 없으면 신규(randomUUID), 있으면 기존 갱신. 저장본 반환, 맵 없으면 undefined. */
  upsertToken(roomId: string, mapId: string, req: TokenUpsertReq): Token | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const existing = typeof req.id === 'string' ? m.tokens.get(req.id) : undefined
    const layer = typeof req.layer === 'string' ? coerceLayer(req.layer) : (existing?.layer ?? 'token')
    // 같은 레이어 갱신이면 z 보존, 신규·레이어 이동이면 그 레이어 맨 앞으로(top+1).
    const z =
      existing && (existing.layer ?? 'token') === layer
        ? (existing.z ?? 0)
        : topZ(m.tokens.values(), layer) + 1
    // 좌표·크기는 유한·범위 클램프, 이미지/식별자는 캡. charPlayerId 는 GM 전용 경로라
    // 길이만 캡 — 이동 권한은 charPlayerId===playerId 일치로만 부여되어 잘못된 id 는 누구에게도 권한 없음.
    const token: Token = {
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      x: clampCoord(req.x, existing?.x ?? 0),
      y: clampCoord(req.y, existing?.y ?? 0),
      size:
        typeof req.size === 'number' && Number.isFinite(req.size) && req.size > 0
          ? Math.min(req.size, 64)
          : (existing?.size ?? 1),
      rotation:
        typeof req.rotation === 'number' && Number.isFinite(req.rotation) ? req.rotation : existing?.rotation,
      charPlayerId: capId(req.charPlayerId) ?? existing?.charPlayerId,
      label: typeof req.label === 'string' ? req.label.slice(0, 200) : existing?.label,
      color: typeof req.color === 'string' ? req.color.slice(0, 32) : existing?.color,
      image: capImage(req.image) ?? existing?.image,
      layer,
      z,
      flipX: req.flipX === true ? true : req.flipX === false ? undefined : existing?.flipX,
      // 이름/UI 숨김 — 명시값이면 적용(true=숨김, false=해제), 미지정이면 기존 보존.
      hideName: req.hideName === true ? true : req.hideName === false ? undefined : existing?.hideName,
      hideUI: req.hideUI === true ? true : req.hideUI === false ? undefined : existing?.hideUI,
      // 이동/회전 권한 명단 — 배열이면 정규화 적용(빈 배열=해제), 미지정이면 기존 보존.
      allowedPlayers: Array.isArray(req.allowedPlayers)
        ? coercePlayerIds(req.allowedPlayers)
        : existing?.allowedPlayers,
      // 이미지 카드 — 배열이면 적용(최대 20장), 미지정이면 기존 보존. currentIndex 는 정수면 적용, 아니면 보존.
      images: Array.isArray(req.images) ? capImageList(req.images, 20) : existing?.images,
      currentIndex:
        typeof req.currentIndex === 'number' && Number.isInteger(req.currentIndex) && req.currentIndex >= 0
          ? req.currentIndex
          : existing?.currentIndex
    }
    m.tokens.set(token.id, token)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 이동(위치만). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay). */
  moveToken(roomId: string, mapId: string, id: string, x: number, y: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const token = m?.tokens.get(id)
    if (!room || !m || !token) return undefined
    token.x = clampCoord(x, token.x)
    token.y = clampCoord(y, token.y)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 회전(각도만, 라디안). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay · 이동과 동일). */
  rotateToken(roomId: string, mapId: string, id: string, rotation: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const token = m?.tokens.get(id)
    if (!room || !m || !token) return undefined
    token.rotation = Number.isFinite(rotation) ? rotation : (token.rotation ?? 0)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 이미지 카드의 표시 이미지 인덱스 변경(images 범위로 클램프). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay · 이동과 동일). */
  setTokenImageIndex(roomId: string, mapId: string, id: string, index: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const token = m?.tokens.get(id)
    if (!room || !m || !token) return undefined
    const max = (token.images?.length ?? 1) - 1
    token.currentIndex = Math.max(0, Math.min(Math.floor(index), Math.max(0, max)))
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 삭제. 삭제된 토큰 반환, 없으면 undefined. */
  removeToken(roomId: string, mapId: string, id: string): Token | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const prev = m?.tokens.get(id)
    if (!room || !m || !prev) return undefined
    m.tokens.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getToken(roomId: string, mapId: string, id: string): Token | undefined {
    return this.getMap(roomId, mapId)?.tokens.get(id)
  }

  /**
   * 토큰 z순서/레이어 변경(GM 전용 — 권한 검증은 호출 측 relay). layer 지정 시 그 레이어 맨 앞으로 이동,
   * 아니면 op 로 현재 레이어 내 정렬. 변경된 토큰(0~2개 · forward/backward 는 교환쌍) 반환 → relay 가 각각 token:state 송출.
   */
  reorderToken(
    roomId: string,
    mapId: string,
    id: string,
    req: { op?: TokenZOp; layer?: TokenLayer }
  ): Token[] {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const t = m?.tokens.get(id)
    if (!room || !m || !t) return []
    const changed: Token[] = []
    const curLayer = t.layer ?? 'token'
    if (req.layer && coerceLayer(req.layer) !== curLayer) {
      const layer = coerceLayer(req.layer)
      // topZ 를 레이어 변경 전에 계산(아직 옛 레이어 → t 자신이 새 레이어 max 에 포함되지 않음).
      const z = topZ(m.tokens.values(), layer) + 1 // 새 레이어 맨 앞으로
      t.layer = layer
      t.z = z
      changed.push(t)
    } else if (req.op) {
      const sibs = [...m.tokens.values()].filter((x) => (x.layer ?? 'token') === curLayer)
      const myz = t.z ?? 0
      if (req.op === 'front') {
        const mx = Math.max(...sibs.map((s) => s.z ?? 0))
        if (myz < mx) {
          t.z = mx + 1
          changed.push(t)
        }
      } else if (req.op === 'back') {
        const mn = Math.min(...sibs.map((s) => s.z ?? 0))
        if (myz > mn) {
          t.z = mn - 1
          changed.push(t)
        }
      } else if (req.op === 'forward') {
        // 바로 위(다음으로 큰 z) 형제와 z 교환.
        const next = sibs.filter((s) => (s.z ?? 0) > myz).sort((a, b) => (a.z ?? 0) - (b.z ?? 0))[0]
        if (next) {
          const nz = next.z ?? 0
          next.z = myz
          t.z = nz
          changed.push(t, next)
        }
      } else if (req.op === 'backward') {
        // 바로 아래(다음으로 작은 z) 형제와 z 교환.
        const prev = sibs.filter((s) => (s.z ?? 0) < myz).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0]
        if (prev) {
          const pz = prev.z ?? 0
          prev.z = myz
          t.z = pz
          changed.push(t, prev)
        }
      }
    }
    if (changed.length) room.lastActivityAt = Date.now()
    return changed
  }

  // ===== 자유 드로잉 =====
  /**
   * 드로잉 획 추가(전원). points 는 유한 숫자만·짝수 길이로 정규화하고 4000개(2000점)로 상한,
   * width 는 1~40 클램프. playerId/color 는 호출 측(relay)이 참가자 정보로 스탬프. 저장본 반환.
   */
  addStroke(
    roomId: string,
    mapId: string,
    req: { id?: unknown; points: unknown; width?: unknown },
    author: { playerId: string; color: string }
  ): Stroke | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const raw = Array.isArray(req.points) ? req.points : []
    const pts: number[] = []
    for (const v of raw) {
      if (typeof v === 'number' && Number.isFinite(v)) pts.push(v)
      if (pts.length >= 4000) break
    }
    if (pts.length % 2 !== 0) pts.pop()
    if (pts.length < 2) return undefined // 점이 너무 적으면 획 아님
    const width =
      typeof req.width === 'number' && Number.isFinite(req.width) ? Math.max(1, Math.min(40, req.width)) : 4
    const stroke: Stroke = {
      id: typeof req.id === 'string' && req.id ? req.id : randomUUID(),
      playerId: author.playerId,
      color: author.color,
      width,
      points: pts
    }
    m.drawings.set(stroke.id, stroke)
    room.lastActivityAt = Date.now()
    return stroke
  }

  getStroke(roomId: string, mapId: string, strokeId: string): Stroke | undefined {
    return this.getMap(roomId, mapId)?.drawings.get(strokeId)
  }

  /** 드로잉 획 삭제. 삭제된 획 반환, 없으면 undefined. 권한 검증은 호출 측(relay). */
  eraseStroke(roomId: string, mapId: string, strokeId: string): Stroke | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const prev = m?.drawings.get(strokeId)
    if (!room || !m || !prev) return undefined
    m.drawings.delete(strokeId)
    room.lastActivityAt = Date.now()
    return prev
  }

  /** 맵의 모든 드로잉 삭제(GM 전용 — 호출 측 검증). 맵 있으면 true. */
  clearDrawings(roomId: string, mapId: string): boolean {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return false
    m.drawings.clear()
    room.lastActivityAt = Date.now()
    return true
  }

  // ===== 맵 텍스트 라벨 =====
  /**
   * 맵 텍스트 생성/편집. id 없으면 신규(작성자=author.playerId), 있으면 기존 편집(텍스트·색·크기·굵기·위치만).
   * 권한 검증(편집은 작성자/GM)은 호출 측(relay). 텍스트가 비면 null(생성 안 함). 맵당 최대 500개.
   */
  upsertText(
    roomId: string,
    mapId: string,
    req: MapTextUpsertReq,
    author: { playerId: string }
  ): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const existing = typeof req.id === 'string' ? m.texts.get(req.id) : undefined
    const text = typeof req.text === 'string' ? req.text.slice(0, 200) : ''
    if (!text) return undefined
    if (!existing && m.texts.size >= 500) return undefined // 폭주 방지 상한
    const label: MapText = {
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      playerId: existing?.playerId ?? author.playerId, // 작성자는 생성 시 고정(편집해도 불변)
      x: clampCoord(req.x, existing?.x ?? 0),
      y: clampCoord(req.y, existing?.y ?? 0),
      text,
      color:
        typeof req.color === 'string' && req.color ? req.color.slice(0, 32) : (existing?.color ?? '#ffffff'),
      size:
        typeof req.size === 'number' && Number.isFinite(req.size)
          ? Math.max(8, Math.min(200, req.size))
          : (existing?.size ?? 28),
      bold: req.bold === true ? true : req.bold === false ? undefined : existing?.bold
    }
    m.texts.set(label.id, label)
    room.lastActivityAt = Date.now()
    return label
  }

  /** 맵 텍스트 이동(위치만). 권한 검증(작성자/GM)은 호출 측(relay). */
  moveText(roomId: string, mapId: string, id: string, x: number, y: number): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const t = m?.texts.get(id)
    if (!room || !m || !t) return undefined
    t.x = clampCoord(x, t.x)
    t.y = clampCoord(y, t.y)
    room.lastActivityAt = Date.now()
    return t
  }

  /** 맵 텍스트 삭제. 삭제된 텍스트 반환. 권한 검증(작성자/GM)은 호출 측(relay). */
  removeText(roomId: string, mapId: string, id: string): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const prev = m?.texts.get(id)
    if (!room || !m || !prev) return undefined
    m.texts.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getText(roomId: string, mapId: string, id: string): MapText | undefined {
    return this.getMap(roomId, mapId)?.texts.get(id)
  }

  /** 맵의 모든 텍스트 삭제(GM 전용 — 호출 측 검증). 맵 있으면 true. */
  clearTexts(roomId: string, mapId: string): boolean {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return false
    m.texts.clear()
    room.lastActivityAt = Date.now()
    return true
  }

  // ===== 세션 목록·관리 (서버 영속) =====
  /** 계정의 세션 목록(소유 또는 참여) — 최근 활동 순. */
  listForAccount(accountId: string): RoomSummary[] {
    const out: RoomSummary[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId === accountId || room.members.has(accountId))
        out.push(this.summaryFor(room, accountId))
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 세션 메타(이름·카드) 수정 — 소유자만. cardImage=null 이면 제거. 갱신 요약 반환. */
  setMeta(
    roomId: string,
    accountId: string,
    patch: { title?: string; cardImage?: string | null }
  ): RoomSummary | undefined {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return undefined
    if (typeof patch.title === 'string' && patch.title.trim()) room.title = patch.title.trim().slice(0, 80)
    if (patch.cardImage === null) room.cardImage = undefined
    else if (typeof patch.cardImage === 'string' && patch.cardImage)
      room.cardImage = capImage(patch.cardImage) ?? room.cardImage
    room.lastActivityAt = Date.now()
    void this.flush(room)
    return this.summaryFor(room, accountId)
  }

  /** 세션 삭제 — 소유자만. 메모리·파일 제거. 알릴 대상(멤버·현재 참가자) 반환. */
  deleteRoom(roomId: string, accountId: string): { members: string[]; participants: string[] } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return undefined
    const members = [...room.members]
    const participants = [...room.participants.keys()]
    this.rooms.delete(roomId)
    this.codeToId.delete(room.code)
    this.savedAt.delete(roomId)
    this.removeFile(roomId)
    return { members, participants }
  }

  /**
   * 관리자 강제 삭제 — 소유자 검증을 생략하고 방을 제거(권한 검사는 호출 측 relay 가 admin 으로 수행).
   * 통지·정리에 쓰도록 소유자·멤버·현재 참가자를 반환. 없는 방이면 undefined.
   */
  adminDeleteRoom(roomId: string): { ownerId: string; members: string[]; participants: string[] } | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const ownerId = room.ownerId
    const members = [...room.members]
    const participants = [...room.participants.keys()]
    this.rooms.delete(roomId)
    this.codeToId.delete(room.code)
    this.savedAt.delete(roomId)
    this.removeFile(roomId)
    return { ownerId, members, participants }
  }

  /**
   * 한 계정이 소유한 모든 세션방 삭제(계정 탈퇴 연쇄). 각 방의 참가자 목록(강제 퇴장 통지용)과 함께 반환.
   * 소유자가 사라진 방은 GM 권한을 행사할 주체가 없어 사실상 좀비 — 그래서 통째로 제거한다.
   */
  deleteOwnedBy(accountId: string): { id: string; participants: string[] }[] {
    if (!accountId) return []
    const out: { id: string; participants: string[] }[] = []
    for (const room of [...this.rooms.values()]) {
      if (room.ownerId !== accountId) continue
      const participants = [...room.participants.keys()]
      this.rooms.delete(room.id)
      this.codeToId.delete(room.code)
      this.savedAt.delete(room.id)
      this.removeFile(room.id)
      out.push({ id: room.id, participants })
    }
    return out
  }

  /** 세션 복사 — 소유자만. 장면(맵·자료·외형·BGM·카드)만 복제, 참가자·채팅·멤버는 초기화. 새 방 요약 반환. */
  duplicateRoom(roomId: string, accountId: string): RoomSummary | undefined {
    const src = this.rooms.get(roomId)
    if (!src || src.ownerId !== accountId) return undefined
    const id = randomUUID()
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    const now = Date.now()
    const maps = new Map<string, RoomMap>()
    for (const m of src.maps.values()) {
      const c = coerceLoadedMap(toWireMap(m)) // 깊은 복사(wire 왕복)
      if (c) maps.set(c.id, c)
    }
    const handouts = new Map<string, Handout>()
    for (const h of src.handouts.values()) handouts.set(h.id, { ...h })
    const room: Room = {
      id,
      code,
      title: src.title + ' (사본)',
      ownerId: accountId,
      members: new Set([accountId]),
      cardImage: src.cardImage,
      participants: new Map(),
      characters: new Map(),
      handouts,
      maps,
      activeMapId: maps.has(src.activeMapId) ? src.activeMapId : (maps.keys().next().value as string),
      appearance: { ...src.appearance },
      cutInImage: src.cutInImage,
      cutInImages: src.cutInImages ? { ...src.cutInImages } : undefined,
      dimColor: src.dimColor,
      madnessTables: src.madnessTables
        ? {
            realtimeTemp: [...src.madnessTables.realtimeTemp],
            realtimeIndef: [...src.madnessTables.realtimeIndef],
            summary: [...src.madnessTables.summary]
          }
        : undefined,
      luckEnabled: src.luckEnabled, // 행운 깎기 사용 여부 복제
      bgm: src.bgm.map((t) => ({ ...t })),
      combat: null,
      channels: new Map(),
      messages: [],
      charRooms: new Map(),
      createdAt: now,
      lastActivityAt: now
    }
    this.rooms.set(id, room)
    this.codeToId.set(code, id)
    void this.flush(room)
    return this.summaryFor(room, accountId)
  }

  /** 세션 채팅 로그 전체 삭제 — 소유자만. 성공 시 true. */
  clearChat(roomId: string, accountId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return false
    room.messages = []
    room.lastActivityAt = Date.now()
    void this.flush(room)
    return true
  }

  participants(room: Room): Participant[] {
    return [...room.participants.values()]
  }

  /** viewer 지정 시 handouts 는 그 사람이 볼 수 있는 것만(없으면 전체 — 테스트/하위호환용). */
  snapshot(room: Room, viewer?: { playerId: string; role: Participant['role'] }): RoomState {
    const { messages, avatarPool } = packAvatars(room.messages) // 채팅 두상 풀 분리 — 스냅샷 크기 절감
    return {
      id: room.id,
      code: room.code,
      title: room.title,
      ownerId: room.ownerId,
      cardImage: room.cardImage,
      participants: this.participants(room),
      characters: [...room.characters.values()],
      messages,
      avatarPool, // 채팅 두상 풀 — 클라가 avatarRef 복원에 사용
      handouts: viewer ? this.handoutsFor(room, viewer) : [...room.handouts.values()],
      maps: [...room.maps.values()].map(toWireMap),
      activeMapId: room.activeMapId,
      appearance: room.appearance,
      cutInImage: room.cutInImage,
      cutInImages: room.cutInImages,
      dimColor: room.dimColor,
      madnessTables: room.madnessTables, // GM 커스텀 광기표
      luckEnabled: room.luckEnabled, // 행운 깎기 사용 여부
      bgm: room.bgm,
      combat: room.combat,
      channels: this.channelsFor(room, viewer),
      charRoomIds: viewer ? (room.charRooms.get(viewer.playerId) ?? []) : [] // 요청자의 이 방 시트 멤버십
    }
  }

  /** 방 시트 멤버십: playerId 의 이 방 charId 목록(없으면 []). */
  roomCharsFor(roomId: string, playerId: string): string[] {
    return this.rooms.get(roomId)?.charRooms.get(playerId) ?? []
  }

  /** 방에 내 시트 추가. 이미 있으면 무시. 갱신된 목록 반환(없으면 undefined). */
  addRoomChar(roomId: string, playerId: string, charId: string): string[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !charId) return undefined
    const cur = room.charRooms.get(playerId) ?? []
    if (!cur.includes(charId)) {
      room.charRooms.set(playerId, [...cur, charId])
      room.lastActivityAt = Date.now()
    }
    return room.charRooms.get(playerId) ?? []
  }

  /** 방에서 내 시트 제거(라이브러리 원본은 유지). 갱신된 목록 반환. */
  removeRoomChar(roomId: string, playerId: string, charId: string): string[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const cur = room.charRooms.get(playerId) ?? []
    room.charRooms.set(
      playerId,
      cur.filter((id) => id !== charId)
    )
    room.lastActivityAt = Date.now()
    return room.charRooms.get(playerId) ?? []
  }

  /** 접속자 없이 maxIdleMs 이상 방치된 방 정리. 정리된 roomId 목록 반환. 영속 모드는 정리 안 함(소유자 삭제만). */
  sweepStale(maxIdleMs: number, now = Date.now()): string[] {
    if (this.persist) return []
    const removed: string[] = []
    for (const room of this.rooms.values()) {
      const anyConnected = [...room.participants.values()].some((p) => p.connected)
      if (!anyConnected && now - room.lastActivityAt > maxIdleMs) {
        this.rooms.delete(room.id)
        this.codeToId.delete(room.code)
        removed.push(room.id)
      }
    }
    return removed
  }

  /** 진단용. */
  get roomCount(): number {
    return this.rooms.size
  }

  /**
   * 관리자 용량 산출 — 한 계정이 소유한 방들의 직렬화 바이트 합 + 참조 자산 해시 집합(방 개수 포함).
   * 직렬화 형식은 디스크 저장(roomToFile)과 동일해 실제 점유와 거의 일치한다.
   */
  usageForOwner(accountId: string): {
    count: number
    bytes: number
    refs: Set<string>
    list: { id: string; title?: string; code: string; bytes: number }[]
  } {
    let bytes = 0
    const refs = new Set<string>()
    const list: { id: string; title?: string; code: string; bytes: number }[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId !== accountId) continue
      try {
        const json = JSON.stringify(roomToFile(room))
        const b = Buffer.byteLength(json, 'utf8')
        bytes += b
        scanAssetRefs(json, refs)
        list.push({ id: room.id, title: room.title, code: room.code, bytes: b })
      } catch {
        /* 직렬화 실패 방어 — 해당 방만 건너뜀 */
      }
    }
    return { count: list.length, bytes, refs, list }
  }

  /**
   * 보유한 전 방에서 참조 중인 'asset:<해시>' 를 into 에 수집(자산 GC 라이브 집합).
   * 인메모리 방이 진실원본 — 디스크 flush 가 지연돼도(자동저장 주기) 최신 참조를 누락하지 않는다.
   */
  collectAssetRefs(into: Set<string>): void {
    for (const room of this.rooms.values()) {
      try {
        scanAssetRefs(JSON.stringify(roomToFile(room)), into)
      } catch {
        /* 직렬화 실패 방어 — 해당 방만 건너뜀 */
      }
    }
  }

  /** 멤버 본인 이전 — 이 계정이 소유한 모든 방을 영속 파일 형태(roomToFile = 전체 장면·채팅)로 내보낸다. */
  exportOwnedBy(accountId: string): Record<string, unknown>[] {
    if (!accountId) return []
    const out: Record<string, unknown>[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId === accountId) out.push(roomToFile(room))
    }
    return out
  }

  /**
   * 멤버 본인 이전(가져오기) — 내보낸 방 파일들을 이 계정 소유로 복원한다. 새 id·고유 코드를 발급하고
   * 소유자·멤버·참가자를 가져오는 계정만으로 재구성한다(옛 참가자 id 는 새 서버에 없으므로 코드로 재입장하게 둠).
   * 장면·채팅 기록은 그대로 보존. 반환=복원된 방 수.
   */
  importOwnedBy(accountId: string, files: unknown, ownerNick: string): number {
    if (!accountId || !Array.isArray(files)) return 0
    let imported = 0
    for (const f of files) {
      if (imported >= 200) break // 안전 상한
      const room = roomFromFile(f)
      if (!room) continue
      const id = randomUUID()
      let code = genCode()
      while (this.codeToId.has(code)) code = genCode()
      room.id = id
      room.code = code
      room.ownerId = accountId
      room.members = new Set([accountId])
      room.participants = new Map<string, Participant>([
        [
          accountId,
          { playerId: accountId, nick: (ownerNick || '탐사자').slice(0, 80), color: DEFAULT_PL_COLOR, role: 'GM', connected: false }
        ]
      ])
      room.charRooms = new Map() // 시트 멤버십은 옛 playerId 기준이라 초기화(소유자가 방에 다시 추가)
      room.lastActivityAt = Date.now()
      this.rooms.set(id, room)
      this.codeToId.set(code, id)
      void this.flush(room) // 즉시 영속
      imported++
    }
    return imported
  }
}
