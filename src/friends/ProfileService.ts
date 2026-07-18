import type { FriendProfile, FriendStatus } from './types';
import { friendStore } from './FriendStore';
import { presenceService } from './PresenceService';

class ProfileService {
  updateProfile(updates: Partial<FriendProfile>): void {
    friendStore.updateMyProfile(updates);
  }

  setDisplayName(name: string): void {
    this.updateProfile({ displayName: name });
  }

  setBio(bio: string): void {
    this.updateProfile({ bio });
  }

  setAvatar(avatar: string): void {
    this.updateProfile({ avatar });
  }

  setBanner(banner: string): void {
    this.updateProfile({ banner });
  }

  setCustomStatus(status: string): void {
    this.updateProfile({ customStatus: status });
  }

  setAccentColor(color: string): void {
    this.updateProfile({ accentColor: color });
    document.documentElement.style.setProperty('--friends-accent', color);
  }

  setStatus(status: FriendStatus): void {
    presenceService.setStatus(status);
  }

  async uploadAvatar(): Promise<string | null> {
    try {
      const result = await window.electronAPI?.showOpenDialog?.({
        title: 'Avatar auswählen',
        filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
      });
      if (result && !result.canceled && result.filePaths?.[0]) {
        const filePath = result.filePaths[0];
        const savedPath = await window.electronAPI?.saveFriendAvatar?.(filePath);
        if (savedPath) {
          this.setAvatar(savedPath);
          return savedPath;
        } else {
          alert('Fehler: Das Bild konnte nicht verarbeitet werden. Erlaubt sind PNG/JPG/GIF/WebP bis 5 MB.');
        }
      }
    } catch (e) {
      console.warn('[ProfileService] avatar upload error:', e);
    }
    return null;
  }

  async uploadBanner(): Promise<string | null> {
    try {
      const result = await window.electronAPI?.showOpenDialog?.({
        title: 'Banner auswählen',
        filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
      });
      if (result && !result.canceled && result.filePaths?.[0]) {
        const filePath = result.filePaths[0];
        const savedPath = await window.electronAPI?.saveFriendBanner?.(filePath);
        if (savedPath) {
          this.setBanner(savedPath);
          return savedPath;
        }
      }
    } catch (e) {
      console.warn('[ProfileService] banner upload error:', e);
    }
    return null;
  }

  getMyProfile() {
    return friendStore.getMyProfile();
  }

  getFriendProfile(userId: string) {
    return friendStore.getFriend(userId);
  }
}

export const profileService = new ProfileService();
