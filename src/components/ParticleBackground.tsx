import React, { useEffect, useRef } from "react";

export type ThemeType = string;

// Helpers to derive colors from a single accent hex
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function getColorsFromAccent(accent: string): string[] {
  const rgb = hexToRgb(accent);
  if (!rgb) {
    return [
      "rgba(34, 197, 94, ",
      "rgba(74, 222, 128, ",
      "rgba(134, 239, 172, ",
      "rgba(16, 185, 129, ",
      "rgba(52, 211, 153, ",
    ];
  }
  const { r, g, b } = rgb;
  return [
    `rgba(${clamp(r + 50)}, ${clamp(g + 50)}, ${clamp(b + 50)}, `,
    `rgba(${r}, ${g}, ${b}, `,
    `rgba(${clamp(r - 40)}, ${clamp(g - 40)}, ${clamp(b - 40)}, `,
    `rgba(${clamp(r + 90)}, ${clamp(g + 90)}, ${clamp(b + 90)}, `,
    `rgba(${clamp(r - 70)}, ${clamp(g - 70)}, ${clamp(b - 70)}, `,
  ];
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));

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
  shapeIdx: number;
  stretchX: number;
  stretchY: number;
}

interface ParticleBackgroundProps {
  accent: string;
  bgImage?: string;
  particleShapes?: number[][][];
  /** PNG sprite URL for particle shapes — loaded and tinted with accent color */
  particleImage?: string;
  showBgImage?: boolean;
  showParticles?: boolean;
  showCursorGlow?: boolean;
  /** Brightness of background image (0–100, default 35) */
  bgBrightness?: number;
  /** Blur of background image in px (0–20, default 0) */
  bgBlur?: number;
  /** Sprite particle size multiplier from theme metadata (default 8) */
  particleSize?: number;
  /** Number of particles from theme metadata (default 40) */
  particleFrequency?: number;
}

export const ParticleBackground = React.memo(function ParticleBackground({
  accent,
  bgImage,
  particleShapes,
  particleImage,
  showBgImage = true,
  showParticles = true,
  showCursorGlow = true,
  bgBrightness = 35,
  bgBlur = 0,
  particleSize = 8,
  particleFrequency = 40,
}: ParticleBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  const mousePosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const accentRef = useRef(accent);
  const shapesRef = useRef(particleShapes);
  const spriteImgRef = useRef<HTMLImageElement | null>(null);
  const spriteLoadedRef = useRef(false);
  const spriteSizeRef = useRef(particleSize);
  const particleCountRef = useRef(particleFrequency);

  useEffect(() => { accentRef.current = accent; }, [accent]);
  useEffect(() => { shapesRef.current = particleShapes; }, [particleShapes]);
  useEffect(() => { spriteSizeRef.current = particleSize; }, [particleSize]);
  useEffect(() => { particleCountRef.current = particleFrequency; }, [particleFrequency]);

  // Load particle sprite image with cleanup to prevent stale-image race condition
  useEffect(() => {
    let cancelled = false;
    if (!particleImage) {
      spriteImgRef.current = null;
      spriteLoadedRef.current = false;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!cancelled) { spriteImgRef.current = img; spriteLoadedRef.current = true; } };
    img.onerror = () => { if (!cancelled) { spriteImgRef.current = null; spriteLoadedRef.current = false; } };
    img.src = particleImage;
    return () => { cancelled = true; };
  }, [particleImage]);

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

    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      if (bgRef.current) {
        const px = -(e.clientX - window.innerWidth / 2) * 0.012;
        const py = -(e.clientY - window.innerHeight / 2) * 0.012;
        bgRef.current.style.transform = `translate(${px}px, ${py}px) scale(1.03)`;
      }
      if (glowRef.current) {
        glowRef.current.style.left = `${e.clientX}px`;
        glowRef.current.style.top = `${e.clientY}px`;
      }
    };
    window.addEventListener("mousemove", handleMouseMove);

    const createParticle = (initY = false): Particle => {
      const size = Math.random() * 5 + 1.5;
      const colors = getColorsFromAccent(accentRef.current);
      const baseColor = colors[Math.floor(Math.random() * colors.length)];
      const shapes = shapesRef.current;
      let shapeIdx = -1;
      let stretchX = 1;
      let stretchY = 1;
      if (shapes && shapes.length > 0) {
        shapeIdx = Math.floor(Math.random() * shapes.length);
        stretchX = 0.6 + Math.random() * 0.8;
        stretchY = 0.6 + Math.random() * 0.8;
      }
      return {
        x: Math.random() * canvas.width,
        y: initY ? Math.random() * canvas.height : canvas.height + 20,
        size,
        speedX: (Math.random() - 0.5) * 0.4,
        speedY: -(Math.random() * 0.5 + 0.2),
        opacity: Math.random() * 0.4 + 0.15,
        color: baseColor,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.005,
        type: Math.random() > 0.4 ? "shape" : "spark",
        shapeIdx,
        stretchX,
        stretchY,
      };
    };

    const initCount = particleCountRef.current;
    for (let i = 0; i < initCount; i++) {
      particles.push(createParticle(true));
    }

    const drawAndUpdate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const mPos = mousePosRef.current;
      const currentAccent = accentRef.current;
      const rgb = hexToRgb(currentAccent);

      // Mouse glow gradient
      const grad = ctx.createRadialGradient(mPos.x, mPos.y, 10, mPos.x, mPos.y, 600);
      if (rgb) grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
      else grad.addColorStop(0, "rgba(34, 197, 94, 0.08)");
      grad.addColorStop(0.4, "rgba(15, 23, 42, 0.03)");
      grad.addColorStop(1, "rgba(2, 6, 23, 0.85)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const shapes = shapesRef.current;
      const sprite = spriteImgRef.current;
      const useSprite = spriteLoadedRef.current && sprite;

      particles.forEach((p, index) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.angle += p.spin;

        // Subtle mouse drift
        const dx = mPos.x - p.x;
        const dy = mPos.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 250) {
          const force = (250 - dist) / 250;
          p.x += dx * force * 0.0015;
          p.y += dy * force * 0.0015;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);

        const setGlow = () => {
          if (rgb) ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
          else ctx.shadowColor = "rgba(34, 197, 94, 0.6)";
          ctx.shadowBlur = p.size * 1.2;
        };
        if (p.type === "shape" && useSprite) {
          // === SPRITE PARTICLE: draw on temp canvas for clean tinting ===
          // (no composite ops on main canvas - they would clip ALL particles)
          const baseSize = p.size * 5;
          const sizeFactor = Math.min(spriteSizeRef.current, 32) / 8;
          const s = baseSize * sizeFactor + 4;
          const w = sprite.naturalWidth;
          const h = sprite.naturalHeight;
          const ratio = w / h;
          const drawW = s * p.stretchX;
          const drawH = s / ratio * p.stretchY;

          if (drawW > 0 && drawH > 0 && isFinite(drawW) && isFinite(drawH)) {
            let tCanvas = (sprite as any).__tintCanvas;
            if (!tCanvas || tCanvas.width < drawW || tCanvas.height < drawH) {
              tCanvas = document.createElement("canvas");
              tCanvas.width = Math.ceil(drawW);
              tCanvas.height = Math.ceil(drawH);
              (sprite as any).__tintCanvas = tCanvas;
            }
            const tc = tCanvas.getContext("2d");
            tc.clearRect(0, 0, tCanvas.width, tCanvas.height);
            tc.drawImage(sprite, 0, 0, drawW, drawH);
            tc.globalCompositeOperation = "source-in";
            tc.fillStyle = `${p.color}${p.opacity * 0.7})`;
            tc.fillRect(0, 0, drawW, drawH);
            tc.globalCompositeOperation = "source-over";
            ctx.drawImage(tCanvas, -drawW / 2, -drawH / 2);
          }
        } else if (p.type === "shape" && shapes && shapes.length > 0 && p.shapeIdx >= 0) {
          ctx.beginPath();
          const polygon = shapes[p.shapeIdx % shapes.length];
          if (polygon && polygon.length >= 2) {
            const s = p.size * 5;
            for (let i = 0; i < polygon.length; i++) {
              const [nx, ny] = polygon[i];
              const px = (nx - 0.5) * s * p.stretchX;
              const py = (ny - 0.5) * s * p.stretchY;
              i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
            }
            ctx.closePath();
          } else {
            ctx.ellipse(0, 0, p.size * 1.5, p.size * 0.6, 0, 0, Math.PI * 2);
          }
          ctx.fillStyle = `${p.color}${p.opacity})`;
          setGlow();
          ctx.fill();
        } else if (p.type === "shape") {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size * 1.5, p.size * 0.6, 0, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}${p.opacity})`;
          setGlow();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}${p.opacity})`;
          setGlow();
          ctx.fill();
        }

        ctx.restore();

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
  }, [particleFrequency]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden select-none pointer-events-none z-0">
      {showBgImage && (
        <div
          ref={bgRef}
          className="absolute inset-[-40px] bg-cover bg-center transition-all duration-1000 ease-out scale-105"
          style={{
            backgroundImage: bgImage ? `url('${bgImage}')` : undefined,
            backgroundColor: bgImage ? undefined : "rgba(2, 6, 23, 1)",
            transform: "translate(0px, 0px) scale(1.03)",
            filter: bgImage ? `brightness(${bgBrightness}%) blur(${bgBlur}px) contrast(1.08)` : undefined,
          }}
        />
      )}
      {!showBgImage && <div className="absolute inset-0 bg-slate-950" />}
      <div className="absolute inset-0 bg-gradient-to-tr from-slate-950/95 via-slate-950/40 to-slate-900/60" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,23,0.85)_100%)]" />

      <canvas ref={canvasRef} className={`absolute inset-0 pointer-events-none ${showParticles ? 'mix-blend-screen' : 'hidden'}`} />

      {showCursorGlow && (
        <div
          ref={glowRef}
          className="fixed w-[400px] h-[400px] rounded-full pointer-events-none z-10 -translate-x-1/2 -translate-y-1/2 will-change-transform"
          style={{
            left: `${window.innerWidth / 2}px`,
            top: `${window.innerHeight / 2}px`,
            background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
            filter: "blur(80px)",
          }}
        />
      )}
    </div>
  );
});
