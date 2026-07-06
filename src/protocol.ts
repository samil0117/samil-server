// 멀티플레이 와이어 프로토콜 (서버 ↔ 클라이언트 단일 계약).
// 클라이언트 미러: src/renderer/src/net/protocol.ts — 이벤트/페이로드 변경 시 양쪽 동기화.
//    ChatMessage 는 렌더러 lib/chat/types.ts 와 동일 구조(클라는 그쪽을 재사용).
import type { DiceResult, SuccessLevel } from './dice/types'

export type ChatChannel = 'main' | 'ooc' | 'whisper' | 'group'
// script = /desc 프로필 없는 꾸미기 스크립트(클라가 아바타·이름 없이 꾸미기 마크업으로 렌더).
// madness = 광기의 발작 카드(클라가 표를 굴려 결과 payload 전송 — 서버는 그대로 중계).
// choice = GM 선택지 버튼 · luck = 행운 성공 전환 결과 카드.
export type MessageKind =
  | 'speech'
  | 'narration'
  | 'dice'
  | 'madness'
  | 'script'
  | 'system'
  | 'choice'
  | 'luck'

/** 광기의 발작(CoC 7판) 굴림 결과 — 렌더러 lib/chat/types 의 MadnessRoll 과 동일 구조(미러). */
export interface MadnessRoll {
  mode: 'realtime' | 'summary'
  /** 실시간 발작의 광기 종류 — 일시적/장기적. 요약은 없음. */
  insanity?: 'temporary' | 'indefinite'
  roll: number
  /** 표 항목 수(1dN 의 N · 표 길이 가변). 없으면 10. */
  sides?: number
  duration: number
  unit: string
  symptom: string
}

/**
 * GM 커스텀 광기표(재구성) — 실시간은 일시적/장기적 두 표, 요약은 한 표.
 * 각 표 항목 수 가변(GM 이 가감). 미설정/빈 표면 클라 기본 7판 표 폴백. GM 설정·전원 동기화.
 */
export interface MadnessTables {
  realtimeTemp: string[]
  realtimeIndef: string[]
  summary: string[]
}

export interface ChatMessage {
  id: string
  time: number // epoch ms
  channel: ChatChannel
  kind: MessageKind
  author?: string
  /** 발화자 playerId (서버 스탬프 · 캐릭터/아바타 매칭용). system 메시지는 없음. */
  playerId?: string
  color?: string
  /** 발화 당시 두상(서버가 발화 정체성 프레즌스에서 각인) — 서버 재시작·새 참가자에도 채팅 두상 보존. */
  avatar?: string
  /** 발화 당시 이름색(서버 각인). */
  nameColor?: string
  /** 두상 풀 인덱스 — 디스크/스냅샷에서만 avatar 대신 사용(중복 제거). 런타임·증분 메시지는 avatar 인라인. */
  avatarRef?: number
  text?: string
  dice?: DiceResult
  /** 광기의 발작 카드(kind='madness'). */
  madness?: MadnessRoll
  to?: string
  /** 그룹 채널 id — channel==='group' 일 때 어느 그룹 채널인지. */
  groupId?: string
  /** 비밀 메시지(GM+본인만). 공유 히스토리에 저장하지 않음. */
  secret?: boolean
  /** GM 1회성 NPC 발화 — 투명 두상으로 렌더(아바타·캐릭터 매칭 없음). */
  npc?: boolean
  /** GM 선택지 버튼(kind='choice') — 브로드캐스트본은 option.script 제거됨. 색은 게시 시 GM 지정. */
  choice?: {
    prompt: string
    options: { id: string; label: string; script?: string }[]
    btnColor?: string
    bgColor?: string
    textColor?: string
    promptColor?: string
  }
  /** 행운 성공 전환 결과 카드(kind='luck'). */
  luck?: { cost: number; remaining: number; command: string }
  /** 수정됨 표시 — 작성자/GM 이 본문을 고치면 true. */
  edited?: boolean
  /** 삭제됨 툼스톤 — GM 이 삭제하면 true(본문 제거, "삭제된 메시지"로 렌더). */
  deleted?: boolean
}

export type Role = 'GM' | 'PL'

/** 방 참가자 (서버 권위). connected=false 면 일시 이탈(재접속 대기). */
export interface Participant {
  playerId: string
  nick: string
  color: string
  role: Role
  connected: boolean
}

/** 시트 공개 범위 (렌더러 lib/coc/types 의 Visibility 와 동일 값). */
export type Visibility = 'public' | 'private' | 'hidden'

/**
 * 멀티플레이로 공유하는 캐릭터 "프레즌스 서브셋" (시트 전체가 아님).
 * 미연시 무대·로스터·채팅 아바타 표시에 필요한 최소 정보만 — 능력치·기능 등은 비공유(본인 로컬).
 * standings(data URL)는 용량이 크므로 입장/변경 시에만 char:update 로 1회 전송,
 * 잦은 표정 전환은 char:expr(인덱스만)로 전송한다.
 */
/** 토큰 위 표시용 캐릭터 수치 (HP/MP/SAN 현재·최대). 본인 시트에서 산출해 프레즌스로 공유. */
export interface TokenStats {
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  san: number
  sanMax: number
  /** 상태 이상 마커 — 본인 시트 status 에서 동기(true 일 때만 전송). */
  majorWound?: boolean
  dying?: boolean
  tempInsane?: boolean
  indefInsane?: boolean
}

/** 프로필 링크(SNS 바이오용) — 라벨 + URL. 클라 protocol 과 미러. */
export interface ProfileLink {
  label: string
  url: string
}

/** 프로필 카드 색 커스텀(SNS 바이오) — 모두 hex(미설정 시 기본). 클라 protocol 과 미러. */
export interface ProfileTheme {
  /** 강조색 — 프사 테두리·헤더 윗 띠·링크 칩. */
  accent?: string
  /** 닉네임 글자색(미설정 시 강조색). */
  nameColor?: string
  /** 자기소개 글자색. */
  bioColor?: string
  /** 카드 전체 배경색(라이트/다크 사용자 고정). */
  bg?: string
}

export interface SharedCharacter {
  playerId: string // 소유자 (서버 권위 스탬프)
  charId: string
  name: string
  color: string
  /** 이름 표시색 — 플레이어 본인이 지정. 핑 색에도 사용. 없으면 테마 기본색. */
  nameColor?: string
  headshot?: string // data URL
  standings: string[] // data URL[]
  /** 스탠딩과 index 연동된 표정별 두상(채팅 아바타). headshots[i] 비면 headshot 폴백. */
  headshots?: string[]
  currentExpression: number
  /** VN 무대 스탠딩 표시 높이(px) — 미설정이면 기본(무대 92%). 캐릭터별 동기화. */
  standingHeight?: number
  visibility: Visibility
  stats?: TokenStats // 토큰 위 HP/MP/SAN 표시용(없으면 미표시)
  /** 계정 자기소개 — 참가자 프로필 팝업 표기용(발화·캐릭터와 무관한 계정 정보). */
  bio?: string
  /** 프로필 배너(헤더 이미지, data URL) — SNS 바이오 카드용. */
  banner?: string
  /** 프로필 링크 목록 — SNS 바이오 카드용. */
  links?: ProfileLink[]
  /** 프로필 카드 색 커스텀. */
  profileTheme?: ProfileTheme
}

/** char:update 요청 — playerId 는 서버가 소켓에서 스탬프(위조 방지)하므로 클라는 제외. */
export type CharUpdateReq = Omit<SharedCharacter, 'playerId'>

/**
 * 계정 영속용 캐릭터 시트 "전체". 서버는 내용을 해석하지 않고 불투명 블롭으로 저장 —
 * 도메인 타입(능력치·기능 등)은 렌더러 lib/coc/types 소유. id 만 보장. 클라 protocol 과 미러.
 */
export interface CharacterRecord {
  id: string
  [key: string]: unknown
}

/** 핸드아웃 공개 범위: private=GM만(비공개 draft) / all=전체 / targeted=특정 유저(비밀 핸드아웃). */
export type HandoutScope = 'private' | 'all' | 'targeted'

/**
 * 핸드아웃(자료) — 방 단위 GM 자료. 이미지는 PNG/GIF/APNG 보존을 위해 원본 data URL 그대로 보관
 * (캐릭터 두상/스탠딩과 달리 WebP 재인코딩하지 않음). 가시성 판정은 서버 권위(canViewHandout).
 */
/** 핸드아웃 메인 이미지 정렬. 없으면 left. */
export type HandoutImageAlign = 'left' | 'center' | 'right'

export interface Handout {
  id: string
  title: string
  body: string
  image?: string // data URL (PNG/GIF/APNG 보존)
  imageAlign?: HandoutImageAlign // 메인 이미지 좌/우/가운데 정렬. 없으면 left.
  tags: string[]
  scope: HandoutScope
  targets: string[] // playerId[] (scope==='targeted' 일 때 대상)
  createdAt: number
  updatedAt: number
}

/** handout:upsert 요청 (GM 전용). id 없으면 신규 생성, 있으면 갱신. */
export interface HandoutUpsertReq {
  id?: string
  title: string
  body: string
  image?: string
  imageAlign?: HandoutImageAlign
  tags?: string[]
  scope: HandoutScope
  targets?: string[]
}

/** 토큰/오브젝트 레이어. bg=배경 소품(그리드 아래) · token=캐릭터/NPC 토큰 · standing=전경 스탠딩(토큰 위). */
export type TokenLayer = 'bg' | 'token' | 'standing'

/** z순서 조정 연산. 같은 레이어 안에서 한 칸 앞/뒤(forward/backward) 또는 맨앞/맨뒤(front/back). */
export type TokenZOp = 'front' | 'back' | 'forward' | 'backward'

/**
 * 맵 토큰/오브젝트. 위치는 월드 좌표(px). 캐릭터 토큰이면 charPlayerId 로 roster 의 두상/수치/색/이동권한을
 * 참조하고, 없으면 NPC 토큰·이미지 오브젝트(label/color/image 직접 보관). size 는 그리드 칸 배수(1=1칸).
 * layer=렌더 레이어(기본 token), z=레이어 내 정렬 순서(클수록 앞 · 서버 권위).
 */
export interface Token {
  id: string
  x: number
  y: number
  size: number
  /** 회전 각도(라디안). GM·소유 PL 이 회전 가능(token:rotate). 기본 0. */
  rotation?: number
  charPlayerId?: string
  label?: string
  color?: string
  image?: string // data URL (NPC 토큰·이미지 오브젝트)
  layer?: TokenLayer
  z?: number
  /** 좌우 반전(이미지 토큰 미러 · /). 기본 false. */
  flipX?: boolean
  /** 이름표 숨김(GM 전용 토글·전원 동기화). true 면 토큰 이름 미표시. */
  hideName?: boolean
  /** UI(HP/MP/SAN 바·상태 마커) 숨김(GM 전용 토글·전원 동기화). true 면 미표시. */
  hideUI?: boolean
  /** 이동/회전 권한을 부여받은 playerId 목록(GM 지정). 이 목록의 PL 은 GM 처럼 이동·회전 가능(이미지 토큰 포함). */
  allowedPlayers?: string[]
  /** 이미지 카드: 등록된 이미지 목록(asset:ref 또는 data URL). 비면 단일 image 토큰. */
  images?: string[]
  /** 이미지 카드에서 현재 표시 중인 images 인덱스(기본 0). */
  currentIndex?: number
}

/** token:upsert 요청 (GM 전용). id 없으면 신규 생성. mapId=대상 맵. layer=배치 레이어(이미지 오브젝트). */
export interface TokenUpsertReq {
  mapId: string
  id?: string
  x: number
  y: number
  size?: number
  rotation?: number
  charPlayerId?: string
  label?: string
  color?: string
  image?: string
  layer?: TokenLayer
  flipX?: boolean
  hideName?: boolean
  hideUI?: boolean
  allowedPlayers?: string[]
  images?: string[]
  currentIndex?: number
}

/** token:move 요청 (GM 또는 토큰 소유 PL). 잦은 이벤트 → 위치만 전송. mapId=대상 맵. */
export interface TokenMoveReq {
  mapId: string
  id: string
  x: number
  y: number
}

/** token:rotate 요청 (GM 또는 토큰 소유 PL · 이동과 동일 권한). rotation=라디안. mapId=대상 맵. */
export interface TokenRotateReq {
  mapId: string
  id: string
  rotation: number
}

/** token:reorder 요청 (GM 전용). op=z순서 조정, layer=레이어 이동(지정 시 그 레이어 맨 앞으로). mapId=대상 맵. */
export interface TokenReorderReq {
  mapId: string
  id: string
  op?: TokenZOp
  layer?: TokenLayer
}

/** token:imageindex 요청 (GM 또는 토큰 소유 PL · 이동과 동일 권한). 이미지 카드의 표시 이미지 전환. index=images 인덱스. */
export interface TokenImageIndexReq {
  mapId: string
  id: string
  index: number
}

/** 방 배경(맵별 단일 배경). 이미지는 라이브러리 자산 원본 data URL. */
export interface MapBackground {
  image?: string
  w: number // 배경 자연 크기(px) — 그리드/배치 기준
  h: number
}

/** 맵 그리드 설정(맵 단위, GM 제어). size=셀 한 변(월드 px, 토큰 size 1=1셀), visible=선 표시. */
export interface GridConfig {
  size: number
  visible: boolean
}

/**
 * 자유 드로잉 한 획. points=월드 좌표 평탄 배열 [x0,y0,x1,y1,...].
 * playerId/color=작성자(서버 스탬프), width=선 두께(월드 px). 맵별 세션 보관.
 */
export interface Stroke {
  id: string
  playerId: string
  color: string
  width: number
  points: number[]
}

/** map:draw 요청 — 새 획. id 는 클라 생성(낙관 반영·서버 에코 멱등), color/playerId 는 서버 스탬프. */
export interface DrawReq {
  mapId: string
  id: string
  points: number[]
  width?: number
  /** 그리기 색 — 없으면 서버가 참가자색으로 스탬프. */
  color?: string
}

/**
 * 맵 텍스트 라벨(자유 텍스트). 위치는 월드 좌표(px). playerId=작성자(서버 스탬프).
 * GM 은 모든 텍스트, PL 은 본인 텍스트만 편집·이동·삭제. 맵별 세션 보관(드로잉과 동일).
 */
export interface MapText {
  id: string
  playerId: string
  x: number
  y: number
  text: string
  color: string
  size: number
  bold?: boolean
}

/** map:text 요청 — 신규(ID 없음=서버 생성) 또는 편집. playerId 는 서버 스탬프(편집은 작성자/GM 만). */
export interface MapTextUpsertReq {
  mapId: string
  id?: string
  x: number
  y: number
  text: string
  color?: string
  size?: number
  bold?: boolean
}

/** 비주얼 노벨 무대 레이어 — vnBackground(맨 뒤) 위에 층층이 쌓는 이미지. z 작을수록 뒤. */
export interface VnLayer {
  id: string
  image: string // data URL
  z: number
  opacity?: number // 0~1 (기본 1)
  fit?: 'cover' | 'contain' // cover=화면 꽉 채움(기본·배경처럼) · contain=비율 맞춤(여백)
  front?: boolean // true=스탠딩 앞(오버레이 — 비/플레어 효과), 기본 false=스탠딩 뒤
}

/** 맵(씬) 1개 — 자체 배경·그리드·토큰·드로잉 보유. 방은 여러 맵 + 활성 맵 1개. */
export interface GameMap {
  id: string
  name: string
  background: MapBackground | null
  grid: GridConfig
  tokens: Token[]
  /** 자유 드로잉 획(맵별 세션 보관). */
  drawings: Stroke[]
  /** 맵 텍스트 라벨(맵별 세션 보관). */
  texts: MapText[]
  /** 비주얼 노벨 무대 배경 이미지(data URL) — 맵(씬)별. 전술 맵 배경과 별개. GM이 우클릭으로 설정. */
  vnBackground?: string
  /** 비주얼 노벨 무대 레이어 스택 — vnBackground 위에 z순으로 쌓임. GM 설정·전원 동기화. */
  vnLayers?: VnLayer[]
  /** 맵 배경 단색(여백 전체 포함) — 캔버스 전체를 이 색으로 채움. hex. 없으면 투명(앱 배경). */
  bgColor?: string
}

/**
 * 방 외형(테마·다이스 컷인) — 방 GM 이 전원에 강제(동기화). 방 단위 보관·스냅샷 포함.
 * accent/diceStyle 은 와이어에선 문자열(렌더러 union 과 디커플) — 서버가 허용값으로 검증·정규화.
 */
export interface Appearance {
  theme: 'dark' | 'light'
  accent: string
  uiAccent: string // 직접 강조색 hex ('' = accent 프리셋)
  diceStyle: string
}

/** BGM 음원 종류. file=업로드 오디오, youtube=유튜브 영상. */
export type BgmKind = 'file' | 'youtube'

/**
 * 방 BGM 재생 상태 — GM 이 제어, 전원 동기화. 방 단위 보관·스냅샷 포함.
 * src 는 file 이면 오디오 data URL, youtube 면 영상 id. 볼륨/음소거는 클라 개인(비공유).
 * 트랙 변경(소스 포함)은 bgm:state, 재생/정지·반복 토글은 경량 bgm:control 로 송출.
 * 클라 protocol 과 미러.
 */
export interface BgmState {
  trackId: string // GM 라이브러리 트랙 식별(멱등)
  kind: BgmKind
  src: string // file: 오디오 data URL · youtube: 영상 id
  title: string
  loop: boolean
  playing: boolean
  /** 트랙 믹스 볼륨(0~1 · GM 설정·동기화). 개인 마스터 볼륨과 곱해 최종 볼륨. */
  volume: number
}

/** 전투 참가자(이니셔티브). initiative 내림차순 정렬 · charPlayerId 있으면 roster 두상/색/HP 참조. */
export interface Combatant {
  id: string
  name: string
  initiative: number
  charPlayerId?: string
  hp?: number // 수동 추적(주로 NPC)
  hpMax?: number
}

/** 방 전투 상태 — GM 권위·전원 동기화. null=전투 없음. 클라 protocol 과 미러. */
export interface CombatState {
  round: number // 1부터
  turn: number // initiative 정렬 순서의 현재 턴 인덱스
  combatants: Combatant[]
}

/**
 * 그룹 채널(GM 개설) — members(+GM)에게만 보이고 전달됨. 채널 자체는 영속,
 * 메시지는 휘발(귓속말처럼 공유 히스토리 미저장). 클라 protocol 과 미러.
 */
export interface Channel {
  id: string
  name: string
  members: string[] // playerId[] (GM 은 항상 접근)
}

/** 방 전체 스냅샷 (입장/재접속 ack 로 전달). handouts 는 요청자 기준으로 필터링됨. */
export interface RoomState {
  id: string
  code: string
  /** 세션방 이름·소유자 계정·카드 이미지(서버 영속 메타). */
  title: string
  ownerId: string
  cardImage?: string
  participants: Participant[]
  characters: SharedCharacter[]
  messages: ChatMessage[]
  handouts: Handout[]
  /** 방의 모든 맵(씬). */
  maps: GameMap[]
  /** 전원이 보는 활성 맵 id. */
  activeMapId: string
  /** 방 외형(방 GM 강제 테마·다이스 카드). 입장 시 클라가 적용. */
  appearance: Appearance
  /** 방 BGM 트랙들(GM 제어·전원 동기화). 빈 배열=정지/없음. 최대 5개 동시재생. 입장 시 클라가 적용. */
  bgm: BgmState[]
  /** 방 전투 상태(GM 제어·전원 동기화). null=전투 없음. */
  combat: CombatState | null
  /** 그룹 채널 목록 — 수신자가 멤버이거나 GM 인 채널만 필터링됨. */
  channels: Channel[]
  /** 방 주사위 컷인 이미지(data URL · GM 설정 · 전원 동일) — 레벨별 컷인 미설정 시 공통 폴백. */
  cutInImage?: string
  /** 성공 단계별 주사위 컷인 — 굴림 결과 단계에 맞는 컷인을 우선 표시. 미설정 단계는 cutInImage 폴백. */
  cutInImages?: Partial<Record<SuccessLevel, string>>
  /** ~문장~ 행동지문 색(GM 설정·전원 동기화). 빈값이면 글자색 따름(mk-dim-color CSS 변수). */
  dimColor?: string
  /** 요청자의 이 방 캐릭터 시트 멤버십 — 이 charId 들만 방에서 보임(라이브러리에서 가져온 것). */
  charRoomIds: string[]
  /** GM 커스텀 광기표 — 미설정이면 클라 기본 7판 표 사용. 전원 동기화. */
  madnessTables?: MadnessTables
  /** 행운 깎기(CoC7 하우스룰) 사용 여부 — GM 토글·전원 동기화. 미설정/true=사용, false=비활성. */
  luckEnabled?: boolean
  /** 채팅 두상 풀 — messages 의 avatarRef 가 가리키는 두상 data URL 목록(스냅샷 크기 절감). */
  avatarPool?: string[]
}

/** 세션 목록 항목(room:list). 카드·메타만 — 장면/채팅 본문은 입장 시 스냅샷으로. 클라 protocol 과 미러. */
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

/** create/join 성공 시 본인 + 방 스냅샷. */
export interface JoinedRoom {
  self: Participant
  room: RoomState
}

/**
 * 방 불러오기 요청(GM 전용) — .orpg 스냅샷의 "장면" 부분을 방에 적용.
 * 참가자·채팅 로그는 라이브 상태라 복원하지 않음(맵·자료·외형·BGM 만). 클라 protocol 과 미러.
 */
export interface RoomLoadReq {
  maps: GameMap[]
  activeMapId: string
  handouts: Handout[]
  appearance: Appearance
  bgm: BgmState[]
}

/** ack 콜백 공통 형태. */
export type Ack<T> = (res: AckResult<T>) => void
export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface CreateRoomReq {
  nick: string
  color: string
  /** 세션방 이름·카드 이미지(서버 영속 메타, 선택). */
  title?: string
  cardImage?: string
}
export interface JoinRoomReq {
  code: string
  nick: string
  color: string
}
export interface ChatSendReq {
  channel: ChatChannel
  text: string
  narration?: boolean
  to?: string // 귓속말 대상 playerId (서버가 대상에게만 전달)
  groupId?: string // 그룹 채널 id (channel==='group' — 서버가 멤버에게만 전달)
  secret?: boolean // 비밀 굴림/메시지 (GM+본인만)
  script?: boolean // /desc 프로필 없는 꾸미기 스크립트(kind='script', 주사위 파싱 안 함)
  npcName?: string // GM 1회성 NPC 이름 — GM 이고 비어있지 않으면 author 로 스탬프(투명 두상). PL 은 무시.
}

/**
 * 클라가 굴린 결과(시트 주사위/광기 등)를 그대로 중계 요청 — chat:send 와 달리 서버가 재굴림하지 않고
 * dice/madness payload 를 신뢰해 그대로 브로드캐스트한다(라벨·광기표 등 서버가 재현 못하는 결과 보존).
 * author/color/playerId 는 서버가 정체성으로 스탬프(위조 방지). 라우팅·히스토리 규칙은 chat:send 와 동일.
 */
export interface ChatRollReq {
  channel: ChatChannel
  kind: 'dice' | 'madness'
  dice?: DiceResult
  madness?: MadnessRoll
  to?: string
  groupId?: string
  secret?: boolean
}

/** 핸드셰이크 시 socket.handshake.auth 로 전달. */
export interface HandshakeAuth {
  /** 세션 토큰(계정 인증). requireAuth 모드에선 필수 — 없거나 무효면 연결 거부. */
  token?: string
  /** 재접속 식별 playerId(비인증 레거시/테스트 경로). 인증 시엔 서버가 account.id 로 대체. */
  playerId?: string
}

export interface ClientToServerEvents {
  'room:create': (req: CreateRoomReq, ack: Ack<JoinedRoom>) => void
  'room:join': (req: JoinRoomReq, ack: Ack<JoinedRoom>) => void
  'room:leave': () => void
  // 세션방 목록·관리 (서버 영속, 인증 계정 기준). setMeta/delete/duplicate/clearChat=소유자만(서버 검증).
  'room:list': (ack: Ack<RoomSummary[]>) => void
  'room:enter': (req: { roomId: string; nick: string; color: string }, ack: Ack<JoinedRoom>) => void
  'room:setMeta': (req: { roomId: string; title?: string; cardImage?: string | null }, ack: Ack<RoomSummary>) => void
  'room:delete': (req: { roomId: string }, ack: Ack<{ id: string }>) => void
  'room:duplicate': (req: { roomId: string }, ack: Ack<RoomSummary>) => void
  'room:clearChat': (req: { roomId: string }, ack: Ack<{ id: string }>) => void
  'chat:send': (req: ChatSendReq) => void
  // 클라가 굴린 결과(시트 주사위·광기) 중계 — 서버가 정체성 스탬프·라우팅·히스토리·브로드캐스트.
  'chat:roll': (req: ChatRollReq) => void
  // 행운 성공 전환 안내 — 서버가 정체성 스탬프 후 kind='luck' 카드로 브로드캐스트(공개·히스토리).
  'chat:luck': (req: { channel: ChatChannel; cost: number; remaining: number; command: string }) => void
  // GM 선택지 — 채팅에 버튼 선택지 게시. 서버는 옵션 스크립트를 숨기고 라벨만 브로드캐스트. 색은 그대로 전달.
  'chat:choice': (req: {
    prompt: string
    options: { id: string; label: string; script?: string }[]
    btnColor?: string
    bgColor?: string
    textColor?: string
    promptColor?: string
  }) => void
  // 플레이어가 선택지 버튼 클릭 — 1회만. 서버: GM 비공개 통지 +(스크립트 있으면)본인 출력 + choice:locked.
  'choice:select': (req: { messageId: string; optionId: string }) => void
  // 보낸 채팅 수정/삭제. 수정=작성자 본인 또는 GM(텍스트 메시지만), 삭제=GM 만. 서버가 검증 후 브로드캐스트.
  'chat:edit': (req: { id: string; text: string }) => void
  'chat:delete': (req: { id: string }) => void
  // 입력 중 표시(휘발) — 타이핑 시작/정지를 방 전체에 알림(저장 안 함). channel/groupId 로 어느 탭에서 치는지 전달.
  'chat:typing': (req: { typing: boolean; channel?: ChatChannel; groupId?: string }) => void
  // 캐릭터 프레즌스 공유. playerId 는 서버가 스탬프.
  'char:update': (req: CharUpdateReq) => void
  'char:expr': (req: { index: number }) => void
  // 캐릭터 시트 영속 (인증 계정 전용). 시트 전체를 계정에 저장/삭제.
  'char:save': (req: CharacterRecord) => void
  'char:delete': (req: { id: string }) => void
  // 방별 시트 멤버십 — 내 라이브러리 시트를 이 방에 추가/제거. 서버가 charRooms 영속 + room:char:list 응답.
  'room:char:add': (req: { charId: string }) => void
  'room:char:remove': (req: { charId: string }) => void
  // GM 시트 지급 — record 를 대상 플레이어 계정으로 복사 저장 + 그 방 멤버십에 추가.
  'room:char:grant': (req: { targetPlayerId: string; record: CharacterRecord }) => void
  // GM 시트 지급 취소·빼앗기 — 대상 플레이어의 계정·방에서 해당 시트를 회수(삭제).
  'room:char:revoke': (req: { targetPlayerId: string; charId: string }) => void
  // GM 전용 시트 열람: 같은 방 참가자의 전체 시트를 읽기전용으로 요청. 서버가 GM·동일 방 검증 후 sheet:data 응답.
  'sheet:request': (req: { playerId: string }) => void
  // GM 전용 시트 편집: 대상 참가자 시트를 GM 이 수정. 서버가 GM·동일 방 검증 후 대상 계정에 저장 + sheet:push 로 대상에 반영.
  'sheet:edit': (req: { targetPlayerId: string; character: CharacterRecord }) => void
  // 추방 (GM 전용).
  'room:kick': (req: { playerId: string }) => void
  // 외형: 방 GM 이 방의 테마·다이스 카드를 전원에 강제. 서버가 방 GM 검증·정규화.
  'room:appearance': (req: Appearance) => void
  // 방 주사위 컷인 (GM 전용): level 지정 시 그 성공 단계 컷인, 없으면 공통 컷인. image 없으면 해제. 전원 동기화.
  'room:cutin': (req: { image?: string; level?: SuccessLevel }) => void
  // GM 전용: 맵/비주얼노벨 탭 + (있으면)지정 맵으로 강제 이동. targets 지정 시 그 플레이어들만.
  'room:view': (req: { view: 'map' | 'vn'; mapId?: string; targets?: string[] }) => void
  // 각 클라가 현재 보는 맵/뷰를 서버에 보고 — GM 위치 표시용. 서버는 GM 에게만 room:positions 로 집계 전달.
  'room:where': (req: { mapId: string; view: 'map' | 'vn' }) => void
  // GM 전용: ~문장~ 행동지문 색 설정/해제(빈값=해제). 전원 동기화.
  'room:dim': (req: { color?: string }) => void
  'room:luck': (req: { enabled: boolean }) => void
  // GM 커스텀 광기표 설정(GM 전용) — 서버 정규화 후 전원 동기화.
  'room:madness': (req: MadnessTables) => void
  // BGM (다중, GM 전용). set=트랙 추가/로드(소스 포함·최대 5), control=해당 트랙 재생/반복/볼륨 토글, clear=한 트랙(trackId) 또는 전체 정지.
  'bgm:set': (req: {
    trackId: string
    kind: BgmKind
    src: string
    title: string
    loop: boolean
    volume?: number
  }) => void
  'bgm:control': (req: { trackId: string; playing?: boolean; loop?: boolean; volume?: number }) => void
  'bgm:clear': (req?: { trackId?: string }) => void
  // 전체 트랙을 권위적으로 교체 — '나만 듣기'→'전체 동기화' 전환 시 GM 로컬 트랙으로 방을 정확히 맞춰 혼선 제거.
  'bgm:replace': (req: { tracks: BgmState[] }) => void
  // BGM 시크 (GM 전용). 재생 위치(초)를 전원에게 점프 명령. 위치는 비영속(transient broadcast).
  'bgm:seek': (req: { trackId: string; position: number }) => void
  // 전투 (GM 전용). 전체 상태 교체(시작·턴진행·HP·종료=null). 서버가 GM 검증·정규화 후 전원 동기화.
  'combat:set': (state: CombatState | null) => void
  // 그룹 채널 (GM 전용). create=개설(이름+멤버), remove=삭제. 서버가 멤버 기준 채널 목록 동기화.
  'channel:create': (req: { name: string; members: string[] }) => void
  'channel:remove': (req: { id: string }) => void
  // 방 불러오기 (GM 전용). 서버가 검증·적용 후 전원에 room:sync 풀 재싱크.
  'room:load': (req: RoomLoadReq) => void
  // 핸드아웃 (GM 전용). 소유/권한은 서버가 검증.
  'handout:upsert': (req: HandoutUpsertReq) => void
  'handout:delete': (req: { id: string }) => void
  'handout:focus': (req: { id: string }) => void
  // 맵·토큰 . 맵 관리·배경·그리드·배치·삭제는 GM, 이동은 GM 또는 토큰 소유 PL — 서버 검증.
  'map:create': (req: { name?: string }) => void
  'map:delete': (req: { mapId: string }) => void
  'map:rename': (req: { mapId: string; name: string }) => void
  'map:activate': (req: { mapId: string }) => void
  'map:background': (req: { mapId: string; bg: MapBackground | null }) => void
  /** 비주얼 노벨 무대 배경 설정/해제 (GM 전용). image 없으면 해제. */
  'map:vnbg': (req: { mapId: string; image?: string }) => void
  /** 비주얼 노벨 무대 레이어 스택 전체 교체 (GM 전용). */
  'map:vnlayers': (req: { mapId: string; layers: VnLayer[] }) => void
  /** 맵 배경 단색 설정/해제 (GM 전용 · 여백 전체). color 없으면 해제(투명). */
  'map:bgcolor': (req: { mapId: string; color?: string }) => void
  'map:grid': (req: { mapId: string; grid: GridConfig }) => void
  'token:upsert': (req: TokenUpsertReq) => void
  'token:move': (req: TokenMoveReq) => void
  'token:rotate': (req: TokenRotateReq) => void
  'token:imageindex': (req: TokenImageIndexReq) => void
  'token:remove': (req: { mapId: string; id: string }) => void
  'token:reorder': (req: TokenReorderReq) => void
  // 자유 드로잉·핑 . 그리기=전원, 지우개=작성자/GM, 전체 지우기=GM, 핑=전원(휘발).
  'map:draw': (req: DrawReq) => void
  'map:draw:erase': (req: { mapId: string; strokeId: string }) => void
  'map:draw:clear': (req: { mapId: string }) => void
  // 맵 텍스트 . 생성=전원, 편집/이동/삭제=작성자/GM, 전체 지우기=GM — 서버 검증.
  'map:text': (req: MapTextUpsertReq) => void
  'map:text:move': (req: { mapId: string; id: string; x: number; y: number }) => void
  'map:text:remove': (req: { mapId: string; id: string }) => void
  'map:text:clear': (req: { mapId: string }) => void
  'map:ping': (req: { mapId: string; x: number; y: number; color?: string }) => void
}

/** DM(유저 간 다이렉트 메시지) 1건. from/to=userId(=계정 id). */
export interface DmMessage {
  id: string
  from: string
  to: string
  text: string
  createdAt: number
}

export interface ServerToClientEvents {
  'room:participants': (participants: Participant[]) => void
  'chat:new': (message: ChatMessage) => void
  // 채팅 수정/삭제 브로드캐스트 — 대상자(공개 히스토리 수신자 전체)에게 반영.
  'chat:edited': (req: { id: string; text: string }) => void
  'chat:deleted': (req: { id: string }) => void
  // 채팅 로그 전체 비움(소유자가 세션 채팅 삭제 시 입장 중인 클라가 로컬 채팅도 비움).
  'chat:clear': () => void
  // 입력 중 표시(휘발) — 발신자 제외 방 전체에 브로드캐스트. playerId 서버 스탬프. channel/groupId 로 탭별 분리.
  'chat:typing': (req: { playerId: string; typing: boolean; channel: ChatChannel; groupId?: string }) => void
  // ===== DM(유저 간 다이렉트 메시지) =====
  // 새 DM 도착 — 발신자·수신자 양쪽 개인룸으로(HTTP /dm/send 가 트리거).
  'dm:new': (message: DmMessage) => void
  // DM 수정/삭제 — 발신자·수신자 양쪽 개인룸으로(HTTP /dm/edit·/dm/delete 가 트리거).
  'dm:edited': (message: DmMessage) => void
  'dm:deleted': (req: { id: string; from: string; to: string }) => void
  // DM 대화 개인 삭제 — 지운 사용자의 개인룸으로만(여러 세션 동기화용. 상대에겐 보내지 않음).
  'dm:cleared': (req: { peer: string; by: string }) => void
  // 상대 온라인/오프라인 전환(전체 브로드캐스트).
  'dm:presence': (req: { userId: string; online: boolean }) => void
  // 접속 직후 현재 온라인 사용자 목록(접속자에게만).
  'dm:presence:init': (req: { online: string[] }) => void
  // 관리자가 등급을 바꾸면 대상 사용자의 접속 세션에 즉시 푸시(재로그인 없이 권한 반영).
  'role:changed': (req: { role: 'admin' | 'member' | 'guest' }) => void
  // 친구 신청/수락/거절/끊기 발생 시 대상에게 목록 재조회 신호(페이로드 없음).
  'friend:update': () => void
  // 캐릭터 프레즌스 브로드캐스트.
  'char:state': (char: SharedCharacter) => void
  'char:expr': (msg: { playerId: string; index: number }) => void
  // 캐릭터 시트 영속 : 계정의 전체 캐릭터 목록(연결 시 + 변경 시 계정 룸에 동기화).
  'char:library': (chars: CharacterRecord[]) => void
  // 관리자가 그 계정의 캐릭터를 전부 삭제 — 클라는 로컬 라이브러리를 비운다(빈 char:library 의 '시드 재업로드'와 구분).
  'char:wiped': () => void
  // 방별 시트 멤버십 갱신 — 해당 playerId 에게 그 방의 charId 목록 전달(본인 화면 필터 갱신).
  'room:char:list': (req: { playerId: string; charIds: string[] }) => void
  // GM 전용 시트 열람: 요청 GM 에게만 대상 참가자의 전체 캐릭터 시트 목록 전달.
  'sheet:data': (req: { playerId: string; characters: CharacterRecord[] }) => void
  // GM 시트 편집 결과를 대상 본인에게 푸시 — 대상 클라가 자기 캐릭터 레코드를 병합.
  'sheet:push': (req: { character: CharacterRecord }) => void
  // 선택지 응답 잠금 — 응답한 본인에게만: 그 선택지 메시지의 버튼을 잠그고 고른 옵션 표시.
  'choice:locked': (req: { messageId: string; optionId: string }) => void
  // 초대 코드 재발급 통지 (추방 시 남은 인원에게).
  'room:code': (code: string) => void
  'room:closed': (reason: string) => void
  // 외형 브로드캐스트: 방 GM 변경 시 방 전체에 강제 적용.
  'room:appearance': (ap: Appearance) => void
  // 방 주사위 컷인 브로드캐스트 : GM 설정 시 전원에 동기화(level=성공 단계, 없으면 공통).
  'room:cutin': (req: { image?: string; level?: SuccessLevel }) => void
  // GM 화면 강제 이동 브로드캐스트 : 맵/비주얼노벨 탭 + (있으면)그 맵으로 전환(대상=전원 또는 지정 인원).
  'room:view': (req: { view: 'map' | 'vn'; mapId?: string }) => void
  // 각 플레이어의 현재 맵 위치·뷰 집계 — GM 에게만 전달. positions[playerId]=mapId, views[playerId]=map|vn.
  'room:positions': (req: { positions: Record<string, string>; views?: Record<string, 'map' | 'vn'> }) => void
  // ~문장~ 행동지문 색 브로드캐스트 : GM 설정 시 전원 동기화(빈값=해제).
  'room:dim': (req: { color?: string }) => void
  'room:luck': (req: { enabled: boolean }) => void
  // GM 커스텀 광기표 브로드캐스트 .
  'room:madness': (req: MadnessTables) => void
  // BGM 브로드캐스트 (다중). state=트랙 목록 전체(소스 포함·추가/제거 시), control=경량 트랙 토글(재생/반복/볼륨).
  'bgm:state': (tracks: BgmState[]) => void
  'bgm:control': (req: { trackId: string; playing: boolean; loop: boolean; volume: number }) => void
  // BGM 시크 브로드캐스트 (GM 전용). 전원의 오디오를 지정 위치(초)로 점프 — 위치는 저장 안 함(transient).
  'bgm:seek': (req: { trackId: string; position: number }) => void
  // 전투 브로드캐스트 . GM 변경 시 전원에 동기화. null=전투 종료.
  'combat:state': (state: CombatState | null) => void
  // 그룹 채널 목록 . 수신자가 멤버이거나 GM 인 채널만(개설/삭제 시 갱신).
  'channel:list': (channels: Channel[]) => void
  // 방 불러오기 풀 재싱크 . 적용된 방 스냅샷(핸드아웃은 수신자 기준 필터).
  'room:sync': (room: RoomState) => void
  // 핸드아웃 브로드캐스트 (대상 필터링됨). focus = 강제 포커스(대상 화면에 모달 자동 오픈).
  'handout:state': (handout: Handout) => void
  'handout:remove': (req: { id: string }) => void
  'handout:focus': (req: { id: string }) => void
  // 맵·토큰 브로드캐스트 (방 전체). 콘텐츠는 mapId 로 대상 맵 명시.
  'map:added': (map: GameMap) => void
  'map:removed': (req: { mapId: string }) => void
  'map:renamed': (req: { mapId: string; name: string }) => void
  'map:active': (req: { mapId: string }) => void
  'map:background': (req: { mapId: string; bg: MapBackground | null }) => void
  'map:vnbg': (req: { mapId: string; image?: string }) => void
  'map:vnlayers': (req: { mapId: string; layers: VnLayer[] }) => void
  'map:bgcolor': (req: { mapId: string; color?: string }) => void
  'map:grid': (req: { mapId: string; grid: GridConfig }) => void
  'token:state': (req: { mapId: string; token: Token }) => void
  'token:move': (req: TokenMoveReq) => void
  'token:rotate': (req: TokenRotateReq) => void
  'token:imageindex': (req: TokenImageIndexReq) => void
  'token:remove': (req: { mapId: string; id: string }) => void
  // 자유 드로잉·핑 브로드캐스트 . draw=새 획(서버 스탬프), ping=휘발(저장 안 함).
  'map:draw': (req: { mapId: string; stroke: Stroke }) => void
  'map:draw:erase': (req: { mapId: string; strokeId: string }) => void
  'map:draw:clear': (req: { mapId: string }) => void
  // 맵 텍스트 브로드캐스트 . state=신규/편집(서버 스탬프), move=이동, remove=삭제, clear=전체 지우기.
  'map:text:state': (req: { mapId: string; text: MapText }) => void
  'map:text:move': (req: { mapId: string; id: string; x: number; y: number }) => void
  'map:text:remove': (req: { mapId: string; id: string }) => void
  'map:text:clear': (req: { mapId: string }) => void
  'map:ping': (req: { mapId: string; x: number; y: number; playerId: string; color: string }) => void
}

/** 소켓별 서버 보관 데이터. */
export interface SocketData {
  playerId: string
  roomId?: string
  /** 인증된 계정(비인증 레거시/테스트면 없음). 전역 등급 admin/member/guest. */
  account?: { id: string; username: string; role: 'admin' | 'member' | 'guest' }
}
