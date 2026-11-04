import type { BedrockCube } from "../electron/cosmetics/geometry"

export type Unsubscribe = () => void

type CurseForgeFailureCode =
  | 'missing-key'
  | 'invalid-key'
  | 'rate-limited'
  | 'http'
  | 'network'

interface CurseForgeFailureReply {
  error: string
  code: CurseForgeFailureCode
  status?: number
  detail?: string
}

interface CurseForgeSearchHit {
  id: number
  classId?: number
  name: string
  slug?: string
  summary?: string
  downloadCount?: number
  rating?: number
  dateCreated?: string
  dateModified?: string
  logo?: { url?: string } | null
  authors?: Array<{ name?: string }>
  categories?: Array<string | { slug?: string; name?: string }>
  latestFiles?: Array<{ gameVersions?: string[] }>
}

type CurseForgeSearchReply =
  | { data: CurseForgeSearchHit[]; pagination: { totalCount: number } }
  | CurseForgeFailureReply

interface CurseForgeProjectReply {
  id?: number
  name?: string
  slug?: string
  summary?: string
  downloadCount?: number
  logo?: { url?: string } | null
  authors?: Array<{ name?: string }>
  fullDescription?: string
  description?: string
}

type CurseForgeProjectResult = CurseForgeProjectReply | CurseForgeFailureReply

interface CurseForgeFileEntry {
  id: number
  displayName?: string
  fileName?: string
  fileDate?: string
  gameVersions?: string[]
  modLoader?: number
  downloadUrl?: string | null
}

type CurseForgeFilesResult = CurseForgeFileEntry[] | CurseForgeFailureReply

export type LogCrashRuleId =
  | 'java-too-old'
  | 'legacy-on-modern-jvm'
  | 'missing-dependency-forge'
  | 'missing-dependency-fabric'
  | 'duplicate-mod'
  | 'mod-resolution-failed'
  | 'mixin-apply-failed'
  | 'out-of-memory'
  | 'graphics-driver'
  | 'corrupt-jar'
  | 'no-class-def'

export type LogReasonCode =
  | `crash.rule-${LogCrashRuleId}`
  | 'crash.no-signal'
  | 'crash.report-stale'
  | 'crash.report-only'
  | 'crash.confidence-low'

export type LogFixAction =
  | { id: string; kind: 'switch-java'; major: number; reason: LogReasonCode }
  | { id: string; kind: 'raise-heap'; toMb: number }
  | { id: string; kind: 'disable-mod'; jar: string; targetDir: string }
  | { id: string; kind: 'install-dependency'; modId: string; versionRange?: string; projectHint?: string }
  | { id: string; kind: 'open-path'; path: string }
  | { id: string; kind: 'open-url'; url: string }

export interface LogAnalysisFinding {
  ruleId: LogCrashRuleId
  confidence: 'certain' | 'likely' | 'possible'
  title: string
  detail: string
  evidence: string[]
  actions: LogFixAction[]
}

export interface LogAnalysisResult {
  id: string
  instanceId: string
  launchId?: string
  truncated: boolean
  findings: LogAnalysisFinding[]
  reasons: LogReasonCode[]
  anchorHits?: number
}

export type LogFixResult =
  | { ok: true; changed: string[]; undoToken?: string; requiresRestart: boolean }
  | { ok: false; code: 'EACCES' | 'ENOENT' | 'LOCKED' | 'INVALID'; message: string }

export interface CoreInstanceRecord {
  id: string
  name: string
  folderName: string
  path: string
  version: string
  loader: string
  loaderVersion: string
  javaPath: string
  minMemory: number
  maxMemory: number
  managed?: boolean
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export interface InstanceLaunchSettingsPatch {
  javaPath?: string
  javaMode?: 'auto' | 'pinned'
  maxMemory?: number
  memoryMode?: 'auto' | 'explicit'
  extraJvmArgs?: string[]
  resolution?: { width: number; height: number } | null
}

export interface InstanceFileRecord {
  id: string
  name: string
  version: string
  loader: string
  loaderVersion: string
  javaPath: string
  javaMode?: 'auto' | 'pinned'
  minMemory: number
  maxMemory: number
  memoryMode?: 'auto' | 'explicit'
  extraJvmArgs?: string[]
  resolution?: { width: number; height: number }
  [key: string]: unknown
}

export interface InstanceProfileRecord {
  [key: string]: unknown
}

export interface SettingsSnapshot {
  currentTheme?: string
  lang?: string
  preferences?: unknown
  [key: string]: unknown
}

export interface LaunchGamePayload {
  folderName?: string
  profileName: string
  version: string
  ram: number
  modLoader: string
  loaderVersion?: string
  javaPath?: string
  authData?: { type: string; name: string; uuid?: string }
  gameOptions?: Record<string, unknown>
  extraJvmArgs?: string[]
  resolution?: { width: number; height: number }
}

export interface GameClosedPayload {
  code: number
  profileName: string
  folderName: string
}

export interface LaunchFailedPayload {
  folderName: string
  profileName: string
  message: string
}

export interface LaunchStopPayload {
  folderName: string
  profileName: string
}

export interface CreateInstancePayload {
  folderName: string
  options: Record<string, unknown> & {
    keyBindings?: Record<string, string>
    _mcVersion?: string
    lang?: string
    fullscreen?: boolean
  }
}

export interface CreateInstanceResult {
  success: boolean
  folderName?: string
  path?: string
  created?: boolean
  reason?: string
  keybindCount?: number
  error?: string
}

export interface RenameInstanceResult {
  success: boolean
  newFolderName?: string
  profiles?: unknown
  error?: string
}

export interface RepairProfilePayload {
  loader: string
  loaderVersion: string
  mcVersion: string
  folderName?: string
}

export interface ChangeInstanceVersionPayload {
  folderName: string
  mcVersion: string
  /** Lowercase loader id: vanilla, fabric, quilt, forge or neoforge. */
  loader: string
  loaderVersion?: string
}

export interface ChangeInstanceVersionResult {
  success: boolean
  error?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  /** Installed launcher profile that matches the target version. */
  versionId?: string
}

export interface JavaVersion {
  path: string
  version: number
  verStr: string
  majorVersion?: number
  arch?: string
  vendor?: string
  source?: string
}

export interface SupportBundleResult {
  file: string
  entries: string[]
  bytes: number
  sanitizedLogFiles: number
}

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface DialogOpenOptions {
  defaultPath?: string
  properties?: string[]
  filters?: DialogFilter[]
  [key: string]: unknown
}

export interface DialogOpenResult {
  canceled: boolean
  filePaths?: string[]
}

export interface DialogSaveOptions {
  defaultPath?: string
  filters?: DialogFilter[]
  [key: string]: unknown
}

export interface DialogSaveResult {
  canceled: boolean
  filePath?: string
}

export interface InstalledWorldInfo {
  /** Folder created inside the instance's `saves` directory. */
  folderName: string
  path: string
  /** True when an existing world forced a `(2)`-style name instead of overwriting. */
  renamed: boolean
  files?: number
}

export interface DownloadModPayload {
  folderName: string
  profileName: string
  versionId: string
  downloadUrl?: string
  filename: string
  itemType: string
  /** Correlates world-install progress with the footer task bar. */
  taskId?: string
  /** CurseForge file id: the core resolves and verifies it against the API. */
  curseforgeFileId?: number
  /** Project title, used as the world name when the archive has no folder of its own. */
  title?: string
}

export interface DownloadModResult {
  success: boolean
  path?: string
  error?: string
  /** Set for world installs: the folders created inside `saves`. */
  worlds?: InstalledWorldInfo[]
}

export interface InstallModpackPayload {
  folderName: string
  mcVersion: string
  loader: string
  mrpackUrl: string
  /** `install` reserves a free folder; `update` keeps the existing one. */
  mode?: 'install' | 'update'
}

export interface ModpackIndexEntry {
  path?: string
  filename?: string
  downloads?: string[]
  [key: string]: unknown
}

export interface ModpackIndex {
  name?: string
  files?: ModpackIndexEntry[]
  [key: string]: unknown
}

export interface InstallModpackResult {
  success: boolean
  modCount?: number
  index?: ModpackIndex
  error?: string
  loaderInstalled?: boolean
  /** Loader kind and versions the .mrpack actually requires, not the UI label. */
  loader?: string
  mcVersion?: string
  /** Loader version the installer actually selected, for the instance profile. */
  loaderVersion?: string
  versionId?: string
  /** Actual folder on disk, unique when the requested one was already taken. */
  folderName?: string
  /** Relative paths of every override file the pack installed. */
  overrideFiles?: string[]
}

export interface ModpackInstallProgress {
  folderName: string
  percent: number
  label: string
}

export interface LaunchProgress {
  folderName: string
  profileName: string
  percent: number
  label: string
  /** Main-process start timestamp, so a remounted card resumes the curve. */
  startedAt?: number
}

export interface ContentFilePayload {
  folderName: string
  type: string
}

export interface HashContentFilesPayload {
  folderName: string
  files: Array<{ fileName: string; type: string }>
}

export type HashContentFilesResult = Record<string, string>

export interface IdentifiedContentFile {
  source: 'modrinth' | 'curseforge'
  projectId: string
  name: string
  iconUrl: string
  versionNumber: string
}

export type IdentifyContentFilesResult = Record<string, IdentifiedContentFile>

export interface UploadLocalModPayload {
  folderName: string
  filePath: string
  itemType: string
  /** Correlates installer progress with the footer task bar. */
  taskId?: string
}

export interface UploadLocalModResult {
  success: boolean
  error?: string
  fileName?: string
  destPath?: string
  itemType?: string
  /** Read from the JAR manifest so the list never has to show a bare file name. */
  modName?: string
  modVersion?: string
  modLoader?: string
  iconBase64?: string | null
  /** Set for world uploads: the folders created inside `saves`. */
  worlds?: InstalledWorldInfo[]
}

export interface UploadProgress {
  percent: number
}

export interface ExportProfilePayload {
  format: 'mrpack' | 'zip'
  instanceName: string
  folderName: string
  manifest: unknown
  options: unknown
  savePath?: string
  suggestedFileName: string
  mrpackIndex?: unknown
}

export interface ExportProfileResult {
  success: boolean
  filePath?: string
  fileName?: string
  fileSize?: number
  error?: string
}

export interface ImportPreviewPayload {
  error?: string
  format?: "mrpack" | "zip"
  title?: string
  minecraftVersion?: string
  modloader?: string
  modloaderVersion?: string
  description?: string
  author?: string
  fileSize?: number
  totalFiles?: number
  modCount?: number
  resourcepackCount?: number
  shaderCount?: number
  datapackCount?: number
  worldCount?: number
  hasIcon?: boolean
  hasBanner?: boolean
  hasConfig?: boolean
  hasScreenshots?: boolean
  worlds?: string[]
  isModpack?: boolean
}

export interface ImportProfilePayload {
  filePath: string
  taskId?: string
  targetInstanceName: string
  installMods: boolean
  installResourcepacks: boolean
  installShaderpacks: boolean
  installDatapacks: boolean
  installWorlds: boolean
  installConfig: boolean
  installScreenshots: boolean
}

export interface ImportProfileResult {
  success: boolean
  instanceId?: string
  instanceName?: string
  profile?: Record<string, unknown>
  error?: string
  modsInstalled?: number
  resourcepacksInstalled?: number
  shaderpacksInstalled?: number
  datapacksInstalled?: number
  worldsImported?: number
  /** Non-fatal problems reported after a successful import (e.g. skipped files). */
  warnings?: string[]
}

export interface ScreenshotDeletePayload {
  absolutePath: string
  sourceAbsolutePath?: string
}

export interface ServerPingResult {
  online: boolean
  playersOnline: number
  playersMax: number
  motd: string
  ping: number
  version: string
  icon: string | null
  error?: string
}

export interface LaunchApi {
  start(payload: LaunchGamePayload): void
  stop(payload: LaunchStopPayload): Promise<boolean>
  onStatus(callback: (status: string) => void): Unsubscribe
  onClosed(callback: (data: GameClosedPayload) => void): Unsubscribe
  onReady(callback: (profileName: string) => void): Unsubscribe
  onFailed(callback: (data: LaunchFailedPayload) => void): Unsubscribe
  onProgress(callback: (data: LaunchProgress) => void): Unsubscribe
}

export interface LogsApi {
  onAnalysis(callback: (result: LogAnalysisResult) => void): Unsubscribe
  analyze(instanceId: string, launchId?: string): Promise<LogAnalysisResult>
  applyFix(analysisId: string, actionId: string): Promise<LogFixResult>
  undoFix(undoToken: string): Promise<LogFixResult>
  readLatest(folderName: string): Promise<string>
  createSupportBundle(destination: string): Promise<SupportBundleResult>
}

export interface SettingsApi {
  get(): Promise<SettingsSnapshot | null>
  save(settings: SettingsSnapshot): Promise<boolean>
  onFlushBeforeClose(callback: () => void): Unsubscribe
  flushBeforeCloseComplete(): void
}

/** Mirrors `electron/instances/worlds.ts`; each locomotion stat stays separate. */
export interface DistanceStats {
  walkCm: number
  sprintCm: number
  crouchCm: number
  swimCm: number
  flyCm: number
  climbCm: number
  fallCm: number
  walkOnWaterCm: number
  walkUnderWaterCm: number
  aviateCm: number
  minecartCm: number
  boatCm: number
  pigCm: number
  horseCm: number
  striderCm: number
  happyGhastCm: number
}

/** Mirrors `electron/statistics.ts`; one instance's slice of the aggregate. */
export interface StatisticsInstanceSummary {
  id: string
  name: string
  version: string
  loader: string
  playTimeMs: number
  sessions: number
  worlds: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
}

/** Mirrors `electron/statistics.ts`; aggregated once in the main process. */
export interface StatisticsSummary {
  enabled: boolean
  playTimeMs: number
  sessions: number
  firstPlayedAt: number
  lastPlayedAt: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
  instances: number
  worlds: number
  perInstance: StatisticsInstanceSummary[]
  generatedAt: number
}

export interface StatisticsApi {
  summary(): Promise<StatisticsSummary | undefined>
}

export type WorldGamemode = 'survival' | 'creative' | 'adventure' | 'spectator'

/** Mirrors `electron/instances/worlds.ts`; worlds are detected from `saves` on disk. */
export interface WorldSummary {
  folderName: string
  name: string
  gamemode: WorldGamemode | null
  hardcore: boolean
  version: string | null
  lastPlayed: number | null
  playtimeMs: number | null
  playtimeSource: 'stats' | 'world-age' | 'none'
  playtimeApproximate: boolean
  playerCount: number
  iconDataUrl: string | null
  error?: string
}

export interface CloneInstanceResult {
  success: boolean
  profile?: InstanceProfileRecord
  error?: string
}

export interface CreateShortcutResult {
  success: boolean
  path?: string
  error?: string
}

export interface BackgroundTaskProgress {
  id: string
  percent: number | null
  label: string
}

export interface InstancesApi {
  list(): Promise<CoreInstanceRecord[]>
  create(data: CreateInstancePayload): Promise<CreateInstanceResult>
  rename(data: { oldFolderName: string; newName: string }): Promise<RenameInstanceResult>
  clone(data: { folderName: string; newName?: string }): Promise<CloneInstanceResult>
  createShortcut(data: { folderName: string; instanceName: string }): Promise<CreateShortcutResult>
  deleteFiles(folderName: string): Promise<{ success: boolean; deleted?: boolean; screenshots?: number; error?: string }>
  openFolder(folderName: string): Promise<void>
  openProfileFolder(name: string): Promise<void>
  listWorlds(folderName: string): Promise<WorldSummary[]>
  repair(data: RepairProfilePayload): Promise<boolean>
  changeVersion(data: ChangeInstanceVersionPayload): Promise<ChangeInstanceVersionResult>
  updateLaunchSettings(
    folderName: string,
    patch: InstanceLaunchSettingsPatch,
  ): Promise<InstanceFileRecord>
  getProfiles(): Promise<InstanceProfileRecord[] | null>
  saveProfiles(profiles: InstanceProfileRecord[]): Promise<boolean>
  onLaunchRequest(callback: (folderName: string) => void): Unsubscribe
}

export interface InstanceModUpdate {
  /** Installed file name in `mods/`; the row is matched by it. */
  file: string
  projectId: string
  versionId: string
  versionNumber: string
  fileName: string
  url: string
}

export interface InstanceModUpdateResult {
  /** Jars Modrinth knows, with or without a newer build. */
  resolved: string[]
  updates: InstanceModUpdate[]
}

export interface ModsApi {
  checkUpdates(data: { folderName: string }): Promise<InstanceModUpdateResult>
  curseforgeSearch(data: {
    query: string
    sortBy: string
    modFilter?: string
    gameVersion?: string
    modLoaderType?: number
    index?: number
    pageSize?: number
  }): Promise<CurseForgeSearchReply | undefined>
  curseforgeProject(modId: string | number): Promise<CurseForgeProjectResult | undefined>
  curseforgeFiles(
    modId: string | number,
    gameVersion?: string,
    modLoaderType?: number,
  ): Promise<CurseForgeFilesResult | undefined>
  download(data: DownloadModPayload): Promise<DownloadModResult>
  installModpack(data: InstallModpackPayload): Promise<InstallModpackResult>
  uploadLocal(data: UploadLocalModPayload): Promise<UploadLocalModResult>
  listContentFiles(data: ContentFilePayload): Promise<string[]>
  hashContentFiles(data: HashContentFilesPayload): Promise<HashContentFilesResult>
  identifyContentFiles(data: HashContentFilesPayload): Promise<IdentifyContentFilesResult>
  deleteContentFile(data: ContentFilePayload & { fileName: string }): Promise<boolean>
  onUploadProgress(callback: (data: UploadProgress) => void): Unsubscribe
  onModpackProgress(callback: (data: ModpackInstallProgress) => void): Unsubscribe
}

export interface DialogsApi {
  open(options?: DialogOpenOptions): Promise<DialogOpenResult>
  save(options?: DialogSaveOptions): Promise<DialogSaveResult>
  showItem(filePath: string): Promise<void>
  readImage(filePath: string): Promise<string | null>
}

export interface ProfilesApi {
  export(data: ExportProfilePayload): Promise<ExportProfileResult>
  importPreview(filePath: string): Promise<ImportPreviewPayload | null>
  import(data: ImportProfilePayload): Promise<ImportProfileResult>
}

export interface AuthApi {
  status(): Promise<MicrosoftAuthStatus | undefined>
  login(): Promise<MicrosoftAuthStatus | undefined>
  cancel(): Promise<boolean | undefined>
  refresh(accountId?: string): Promise<MicrosoftAuthStatus | undefined>
  signOut(accountId?: string): Promise<MicrosoftAuthStatus | undefined>
  identity(): Promise<{ uuid: string | null; username: string | null; type: string } | null>
  onStatus(callback: (status: MicrosoftAuthStatus) => void): Unsubscribe
}

export interface WindowApi {
  minimize(): void
  maximize(): void
  isMaximized(): Promise<boolean>
  onMaximizedChange(callback: (maximized: boolean) => void): () => void
  focus(): void
  close(): void
}

export interface JavaApi {
  versions(forceRescan?: boolean): Promise<JavaVersion[] | null>
}

export interface LoadersApi {
  forgeVersions(): Promise<string[] | null>
  neoforgeVersions(): Promise<string[] | null>
}

export interface ServersApi {
  ping(serverIp: string): Promise<ServerPingResult>
}

export interface ScreenshotsApi {
  collect(): Promise<ScreenshotItem[]>
  delete(payload: ScreenshotDeletePayload): Promise<boolean>
  openFolder(): Promise<void>
}

export interface SystemApi {
  copy(text: string): void
  openExternal(url: string): void
}

export interface TasksApi {
  onProgress(callback: (data: BackgroundTaskProgress) => void): Unsubscribe
}

export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  percent?: number
  message?: string
  checkedAt?: number
}

export interface UpdatesApi {
  state(): Promise<UpdateStatus | undefined>
  check(): Promise<UpdateStatus | undefined>
  install(): Promise<boolean | undefined>
  onStatus(callback: (status: UpdateStatus) => void): Unsubscribe
}

export type SkinVariant = 'classic' | 'slim'

export interface VanillaCapeSnapshot {
  id: string
  name: string
  url: string
  active: boolean
}

export interface SkinSnapshot {
  account: { id: string; name: string; uuid: string; online: boolean } | null
  /** Capes Mojang already owns for the account; display only. */
  capes: VanillaCapeSnapshot[]
  skin: {
    url: string | null
    source: 'local' | 'profile' | 'none'
    variant: SkinVariant
    updatedAt?: number
    applied: boolean
  }
  canApplySkin: boolean
}

export interface SkinsApi {
  snapshot(): Promise<SkinSnapshot | undefined>
  saveSkin(payload: { bytes: Uint8Array; variant: SkinVariant }): Promise<SkinSnapshot | undefined>
  setSkinVariant(variant: SkinVariant): Promise<SkinSnapshot | undefined>
  resetSkin(): Promise<SkinSnapshot | undefined>
  applySkin(): Promise<SkinSnapshot | undefined>
  /** Sets the active Mojang cape, or hides it with null. */
  selectCape(capeId: string | null): Promise<SkinSnapshot | undefined>
  refresh(): Promise<SkinSnapshot | undefined>
}

export type CosmeticSlot = "head" | "back" | "cape"

export interface CosmeticPreviewPart {
  /** PNG data URL from the package itself. */
  texture: string
  textureWidth: number
  textureHeight: number
  cubes: BedrockCube[]
}

export interface CosmeticPreview {
  id: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  faces: number
  parts: CosmeticPreviewPart[]
}

export interface InstalledCosmetic {
  file: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  bytes: number
  valid: boolean
  error?: string
}

export interface ShopItem {
  id: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  file: string
  /** Preview image: data URL from the bundle, https URL from GitHub. */
  image: string | null
  remote: boolean
}

export interface ShopCatalog {
  items: ShopItem[]
  source: "remote" | "local"
  error?: string
}

export interface CosmeticsApi {
  /** Account-wide library, mirrored into every instance. */
  list(): Promise<InstalledCosmetic[] | undefined>
  preview(payload: { file: string }): Promise<CosmeticPreview | undefined>
  remove(payload: { file: string }): Promise<InstalledCosmetic[] | undefined>
  shop(): Promise<ShopCatalog | undefined>
  shopPreview(id: string): Promise<CosmeticPreview | undefined>
  install(payload: { id: string }): Promise<InstalledCosmetic[] | undefined>
  /** Reachability of the mod's relay; the launcher itself never publishes. */
  syncStatus(): Promise<CosmeticSyncStatus | undefined>
}

export interface CosmeticSyncStatus {
  relay: string
  online: boolean
  error?: string
}

export interface BambooApi {
  icons: Record<string, string>
  launch: LaunchApi
  logs: LogsApi
  settings: SettingsApi
  statistics: StatisticsApi
  instances: InstancesApi
  mods: ModsApi
  dialogs: DialogsApi
  profiles: ProfilesApi
  tasks: TasksApi
  auth: AuthApi
  skins: SkinsApi
  cosmetics: CosmeticsApi
  window: WindowApi
  java: JavaApi
  loaders: LoadersApi
  servers: ServersApi
  screenshots: ScreenshotsApi
  updates: UpdatesApi
  system: SystemApi
}

declare global {
  // The renderer only ever sees metadata; tokens stay in the OS secret store.
  interface MicrosoftAccountStatus {
    id: string
    name: string
    uuid: string
    type: string
    active: boolean
    avatar: string
    expiresAt?: number
    expired: boolean
    hasRefreshToken: boolean
  }

  interface MicrosoftAuthStatus {
    signedIn: boolean
    pending: boolean
    tokenStoreDegraded: boolean
    account: MicrosoftAccountStatus | null
  }

  interface ScreenshotItem {
    id: string;
    title: string;
    fileName: string;
    source: string;
    instance: string;
    world: string | null;
    date: number;
    sizeBytes: number;
    sizeStr: string;
    dimensions: string;
    url: string;
    absolutePath: string;
    sourceAbsolutePath: string;
  }
  interface Window {
    electronAPI?: BambooApi
  }
}
