"use client";

import { useEffect, useRef } from "react";

/**
 * Business-themed WebGL background ("growth field") for the auth/landing
 * surfaces. One fullscreen fragment shader draws, in the brand emerald/teal
 * palette:
 *   1. a perspective "data grid" floor scrolling toward the horizon,
 *   2. an animated growth curve with a soft area fill,
 *   3. quarterly "bar chart" silhouettes rising behind the horizon,
 *   4. two depth layers of drifting "transaction" particles,
 *   5. a horizon accent glow + vignette.
 *
 * Robustness contract (why it is written this way):
 * - Single quad + one shader: no geometry buffers to leak, works on
 *   WebGL1 (GLSL ES 1.0) for maximum device compatibility.
 * - No WebGL / context creation failure → the canvas hides itself and the
 *   page falls back to the CSS gradient already behind it.
 * - `prefers-reduced-motion: reduce` → ONE static frame, no RAF loop.
 * - `document.hidden` → RAF paused (battery/CPU friendly).
 * - devicePixelRatio capped at 1.75 (soft-glow content, no sharpening
 *   benefit beyond that, big GPU saving on 3x phones).
 * - Theme-aware: colors swap via a MutationObserver on <html class>, so a
 *   dark↔light toggle updates the canvas without a remount.
 * - Context loss handled (preventDefault + re-init on restore); full
 *   cleanup on unmount (RAF, listeners, observers, context loss ext).
 * - Decorative only: aria-hidden, pointer-events-none, no layout impact.
 */

const VERT_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uDark;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/* Sparse drifting dots ("transactions") on a hashed grid cell. */
float particleLayer(vec2 uv, float t, float scale, float speed, float threshold) {
  vec2 p = uv * scale;
  p.y -= t * speed; /* negative → dots drift upward */
  vec2 i = floor(p);
  vec2 f = fract(p);
  float h = hash(i);
  vec2 c = vec2(hash(i + 2.3), hash(i + 4.5));
  float d = length(f - c);
  float blink = 0.55 + 0.45 * sin(t * 1.6 + h * 6.2831);
  return smoothstep(0.10, 0.0, d) * step(threshold, h) * blink;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime;

  /* Premultiplied-style accumulation: every color term is already scaled
     by its own mask, so the canvas composites straight onto the page. */
  vec3 col = vec3(0.0);
  float a = 0.0;

  /* 1) Perspective "data grid" floor below the horizon. */
  float horizon = -0.14;
  if (uv.y < horizon) {
    float z = 1.0 / (horizon - uv.y);
    vec2 gp = vec2(uv.x * z * 1.1, z * 0.85 - t * 0.45);
    vec2 g = abs(fract(gp) - 0.5);
    float line = smoothstep(0.42, 0.5, max(g.x, g.y));
    float nearH = smoothstep(horizon, horizon - 0.035, uv.y);
    float depthFade = clamp(z * 0.16, 0.0, 1.0);
    float m = line * (1.0 - nearH) * depthFade;
    col += uColA * m * 0.35;
    a += m * 0.32;
  }

  /* 2) Growth curve with soft area fill — the signature "business line". */
  float wave = vnoise(vec2(uv.x * 2.1 + t * 0.10, 3.7)) * 0.14
             + sin(uv.x * 5.0 - t * 0.35) * 0.018;
  float chartY = 0.12 + wave;
  float dLine = abs(uv.y - chartY);
  float glow = exp(-dLine * 70.0);
  float core = exp(-dLine * 320.0);
  float area = smoothstep(0.0, 0.42, chartY - uv.y) * 0.085;
  col += uColA * glow * 0.55 + uColB * core * 0.9 + uColA * area;
  a += glow * 0.38 + core * 0.5 + area;

  /* 3) Quarterly bars rising behind the horizon. */
  float bx = uv.x * 7.0 + 23.0;
  float bi = floor(bx);
  float bf = fract(bx);
  float bh = (0.06 + vnoise(vec2(bi * 1.7, floor(t * 0.4) + 5.0)) * 0.16)
           * (0.55 + 0.45 * sin(t * 0.5 + bi * 1.31));
  float barMask = step(0.22, bf) * step(bf, 0.78);
  float inBar = step(uv.y, horizon + 0.015) * step(horizon - bh, uv.y);
  float bar = barMask * inBar;
  col += uColB * bar * 0.14;
  a += bar * 0.16;
  float topEdge = exp(-abs(uv.y - (horizon - bh)) * 46.0) * barMask
                * step(uv.y, horizon + 0.015);
  col += uColB * topEdge * 0.4;
  a += topEdge * 0.3;

  /* 4) Transaction particles — two depth layers. */
  float p1 = particleLayer(uv + vec2(0.0, 0.18), t, 9.0, 0.05, 0.86);
  float p2 = particleLayer(uv + vec2(3.1, 0.4), t, 14.0, 0.08, 0.90);
  col += uColA * p1 * 0.5 + uColB * p2 * 0.4;
  a += p1 * 0.45 + p2 * 0.35;

  /* 5) Horizon accent + vignette. */
  float hGlow = exp(-abs(uv.y - horizon) * 26.0) * 0.5;
  col += uColB * hGlow * 0.35;
  a += hGlow * 0.3;
  float vig = smoothstep(1.25, 0.35, length(uv * vec2(0.85, 1.15)));
  a *= vig;
  col *= vig;

  /* Light theme stays much quieter so form contrast is preserved. */
  float themeScale = mix(0.42, 1.0, uDark);
  gl_FragColor = vec4(col * themeScale, clamp(a, 0.0, 1.0) * themeScale);
}
`;

/* Palette mirrors the .gradient-text stops in globals.css so the canvas
   always matches the brand, in both themes. */
const PALETTE = {
  dark: {
    colA: [0.204, 0.827, 0.6] as const, // emerald-400 #34d399
    colB: [0.369, 0.918, 0.831] as const, // teal-300 #5eead4
  },
  light: {
    colA: [0.02, 0.588, 0.412] as const, // emerald-600 #059669
    colB: [0.051, 0.58, 0.533] as const, // teal-600 #0d9488
  },
};

function isDarkNow(): boolean {
  return typeof document !== "undefined"
    ? document.documentElement.classList.contains("dark")
    : true;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BusinessWebGLBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf = 0;
    let running = false;
    let elapsed = 0;
    let last = 0;
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uTime: WebGLUniformLocation | null = null;
    let uColA: WebGLUniformLocation | null = null;
    let uColB: WebGLUniformLocation | null = null;
    let uDark: WebGLUniformLocation | null = null;
    let disposed = false;
    let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const startLoop = () => {
      if (running || disposed || reducedMotion) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stopLoop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const resize = () => {
      if (!gl) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const applyTheme = () => {
      if (!gl) return;
      const dark = isDarkNow();
      const pal = dark ? PALETTE.dark : PALETTE.light;
      if (uColA) gl.uniform3f(uColA, pal.colA[0], pal.colA[1], pal.colA[2]);
      if (uColB) gl.uniform3f(uColB, pal.colB[0], pal.colB[1], pal.colB[2]);
      if (uDark) gl.uniform1f(uDark, dark ? 1 : 0);
    };

    const draw = () => {
      if (!gl) return;
      resize();
      if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
      if (uTime) gl.uniform1f(uTime, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number) => {
      if (!running) return;
      elapsed += Math.min((now - last) / 1000, 0.1); // clamp tab-switch jumps
      last = now;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const init = (): boolean => {
      gl = (canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
      }) ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (!gl) return false;

      const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      if (!vs || !fs) return false;
      program = gl.createProgram();
      if (!program) return false;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);

      // Fullscreen triangle — no index buffer needed.
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      uRes = gl.getUniformLocation(program, "uRes");
      uTime = gl.getUniformLocation(program, "uTime");
      uColA = gl.getUniformLocation(program, "uColA");
      uColB = gl.getUniformLocation(program, "uColB");
      uDark = gl.getUniformLocation(program, "uDark");

      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied output

      applyTheme();
      return true;
    };

    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    const onMotionPref = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
      if (reducedMotion) {
        stopLoop();
        elapsed = 40; // a settled, representative composition
        draw();
      } else {
        startLoop();
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      stopLoop();
      gl = null;
    };
    const onContextRestored = () => {
      if (disposed) return;
      if (init()) {
        if (reducedMotion) draw();
        else startLoop();
      } else {
        canvas.style.display = "none";
      }
    };

    // Boot
    if (!init()) {
      // WebGL unavailable → hide the canvas; CSS gradient fallback remains.
      canvas.style.display = "none";
      return;
    }
    resize();
    draw();

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener("change", onMotionPref);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    const themeObserver = new MutationObserver(() => {
      applyTheme();
      if (reducedMotion) draw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const resizeObserver = new ResizeObserver(() => {
      // Redraw immediately on resize so there is no stretched-frame lag.
      draw();
    });
    resizeObserver.observe(canvas);

    if (reducedMotion) {
      elapsed = 40;
      draw(); // single static frame, no loop
    } else {
      startLoop();
    }

    return () => {
      disposed = true;
      stopLoop();
      motionQuery.removeEventListener("change", onMotionPref);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      const lose = gl?.getExtension("WEBGL_lose_context");
      lose?.loseContext();
      gl = null;
      program = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 -z-10 h-full w-full ${className ?? ""}`}
    />
  );
}
