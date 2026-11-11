import { useQueryState } from "@feltdb/feltkit/react";
import { ActivityTimeline, Alert } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, Card, Empty, EVENT_LABEL, Live, PageHead, Ref, State, when } from "../ui";

export function Overview() {
  const overview = useQueryState(api.insights.overview, {});
  const findings = useQueryState(api.insights.findings, {});
  const ready = useQueryState(api.changes.list, { status: "ready", limit: 5 });
  return (
    <>
      <PageHead title="Overview">What your applications depend on at run time, what is changing, and what needs a decision. Every number is counted from recorded state; nothing is estimated.</PageHead>
      <Live state={overview} what="the overview">
        {(o) =>
          !o.configured ? (
            <Alert tone="attention" title="Connect Resolver">
              Resolver Control reads and changes runtime references through Resolver. Set its origin and the environments to manage in <a href="#/settings">Settings</a>, and give the resolver component its API key on the host (<code>FELTKIT_CREDENTIAL_RESOLVER_API_KEY</code>). Until then there is nothing to show, and nothing is invented.
            </Alert>
          ) : (
            <>
              <div className="stats">
                <a className="stat" href="#/dependencies">
                  <span className="stat-n">{o.references}</span>
                  <span className="stat-l">references observed</span>
                  <span className="stat-s">{o.governed} governed · {o.references - o.governed} unregistered</span>
                </a>
                <a className="stat" href="#/approvals">
                  <span className="stat-n">{o.awaitingApproval}</span>
                  <span className="stat-l">awaiting approval</span>
                  <span className="stat-s">{(o.changes["approved"] ?? 0) + (o.changes["executing"] ?? 0)} approved or executing</span>
                </a>
                <a className="stat" href="#/changes">
                  <span className="stat-n">{o.executedLast7Days}</span>
                  <span className="stat-l">verified changes, 7 days</span>
                  <span className="stat-s">{o.changes["unknown"] ?? 0} unknown · {o.changes["failed"] ?? 0} failed</span>
                </a>
                <a className={`stat ${o.outOfBandLast7Days ? "stat-warn" : ""}`} href="#/activity">
                  <span className="stat-n">{o.outOfBandLast7Days}</span>
                  <span className="stat-l">changes outside governance, 7 days</span>
                  <span className="stat-s">written directly in Resolver</span>
                </a>
              </div>
              <div className="grid-2">
                <Card title="By environment" subtitle="Observed in Resolver">
                  {Object.keys(o.byEnvironment).length === 0 ? (
                    <Empty title="No references observed yet">{o.sync ? (o.sync.state === "ok" ? "The executor key sees none in the managed environments." : o.sync.detail ?? o.sync.state) : "The resolver component has not reported."}</Empty>
                  ) : (
                    <ul className="list">
                      {Object.entries(o.byEnvironment).sort().map(([env, n]) => (
                        <li key={env} className="row-between"><a href="#/environments">{env}</a><span className="num">{n}</span></li>
                      ))}
                    </ul>
                  )}
                  <div className="kinds">
                    {Object.entries(o.byKind).sort().map(([kind, n]) => <span key={kind} className="chip">{kind} <strong>{n}</strong></span>)}
                  </div>
                </Card>
                <Card title="Awaiting approval" actions={<a href="#/approvals">All</a>}>
                  <Live state={ready} what="changes awaiting approval">
                    {(rows) =>
                      rows.length === 0 ? <Empty title="Nothing is waiting for a decision" /> : (
                        <ul className="list">
                          {rows.map((c) => (
                            <li key={c.id}>
                              <a href={`#/changes/${c.id}`}>CHG-{c.number}</a> <Ref value={c.ref} /> — {c.reason}
                              <div className="small muted">{c.approvals.length}/{c.impact.requiredApprovals} approvals · proposed by {c.proposedBy} {when(c.proposedAt)}</div>
                            </li>
                          ))}
                        </ul>
                      )
                    }
                  </Live>
                </Card>
              </div>
              <div className="grid-2">
                <Card title="Needs attention" actions={<a href="#/insights">All findings</a>}>
                  <Live state={findings} what="findings">
                    {(rows) => {
                      const top = rows.filter((f) => f.severity !== "info").slice(0, 6);
                      return top.length === 0 ? <Empty title="No action or warning findings" /> : (
                        <ul className="list">
                          {top.map((f) => (
                            <li key={f.id}>
                              <State field="resolver-control.finding.severity" value={f.severity} /> <strong>{f.title}</strong> {f.ref && <Ref value={f.ref} />}
                              <div className="small muted">{f.detail}</div>
                            </li>
                          ))}
                        </ul>
                      );
                    }}
                  </Live>
                </Card>
                <Card title="Recent activity" actions={<a href="#/activity">All</a>}>
                  <ActivityTimeline
                    label="Recent activity"
                    emptyTitle="Nothing recorded yet"
                    hasMore={o.recent.length >= 12}
                    moreHref="#/activity"
                    items={o.recent.map((e) => ({ id: e.id, at: e.at, actor: <Actor id={e.actor} />, summary: <>{EVENT_LABEL[e.type] ?? e.type} {e.ref && <Ref value={e.ref} />}</> }))}
                  />
                </Card>
              </div>
            </>
          )
        }
      </Live>
    </>
  );
}
