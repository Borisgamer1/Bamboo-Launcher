import type { ActivityEntry } from './types';
import { generateId } from './types';
import { friendStore } from './FriendStore';

class ActivityService {
  addEntry(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
    const full: ActivityEntry = {
      ...entry,
      id: generateId(),
      timestamp: Date.now(),
    };
    friendStore.addActivity(full);
  }

  friendOnline(userName: string, userAvatar: string, userId: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'online',
      message: `${userName} ist jetzt online.`,
    });
  }

  friendStartedMinecraft(userName: string, userAvatar: string, userId: string, profileName?: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'started_minecraft',
      message: profileName
        ? `${userName} spielt jetzt "${profileName}".`
        : `${userName} hat Minecraft gestartet.`,
      metadata: profileName ? { profileName } : undefined,
    });
  }

  friendAdded(userName: string, userAvatar: string, userId: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'friend_added',
      message: `${userName} ist jetzt mit dir befreundet.`,
    });
  }

  profileUpdated(userName: string, userAvatar: string, userId: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'profile_updated',
      message: `${userName} hat sein Profil aktualisiert.`,
    });
  }

  createdModpack(userName: string, userAvatar: string, userId: string, modpackName?: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'created_modpack',
      message: modpackName
        ? `${userName} hat ein neues Modpack erstellt: "${modpackName}".`
        : `${userName} hat ein neues Modpack erstellt.`,
      metadata: modpackName ? { modpackName } : undefined,
    });
  }

  installedLoader(userName: string, userAvatar: string, userId: string, loader: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'installed_loader',
      message: `${userName} hat ${loader} installiert.`,
      metadata: { loader },
    });
  }

  installedMod(userName: string, userAvatar: string, userId: string, modName?: string): void {
    this.addEntry({
      userId, userName, userAvatar,
      type: 'installed_mod',
      message: modName
        ? `${userName} verwendet jetzt "${modName}".`
        : `${userName} hat einen neuen Mod installiert.`,
      metadata: modName ? { modName } : undefined,
    });
  }
}

export const activityService = new ActivityService();
