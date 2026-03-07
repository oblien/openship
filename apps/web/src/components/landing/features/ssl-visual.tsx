export function SslVisual() {
  return (
    <svg viewBox="0 0 520 260" fill="none" className="w-full h-auto">
      {/* Central lock */}
      <path d="M240 78 V58 C240 34 280 34 280 58 V78" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity={0.5} strokeLinecap="round" />
      <rect x="226" y="78" width="68" height="56" rx="10" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.45} />
      <circle cx="260" cy="102" r="5" fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.4} />
      <line x1="260" y1="106" x2="260" y2="118" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.4} strokeLinecap="round" />
      <text x="260" y="154" textAnchor="middle" fontSize="14" fontWeight="600" fill="currentColor" fillOpacity={0.85} letterSpacing=".04em">HTTPS</text>

      {/* Left: Domain card */}
      <rect x="20" y="58" width="170" height="56" rx="10" fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.2} />
      <circle cx="38" cy="80" r="4" fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <path d="M36 80 L37.5 82 L40.5 78" stroke="currentColor" strokeWidth="1" strokeOpacity={0.45} strokeLinecap="round" fill="none" />
      <text x="50" y="84" fontSize="11" fontFamily="monospace" fill="currentColor" fillOpacity={0.6}>app.company.com</text>
      <text x="105" y="126" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.35}>Custom domain</text>

      {/* Connection: domain → lock */}
      <line x1="192" y1="86" x2="224" y2="98" stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.15} strokeDasharray="4 4" />

      {/* Right: Certificate card */}
      <rect x="330" y="52" width="160" height="72" rx="10" fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.2} />
      <line x1="348" y1="72" x2="472" y2="72" stroke="currentColor" strokeOpacity={0.12} strokeWidth=".8" />
      <line x1="348" y1="86" x2="460" y2="86" stroke="currentColor" strokeOpacity={0.08} strokeWidth=".8" />
      <line x1="348" y1="100" x2="466" y2="100" stroke="currentColor" strokeOpacity={0.08} strokeWidth=".8" />
      {/* Seal */}
      <circle cx="408" cy="110" r="7" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <path d="M405 110 L407 112 L412 108" stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.5} strokeLinecap="round" fill="none" />
      <text x="408" y="138" textAnchor="middle" fontSize="11" fontWeight="500" fill="currentColor" fillOpacity={0.35}>SSL certificate</text>

      {/* Connection: lock → cert */}
      <line x1="296" y1="98" x2="328" y2="88" stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.15} strokeDasharray="4 4" />

      {/* Bottom: DNS records */}
      <rect x="60" y="176" width="400" height="48" rx="10" fill="currentColor" fillOpacity={0.03} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.15} />
      <text x="190" y="204" textAnchor="middle" fontSize="11" fontFamily="monospace" fill="currentColor" fillOpacity={0.45}>A  143.198.42.17</text>
      <line x1="260" y1="186" x2="260" y2="214" stroke="currentColor" strokeOpacity={0.1} strokeWidth=".6" />
      <text x="350" y="204" textAnchor="middle" fontSize="11" fontFamily="monospace" fill="currentColor" fillOpacity={0.45}>CNAME  edge.os.dev</text>
    </svg>
  );
}
