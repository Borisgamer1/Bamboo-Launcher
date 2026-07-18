import type { FriendNotification } from './types';
import { generateId } from './types';
import { friendStore } from './FriendStore';

type PopupHandler = (notification: FriendNotification) => void;

class NotificationService {
  private popupHandlers: Set<PopupHandler> = new Set();
  private enabled = true;

  onPopup(handler: PopupHandler): () => void {
    this.popupHandlers.add(handler);
    return () => this.popupHandlers.delete(handler);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private add(type: FriendNotification['type'], fromUserId: string, fromUserName: string, fromUserAvatar: string, message: string, invitationData?: any): void {
    const notification: FriendNotification = {
      id: generateId(),
      type,
      fromUserId,
      fromUserName,
      fromUserAvatar,
      message,
      timestamp: Date.now(),
      read: false,
      invitationData,
    };
    friendStore.addNotification(notification);
    if (this.enabled) {
      this.popupHandlers.forEach(fn => fn(notification));
    }
  }

  friendOnline(userId: string, userName: string, avatar: string): void {
    this.add('friend_online', userId, userName, avatar, `${userName} ist jetzt online.`);
  }

  friendStartedGame(userId: string, userName: string, avatar: string, profileName?: string): void {
    this.add('friend_started_game', userId, userName, avatar,
      profileName ? `${userName} spielt ${profileName}.` : `${userName} hat Minecraft gestartet.`);
  }

  friendRequest(userId: string, userName: string, avatar: string, message?: string): void {
    this.add('friend_request', userId, userName, avatar,
      message ? `${userName} möchte dich als Freund hinzufügen: "${message}"` : `${userName} möchte dich als Freund hinzufügen.`);
  }

  requestAccepted(userId: string, userName: string, avatar: string): void {
    this.add('request_accepted', userId, userName, avatar,
      `${userName} hat deine Freundschaftsanfrage angenommen.`);
  }

  profileUpdated(userId: string, userName: string, avatar: string): void {
    this.add('profile_updated', userId, userName, avatar,
      `${userName} hat sein Profil aktualisiert.`);
  }

  invitation(userId: string, userName: string, avatar: string, invitationData: any): void {
    this.add('invitation', userId, userName, avatar,
      `${userName} hat dir eine Einladung gesendet.`, invitationData);
  }
}

export const notificationService = new NotificationService();
