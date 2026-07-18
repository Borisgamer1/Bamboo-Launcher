export { friendStore } from './FriendStore';
export { presenceService } from './PresenceService';
export { activityService } from './ActivityService';
export { notificationService } from './NotificationService';
export { profileService } from './ProfileService';
export { invitationService } from './InvitationService';
export { networkLayer } from './NetworkLayer';
export * from './types';

import { friendStore } from './FriendStore';
import { presenceService } from './PresenceService';

export async function initFriendsSystem(): Promise<void> {
  await friendStore.init();
  presenceService.init();
  // Apply saved accent color
  const myProfile = friendStore.getMyProfile();
  if (myProfile.accentColor) {
    document.documentElement.style.setProperty('--friends-accent', myProfile.accentColor);
  }
  console.log('[Bamboo Friends] System initialized, accent:', myProfile.accentColor);
}

export { initFriendsSystem as default };
