/** Decorative vector artwork: no remote assets, canvas loop or model work. */
export function PrismVisual() {
  return <div className="prism-scene" aria-hidden="true">
    <div className="prism-aura" />
    <svg className="prism-art" viewBox="0 0 680 650" fill="none" focusable="false">
      <defs>
        <linearGradient id="prism-left" x1="225" y1="140" x2="405" y2="535" gradientUnits="userSpaceOnUse"><stop stopColor="#bcffe6" stopOpacity=".9"/><stop offset=".27" stopColor="#357f70" stopOpacity=".18"/><stop offset=".74" stopColor="#145c49" stopOpacity=".7"/><stop offset="1" stopColor="#9ef4ce" stopOpacity=".9"/></linearGradient>
        <linearGradient id="prism-right" x1="335" y1="150" x2="532" y2="476" gradientUnits="userSpaceOnUse"><stop stopColor="#d4f8df" stopOpacity=".7"/><stop offset=".4" stopColor="#3d9b80" stopOpacity=".13"/><stop offset="1" stopColor="#113b30" stopOpacity=".85"/></linearGradient>
        <linearGradient id="prism-top" x1="250" y1="130" x2="450" y2="300" gradientUnits="userSpaceOnUse"><stop stopColor="#eaffdc" stopOpacity=".8"/><stop offset=".4" stopColor="#4eaa87" stopOpacity=".25"/><stop offset="1" stopColor="#a0e9c8" stopOpacity=".7"/></linearGradient>
        <linearGradient id="prism-edge" x1="203" y1="150" x2="497" y2="510" gradientUnits="userSpaceOnUse"><stop stopColor="#d4ffe7"/><stop offset=".4" stopColor="#8bcea8" stopOpacity=".4"/><stop offset=".75" stopColor="#ecffe8"/><stop offset="1" stopColor="#5fd4ac" stopOpacity=".3"/></linearGradient>
        <linearGradient id="prism-beam"><stop stopColor="#9ed3ba" stopOpacity="0"/><stop offset=".6" stopColor="#cdedd2" stopOpacity=".5"/><stop offset="1" stopColor="#edffed" stopOpacity=".9"/></linearGradient>
        <radialGradient id="prism-floor"><stop stopColor="#67cd9c" stopOpacity=".24"/><stop offset="1" stopColor="#67cd9c" stopOpacity="0"/></radialGradient>
      </defs>
      <ellipse cx="364" cy="552" rx="265" ry="77" fill="url(#prism-floor)"/>
      <g stroke="#89b69e" strokeOpacity=".12"><ellipse cx="364" cy="547" rx="263" ry="74"/><ellipse cx="364" cy="547" rx="203" ry="57"/><path d="M84 547H652M364 469V630M145 594L556 487M169 487L573 595"/></g>
      <path d="M0 258L330 309L0 304Z" fill="url(#prism-beam)" opacity=".27"/>
      <path d="M0 283L330 309" stroke="url(#prism-beam)"/>
      <g className="prism-crystal">
        <path d="M331 98L195 362L399 526L510 303Z" fill="#0c251e"/>
        <path d="M331 98L195 362L344 308Z" fill="url(#prism-top)"/>
        <path d="M331 98L510 303L344 308Z" fill="url(#prism-right)"/>
        <path d="M195 362L344 308L399 526Z" fill="url(#prism-left)"/>
        <path d="M344 308L510 303L399 526Z" fill="url(#prism-right)"/>
        <path d="M331 98L344 308L399 526L195 362L331 98L510 303L399 526M195 362L344 308L510 303" stroke="url(#prism-edge)" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M331 98L296 294L399 526M331 98L406 294L399 526M195 362L406 294L510 303M195 362L296 294L510 303" stroke="#b2f7cf" strokeOpacity=".21"/>
        <path d="M334 108L347 303L399 511" stroke="#efffe7" strokeOpacity=".7" strokeWidth="2"/>
        <path d="M203 359L341 310" stroke="#dbffe6" strokeOpacity=".8"/>
        <circle cx="344" cy="308" r="3" fill="#e6ffe0"/>
        <circle cx="331" cy="98" r="2" fill="#efffe4"/>
      </g>
      <g stroke="#b7d2ba" strokeOpacity=".43"><path d="M434 185H533L550 166H637"/><path d="M237 403H119L101 422H34"/><circle cx="434" cy="185" r="3"/><circle cx="237" cy="403" r="3"/></g>
      <g fill="#abc8b7" fontFamily="Arial, sans-serif" fontSize="9" letterSpacing="2"><text x="548" y="155">РАЗНЫЕ ГРАНИ</text><text x="35" y="439">ОДИН ВЗГЛЯД</text></g>
    </svg>
    <div className="prism-caption"><span>PRIZMA / DIGITAL TRUST</span><span>Ясность в деталях</span></div>
  </div>;
}
