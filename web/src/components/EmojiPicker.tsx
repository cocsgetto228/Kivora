import { useEffect, useMemo, useRef, useState } from "react";

import { CATEGORIES, recentEmoji, rememberEmoji, searchEmoji } from "../data/emoji.ts";
import type { Key } from "../i18n/index.ts";
import { useT } from "../i18n/useT.ts";
import { IconSearch } from "./Icons.tsx";

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: Props) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]!.id);
  const [recent, setRecent] = useState<string[]>(() => recentEmoji());
  const box = useRef<HTMLDivElement>(null);

  // Clicking anywhere else, or pressing Escape, closes the picker — the two
  // things every popover is expected to do and the two most often forgotten.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const results = useMemo(() => (query ? searchEmoji(query) : []), [query]);
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0]!;

  function choose(emoji: string) {
    rememberEmoji(emoji);
    setRecent(recentEmoji());
    onPick(emoji);
  }

  return (
    <div className="emoji" ref={box}>
      <div className="emoji__search">
        <IconSearch width={15} height={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("common.search")}
          autoFocus
        />
      </div>

      <div className="emoji__grid">
        {query ? (
          results.length > 0 ? (
            results.map((emoji) => (
              <button key={emoji} type="button" onClick={() => choose(emoji)}>
                {emoji}
              </button>
            ))
          ) : (
            <p className="emoji__none">{t("compose.nobody")}</p>
          )
        ) : (
          <>
            {recent.length > 0 && category === CATEGORIES[0]!.id && (
              <>
                <p className="emoji__heading">{t("composer.recent")}</p>
                <div className="emoji__row">
                  {recent.map((emoji) => (
                    <button key={`r-${emoji}`} type="button" onClick={() => choose(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="emoji__heading">{t(`emoji.${active.id}` as Key)}</p>
            <div className="emoji__row">
              {active.emoji.map((emoji) => (
                <button key={emoji} type="button" onClick={() => choose(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="emoji__tabs">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={c.id === category && !query ? "on" : ""}
            title={t(`emoji.${c.id}` as Key)}
            onClick={() => {
              setQuery("");
              setCategory(c.id);
            }}
          >
            {c.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
