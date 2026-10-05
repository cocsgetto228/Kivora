import { useState } from "react";

import type { ChannelJSON } from "../lib/api.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { Avatar } from "./Avatar.tsx";
import { IconBranch, IconClose } from "./Icons.tsx";

interface Props {
  parent: ChannelJSON;
  onClose: () => void;
}

/**
 * Creating a thread.
 *
 * The member picker is the security control, not a convenience: whoever is
 * ticked here gets a wrapped key, and whoever is not cannot read the thread at
 * all — not "cannot see it in the list", but cannot decrypt it.
 */
export function ThreadDialog({ parent, onClose }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const others = (parent.members ?? []).filter((m) => m.userId !== state.user?.id);
  const [picked, setPicked] = useState<string[]>(others.map((m) => m.userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await session.createThread(parent.id, { name, topic, members: picked });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__box">
        <header className="modal__head">
          <h2>
            <IconBranch width={18} height={18} /> {t("thread.new")}
          </h2>
          <button className="iconbtn" onClick={onClose} aria-label={t("common.close")}>
            <IconClose />
          </button>
        </header>

        <label>
          <span>{t("thread.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </label>
        <label>
          <span>{t("compose.topic")}</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={140} />
        </label>

        <h3 className="modal__sub">{t("thread.members")}</h3>
        <p className="modal__hint">{t("thread.membersHint")}</p>

        <ul className="pickList">
          {others.map((member) => {
            const on = picked.includes(member.userId);
            return (
              <li key={member.userId}>
                <button
                  type="button"
                  className={on ? "pick pick--on" : "pick"}
                  onClick={() =>
                    setPicked((current) =>
                      on ? current.filter((id) => id !== member.userId) : [...current, member.userId],
                    )
                  }
                >
                  <Avatar name={member.displayName} hue={member.avatarHue} avatar={member.avatar} size={28} />
                  <span>
                    {member.displayName}
                    <em>@{member.username}</em>
                  </span>
                  <i>{on ? "✓" : ""}</i>
                </button>
              </li>
            );
          })}
          {others.length === 0 && <li className="results__none">{t("compose.nobody")}</li>}
        </ul>

        {error && <p className="auth__error">{error}</p>}

        <button className="btn btn--primary" onClick={create} disabled={!name.trim() || busy}>
          {t("thread.create")}
        </button>
      </div>
    </div>
  );
}
