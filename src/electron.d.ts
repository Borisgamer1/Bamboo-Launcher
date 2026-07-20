export {}

interface FriendProfile {
  id: string; username: string; displayName: string; avatar: string; banner: string;
  bio: string; accentColor: string; createdAt: number;
  status: 'online' | 'busy' | 'away' | 'dnd' | 'invisible' | 'offline';
  activity: { type: string; detail?: string; minecraftVersion?: string; loader?: string; profileName?: string; sessionStart?: number; progress?: { current: number; total: number } };
  friendCount: number; lastOnline: number; launcherVersion: string; customStatus?: string;
  launcherLevel?: number;
  badges?: string[];
}

interface FriendStore {
  friends: Record<string, FriendProfile>;
  relations: Record<string, { userId: string; since: number; direction: string }>;
  friendRequests: { from: string; to: string; timestamp: number; message?: string }[];
  blockedUsers: string[];
  activities: any[];
  notifications: any[];
  privacySettings: any;
  myProfile: Partial<FriendProfile> & { id: string };
}

declare global {
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
    electronAPI?: {
      iconCache: Record<string, string>
      launchGame: (payload: {
        folderName?: string
        profileName: string
        version: string
        ram: number
        modLoader: string
        loaderVersion?: string
        javaPath?: string
        authData?: { type: string; name: string; uuid?: string; token?: string }
        gameOptions?: Record<string, unknown>
      }) => void
      onLaunchStatus?: (callback: (status: string) => void) => () => void
      onGameClosed?: (callback: (data: { code: number; profileName: string; folderName: string }) => void) => () => void
      onGameReady?: (callback: (profileName: string) => void) => () => void
      startMicrosoftLogin?: () => void
      onMsDeviceCode?: (callback: (data: { userCode: string; verificationUri: string }) => void) => () => void
      onMsLoginStep?: (callback: (step: string) => void) => () => void
      onMsLoginResult?: (callback: (result: { success: boolean; name?: string; uuid?: string; token?: string; refreshToken?: string; error?: string }) => void) => () => void
      copyToClipboard?: (text: string) => void
      openExternal?: (url: string) => void
      writeOptionsTxt?: (data: { folderName: string; options: Record<string, unknown> }) => Promise<void>
      findJava?: () => Promise<string | null>
      getJavaVersions?: (forceRescan?: boolean) => Promise<{ path: string; version: number; verStr: string }[] | null>
      getRecommendedJavaForMc?: (mcVersion: string) => Promise<{ recommended: number; selected: { path: string; version: number; verStr: string } | null; available: { path: string; version: number; verStr: string }[] }>
      findBestJavaForMc?: (mcVersion: string) => Promise<{ path: string; version: number; verStr: string } | null>
      getProfiles?: () => Promise<any>
      saveProfiles?: (profiles: any) => Promise<boolean>
      getCollections?: () => Promise<any[]>
      saveCollections?: (collections: any[]) => Promise<boolean>
      openProfileFolder?: (name: string) => Promise<void>
      openInstanceFolder?: (folderName: string) => Promise<void>
      downloadMod?: (data: { folderName: string; profileName: string; versionId: string; downloadUrl: string; filename: string; itemType: string }) => Promise<{ success: boolean; path?: string }>
      installModpackMrpack?: (data: { folderName: string; mcVersion: string; loader: string; mrpackUrl: string }) => Promise<{ success: boolean; modCount?: number; index?: any; error?: string }>
      getForgeVersions?: () => Promise<string[] | null>
      getNeoforgeVersions?: () => Promise<string[] | null>
      getSettings?: () => Promise<any>
      saveSettings?: (settings: any) => Promise<boolean>
      getPlayerIdentity?: () => Promise<{ uuid: string | null; username: string | null; type: string } | null>
      curseforgeSearch?: (data: { query: string; sortBy: string; modFilter?: string; gameVersion?: string; modLoaderType?: number; index?: number; pageSize?: number }) => Promise<any | { error: string }>
      curseforgeProject?: (modId: string) => Promise<any | { error: string }>
      curseforgeFiles?: (modId: string, gameVersion?: string, modLoaderType?: number) => Promise<any[] | { error: string }>
      deleteProfileFiles?: (folderName: string) => Promise<void>
      repairProfile?: (data: { loader: string; loaderVersion: string; mcVersion: string; folderName?: string }) => Promise<boolean>
      onRepairProgress?: (callback: (status: string) => void) => () => void
      completeReinstall?: (profiles: any[]) => Promise<boolean>
      onReinstallProgress?: (callback: (status: string) => void) => () => void
      showOpenDialog?: (options: any) => Promise<{ canceled: boolean; filePaths?: string[] }>
      showSaveDialog?: (options: any) => Promise<{ canceled: boolean; filePath?: string }>
      pingServer?: (serverIp: string) => Promise<{ online: boolean; playersOnline: number; playersMax: number; motd: string; ping: number; version: string; icon: string | null; error?: string }>
      readImageFile?: (filePath: string) => Promise<string | null>
      exportProfile?: (data: { format: string; instanceName: string; folderName: string; manifest: any; options: any; suggestedFileName: string; savePath?: string; mrpackIndex?: any }) => Promise<any>
      importPreview?: (filePath: string) => Promise<any>
      importProfile?: (data: any) => Promise<any>
      // Unified screenshots collection
      collectAllScreenshots?: () => Promise<ScreenshotItem[]>
      deleteScreenshotFile?: (payload: { absolutePath: string; sourceAbsolutePath?: string }) => Promise<boolean>
      openScreenshotsFolder?: () => Promise<void>
      windowMinimize?: () => void
      windowClose?: () => void
      stopGame?: (data: { folderName: string; profileName: string }) => void
      // Friends API
      getFriendsStore?: () => Promise<FriendStore | null>
      saveFriendsStore?: (data: FriendStore) => Promise<boolean>
      searchUsers?: (query: string) => Promise<FriendProfile[]>
      sendFriendRequest?: (userId: string) => Promise<boolean>
      acceptFriendRequest?: (userId: string) => Promise<boolean>
      declineFriendRequest?: (userId: string) => Promise<boolean>
      blockUser?: (userId: string) => Promise<boolean>
      removeFriend?: (userId: string) => Promise<boolean>
      updateFriendStatus?: (status: string) => Promise<boolean>
      updateFriendActivity?: (activity: any) => Promise<boolean>
      buildInviteLink?: (payload: any) => Promise<string>
      sendFriendInvitation?: (data: any) => Promise<boolean>
      acceptFriendInvitation?: (notificationId: string) => Promise<boolean>
      declineFriendInvitation?: (notificationId: string) => Promise<boolean>
      saveFriendAvatar?: (filePath: string) => Promise<string | null>
      saveFriendBanner?: (filePath: string) => Promise<string | null>
      onDeepLinkInvite?: (callback: (payload: any) => void) => () => void
      getActiveLaunches?: () => Promise<string[]>
      onCosmeticProgress?: (callback: (data: { playtimeHours?: number; blocksMined?: number; mobsKilled?: number; playerKills?: number; distanceTraveled?: number; achievements?: string[] }) => void) => () => void

      detectLanServer?: (folderName: string) => Promise<{ port: number; address: string } | null>
      getHostedServers?: () => Promise<Record<string, { port: number; address: string; discoveredAt: number }>>
      // Issue 24: Custom version / local content upload
      deleteContentFile?: (data: { folderName: string; fileName: string; type: string }) => Promise<void>
      uploadLocalMod?: (data: { folderName: string; filePath: string; itemType: string }) => Promise<{ success: boolean; error?: string }>
      onUploadProgress?: (callback: (data: { percent: number }) => void) => () => void
      listContentFiles?: (data: { folderName: string; type: string }) => Promise<string[]>
      readFileAsBase64?: (filePath: string) => Promise<string | null>
      showItemInFolder?: (filePath: string) => Promise<void>
      saveTempFile?: (data: { data: number[]; fileName: string }) => Promise<string | null>
    }
  }
}
