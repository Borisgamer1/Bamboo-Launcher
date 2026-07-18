export type FriendStatus = 'online' | 'busy' | 'away' | 'dnd' | 'invisible' | 'offline';

export type ActivityType =
  | 'in_launcher'
  | 'playing_minecraft'
  | 'editing_modpack'
  | 'installing_mods'
  | 'downloading_mods'
  | 'browsing_modrinth'
  | 'browsing_curseforge'
  | 'in_ai_assistant'
  | 'idle'
  | 'offline';

export interface FriendActivity {
  type: ActivityType;
  detail?: string;
  minecraftVersion?: string;
  loader?: string;
  profileName?: string;
  sessionStart?: number;
  progress?: { current: number; total: number };
}

export interface FriendProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  banner: string;
  bio: string;
  accentColor: string;
  createdAt: number;
  status: FriendStatus;
  activity: FriendActivity;
  friendCount: number;
  lastOnline: number;
  launcherVersion: string;
  customStatus?: string;
  launcherLevel?: number;
  badges?: string[];
}

export interface FriendRelation {
  userId: string;
  since: number;
  direction: 'requested' | 'pending' | 'accepted' | 'blocked';
}

export interface ActivityEntry {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string;
  type: 'friend_added' | 'status_change' | 'started_minecraft' | 'created_modpack'
    | 'installed_loader' | 'installed_mod' | 'online' | 'profile_updated';
  message: string;
  timestamp: number;
  metadata?: Record<string, string>;
}

export interface FriendNotification {
  id: string;
  type: 'friend_online' | 'friend_started_game' | 'friend_request' | 'request_accepted'
    | 'profile_updated' | 'invitation';
  fromUserId: string;
  fromUserName: string;
  fromUserAvatar: string;
  message: string;
  timestamp: number;
  read: boolean;
  invitationData?: InvitationData;
}

export interface InvitationData {
  type: 'join_request' | 'server' | 'realm' | 'modpack' | 'profile_share';
  detail?: string;
  payload?: any;
}

export interface PrivacySettings {
  statusVisible: 'everyone' | 'friends' | 'nobody';
  profileVisible: 'everyone' | 'friends' | 'nobody';
  whoCanAdd: 'everyone' | 'friends' | 'nobody';
  activitiesVisible: 'everyone' | 'friends' | 'nobody';
  invitationsAllowed: 'everyone' | 'friends' | 'nobody';
  currentProfileVisible: 'everyone' | 'friends' | 'nobody';
}

export interface FriendStore {
  friends: Record<string, FriendProfile>;
  relations: Record<string, FriendRelation>;
  friendRequests: { from: string; to: string; timestamp: number; message?: string }[];
  blockedUsers: string[];
  activities: ActivityEntry[];
  notifications: FriendNotification[];
  privacySettings: PrivacySettings;
  myProfile: Partial<FriendProfile> & { id: string };
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  statusVisible: 'everyone',
  profileVisible: 'friends',
  whoCanAdd: 'everyone',
  activitiesVisible: 'friends',
  invitationsAllowed: 'friends',
  currentProfileVisible: 'friends',
};

export const DEFAULT_STORE: FriendStore = {
  friends: {},
  relations: {},
  friendRequests: [],
  blockedUsers: [],
  activities: [],
  notifications: [],
  privacySettings: { ...DEFAULT_PRIVACY },
  myProfile: { id: '', username: 'BambooPlayer', displayName: 'BambooPlayer', avatar: '🎋', banner: '', bio: 'Bamboo Launcher Nutzer', accentColor: '#4CAF50', createdAt: 0, status: 'online' as FriendStatus, activity: { type: 'in_launcher' } as any, friendCount: 0, lastOnline: 0, launcherVersion: '0.1.0' },
};

let _idCounter = 0;
export function generateId(): string {
  _idCounter++;
  return Date.now().toString(36) + '-' + _idCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

export const STATUS_LABELS: Record<FriendStatus, string> = {
  online: 'Online',
  busy: 'Beschäftigt',
  away: 'Abwesend',
  dnd: 'Nicht stören',
  invisible: 'Unsichtbar',
  offline: 'Offline',
};

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  in_launcher: 'Im Launcher',
  playing_minecraft: 'Spielt Minecraft',
  editing_modpack: 'Bearbeitet Modpack',
  installing_mods: 'Installiert Mods',
  downloading_mods: 'Lädt Mods herunter',
  browsing_modrinth: 'Durchsucht Modrinth',
  browsing_curseforge: 'Durchsucht CurseForge',
  in_ai_assistant: 'Im KI-Assistenten',
  idle: 'Inaktiv',
  offline: 'Offline',
};
