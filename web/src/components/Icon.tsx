/** Einheitliche Strich-Symbole (24×24, Farbe und Größe vom umgebenden Text) */
export const ICONS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  switcher: 'M14 3H6v18h12V7zM14 3v4h4M11.5 11a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM15 18.5l-1.7-1.7',
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  today: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  chat: 'M4 5h16v11H10l-6 4z',
  inbox: 'M4 13l2.5-8h11l2.5 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  log: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  graph: 'M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.4 6l7.2 1.2M7.2 7.8l3.8 8.4M16.8 9.6l-3.7 6.6',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  folderPlus: 'M4 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 10v6M9 13h6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  stop: 'M7 7h10v10H7z',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  puzzle: 'M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  auto: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  vault: 'M4 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 11v4M10 13h4',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] ?? ICONS.puzzle} />
    </svg>
  )
}

/** Symbol aus Plugins: bekannter Name → Strich-Symbol, sonst der Text (z. B. ein Zeichen) */
export function NavIcon({ icon }: { icon?: string }) {
  if (!icon || ICONS[icon]) return <Icon name={icon ?? 'puzzle'} />
  return <span aria-hidden>{icon}</span>
}
