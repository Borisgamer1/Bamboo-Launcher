import React, { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Newspaper, Search, Calendar, User, Timer, Pin, ChevronRight,
  ArrowLeft, RefreshCw, BookOpen, AlertTriangle, Clock, Tag,
} from "lucide-react";
import { ThemeType } from "./ParticleBackground";
import { LanguageType, translations } from "../lib/translations";
import { API_BASE } from "../services/api";

// ===== Types =====
interface NewsItem {
  id: string; title: string; subtitle: string; content: string;
  bannerUrl: string; category: string; author: string;
  publishedAt: string | null; createdAt: string; updatedAt: string;
  isVisible: boolean; isPinned: boolean; gameVersion: string;
  tags: string[]; sortOrder: number;
}

interface EventItem {
  id: string; title: string; subtitle: string; description: string;
  bannerUrl: string; category: string; startDate: string; endDate: string | null;
  isActive: boolean; isVisible: boolean; priority: number; author: string;
}

// ===== Constants =====
const NEWS_CATEGORIES = [
  { id: "all", label: { de: "Alle", en: "All" } },
  { id: "update", label: { de: "Updates", en: "Updates" } },
  { id: "event", label: { de: "Events", en: "Events" } },
  { id: "announcement", label: { de: "Ankündigungen", en: "Announcements" } },
  { id: "maintenance", label: { de: "Wartung", en: "Maintenance" } },
  { id: "community", label: { de: "Community", en: "Community" } },
  { id: "guide", label: { de: "Guides", en: "Guides" } },
  { id: "general", label: { de: "Allgemein", en: "General" } },
];

const CATEGORY_EMOJI: Record<string, string> = {
  seasonal: "🎄", community: "👥", competition: "🏆", update: "🔄", sale: "💰", special: "⭐", general: "📅",
};

function CountdownTimer({ targetDate, lang }: { targetDate: string; lang: LanguageType }) {
  const [timeLeft, setTimeLeft] = useState("");
  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const diff = new Date(targetDate).getTime() - now;
      if (diff <= 0) { setTimeLeft(lang === "de" ? "Jetzt live!" : "Live now!"); return; }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${days > 0 ? days + "d " : ""}${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [targetDate, lang]);
  if (!timeLeft) return null;
  const isLive = timeLeft === (lang === "de" ? "Jetzt live!" : "Live now!");
  return (
    <span className={`flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-lg ${isLive ? "bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-pulse" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"}`}>
      <Timer className="w-3 h-3" /> {timeLeft}
    </span>
  );
}

interface Props {
  theme: ThemeType;
  lang: LanguageType;
}

export const NewsEventsView: React.FC<Props> = ({ theme, lang }) => {
  const t = translations[lang];
  const [view, setView] = useState<"list" | "news-detail">("list");
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null);

  // News state
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  // Events state
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const fetchNews = useCallback(async () => {
    setNewsLoading(true);
    setNewsError(null);
    try {
      const url = new URL(`${API_BASE}/content/news`);
      url.searchParams.set("active", "true");
      url.searchParams.set("limit", "50");
      if (activeCategory !== "all") url.searchParams.set("category", activeCategory);
      if (search) url.searchParams.set("search", search);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNews(data.data || []);
    } catch (err: any) { setNewsError(err.message); setNews([]); }
    finally { setNewsLoading(false); }
  }, [activeCategory, search]);

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const url = new URL(`${API_BASE}/content/event`);
      url.searchParams.set("active", "true");
      url.searchParams.set("limit", "20");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.data || []);
    } catch (err: any) { setEventsError(err.message); }
    finally { setEventsLoading(false); }
  }, []);

  useEffect(() => { fetchNews(); }, [fetchNews]);
  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const formatDate = (d: string | null) => {
    if (!d) return "";
    return new Date(d).toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { day: "numeric", month: "short", year: "numeric" });
  };

  const getCatLabel = (cat: string) => {
    const f = NEWS_CATEGORIES.find(c => c.id === cat);
    return f ? f.label[lang] || cat : cat;
  };

  const pinnedNews = useMemo(() => news.filter(n => n.isPinned), [news]);
  const unpinnedNews = useMemo(() => news.filter(n => !n.isPinned), [news]);

  const now = Date.now();
  const activeEvents = useMemo(() => events.filter(e => e.isActive && new Date(e.startDate).getTime() <= now && (!e.endDate || new Date(e.endDate).getTime() >= now)).sort((a, b) => b.priority - a.priority), [events]);
  const upcomingEvents = useMemo(() => events.filter(e => new Date(e.startDate).getTime() > now).sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()), [events]);

  // Theme colors – automatisch via CSS-Variablen an das aktuelle Theme angepasst
  const c = {
    accent: "theme-text",
    bg: "theme-bg-light",
    border: "theme-border-light",
    btn: "theme-bg hover:theme-bg-hover text-slate-950",
  };

  // ===== News Detail View =====
  if (view === "news-detail" && selectedNews) {
    return (
      <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-4 custom-scrollbar z-10 relative select-none">
        <button onClick={() => { setView("list"); setSelectedNews(null); }} className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer w-fit">
          <ArrowLeft className="w-4 h-4" /> {lang === "de" ? "Zurück zur Übersicht" : "Back to overview"}
        </button>
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl overflow-hidden shadow-2xl">
          {selectedNews.bannerUrl && (
            <div className="relative h-48 md:h-64 overflow-hidden">
              <img src={selectedNews.bannerUrl} alt={selectedNews.title} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent" />
            </div>
          )}
          <div className="p-6 md:p-8">
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg ${c.bg} ${c.accent} ${c.border} border`}>{getCatLabel(selectedNews.category)}</span>
              {selectedNews.isPinned && <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-lg flex items-center gap-1"><Pin className="w-3 h-3" /> {lang === "de" ? "Angepinnt" : "Pinned"}</span>}
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white tracking-wide mb-2">{selectedNews.title}</h1>
            {selectedNews.subtitle && <p className="text-base text-slate-400 font-medium mb-6">{selectedNews.subtitle}</p>}
            <div className="flex items-center gap-4 text-xs text-slate-500 mb-6 pb-6 border-b border-slate-800/60">
              <span className="flex items-center gap-1.5"><User className="w-3.5 h-3.5" /> {selectedNews.author}</span>
              <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> {formatDate(selectedNews.publishedAt)}</span>
            </div>
            <div className="news-content prose prose-invert max-w-none text-sm text-slate-300 leading-relaxed" dangerouslySetInnerHTML={{ __html: selectedNews.content }} />
            {selectedNews.tags.length > 0 && (
              <div className="flex items-center gap-2 mt-8 pt-6 border-t border-slate-800/60 flex-wrap">
                <Tag className="w-4 h-4 text-slate-500" />
                {selectedNews.tags.map((tag, i) => <span key={i} className="text-[10px] font-bold text-slate-400 bg-slate-900/40 border border-slate-800 px-2.5 py-1 rounded-lg">{tag}</span>)}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  // ===== Combined List View =====
  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      {/* Header */}
      <div className="flex flex-col gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-2xl ${c.bg} ${c.border} border flex items-center justify-center`}>
            <Newspaper className={`w-6 h-6 ${c.accent}`} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide">{lang === "de" ? "Neuigkeiten & Events" : "News & Events"}</h2>
            <p className="text-xs text-slate-400 mt-1">{lang === "de" ? "Updates, Ankündigungen und zeitlich begrenzte Events." : "Updates, announcements, and limited-time events."}</p>
          </div>
        </div>
        {/* Search & Category Filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={lang === "de" ? "News durchsuchen..." : "Search news..."} className="w-full bg-slate-950/40 border border-slate-800/80 rounded-xl py-2.5 pl-10 pr-4 text-xs text-slate-200 placeholder-slate-500 outline-none transition-all focus:border-[var(--theme-accent)]/50" />
          </div>
          <div className="flex gap-1.5 overflow-x-auto">
            {NEWS_CATEGORIES.map(cat => (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)} className={`px-3 py-2 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all border cursor-pointer ${activeCategory === cat.id ? `${c.bg} ${c.border} ${c.accent} border-current/20` : "bg-slate-900/20 border-slate-800/50 text-slate-400 hover:text-slate-200"}`}>
                {cat.label[lang] || cat.id}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ===== NEWS SECTION ===== */}
      <div>
        <h3 className={`text-sm font-black ${c.accent} uppercase tracking-widest mb-4 flex items-center gap-2`}>
          <span className="w-2 h-2 rounded-full bg-current" /> {lang === "de" ? "Neuigkeiten" : "News"}
        </h3>

        {newsLoading ? (
          <div className="flex items-center justify-center py-12"><RefreshCw className={`w-6 h-6 ${c.accent} animate-spin`} /></div>
        ) : newsError ? (
          <div className="text-center py-8"><AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-2" /><p className="text-xs text-slate-400">{newsError}</p></div>
        ) : news.length === 0 ? (
          <div className="text-center py-8"><BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" /><p className="text-xs text-slate-400">{lang === "de" ? "Keine News verfügbar" : "No news available"}</p></div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Pinned Hero Cards */}
            {pinnedNews.map(item => (
              <motion.div key={item.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                onClick={() => { setSelectedNews(item); setView("news-detail"); }}
                className={`relative rounded-3xl overflow-hidden border cursor-pointer group transition-all duration-300 hover:shadow-2xl ${c.border} bg-slate-950/45 backdrop-blur-xl`}>
                {item.bannerUrl && <div className="absolute inset-0"><img src={item.bannerUrl} alt="" className="w-full h-full object-cover opacity-25 group-hover:opacity-35 transition-opacity" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} /></div>}
                <div className="relative p-6 md:p-8 flex gap-6 items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${c.bg} ${c.accent} border ${c.border}`}>{getCatLabel(item.category)}</span>
                      <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded flex items-center gap-1"><Pin className="w-3 h-3" /> {lang === "de" ? "Angepinnt" : "Pinned"}</span>
                    </div>
                    <h3 className="text-lg font-black text-white group-hover:text-[var(--theme-accent)] transition-colors">{item.title}</h3>
                    {item.subtitle && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{item.subtitle}</p>}
                    <div className="flex items-center gap-3 mt-3 text-[10px] text-slate-500">
                      <span className="flex items-center gap-1"><User className="w-3 h-3" /> {item.author}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {formatDate(item.publishedAt)}</span>
                    </div>
                  </div>
                  <ChevronRight className={`w-6 h-6 ${c.accent} group-hover:translate-x-1 transition-transform shrink-0`} />
                </div>
              </motion.div>
            ))}

            {/* Regular News Grid */}
            {unpinnedNews.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {unpinnedNews.map((item, idx) => (
                  <motion.div key={item.id} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}
                    onClick={() => { setSelectedNews(item); setView("news-detail"); }}
                    className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5 group cursor-pointer hover:border-[var(--theme-accent)]/30 hover:shadow-xl transition-all">
                    {item.bannerUrl && <div className="h-32 rounded-xl overflow-hidden mb-4 border border-slate-800/60"><img src={item.bannerUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} /></div>}
                    <div className="flex items-center gap-2 mb-2"><span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded ${c.bg} ${c.accent} border ${c.border}`}>{getCatLabel(item.category)}</span></div>
                    <h3 className="text-sm font-black text-slate-100 group-hover:text-[var(--theme-accent)] transition-colors line-clamp-2">{item.title}</h3>
                    {item.subtitle && <p className="text-[11px] text-slate-400 mt-1.5 line-clamp-2">{item.subtitle}</p>}
                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-800/40">
                      <span className="flex items-center gap-1 text-[10px] text-slate-500"><Calendar className="w-3 h-3" /> {formatDate(item.publishedAt)}</span>
                      <span className={`text-[10px] font-bold ${c.accent} group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5`}>{lang === "de" ? "Lesen" : "Read"} <ChevronRight className="w-3 h-3" /></span>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-slate-800/40" />

      {/* ===== EVENTS SECTION ===== */}
      <div>
        <h3 className={`text-sm font-black ${c.accent} uppercase tracking-widest mb-4 flex items-center gap-2`}>
          <span className="w-2 h-2 rounded-full bg-current animate-pulse" /> {lang === "de" ? "Events" : "Events"}
        </h3>

        {eventsLoading ? (
          <div className="flex items-center justify-center py-8"><RefreshCw className={`w-5 h-5 ${c.accent} animate-spin`} /></div>
        ) : eventsError ? (
          <div className="text-center py-8"><p className="text-xs text-slate-400">{eventsError}</p></div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Active Events */}
            {activeEvents.length > 0 && (
              <div>
                <h4 className="text-xs font-bold text-rose-400 uppercase tracking-wider mb-3">{lang === "de" ? "Aktive Events" : "Active Events"}</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activeEvents.map((item, idx) => (
                    <motion.div key={item.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}
                      className={`relative rounded-2xl overflow-hidden border ${c.border} bg-slate-950/45 backdrop-blur-xl group transition-all duration-300 hover:shadow-xl`}>
                      {item.bannerUrl && <div className="h-32 overflow-hidden"><img src={item.bannerUrl} alt={item.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} /></div>}
                      <div className="p-5">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${c.bg} ${c.accent} border ${c.border}`}>{CATEGORY_EMOJI[item.category] || "📅"} {item.category}</span>
                          <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded">LIVE</span>
                        </div>
                        <h3 className="text-base font-black text-white tracking-wide">{item.title}</h3>
                        {item.subtitle && <p className="text-xs text-slate-400 mt-1">{item.subtitle}</p>}
                        <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
                          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {formatDate(item.startDate)}{item.endDate ? ` – ${formatDate(item.endDate)}` : ""}</span>
                          {item.endDate && <CountdownTimer targetDate={item.endDate} lang={lang} />}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming Events */}
            {upcomingEvents.length > 0 && (
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">{lang === "de" ? "Kommende Events" : "Upcoming Events"}</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {upcomingEvents.map((item, idx) => (
                    <motion.div key={item.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}
                      className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-5 group hover:border-slate-700/60 transition-all">
                      <div className={`w-10 h-10 rounded-xl ${c.bg} ${c.border} border flex items-center justify-center mb-3`}>{CATEGORY_EMOJI[item.category] || "📅"}</div>
                      <h3 className="text-sm font-black text-slate-100 tracking-wide">{item.title}</h3>
                      {item.subtitle && <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{item.subtitle}</p>}
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-800/40">
                        <span className="flex items-center gap-1 text-[10px] text-slate-500"><Calendar className="w-3 h-3" /> {formatDate(item.startDate)}</span>
                        <span className="flex-1" />
                        <CountdownTimer targetDate={item.startDate} lang={lang} />
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* No events at all */}
            {activeEvents.length === 0 && upcomingEvents.length === 0 && !eventsLoading && (
              <div className="text-center py-8"><Calendar className="w-8 h-8 text-slate-600 mx-auto mb-2" /><p className="text-xs text-slate-400">{lang === "de" ? "Keine Events" : "No events"}</p></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
