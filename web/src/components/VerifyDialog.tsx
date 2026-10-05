import { useState } from "react";

import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { IconAlert, IconCheck, IconClose, IconKey, IconShield } from "./Icons.tsx";

interface Props {
  userId: string;
  name: string;
  onClose: () => void;
}

/**
 * Key verification.
 *
 * The safety number is derived from both identity keys, so it is the same on
 * both screens and different the moment anyone is substituted. Comparing it
 * over a second channel is the only thing that turns "the server says this is
 * their key" into "this is their key".
 */
export function VerifyDialog({ userId, name, onClose }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const number = session.safetyNumberWith(userId);
  const devices = session.devicesOf(userId);
  const trust = state.trust[userId] ?? "unknown";

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__box modal__box--wide">
        <header className="modal__head">
          <h2>
            <IconShield width={18} height={18} /> {t("verify.title")}
          </h2>
          <button className="iconbtn" onClick={onClose} aria-label={t("common.close")}>
            <IconClose />
          </button>
        </header>

        <p className={`verifyState verifyState--${trust}`}>
          {trust === "verified" && (
            <>
              <IconCheck width={16} height={16} /> {t("verify.verified")}
            </>
          )}
          {trust === "unknown" && (
            <>
              <IconKey width={16} height={16} /> {t("verify.unverified")}
            </>
          )}
          {trust === "changed" && (
            <>
              <IconAlert width={16} height={16} /> {t("verify.changed")}
            </>
          )}
        </p>

        {trust === "changed" && <p className="modal__hint modal__hint--warn">{t("verify.changedHint")}</p>}

        <p className="modal__hint">{t("verify.compareHint")}</p>

        {number ? (
          <pre className="safety safety--big">{number}</pre>
        ) : (
          <p className="modal__hint">{t("error.unknownSender")}</p>
        )}

        <div className="verifyActions">
          {number && (
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(number);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? t("verify.copied") : t("verify.copy")}
            </button>
          )}

          {trust === "verified" ? (
            <button className="btn" onClick={() => void session.clearVerification(userId)}>
              {t("verify.unverify")}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => void session.markVerified(userId)}>
              <IconCheck width={16} height={16} />
              {t("verify.markVerified")}
            </button>
          )}

          {trust === "changed" && (
            <button className="btn" onClick={() => void session.acknowledgeKeyChange(userId)}>
              {t("verify.acknowledge")}
            </button>
          )}
        </div>

        <h3 className="modal__sub">
          {t("verify.perDevice")} · {t("verify.deviceCount", { count: devices.length })}
        </h3>
        <ul className="fingerprints">
          {devices.map((device) => (
            <li key={device.deviceId}>
              <span>{name}</span>
              <code>{device.fingerprint}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
