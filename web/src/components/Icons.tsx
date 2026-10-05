/**
 * Inline icons. A whole icon package for three dozen glyphs is exactly the kind
 * of dependency that turns a "lightweight" app into a 2 MB download.
 */
import type { ReactElement, SVGProps } from "react";

type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconChats: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4.2-.9L3 20.5l1.5-4.3A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </svg>
);

export const IconChannels: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </svg>
);

export const IconPeople: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
  </svg>
);

export const IconSettings: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const IconLock: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 1 1 8 0v3" />
  </svg>
);

export const IconSend: Icon = (p) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M3.2 20.6 21.4 12 3.2 3.4 3.2 10.3 15.6 12 3.2 13.7z" />
  </svg>
);

export const IconSearch: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconPlus: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconClose: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconMoon: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
);

export const IconSun: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const IconShield: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const IconTrash: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);

// ---------------------------------------------------------------- new set

export const IconSmile: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.4" />
  </svg>
);

export const IconPaperclip: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M20.4 11.6 12 20a5.7 5.7 0 0 1-8-8l8.6-8.6a3.8 3.8 0 1 1 5.4 5.4l-8.6 8.6a1.9 1.9 0 1 1-2.7-2.7l7.9-7.9" />
  </svg>
);

export const IconPhone: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
  </svg>
);

export const IconPhoneOff: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M10.7 5.1A11 11 0 0 1 12 5c6 0 11 3.6 11 6.5 0 1-.6 1.9-1.6 2.6-.7.5-1.7.2-2-.6l-.6-1.6" />
    <path d="M6.3 7.4C3.6 8.6 1 10.4 1 11.5c0 1 .6 1.9 1.6 2.6.7.5 1.7.2 2-.6l.6-1.6c.2-.6.8-1 1.4-.9l2 .3" />
    <path d="M2 2 22 22" />
  </svg>
);

export const IconVideo: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 11 6-3.5v9L16 13" />
  </svg>
);

export const IconVideoOff: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M10 6h4a2 2 0 0 1 2 2v2m0 4v.2a2 2 0 0 1-2 1.8H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1" />
    <path d="m16 11 6-3.5v9l-3-1.7" />
    <path d="M2 2 22 22" />
  </svg>
);

export const IconMic: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
  </svg>
);

export const IconMicOff: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M15 9.3V5a3 3 0 0 0-6-.3M9 9v2a3 3 0 0 0 4.6 2.5" />
    <path d="M5 11a7 7 0 0 0 10.7 6M19 11a7 7 0 0 1-.4 2.2M12 18v4M8 22h8" />
    <path d="M2 2 22 22" />
  </svg>
);

export const IconScreen: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const IconPin: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M15 3 21 9l-3.5 1.2-3.8 3.8L13 18l-2 2-4-4-4.5 1.5L4 15l3.8-3.8L9 7.5 15 3Z" />
  </svg>
);

export const IconArchive: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="2" y="4" width="20" height="4" rx="1" />
    <path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
  </svg>
);

export const IconDots: Icon = (p) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="12" cy="19" r="1.9" />
  </svg>
);

export const IconBell: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

export const IconBellOff: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M13.7 21a2 2 0 0 1-3.4 0M18.6 13c.3 2 1.4 3 1.4 3H7M6 8a6 6 0 0 1 8.5-5.5" />
    <path d="M2 2 22 22" />
  </svg>
);

export const IconDownload: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M12 3v12M7 11l5 5 5-5M4 21h16" />
  </svg>
);

export const IconImage: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.8" />
    <path d="m4 17 5-5 4 4 3-2 4 4" />
  </svg>
);

export const IconFilm: Icon = (p) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M3 15h18M8 4v16M16 4v16" />
  </svg>
);

export const IconFile: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

export const IconPlay: Icon = (p) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M7 4.5 19.5 12 7 19.5Z" />
  </svg>
);

export const IconClock: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconExpand: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
  </svg>
);

export const IconBranch: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="6" cy="5" r="2.5" />
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <path d="M6 7.5v9M8.5 5H13a2.5 2.5 0 0 1 2.5 2.5V10M8.5 19H13a2.5 2.5 0 0 0 2.5-2.5V14" />
  </svg>
);

export const IconCheck: Icon = (p) => (
  <svg {...base(p)}>
    <path d="m4 12.5 5 5 11-11" />
  </svg>
);

export const IconAlert: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

export const IconGlobe: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
  </svg>
);

export const IconChart: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M3 3v18h18" />
    <path d="M7 15l3.5-4 3 2.5L20 7" />
  </svg>
);

export const IconDatabase: Icon = (p) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

export const IconUsers: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9.5" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
  </svg>
);

export const IconLogOut: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export const IconChevronLeft: Icon = (p) => (
  <svg {...base(p)}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);

export const IconChevronDown: Icon = (p) => (
  <svg {...base(p)}>
    <path d="m5 9 7 7 7-7" />
  </svg>
);

export const IconCamera: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M4 8h3l1.5-2.5h7L17 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </svg>
);

export const IconEye: Icon = (p) => (
  <svg {...base(p)}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconKey: Icon = (p) => (
  <svg {...base(p)}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m11 12 9-9 2 2-2 2 2 2-3 3-2-2-2 2" />
  </svg>
);
