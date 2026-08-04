"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Moon, Sun, SunMoon } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Brand panel — the source image, ordered-dithered on the GPU        */
/* ------------------------------------------------------------------ */

const vertexShader = `#version 300 es
const vec2 positions[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

const fragmentShader = `#version 300 es
precision highp float;

uniform sampler2D imageTexture;
uniform vec2 resolution;
uniform vec2 imageResolution;
uniform float time;

out vec4 outputColor;

const float bayerMatrix8x8[64] = float[64](
  0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0,16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0,19.0/64.0, 47.0/64.0, 31.0/64.0,
  8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0,59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0,24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0,27.0/64.0, 39.0/64.0, 23.0/64.0,
  2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0,49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0,18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0,17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0,58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0,57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0,26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0,25.0/64.0, 37.0/64.0, 21.0/64.0
);

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x * 34.0) + 1.0) * x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec2 fade(vec2 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float cnoise(vec2 point) {
  vec4 pi = floor(point.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
  vec4 pf = fract(point.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
  pi = mod289(pi);
  vec4 ix = pi.xzxz;
  vec4 iy = pi.yyww;
  vec4 fx = pf.xzxz;
  vec4 fy = pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0 / 41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx -= tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
  g00 *= norm.x;
  g01 *= norm.y;
  g10 *= norm.z;
  g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fadeXY = fade(pf.xy);
  vec2 nx = mix(vec2(n00, n01), vec2(n10, n11), fadeXY.x);
  return 2.3 * mix(nx.x, nx.y, fadeXY.y);
}

float fbm(vec2 point) {
  float value = 0.0;
  float amplitude = 1.0;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * abs(cnoise(point));
    point *= 3.0;
    amplitude *= 0.3;
  }
  return value;
}

float pattern(vec2 point) {
  vec2 movingPoint = point - time * 0.05;
  return fbm(point + fbm(movingPoint));
}

vec2 coverUv(vec2 uv) {
  float canvasAspect = resolution.x / resolution.y;
  float textureAspect = imageResolution.x / imageResolution.y;

  if (canvasAspect < textureAspect) {
    uv.x = (uv.x - 0.5) * canvasAspect / textureAspect + 0.5;
  } else {
    float focalY = canvasAspect > 1.0 ? 0.64 : 0.5;
    uv.y = (uv.y - 0.5) * textureAspect / canvasAspect + focalY;
  }

  return uv;
}

void main() {
  vec2 pixelCoord = floor(gl_FragCoord.xy);
  vec2 sampledUv = (pixelCoord + 0.5) / resolution;
  vec3 sampledColor = texture(imageTexture, coverUv(sampledUv)).rgb;
  float luminance = dot(sampledColor, vec3(0.2126, 0.7152, 0.0722));

  int x = int(mod(pixelCoord.x, 8.0));
  int y = int(mod(pixelCoord.y, 8.0));
  float threshold = bayerMatrix8x8[y * 8 + x] + 0.5 / 64.0;

  vec2 waveUv = gl_FragCoord.xy / resolution - 0.5;
  waveUv.x *= resolution.x / resolution.y;
  float movingDither = (pattern(waveUv * 2.5) - 0.55) * 0.12;
  float ditheredColor = step(threshold, clamp(luminance + movingDither, 0.0, 1.0));

  outputColor = vec4(vec3(ditheredColor), 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unable to compile WebGL shader";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program");

  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShader);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShader);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unable to link WebGL program";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

/** The <img> stays in the DOM and stays the fallback: when WebGL2 is missing or
 *  the program fails to build we bail out and the plain photo is what shows. */
function DitherImage({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drawRef = useRef<((time: number) => void) | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // The flow animation only. When motion is reduced we skip the loop entirely
  // rather than idling in it — the still frame is drawn on upload and resize.
  useEffect(() => {
    if (reduceMotion) return;
    let frame = requestAnimationFrame(function loop(time) {
      drawRef.current?.(time / 1000);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const gl = canvas?.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });

    if (!canvas || !image || !gl) return;

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch {
      return;
    }

    const texture = gl.createTexture();
    if (!texture) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const resolution = gl.getUniformLocation(program, "resolution");
    const imageResolution = gl.getUniformLocation(program, "imageResolution");
    const time = gl.getUniformLocation(program, "time");
    const imageTexture = gl.getUniformLocation(program, "imageTexture");
    gl.uniform1i(imageTexture, 0);

    let disposed = false;
    const uploadImage = () => {
      if (disposed || !image.naturalWidth) return;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.uniform2f(imageResolution, image.naturalWidth, image.naturalHeight);

      drawRef.current = (elapsed) => {
        const dpr = Math.min(window.devicePixelRatio, 1.5);
        const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        gl.viewport(0, 0, width, height);
        gl.uniform2f(resolution, width, height);
        gl.uniform1f(time, elapsed);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };

      drawRef.current(0);
    };

    if (image.complete) uploadImage();
    else image.addEventListener("load", uploadImage, { once: true });

    const resizeObserver = new ResizeObserver(() => drawRef.current?.(0));
    resizeObserver.observe(canvas);

    return () => {
      disposed = true;
      drawRef.current = null;
      image.removeEventListener("load", uploadImage);
      resizeObserver.disconnect();
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    };
  }, [src]);

  return (
    <div className="absolute inset-0" aria-hidden="true">
      <Image
        ref={imageRef}
        src={src}
        alt=""
        fill
        priority
        sizes="(min-width: 1024px) 50vw, 100vw"
        className="object-cover object-[center_36%] lg:object-center"
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />
    </div>
  );
}

/**
 * Shared wrapper for auth pages (login, register, forgot-password, etc.).
 * Provides centered layout, brand, and theme toggle.
 */
export function AuthShell({
  children,
  maxWidth = "max-w-[400px]",
  align = "center",
  onBack,
}: {
  children: React.ReactNode;
  maxWidth?: string;
  /**
   * Vertical placement. `center` is right for a short form. Pass `start` for
   * anything tall: centering a page taller than the viewport pushes its top ABOVE
   * the scroll origin (unreachable), and it breaks `lg:sticky` children, which
   * need a normal-flow top edge to stick against.
   */
  align?: "center" | "start";
  /** When provided, renders a back button in the top bar */
  onBack?: () => void;
}) {
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <div
      className={`flex min-h-dvh flex-col items-center px-4 ${
        align === "start" ? "justify-start pb-12 pt-20" : "justify-center py-12"
      }`}
    >
      {/* Top bar - logo left, controls right */}
      <div
        data-app-topinset
        className="fixed inset-x-0 top-0 flex items-center justify-between px-5 py-4"
      >
        <div className="flex items-center gap-2.5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label={t.auth.back ?? "Back"}
              className="me-1"
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Button>
          )}
          <Logo size={24} />
          <span className="text-[16px] font-semibold tracking-tight text-foreground">
            {t.brand}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={t.auth.toggleTheme}
          >
            {resolvedTheme === "light" ? <Sun /> : resolvedTheme === "dim" ? <SunMoon /> : <Moon />}
          </Button>
        </div>
      </div>

      <div className={`w-full ${maxWidth}`}>
        {children}
      </div>
    </div>
  );
}
