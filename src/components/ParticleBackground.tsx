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
    // Fallback green palette
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
  /** Which polygon index to use (0-based), -1 for random */
  shapeIdx: number;
  /** Per-particle stretch multiplier */
  stretchX: number;
  stretchY: number;
}

interface ParticleBackgroundProps {
  /** Theme accent color in hex (#rrggbb) */
  accent: string;
  /** Background image URL (optional) */
  bgImage?: string;
  /** Custom polygon shapes for particles – array of polygons, each polygon is array of [x,y] points (normalized 0-1) */
  particleShapes?: number[][][];
  /** Whether to show the background image (default true) */
  showBgImage?: boolean;
  /** Whether to show floating particle shapes (default true) */
  showParticles?: boolean;
  /** Whether to show the cursor glow trail (default true) */
  showCursorGlow?: boolean;
}

export const ParticleBackground = React.memo(function ParticleBackground({
  accent,
  bgImage,
  particleShapes,
  showBgImage = true,
  showParticles = true,
  showCursorGlow = true,
}: ParticleBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  // Keep track of mouse coordinates locally without React state updates!
  const mousePosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const accentRef = useRef(accent);
  const shapesRef = useRef(particleShapes);

  useEffect(() => {
    accentRef.current = accent;
  }, [accent]);

  useEffect(() => {
    shapesRef.current = particleShapes;
  }, [particleShapes]);

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

    const createParticle = (initY = false): Particle => {
      const size = Math.random() * 5 + 1.5;
      const currentColors = getColorsFromAccent(accentRef.current);
      const baseColor = currentColors[Math.floor(Math.random() * currentColors.length)];
      const shapes = shapesRef.current;

      let shapeIdx = -1;
      let stretchX = 1;
      let stretchY = 1;
      if (shapes && shapes.length > 0) {
        shapeIdx = Math.floor(Math.random() * shapes.length);
        // Randomize stretch for variety (0.6 – 1.4)
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

    // Initialize particles
    const particleCount = 40;
    for (let i = 0; i < particleCount; i++) {
      particles.push(createParticle(true));
    }

    const drawAndUpdate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const mPos = mousePosRef.current;
      const currentAccent = accentRef.current;

      // Mouse glow radial gradient
      const radialGradient = ctx.createRadialGradient(mPos.x, mPos.y, 10, mPos.x, mPos.y, 600);
      const rgb = hexToRgb(currentAccent);
      if (rgb) {
        radialGradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
      } else {
        radialGradient.addColorStop(0, `rgba(34, 197, 94, 0.08)`);
      }
      radialGradient.addColorStop(0.4, "rgba(15, 23, 42, 0.03)");
      radialGradient.addColorStop(1, "rgba(2, 6, 23, 0.85)");

      ctx.fillStyle = radialGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const shapes = shapesRef.current;

      // Update and draw particles
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

        // Draw particle
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);

        ctx.beginPath();

        if (p.type === "shape" && shapes && shapes.length > 0 && p.shapeIdx >= 0) {
          // Draw custom polygon with random stretch
          const polygon = shapes[p.shapeIdx % shapes.length];
          if (polygon && polygon.length >= 2) {
            const s = p.size * 5; // scale factor
            for (let i = 0; i < polygon.length; i++) {
              const [nx, ny] = polygon[i];
              const px = (nx - 0.5) * s * p.stretchX;
              const py = (ny - 0.5) * s * p.stretchY;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.closePath();
          } else {
            // Fallback ellipse
            ctx.ellipse(0, 0, p.size * 1.5, p.size * 0.6, 0, 0, Math.PI * 2);
          }
        } else if (p.type === "shape") {
          // No custom shapes — draw a flowing ellipse
          ctx.ellipse(0, 0, p.size * 1.5, p.size * 0.6, 0, 0, Math.PI * 2);
        } else {
          // Sparks: small circles
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
        }

        ctx.fillStyle = `${p.color}${p.opacity})`;

        // Shadow glow from accent
        if (rgb) {
          ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
        } else {
          ctx.shadowColor = "rgba(34, 197, 94, 0.6)";
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
  }, []); // Empty dependency array means this only runs once on mount!

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden select-none pointer-events-none z-0">
      {/* Background Image with slow, beautiful parallax handled directly via DOM styled transform */}
      {showBgImage && (
        <div
          ref={bgRef}
          className="absolute inset-[-40px] bg-cover bg-center transition-all duration-1000 ease-out scale-105"
          style={{
            backgroundImage: bgImage ? `url('${bgImage}')` : undefined,
            backgroundColor: bgImage ? undefined : `rgba(2, 6, 23, 1)`,
            transform: `translate(0px, 0px) scale(1.03)`,
            filter: bgImage ? "brightness(0.35) contrast(1.08)" : undefined,
          }}
        />
      )}
      {!showBgImage && (
        <div className="absolute inset-0 bg-slate-950" />
      )}
      {/* Dark vignette gradient — always on top of background */}
      <div className="absolute inset-0 bg-gradient-to-tr from-slate-950/95 via-slate-950/40 to-slate-900/60" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(2,6,23,0.85)_100%)]" />

      {/* Interactive canvas — only when particles enabled */}
      {showParticles && (
        <canvas ref={canvasRef} className="absolute inset-0 mix-blend-screen pointer-events-none" />
      )}

      {/* High-performance cursor glow trail — only when cursor glow enabled */}
      {showCursorGlow && (
        <div
          ref={glowRef}
          className="fixed w-[400px] h-[400px] rounded-full pointer-events-none z-10 -translate-x-1/2 -translate-y-1/2 will-change-transform"
          style={{
            left: `${window.innerWidth / 2}px`,
            top: `${window.innerHeight / 2}px`,
            background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
            filter: 'blur(80px)',
          }}
        />
      )}
    </div>
  );
});
