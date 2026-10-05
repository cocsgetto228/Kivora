import { createContext, useContext, useSyncExternalStore } from "react";

import type { Session, SessionState } from "../lib/session.ts";

/**
 * State management is fifteen lines of React, not a library. `Session` already
 * owns the state and publishes changes; `useSyncExternalStore` is the supported
 * way to read an external store, and it costs nothing in bundle size.
 */
export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionContext");
  return session;
}

export function useSessionState(): SessionState {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}
