import type { InvitationData } from './types';

class InvitationService {
  async sendInvitation(toUserId: string, data: InvitationData): Promise<boolean> {
    try {
      await window.electronAPI?.sendFriendInvitation?.({ toUserId, ...data });
      return true;
    } catch {
      return false;
    }
  }

  async acceptInvitation(notificationId: string): Promise<boolean> {
    try {
      await window.electronAPI?.acceptFriendInvitation?.(notificationId);
      return true;
    } catch {
      return false;
    }
  }

  async declineInvitation(notificationId: string): Promise<boolean> {
    try {
      await window.electronAPI?.declineFriendInvitation?.(notificationId);
      return true;
    } catch {
      return false;
    }
  }

  getInvitationLabel(type: InvitationData['type']): string {
    switch (type) {
      case 'join_request': return 'Beitrittsanfrage';
      case 'server': return 'Server-Einladung';
      case 'realm': return 'Realm-Einladung';
      case 'modpack': return 'Modpack-Einladung';
      case 'profile_share': return 'Profil teilen';
    }
  }
}

export const invitationService = new InvitationService();
