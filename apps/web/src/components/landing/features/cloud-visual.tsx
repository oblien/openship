export function CloudVisual() {
  return (
    <svg viewBox="0 0 540 260" fill="none" className="w-full h-auto">
      {/* ── Left: Cloud shape ── */}
      <path
        d="M48 158 C46 158 30 100 92 82 C112 34 182 26 204 68 C236 44 280 66 276 112 C310 108 324 140 304 166 L48 166 Z"
        fill="currentColor" fillOpacity=".05" stroke="currentColor" strokeWidth="1.8" strokeOpacity=".4" strokeLinejoin="round"
      />
      <circle cx="118" cy="108" r="5" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".3" />
      <circle cx="118" cy="108" r="2" fill="currentColor" fillOpacity=".65" />
      <circle cx="176" cy="94" r="5" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".3" />
      <circle cx="176" cy="94" r="2" fill="currentColor" fillOpacity=".65" />
      <circle cx="232" cy="106" r="5" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".3" />
      <circle cx="232" cy="106" r="2" fill="currentColor" fillOpacity=".65" />
      <line x1="123" y1="107" x2="171" y2="96" stroke="currentColor" strokeWidth=".8" strokeOpacity=".2" />
      <line x1="181" y1="96" x2="227" y2="105" stroke="currentColor" strokeWidth=".8" strokeOpacity=".2" />
      <text x="175" y="196" textAnchor="middle" fontSize="14" fontWeight="600" fill="currentColor" fillOpacity=".75">Managed</text>
      <text x="175" y="214" textAnchor="middle" fontSize="11" fill="currentColor" fillOpacity=".4">Auto-scaling · Zero ops</text>

      {/* ── Center divider ── */}
      <line x1="278" y1="50" x2="278" y2="175" stroke="currentColor" strokeWidth="1" strokeOpacity=".15" strokeDasharray="4 4" />
      <text x="278" y="196" textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor" fillOpacity=".3" letterSpacing=".12em">OR</text>

      {/* ── Right: Server rack ── */}
      <rect x="336" y="60" width="154" height="30" rx="6" fill="currentColor" fillOpacity=".04" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".25" />
      <rect x="336" y="96" width="154" height="30" rx="6" fill="currentColor" fillOpacity=".04" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".25" />
      <rect x="336" y="132" width="154" height="30" rx="6" fill="currentColor" fillOpacity=".04" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".25" />
      <circle cx="352" cy="75" r="2.5" fill="currentColor" fillOpacity=".45" />
      <circle cx="362" cy="75" r="2.5" fill="currentColor" fillOpacity=".25" />
      <circle cx="352" cy="111" r="2.5" fill="currentColor" fillOpacity=".45" />
      <circle cx="362" cy="111" r="2.5" fill="currentColor" fillOpacity=".25" />
      <circle cx="352" cy="147" r="2.5" fill="currentColor" fillOpacity=".45" />
      <circle cx="362" cy="147" r="2.5" fill="currentColor" fillOpacity=".25" />
      <line x1="378" y1="68" x2="478" y2="68" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <line x1="378" y1="82" x2="478" y2="82" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <line x1="378" y1="104" x2="478" y2="104" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <line x1="378" y1="118" x2="478" y2="118" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <line x1="378" y1="140" x2="478" y2="140" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <line x1="378" y1="154" x2="478" y2="154" stroke="currentColor" strokeWidth=".6" strokeOpacity=".1" />
      <text x="413" y="196" textAnchor="middle" fontSize="14" fontWeight="600" fill="currentColor" fillOpacity=".75">Self-Hosted</text>
      <text x="413" y="214" textAnchor="middle" fontSize="11" fill="currentColor" fillOpacity=".4">Your servers · Full control</text>
    </svg>
  );
}
