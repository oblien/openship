import type { ReactNode } from "react";
import type { IllustrationArtwork } from "./IllustrationFrame";
import { ACCENT, ACCENT_INK, INK } from "./palette";

// Flat shapes shared by the extended feature collection.
const r = (x: number, y: number, w: number, h: number, radius = 6, fill = INK, opacity = 1) => (
  <rect x={x} y={y} width={w} height={h} rx={radius} fill={fill} opacity={opacity} />
);
const c = (x: number, y: number, radius: number, fill = INK, opacity = 1) => (
  <circle cx={x} cy={y} r={radius} fill={fill} opacity={opacity} />
);
const p = (d: string, fill = INK, opacity = 1) => <path d={d} fill={fill} opacity={opacity} />;
const l = (d: string, opacity = 0.4, width = 2, color = INK) => (
  <path
    d={d}
    fill="none"
    stroke={color}
    strokeOpacity={opacity}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);
const cut = (id: string, holes: ReactNode, drawing: ReactNode) => (
  <>
    <defs>
      <mask id={`${id}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="64">
        {r(0, 0, 80, 64, 0, "white")}
        {holes}
      </mask>
    </defs>
    <g mask={`url(#${id}-cut)`}>{drawing}</g>
  </>
);
const panel = (id: string, x: number, y: number, w: number, h: number, holes?: ReactNode) =>
  cut(
    id,
    <>
      {r(x + 7, y + 5, 6, 2, 1, "black")}
      {r(x + 16, y + 5, 3, 2, 1, "black")}
      {r(x, y + 12, w, 1.5, 0, "black")}
      {holes}
    </>,
    r(x, y, w, h, 8),
  );
const check = (x: number, y: number) => l(`m${x} ${y} 3 3 6-7`, 1, 2, ACCENT_INK);
const person = (x: number, y: number, opacity = 1) => (
  <>
    {c(x + 10, y + 7, 7, INK, opacity)}
    {p(`M${x - 3} ${y + 34}v-5a13 13 0 0 1 26 0v5Z`, INK, opacity)}
  </>
);
const envelope = (id: string, x = 9, y = 22) =>
  cut(id, l(`m${x + 1} ${y + 4} 27 18 27-18`, 1, 2.2, "black"), r(x, y, 56, 34, 8));
const lock = (x: number, y: number) => (
  <>
    {l(`M${x + 5} ${y + 8}V${y + 5}a5 5 0 0 1 10 0v3`, 1, 2.5)}
    {r(x, y + 8, 25, 18, 6, ACCENT)}
    {r(x + 11, y + 13, 3, 7, 1.5, ACCENT_INK)}
  </>
);

export const capabilityArtwork = {
  "local-folder-deploys": (id) => (
    <>
      {p("M7 22V14a7 7 0 0 1 7-7h16l8 8h27a7 7 0 0 1 7 7v24H7Z", INK, 0.22)}
      {cut(id, <>{l("M39 49V29m-9 9 9-9 9 9", 1, 3, "black")}</>, r(5, 22, 68, 36, 9))}
      {c(65, 18, 5, ACCENT)}
    </>
  ),
  "configuration-as-code": (id) => (
    <>
      {r(24, 4, 44, 47, 8, INK, 0.18)}
      {panel(
        id,
        13,
        10,
        44,
        49,
        <>{l("M29 29h-4v6l-3 2 3 2v7h4m13-17h4v6l3 2-3 2v7h-4", 1, 2, "black")}</>,
      )}
      {c(35, 34, 1.8, ACCENT)}
      {c(35, 41, 1.8, ACCENT)}
    </>
  ),
  "api-sdk": (id) => (
    <>
      {cut(
        id,
        <>{l("M23 20h-5v9l-4 3 4 3v9h5m34-24h5v9l4 3-4 3v9h-5", 1, 2.5, "black")}</>,
        <>
          {r(6, 10, 25, 44, 9)}
          {r(49, 10, 25, 44, 9, INK, 0.65)}
        </>,
      )}
      {l("M29 32h22", 0.35, 2)}
      {c(40, 32, 4, ACCENT)}
    </>
  ),
  "deploy-anywhere": () => (
    <>
      {l("M40 31v12M16 49v-6h48v6", 0.28, 2)}
      {p("M21 33a11 11 0 0 1-2-22 16 16 0 0 1 30-1 12 12 0 1 1 6 23Z")}
      {r(6, 47, 22, 13, 5, INK, 0.35)}
      {r(52, 47, 22, 13, 5, INK, 0.35)}
      {c(17, 53.5, 2, ACCENT)}
      {c(63, 53.5, 2, ACCENT)}
    </>
  ),
  "push-to-deploy": (id) => (
    <>
      {l("M16 17v29m0-14c0-14 35 0 35-19", 0.35, 3)}
      {c(16, 12, 6)}
      {c(16, 51, 6, INK, 0.35)}
      {l("m44 17 7-7 7 7", 1, 2.5, ACCENT)}
      {panel(id, 33, 29, 39, 29, <>{r(40, 48, 17, 3, 1.5, "black")}</>)}
    </>
  ),
  "any-stack": (id) => (
    <>
      {r(5, 5, 57, 43, 8, INK, 0.14)}
      {r(12, 12, 57, 43, 8, INK, 0.28)}
      {panel(
        id,
        19,
        19,
        57,
        43,
        <>{l("m37 39-6 5 6 5m20-10 6 5-6 5m-14 2 4-14", 1, 2.2, "black")}</>,
      )}
      {c(67, 25, 2, ACCENT)}
    </>
  ),
  "autoscaling-load-balancing": () => (
    <>
      {l("M29 17h11v30H29m11-15h13", 0.3, 2)}
      {r(5, 7, 25, 19, 6, INK, 0.35)}
      {r(5, 38, 25, 19, 6, INK, 0.35)}
      {r(52, 22, 25, 20, 7)}
      {l("M12 16h10m-10 31h10", 0.7, 2)}
      {c(64.5, 32, 3, ACCENT)}
    </>
  ),
  "private-networking": (id) => (
    <>
      {l("M40 13v11M15 52l15-10m20 0 15 10", 0.3, 2)}
      {c(40, 9, 5, INK, 0.4)}
      {r(7, 48, 13, 13, 4, INK, 0.4)}
      {r(60, 48, 13, 13, 4, INK, 0.4)}
      {cut(
        id,
        <>
          {r(38.5, 29, 3, 10, 1.5, "black")}
          {c(40, 29, 3, "black")}
        </>,
        p("m40 16 15 6v13c0 10-9 17-15 20-6-3-15-10-15-20V22Z"),
      )}
      {c(65, 54, 2.5, ACCENT)}
    </>
  ),
  "route-rules-waf": () => (
    <>
      {p("m40 4 27 8v21c0 14-15 24-27 29-12-5-27-15-27-29V12Z", INK, 0.1)}
      {l("M21 20h38M21 32h38M21 44h38", 0.5, 4)}
      {r(29, 15, 9, 10, 4)}
      {r(45, 27, 9, 10, 4)}
      {r(24, 39, 9, 10, 4, ACCENT)}
    </>
  ),
  mail: (id) => (
    <>
      {r(20, 5, 40, 33, 7, INK, 0.2)}
      {l("M29 12h22m-22 7h15", 0.6, 2)}
      {envelope(id)}
      {c(66, 48, 10, ACCENT)}
      {check(61, 48)}
    </>
  ),
  "dashboard-cli-desktop": (id) => (
    <>
      {r(5, 6, 59, 39, 8, INK, 0.25)}
      {l("M26 46v9m-12 0h25", 0.35, 2)}
      {l("M14 32v-8m8 8V18m8 14V22", 0.6, 3)}
      {cut(id, l("m45 37 6 5-6 5m12 0h8", 1, 2, "black"), r(35, 29, 42, 28, 7))}
      {c(57, 13, 2, ACCENT)}
    </>
  ),
  "preview-deployments": (id) => (
    <>
      {r(5, 5, 53, 41, 8, INK, 0.15)}
      {r(12, 12, 53, 41, 8, INK, 0.3)}
      {panel(id, 19, 19, 56, 42, <>{p("M32 43q15-19 30 0-15 19-30 0Z", "black")}</>)}
      {c(47, 43, 5)}
      {c(47, 43, 2, ACCENT)}
    </>
  ),
  "runner-destinations": (id) => (
    <>
      {cut(
        id,
        <>
          {r(19, 17, 24, 4, 2, "black")}
          {r(19, 31, 24, 4, 2, "black")}
        </>,
        r(10, 7, 47, 49, 9),
      )}
      {r(19, 45, 12, 3, 1.5, INK, 0.3)}
      {c(60, 45, 15, ACCENT)}
      {p("M56 37 68 45 56 53Z", ACCENT_INK)}
    </>
  ),
  "sleep-resource-limits": () => (
    <>
      {r(6, 17, 56, 41, 8, INK, 0.12)}
      {r(15, 35, 7, 15, 3, INK, 0.35)}
      {r(29, 26, 7, 24, 3)}
      {r(43, 31, 7, 19, 3, INK, 0.65)}
      {p("M66 5a15 15 0 1 0 9 27A17 17 0 0 1 66 5Z", ACCENT)}
    </>
  ),
  "edge-routing": (id) => (
    <>
      {l("M8 32h18m27 0h7V12h8M60 32v20h8", 0.3, 2)}
      {c(8, 32, 4, INK, 0.5)}
      {cut(id, l("m36 25 7 7-7 7", 1, 3, "black"), r(25, 18, 29, 28, 9))}
      {r(64, 6, 13, 12, 4, INK, 0.35)}
      {r(64, 46, 13, 12, 4, ACCENT)}
    </>
  ),
  webhooks: () => (
    <>
      {l("M37 17 20 43m23-26 17 26M28 48h24", 0.25, 3)}
      {c(40, 12, 8)}
      {c(17, 48, 10, INK, 0.35)}
      {c(63, 48, 10, INK, 0.35)}
      {l("M17 42v7h19m-5-5 5 5-5 5", 1, 2.5)}
      {c(40, 12, 3, ACCENT)}
    </>
  ),
  "git-authentication": () => (
    <>
      {l("M17 17v30m0-15c0-15 37 0 37-17", 0.35, 3)}
      {c(17, 11, 6)}
      {c(17, 53, 6, INK, 0.4)}
      {c(54, 10, 5, INK, 0.4)}
      {lock(48, 32)}
    </>
  ),
  "app-catalog": (id) => (
    <>
      {cut(
        id,
        <>
          {p("m23 10 6 6-6 6-6-6Z", "black")}
          {r(16, 45, 14, 3, 1.5, "black")}
          {r(16, 51, 9, 3, 1.5, "black")}
        </>,
        <>
          {r(9, 4, 28, 25, 7)}
          {r(9, 35, 28, 25, 7, INK, 0.55)}
        </>,
      )}
      {r(43, 4, 28, 25, 7, INK, 0.2)}
      {r(43, 35, 28, 25, 7, INK, 0.2)}
      {c(57, 16.5, 4, ACCENT)}
      {l("M51 47.5h12m-6-6v12", 0.8, 2)}
    </>
  ),
  "persistent-storage": (id) => (
    <>
      {r(20, 5, 40, 31, 7, INK, 0.22)}
      {l("M28 13h24m-24 7h17", 0.5, 2)}
      {cut(
        id,
        <>
          {r(6, 42, 68, 2, 0, "black")}
          {r(45, 50, 18, 3, 1.5, "black")}
        </>,
        r(6, 27, 68, 33, 9),
      )}
      {c(17, 51, 3, ACCENT)}
    </>
  ),
  "object-storage": (id) => (
    <>
      {r(14, 4, 17, 17, 5, INK, 0.25)}
      {r(36, 8, 17, 17, 5, INK, 0.55)}
      {r(57, 4, 17, 17, 5, ACCENT)}
      {cut(id, r(29, 39, 22, 5, 2.5, "black"), p("M8 27h64l-6 29a6 6 0 0 1-6 5H20a6 6 0 0 1-6-5Z"))}
    </>
  ),
  "server-management": (id) => (
    <>
      {cut(
        id,
        <>
          {r(15, 15, 28, 3, 1.5, "black")}
          {r(15, 21, 17, 3, 1.5, "black")}
          {r(15, 41, 28, 3, 1.5, "black")}
          {r(15, 47, 17, 3, 1.5, "black")}
        </>,
        <>
          {r(7, 7, 66, 23, 7)}
          {r(7, 35, 66, 23, 7, INK, 0.5)}
        </>,
      )}
      {c(62, 18.5, 3, ACCENT)}
      {c(62, 46.5, 3, ACCENT)}
    </>
  ),
  "migration-import": (id) => (
    <>
      {r(5, 12, 28, 42, 7, INK, 0.25)}
      {panel(id, 47, 12, 28, 42, r(54, 43, 13, 3, 1.5, "black"))}
      {l("M17 34h43m-7-7 7 7-7 7", 1, 3, ACCENT)}
    </>
  ),
  "instance-transfer": (id) => (
    <>
      {r(8, 6, 50, 42, 8, INK, 0.2)}
      {panel(id, 17, 15, 50, 42, c(42, 39, 9, "black"))}
      {c(42, 39, 6, INK)}
      {l("M57 16h16v15m-16 0 16-15", 1, 3, ACCENT)}
    </>
  ),
  notifications: () => (
    <>
      {r(36, 6, 35, 25, 7, INK, 0.12)}
      {r(29, 13, 35, 25, 7, INK, 0.24)}
      {p("M13 48c5-6 4-12 4-18a17 17 0 0 1 34 0c0 6-1 12 4 18Z")}
      {p("M27 53a7 7 0 0 0 14 0Z", INK, 0.5)}
      {c(57, 18, 6, ACCENT)}
    </>
  ),
  "secrets-credentials": (id) => (
    <>
      {r(16, 6, 53, 48, 8, INK, 0.2)}
      {cut(
        id,
        <>
          {c(39, 35, 12, "black")}
          {r(14, 18, 2, 6, 1, "black")}
          {r(14, 45, 2, 6, 1, "black")}
        </>,
        r(9, 12, 53, 48, 8),
      )}
      {l("M39 25v6m10 4h-6m-4 10v-6m-10-4h6", 0.75, 2)}
      {c(39, 35, 3, ACCENT)}
    </>
  ),
  "scoped-tokens": (id) => (
    <>
      {r(12, 7, 59, 37, 9, INK, 0.2)}
      {cut(
        id,
        <>
          {c(26, 37, 8, "black")}
          {r(32, 35, 24, 4, 2, "black")}
          {r(45, 37, 4, 7, 1, "black")}
          {r(53, 37, 3, 5, 1, "black")}
        </>,
        r(5, 18, 65, 37, 10),
      )}
      {c(26, 37, 3, ACCENT)}
    </>
  ),
  "audit-log": (id) => (
    <>
      {r(25, 3, 42, 49, 8, INK, 0.18)}
      {cut(
        id,
        <>
          {r(29, 22, 22, 3, 1.5, "black")}
          {r(29, 34, 22, 3, 1.5, "black")}
          {r(29, 46, 15, 3, 1.5, "black")}
          {c(22, 35.5, 2, "black")}
          {c(22, 47.5, 2, "black")}
        </>,
        r(12, 10, 48, 50, 8),
      )}
      {c(22, 23.5, 4, ACCENT)}
      {check(19, 23.5)}
    </>
  ),
  "two-factor-auth": (id) => (
    <>
      {cut(
        id,
        <>
          {r(18, 12, 26, 37, 5, "black")}
          {r(26, 6, 11, 2, 1, "black")}
        </>,
        r(12, 3, 38, 58, 9),
      )}
      {c(24, 30, 2)}
      {c(31, 30, 2)}
      {c(38, 30, 2)}
      {c(31, 55, 2, ACCENT)}
      {r(43, 35, 30, 23, 7, ACCENT)}
      {l("M51 45v5m7-9v9m7-5v5", 1, 2, ACCENT_INK)}
    </>
  ),
  "deployment-health-checks": () => (
    <>
      {r(5, 8, 59, 43, 9, INK, 0.15)}
      {l("M12 34h9l6-13 9 23 7-15h12", 1, 2.5)}
      {p("m62 34 14 5v8c0 7-7 12-14 16-7-4-14-9-14-16v-8Z", ACCENT)}
      {check(57, 47)}
    </>
  ),
  updates: (id) => (
    <>
      {r(6, 19, 51, 41, 8, INK, 0.15)}
      {r(14, 11, 51, 41, 8, INK, 0.32)}
      {cut(id, l("M48 34V14m-9 9 9-9 9 9", 1, 3, "black"), r(22, 3, 51, 41, 8))}
      {c(14, 53, 3, ACCENT)}
    </>
  ),
  workspaces: (id) => (
    <>
      {r(5, 5, 47, 37, 8, INK, 0.14)}
      {r(13, 13, 47, 37, 8, INK, 0.28)}
      {panel(
        id,
        21,
        21,
        52,
        40,
        <>
          {r(29, 40, 13, 13, 3, "black")}
          {r(47, 40, 17, 3, 1.5, "black")}
          {r(47, 47, 12, 3, 1.5, "black")}
        </>,
      )}
      {c(64, 27, 2, ACCENT)}
    </>
  ),
  "team-roles": () => (
    <>
      {person(43, 10, 0.25)}
      {person(17, 8)}
      {c(61, 47, 12, ACCENT)}
      {p("m61 39 6 8-6 8-6-8Z", ACCENT_INK)}
    </>
  ),
  "resource-permissions": (id) => (
    <>
      {r(6, 7, 59, 47, 9, INK, 0.12)}
      {cut(
        id,
        <>
          {r(16, 16, 13, 13, 3, "black")}
          {r(36, 16, 13, 13, 3, "black")}
          {r(16, 36, 13, 10, 3, "black")}
        </>,
        r(11, 11, 45, 40, 7),
      )}
      {lock(48, 33)}
    </>
  ),
  invitations: (id) => (
    <>
      {person(27, 2, 0.3)}
      {envelope(id, 6, 25)}
      {c(65, 47, 12, ACCENT)}
      {l("M59 47h12m-6-6v12", 1, 2.5, ACCENT_INK)}
    </>
  ),
  "workflow-approvals": (id) => (
    <>
      {l("M12 18v28m0-14h26", 0.3, 2)}
      {r(5, 6, 14, 14, 4, INK, 0.3)}
      {r(5, 45, 14, 14, 4, INK, 0.3)}
      {cut(
        id,
        <>
          {r(45, 16, 18, 3, 1.5, "black")}
          {r(45, 47, 13, 3, 1.5, "black")}
        </>,
        r(36, 7, 36, 51, 8),
      )}
      {c(54, 33, 10, ACCENT)}
      {check(49, 33)}
    </>
  ),
  "project-environments": (id) => (
    <>
      {r(4, 6, 72, 52, 9, INK, 0.1)}
      {cut(
        id,
        <>
          {r(13, 21, 8, 2, 1, "black")}
          {r(36, 21, 8, 2, 1, "black")}
          {r(59, 21, 8, 2, 1, "black")}
        </>,
        <>
          {r(9, 17, 16, 32, 5, INK, 0.3)}
          {r(32, 17, 16, 32, 5, INK, 0.6)}
          {r(55, 17, 16, 32, 5)}
        </>,
      )}
      {c(17, 40, 2, INK, 0.7)}
      {c(40, 40, 2, INK, 0.7)}
      {c(63, 40, 2.5, ACCENT)}
    </>
  ),
} satisfies Record<string, IllustrationArtwork>;
