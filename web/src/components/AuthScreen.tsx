import { useState, type FormEvent } from "react";

import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { isLangOverridden, type Lang } from "../i18n/index.ts";
import { IconGlobe, IconLock } from "./Icons.tsx";

type Mode = "login" | "register";

/**
 * One screen covers signing in, signing up and unlocking, because from the
 * user's side they are the same moment: "let me in on this machine".
 * Registration works here and in the desktop app from the identical component —
 * there is no web-only or desktop-only account flow.
 */
export function AuthScreen() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [serverUrl, setServerUrl] = useState(state.serverUrl);

  const locked = state.phase === "locked";
  const registrationClosed = state.server?.registrationMode === "closed";
  const needsInvite = state.server?.registrationMode === "invite";

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (locked) await session.unlock(password);
      else if (mode === "login") await session.login(username, password);
      else await session.register({ username, displayName, password, inviteCode: invite });
    } catch {
      /* the message is already in state.notice */
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <img className="auth__logo" src="/brand/logo.webp" alt={t("app.name")} width={420} height={293} />

        <p className="auth__server">
          {state.server
            ? t("auth.serverInfo", {
                name: state.server.name,
                version: state.server.version,
                protocol: state.server.protocol,
              })
            : t("app.loading")}
        </p>

        {locked ? (
          <p className="auth__hint">
            <IconLock width={16} height={16} />
            {t("auth.lockedHint")}
          </p>
        ) : (
          <div className="tabs">
            <button
              type="button"
              className={mode === "login" ? "tab tab--on" : "tab"}
              onClick={() => setMode("login")}
            >
              {t("auth.signIn")}
            </button>
            <button
              type="button"
              className={mode === "register" ? "tab tab--on" : "tab"}
              onClick={() => setMode("register")}
              disabled={registrationClosed}
            >
              {t("auth.signUp")}
            </button>
          </div>
        )}

        <form onSubmit={submit} className="auth__form">
          {!locked && (
            <label>
              <span>{t("auth.username")}</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                autoComplete="username"
                placeholder="ivan"
                required
                minLength={3}
                maxLength={32}
              />
            </label>
          )}

          {!locked && mode === "register" && (
            <label>
              <span>{t("auth.displayName")}</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={64}
              />
            </label>
          )}

          <label>
            <span>{t("auth.password")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              minLength={8}
            />
          </label>

          {!locked && mode === "register" && needsInvite && (
            <label>
              <span>{t("auth.inviteCode")}</span>
              <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
            </label>
          )}

          {state.notice && <p className="auth__error">{state.notice}</p>}

          <button className="btn btn--primary" type="submit" disabled={state.busy}>
            {state.busy
              ? t("auth.working")
              : locked
                ? t("auth.submitUnlock")
                : mode === "login"
                  ? t("auth.submitLogin")
                  : t("auth.submitRegister")}
          </button>
        </form>

        <div className="auth__row">
          <label className="auth__lang">
            <IconGlobe width={14} height={14} />
            <select
              value={isLangOverridden() ? state.lang : "auto"}
              onChange={(e) =>
                session.chooseLanguage(e.target.value === "auto" ? null : (e.target.value as Lang))
              }
            >
              <option value="auto">{t("settings.languageAuto")}</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>

        {!locked && (
          <details className="auth__serverBox">
            <summary>{t("auth.otherServer")}</summary>
            <div className="auth__serverRow">
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://chat.example.org"
              />
              <button type="button" className="btn" onClick={() => session.setServerUrl(serverUrl)}>
                {t("auth.connect")}
              </button>
            </div>
            <p>{t("auth.otherServerHint")}</p>
          </details>
        )}

        <p className="auth__foot">
          {t("auth.footer")}
          {state.suiteBackend && <span className="mono"> {state.suiteBackend}</span>}
        </p>
      </div>
    </div>
  );
}
