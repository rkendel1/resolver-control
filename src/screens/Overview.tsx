import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, Badge, Card, Empty, EVENT_LABEL, Live, PageHead, Ref, when } from "../ui";

export function Overview() {
  const overview = useQueryState(api.insights.overview, {});
  const findings = useQueryState(api.insights.findings, {});
  const ready = useQueryState(api.changes.list, { status: "ready", limit: 5 });
  return (
    <>
      <PageHead title="Overview">What your applications depend on at run time, what is changing, and what needs a decision. Every number below is counted from recorded state; nothing is estimated.</PageHead>
      <Live state={overview}>
        {(o) =>
          !o.configured ? (
            <Card title="Connect Resolver">
              <p>Resolver Control reads and changes runtime references through Resolver. Set its origin and the environments to manage in <a href="#/settings">Settings</a>, and give the resolver component its API key on the host (<code>FELTKIT_CREDENTIAL_RESOLVER_API_KEY</code>). Until then there is nothing to show, and nothing is invented.</p>
            </Card>
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
                    <Empty>No references observed yet. {o.sync ? (o.sync.state === "ok" ? "The executor key sees none in the managed environments." : o.sync.detail ?? o.sync.state) : "The resolver component has not reported."}</Empty>
                  ) : (
                    <table className="table compact">
                      <tbody>
                        {Object.entries(o.byEnvironment).sort().map(([env, n]) => (
                          <tr key={env}>
                            <td><a href="#/environments">{env}</a></td>
                            <td className="num">{n}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="kinds">
                    {Object.entries(o.byKind).sort().map(([kind, n]) => (
                      <span key={kind} className="chip">{kind} <strong>{n}</strong></span>
                    ))}
                  </div>
                </Card>
                <Card title="Awaiting approval" actions={<a href="#/approvals">All</a>}>
                  <Live state={ready}>
                    {(rows) =>
                      rows.length === 0 ? <Empty>Nothing is waiting for a decision.</Empty> : (
                        <ul className="list">
                          {rows.map((c) => (
                            <li key={c.id}>
                              <a href={`#/changes/${c.id}`}>CHG-{c.number}</a> <Ref value={c.ref} /> <span className="muted">— {c.reason}</span>
                              <div className="muted small">{c.approvals.length}/{c.impact.requiredApprovals} approvals · proposed by {c.proposedBy} {when(c.proposedAt)}</div>
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
                  <Live state={findings}>
                    {(rows) => {
                      const top = rows.filter((f) => f.severity !== "info").slice(0, 6);
                      return top.length === 0 ? <Empty>No action or warning findings.</Empty> : (
                        <ul className="list">
                          {top.map((f) => (
                            <li key={f.id}>
                              <Badge status={f.severity} /> <strong>{f.title}</strong> {f.ref && <Ref value={f.ref} />}
                              <div className="muted small">{f.detail}</div>
                            </li>
                          ))}
                        </ul>
                      );
                    }}
                  </Live>
                </Card>
                <Card title="Recent activity" actions={<a href="#/activity">All</a>}>
                  {o.recent.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
                    <ul className="list">
                      {o.recent.map((e) => (
                        <li key={e.id}>
                          {EVENT_LABEL[e.type] ?? e.type} {e.ref && <Ref value={e.ref} />}
                          <div className="muted small"><Actor id={e.actor} /> · {when(e.at)}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          )
        }
      </Live>
    </>
  );
}
