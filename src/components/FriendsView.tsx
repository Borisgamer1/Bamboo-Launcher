import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, UserPlus, UserCheck, UserX, Search, X, Check, XCircle,
  MoreHorizontal, Clock, Shield, ShieldOff,
  ExternalLink, User, Settings, Bell, Activity, Send, Loader2,
  LogIn, Ban, CheckCircle2, AlertCircle, RefreshCw,
  ChevronRight, ChevronLeft, Box, Server, Image,
} from "lucide-react";
import { LanguageType } from "../lib/translations";
import { friendStore } from "../friends/FriendStore";
import { presenceService } from "../friends/PresenceService";
import { profileService } from "../friends/ProfileService";
import { networkLayer, type ConnectionStatus } from "../friends/NetworkLayer";
import type {
  FriendProfile, FriendStatus, FriendActivity, ActivityType,
  FriendNotification, InvitationData, FriendRelation,
} from "../friends/types";
import { STATUS_LABELS, ACTIVITY_LABELS, generateId } from "../friends/types";
import { type Account } from "./TopBar";

interface FriendsViewProps {
  lang: LanguageType;
  activeAccount?: Account;
  setActiveTab?: (tab: any) => void;
}

// ===== Sub-components =====

const StatusDot: React.FC<{ status: FriendStatus; size?: number }> = ({ status, size = 10 }) => {
  const colors: Record<FriendStatus, string> = {
    online: "bg-emerald-400 shadow-emerald-500/50",
    busy: "bg-amber-400 shadow-amber-500/50",
    away: "bg-yellow-400 shadow-yellow-500/50",
    dnd: "bg-rose-400 shadow-rose-500/50",
    invisible: "bg-slate-500",
    offline: "bg-slate-600",
  };
  return (
    <span
      className={`inline-block rounded-full ${colors[status] || "bg-slate-600"} shadow-lg`}
      style={{ width: size, height: size }}
    />
  );
};

const formatTime = (ts: number | string | null): string => {
  if (!ts) return "";
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "Gerade eben";
  if (diff < 3600000) return `Vor ${Math.floor(diff / 60000)} Min.`;
  if (diff < 86400000) return `Vor ${Math.floor(diff / 3600000)} Std.`;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
};

const statusOptions: { value: FriendStatus; label: string; icon: string; desc: string }[] = [
  { value: "online", label: "Online", icon: "🟢", desc: "Online · Normale Aktivität" },
  { value: "dnd", label: "Nicht stören", icon: "🔴", desc: "Keine Benachrichtigungen" },
  { value: "away", label: "Abwesend", icon: "🟡", desc: "Automatisch nach 5 Min. AFK" },
  { value: "invisible", label: "Unsichtbar", icon: "⚫", desc: "Für andere offline erscheinen" },
];

// ===== Notification Toast Component =====
const NotificationToast: React.FC<{
  notification: FriendNotification;
  onDismiss: (id: string) => void;
}> = ({ notification, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(notification.id), 5000);
    return () => clearTimeout(timer);
  }, [notification.id, onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 60, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 60, scale: 0.9 }}
      transition={{ type: "spring", damping: 20, stiffness: 300 }}
      className="bg-slate-950/90 backdrop-blur-2xl border border-slate-800/80 rounded-2xl p-4 shadow-2xl flex items-start gap-3 pointer-events-auto max-w-sm"
    >
      <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-base shrink-0 overflow-hidden">
        {notification.fromUserAvatar?.startsWith("http") ? (
          <img src={notification.fromUserAvatar} alt="" className="w-full h-full object-cover" />
        ) : (
          <span>{notification.fromUserAvatar || "🔔"}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-slate-100 truncate">{notification.fromUserName}</p>
        <p className="text-[10px] text-slate-400 mt-0.5">{notification.message}</p>
      </div>
      <button
        onClick={() => onDismiss(notification.id)}
        className="p-1 rounded-lg hover:bg-slate-800/40 text-slate-500 hover:text-slate-300 transition-all cursor-pointer shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
};

// ===== Main Component =====

export const FriendsView = React.memo(function FriendsView({ lang, activeAccount, setActiveTab }: FriendsViewProps) {
  const [activeSection, setActiveSection] = useState<"friends" | "requests" | "search" | "profile" | "notifications" | "settings">("friends");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FriendProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<FriendProfile | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [myStatus, setMyStatus] = useState<FriendStatus>("online");
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const [friendRequests, setFriendRequests] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<FriendNotification[]>([]);
  const [profileMode, setProfileMode] = useState<"view" | "edit">("view");
  const [editBio, setEditBio] = useState("");
  // Display name is ALWAYS the Minecraft username (not editable)
  const [editCustomStatus, setEditCustomStatus] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "online" | "pending">("all");
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [toastNotifications, setToastNotifications] = useState<FriendNotification[]>([]);
  const searchTimeout = useRef<number | null>(null);
  const lastNotifCount = useRef(0);

  // ===== Check if user is offline/guest =====
  const isOfflineUser = !activeAccount || activeAccount.type === "Offline" || activeAccount.username === "BambooPlayer";
  // Also check if there's a settings account with Microsoft type
  const hasMicrosoftAccount = activeAccount?.type === "Microsoft";

  const myProfile = friendStore.getMyProfile();

  // Subscribe to store changes
  useEffect(() => {
    const unsub = friendStore.subscribe(() => {
      setFriends(friendStore.getFriends());
      setFriendRequests(friendStore.getFriendRequests());
      const newNotifs = friendStore.getNotifications();
      setNotifications(newNotifs);
      setMyStatus(presenceService.getStatus());

      // Toast for new notifications (Discord-like popups)
      if (newNotifs.length > lastNotifCount.current) {
        const newOnes = newNotifs.slice(0, newNotifs.length - lastNotifCount.current);
        newOnes.forEach(n => {
          if (!n.read) {
            setToastNotifications(prev => [...prev, n]);
          }
        });
      }
      lastNotifCount.current = newNotifs.length;
    });
    return unsub;
  }, []);

  // Connection status
  useEffect(() => {
    const unsub = networkLayer.onStatusChange(setConnectionStatus);
    return unsub;
  }, []);

  // Auto-connect if we have a token
  useEffect(() => {
    const token = localStorage.getItem("bamboo_friends_token");
    if (token && connectionStatus === "disconnected") {
      networkLayer.connect(token);
    }
  }, [connectionStatus]);

  // Sync edit fields when entering edit mode
  useEffect(() => {
    if (activeSection === "profile" && profileMode === "edit") {
      const profile = friendStore.getMyProfile();
      setEditBio(profile.bio || "");
      setEditCustomStatus(profile.customStatus || "");
    }
  }, [activeSection, profileMode]);

  // Load initial data
  useEffect(() => {
    setFriends(friendStore.getFriends());
    setFriendRequests(friendStore.getFriendRequests());
    setNotifications(friendStore.getNotifications());
  }, []);

  // Search with debounce
  const handleSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!q || q.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimeout.current = window.setTimeout(async () => {
      try {
        if (networkLayer.isConnected()) {
          const results = await networkLayer.searchUsers(q);
          setSearchResults(results.filter(r => r.id !== myProfile.id));
        } else {
          setSearchResults([]);
        }
      } catch {
        setSearchResults([]);
      }
      setIsSearching(false);
    }, 300);
  }, [myProfile.id]);

  const handleSendRequest = async (userId: string) => {
    try {
      if (networkLayer.isConnected()) {
        await networkLayer.sendFriendRequest(userId);
      } else {
        friendStore.addFriendRequest({ from: myProfile.id, to: userId, timestamp: Date.now() });
      }
      friendStore.addActivity({
        id: generateId(),
        userId: myProfile.id,
        userName: myProfile.displayName || myProfile.username,
        userAvatar: myProfile.avatar,
        type: "friend_added",
        message: `Freundschaftsanfrage gesendet.`,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.warn("[Friends] Send request error:", e);
    }
  };

  const handleAcceptRequest = async (userId: string) => {
    try {
      if (networkLayer.isConnected()) {
        await networkLayer.acceptFriendRequest(userId);
      }
      friendStore.removeFriendRequest(userId, myProfile.id);
    } catch (e) {
      console.warn("[Friends] Accept error:", e);
    }
  };

  const handleDeclineRequest = async (userId: string) => {
    try {
      if (networkLayer.isConnected()) {
        await networkLayer.declineFriendRequest(userId);
      }
      friendStore.removeFriendRequest(userId, myProfile.id);
    } catch (e) {
      console.warn("[Friends] Decline error:", e);
    }
  };

  const handleRemoveFriend = async (userId: string) => {
    try {
      if (networkLayer.isConnected()) {
        await networkLayer.removeFriend(userId);
      } else {
        friendStore.removeFriend(userId);
      }
    } catch (e) {
      console.warn("[Friends] Remove error:", e);
    }
  };

  const handleBlockUser = async (userId: string) => {
    try {
      if (networkLayer.isConnected()) {
        await networkLayer.blockUser(userId);
      } else {
        friendStore.blockUser(userId);
      }
    } catch (e) {
      console.warn("[Friends] Block error:", e);
    }
  };

  const handleStatusChange = (status: FriendStatus) => {
    presenceService.setStatus(status);
    setMyStatus(status);
    setShowStatusPicker(false);
  };

  const handleSaveProfile = () => {
    // Display name is ALWAYS the Minecraft username (not editable)
    profileService.setBio(editBio);
    profileService.setCustomStatus(editCustomStatus);
    setProfileMode("view");
  };

  // ===== Avatar picker =====
  const handleAvatarPick = async () => {
    const newAvatar = await profileService.uploadAvatar();
    if (newAvatar) {
      friendStore.notify();
    }
  };

  const dismissToast = useCallback((id: string) => {
    setToastNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const filteredFriends = friends.filter(f => {
    if (filterStatus === "online") return f.status === "online" || f.status === "busy";
    if (filterStatus === "pending") return f.status === "away" || f.status === "dnd";
    return true;
  }).filter(f =>
    !searchQuery || f.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    f.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const onlineCount = friends.filter(f => f.status === "online" || f.status === "busy").length;
  const pendingRequests = friendRequests.filter(r => r.to === myProfile.id).length;
  const unreadNotifs = notifications.filter(n => !n.read).length;

  // Theme classes
  const tc = {
    text: "theme-text",
    bg: "theme-bg-light",
    border: "theme-border-light",
    hoverBorder: "hover:theme-border-md",
    button: "theme-bg hover:theme-bg-hover text-white",
    glow: "theme-shadow-sm",
    badge: "theme-bg-md theme-text theme-border-md",
  };

  // ===== OFFLINE USER OVERRIDE =====
  if (isOfflineUser && !hasMicrosoftAccount) {
    return (
      <div className="flex-1 h-full flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md text-center"
        >
          <div className="w-20 h-20 rounded-3xl bg-slate-900/60 border border-slate-800/60 mx-auto flex items-center justify-center mb-6">
            <LogIn className="w-10 h-10 text-slate-500" />
          </div>
          <h2 className="text-2xl font-black text-white tracking-wide mb-3">
            {lang === "de" ? "Online-Funktionen" : "Online Features"}
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            {lang === "de"
              ? "Melde dich mit einem Microsoft-Konto an, um das Freundesystem, Rich Presence und alle Online-Funktionen des Bamboo Launchers zu nutzen."
              : "Sign in with a Microsoft account to use the friends system, Rich Presence, and all online features of the Bamboo Launcher."}
          </p>
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={() => setActiveTab?.("settings")}
              className="px-6 py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white transition-all cursor-pointer shadow-lg shadow-blue-500/20"
            >
              <Settings className="w-4 h-4 inline mr-2" />
              {lang === "de" ? "Zu den Kontoeinstellungen" : "Go to Account Settings"}
            </button>
            <p className="text-[10px] text-slate-500">
              {lang === "de"
                ? "Benötigt wird ein gültiger Minecraft: Java Edition Account."
                : "Requires a valid Minecraft: Java Edition account."}
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full flex overflow-hidden relative">
      {/* Notification Toasts - Discord-like */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toastNotifications.slice(0, 3).map(n => (
            <div key={n.id} className="pointer-events-auto">
              <NotificationToast notification={n} onDismiss={dismissToast} />
            </div>
          ))}
        </AnimatePresence>
      </div>

      {/* Left Sidebar */}
      <div className="w-64 lg:w-72 shrink-0 bg-slate-950/40 backdrop-blur-xl border-r border-slate-800/60 flex flex-col">
        {/* Header with status */}
        <div className="p-4 border-b border-slate-800/40">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-black text-white tracking-wide flex items-center gap-2">
              <Users className={`w-4 h-4 ${tc.text}`} />
              {lang === "de" ? "Freunde" : "Friends"}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveSection("notifications")}
                className={`relative p-2 rounded-lg transition-all cursor-pointer ${
                  activeSection === "notifications"
                    ? `${tc.bg} ${tc.text}`
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <Bell className="w-4 h-4" />
                {unreadNotifs > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-rose-500 border-2 border-slate-950 rounded-full text-[8px] font-bold text-white flex items-center justify-center">
                    {unreadNotifs > 9 ? "9+" : unreadNotifs}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveSection("settings")}
                className={`p-2 rounded-lg transition-all cursor-pointer ${
                  activeSection === "settings"
                    ? `${tc.bg} ${tc.text}`
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* My Status - Discord Style */}
          <div className="relative">
            <button
              onClick={() => setShowStatusPicker(!showStatusPicker)}
              className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60 hover:border-slate-700/60 transition-all cursor-pointer text-left"
            >
              <div className="relative shrink-0">
                <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-lg overflow-hidden">
                  {myProfile.avatar?.startsWith("http") ? (
                    <img src={myProfile.avatar} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span>{myProfile.avatar || "🎋"}</span>
                  )}
                </div>
                <span className="absolute -bottom-0.5 -right-0.5">
                  <StatusDot status={myStatus} size={8} />
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-200 truncate">
                  {myProfile.displayName || myProfile.username}
                </p>
                <p className="text-[10px] text-slate-400">
                  {myStatus === "invisible" ? "Offline" : STATUS_LABELS[myStatus]}
                </p>
              </div>
            </button>

            <AnimatePresence>
              {showStatusPicker && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-full left-0 right-0 mt-1 bg-slate-950/95 backdrop-blur-xl border border-slate-800/90 rounded-xl p-1 z-40 shadow-2xl"
                >
                  {statusOptions.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleStatusChange(opt.value)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs transition-all cursor-pointer ${
                        myStatus === opt.value
                          ? `${tc.bg} ${tc.text} font-bold`
                          : "text-slate-300 hover:bg-slate-800/40"
                      }`}
                    >
                      <span className="text-base shrink-0">{opt.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <span className="block">{opt.label}</span>
                        <span className="block text-[9px] text-slate-500">{opt.desc}</span>
                      </div>
                      {myStatus === opt.value && <Check className="w-3.5 h-3.5 ml-auto shrink-0" />}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Navigation */}
        <div className="p-2 space-y-0.5">
          <button
            onClick={() => setActiveSection("friends")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeSection === "friends"
                ? `${tc.bg} ${tc.text} font-bold`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/30"
            }`}
          >
            <Users className="w-4 h-4" />
            <span>{lang === "de" ? "Alle Freunde" : "All Friends"}</span>
            <span className="ml-auto text-[10px] text-slate-500">{friends.length}</span>
          </button>
          <button
            onClick={() => setActiveSection("requests")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeSection === "requests"
                ? `${tc.bg} ${tc.text} font-bold`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/30"
            }`}
          >
            <UserPlus className="w-4 h-4" />
            <span>{lang === "de" ? "Anfragen" : "Requests"}</span>
            {pendingRequests > 0 && (
              <span className="ml-auto bg-rose-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                {pendingRequests}
              </span>
            )}
          </button>
          <button
            onClick={() => { setActiveSection("search"); setSearchQuery(""); setSearchResults([]); }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeSection === "search"
                ? `${tc.bg} ${tc.text} font-bold`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/30"
            }`}
          >
            <Search className="w-4 h-4" />
            <span>{lang === "de" ? "Benutzer suchen" : "Search Users"}</span>
          </button>
          <button
            onClick={() => { setActiveSection("profile"); setProfileMode("view"); }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeSection === "profile"
                ? `${tc.bg} ${tc.text} font-bold`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/30"
            }`}
          >
            <User className="w-4 h-4" />
            <span>{lang === "de" ? "Mein Profil" : "My Profile"}</span>
          </button>
        </div>

        {/* Connection Status */}
        <div className="mt-auto p-3 border-t border-slate-800/40">
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span className={`w-2 h-2 rounded-full ${
              connectionStatus === "connected" ? "bg-emerald-400" :
              connectionStatus === "connecting" ? "bg-amber-400 animate-pulse" : "bg-slate-600"
            }`} />
            <span>
              {connectionStatus === "connected" ? "Verbunden" :
               connectionStatus === "connecting" ? "Verbinde..." : "Lokal"}
            </span>
            <button
              onClick={async () => {
                if (connectionStatus !== "connected") {
                  setIsConnecting(true);
                  const token = localStorage.getItem("bamboo_friends_token");
                  if (token) {
                    await networkLayer.connect(token);
                  } else {
                    networkLayer.connect("demo-token").catch(() => {});
                  }
                  setIsConnecting(false);
                } else {
                  networkLayer.disconnect();
                }
              }}
              className="ml-auto p-1 rounded hover:bg-slate-800/40 transition-all cursor-pointer disabled:opacity-50"
              disabled={isConnecting}
            >
              <RefreshCw className={`w-3 h-3 ${isConnecting ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
            className="flex-1 overflow-y-auto p-6"
          >
            {/* ===== FRIENDS LIST ===== */}
            {activeSection === "friends" && (
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-lg font-black text-white tracking-wide">
                      {lang === "de" ? "Freunde" : "Friends"}
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      {onlineCount} {lang === "de" ? "online" : "online"} · {friends.length} {lang === "de" ? "gesamt" : "total"}
                    </p>
                  </div>
                  {/* Filter chips */}
                  <div className="flex gap-1">
                    {(["all", "online", "pending"] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => setFilterStatus(f)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer ${
                          filterStatus === f
                            ? `${tc.bg} ${tc.text} ${tc.border} border`
                            : "bg-slate-900/60 text-slate-400 border border-slate-800/60 hover:text-slate-200"
                        }`}
                      >
                        {f === "all" ? (lang === "de" ? "Alle" : "All") :
                         f === "online" ? (lang === "de" ? "Online" : "Online") :
                         (lang === "de" ? "Ausstehend" : "Pending")}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredFriends.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 rounded-3xl bg-slate-900/60 border border-slate-800/60 flex items-center justify-center mb-4">
                      <Users className="w-8 h-8 text-slate-600" />
                    </div>
                    <h4 className="text-base font-bold text-slate-400 mb-2">
                      {lang === "de" ? "Keine Freunde gefunden" : "No friends found"}
                    </h4>
                    <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                      {lang === "de"
                        ? "Suche nach anderen Benutzern, um Freunde hinzuzufügen und gemeinsam zu spielen."
                        : "Search for other users to add friends and play together."}
                    </p>
                    <button
                      onClick={() => setActiveSection("search")}
                      className={`mt-4 px-5 py-2.5 rounded-xl text-xs font-bold ${tc.button} transition-all cursor-pointer shadow-lg`}
                    >
                      <UserPlus className="w-3.5 h-3.5 inline mr-1.5" />
                      {lang === "de" ? "Benutzer suchen" : "Search Users"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredFriends.filter(f => f.status === "online" || f.status === "busy").map(friend => (
                      <FriendCard
                        key={friend.id}
                        friend={friend}
                        onClick={() => setSelectedFriend(friend)}
                        onRemove={handleRemoveFriend}
                        onBlock={handleBlockUser}
                        lang={lang}
                      />
                    ))}
                    {filteredFriends.filter(f => f.status !== "online" && f.status !== "busy").map(friend => (
                      <FriendCard
                        key={friend.id}
                        friend={friend}
                        onClick={() => setSelectedFriend(friend)}
                        onRemove={handleRemoveFriend}
                        onBlock={handleBlockUser}
                        lang={lang}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ===== FRIEND REQUESTS ===== */}
            {activeSection === "requests" && (
              <div className="max-w-3xl mx-auto">
                <h3 className="text-lg font-black text-white tracking-wide mb-6">
                  {lang === "de" ? "Freundesanfragen" : "Friend Requests"}
                </h3>

                {pendingRequests === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 rounded-3xl bg-slate-900/60 border border-slate-800/60 flex items-center justify-center mb-4">
                      <UserCheck className="w-8 h-8 text-slate-600" />
                    </div>
                    <h4 className="text-base font-bold text-slate-400 mb-2">
                      {lang === "de" ? "Keine offenen Anfragen" : "No pending requests"}
                    </h4>
                    <p className="text-xs text-slate-500 max-w-xs">
                      {lang === "de"
                        ? "Wenn dir jemand eine Freundschaftsanfrage sendet, wird sie hier angezeigt."
                        : "When someone sends you a friend request, it will appear here."}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {friendRequests.filter(r => r.to === myProfile.id).map((req, i) => {
                      const fromUser = req.fromUser || {
                        id: req.from,
                        username: "Unknown",
                        displayName: "Unknown",
                        avatar: "👤",
                      };
                      return (
                        <motion.div
                          key={req.from || i}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.03 }}
                          className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-4 flex items-center gap-4"
                        >
                          <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-lg shrink-0 overflow-hidden">
                            {fromUser.avatar?.startsWith("http") ? (
                              <img src={fromUser.avatar} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <span>{fromUser.avatar || "👤"}</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-slate-100 truncate">
                              {fromUser.displayName || fromUser.username}
                            </p>
                            <p className="text-[10px] text-slate-500">
                              {formatTime(req.timestamp)}
                            </p>
                            {req.message && (
                              <p className="text-[11px] text-slate-400 mt-1 italic">"{req.message}"</p>
                            )}
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              onClick={() => handleAcceptRequest(req.from)}
                              className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all cursor-pointer"
                              title={lang === "de" ? "Annehmen" : "Accept"}
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeclineRequest(req.from)}
                              className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all cursor-pointer"
                              title={lang === "de" ? "Ablehnen" : "Decline"}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ===== SEARCH USERS ===== */}
            {activeSection === "search" && (
              <div className="max-w-3xl mx-auto">
                <h3 className="text-lg font-black text-white tracking-wide mb-4">
                  {lang === "de" ? "Benutzer suchen" : "Search Users"}
                </h3>
                <div className="relative mb-6">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => handleSearch(e.target.value)}
                    placeholder={lang === "de" ? "Nach Benutzernamen suchen..." : "Search by username..."}
                    className="w-full bg-slate-900/60 border border-slate-800/60 rounded-xl pl-10 pr-10 py-3 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-[var(--theme-accent)]/50 transition-all"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => handleSearch("")}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {isSearching ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 theme-text animate-spin" />
                  </div>
                ) : searchQuery.length > 0 && searchQuery.length < 2 ? (
                  <p className="text-xs text-slate-500 text-center py-8">
                    {lang === "de" ? "Mindestens 2 Zeichen eingeben" : "Type at least 2 characters"}
                  </p>
                ) : searchResults.length === 0 && searchQuery.length >= 2 ? (
                  <div className="flex flex-col items-center py-12 text-center">
                    <UserX className="w-10 h-10 text-slate-600 mb-3" />
                    <p className="text-sm text-slate-400 font-medium">
                      {lang === "de" ? "Keine Benutzer gefunden" : "No users found"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      "{searchQuery}"
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {searchResults.map(user => {
                      const isFriend = friends.some(f => f.id === user.id);
                      const hasRequest = friendRequests.some(r => r.from === user.id || r.to === user.id);
                      return (
                        <div
                          key={user.id}
                          className="bg-slate-900/40 backdrop-blur border border-slate-800/60 rounded-2xl p-4 flex items-center gap-4"
                        >
                          <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-lg shrink-0 overflow-hidden">
                            {user.avatar?.startsWith("http") ? (
                              <img src={user.avatar} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <span>{user.avatar || "👤"}</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-slate-100 truncate">
                              {user.displayName || user.username}
                            </p>
                            <p className="text-[10px] text-slate-500">@{user.username}</p>
                          </div>
                          {isFriend ? (
                            <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg">
                              <UserCheck className="w-3 h-3 inline mr-1" />
                              {lang === "de" ? "Freund" : "Friend"}
                            </span>
                          ) : hasRequest ? (
                            <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg">
                              {lang === "de" ? "Anfrage offen" : "Request sent"}
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSendRequest(user.id)}
                              className={`px-4 py-2 rounded-xl text-[10px] font-bold ${tc.button} transition-all cursor-pointer shadow-lg`}
                            >
                              <UserPlus className="w-3 h-3 inline mr-1" />
                              {lang === "de" ? "Hinzufügen" : "Add"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ===== PROFILE ===== */}
            {activeSection === "profile" && (
              <div className="max-w-2xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {lang === "de" ? "Mein Profil" : "My Profile"}
                  </h3>
                  <button
                    onClick={() => setProfileMode(profileMode === "view" ? "edit" : "view")}
                    className={`px-4 py-2 rounded-xl text-[10px] font-bold transition-all cursor-pointer ${
                      profileMode === "edit"
                        ? `${tc.bg} ${tc.text} border ${tc.border}`
                        : `bg-slate-900/60 border border-slate-800/60 text-slate-300 hover:text-slate-100`
                    }`}
                  >
                    {profileMode === "edit"
                      ? (lang === "de" ? "Ansicht" : "View")
                      : (lang === "de" ? "Bearbeiten" : "Edit")}
                  </button>
                </div>

                {profileMode === "edit" ? (
                  <div className="space-y-4">
                    {/* Avatar selection */}
                    <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3 block">
                        {lang === "de" ? "Profilbild" : "Avatar"}
                      </label>
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-slate-800 border-2 border-slate-700/60 flex items-center justify-center text-2xl overflow-hidden shrink-0">
                          {myProfile.avatar?.startsWith("http") ? (
                            <img src={myProfile.avatar} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <span>{myProfile.avatar || "🎋"}</span>
                          )}
                        </div>
                        <button
                          onClick={handleAvatarPick}
                          className="px-4 py-2.5 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700/60 text-slate-200 transition-all cursor-pointer flex items-center gap-2"
                        >
                          <Image className="w-4 h-4" />
                          {lang === "de" ? "Bild auswählen" : "Choose Image"}
                        </button>
                      </div>
                    </div>

                    <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 block">
                        {lang === "de" ? "Anzeigename (Minecraft-Username)" : "Display Name (Minecraft Username)"}
                      </label>
                      <div className="w-full bg-slate-950 border border-slate-800/60 rounded-xl px-4 py-2.5 text-sm text-slate-400 flex items-center gap-2">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        {myProfile.username}
                      </div>
                      <p className="text-[10px] text-slate-500 mt-1">
                        {lang === "de" ? "Der Anzeigename ist immer dein Minecraft-Username und kann nicht geändert werden." : "Display name is always your Minecraft username and cannot be changed."}
                      </p>
                    </div>
                    <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 block">
                        {lang === "de" ? "Status" : "Custom Status"}
                      </label>
                      <input
                        type="text"
                        value={editCustomStatus}
                        onChange={e => setEditCustomStatus(e.target.value)}
                        maxLength={64}
                        placeholder={lang === "de" ? "Was machst du gerade?" : "What are you up to?"}
                        className="w-full bg-slate-950 border border-slate-800/60 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-[var(--theme-accent)]/50 transition-all"
                      />
                    </div>
                    <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 block">
                        {lang === "de" ? "Über mich" : "Bio"}
                      </label>
                      <textarea
                        value={editBio}
                        onChange={e => setEditBio(e.target.value)}
                        maxLength={280}
                        rows={3}
                        placeholder={lang === "de" ? "Erzähle etwas über dich..." : "Tell something about yourself..."}
                        className="w-full bg-slate-950 border border-slate-800/60 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-[var(--theme-accent)]/50 transition-all resize-none"
                      />
                      <p className="text-[10px] text-slate-500 mt-1 text-right">{editBio.length}/280</p>
                    </div>
                    <button
                      onClick={handleSaveProfile}
                      className={`w-full py-3 rounded-xl text-sm font-bold ${tc.button} transition-all cursor-pointer shadow-lg`}
                    >
                      <Check className="w-4 h-4 inline mr-2" />
                      {lang === "de" ? "Speichern" : "Save"}
                    </button>
                  </div>
                ) : (
                  <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl overflow-hidden">
                    {/* Banner */}
                    <div
                      className="h-32 bg-gradient-to-r from-slate-800 to-slate-700 relative"
                      style={myProfile.banner ? { backgroundImage: `url(${myProfile.banner})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
                    >
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />
                    </div>
                    {/* Avatar */}
                    <div className="relative px-6">
                      <div className="w-20 h-20 rounded-2xl bg-slate-800 border-4 border-slate-950 flex items-center justify-center text-3xl -mt-10 overflow-hidden shadow-xl">
                        {myProfile.avatar?.startsWith("http") ? (
                          <img src={myProfile.avatar} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span>{myProfile.avatar || "🎋"}</span>
                        )}
                      </div>
                    </div>
                    {/* Info */}
                    <div className="p-6 pt-4">
                      <div className="flex items-center gap-3 mb-1">
                        <h4 className="text-xl font-black text-white">
                          {myProfile.displayName || myProfile.username}
                        </h4>
                        <StatusDot status={myStatus} size={10} />
                      </div>
                      <p className="text-xs text-slate-500 mb-3">@{myProfile.username}</p>
                      {editCustomStatus && (
                        <p className="text-sm text-slate-300 italic mb-3">"{editCustomStatus}"</p>
                      )}
                      {editBio && (
                        <p className="text-sm text-slate-400 leading-relaxed mb-4">{editBio}</p>
                      )}

                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-slate-950/50 border border-slate-800/60 rounded-xl p-3 text-center">
                          <p className="text-lg font-black text-white">{friends.length}</p>
                          <p className="text-[10px] text-slate-400">{lang === "de" ? "Freunde" : "Friends"}</p>
                        </div>
                        <div className="bg-slate-950/50 border border-slate-800/60 rounded-xl p-3 text-center">
                          <p className="text-lg font-black text-white">{onlineCount}</p>
                          <p className="text-[10px] text-slate-400">{lang === "de" ? "Online" : "Online"}</p>
                        </div>
                        <div className="bg-slate-950/50 border border-slate-800/60 rounded-xl p-3 text-center">
                          <p className="text-lg font-black text-white">{myProfile.launcherLevel || 1}</p>
                          <p className="text-[10px] text-slate-400">{lang === "de" ? "Level" : "Level"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ===== NOTIFICATIONS ===== */}
            {activeSection === "notifications" && (
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {lang === "de" ? "Benachrichtigungen" : "Notifications"}
                  </h3>
                  {unreadNotifs > 0 && (
                    <button
                      onClick={() => { friendStore.markAllNotificationsRead(); }}
                      className={`text-[10px] font-bold ${tc.text} hover:opacity-80 transition-all cursor-pointer`}
                    >
                      {lang === "de" ? "Alle gelesen" : "Mark all read"}
                    </button>
                  )}
                </div>

                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center py-20 text-center">
                    <div className="w-16 h-16 rounded-3xl bg-slate-900/60 border border-slate-800/60 flex items-center justify-center mb-4">
                      <Bell className="w-8 h-8 text-slate-600" />
                    </div>
                    <h4 className="text-base font-bold text-slate-400 mb-2">
                      {lang === "de" ? "Keine Benachrichtigungen" : "No notifications"}
                    </h4>
                    <p className="text-xs text-slate-500 max-w-xs">
                      {lang === "de"
                        ? "Benachrichtigungen über Freundesaktivitäten erscheinen hier."
                        : "Notifications about friend activities will appear here."}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {notifications.map(n => (
                      <div
                        key={n.id}
                        onClick={() => friendStore.markNotificationRead(n.id)}
                        className={`rounded-2xl p-4 flex items-start gap-3 cursor-pointer transition-all ${
                          n.read
                            ? "bg-slate-900/20 border border-slate-800/40"
                            : `bg-slate-900/40 border border-slate-800/60 ${tc.border}`
                        }`}
                      >
                        <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-base shrink-0 overflow-hidden">
                          {n.fromUserAvatar?.startsWith("http") ? (
                            <img src={n.fromUserAvatar} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <span>{n.fromUserAvatar || "🔔"}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs ${n.read ? "text-slate-400" : "text-slate-200 font-bold"}`}>
                            {n.message}
                          </p>
                          <p className="text-[10px] text-slate-500 mt-1">{formatTime(n.timestamp)}</p>
                        </div>
                        {!n.read && (
                          <span className="w-2 h-2 rounded-full theme-bg shrink-0 mt-2" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ===== SETTINGS ===== */}
            {activeSection === "settings" && (
              <div className="max-w-2xl mx-auto">
                <h3 className="text-lg font-black text-white tracking-wide mb-6">
                  {lang === "de" ? "Freundes-Einstellungen" : "Friends Settings"}
                </h3>
                <div className="space-y-4">
                  <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                    <h4 className="text-sm font-bold text-slate-200 mb-3">
                      {lang === "de" ? "Privatsphäre" : "Privacy"}
                    </h4>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-200 font-medium">
                            {lang === "de" ? "Profil sichtbar für" : "Profile visible to"}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {lang === "de" ? "Wer kann dein Profil sehen?" : "Who can see your profile?"}
                          </p>
                        </div>
                        <select
                          value={friendStore.getPrivacySettings().profileVisible}
                          onChange={e => { friendStore.updatePrivacySettings({ profileVisible: e.target.value as any }); }}
                          className="bg-slate-950 border border-slate-800/60 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none cursor-pointer"
                        >
                          <option value="everyone">{lang === "de" ? "Alle" : "Everyone"}</option>
                          <option value="friends">{lang === "de" ? "Nur Freunde" : "Friends only"}</option>
                          <option value="nobody">{lang === "de" ? "Niemand" : "Nobody"}</option>
                        </select>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-200 font-medium">
                            {lang === "de" ? "Freundschaftsanfragen" : "Friend requests"}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {lang === "de" ? "Wer kann dir Anfragen senden?" : "Who can send you requests?"}
                          </p>
                        </div>
                        <select
                          value={friendStore.getPrivacySettings().whoCanAdd}
                          onChange={e => { friendStore.updatePrivacySettings({ whoCanAdd: e.target.value as any }); }}
                          className="bg-slate-950 border border-slate-800/60 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none cursor-pointer"
                        >
                          <option value="everyone">{lang === "de" ? "Alle" : "Everyone"}</option>
                          <option value="nobody">{lang === "de" ? "Niemand" : "Nobody"}</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5">
                    <h4 className="text-sm font-bold text-slate-200 mb-3">
                      {lang === "de" ? "Verbindung" : "Connection"}
                    </h4>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-slate-200 font-medium">
                          {lang === "de" ? "Server-Status" : "Server Status"}
                        </p>
                        <p className={`text-[10px] flex items-center gap-1.5 mt-1 ${
                          connectionStatus === "connected" ? "text-emerald-400" :
                          connectionStatus === "connecting" ? "text-amber-400" : "text-slate-500"
                        }`}>
                          <span className={`w-2 h-2 rounded-full ${
                            connectionStatus === "connected" ? "bg-emerald-400" :
                            connectionStatus === "connecting" ? "bg-amber-400 animate-pulse" : "bg-slate-600"
                          }`} />
                          {connectionStatus === "connected" ? "Connected" :
                           connectionStatus === "connecting" ? "Connecting..." : "Local Mode"}
                        </p>
                      </div>
                      <button
                        onClick={async () => {
                          if (connectionStatus !== "connected") {
                            const token = localStorage.getItem("bamboo_friends_token");
                            if (token) await networkLayer.connect(token);
                            else networkLayer.connect("demo-token").catch(() => {});
                          } else {
                            networkLayer.disconnect();
                          }
                        }}
                        className={`px-4 py-2 rounded-xl text-[10px] font-bold transition-all cursor-pointer ${
                          connectionStatus === "connected"
                            ? "bg-rose-500/10 border border-rose-500/20 text-rose-400"
                            : `bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 ${tc.text}`
                        }`}
                      >
                        {connectionStatus === "connected"
                          ? (lang === "de" ? "Trennen" : "Disconnect")
                          : (lang === "de" ? "Verbinden" : "Connect")}
                      </button>
                    </div>

                    {/* P2P Status */}
                    <div className="mt-4 pt-4 border-t border-slate-800/40">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-200 font-medium">
                            P2P {lang === "de" ? "Verbindungen" : "Connections"}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {lang === "de" ? "Direkte Verbindungen zu Freunden" : "Direct connections to friends"}
                          </p>
                        </div>
                        <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg">
                          {lang === "de" ? "Vorbereitet" : "Prepared"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Friend Detail Side Panel */}
      <AnimatePresence>
        {selectedFriend && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="w-80 lg:w-96 shrink-0 bg-slate-950/60 backdrop-blur-2xl border-l border-slate-800/60 flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-800/40">
              <button
                onClick={() => setSelectedFriend(null)}
                className="p-1.5 rounded-lg hover:bg-slate-800/40 text-slate-400 hover:text-slate-200 transition-all cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <h4 className="text-xs font-bold text-slate-400">
                {lang === "de" ? "Profil" : "Profile"}
              </h4>
              <div className="w-8" />
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <div
                className="h-24 rounded-2xl bg-gradient-to-r from-slate-800 to-slate-700 relative mb-12"
                style={selectedFriend.banner ? { backgroundImage: `url(${selectedFriend.banner})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
              >
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent rounded-2xl" />
              </div>

              <div className="relative -mt-14 mb-4 px-2">
                <div className="w-16 h-16 rounded-2xl bg-slate-800 border-4 border-slate-950 flex items-center justify-center text-2xl overflow-hidden shadow-xl">
                  {selectedFriend.avatar?.startsWith("http") ? (
                    <img src={selectedFriend.avatar} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span>{selectedFriend.avatar || "👤"}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-lg font-black text-white">
                  {selectedFriend.displayName || selectedFriend.username}
                </h4>
                <StatusDot status={selectedFriend.status} size={8} />
              </div>
              <p className="text-xs text-slate-500 mb-2">@{selectedFriend.username}</p>

              {selectedFriend.customStatus && (
                <p className="text-sm text-slate-300 italic mb-3">"{selectedFriend.customStatus}"</p>
              )}

              {selectedFriend.activity && selectedFriend.activity.type !== "offline" && (
                <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3 mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Activity className="w-3.5 h-3.5 theme-text" />
                    <span className="text-[11px] font-bold text-slate-200">
                      {ACTIVITY_LABELS[selectedFriend.activity.type] || selectedFriend.activity.type}
                    </span>
                  </div>
                  {selectedFriend.activity.profileName && (
                    <p className="text-[10px] text-slate-400">
                      {lang === "de" ? "Spielt" : "Playing"}: {selectedFriend.activity.profileName}
                    </p>
                  )}
                  {selectedFriend.activity.minecraftVersion && (
                    <p className="text-[10px] text-slate-500">
                      MC {selectedFriend.activity.minecraftVersion}
                      {selectedFriend.activity.loader ? ` · ${selectedFriend.activity.loader}` : ""}
                    </p>
                  )}
                  {selectedFriend.activity.sessionStart && (
                    <p className="text-[10px] text-slate-500">
                      {lang === "de" ? "Sitzung seit" : "Session since"}: {formatTime(selectedFriend.activity.sessionStart)}
                    </p>
                  )}
                </div>
              )}

              {selectedFriend.bio && (
                <p className="text-xs text-slate-400 leading-relaxed mb-4">{selectedFriend.bio}</p>
              )}

              {/* Show "Zuletzt online" for offline friends */}
              {(selectedFriend.status === "offline" || selectedFriend.status === "invisible") && selectedFriend.lastOnline && (
                <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-3 mb-4 text-center">
                  <p className="text-[10px] text-slate-500">
                    {lang === "de" ? "Zuletzt online" : "Last online"}: {formatTime(selectedFriend.lastOnline)}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-3 text-center">
                  <p className="text-base font-black text-white">{selectedFriend.friendCount}</p>
                  <p className="text-[9px] text-slate-500">{lang === "de" ? "Freunde" : "Friends"}</p>
                </div>
                <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-3 text-center">
                  <p className="text-base font-black text-white">{selectedFriend.launcherLevel || 1}</p>
                  <p className="text-[9px] text-slate-500">{lang === "de" ? "Level" : "Level"}</p>
                </div>
                <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl p-3 text-center">
                  <p className="text-base font-black text-white">{selectedFriend.badges?.length || 0}</p>
                  <p className="text-[9px] text-slate-500">{lang === "de" ? "Abzeichen" : "Badges"}</p>
                </div>
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => { handleRemoveFriend(selectedFriend.id); setSelectedFriend(null); }}
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all cursor-pointer"
                >
                  <UserX className="w-3.5 h-3.5 inline mr-1.5" />
                  {lang === "de" ? "Freund entfernen" : "Remove Friend"}
                </button>
                <button
                  onClick={() => { handleBlockUser(selectedFriend.id); setSelectedFriend(null); }}
                  className="w-full py-2.5 rounded-xl text-xs font-bold bg-slate-900/60 border border-slate-800/60 text-slate-400 hover:text-rose-400 hover:border-rose-500/30 transition-all cursor-pointer"
                >
                  <Ban className="w-3.5 h-3.5 inline mr-1.5" />
                  {lang === "de" ? "Blockieren" : "Block"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// ===== Friend Card =====
interface FriendCardProps {
  friend: FriendProfile;
  onClick: () => void;
  onRemove: (id: string) => void;
  onBlock: (id: string) => void;
  lang: LanguageType;
}

const FriendCard = React.memo(function FriendCard({ friend, onClick, onRemove, onBlock, lang }: FriendCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const getActivityText = (friend: FriendProfile): string => {
    const { activity, status } = friend;
    if (!activity || activity.type === "offline") {
      if (status === "offline" || status === "invisible") {
        return friend.lastOnline ? `Zuletzt online: ${formatTime(friend.lastOnline)}` : "Offline";
      }
      return "";
    }
    let label = ACTIVITY_LABELS[activity.type] || activity.type;
    let parts: string[] = [];
    if (activity.type === "playing_minecraft") {
      if (activity.profileName) parts.push(`Spielt ${activity.profileName}`);
      else parts.push("Spielt Minecraft");
      if (activity.minecraftVersion) parts.push(`MC ${activity.minecraftVersion}`);
      if (activity.loader) parts.push(activity.loader);
    } else if (activity.type === "in_launcher") {
      parts = ["Im Launcher"];
    } else {
      parts = [label];
      if (activity.detail) parts.push(activity.detail);
    }
    return parts.join(" · ");
  };

  const getSessionDuration = (activity: FriendActivity): string => {
    if (!activity?.sessionStart) return "";
    const mins = Math.floor((Date.now() - activity.sessionStart) / 60000);
    if (mins < 1) return "< 1 Min.";
    if (mins < 60) return `${mins} Min.`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  };

  // For invisible friends, show the offline indicator publicly
  const displayStatus = friend.status === "invisible" ? "offline" : friend.status;

  return (
    <div
      onClick={onClick}
      className="group flex items-center gap-3 p-3 rounded-2xl border border-transparent hover:bg-slate-900/40 hover:border-slate-800/60 transition-all cursor-pointer"
    >
      <div className="relative shrink-0">
        <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center text-lg overflow-hidden">
          {friend.avatar?.startsWith("http") ? (
            <img src={friend.avatar} alt="" className="w-full h-full object-cover" />
          ) : (
            <span>{friend.avatar || "👤"}</span>
          )}
        </div>
        <span className="absolute -bottom-0.5 -right-0.5">
          <StatusDot status={displayStatus} size={8} />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-slate-100 truncate">
            {friend.displayName || friend.username}
          </p>
          {friend.customStatus && (
            <span className="text-[10px] text-slate-500 italic truncate hidden lg:inline">
              "{friend.customStatus}"
            </span>
          )}
        </div>
        <p className="text-[10px] text-slate-400 truncate">
          {getActivityText(friend)}
        </p>
        {friend.activity?.type === 'playing_minecraft' && friend.activity.sessionStart && (
          <p className="text-[9px] text-slate-500">
            🕐 {getSessionDuration(friend.activity)}
          </p>
        )}
      </div>
      <div className="relative shrink-0">
        <button
          onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-slate-800/40 text-slate-400 hover:text-slate-200 transition-all cursor-pointer"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
        <AnimatePresence>
          {showMenu && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: -5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -5 }}
              transition={{ duration: 0.1 }}
              className="absolute right-0 top-full mt-1 bg-slate-950/95 backdrop-blur-xl border border-slate-800/90 rounded-xl p-1 z-50 shadow-2xl w-40"
            >
              <button
                onClick={e => { e.stopPropagation(); onRemove(friend.id); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-rose-500/10 hover:text-rose-400 transition-all cursor-pointer"
              >
                <UserX className="w-3.5 h-3.5" />
                {lang === "de" ? "Entfernen" : "Remove"}
              </button>
              <button
                onClick={e => { e.stopPropagation(); onBlock(friend.id); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-rose-500/10 hover:text-rose-400 transition-all cursor-pointer"
              >
                <Ban className="w-3.5 h-3.5" />
                {lang === "de" ? "Blockieren" : "Block"}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});

export default FriendsView;
