import { useEffect, useState } from "react";

import type { Member } from "../lib/api.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { Avatar } from "./Avatar.tsx";
import { IconClose } from "./Icons.tsx";

interface Props {
  onClose: () => void;
}

type Tab = "direct" | "group" | "channel";

export function ComposeDialog({ onClose }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [tab, setTab] = useState<Tab>("direct");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [picked, setPicked] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [suite, setSuite] = useState(state.suiteId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void session
        .searchUsers(query)
        .then(({ users }) => setResults(users.filter((u) => u.userId !== state.user?.id)))
        .catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [query, session, state.user?.id]);

  async function go() {
    setError(null);
    try {
      if (tab === "direct") {
        const target = picked[0] ?? results[0];
        if (!target) return;
        await session.startDirect(target.userId);
      } else {
        await session.createChannel({
          kind: tab,
          name,
          topic,
          members: picked.map((p) => p.userId),
          encrypted: tab === "group",
          suite,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.unknown"));
    }
  }

  function toggle(user: Member) {
    setPicked((current) =>
      current.some((p) => p.userId === user.userId)
        ? current.filter((p) => p.userId !== user.userId)
        : [...current, user],
    );
  }

  const allowedSuites = state.suites.filter((s) => s.allowed);

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__box">
        <header className="modal__head">
          <h2>{t("compose.title")}</h2>
          <button className="iconbtn" onClick={onClose} aria-label={t("common.close")}>
            <IconClose />
          </button>
        </header>

        <div className="tabs">
          {(
            [
              ["direct", t("compose.direct")],
              ["group", t("compose.group")],
              ["channel", t("compose.channel")],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "tab tab--on" : "tab"}
              onClick={() => setTab(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <p className="modal__hint">
          {tab === "direct" && t("compose.hintDirect")}
          {tab === "group" && t("compose.hintGroup")}
          {tab === "channel" && t("compose.hintChannel")}
        </p>

        {tab !== "direct" && (
          <>
            <label>
              <span>{t("compose.name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <label>
              <span>{t("compose.topic")}</span>
              <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={140} />
            </label>
          </>
        )}

        {(tab === "direct" || tab === "group") && allowedSuites.length > 1 && (
          <label>
            <span>{t("compose.cipher")}</span>
            <select value={suite} onChange={(e) => setSuite(e.target.value)}>
              {allowedSuites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <em className="fieldHint">{t("compose.cipherHint")}</em>
          </label>
        )}

        <label>
          <span>{tab === "direct" ? t("compose.whoTo") : t("compose.whoAdd")}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("compose.searchPlaceholder")}
            autoFocus
          />
        </label>

        {picked.length > 0 && (
          <div className="chips">
            {picked.map((p) => (
              <button key={p.userId} className="chip" onClick={() => toggle(p)} type="button">
                {p.displayName} ✕
              </button>
            ))}
          </div>
        )}

        <ul className="results">
          {results.map((user) => (
            <li key={user.userId}>
              <button
                type="button"
                onClick={() =>
                  tab === "direct" ? void session.startDirect(user.userId).then(onClose) : toggle(user)
                }
              >
                <Avatar name={user.displayName} hue={user.avatarHue} avatar={user.avatar} size={32} />
                <span>
                  {user.displayName}
                  <em>@{user.username}</em>
                </span>
              </button>
            </li>
          ))}
          {query.trim().length >= 2 && results.length === 0 && (
            <li className="results__none">{t("compose.nobody")}</li>
          )}
        </ul>

        {error && <p className="auth__error">{error}</p>}

        {tab !== "direct" && (
          <button className="btn btn--primary" onClick={go} disabled={!name.trim()}>
            {t("compose.create")}
          </button>
        )}
      </div>
    </div>
  );
}
