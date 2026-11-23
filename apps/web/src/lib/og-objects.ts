// Each silhouette describes a destination. The shared inks keep fine edges and
// folds legible against the paper background when the card is reduced to a link.
const featureSubjects = {
  "build-performance": `<path d="M54 190a116 116 0 0 1 232 0" fill="none" stroke="#c5cac3" stroke-width="30"/><path d="M54 190a116 116 0 0 1 146-112" fill="none" stroke="url(#metal)" stroke-width="30"/><path d="m157 178 78-61-52 86Z" fill="#9ba892"/><circle cx="170" cy="190" r="18" fill="#40473f"/>`,
  "docker-swarm": `<g fill="url(#pearl)" stroke="#90988d" stroke-width="2"><path d="m91 57 43 25v50l-43 25-43-25V82Z"/><path d="m248 57 43 25v50l-43 25-43-25V82Z"/><path d="m170 128 43 25v50l-43 25-43-25v-50Z" fill="url(#sage)"/></g>`,
  "static-sites-workers": `<rect x="32" y="39" width="186" height="148" rx="13" fill="url(#pearl)"/><path d="M32 78h186" stroke="#949b93" stroke-width="3"/><g fill="#838d81"><circle cx="51" cy="59" r="4"/><circle cx="66" cy="59" r="4"/></g><path d="m232 95-82 93h54l-9 66 88-106h-55Z" fill="url(#metal)"/>`,
  "traffic-analytics": `<path d="M30 215h283" stroke="#959d93" stroke-width="2"/><path d="M32 207c40 0 52-78 91-78s52 56 82 34 54-89 98-100v142Z" fill="url(#sage)"/><path d="M32 204c39 0 69-60 107-52s62 31 87 15 51-57 77-59" fill="none" stroke="#465246" stroke-width="7" stroke-linecap="round"/>`,
  "ai-agents": `<g transform="translate(170 141)" stroke-width="30" stroke-linecap="round"><path d="M0-86v47" stroke="#b3a2c9"/><path d="m74-43-40 23m40 63-40-23M0 86V40m-74 3 40-23m-40-63 40 23" stroke="#414740"/></g><circle cx="170" cy="141" r="15" fill="#a8b3a5"/>`,
  "chat-integrations": `<path d="M27 64h139v84H90l-33 29v-29H27Z" fill="url(#pearl)"/><path d="M181 67h115m-26-22 26 22-26 22M154 209H45m23-20-23 20 23 20" stroke="#969e92" fill="none" stroke-width="5"/><path d="M180 127h138v80h-25v28l-31-28h-82Z" fill="url(#sage)"/>`,
  "dns-tunnels": `<g fill="none" stroke-width="19"><ellipse cx="98" cy="133" rx="46" ry="83" stroke="#464c46"/><ellipse cx="175" cy="133" rx="46" ry="83" stroke="#bcc4bb"/><ellipse cx="249" cy="133" rx="46" ry="83" stroke="#9fadbd"/></g><path d="M14 134h304" stroke="#747e75" stroke-width="3" stroke-dasharray="7 7"/>`,
  terminals: `<rect x="23" y="44" width="294" height="191" rx="19" fill="url(#metal)"/><g fill="none" stroke="#edece7" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><path d="m62 101 38 34-38 34"/><path d="M127 169h78" stroke="#b6c8ad"/></g>`,
  "security-advisories": `<path d="M155 35q15-26 30 0l114 191q11 21-13 21H54q-24 0-13-21Z" fill="url(#paper)" stroke="#a9aa9e" stroke-width="3"/><path d="M170 93v68" fill="none" stroke="#565d53" stroke-width="17" stroke-linecap="round"/><circle cx="170" cy="194" r="10" fill="#b19268"/>`,
  "cluster-databases": `<g stroke="#99a297" stroke-width="2"><path d="M37 82v83c0 36 112 36 112 0V82Z" fill="url(#pearl)"/><ellipse cx="93" cy="82" rx="56" ry="20" fill="#eceee7"/><path d="M187 125v68c0 36 112 36 112 0v-68Z" fill="url(#sage)"/><ellipse cx="243" cy="125" rx="56" ry="20" fill="#d5dfd2"/></g><path d="M151 106h17v53h17" fill="none" stroke="#6a766b" stroke-width="4"/>`,
  "shared-cluster-storage": `<path d="M69 77v56h201V77m-100 57v51" fill="none" stroke="#929c91" stroke-width="6"/><g fill="#40483f"><circle cx="69" cy="70" r="22"/><circle cx="170" cy="70" r="22"/><circle cx="270" cy="70" r="22"/></g><path d="M170 72v62" stroke="#929c91" stroke-width="6"/><rect x="111" y="177" width="118" height="49" rx="12" fill="url(#sage)"/><path d="M128 202h52" stroke="#6d806d" stroke-width="5" stroke-linecap="round"/>`,
  "static-response-routes": `<path d="M34 135h119m-32-30 33 30-33 30" stroke="#8da48d" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M173 37h82l45 45v157H173Z" fill="url(#pearl)"/><path d="M255 37v45h45" fill="#919b91"/><path d="M197 132h73m-73 23h47" stroke="#798578" stroke-width="6" stroke-linecap="round"/>`,
  "project-topology": `<path d="M60 70h110v140h110m-110-70h110" stroke="#abb2aa" stroke-width="5" fill="none"/><rect x="28" y="48" width="84" height="42" rx="12" fill="#485047"/><circle cx="170" cy="140" r="17" fill="#9eaca0"/><rect x="242" y="119" width="68" height="42" rx="12" fill="#bec8d3"/><rect x="242" y="188" width="68" height="42" rx="12" fill="#b5bcb4"/>`,
} as const;

export function subjectForFeature(slug: string) {
  return Object.hasOwn(featureSubjects, slug) ? (slug as keyof typeof featureSubjects) : undefined;
}

const objects = {
  ...featureSubjects,
  alerts: `<path d="M92 184q17-15 17-63a61 61 0 0 1 122 0q0 48 17 63l11 16H81Z" fill="url(#pearl)" stroke="#a1a69d" stroke-width="2"/><path d="M145 211a26 26 0 0 0 50 0Z" fill="#444b42"/><circle cx="228" cy="84" r="29" fill="#cfac92"/><path d="M228 69v16m0 10v1" stroke="#5a493c" stroke-width="5" stroke-linecap="round"/>`,
  costs: `<g transform="rotate(-9 170 140)"><path d="M80 25h172v230l-16-10-14 10-15-10-15 10-15-10-15 10-15-10-15 10-15-10-14 10-13-10-10 8Z" fill="url(#paper)" stroke="#aaafa5" stroke-width="2"/><path d="M107 68h76m-76 35h43m55 0h20m-118 21h56m42 0h20m-118 21h37m61 0h20" stroke="#8a9488" stroke-width="5" stroke-linecap="round"/><path d="M106 174h120" stroke="#adb4a9" stroke-width="2" stroke-dasharray="5 5"/><rect x="167" y="190" width="60" height="13" rx="5" fill="#a3bca0"/></g>`,
  compiler: `<path d="M20 140h102" stroke="#a5aaa1" stroke-width="5"/><path d="m169 40 71 164H96Z" fill="url(#pearl)" stroke="#9caa9b" stroke-width="2"/><path d="m134 141 54-7 126-61m-126 61 126 3m-126-3 126 63" fill="none" stroke="#a79cb6" stroke-width="5"/>`,
  introduction: `<g fill="none" stroke-width="15" stroke-linecap="round"><path d="M70 202a117 117 0 1 1 207-18" stroke="url(#metal)"/><path d="M104 190a79 79 0 1 1 139-13" stroke="#a8b6aa"/><path d="M139 177a40 40 0 1 1 66-12" stroke="#ccc4d4"/></g>`,
  milestone: `<path d="M96 238V36" stroke="#4b534c" stroke-width="7" stroke-linecap="round"/><path d="M100 44c50-36 86 38 169-1l-23 50 23 41c-80 36-120-35-169-2Z" fill="url(#lilac)"/><ellipse cx="95" cy="245" rx="46" ry="5" fill="#d5d9d0"/>`,
  android: `<rect x="98" y="17" width="144" height="245" rx="24" fill="url(#metal)"/><rect x="105" y="25" width="130" height="228" rx="19" fill="url(#paper)"/><circle cx="170" cy="35" r="3" fill="#515853"/><path d="M125 162v-53l45 34 45-34v53" stroke="#87a38a" stroke-width="13" fill="none" stroke-linejoin="round"/>`,
  ios: `<g transform="rotate(9 170 140)"><rect x="68" y="38" width="204" height="204" rx="48" fill="url(#pearl)" stroke="#a9b4b8" stroke-width="2"/><rect x="105" y="95" width="130" height="89" rx="9" fill="#627d91"/><path d="m107 99 63 49 63-49m-124 82 39-36m82 36-38-36" fill="none" stroke="#e5e9e9" stroke-width="5"/></g>`,
  desktop: `<rect x="26" y="39" width="288" height="183" rx="15" fill="url(#metal)"/><rect x="37" y="50" width="266" height="159" rx="8" fill="url(#paper)"/><path d="M37 50h74v159H37Z" fill="#bbc0b6"/><path d="M130 80h88m-88 23h145m-145 23h103" stroke="#a5ada6" stroke-width="6" stroke-linecap="round"/><path d="M149 222h42l7 20h20v7h-96v-7h20Z" fill="#686e69"/>`,
  nodemailer: `<path d="m170 15 109 62v126l-109 62-109-62V77Z" fill="url(#sage)" stroke="#9aa89a" stroke-width="2"/><g fill="none" stroke="#394c40" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"><path d="m131 109-33 33 33 30m78-63 33 33-33 30m-25-77-28 92"/></g>`,
  deploy: `<path d="M12 236c55 29 105 24 111-5 5-26-43-27-41-3 4 26 67 19 110-30" fill="none" stroke="#9daca1" stroke-width="2.5" stroke-dasharray="6 7"/>
    <path d="m62 125 250-84-80 199-67-53-37 38-6-73Z" fill="url(#paper)" stroke="#8d988e" stroke-width="2" stroke-linejoin="round"/>
    <path d="m122 152 190-111-153 137-31 47Z" fill="#91ac9b"/><path d="m159 178-31 47 37-38Z" fill="#48594c"/>
    <path d="M159 178 312 41l-80 199Z" fill="url(#pearl)"/><path d="m159 178 73 62" stroke="#a4ada4" stroke-width="2"/>`,
  mail: `<path d="m31 119 131-93a15 15 0 0 1 18 0l130 93-1 117H31Z" fill="#aaa6bc"/>
    <g transform="rotate(-9 165 130)"><rect x="72" y="52" width="196" height="164" rx="8" fill="url(#paper)" stroke="#b6b3ba" stroke-width="2"/>
    <path d="M96 84h66m-66 17h98m-98 17h80" stroke="#a5a5a0" stroke-width="5" stroke-linecap="round"/>
    <circle cx="231" cy="84" r="15" fill="none" stroke="#af9aca" stroke-width="5"/></g>
    <path d="M31 119 164 191l146-72v111a14 14 0 0 1-14 14H45a14 14 0 0 1-14-14Z" fill="url(#pearl)" stroke="#aba9b1" stroke-width="2"/><path d="m34 239 104-76m169 76-103-77" fill="none" stroke="#bcbac2" stroke-width="2"/>`,
  pricing: `<g stroke="#aaa9a0" stroke-width="1.4" stroke-linejoin="round">
    <path d="m29 185 56-21 50 18-56 22Z" fill="#fff"/><path d="m29 185 50 19v53l-50-18Z" fill="#d6d8d2"/><path d="m79 204 56-22v53l-56 22Z" fill="#b6b9b2"/>
    <path d="m110 123 56-21 50 18-56 22Z" fill="#f4eee1"/><path d="m110 123 50 19v115l-50-18Z" fill="#e0d6c0"/><path d="m160 142 56-22v115l-56 22Z" fill="#beb19b"/>
    <path d="m191 62 56-21 50 18-56 22Z" fill="#555a55"/><path d="m191 62 50 19v176l-50-18Z" fill="#383c39"/><path d="m241 81 56-22v176l-56 22Z" fill="#242825"/></g>`,
  referrals: `<g fill="none" stroke-width="27" transform="rotate(-34 170 142)">
    <rect x="37" y="98" width="154" height="83" rx="41.5" stroke="url(#metal)"/>
    <rect x="148" y="98" width="154" height="83" rx="41.5" stroke="url(#lilac)"/>
    <path d="M148 98a42 42 0 0 1 42 42" stroke="url(#metal)"/></g>`,
  support: `<g transform="rotate(-24 170 142)" fill="none">
    <circle cx="170" cy="142" r="112" stroke="#b6b2aa" stroke-width="2"/>
    <circle cx="170" cy="142" r="83" stroke="url(#pearl)" stroke-width="54"/>
    <circle cx="170" cy="142" r="83" stroke="#cc9e88" stroke-width="54" stroke-dasharray="39 91.38"/>
    <circle cx="170" cy="142" r="56" stroke="#9b938d" stroke-width="2"/></g>`,
  contact: `<path d="M47 51h174a31 31 0 0 1 31 31v63a31 31 0 0 1-31 31h-92l-50 40v-40H47a31 31 0 0 1-31-31V82a31 31 0 0 1 31-31Z" fill="url(#pearl)" stroke="#abaea9" stroke-width="2"/>
    <path d="M176 136h100a27 27 0 0 1 27 27v40a27 27 0 0 1-27 27v25l-38-25h-62a27 27 0 0 1-27-27v-40a27 27 0 0 1 27-27Z" fill="#444c47"/>
    <path d="M61 91h109m-109 25h70" fill="none" stroke="#b3b6ae" stroke-width="7" stroke-linecap="round"/><g fill="#cfdec9"><circle cx="194" cy="185" r="5"/><circle cx="223" cy="185" r="5"/><circle cx="252" cy="185" r="5"/></g>`,
  about: `<g transform="rotate(-26 170 141)"><ellipse cx="170" cy="154" rx="131" ry="77" fill="none" stroke="#aaa9af" stroke-width="35"/><ellipse cx="170" cy="141" rx="131" ry="77" fill="none" stroke="url(#metal)" stroke-width="34"/><path d="M271 91q29 18 30 49" fill="none" stroke="#bcadd6" stroke-width="34"/></g>`,
  download: `<path d="m42 184 30-17 26 37h148l25-37 29 17-33 61H75Z" fill="url(#metal)"/><path d="m72 167 25 17h146l28-17-25 37H98Z" fill="#858b85"/>
    <path d="M146 30h49v76h44l-69 68-68-68h44Z" fill="url(#sage)" stroke="#929f94" stroke-width="2" stroke-linejoin="round"/>`,
  privacy: `<path d="M12 145q66-87 158-87t158 87q-66 86-158 86T12 145Z" fill="url(#pearl)" stroke="#acb0ac" stroke-width="2"/>
    <circle cx="170" cy="145" r="62" fill="#a9bbae"/><circle cx="170" cy="145" r="32" fill="#354239"/><circle cx="183" cy="132" r="9" fill="#e7eee7"/>
    <path d="m70 235 201-180" stroke="#f8f8f5" stroke-width="20"/><path d="m70 235 201-180" stroke="#626b63" stroke-width="9" stroke-linecap="round"/>`,
  trust: `<path d="M170 18q54 35 112 38v74q0 80-112 133Q58 210 58 130V56q58-3 112-38Z" fill="url(#metal)"/>
    <path d="M170 37q48 29 93 33v58q0 68-93 114Z" fill="#9eaea2"/><path d="m124 140 32 31 61-65" fill="none" stroke="#f5f6ed" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`,
  uptime: `<g stroke="#d9ded7" stroke-width="1.5"><path d="M12 74h315M12 143h315M12 211h315M70 37v206m67-206v206m67-206v206m67-206v206"/></g>
    <path d="M12 158h70l27-39 35 82 38-145 31 102h65" fill="none" stroke="#393f3b" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/><circle cx="292" cy="158" r="25" fill="#c6dcc8"/><circle cx="292" cy="158" r="10" fill="#536f53"/>`,
  terms: `<path d="m90 26 144 9 35 44-12 177-181-12Z" fill="url(#paper)" stroke="#a9aaa4" stroke-width="2"/><path d="m234 35-3 42 38 2" fill="#bec0b8"/><g transform="rotate(4 162 131)" fill="none" stroke-linecap="round"><path d="M110 86h60m-60 23h98m-98 20h82m-82 19h94" stroke="#9ea39c" stroke-width="5"/><path d="M108 207c23-10 35-49 26-48s-15 67 11 39c10-13 10-11 8-2s9 8 18 3l21-3" stroke="#85819c" stroke-width="3.5"/></g>`,
  journal: `<g transform="rotate(-12 170 141)"><path d="M41 59q67-13 129 11 61-24 128-11v166q-67-11-128 13-62-24-129-13Z" fill="#92988e"/><path d="M41 51q67-13 129 11v166q-62-24-129-13Z" fill="url(#paper)"/><path d="M170 62q61-24 128-11v164q-67-11-128 13Z" fill="url(#pearl)"/><path d="M245 48v68l14-13 13 9V47" fill="#c4a38a"/></g>`,
  releases: `<path d="M61 239V57q0-19 19-19h6M61 177h63q37 0 52-28l23-44q13-22 40-22h50" fill="none" stroke="url(#metal)" stroke-width="12" stroke-linecap="round"/><g stroke="#494e49" stroke-width="7" fill="#f7f7f1"><circle cx="61" cy="238" r="13"/><circle cx="61" cy="177" r="13"/><circle cx="286" cy="83" r="18" fill="#c5b4d9"/></g>`,
  compare: `<g fill="none" stroke-width="27"><circle cx="124" cy="144" r="83" stroke="#414643"/><circle cx="215" cy="144" r="83" stroke="#b5a9c5"/></g><path d="M163 71a83 83 0 0 1 44 73" fill="none" stroke="#414643" stroke-width="27"/>`,
} as const;

export type CoverObject = keyof typeof objects;
export function objectArtwork(name: CoverObject) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="280" viewBox="0 0 340 280"><defs>
    <linearGradient id="paper" x2=".8" y2="1"><stop stop-color="#fffef9"/><stop offset="1" stop-color="#deded5"/></linearGradient>
    <linearGradient id="pearl" x2=".65" y2="1"><stop stop-color="#f3f2ee"/><stop offset=".55" stop-color="#d9dbd5"/><stop offset="1" stop-color="#b8bcb6"/></linearGradient>
    <linearGradient id="metal" x2=".8" y2="1"><stop stop-color="#727973"/><stop offset=".5" stop-color="#373c39"/><stop offset="1" stop-color="#282c29"/></linearGradient>
    <linearGradient id="lilac" x2=".8" y2="1"><stop stop-color="#d9cceb"/><stop offset="1" stop-color="#9a89b4"/></linearGradient>
    <linearGradient id="sage" x2=".8" y2="1"><stop stop-color="#e3ebe1"/><stop offset="1" stop-color="#9bb6a2"/></linearGradient>
    </defs>${objects[name]}</svg>`;
}
