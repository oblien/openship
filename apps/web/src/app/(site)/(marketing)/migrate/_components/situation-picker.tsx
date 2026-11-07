"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Situation } from "../_data";

function Cross() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2l2.3 2.3 4.7-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Pick-your-problem selector. Each situation has its own hash (#bill, #limits, …)
 * so links from posts and replies open the right one.
 */
export function SituationPicker({ items }: { items: Situation[] }) {
  const [active, setActive] = useState(items[0]?.id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const viewRef = useRef<HTMLDivElement>(null);

  const fromHash = useCallback(() => {
    const id = window.location.hash.slice(1);
    if (items.some((s) => s.id === id)) {
      setActive(id as Situation["id"]);
      document.getElementById("situations")?.scrollIntoView();
    }
  }, [items]);

  useEffect(() => {
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [fromHash]);

  const choose = (id: Situation["id"]) => {
    setActive(id);
    if (window.matchMedia("(max-width: 980px)").matches) {
      viewRef.current?.scrollIntoView({ block: "start" });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + items.length) % items.length;
    setActive(items[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="mg-picker">
      <div
        className="mg-plist"
        role="tablist"
        aria-label="Your situation"
        aria-orientation="vertical"
      >
        {items.map((s, i) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`mg-tab-${s.id}`}
              aria-controls={`mg-panel-${s.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(s.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="mg-plist-n">{i + 1}</span>
              <span>
                <strong>{s.title}</strong>
                <em>{s.hint}</em>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mg-pview" ref={viewRef}>
        {items.map((s) => (
          <div
            key={s.id}
            role="tabpanel"
            id={`mg-panel-${s.id}`}
            aria-labelledby={`mg-tab-${s.id}`}
            hidden={s.id !== active}
            className="mg-ppanel"
          >
            <div className="mg-pp-top">
              <p className="mg-quote">{s.quote}</p>
            </div>
            <div className="mg-pp-cols">
              <div className="mg-pp-col">
                <span className="mg-tag mg-tag--problem">What’s going on</span>
                <ul>
                  {s.problems.map((p) => (
                    <li key={p.lead}>
                      <span className="mg-ic mg-ic--x">
                        <Cross />
                      </span>
                      <span>
                        <b>{p.lead}</b>
                        {p.rest}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mg-pp-col">
                <span className="mg-tag mg-tag--fix">On Openship Cloud</span>
                <ul>
                  {s.fixes.map((f) => (
                    <li key={f.lead}>
                      <span className="mg-ic mg-ic--ok">
                        <Tick />
                      </span>
                      <span>
                        <b>{f.lead}</b>
                        {f.rest}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mg-pp-foot">
              <span>{s.footNote}</span>
              <a href={s.footLink.href}>{s.footLink.label} →</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
