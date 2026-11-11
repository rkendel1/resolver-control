import { useEffect, useRef, useState } from "react";
import { useConnectionState, useQueryState, useSession } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ThemeToggle } from "./theme";
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

type Notice = { tone: "error" | "info"; text: string } | null;

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const NAV: Array<{ path: string; label: string; group?: string }> = [
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

function SyncPill() {
  const state = useQueryState(api.settings.get, {});
  const sync = state.data?.sync;
  if (!state.data) return null;
  if (!state.data.settings) return <a className="pill warn" href="#/settings">Resolver not connected</a>;
  if (!sync) return <span className="pill muted">Waiting for the resolver component</span>;
  const age = Date.now() - sync.at;
  const stale = age > Math.max(30_000, state.data.settings.syncIntervalSeconds * 5000);
  const label = sync.state === "ok" ? (stale ? "Resolver: no report recently" : `Resolver: ${sync.references} refs observed`) : sync.state === "unconfigured" ? "Resolver: not configured" : "Resolver unreachable";
  return (
    <a className={`pill ${sync.state === "ok" && !stale ? "good" : sync.state === "unconfigured" || stale ? "warn" : "bad"}`} href="#/settings" title={sync.detail ?? `Last report ${new Date(sync.at).toLocaleTimeString()}`}>
      <span className="dot" /> {label}
    </a>
  );
}

export function App() {
  const { session, signInAsDevUser, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;
  const route = useRoute();

  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === "error" ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const ctx: AppContext | null = principal
    ? { principal: { id: principal.id, type: principal.type, roles: principal.roles ?? [] }, permissions: session?.permissions ?? [], report: (e) => setNotice({ tone: "error", text: describe(e) }), info: (text) => setNotice({ tone: "info", text }) }
    : null;
  const page = route[0] ?? "overview";
  const awaiting = useQueryState(api.changes.list, principal ? { status: "ready" } : "skip");

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/overview">
          <span className="logo" aria-hidden>
            RC
          </span>
          <span className="brand-name">Resolver Control</span>
          {session && !session.environment.production && <span className="env">{session.environment.name}</span>}
        </a>
        <div className="topbar-right">
          {principal && <SyncPill />}
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes appear as they are recorded" : "Connecting to the change stream…"}>
            <span className="dot" /> {live ? "Live" : "Connecting"}
          </span>
          {session && session.devUsers.length > 0 && (
            <label className="identity">
              <span className="sr-only">Signed in as</span>
              <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch((err) => setNotice({ tone: "error", text: describe(err) })) : signOut())}>
                <option value="">Signed out</option>
                {session.devUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ThemeToggle />
        </div>
      </header>
      {notice && (
        <div className={`notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {!ctx ? (
        <main className="signed-out">
          <h1>Resolver Control</h1>
          <p className="muted">Sign in to see and govern the runtime dependencies your applications resolve.</p>
          {session && !session.devUsers.length && <p className="muted">People sign in with a session issued by the operator of this deployment.</p>}
        </main>
      ) : (
        <Ctx.Provider value={ctx}>
          <div className="workspace">
            <nav className="sidebar" aria-label="Sections">
              {NAV.map((item) => (
                <a key={item.path} href={`#/${item.path}`} className={`nav-item ${page === item.path ? "on" : ""}`} aria-current={page === item.path ? "page" : undefined}>
                  {item.label}
                  {item.path === "approvals" && (awaiting.data?.length ?? 0) > 0 && <span className="count">{awaiting.data!.length}</span>}
                </a>
              ))}
              <div className="sidebar-foot muted">
                <div>
                  Signed in as <strong>{ctx.principal.id}</strong>
                </div>
                <div className="roles">{ctx.principal.roles.join(", ")}</div>
              </div>
            </nav>
            <main className="main">
              {page === "overview" && <Overview />}
              {page === "dependencies" && (route[1] ? <DependencyDetail refName={route[1]} /> : <Dependencies />)}
              {page === "environments" && <Environments />}
              {page === "changes" && (route[1] ? <ChangeDetail id={route[1]} /> : <Changes />)}
              {page === "approvals" && <Approvals />}
              {page === "insights" && <Insights />}
              {page === "discovery" && <Discovery />}
              {page === "activity" && <Activity />}
              {page === "settings" && <Settings />}
              {!NAV.some((n) => n.path === page) && <p className="muted">Nothing here. <a href="#/overview">Overview</a></p>}
            </main>
          </div>
        </Ctx.Provider>
      )}
    </div>
  );
}
