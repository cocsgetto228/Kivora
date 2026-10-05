import { useEffect, useRef, useState } from "react";

import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatShortDate, isLangOverridden, type Lang } from "../i18n/index.ts";
import { Avatar } from "./Avatar.tsx";
import {
  IconCamera,
  IconCheck,
  IconGlobe,
  IconKey,
  IconMoon,
  IconShield,
  IconSun,
  IconTrash,
} from "./Icons.tsx";

/** The built-in suites get translated notes; a suite someone added themselves
 *  falls back to whatever text it declares. */
function describeSuite(
  id: string,
  fallback: string | undefined,
  t: (key: never) => string,
): string {
  if (id.startsWith("kivora.x25519-xchacha20poly1305")) return t("crypto.note.xchacha" as never);
  if (id.startsWith("kivora.x25519-aes256gcm")) return t("crypto.note.aesgcm" as never);
  return fallback ?? "";
}

export function SettingsPanel() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [displayName, setDisplayName] = useState(state.user?.displayName ?? "");
  const [bio, setBio] = useState(state.user?.bio ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void session.refreshDevices();
  }, [session]);

  const langValue: Lang | "auto" = isLangOverridden() ? state.lang : "auto";

  return (
    <section className="settings">
      <header className="settings__head">
        <button className="settings__avatar" onClick={() => avatarInput.current?.click()}>
          <Avatar
            name={state.user?.displayName ?? "?"}
            hue={state.user?.avatarHue ?? 200}
            avatar={state.user?.avatar}
            size={72}
          />
          <span className="settings__avatarEdit">
            <IconCamera width={14} height={14} />
          </span>
        </button>
        <div>
          <h2>{state.user?.displayName}</h2>
          <p>@{state.user?.username}</p>
          {state.user?.avatar && (
            <button className="linkbtn" onClick={() => void session.setMyAvatar(null)}>
              {t("settings.removeAvatar")}
            </button>
          )}
        </div>
      </header>

      <input
        ref={avatarInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void session
              .setMyAvatar(file)
              .then(() => setStatus(t("settings.saved")))
              .catch(() => setStatus(t("settings.saveFailed")));
          }
          e.target.value = "";
        }}
      />

      <div className="settings__grid">
        <div className="card">
          <h3>{t("settings.profile")}</h3>
          <label>
            <span>{t("auth.displayName")}</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
          </label>
          <label>
            <span>{t("settings.about")}</span>
            <input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={280} />
          </label>
          <button
            className="btn btn--primary"
            onClick={() =>
              void session.api
                .updateProfile(displayName, bio)
                .then(() => setStatus(t("settings.saved")))
                .catch(() => setStatus(t("settings.saveFailed")))
            }
          >
            {t("settings.save")}
          </button>
          {status && <p className="settings__status">{status}</p>}
        </div>

        <div className="card">
          <h3>
            <IconShield width={16} height={16} /> {t("crypto.title")}
          </h3>
          <p className="settings__line">
            {t("crypto.backend")}: <span className="mono">{state.suiteBackend}</span>
          </p>
          <p className="settings__line">
            {t("crypto.serverAccepts")}: <span className="mono">{state.server?.allowedSuites.join(", ")}</span>
          </p>

          <h4 className="settings__sub">{t("crypto.available")}</h4>
          <ul className="suites">
            {state.suites.map((suite) => (
              <li key={suite.id} className={suite.allowed ? "" : "suites--blocked"}>
                <div className="suites__head">
                  <strong>{suite.label}</strong>
                  {suite.isDefault ? (
                    <span className="tagOk">
                      <IconCheck width={12} height={12} /> {t("crypto.isDefault")}
                    </span>
                  ) : suite.allowed ? (
                    <button className="linkbtn" onClick={() => session.chooseSuite(suite.id)}>
                      {t("crypto.setDefault")}
                    </button>
                  ) : (
                    <span className="tagBad">{t("crypto.notAllowed")}</span>
                  )}
                </div>
                <code>{suite.id}</code>
                <small>
                  {t("crypto.keyLength")}: {t("crypto.bytes", { count: suite.keyLength })} ·{" "}
                  {t("crypto.nonceLength")}: {t("crypto.bytes", { count: suite.nonceLength })} ·{" "}
                  {t("crypto.signatures")}: {suite.signatures ? t("crypto.yes") : t("crypto.no")}
                </small>
                <small className="suites__note">{describeSuite(suite.id, suite.notes, t)}</small>
              </li>
            ))}
          </ul>

          <h4 className="settings__sub">{t("crypto.perChat")}</h4>
          <p className="settings__note">{t("crypto.perChatHint")}</p>

          <h4 className="settings__sub">
            <IconKey width={14} height={14} /> {t("crypto.addOwn")}
          </h4>
          <p className="settings__note">{t("crypto.addOwnHint")}</p>
        </div>

        <div className="card">
          <h3>{t("settings.devices")}</h3>
          <ul className="devices">
            {state.devices.map((device) => (
              <li key={device.id}>
                <div>
                  <strong>
                    {device.name}
                    {device.id === state.deviceId && <em> · {t("settings.thisDevice")}</em>}
                  </strong>
                  <code>{session.fingerprintOf(device)}</code>
                  <small>
                    {device.platform} · {t("settings.addedOn", { date: formatShortDate(device.createdAt) })}
                  </small>
                </div>
                <div className="devices__actions">
                  {device.id !== state.deviceId && (
                    <>
                      <button
                        className="btn btn--ghost"
                        onClick={() =>
                          void session
                            .shareHistory(device.id)
                            .then((n) => setStatus(t("settings.shared", { count: n })))
                            .catch((e: Error) => setStatus(e.message))
                        }
                      >
                        {t("settings.shareHistory")}
                      </button>
                      <button
                        className="iconbtn"
                        title={t("settings.revoke")}
                        onClick={() => void session.revokeDevice(device.id)}
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="settings__note">{t("settings.devicesHint")}</p>

          {state.core ? (
            <p className="settings__line">
              {t("crypto.coreLabel")}: <span className="mono">{state.core.version}</span> ·{" "}
              {state.core.secretStorage === "os-keychain" ? t("crypto.coreOs") : t("crypto.coreFile")}
            </p>
          ) : (
            <p className="settings__line">{t("crypto.coreWeb")}</p>
          )}
          <p className="settings__note">
            {t("crypto.storageHint")}
            {state.core?.keychain ? ` ${t("crypto.storageHintDesktop")}` : ""}
          </p>
        </div>

        <div className="card">
          <h3>{t("settings.appearance")}</h3>
          <button className="btn" onClick={() => session.toggleTheme()}>
            {state.theme === "dark" ? <IconMoon width={16} height={16} /> : <IconSun width={16} height={16} />}
            {state.theme === "dark" ? t("settings.themeDark") : t("settings.themeLight")}
          </button>

          <label>
            <span>
              <IconGlobe width={14} height={14} /> {t("settings.language")}
            </span>
            <select
              value={langValue}
              onChange={(e) =>
                session.chooseLanguage(e.target.value === "auto" ? null : (e.target.value as Lang))
              }
            >
              <option value="auto">{t("settings.languageAuto")}</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>

          <h3>{t("settings.session")}</h3>
          <button className="btn" onClick={() => void session.signOut()}>
            {t("settings.signOut")}
          </button>
          <button className="btn btn--danger" onClick={() => void session.forgetThisDevice()}>
            {t("settings.wipe")}
          </button>
          <p className="settings__note">{t("settings.wipeHint")}</p>
        </div>
      </div>
    </section>
  );
}
