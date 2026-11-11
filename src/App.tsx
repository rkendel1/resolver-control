import { useEffect, useRef, useState } from "react";
import { useConnectionState, useQueryState, useSession } from "@feltdb/feltkit/react";
import { Alert, Button, focusMain, readThemePreference, setThemePreference, Shell, StatusIndicator, type ThemePreference } from "@stack-ui/react";
import { api } from "../feltkit/_generated/api";
import { Ctx, describe, type AppContext } from "./ui";
import { Overview } from "./screens/Overview";
import { Dependencies, DependencyDetail } from "./screens/Dependencies";
import { Environments } from "./screens/Environments";
import { Changes, ChangeDetail } from "./screens/Changes";
import { Approvals } from "./screens/Approvals";
import { Insights } from "./screens/Insights";
import { Discovery } from "./screens/Discovery";
import { Activity } from "./screens/Activity";
import { Settings } from "./screens/Settings";

type Notice = { tone: "critical" | "info"; text: string } | null;

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      focusMain();
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const NAV = [
  { path: "overview", label: "Overview" },
  { path: "dependencies", label: "Dependencies" },
  { path: "environments", label: "Environments" },
  { path: "changes", label: "Changes" },
  { path: "approvals", label: "Approvals" },
  { path: "insights", label: "Insights" },
  { path: "discovery", label: "Discovery" },
  { path: "activity", label: "Activity" },
  { path: "settings", label: "Settings" },
];

/** What the resolver component last reported, from its own record: never assumed healthy. */
function SyncStatus() {
  const state = useQueryState(api.settings.get, {});
  if (!state.data) return null;
  if (!state.data.settings) return <a href="#/settings"><StatusIndicator tone="attention" label="Resolver not connected" /></a>;
  const sync = state.data.sync;
  if (!sync) return <StatusIndicator tone="progress" label="Waiting for the resolver component" />;
  const stale = Date.now() - sync.at > Math.max(30_000, state.data.settings.syncIntervalSeconds * 5000);
  const [tone, label] =
    sync.state !== "ok" ? (sync.state === "unconfigured" ? (["attention", "Resolver: not configured"] as const) : (["critical", "Resolver unreachable"] as const))
    : stale ? (["attention", "Resolver: no report recently"] as const)
    : (["positive", `Resolver: ${sync.references} refs observed`] as const);
  return (
    <a href="#/settings" title={sync.detail ?? `Last report ${new Date(sync.at).toLocaleTimeString()}`}>
      <StatusIndicator tone={tone} label={label} />
    </a>
  );
}

export function App() {
  const { session, signInAsDevUser, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const principal = session?.principal ?? null;
  const route = useRoute();

  useEffect(() => void setThemePreference(theme), [theme]);

  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === "critical" ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const ctx: AppContext | null = principal
    ? { principal: { id: principal.id, type: principal.type, roles: principal.roles ?? [] }, permissions: session?.permissions ?? [], report: (e) => setNotice({ tone: "critical", text: describe(e) }), info: (text) => setNotice({ tone: "info", text }) }
    : null;
  const page = route[0] ?? "overview";
  const awaiting = useQueryState(api.changes.list, principal ? { status: "ready" } : "skip");
  const waiting = awaiting.data?.length ?? 0;

  const account = (
    <>
      <StatusIndicator tone={live ? "positive" : "progress"} label={live ? "Live" : "Connecting"} />
      {session && session.devUsers.length > 0 && (
        <label className="identity">
          <span className="stack-visually-hidden">Signed in as</span>
          <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch((err) => setNotice({ tone: "critical", text: describe(err) })) : signOut())}>
            <option value="">Signed out</option>
            {session.devUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {session && !session.devUsers.length && principal && <span>{principal.id}</span>}
    </>
  );

  return (
    <Shell
      product={{ name: "Resolver Control", homeHref: "#/overview" }}
      family={false}
      otherProducts={[]}
      navigation={NAV.map((item) => ({
        id: item.path,
        label: item.path === "approvals" && waiting > 0 ? `${item.label} (${waiting})` : item.label,
        href: `#/${item.path}`,
        current: page === item.path,
      }))}
      context={principal ? <SyncStatus /> : undefined}
      account={account}
      theme={{ preference: theme, onChange: setTheme }}
    >
      {notice && (
        <div className="notice">
          <Alert tone={notice.tone} actions={<Button label="Dismiss" variant="ghost" size="sm" onClick={() => setNotice(null)} />}>
            {notice.text}
          </Alert>
        </div>
      )}
      {!ctx ? (
        <div className="signed-out">
          <h1>Resolver Control</h1>
          <p>Sign in to see and govern the runtime dependencies your applications resolve.</p>
          {session && !session.devUsers.length && <p>People sign in with a session issued by the operator of this deployment.</p>}
        </div>
      ) : (
        <Ctx.Provider value={ctx}>
          <div className="page">
            {page === "overview" && <Overview />}
            {page === "dependencies" && (route[1] ? <DependencyDetail refName={route[1]} /> : <Dependencies />)}
            {page === "environments" && <Environments />}
            {page === "changes" && (route[1] ? <ChangeDetail id={route[1]} /> : <Changes />)}
            {page === "approvals" && <Approvals />}
            {page === "insights" && <Insights />}
            {page === "discovery" && <Discovery />}
            {page === "activity" && <Activity />}
            {page === "settings" && <Settings />}
            {!NAV.some((n) => n.path === page) && <p>Nothing here. <a href="#/overview">Overview</a></p>}
          </div>
        </Ctx.Provider>
      )}
    </Shell>
  );
}
