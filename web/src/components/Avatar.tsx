import { useSession } from "../state/useSession.ts";

interface Props {
  name: string;
  hue: number;
  /** Upload id of a picture, if the person or group set one. */
  avatar?: string | null;
  size?: number;
  online?: boolean;
  square?: boolean;
  /** Shows the verification tick for a contact whose keys were checked. */
  verified?: boolean;
}

/**
 * Avatars are generated from initials unless a picture was uploaded, so an
 * empty server still looks populated and the chat list costs no image requests.
 * Uploaded pictures arrive through the session's cache, which fetches each one
 * once and holds it as an object URL for the tab's lifetime.
 */
export function Avatar({ name, hue, avatar, size = 44, online, square, verified }: Props) {
  const session = useSession();
  const src = session.avatarUrl(avatar);

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase();

  return (
    <span
      className={`avatar${square ? " avatar--square" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: src
          ? "var(--raised)"
          : `linear-gradient(145deg, hsl(${hue} 62% 52%), hsl(${(hue + 40) % 360} 58% 40%))`,
      }}
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials || "?"}
      {online !== undefined && <i className={`presence${online ? " presence--on" : ""}`} />}
      {verified && (
        <i className="avatar__verified" title="✓">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 12.5 5 5 11-11" />
          </svg>
        </i>
      )}
    </span>
  );
}
