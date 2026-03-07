export function AiVisual() {
  return (
    <svg viewBox="0 0 520 260" fill="none" className="w-full h-auto">
      {/* Terminal window */}
      <rect x="20" y="32" width="210" height="148" rx="12"
        fill="currentColor" fillOpacity={0.05} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.2} />
      {/* Title bar */}
      <circle cx="38" cy="50" r="3.5" fill="currentColor" fillOpacity={0.2} />
      <circle cx="50" cy="50" r="3.5" fill="currentColor" fillOpacity={0.2} />
      <circle cx="62" cy="50" r="3.5" fill="currentColor" fillOpacity={0.2} />
      <line x1="20" y1="62" x2="230" y2="62" stroke="currentColor" strokeWidth=".5" strokeOpacity={0.12} />
      {/* Terminal lines */}
      <text x="34" y="82" fontSize="11.5" fontFamily="monospace" fill="currentColor" fillOpacity={0.35}>$</text>
      <text x="46" y="82" fontSize="11.5" fontFamily="monospace" fill="currentColor" fillOpacity={0.65}>openship deploy</text>
      <text x="34" y="102" fontSize="11.5" fontFamily="monospace" fill="currentColor" fillOpacity={0.75}>✕ Build failed</text>
      <text x="34" y="120" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.35}>Module not found</text>
      <text x="34" y="136" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.3}>src/index.ts:14</text>
      <text x="34" y="152" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.25}>ERR_MODULE_NOT_FOUND</text>

      {/* Arrow: terminal → AI */}
      <line x1="236" y1="106" x2="280" y2="106" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.25} strokeDasharray="4 4" />
      <path d="M277 101 L286 106 L277 111" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity={0.35} />

      {/* AI Agent block */}
      <rect x="292" y="32" width="195" height="148" rx="12"
        fill="currentColor" fillOpacity={0.04} stroke="currentColor" strokeWidth="1.2" strokeOpacity={0.25} />
      {/* Sparkles */}
      <path d="M390 60 L393 70 L403 73 L393 76 L390 86 L387 76 L377 73 L387 70 Z" fill="currentColor" fillOpacity={0.45} />
      <path d="M340 50 L342 56 L348 58 L342 60 L340 66 L338 60 L332 58 L338 56 Z" fill="currentColor" fillOpacity={0.3} />
      <path d="M440 48 L441.5 52 L446 54 L441.5 56 L440 60 L438.5 56 L434 54 L438.5 52 Z" fill="currentColor" fillOpacity={0.2} />
      <text x="390" y="110" textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor" fillOpacity={0.85}>AI Agent</text>
      <text x="390" y="128" textAnchor="middle" fontSize="11" fill="currentColor" fillOpacity={0.4}>Analyzing error…</text>
      {/* Fix result */}
      <line x1="310" y1="146" x2="470" y2="146" stroke="currentColor" strokeWidth=".5" strokeOpacity={0.12} />
      <circle cx="320" cy="160" r="3" fill="currentColor" fillOpacity={0.4} />
      <text x="330" y="164" fontSize="10" fontFamily="monospace" fill="currentColor" fillOpacity={0.45}>fix applied ✓</text>

      {/* Bottom flow: Error → Diagnose → Fixed */}
      <text x="125" y="224" textAnchor="middle" fontSize="12" fontWeight="500" fill="currentColor" fillOpacity={0.5}>Error</text>
      <line x1="162" y1="220" x2="218" y2="220" stroke="currentColor" strokeWidth="1" strokeOpacity={0.2} />
      <path d="M215 216 L223 220 L215 224" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="260" y="224" textAnchor="middle" fontSize="12" fontWeight="500" fill="currentColor" fillOpacity={0.5}>Diagnose</text>
      <line x1="300" y1="220" x2="356" y2="220" stroke="currentColor" strokeWidth="1" strokeOpacity={0.2} />
      <path d="M353 216 L361 220 L353 224" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity={0.3} />
      <text x="395" y="224" textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor" fillOpacity={0.7}>Fixed ✓</text>
    </svg>
  );
}
