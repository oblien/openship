export function InfraVisual() {
  return (
    <svg viewBox="0 0 520 260" fill="none" className="w-full h-auto">
      {/* Central app node */}
      <rect x="200" y="86" width="120" height="52" rx="12"
        fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.5} />
      <text x="260" y="116" textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor" fillOpacity={0.8}>Your App</text>

      {/* ── Top row services ── */}
      {/* PostgreSQL */}
      <rect x="30" y="22" width="100" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="52" cy="42" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="88" y="47" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>Postgres</text>
      {/* Connection to app */}
      <line x1="130" y1="46" x2="200" y2="100" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* Redis */}
      <rect x="210" y="10" width="100" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="232" cy="30" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="270" y="35" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>Redis</text>
      {/* Connection */}
      <line x1="260" y1="50" x2="260" y2="86" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* MongoDB */}
      <rect x="390" y="22" width="100" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="412" cy="42" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="448" y="47" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>MongoDB</text>
      {/* Connection */}
      <line x1="390" y1="46" x2="320" y2="100" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* ── Bottom row services ── */}
      {/* API Gateway */}
      <rect x="14" y="168" width="110" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="36" cy="188" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="78" y="193" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>API Gateway</text>
      <line x1="124" y1="182" x2="210" y2="138" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* WebSocket */}
      <rect x="148" y="180" width="106" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="170" cy="200" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="210" y="205" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>WebSocket</text>
      <line x1="230" y1="180" x2="248" y2="138" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* Worker */}
      <rect x="278" y="180" width="100" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="300" cy="200" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="336" y="205" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>Worker</text>
      <line x1="300" y1="180" x2="275" y2="138" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* S3 / Storage */}
      <rect x="402" y="168" width="100" height="40" rx="8"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      <circle cx="424" cy="188" r="4" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="460" y="193" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.55}>Storage</text>
      <line x1="402" y1="182" x2="320" y2="138" stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} strokeDasharray="3 3" />

      {/* "One click" badge */}
      <rect x="187" y="232" width="146" height="24" rx="12"
        fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1" strokeOpacity={0.2} />
      <text x="260" y="248" textAnchor="middle" fontSize="10" fontWeight="600" fill="currentColor" fillOpacity={0.5} letterSpacing=".06em">ONE CLICK SETUP</text>
    </svg>
  );
}
