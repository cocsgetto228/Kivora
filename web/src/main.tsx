import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { Session } from "./lib/session.ts";
import { SessionContext } from "./state/useSession.ts";
import { getLang } from "./i18n/index.ts";
import "./styles.css";

const session = new Session();
document.documentElement.dataset.theme = session.getState().theme;
document.documentElement.lang = getLang();
void session.boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionContext.Provider value={session}>
      <App />
    </SessionContext.Provider>
  </StrictMode>,
);
