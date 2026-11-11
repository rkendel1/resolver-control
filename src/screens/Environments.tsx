import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { Button, Checkbox, DataTable, Select } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { askReason, attempt, Basis, can, Card, Live, PageHead, Ref, State, useApp } from "../ui";

export function Environments() {
  const app = useApp();
  const envs = useQueryState(api.catalog.environments, {});
  const setPolicy = useMutation(api.policies.set);
  const freeze = useMutation(api.policies.freeze);
  const [pair, setPair] = useState<string[]>([]);
  const writable = can(app.permissions, "policies.write");
  return (
    <>
      <PageHead title="Environments">An environment is a reference namespace (<code>ref://prod/…</code>). Policies here decide who must approve a change; Resolver's grants on the executor key decide what can be written at all.</PageHead>
      <Live state={envs} what="environments">
        {(rows) => {
          const defaults = rows.map((r) => r.environment).filter((e) => ["staging", "prod"].includes(e));
          const chosen = pair.length >= 2 ? pair : defaults.length === 2 ? defaults : rows.slice(0, 2).map((r) => r.environment);
          return (
            <>
              <Card subtitle="Critical dependencies always need at least two different approvers. An environment without a recorded policy is treated as protected.">
                <DataTable
                  label="Environments and their change policy"
                  emptyTitle="No environments yet"
                  emptyBody="Set the managed namespaces in Settings."
                  columns={[{ id: "env", header: "Environment" }, { id: "refs", header: "References", align: "end" }, { id: "protected", header: "Protected" }, { id: "approvals", header: "Approvals" }, { id: "frozen", header: "Frozen" }, { id: "act", header: "" }]}
                  rows={rows.map((e) => ({
                    key: e.environment,
                    cells: {
                      env: <><strong>{e.environment}</strong>{!e.managed && <span className="small muted"> (not managed)</span>}{!e.explicitPolicy && <div className="small muted">default policy</div>}</>,
                      refs: e.references,
                      protected: writable ? <Checkbox id={`protected-${e.environment}`} label={<span className="stack-visually-hidden">{e.environment} protected</span>} checked={e.protected} onChange={(checked) => void attempt(app, () => setPolicy({ environment: e.environment, protected: checked, approvalsRequired: e.approvalsRequired }), "Policy recorded.")} /> : e.protected ? "Yes" : "No",
                      approvals: writable ? <Select id={`approvals-${e.environment}`} label={<span className="stack-visually-hidden">{e.environment} approvals required</span>} value={String(e.approvalsRequired)} options={["1", "2", "3", "4", "5"]} onChange={(v) => void attempt(app, () => setPolicy({ environment: e.environment, protected: e.protected, approvalsRequired: Number(v) }), "Policy recorded.")} /> : e.approvalsRequired,
                      frozen: e.frozen ? <State field="resolver-control.finding.severity" value="action" label="Frozen" detail={e.freezeReason} /> : "No",
                      act: writable ? (
                        <Button
                          label={e.frozen ? "Unfreeze" : "Freeze"}
                          size="sm"
                          variant="secondary"
                          onClick={async () => {
                            if (e.frozen) return void attempt(app, () => freeze({ environment: e.environment, frozen: false }), "Unfrozen.");
                            const reason = await askReason(`Freeze ${e.environment}`, "No change is approved or executed here while it is frozen; approved changes wait.", "Freeze");
                            if (reason) void attempt(app, () => freeze({ environment: e.environment, frozen: true, reason }), "Frozen.");
                          }}
                        />
                      ) : null,
                    },
                  }))}
                />
              </Card>
              {rows.length >= 2 && (
                <Card
                  title={<>Compare <Basis kind="observed" /></>}
                  actions={
                    <div className="pair">
                      {[0, 1].map((i) => (
                        <Select key={i} id={`compare-${i}`} label={`Environment ${i + 1}`} value={chosen[i]} options={rows.map((r) => r.environment)} onChange={(v) => { const next = [...chosen]; next[i] = v; setPair(next); }} />
                      ))}
                    </div>
                  }
                >
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
    <Live state={state} what="the comparison">
      {(rows) => (
        <DataTable
          label={`Compare ${environments.join(" and ")}`}
          emptyTitle="No references observed in these environments"
          columns={[{ id: "path", header: "Path" }, ...environments.map((e) => ({ id: e, header: e })), { id: "cmp", header: "Compared" }]}
          rows={rows.map((r) => ({
            key: r.path,
            cells: {
              path: <><code>{r.path}</code> <span className="small muted">{r.kind}</span></>,
              ...Object.fromEntries(r.cells.map((c) => [c.environment, c.present ? <><Ref value={c.ref} /><div className="small">{c.summary} <span className="muted">r{c.revision}</span></div></> : <span className="muted">missing</span>])),
              cmp: <State field="resolver-control.comparison" value={r.differs ? "differs" : "same"} />,
            },
          }))}
        />
      )}
    </Live>
  );
}
