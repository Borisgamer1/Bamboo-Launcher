import React, { useEffect, useRef } from "react";

export type ThemeType = "bamboo" | "cherry" | "frozen" | "nether" | "warden" | "end" | "copper" | "obsidian";

interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  color: string;
  angle: number;
  spin: number;
  type: "shape" | "spark";
}

interface ParticleBackgroundProps {
  theme: ThemeType;
}

export const ParticleBackground = React.memo(function ParticleBackground({ theme }: ParticleBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  
  // Keep track of mouse coordinates locally without React state updates!
  const mousePosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const themeRef = useRef(theme);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let particles: Particle[] = [];

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    // Local mousemove listener directly on window
    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      
      // 1. Update background image parallax transform DIRECTLY on the DOM element!
      if (bgRef.current) {
        const parallaxX = -(e.clientX - window.innerWidth / 2) * 0.012;
        const parallaxY = -(e.clientY - window.innerHeight / 2) * 0.012;
        bgRef.current.style.transform = `translate(${parallaxX}px, ${parallaxY}px) scale(1.03)`;
      }

      // 2. Update cursor trail glow position DIRECTLY on the DOM element!
      if (glowRef.current) {
        glowRef.current.style.left = `${e.clientX}px`;
        glowRef.current.style.top = `${e.clientY}px`;
      }
    };

    window.addEventListener("mousemove", handleMouseMove);

    // Helper to get color palette based on current theme
const getThemeColors = (currentTheme: ThemeType) => {
  switch (currentTheme) {
    case "cherry":
      return [
        "rgba(244, 63, 94, ",   // rose-500
        "rgba(251, 113, 133, ", // rose-400
        "rgba(253, 164, 175, ", // rose-300
        "rgba(255, 241, 242, ", // rose-50
        "rgba(236, 72, 153, "   // pink-500
      ];
    case "frozen":
      return [
        "rgba(56, 189, 248, ",  // sky-400
        "rgba(14, 165, 233, ",  // sky-500
        "rgba(125, 211, 252, ", // sky-300
        "rgba(224, 242, 254, ", // sky-100
        "rgba(34, 211, 238, "   // cyan-400
      ];
    case "nether":
      return [
        "rgba(185, 28, 28, ",  // red-700
        "rgba(220, 38, 38, ",  // red-600
        "rgba(248, 113, 113, ", // red-400
        "rgba(153, 27, 27, ",  // red-800
        "rgba(127, 29, 29, "   // red-900
      ];
    case "warden":
      return [
        "rgba(20, 184, 166, ",  // teal-500
        "rgba(45, 212, 191, ",  // teal-400
        "rgba(94, 234, 212, ",  // teal-300
        "rgba(15, 118, 110, ",  // teal-700
        "rgba(6, 78, 59, "      // teal-900
      ];
    case "end":
      return [
        "rgba(168, 85, 247, ",  // purple-500
        "rgba(192, 132, 252, ", // purple-400
        "rgba(216, 180, 254, ", // purple-300
        "rgba(88, 28, 135, ",   // purple-800
        "rgba(49, 16, 84, "     // purple-950
      ];
    case "copper":
      return [
        "rgba(217, 119, 6, ",   // amber-600
        "rgba(245, 158, 11, ",  // amber-500
        "rgba(251, 191, 36, ",  // amber-400
        "rgba(120, 53, 15, ",   // amber-900
        "rgba(67, 20, 7, "      // amber-950
      ];
    case "obsidian":
      return [
        "rgba(167, 139, 250, ", // violet-400
        "rgba(139, 92, 246, ",  // violet-500
        "rgba(196, 181, 253, ", // violet-300
        "rgba(30, 27, 75, ",    // indigo-950
        "rgba(15, 15, 30, "     // near-black
      ];
    case "bamboo":
    default:
      return [
        "rgba(34, 197, 94, ",  // green-500
        "rgba(74, 222, 128, ",  // green-400
        "rgba(134, 239, 172, ", // green-300
        "rgba(234, 179, 8, ",   // yellow-500
        "rgba(250, 204, 21, "   // yellow-400
      ];
  }
};

    const createParticle = (initY = false): Particle => {
      const size = Math.random() * 5 + 1.5;
      const currentTheme = themeRef.current;
      const colors = getThemeColors(currentTheme);
      const baseColor = colors[Math.floor(Math.random() * colors.length)];

      return {
        x: Math.random() * canvas.width,
        y: initY ? Math.random() * canvas.height : canvas.height + 20,
        size,
        speedX: (Math.random() - 0.5) * 0.4,
        speedY: -(Math.random() * 0.5 + 0.2), // Constant, beautiful float speed
        opacity: Math.random() * 0.4 + 0.15,
        color: baseColor,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.005,
        type: Math.random() > 0.4 ? "shape" : "spark",
      };
    };

    // Initialize particles
    const particleCount = 40;
    for (let i = 0; i < particleCount; i++) {
      particles.push(createParticle(true));
    }

    const drawAndUpdate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const mPos = mousePosRef.current;
      const currentTheme = themeRef.current;

      const radialGradient = ctx.createRadialGradient(mPos.x, mPos.y, 10, mPos.x, mPos.y, 600);
      const glowIntensity = "0.08";
if (currentTheme === "cherry") radialGradient.addColorStop(0, `rgba(244, 63, 94, ${glowIntensity})`);
else if (currentTheme === "frozen") radialGradient.addColorStop(0, `rgba(56, 189, 248, ${glowIntensity})`);
else if (currentTheme === "nether") radialGradient.addColorStop(0, `rgba(185, 28, 28, ${glowIntensity})`);
else if (currentTheme === "warden") radialGradient.addColorStop(0, `rgba(20, 184, 166, ${glowIntensity})`);
else if (currentTheme === "end") radialGradient.addColorStop(0, `rgba(168, 85, 247, ${glowIntensity})`);
else if (currentTheme === "copper") radialGradient.addColorStop(0, `rgba(217, 119, 6, ${glowIntensity})`);
else if (currentTheme === "obsidian") radialGradient.addColorStop(0, `rgba(167, 139, 250, ${glowIntensity})`);
else radialGradient.addColorStop(0, `rgba(34, 197, 94, ${glowIntensity})`);
      radialGradient.addColorStop(0.4, "rgba(15, 23, 42, 0.03)");
      radialGradient.addColorStop(1, "rgba(2, 6, 23, 0.85)");

      ctx.fillStyle = radialGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Update and draw particles
      particles.forEach((p, index) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.angle += p.spin;

        // Subtle, gentle wind drift towards the mouse when close (very soft, no rapid jumps)
        const dx = mPos.x - p.x;
        const dy = mPos.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 250) {
          const force = (250 - dist) / 250;
          p.x += dx * force * 0.0015; // Extremely gentle drift
          p.y += dy * force * 0.0015;
        }

        // Draw particle
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.beginPath();
        
        if (p.type === "shape") {
if (currentTheme === "cherry") {
  ctx.ellipse(0, 0, p.size * 1.6, p.size * 0.8, 0.2, 0, Math.PI * 2);
} else if (currentTheme === "frozen") {
  ctx.moveTo(0, -p.size * 1.5);
  ctx.lineTo(p.size, 0);
  ctx.lineTo(0, p.size * 1.5);
  ctx.lineTo(-p.size, 0);
  ctx.closePath();
} else if (currentTheme === "nether") {
  ctx.moveTo(0, -p.size);
  ctx.lineTo(p.size * 1.2, -p.size * 0.2);
  ctx.lineTo(p.size * 0.8, p.size * 0.8);
  ctx.lineTo(-p.size * 0.8, p.size * 0.6);
  ctx.closePath();
} else if (currentTheme === "warden") {
  ctx.arc(0, 0, p.size, 0, Math.PI * 2);
} else if (currentTheme === "end") {
  const s = p.size * 1.2;
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.4, -s * 0.4);
  ctx.lineTo(s, 0);
  ctx.lineTo(s * 0.4, s * 0.4);
  ctx.lineTo(0, s);
  ctx.lineTo(-s * 0.4, s * 0.4);
  ctx.lineTo(-s, 0);
  ctx.lineTo(-s * 0.4, -s * 0.4);
  ctx.closePath();
} else if (currentTheme === "copper") {
  const s = p.size * 1.1;
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = Math.cos(angle) * s;
    const py = Math.sin(angle) * s;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
} else if (currentTheme === "obsidian") {
  ctx.rect(-p.size * 0.8, -p.size * 0.8, p.size * 1.6, p.size * 1.6);
} else {
  ctx.ellipse(0, 0, p.size * 1.5, p.size * 0.6, 0, 0, Math.PI * 2);
}
        } else {
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
        }

        ctx.fillStyle = `${p.color}${p.opacity})`;
        
        // Shadow Blur Glow
if (currentTheme === "cherry") {
  ctx.shadowColor = "rgba(244, 63, 94, 0.8)";
} else if (currentTheme === "frozen") {
  ctx.shadowColor = "rgba(56, 189, 248, 0.8)";
} else if (currentTheme === "nether") {
  ctx.shadowColor = "rgba(249, 115, 22, 0.8)";
} else if (currentTheme === "warden") {
  ctx.shadowColor = "rgba(20, 184, 166, 0.8)";
} else if (currentTheme === "end") {
  ctx.shadowColor = "rgba(168, 85, 247, 0.8)";
} else if (currentTheme === "copper") {
  ctx.shadowColor = "rgba(217, 119, 6, 0.8)";
} else if (currentTheme === "obsidian") {
  ctx.shadowColor = "rgba(167, 139, 250, 0.8)";
} else {
  ctx.shadowColor = "rgba(34, 197, 94, 0.8)";
}
        ctx.shadowBlur = p.size * 1.2;
        
        ctx.fill();
        ctx.restore();

        // Reset if out of boundaries
        if (p.y < -20 || p.x < -20 || p.x > canvas.width + 20) {
          particles[index] = createParticle(false);
        }
      });

      animationFrameId = requestAnimationFrame(drawAndUpdate);
    };

    drawAndUpdate();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, []); // Empty dependency array means this only runs once on mount! Constant speed is 100% guaranteed.

  // Select background image based on active theme
  const getThemeBg = (currentTheme: ThemeType) => {
    switch (currentTheme) {
      case "cherry": return "/images/cherry_blossom.png";
      case "frozen": return "/images/frozen_ice.png";
      case "nether": return "/images/nether_amber.png";
      case "warden": return "/images/frozen_ice.png";
      case "end": return "/images/nether_amber.png";
      case "copper": return "/images/nether_amber.png";
      case "obsidian": return "/images/bamboo_forest.png";
      case "bamboo":
      default: return "/images/bamboo_forest.png";
    }
  };

  const getGlowColor = (currentTheme: ThemeType) => {
    switch (currentTheme) {
      case "cherry": return "bg-rose-500/3";
      case "frozen": return "bg-sky-500/3";
      case "nether": return "bg-red-600/3";
      case "warden": return "bg-teal-500/3";
      case "end": return "bg-purple-500/3";
      case "copper": return "bg-amber-500/3";
      case "obsidian": return "bg-violet-500/3";
      case "bamboo":
      default: return "bg-emerald-500/3";
    }
  };

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden select-none pointer-events-none z-0">
      {/* Background Image with slow, beautiful parallax handled directly via DOM styled transform */}
      <div
        ref={bgRef}
        className="absolute inset-[-40px] bg-cover bg-center transition-all duration-1000 ease-out scale-105"
        style={{
          backgroundImage: `url('${getThemeBg(theme)}')`,
          transform: `translate(0px, 0px) scale(1.03)`,
          filter: "brightness(0.35) contrast(1.08)",
        }}
      />
      {/* Dark vignette gradient */}
      <div className="absolute inset-0 bg-gradient-to-tr from-slate-950/95 via-slate-950/40 to-slate-900/60" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,23,0.85)_100%)]" />

      {/* Interactive canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 mix-blend-screen pointer-events-none" />

      {/* High-performance local cursor glow trail inside the particle container */}
      <div 
        ref={glowRef}
        className={`fixed w-[400px] h-[400px] rounded-full ${getGlowColor(theme)} blur-[120px] pointer-events-none z-10 -translate-x-1/2 -translate-y-1/2 transition-all will-change-transform`}
        style={{
          left: `${window.innerWidth / 2}px`,
          top: `${window.innerHeight / 2}px`,
        }}
      />
    </div>
  );
});
