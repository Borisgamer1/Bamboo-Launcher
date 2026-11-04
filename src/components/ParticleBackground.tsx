import React, { useEffect, useRef } from "react";

export type ThemeType = string;

type TintedSprite = HTMLImageElement & { __tintCanvas?: HTMLCanvasElement };

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
  particleImage?: string;
  showBgImage?: boolean;
  showParticles?: boolean;
  bgBrightness?: number;
  bgBlur?: number;
  particleSize?: number;
  particleFrequency?: number;
  particleDirection?: string;
  showGlow?: boolean;
  glowColor?: string;
  glowOverlayColor?: string;
}

export const ParticleBackground = React.memo(function ParticleBackground({
  accent,
  bgImage,
  particleShapes,
  particleImage,
  showBgImage = true,
  showParticles = true,
  bgBrightness = 35,
  bgBlur = 0,
  particleSize = 8,
  particleFrequency = 40,
  particleDirection = "bottom",
  showGlow = true,
  glowColor = "#080415",
  glowOverlayColor = "#080415",
}: ParticleBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);

  const mousePosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const accentRef = useRef(accent);
  const shapesRef = useRef(particleShapes);
  const spriteImgRef = useRef<HTMLImageElement | null>(null);
  const spriteLoadedRef = useRef(false);
  const spriteSizeRef = useRef(particleSize);
  const particleCountRef = useRef(particleFrequency);
  const directionRef = useRef(particleDirection);
  const showGlowRef = useRef(showGlow);
  const glowColorRef = useRef(glowColor);
  const showParticlesRef = useRef(showParticles);

  useEffect(() => { accentRef.current = accent; }, [accent]);
  useEffect(() => { shapesRef.current = particleShapes; }, [particleShapes]);
  useEffect(() => { spriteSizeRef.current = particleSize; }, [particleSize]);
  useEffect(() => { particleCountRef.current = particleFrequency; }, [particleFrequency]);
  useEffect(() => { directionRef.current = particleDirection; }, [particleDirection]);
  useEffect(() => { showGlowRef.current = showGlow; }, [showGlow]);
  useEffect(() => { glowColorRef.current = glowColor; }, [glowColor]);
  useEffect(() => { showParticlesRef.current = showParticles; }, [showParticles]);

  // Cleanup prevents a stale-image race condition.
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
    const particles: Particle[] = [];

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
    };
    window.addEventListener("mousemove", handleMouseMove);

    const spawnParticle = (dir: string, initInside = false): Particle => {
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

      let x: number, y: number, speedX: number, speedY: number;
      const pad = 20;
      switch (dir) {
        case "top":
          x = Math.random() * canvas.width;
          y = initInside ? Math.random() * canvas.height : -pad;
          speedX = (Math.random() - 0.5) * 0.4;
          speedY = Math.random() * 0.5 + 0.2;
          break;
        case "left":
          x = initInside ? Math.random() * canvas.width : -pad;
          y = Math.random() * canvas.height;
          speedX = Math.random() * 0.5 + 0.2;
          speedY = (Math.random() - 0.5) * 0.4;
          break;
        case "right":
          x = initInside ? Math.random() * canvas.width : canvas.width + pad;
          y = Math.random() * canvas.height;
          speedX = -(Math.random() * 0.5 + 0.2);
          speedY = (Math.random() - 0.5) * 0.4;
          break;
        default:
          x = Math.random() * canvas.width;
          y = initInside ? Math.random() * canvas.height : canvas.height + pad;
          speedX = (Math.random() - 0.5) * 0.4;
          speedY = -(Math.random() * 0.5 + 0.2);
          break;
      }

      return {
        x, y, size,
        speedX, speedY,
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

    const createParticle = (initY = false): Particle => spawnParticle(directionRef.current, initY);

    const initCount = particleCountRef.current;
    for (let i = 0; i < initCount; i++) {
      particles.push(createParticle(true));
    }

    const drawAndUpdate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const mPos = mousePosRef.current;
      const currentAccent = accentRef.current;
      const rgb = hexToRgb(currentAccent);
      if (!rgb) return;

      if (showGlowRef.current) {
        const glowRgb = hexToRgb(glowColorRef.current);
        const grad = ctx.createRadialGradient(mPos.x, mPos.y, 10, mPos.x, mPos.y, 600);
        if (glowRgb) grad.addColorStop(0, `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, 0.35)`);
        else grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
        grad.addColorStop(0.4, "rgba(9, 9, 10, 0.03)");
        grad.addColorStop(1, "rgba(9, 9, 10, 0.85)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        const grad = ctx.createRadialGradient(mPos.x, mPos.y, 10, mPos.x, mPos.y, 600);
        grad.addColorStop(0, "rgba(9, 9, 10, 0.04)");
        grad.addColorStop(0.4, "rgba(9, 9, 10, 0.02)");
        grad.addColorStop(1, "rgba(9, 9, 10, 0.85)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      const shapes = shapesRef.current;
      const sprite = spriteImgRef.current;
      const useSprite = spriteLoadedRef.current && sprite;

      if (showParticlesRef.current) {
        particles.forEach((p, index) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.angle += p.spin;

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
          const baseSize = p.size * 5;
          const sizeFactor = Math.min(spriteSizeRef.current, 32) / 8;
          const s = baseSize * sizeFactor + 4;
          const w = sprite.naturalWidth;
          const h = sprite.naturalHeight;
          const ratio = w / h;
          const drawW = s * p.stretchX;
          const drawH = s / ratio * p.stretchY;

          if (drawW > 0 && drawH > 0 && isFinite(drawW) && isFinite(drawH)) {
            const tintSprite = sprite as TintedSprite;
            let tCanvas = tintSprite.__tintCanvas;
            if (!tCanvas || tCanvas.width < drawW || tCanvas.height < drawH) {
              tCanvas = document.createElement("canvas");
              tCanvas.width = Math.ceil(drawW);
              tCanvas.height = Math.ceil(drawH);
              tintSprite.__tintCanvas = tCanvas;
            }
            const tc = tCanvas.getContext("2d");
            if (!tc) return;
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
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
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

        const recycle = (() => {
          const dir = directionRef.current;
          switch (dir) {
            case "top": return p.y > canvas.height + 20;
            case "left": return p.x > canvas.width + 20;
            case "right": return p.x < -20;
            default: return p.y < -20 || p.x < -20 || p.x > canvas.width + 20;
          }
        })();
        if (recycle) {
          particles[index] = spawnParticle(directionRef.current, false);
        }
        });
      }

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
          className="absolute inset-[-40px] bg-cover bg-center transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-out)] ease-[var(--ease-out)] scale-105"
          style={{
            backgroundImage: bgImage ? `url('${bgImage}')` : undefined,
            backgroundColor: bgImage ? undefined : "var(--bg-base)",
            transform: "translate(0px, 0px) scale(1.03)",
            filter: bgImage ? `brightness(${bgBrightness}%) blur(${bgBlur}px) contrast(1.08)` : undefined,
          }}
        />
      )}
      {!showBgImage && <div className="absolute inset-0 bg-root" />}
      {showGlow && (
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `linear-gradient(to top right, ${glowOverlayColor}dd, ${glowOverlayColor}55, transparent)`,
        }} />
      )}
      {showGlow && (
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(circle at center, transparent 20%, ${glowOverlayColor}c0 100%)`,
        }} />
      )}

      <canvas ref={canvasRef} className={`absolute inset-0 pointer-events-none ${(showParticles || showGlow) ? 'mix-blend-screen' : 'hidden'}`} />
    </div>
  );
});
