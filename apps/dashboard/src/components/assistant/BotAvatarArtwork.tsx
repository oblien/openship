import type { AssistantAgentArtwork } from "@repo/contracts";

type CharacterId = Exclude<AssistantAgentArtwork, "crew">;
type Expression = "open" | "round" | "happy" | "resting" | "wink";
type CharacterDefinition = {
  color: string;
  body: string;
  face: [x: number, y: number, tilt: number];
  expression?: Expression;
};

// Original flat bot characters: a solid silhouette and a small, expressive face.
// Shared proportions keep the family coherent; posture and gaze give each its identity.
const characters: Record<CharacterId, CharacterDefinition> = {
  mint: {
    color: "#70B5A5",
    body: "M31 4C46 3 58 16 59 31C60 47 48 60 33 60C18 60 5 49 5 34C5 19 16 5 31 4Z",
    face: [21, 24, 0],
  },
  terminal: {
    color: "#E7A54B",
    body: "M32 5C48 5 60 18 60 33C60 49 48 60 32 59C16 58 4 47 4 32C4 17 16 5 32 5Z",
    face: [20, 26, -5],
    expression: "happy",
  },
  "shield-check": {
    color: "#865FDE",
    body: "M24 8C29 4 35 4 40 8L55 23C61 29 61 35 55 41L41 55C35 61 29 61 23 55L9 41C3 35 3 29 9 23Z",
    face: [23, 25, 0],
    expression: "resting",
  },
  rocket: {
    color: "#6961DC",
    body: "M24 10C28 3 36 3 40 10L57 39C64 51 58 58 45 58L19 58C6 58 0 51 7 39Z",
    face: [21, 32, 0],
  },
  activity: {
    color: "#DF8A94",
    body: "M23 7C35 3 45 8 50 19L58 39C63 52 53 59 38 60L21 59C7 58 2 50 6 37L13 17C15 12 18 9 23 7Z",
    face: [18, 24, 13],
  },
  code: {
    color: "#5585DE",
    body: "M25 5C40 2 54 13 58 27C62 41 52 56 37 59C22 62 9 52 5 38C1 24 10 8 25 5Z",
    face: [23, 22, -10],
    expression: "round",
  },
  database: {
    color: "#7CAEC9",
    body: "M20 8L40 5C52 3 59 11 59 23L57 40C56 52 48 58 36 59L21 60C9 60 4 52 5 40L6 25C7 15 11 10 20 8Z",
    face: [18, 27, -9],
  },
  cloud: {
    color: "#70BBB9",
    body: "M20 12C28 10 39 10 46 13C56 16 62 24 61 34C60 47 50 55 36 55L26 55C13 55 3 48 3 36C2 25 8 15 20 12Z",
    face: [22, 27, 0],
    expression: "resting",
  },
  bug: {
    color: "#DE8048",
    body: "M18 7C26 5 40 4 47 8C55 12 57 23 59 34C61 46 56 55 46 58C35 61 18 60 10 53C3 47 5 33 6 23C7 15 10 9 18 7Z",
    face: [21, 25, -4],
    expression: "wink",
  },
  search: {
    color: "#D4B35C",
    body: "M5 34C5 18 17 6 32 6C47 6 59 18 59 34L59 43C59 54 54 58 43 58L21 58C10 58 5 54 5 43Z",
    face: [24, 29, 0],
    expression: "round",
  },
  "git-branch": {
    color: "#BA89BD",
    body: "M33 5C46 2 59 11 58 24C58 34 47 36 42 44C35 56 24 62 14 57C4 52 3 40 8 27C13 14 22 7 33 5Z",
    face: [18, 25, -16],
  },
  server: {
    color: "#A0B77A",
    body: "M31 4C43 4 51 16 54 28L58 44C61 55 53 60 39 60L25 60C11 60 3 55 6 44L10 28C13 16 19 4 31 4Z",
    face: [21, 23, 0],
  },
  comet: {
    color: "#D58467",
    body: "M20 10C30 1 44 3 53 13C62 23 61 34 52 43L43 52C33 62 20 63 11 53C1 43 3 31 12 20Z",
    face: [20, 25, -20],
    expression: "wink",
  },
  petal: {
    color: "#99A5DA",
    body: "M14 9C26 4 43 4 53 11C63 18 59 32 51 42L40 54C33 62 25 61 18 53L7 35C2 24 4 13 14 9Z",
    face: [22, 22, 7],
  },
  puff: {
    color: "#D7A0AF",
    body: "M21 5H43C49 5 52 8 52 14V18C57 18 59 22 59 28V43C59 54 54 59 43 59H21C10 59 5 54 5 43V28C5 22 7 18 12 18V14C12 8 15 5 21 5Z",
    face: [21, 28, 0],
  },
};

function Face({ expression = "open" }: { expression?: Expression }) {
  if (expression === "happy") {
    return (
      <g stroke="#151B19" strokeWidth="5.5" strokeLinecap="round">
        <path d="M0 7C0-1 8-1 8 7" />
        <path d="M16 7C16-1 24-1 24 7" />
      </g>
    );
  }
  if (expression === "round") {
    return (
      <g fill="#151B19">
        <ellipse cx="3.5" cy="5.5" rx="4" ry="5" />
        <ellipse cx="19.5" cy="5.5" rx="4" ry="5" />
      </g>
    );
  }
  if (expression === "resting") {
    return (
      <g fill="#151B19">
        <rect x="-1" y="3" width="8" height="5" rx="2.5" />
        <rect x="15" y="3" width="8" height="5" rx="2.5" />
      </g>
    );
  }
  return (
    <g fill="#151B19">
      <rect width="6.5" height="11.5" rx="3.25" />
      {expression === "wink" ? (
        <rect x="15" y="4" width="9" height="4.5" rx="2.25" />
      ) : (
        <rect x="16" width="6.5" height="11.5" rx="3.25" />
      )}
    </g>
  );
}

function Character({ id }: { id: CharacterId }) {
  const { body, color, face, expression } = characters[id];
  return (
    <>
      <path d={body} fill={color} />
      <g transform={`translate(${face[0]} ${face[1]}) rotate(${face[2]})`}>
        <Face expression={expression} />
      </g>
    </>
  );
}

export function BotAvatarArtwork({ id }: { id: AssistantAgentArtwork }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="size-full"
      data-bot-avatar={id}
    >
      {id === "crew" ? (
        <>
          <g transform="translate(25 0) scale(.55)">
            <Character id="code" />
          </g>
          <g transform="translate(0 17) scale(.65)">
            <path d={characters.mint.body} strokeWidth="6" className="stroke-background" />
            <Character id="mint" />
          </g>
          <g transform="translate(29 28) scale(.54)">
            <path
              d={characters["shield-check"].body}
              strokeWidth="6"
              className="stroke-background"
            />
            <Character id="shield-check" />
          </g>
        </>
      ) : (
        <Character id={id} />
      )}
    </svg>
  );
}
