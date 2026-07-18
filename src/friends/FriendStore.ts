import type { FriendStore, FriendProfile, FriendRelation, ActivityEntry, FriendNotification } from './types';
import { DEFAULT_STORE } from './types';

type Listener = () => void;

class FriendStoreManager {
  private data: FriendStore = { ...DEFAULT_STORE, myProfile: { ...DEFAULT_STORE.myProfile } };
  private listeners: Set<Listener> = new Set();

  async init(): Promise<void> {
    try {
      const saved = await window.electronAPI?.getFriendsStore?.();
      if (saved) {
        this.data = { ...this.data, ...saved, myProfile: { ...this.data.myProfile, ...saved.myProfile } } as FriendStore;
      }
    } catch (e) {
      console.warn('[FriendStore] init error, using defaults:', e);
    }
    this.notify();
  }

  async save(): Promise<void> {
    try {
      await window.electronAPI?.saveFriendsStore?.(this.data);
    } catch (e) {
      console.warn('[FriendStore] save error:', e);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    this.listeners.forEach(fn => fn());
  }

  get(): FriendStore {
    return this.data;
  }

  getMyProfile(): Partial<FriendProfile> & { id: string } {
    return this.data.myProfile;
  }

  updateMyProfile(updates: Partial<FriendProfile>): void {
    Object.assign(this.data.myProfile, updates);
    this.save();
    this.notify();
  }

  getFriends(): FriendProfile[] {
    return Object.values(this.data.friends);
  }

  getFriend(userId: string): FriendProfile | undefined {
    return this.data.friends[userId];
  }

  getOnlineFriends(): FriendProfile[] {
    return Object.values(this.data.friends).filter(f => f.status === 'online' || f.status === 'busy');
  }

  addFriend(profile: FriendProfile): void {
    this.data.friends[profile.id] = profile;
    this.data.relations[profile.id] = { userId: profile.id, since: Date.now(), direction: 'accepted' };
    this.save();
    this.notify();
  }

  removeFriend(userId: string): void {
    delete this.data.friends[userId];
    delete this.data.relations[userId];
    this.save();
    this.notify();
  }

  getRelation(userId: string): FriendRelation | undefined {
    return this.data.relations[userId];
  }

  isBlocked(userId: string): boolean {
    return this.data.blockedUsers.includes(userId);
  }

  blockUser(userId: string): void {
    if (!this.data.blockedUsers.includes(userId)) {
      this.data.blockedUsers.push(userId);
    }
    delete this.data.friends[userId];
    delete this.data.relations[userId];
    this.save();
    this.notify();
  }

  unblockUser(userId: string): void {
    this.data.blockedUsers = this.data.blockedUsers.filter(id => id !== userId);
    this.save();
    this.notify();
  }

  getFriendRequests(): { from: string; to: string; timestamp: number; message?: string }[] {
    return this.data.friendRequests;
  }

  addFriendRequest(request: { from: string; to: string; timestamp: number; message?: string }): void {
    this.data.friendRequests.push(request);
    this.save();
    this.notify();
  }

  removeFriendRequest(from: string, to: string): void {
    this.data.friendRequests = this.data.friendRequests.filter(
      r => !(r.from === from && r.to === to)
    );
    this.save();
    this.notify();
  }

  getActivities(): ActivityEntry[] {
    return this.data.activities;
  }

  addActivity(entry: ActivityEntry): void {
    this.data.activities.unshift(entry);
    if (this.data.activities.length > 200) {
      this.data.activities = this.data.activities.slice(0, 200);
    }
    this.save();
    this.notify();
  }

  getNotifications(): FriendNotification[] {
    return this.data.notifications;
  }

  getUnreadNotifications(): FriendNotification[] {
    return this.data.notifications.filter(n => !n.read);
  }

  addNotification(notification: FriendNotification): void {
    // DND mode: suppress notifications
    if (this.data.myProfile.status === 'dnd') return;
    
    this.data.notifications.unshift(notification);
    if (this.data.notifications.length > 100) {
      this.data.notifications = this.data.notifications.slice(0, 100);
    }
    this.save();
    this.notify();
  }

  markNotificationRead(id: string): void {
    const n = this.data.notifications.find(n => n.id === id);
    if (n) { n.read = true; this.save(); this.notify(); }
  }

  markAllNotificationsRead(): void {
    this.data.notifications.forEach(n => n.read = true);
    this.save();
    this.notify();
  }

  getPrivacySettings() {
    return this.data.privacySettings;
  }

  updatePrivacySettings(updates: Partial<typeof DEFAULT_STORE.privacySettings>): void {
    Object.assign(this.data.privacySettings, updates);
    this.save();
    this.notify();
  }

  getBlockedUsers(): string[] {
    return this.data.blockedUsers;
  }
}

export const friendStore = new FriendStoreManager();
