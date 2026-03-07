export function RollbackVisual() {
  return (
    <svg viewBox="0 0 520 260" fill="none" className="w-full h-auto">
      {/* Timeline */}
      <line x1="50" y1="110" x2="470" y2="110" stroke="currentColor" strokeWidth="2" strokeOpacity={0.3} strokeLinecap="round" />

      {/* Rollback arrow */}
      <path d="M415 98 C405 54 325 46 300 80" stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.45} strokeLinecap="round" fill="none" strokeDasharray="5 4" />
      <path d="M304 72 L296 86 L310 84" fill="none" stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.5} strokeLinecap="round" strokeLinejoin="round" />
      <text x="358" y="56" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor" fillOpacity={0.65}>rollback</text>

      {/* v1.0 */}
      <circle cx="100" cy="110" r="8" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.35} />
      <circle cx="100" cy="110" r="3" fill="currentColor" fillOpacity={0.55} />
      <text x="100" y="142" textAnchor="middle" fontSize="13" fontFamily="monospace" fontWeight="500" fill="currentColor" fillOpacity={0.6}>v1.0</text>
      <text x="100" y="160" textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.3}>2 days ago</text>

      {/* v1.1 */}
      <circle cx="210" cy="110" r="8" fill="currentColor" fillOpacity={0.06} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.35} />
      <circle cx="210" cy="110" r="3" fill="currentColor" fillOpacity={0.55} />
      <text x="210" y="142" textAnchor="middle" fontSize="13" fontFamily="monospace" fontWeight="500" fill="currentColor" fillOpacity={0.6}>v1.1</text>
      <text x="210" y="160" textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.3}>yesterday</text>

      {/* v1.2 — rollback target — emphasized */}
      <circle cx="320" cy="110" r="10" fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth="2.2" strokeOpacity={0.6} />
      <circle cx="320" cy="110" r="4" fill="currentColor" fillOpacity={0.75} />
      <text x="320" y="144" textAnchor="middle" fontSize="14" fontFamily="monospace" fontWeight="600" fill="currentColor" fillOpacity={0.8}>v1.2</text>
      <text x="320" y="162" textAnchor="middle" fontSize="10" fontWeight="500" fill="currentColor" fillOpacity={0.45}>3h ago</text>
      {/* Snapshot card */}
      <rect x="285" y="174" width="70" height="46" rx="8" fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1" strokeOpacity={0.15} />
      <line x1="296" y1="190" x2="344" y2="190" stroke="currentColor" strokeWidth=".8" strokeOpacity={0.15} />
      <line x1="296" y1="200" x2="336" y2="200" stroke="currentColor" strokeWidth=".8" strokeOpacity={0.1} />
      <line x1="296" y1="210" x2="340" y2="210" stroke="currentColor" strokeWidth=".8" strokeOpacity={0.08} />

      {/* v1.3 — current (faded) */}
      <circle cx="430" cy="110" r="8" fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.8" strokeOpacity={0.2} />
      <circle cx="430" cy="110" r="3" fill="currentColor" fillOpacity={0.3} />
      <text x="430" y="142" textAnchor="middle" fontSize="13" fontFamily="monospace" fill="currentColor" fillOpacity={0.35}>v1.3</text>
      <text x="430" y="160" textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.2}>current</text>
    </svg>
  );
}
