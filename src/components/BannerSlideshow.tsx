import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { API_BASE } from "../services/api";

interface BannerItem {
  id: string;
  title: string;
  imageUrl: string;
  description: string;
  clickTarget: string;
  clickType: string;
  isActive: boolean;
}

interface BannerSlideshowProps {
  accentText?: string;
  accentBg?: string;
}

export const BannerSlideshow = React.memo(function BannerSlideshow({ accentText = "text-emerald-400", accentBg = "bg-emerald-500/10" }: BannerSlideshowProps) {
  const [banners, setBanners] = useState<BannerItem[]>([]);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchBanners = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/content/banner?active=true`);
      if (!res.ok) return;
      const data = await res.json();
      setBanners(data.data || []);
    } catch { console.warn('[Banner] Failed to fetch banners'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchBanners(); }, [fetchBanners]);

  // Auto-rotate every 6 seconds
  useEffect(() => {
    if (banners.length <= 1) return;
    const interval = setInterval(() => {
      setCurrent(prev => (prev + 1) % banners.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [banners.length]);

  const handleClick = (banner: BannerItem) => {
    if (!banner.clickTarget || banner.clickType === "none") return;
    if (banner.clickType === "external") {
      window.open(banner.clickTarget, "_blank", "noopener");
    } else {
      // Internal - could be a launcher tab or route
      window.location.hash = banner.clickTarget;
    }
  };

  if (loading || banners.length === 0) return null;

  const prevSlide = () => setCurrent(p => (p === 0 ? banners.length - 1 : p - 1));
  const nextSlide = () => setCurrent(p => (p + 1) % banners.length);

  return (
    <div className="relative w-full rounded-2xl overflow-hidden group h-40 md:h-48 bg-slate-900/40 border border-slate-800/60">
      <AnimatePresence mode="wait">
        <motion.div
          key={banners[current].id}
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -40 }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          className="absolute inset-0 cursor-pointer"
          onClick={() => handleClick(banners[current])}
        >
          <img
            src={banners[current].imageUrl}
            alt={banners[current].title}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-slate-950/80 via-slate-950/30 to-transparent" />
          
          <div className="absolute bottom-0 left-0 right-0 p-5">
            <h3 className="text-lg font-black text-white tracking-wide drop-shadow-lg">{banners[current].title}</h3>
            {banners[current].description && (
              <p className="text-xs text-slate-300 mt-1 max-w-md drop-shadow">{banners[current].description}</p>
            )}
            {banners[current].clickType !== "none" && (
              <span className={`inline-flex items-center gap-1 mt-2 text-[10px] font-bold ${accentText} ${accentBg} px-2.5 py-1 rounded-lg border border-current/20`}>
                {banners[current].clickType === "external" ? "Mehr erfahren" : "Öffnen"} <ExternalLink className="w-3 h-3" />
              </span>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Navigation dots */}
      {banners.length > 1 && (
        <>
          <div className="absolute bottom-3 right-4 flex gap-1.5 z-20">
            {banners.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setCurrent(i); }}
                className={`w-2 h-2 rounded-full transition-all duration-300 cursor-pointer ${
                  i === current ? "bg-[var(--theme-accent)] scale-110" : "bg-slate-500/60 hover:bg-slate-400"
                }`}
              />
            ))}
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); prevSlide(); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-xl bg-slate-950/60 hover:bg-slate-950/80 border border-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 cursor-pointer z-20"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); nextSlide(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-xl bg-slate-950/60 hover:bg-slate-950/80 border border-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 cursor-pointer z-20"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
});
