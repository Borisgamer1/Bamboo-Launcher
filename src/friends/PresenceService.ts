import type { FriendStatus, FriendActivity } from './types';
import { friendStore } from './FriendStore';

class PresenceService {
  private status: FriendStatus = 'online';
  private activity: FriendActivity = { type: 'in_launcher' };
  private sessionStart: number = Date.now();
  private activityInterval: number | null = null;
  private afkTimer: number | null = null;
  private readonly AFK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private lastActivityTime: number = Date.now();
  private previousStatus: FriendStatus | null = null;

  init(): void {
    const myProfile = friendStore.getMyProfile();
    if (myProfile.status) this.status = myProfile.status;
    if (myProfile.activity) this.activity = myProfile.activity;
    friendStore.updateMyProfile({ status: this.status, activity: this.activity });
    this.startSessionTimer();
    this.startActivityTracking();
  }

  private startSessionTimer(): void {
    if (this.activityInterval) clearInterval(this.activityInterval);
    this.activityInterval = window.setInterval(() => {
      friendStore.updateMyProfile({ activity: { ...this.activity } });
    }, 30000);
  }

  // ===== Discord-like AFK Detection =====
  private startActivityTracking(): void {
    const resetTimer = () => {
      this.lastActivityTime = Date.now();
      
      // If was automatically set to 'away' and user is active again, revert to previous status
      if (this.status === 'away' && this.previousStatus && this.previousStatus !== 'away') {
        const revertTo = this.previousStatus;
        this.previousStatus = null;
        this.setStatus(revertTo);
      }
    };

    // Track user interactions
    const events = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'click'];
    const handlers = events.map(event => {
      const handler = () => resetTimer();
      window.addEventListener(event, handler, { passive: true });
      return { event, handler };
    });

    // Check AFK status periodically
    this.afkTimer = window.setInterval(() => {
      if (this.status === 'online' || this.status === 'busy') {
        const elapsed = Date.now() - this.lastActivityTime;
        if (elapsed >= this.AFK_TIMEOUT) {
          // Auto-switch to away
          this.previousStatus = this.status;
          this.setStatusInternal('away');
        }
      }
    }, 10000); // Check every 10 seconds

    // Cleanup on destroy
    const originalInit = this.init.bind(this);
    const cleanup = () => {
      if (this.afkTimer) clearInterval(this.afkTimer);
      handlers.forEach(h => window.removeEventListener(h.event, h.handler));
    };
    
    // Store cleanup for later use
    (this as any)._cleanup = cleanup;
  }

  private setStatusInternal(status: FriendStatus): void {
    this.status = status;
    friendStore.updateMyProfile({ status });
    try { 
      window.electronAPI?.updateFriendStatus?.(status); 
    } catch { 
      console.warn('[Presence] updateFriendStatus failed'); 
    }
  }

  setStatus(status: FriendStatus): void {
    // If user manually set invisible, remember but still allow them to change
    if (status === 'invisible') {
      // Invisible: don't broadcast to others
      this.status = status;
      friendStore.updateMyProfile({ status });
      // Don't call IPC update so the server doesn't broadcast
      return;
    }
    
    // If user manually set DND, suppress notifications
    if (status === 'dnd') {
      // Set status normally but mark DND
      this.setStatusInternal(status);
      return;
    }
    
    this.setStatusInternal(status);
  }

  setActivity(activity: FriendActivity): void {
    this.activity = activity;
    friendStore.updateMyProfile({ activity });
    try { 
      window.electronAPI?.updateFriendActivity?.(activity); 
    } catch { 
      console.warn('[Presence] updateFriendActivity failed'); 
    }
  }

  setPlayingMinecraft(version: string, loader: string, profileName: string): void {
    this.sessionStart = Date.now();
    this.setActivity({
      type: 'playing_minecraft',
      minecraftVersion: version,
      loader,
      profileName,
      sessionStart: this.sessionStart,
    });
  }

  setInLauncher(): void {
    this.setActivity({ type: 'in_launcher' });
  }

  setBrowsingModrinth(): void {
    this.setActivity({ type: 'browsing_modrinth' });
  }

  setBrowsingCurseforge(): void {
    this.setActivity({ type: 'browsing_curseforge' });
  }

  setEditingModpack(detail?: string): void {
    this.setActivity({ type: 'editing_modpack', detail });
  }

  setInstallingMods(current: number, total: number): void {
    this.setActivity({ type: 'installing_mods', progress: { current, total } });
  }

  setDownloadingMods(current: number, total: number): void {
    this.setActivity({ type: 'downloading_mods', progress: { current, total } });
  }

  getStatus(): FriendStatus { return this.status; }
  getActivity(): FriendActivity { return this.activity; }
  getSessionDuration(): number {
    if (this.activity.type === 'playing_minecraft' && this.activity.sessionStart) {
      return Math.floor((Date.now() - this.activity.sessionStart) / 60000);
    }
    return 0;
  }

  getSessionDisplay(): string {
    const mins = this.getSessionDuration();
    if (mins < 1) return 'Weniger als eine Minute';
    if (mins < 60) return `Seit ${mins} Minuten`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return `Seit ${hours}h ${rem}m`;
  }
}

export const presenceService = new PresenceService();
