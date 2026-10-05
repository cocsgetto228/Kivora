import { useSyncExternalStore } from "react";

import { getLang, onLangChange, t, type Key, type Params } from "./index.ts";

/**
 * Re-renders the tree when the language changes. `t` itself is a plain
 * function; this hook exists only so React knows to redraw.
 */
export function useT(): { t: (key: Key, params?: Params) => string; lang: string } {
  const lang = useSyncExternalStore(onLangChange, getLang, getLang);
  return { t, lang };
}
