import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Badge, Basis, can, Card, Empty, Live, PageHead, Ref, useApp } from "../ui";

export function Environments() {
  const app = useApp();
  const envs = useQueryState(api.catalog.environments, {});
  const setPolicy = useMutation(api.policies.set);
  const freeze = useMutation(api.policies.freeze);
  const [pair, setPair] = useState<string[]>([]);
  return (
    <>
      <PageHead title="Environments">An environment is a reference namespace (<code>ref://prod/…</code>). Policies here decide who must approve a change; Resolver's grants on the executor key decide what can be written at all.</PageHead>
      <Live state={envs}>
        {(rows) => {
          const chosen = pair.length >= 2 ? pair : rows.map((r) => r.environment).filter((e) => ["staging", "prod"].includes(e)).length === 2 ? ["staging", "prod"] : rows.slice(0, 2).map((r) => r.environment);
          return (
            <>
              <Card>
                {rows.length === 0 ? <Empty>No environments yet: set the managed namespaces in Settings.</Empty> : (
                  <table className="table">
                    <thead><tr><th>Environment</th><th className="num">References</th><th>Protected</th><th>Approvals</th><th>Frozen</th><th /></tr></thead>
                    <tbody>
                      {rows.map((e) => (
                        <tr key={e.environment}>
                          <td><strong>{e.environment}</strong> {!e.managed && <span className="muted small">(not managed)</span>} {!e.explicitPolicy && <Badge status="warning" label="default policy" />}</td>
                          <td className="num">{e.references}</td>
                          <td>{can(app.permissions, "policies.write") ? <input type="checkbox" checked={e.protected} onChange={(ev) => attempt(app, () => setPolicy({ environment: e.environment, protected: ev.target.checked, approvalsRequired: e.approvalsRequired }), "Policy recorded.")} aria-label={`${e.environment} protected`} /> : e.protected ? "yes" : "no"}</td>
                          <td>{can(app.permissions, "policies.write") ? (
                            <select value={e.approvalsRequired} onChange={(ev) => attempt(app, () => setPolicy({ environment: e.environment, protected: e.protected, approvalsRequired: Number(ev.target.value) }), "Policy recorded.")} aria-label={`${e.environment} approvals`}>
                              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                          ) : e.approvalsRequired}</td>
                          <td>{e.frozen ? <><Badge status="action" label="frozen" /> <span className="small">{e.freezeReason}</span></> : <span className="muted">no</span>}</td>
                          <td>{can(app.permissions, "policies.write") && (
                            <button className="btn small ghost" onClick={() => {
                              if (e.frozen) return void attempt(app, () => freeze({ environment: e.environment, frozen: false }), "Unfrozen.");
                              const reason = window.prompt(`Why freeze ${e.environment}? Approved changes will wait.`);
                              if (reason) void attempt(app, () => freeze({ environment: e.environment, frozen: true, reason }), "Frozen.");
                            }}>{e.frozen ? "Unfreeze" : "Freeze"}</button>
                          )}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="muted small">Critical dependencies always need at least two different approvers. An environment without a recorded policy is treated as protected.</p>
              </Card>
              {rows.length >= 2 && (
                <Card title={<>Compare <Basis kind="observed" /></>} actions={
                  <div className="pair">
                    {[0, 1].map((i) => (
                      <select key={i} value={chosen[i]} onChange={(ev) => { const next = [...chosen]; next[i] = ev.target.value; setPair(next); }} aria-label={`Environment ${i + 1}`}>
                        {rows.map((r) => <option key={r.environment}>{r.environment}</option>)}
                      </select>
                    ))}
                  </div>
                }>
                  <Compare environments={chosen} />
                </Card>
              )}
            </>
          );
        }}
      </Live>
    </>
  );
}

function Compare({ environments }: { environments: string[] }) {
  const state = useQueryState(api.catalog.compare, { environments });
  return (
    <Live state={state}>
      {(rows) => rows.length === 0 ? <Empty>No references observed in these environments.</Empty> : (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Path</th>{environments.map((e) => <th key={e}>{e}</th>)}<th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <td><code>{r.path}</code> <span className="muted small">{r.kind}</span></td>
                  {r.cells.map((c) => <td key={c.environment} className="summary">{c.present ? <><Ref value={c.ref} /><div className="small">{c.summary} <span className="muted">r{c.revision}</span></div></> : <span className="muted">missing</span>}</td>)}
                  <td>{r.differs ? <Badge status="warning" label="differs" /> : <Badge status="ok" label="same" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Live>
  );
}
