import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { AdminChannelRow, AdminOverview, AdminUserRow } from "../lib/api.ts";
import { describeError } from "../lib/api.ts";
import { useSession } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatBytes, formatDuration, formatShortDate, locale } from "../i18n/index.ts";
import { Avatar } from "./Avatar.tsx";
import { MiniChart } from "./MiniChart.tsx";
import {
  IconChart,
  IconChannels,
  IconCheck,
  IconDatabase,
  IconLock,
  IconUsers,
} from "./Icons.tsx";

import type { AdminTab } from "../lib/session.ts";

/**
 * The body of the administration console — everything inside the chrome that
 * AdminConsole draws around it.
 *
 * Laid out like a conventional Bootstrap admin dashboard — gradient stat tiles,
 * a couple of charts, dense tables — because that is what administrators expect
 * to find, and familiarity is a feature in a screen people visit rarely.
 *
 * What it cannot show is the point: there is no message content here, and no
 * endpoint that could provide any. An administrator sees counts, membership and
 * policy. The conversations stay unreadable to them, exactly as they are to the
 * server itself.
 */
export function AdminPanel({ tab, query }: { tab: AdminTab; query: string }) {
  const session = useSession();
  const { t } = useT();

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [channels, setChannels] = useState<AdminChannelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setOverview(await session.adminOverview());
      setUsers((await session.adminUsers()).users);
      setChannels((await session.adminChannels()).channels);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // The console's search box narrows whichever table is open. A search field
  // that only decorates a toolbar is worse than none: people type into it.
  const needle = query.trim().toLowerCase();
  const shownUsers = needle
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(needle) ||
          u.displayName.toLowerCase().includes(needle),
      )
    : users;
  const shownChannels = needle
    ? channels.filter(
        (c) =>
          (c.name ?? "").toLowerCase().includes(needle) ||
          c.kind.toLowerCase().includes(needle),
      )
    : channels;

  const dayLabels = (overview?.days ?? []).map((day) =>
    new Date(day).toLocaleDateString(locale(), { weekday: "short" }),
  );

  return (
    <>
      {error && <p className="auth__error">{error}</p>}
      {status && <p className="settings__status">{status}</p>}

      {/* Both the overview and the security tab read from `overview`. When the
          request failed there was nothing at all under the error line, which
          reads as a broken panel rather than a failed load — so say what
          happened and offer the obvious next move. */}
      {!overview && (
        <p className="admin__empty">
          {loading ? (
            t("admin.loading")
          ) : (
            <button className="linkbtn" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          )}
        </p>
      )}

      {tab === "overview" && overview && (
        <>
          <div className="statRow">
            <StatTile
              label={t("admin.statUsers")}
              value={overview.users.toLocaleString(locale())}
              hint={`${overview.online} ${t("admin.statOnline").toLowerCase()}`}
              tone="blue"
              icon={<IconUsers width={18} height={18} />}
            />
            <StatTile
              label={t("admin.statChannels")}
              value={overview.channels.toLocaleString(locale())}
              tone="violet"
              icon={<IconChannels width={18} height={18} />}
            />
            <StatTile
              label={t("admin.statMessages")}
              value={overview.messages.toLocaleString(locale())}
              tone="aqua"
              icon={<IconChart width={18} height={18} />}
            />
            <StatTile
              label={t("admin.statDevices")}
              value={overview.devices.toLocaleString(locale())}
              tone="orange"
              icon={<IconLock width={18} height={18} />}
            />
            <StatTile
              label={t("admin.statStorage")}
              value={formatBytes(overview.fileBytes + overview.logBytes)}
              hint={`${formatBytes(overview.fileBytes)} · ${formatBytes(overview.logBytes)}`}
              tone="slate"
              icon={<IconDatabase width={18} height={18} />}
            />
            <StatTile
              label={t("admin.statUptime")}
              value={formatDuration(overview.uptimeSec)}
              hint={`${overview.runtime.os}/${overview.runtime.arch} · ${overview.runtime.heapMb} MB`}
              tone="slate"
              icon={<IconCheck width={18} height={18} />}
            />
          </div>

          <div className="admin__charts">
            <div className="card">
              <h3>{t("admin.messagesPerDay")}</h3>
              <MiniChart
                values={overview.messagesPerDay}
                labels={dayLabels}
                colorVar="--series-1"
                title={t("admin.messagesPerDay")}
              />
            </div>
            <div className="card">
              <h3>{t("admin.registrations")}</h3>
              <MiniChart
                values={overview.signupsPerDay}
                labels={dayLabels}
                colorVar="--series-2"
                title={t("admin.registrations")}
              />
            </div>
          </div>

          <div className="card">
            <h3>{t("admin.recentUsers")}</h3>
            <ul className="recentUsers">
              {overview.recent.map((user) => (
                <li key={user.id}>
                  <Avatar name={user.displayName} hue={user.avatarHue} avatar={user.avatar} size={32} />
                  <span>
                    {user.displayName}
                    <em>@{user.username}</em>
                  </span>
                  <time>{formatShortDate(user.createdAt)}</time>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {tab === "users" && (
        <div className="card card--table">
          <table className="dataTable">
            <thead>
              <tr>
                <th>{t("admin.tableUser")}</th>
                <th>{t("admin.tableRole")}</th>
                <th>{t("admin.tableDevices")}</th>
                <th>{t("admin.tableCreated")}</th>
                <th>{t("admin.tableLastSeen")}</th>
                <th>{t("admin.tableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {shownUsers.map((user) => (
                <tr key={user.id} className={user.suspended ? "row--suspended" : ""}>
                  <td>
                    <div className="cellUser">
                      <Avatar
                        name={user.displayName}
                        hue={user.avatarHue}
                        avatar={user.avatar}
                        size={30}
                        online={user.online}
                      />
                      <span>
                        {user.displayName}
                        <em>@{user.username}</em>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={user.isAdmin ? "tagOk" : "tagNeutral"}>
                      {user.isAdmin ? t("admin.roleAdmin") : t("admin.roleUser")}
                    </span>
                    {user.suspended && <span className="tagBad">{t("admin.suspended")}</span>}
                  </td>
                  <td>{user.devices}</td>
                  <td>{formatShortDate(user.createdAt)}</td>
                  <td>{user.lastSeenAt ? formatShortDate(user.lastSeenAt) : t("common.never")}</td>
                  <td>
                    <div className="cellActions">
                      <button
                        className="linkbtn"
                        onClick={() =>
                          void session
                            .adminSetFlags(user.id, { isAdmin: !user.isAdmin })
                            .then(load)
                            .catch((e) => setError(describeError(e)))
                        }
                      >
                        {user.isAdmin ? t("admin.demote") : t("admin.promote")}
                      </button>
                      <button
                        className="linkbtn linkbtn--danger"
                        onClick={() => {
                          if (!user.suspended && !confirm(t("admin.confirmSuspend", { name: user.username })))
                            return;
                          void session
                            .adminSetFlags(user.id, { suspended: !user.suspended })
                            .then(load)
                            .catch((e) => setError(describeError(e)));
                        }}
                      >
                        {user.suspended ? t("admin.unsuspend") : t("admin.suspend")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "channels" && (
        <div className="card card--table">
          <table className="dataTable">
            <thead>
              <tr>
                <th>{t("admin.tableChannel")}</th>
                <th>{t("admin.tableKind")}</th>
                <th>{t("crypto.title")}</th>
                <th>{t("admin.tableMembers")}</th>
                <th>{t("admin.tableMessages")}</th>
                <th>{t("admin.tableCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {shownChannels.map((channel) => (
                <tr key={channel.id}>
                  <td>{channel.name || <em className="muted">{channel.kind}</em>}</td>
                  <td>
                    <span className="tagNeutral">{channel.kind}</span>
                  </td>
                  <td>
                    {channel.encrypted ? (
                      <span className="tagOk" title={channel.suite}>
                        <IconLock width={12} height={12} /> E2E
                      </span>
                    ) : (
                      <span className="tagNeutral">—</span>
                    )}
                  </td>
                  <td>{channel.memberCount}</td>
                  <td>{channel.messageCount}</td>
                  <td>{formatShortDate(channel.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "security" && overview && (
        <div className="settings__grid">
          <div className="card">
            <h3>{t("admin.security")}</h3>
            <dl className="policy">
              <dt>{t("admin.registration")}</dt>
              <dd>
                {overview.policy.registration === "open"
                  ? t("admin.registrationOpen")
                  : overview.policy.registration === "invite"
                    ? t("admin.registrationInvite")
                    : t("admin.registrationClosed")}
              </dd>

              <dt>{t("admin.allowedSuites")}</dt>
              <dd className="mono">{overview.policy.allowedSuites.join(", ")}</dd>

              <dt>{t("admin.requireE2E")}</dt>
              <dd>{overview.policy.requireE2E ? t("crypto.yes") : t("crypto.no")}</dd>

              <dt>{t("admin.rateLimit")}</dt>
              <dd>
                {t("admin.rateLimitValue", {
                  rps: overview.policy.rateRps,
                  burst: overview.policy.rateBurst,
                })}
              </dd>

              <dt>{t("admin.maxDevices")}</dt>
              <dd>{overview.policy.maxDevices}</dd>

              <dt>{t("media.file")}</dt>
              <dd>{formatBytes(overview.policy.maxFileMb * 1024 * 1024)}</dd>
            </dl>
            <p className="settings__note">{t("admin.settingsHint")}</p>
          </div>

          <div className="card">
            <h3>
              <IconDatabase width={16} height={16} /> {t("admin.statStorage")}
            </h3>
            <p className="settings__line">
              {t("media.file")}: <strong>{formatBytes(overview.fileBytes)}</strong>
            </p>
            <p className="settings__line">
              {t("admin.statMessages")}: <strong>{formatBytes(overview.logBytes)}</strong>
            </p>
            <button
              className="btn"
              onClick={() =>
                void session
                  .adminCompact()
                  .then(() => {
                    setStatus(t("admin.compacted"));
                    return load();
                  })
                  .catch((e) => setError(describeError(e)))
              }
            >
              {t("admin.compact")}
            </button>
            <p className="settings__note">
              Go {overview.runtime.go} · {overview.runtime.goroutines} goroutines ·{" "}
              {overview.runtime.heapMb} MB heap
            </p>
          </div>
        </div>
      )}

      {tab === "pages" && <PagesTab />}
    </>
  );
}

/**
 * Diagnostics for the pages an operator never sees in normal use.
 *
 * The 404 screen is the obvious example: it only appears when something is
 * wrong, which is exactly when nobody wants to be discovering that it renders
 * badly behind their reverse proxy. Each button opens the real thing in a new
 * tab rather than showing a mock-up of it.
 */
function PagesTab() {
  const { t } = useT();
  const [probe, setProbe] = useState<string | null>(null);

  const rows: [string, string, string][] = [
    ["/404", t("admin.page404App"), t("admin.page404AppNote")],
    ["/404.html", t("admin.page404Static"), t("admin.page404StaticNote")],
    ["/no-such-page", t("admin.page404Real"), t("admin.page404RealNote")],
  ];

  return (
    <div className="card">
      <h3>{t("admin.pages")}</h3>
      <p className="settings__note">{t("admin.pagesNote")}</p>

      <ul className="pagesList">
        {rows.map(([href, label, note]) => (
          <li key={href}>
            <span>
              <strong>{label}</strong>
              <em>{note}</em>
              <code>{href}</code>
            </span>
            <a className="btn" href={href} target="_blank" rel="noreferrer">
              {t("admin.openPage")}
            </a>
          </li>
        ))}
      </ul>

      {/* Opening a page proves it renders. This proves the *status code*, which
          is the half a browser tab hides: a 404 body served with 200 looks
          identical to a person and wrong to every crawler and monitor. */}
      <button
        className="btn"
        onClick={() =>
          void fetch("/no-such-page", { method: "GET" })
            .then((r) => setProbe(t("admin.probeResult", { status: r.status })))
            .catch(() => setProbe(t("admin.probeFailed")))
        }
      >
        {t("admin.probeStatus")}
      </button>
      {probe && <p className="settings__status">{probe}</p>}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: string;
  icon: ReactElement;
}) {
  // A single magnitude is a number, not a chart: no sparkline, no gauge.
  return (
    <div className={`stat stat--${tone}`}>
      <span className="stat__icon">{icon}</span>
      <span className="stat__body">
        <em>{label}</em>
        <strong>{value}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </div>
  );
}
