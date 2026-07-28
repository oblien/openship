"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { DarkSection } from "../dark-section";
import {
  BEATS,
  BEAT_HOT,
  EDGES,
  LAYOUTS,
  NODES,
  SR_DESCRIPTION,
  cx,
  cy,
  edgeKey,
  edgePath,
  hexPath,
  netBox,
  versionChips,
  type LayoutName,
  type NodeId,
} from "./layout";

/**
 * System map - the platform as a live architecture diagram.
 *
 * A glowing packet walks the real deploy path (push → build → ship over SSH →
 * wire up services → route through the edge → roll back) while connections draw
 * themselves and nodes ignite. Six beats, looping.
 *
 * Motion notes:
 *  - GSAP owns the timeline; CSS owns every colour. The timeline only tweens
 *    dash offsets, opacity and the packet position, and calls applyBeat(), which
 *    writes data-state / data-active attributes. Palette changes stay in CSS.
 *  - The packet is moved with getPointAtLength rather than MotionPathPlugin -
 *    fewer moving parts, and we need the path lengths for the draw-on anyway.
 *  - Paused while off-screen and in background tabs, so an unseen section costs
 *    nothing.
 *  - prefers-reduced-motion builds no timeline at all: the diagram renders fully
 *    drawn and the beat chips switch captions instantly.
 */

const BEAT = 2.2;
const TOTAL = BEATS.length * BEAT;
/** How long a connection takes to draw. Its dot rides the drawing head. */
const DRAW = BEAT * 0.62;

export function SystemMap() {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const chipsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const capsRef = useRef<(HTMLParagraphElement | null)[]>([]);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const applyRef = useRef<(i: number) => void>(() => {});

  /* Layout switches rarely, so state (and a rebuild) is fine here. */
  const [name, setName] = useState<LayoutName>("wide");
  const layout = LAYOUTS[name];

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setName(mq.matches ? "narrow" : "wide");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const svg = svgRef.current;
    if (!root || !svg) return;

    const nodes = Array.from(svg.querySelectorAll<SVGGElement>("[data-node]"));
    const traces = Array.from(svg.querySelectorAll<SVGPathElement>("[data-trace]"));
    const badges = Array.from(svg.querySelectorAll<SVGGElement>("[data-badge]"));
    const vchips = Array.from(svg.querySelectorAll<SVGGElement>("[data-vchip]"));
    /* One dot per connection, so a beat can move several at once. */
    const dots = new Map<string, SVGGElement>(
      Array.from(svg.querySelectorAll<SVGGElement>("[data-dot]")).map((el) => [
        el.dataset.dot as string,
        el,
      ]),
    );

    /* The chip the current build stamps onto the version rail. */
    const newest = vchips[vchips.length - 1];

    const traceOf = (key: string) => traces.find((t) => t.dataset.trace === key);

    /** Single source of truth for "what is lit at beat i". Idempotent. */
    const applyBeat = (i: number) => {
      const override = BEAT_HOT[i];
      for (const el of nodes) {
        const id = el.dataset.node as NodeId;
        const beat = NODES[id].beat;
        const hot = override ? override.includes(id) : beat === i;
        el.dataset.state = hot ? "hot" : beat <= i ? "warm" : "idle";
      }
      for (const el of vchips) {
        const k = Number(el.dataset.vchip);
        el.dataset.state =
          (i === 1 && k === 3) || (i === 5 && k === 2) ? "hot" : k === 3 && i < 1 ? "idle" : "warm";
      }
      chipsRef.current.forEach((el, k) => {
        if (el) el.dataset.active = k === i ? "1" : "0";
      });
      capsRef.current.forEach((el, k) => {
        if (el) el.dataset.active = k === i ? "1" : "0";
      });
    };
    applyRef.current = applyBeat;

    /* Park each badge over the midpoint of the edge it annotates. Done here
     * rather than in the layout data so both layouts stay coordinate-only. */
    for (const badge of badges) {
      const path = traceOf(badge.dataset.badge ?? "");
      if (!path) continue;
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      badge.setAttribute("transform", `translate(${mid.x} ${mid.y})`);
    }

    /* ── Reduced motion: fully-drawn static diagram, chips still work ── */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.dataset.static = "1";
      applyBeat(0);
      for (const el of nodes) el.dataset.state = "warm";
      for (const el of vchips) el.dataset.state = "warm";
      return;
    }
    delete root.dataset.static;

    const fadeAll: Element[] = [...traces, ...badges];
    let ctx: gsap.Context | undefined;
    let io: IntersectionObserver | undefined;

    try {
      ctx = gsap.context(() => {
        for (const p of traces) {
          const len = p.getTotalLength();
          p.style.strokeDasharray = `${len}`;
          p.style.strokeDashoffset = `${len}`;
        }

        const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, paused: true });
        tlRef.current = tl;

        tl.set(traces, { opacity: 1 }, 0);
        /* Badges belong to an edge that has not drawn yet - stay hidden until
         * their beat, or they read as connections that already exist. */
        tl.set(badges, { opacity: 0 }, 0);
        tl.set([...dots.values()], { opacity: 0 }, 0);
        if (newest) tl.set(newest, { opacity: 0, "--smap-stamp": 0.45 }, 0);

        BEATS.forEach((beat, i) => {
          const at = i * BEAT;
          tl.addLabel(beat.id, at);
          tl.call(() => applyBeat(i), undefined, at);

          /* Every connection on this beat draws itself, staggered, each one
           * drawn *by* its own dot - same duration and ease, so the dot sits
           * exactly on the drawing head. */
          const own = EDGES.filter((e) => e.beat === i);
          own.forEach((e, k) => {
            const key = edgeKey(e);
            const start = at + k * 0.1;
            const path = traceOf(key);

            if (path) {
              tl.to(
                path,
                { strokeDashoffset: 0, duration: DRAW, ease: "power2.inOut" },
                start,
              );

              const dot = dots.get(key);
              if (dot) {
                const len = path.getTotalLength();
                const head = { p: 0 };
                tl.to(dot, { opacity: 1, duration: 0.14 }, start);
                tl.to(
                  head,
                  {
                    p: 1,
                    duration: DRAW,
                    ease: "power2.inOut",
                    onUpdate: () => {
                      const pt = path.getPointAtLength(head.p * len);
                      dot.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
                    },
                  },
                  start,
                );
                tl.to(dot, { opacity: 0, duration: 0.3 }, start + DRAW - 0.12);
              }
            }

            const badge = badges.find((b) => b.dataset.badge === key);
            if (badge) {
              tl.fromTo(badge, { opacity: 0 }, { opacity: 1, duration: 0.4 }, at + BEAT * 0.45);
            }
          });
        });

        /* Beat 1 stamps the new immutable version onto the rail. The scale goes
         * through a custom property that CSS applies around an explicit
         * viewBox-space origin: letting GSAP transform the group directly
         * leaves a residual origin-compensation matrix that shifts the chip. */
        if (newest) {
          tl.to(
            newest,
            {
              opacity: 1,
              "--smap-stamp": 1,
              duration: 0.55,
              ease: "back.out(2.2)",
            },
            BEAT + 0.45,
          );
        }

        /* Soften the wrap-around instead of popping back to an empty diagram. */
        tl.to(fadeAll, { opacity: 0, duration: 0.45, ease: "power1.in" }, TOTAL - 0.45);

        applyBeat(0);

        /* Only run while actually on screen. */
        io = new IntersectionObserver(
          ([entry]) => {
            if (entry.isIntersecting && !document.hidden) tl.play();
            else tl.pause();
          },
          { threshold: 0.15 },
        );
        io.observe(root);
      }, root);
    } catch {
      root.dataset.static = "1";
      for (const el of nodes) el.dataset.state = "warm";
      applyBeat(0);
    }

    const onVisibility = () => {
      const tl = tlRef.current;
      if (!tl) return;
      if (document.hidden) tl.pause();
      else if (root.dataset.static !== "1") tl.play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
      ctx?.revert();
      tlRef.current = null;
      for (const p of traces) {
        p.style.strokeDasharray = "";
        p.style.strokeDashoffset = "";
      }
    };
  }, [name]);

  /* Seek fires the beat callbacks it passes over, but not when jumping
   * backwards - so re-apply afterwards to cover both directions. */
  const seek = (i: number) => {
    tlRef.current?.seek(BEATS[i].id, false).play();
    applyRef.current(i);
  };

  const net = netBox(layout.pos);
  const chips = versionChips(layout.pos.versions);
  /* The trace gradient runs across the whole diagram in user space. Object
   * bounding box would collapse to zero width on a perfectly vertical edge. */
  const [vbX, , vbW] = layout.viewBox.split(" ").map(Number);

  return (
    <section id="features" className="smap-outer">
      <DarkSection>
        <div className="smap-container" ref={rootRef}>
          <header className="smap-head">
            <p className="smap-eyebrow">The system</p>
            <h2 className="smap-title">
              One system.
              <br />
              Every layer.
            </h2>
            <p className="smap-sub">
              From a git push to a served request — this is the actual path your code
              takes, and every box on it is something Openship runs for you.
            </p>
          </header>

          <div className="smap-stage">
            <svg
              ref={svgRef}
              className="smap-svg"
              viewBox={layout.viewBox}
              fill="none"
              aria-hidden="true"
            >
              <defs>
                <radialGradient id="smap-packet-grad">
                  <stop offset="0%" stopColor="#ede9fe" stopOpacity="1" />
                  <stop offset="45%" stopColor="#a78bfa" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
                </radialGradient>
                <linearGradient
                  id="smap-trace-grad"
                  gradientUnits="userSpaceOnUse"
                  x1={vbX}
                  y1="0"
                  x2={vbX + vbW}
                  y2="0"
                >
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="55%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#c084fc" />
                </linearGradient>
              </defs>

              {/* Private network bracket around the managed services */}
              <g className="smap-net">
                <rect
                  className="smap-net-box"
                  x={net.x}
                  y={net.y}
                  width={net.w}
                  height={net.h}
                  rx={16}
                />
                <text className="smap-net-label" x={net.x + 14} y={net.y + 14}>
                  private network
                </text>
              </g>

              {/* Connections: a faint always-on base, plus the animated trace */}
              {EDGES.map((e) => {
                const d = edgePath(layout, e);
                const key = edgeKey(e);
                return (
                  <g key={key} className="smap-edge">
                    <path className="smap-edge-base" d={d} />
                    <path className="smap-edge-trace" data-trace={key} d={d} />
                  </g>
                );
              })}

              {/* Edge labels - positioned onto their path midpoint at runtime */}
              {EDGES.filter((e) => e.label).map((e) => {
                const key = edgeKey(e);
                const w = (e.label as string).length * 6.4 + 18;
                return (
                  <g key={`b-${key}`} className="smap-badge" data-badge={key}>
                    <rect
                      className="smap-badge-bg"
                      x={-w / 2}
                      y={-10}
                      width={w}
                      height={20}
                      rx={10}
                    />
                    <text className="smap-badge-text" x={0} y={1}>
                      {e.label}
                    </text>
                  </g>
                );
              })}

              {/* Nodes */}
              {(Object.keys(NODES) as NodeId[]).map((id) => {
                const def = NODES[id];
                const b = layout.pos[id];

                if (def.kind === "rail") {
                  return (
                    <g
                      key={id}
                      className="smap-node smap-node--rail"
                      data-node={id}
                      data-state="idle"
                    >
                      <rect
                        className="smap-node-shape"
                        x={b.x}
                        y={b.y}
                        width={b.w}
                        height={b.h}
                        rx={16}
                      />
                      {chips.map((c, i) => (
                        <g
                          key={c.label}
                          data-vchip={i}
                          data-state="idle"
                          className={
                            i === chips.length - 1
                              ? "smap-vchip smap-vchip--stamp"
                              : "smap-vchip"
                          }
                          style={
                            i === chips.length - 1
                              ? { transformOrigin: `${c.x + c.w / 2}px ${c.y + c.h / 2}px` }
                              : undefined
                          }
                        >
                          <rect
                            className="smap-vchip-bg"
                            x={c.x}
                            y={c.y}
                            width={c.w}
                            height={c.h}
                            rx={7}
                          />
                          <text
                            className="smap-vchip-text"
                            x={c.x + c.w / 2}
                            y={c.y + c.h / 2}
                          >
                            {c.label}
                          </text>
                        </g>
                      ))}
                      <text
                        className="smap-node-sub"
                        x={cx(b)}
                        y={b.y + b.h - 13}
                      >
                        {def.label}
                      </text>
                    </g>
                  );
                }

                if (def.kind === "system") {
                  const r = b.w / 2;
                  return (
                    <g
                      key={id}
                      className="smap-node smap-node--system"
                      data-node={id}
                      data-state="idle"
                    >
                      <path className="smap-node-halo" d={hexPath({ ...b, w: b.w + 26, h: b.h + 26, x: b.x - 13, y: b.y - 13 })} />
                      <path className="smap-node-shape" d={hexPath(b)} />
                      <circle
                        className="smap-node-spin"
                        cx={cx(b)}
                        cy={cy(b)}
                        r={r - 16}
                      />
                      <text className="smap-node-label" x={cx(b)} y={cy(b) - (def.sub ? 8 : 0)}>
                        {def.label}
                      </text>
                      {def.sub ? (
                        <text className="smap-node-sub" x={cx(b)} y={cy(b) + 12}>
                          {def.sub}
                        </text>
                      ) : null}
                    </g>
                  );
                }

                return (
                  <g
                    key={id}
                    className="smap-node smap-node--pill"
                    data-node={id}
                    data-state="idle"
                  >
                    <rect
                      className="smap-node-halo"
                      x={b.x - 7}
                      y={b.y - 7}
                      width={b.w + 14}
                      height={b.h + 14}
                      rx={(b.h + 14) / 2}
                    />
                    <rect
                      className="smap-node-shape"
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      rx={b.h / 2}
                    />
                    {def.sub ? (
                      <>
                        <text className="smap-node-label" x={cx(b)} y={b.y + 17}>
                          {def.label}
                        </text>
                        <text className="smap-node-sub" x={cx(b)} y={b.y + 32}>
                          {def.sub}
                        </text>
                      </>
                    ) : (
                      <text className="smap-node-label" x={cx(b)} y={cy(b)}>
                        {def.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* One travelling dot per connection, drawn above everything */}
              {EDGES.map((e) => (
                <g
                  key={`d-${edgeKey(e)}`}
                  className="smap-dot"
                  data-dot={edgeKey(e)}
                  transform="translate(-60 -60)"
                >
                  <circle className="smap-dot-glow" r={9} />
                  <circle className="smap-dot-core" r={2.4} />
                </g>
              ))}
            </svg>

            <p className="smap-sr">{SR_DESCRIPTION}</p>
          </div>

          {/* Beat chips - also a way to jump straight to a step */}
          <div className="smap-chips">
            {BEATS.map((b, i) => (
              <button
                key={b.id}
                type="button"
                className="smap-chip"
                data-active={i === 0 ? "1" : "0"}
                ref={(el) => {
                  chipsRef.current[i] = el;
                }}
                onClick={() => seek(i)}
              >
                <span className="smap-chip-dot" aria-hidden="true" />
                <span className="smap-chip-n">{String(i + 1).padStart(2, "0")}</span>
                {b.chip}
              </button>
            ))}
          </div>

          <div className="smap-captions">
            {BEATS.map((b, i) => (
              <p
                key={b.id}
                className="smap-caption"
                data-active={i === 0 ? "1" : "0"}
                ref={(el) => {
                  capsRef.current[i] = el;
                }}
              >
                {b.caption}
              </p>
            ))}
          </div>
        </div>
      </DarkSection>
    </section>
  );
}
