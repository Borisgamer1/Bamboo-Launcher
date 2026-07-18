import type { FriendProfile, FriendStatus, FriendActivity } from './types';
import { friendStore } from './FriendStore';
import { notificationService } from './NotificationService';
import { activityService } from './ActivityService';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

class NetworkLayer {
  private ws: WebSocket | null = null;
  private apiUrl = import.meta.env.VITE_FRIENDS_API_URL || 'http://localhost:3400';
  private wsUrl = import.meta.env.VITE_FRIENDS_WS_URL || 'ws://localhost:3401';
  private token: string | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30000; // max 30s between attempts
  private readonly INITIAL_RECONNECT_DELAY = 1000; // start at 1s
  private status: ConnectionStatus = 'disconnected';
  private statusListeners: Set<(s: ConnectionStatus) => void> = new Set();

  onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): ConnectionStatus { return this.status; }
  isConnected(): boolean { return this.status === 'connected'; }

  setApiUrl(url: string): void { this.apiUrl = url; }
  setWsUrl(url: string): void { this.wsUrl = url; }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.statusListeners.forEach(fn => fn(s));
  }

  async connect(token: string): Promise<void> {
    this.token = token;
    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.setStatus('connected');
        this.reconnectAttempts = 0; // Reset backoff on successful connection
        this.ws?.send(JSON.stringify({ type: 'auth', token }));
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch { console.warn('[WS] Failed to parse message'); }
      };
      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.setStatus('error');
      };
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
    const delay = Math.min(
      this.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.token) this.connect(this.token);
    }, delay);
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.setStatus('disconnected');
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'friend_online':
        this.handleFriendOnline(msg.userId, msg.profile);
        break;
      case 'friend_offline':
        this.handleFriendOffline(msg.userId);
        break;
      case 'friend_status':
        this.handleFriendStatusChange(msg.userId, msg.status, msg.activity);
        break;
      case 'friend_request':
        this.handleFriendRequest(msg.fromUserId, msg.fromUserName, msg.fromAvatar, msg.message);
        break;
      case 'friend_request_accepted':
        this.handleFriendRequestAccepted(msg.userId, msg.profile);
        break;
      case 'friend_removed':
        this.handleFriendRemoved(msg.userId);
        break;
      case 'notification':
        this.handleNotification(msg);
        break;
    }
  }

  private handleFriendOnline(userId: string, profile: FriendProfile): void {
    friendStore.addFriend(profile);
    notificationService.friendOnline(userId, profile.displayName, profile.avatar);
  }

  private handleFriendOffline(userId: string): void {
    const friend = friendStore.getFriend(userId);
    if (friend) {
      friend.status = 'offline';
      friend.activity = { type: 'offline' };
      friend.lastOnline = Date.now();
      friendStore.updateMyProfile({});
    }
  }

  private handleFriendStatusChange(userId: string, status: FriendStatus, activity: FriendActivity): void {
    const friend = friendStore.getFriend(userId);
    if (friend) {
      friend.status = status;
      friend.activity = activity;
      friendStore.updateMyProfile({});
    }
  }

  private handleFriendRequest(fromUserId: string, fromUserName: string, fromAvatar: string, message?: string): void {
    friendStore.addFriendRequest({ from: fromUserId, to: '', timestamp: Date.now(), message });
    notificationService.friendRequest(fromUserId, fromUserName, fromAvatar, message);
  }

  private handleFriendRequestAccepted(userId: string, profile: FriendProfile): void {
    friendStore.addFriend(profile);
    notificationService.requestAccepted(userId, profile.displayName, profile.avatar);
    activityService.friendAdded(profile.displayName, profile.avatar, userId);
  }

  private handleFriendRemoved(userId: string): void {
    friendStore.removeFriend(userId);
  }

  private handleNotification(msg: any): void {
    if (msg.notification) {
      friendStore.addNotification(msg.notification);
    }
  }

  async apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.apiUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...options?.headers,
      },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  async searchUsers(query: string): Promise<FriendProfile[]> {
    return this.apiRequest<FriendProfile[]>(`/users/search?q=${encodeURIComponent(query)}`);
  }

  async sendFriendRequest(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async acceptFriendRequest(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async declineFriendRequest(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/decline', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async blockUser(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/block', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async unblockUser(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/unblock', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async removeFriend(userId: string): Promise<boolean> {
    return this.apiRequest<boolean>('/friends/remove', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }
}

export const networkLayer = new NetworkLayer();
