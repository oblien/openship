export function GitVisual() {
  return (
    <svg viewBox="0 0 520 260" fill="none" className="w-full h-auto">
      {/* Main branch line */}
      <line x1="50" y1="100" x2="470" y2="100" stroke="currentColor" strokeWidth="2" strokeOpacity={0.35} strokeLinecap="round" />

      {/* Feature branch arc */}
      <path d="M140 100 C155 100 162 62 182 56" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.25} fill="none" />
      <line x1="182" y1="56" x2="308" y2="56" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.25} strokeLinecap="round" />
      <path d="M308 56 C328 62 335 100 350 100" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.25} fill="none" />

      {/* Commits on main */}
      <circle cx="50" cy="100" r="6" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.4} />
      <circle cx="50" cy="100" r="2" fill="currentColor" fillOpacity={0.6} />
      <circle cx="140" cy="100" r="6" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.4} />
      <circle cx="140" cy="100" r="2" fill="currentColor" fillOpacity={0.6} />
      {/* Merge commit — emphasized */}
      <circle cx="350" cy="100" r="8" fill="currentColor" fillOpacity={0.1} stroke="currentColor" strokeWidth="2" strokeOpacity={0.6} />
      <circle cx="350" cy="100" r="3" fill="currentColor" fillOpacity={0.7} />
      <circle cx="440" cy="100" r="6" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.4} />
      <circle cx="440" cy="100" r="2" fill="currentColor" fillOpacity={0.6} />

      {/* Feature branch commits */}
      <circle cx="222" cy="56" r="5" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.3} />
      <circle cx="222" cy="56" r="1.5" fill="currentColor" fillOpacity={0.5} />
      <circle cx="280" cy="56" r="5" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.3} />
      <circle cx="280" cy="56" r="1.5" fill="currentColor" fillOpacity={0.5} />

      {/* Labels — main commits */}
      <text x="50" y="124" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.4}>a3f2c</text>
      <text x="140" y="124" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.4}>b7e4a</text>
      <text x="350" y="126" textAnchor="middle" fontSize="11" fontFamily="monospace" fontWeight="600" fill="currentColor" fillOpacity={0.7}>merge</text>
      <text x="440" y="124" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.4}>deploy</text>

      {/* Branch labels */}
      <text x="251" y="42" textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" fillOpacity={0.55}>feat/dashboard</text>
      <text x="30" y="146" fontSize="11" fontWeight="600" fill="currentColor" fillOpacity={0.55}>main</text>

      {/* Deploy arrow */}
      <line x1="440" y1="112" x2="440" y2="162" stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.2} strokeDasharray="3 3" />
      <path d="M436 159 L440 168 L444 159" fill="currentColor" fillOpacity={0.25} />

      {/* Pipeline bar */}
      <rect x="80" y="180" width="360" height="44" rx="10" fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.2} />
      {/* Build */}
      <circle cx="160" cy="202" r="4" fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth="1" strokeOpacity={0.35} />
      <path d="M157.5 202 L159.5 204 L163 200" stroke="currentColor" strokeWidth="1" strokeOpacity={0.5} strokeLinecap="round" fill="none" />
      <text x="174" y="206" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.5}>Build</text>
      <line x1="220" y1="190" x2="220" y2="214" stroke="currentColor" strokeOpacity={0.1} strokeWidth=".6" />
      {/* Test */}
      <circle cx="260" cy="202" r="4" fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth="1" strokeOpacity={0.35} />
      <path d="M257.5 202 L259.5 204 L263 200" stroke="currentColor" strokeWidth="1" strokeOpacity={0.5} strokeLinecap="round" fill="none" />
      <text x="274" y="206" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.5}>Test</text>
      <line x1="320" y1="190" x2="320" y2="214" stroke="currentColor" strokeOpacity={0.1} strokeWidth=".6" />
      {/* Live */}
      <circle cx="360" cy="202" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.5} />
      <path d="M357.5 202 L359.5 204 L363 200" stroke="currentColor" strokeWidth="1" strokeOpacity={0.6} strokeLinecap="round" fill="none" />
      <text x="374" y="206" fontSize="11" fontWeight="600" fill="currentColor" fillOpacity={0.65}>Live</text>
    </svg>
  );
}
