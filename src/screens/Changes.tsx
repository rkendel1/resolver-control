import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Actor, Badge, Basis, can, Card, Empty, EVENT_LABEL, exact, go, Json, Live, PageHead, Ref, STATUS_LABEL, useApp, when } from "../ui";

const GROUPS: Array<[string, string[]]> = [
  ["Open", ["proposed", "ready", "approved", "executing", "unknown"]],
  ["Verified", ["verified"]],
  ["Did not happen", ["failed", "invalid", "superseded", "rejected", "cancelled"]],
  ["All", []],
];

export function Changes() {
  const all = useQueryState(api.changes.list, { limit: 500 });
  const [group, setGroup] = useState("Open");
  return (
    <>
      <PageHead title="Changes">Every change to what a reference resolves to, from proposal to verified execution. A proposal never executes by itself.</PageHead>
      <div className="tabs" role="tablist">
        {GROUPS.map(([name]) => <button key={name} role="tab" aria-selected={group === name} className={group === name ? "on" : ""} onClick={() => setGroup(name)}>{name}</button>)}
      </div>
      <Live state={all}>
        {(rows) => {
          const statuses = GROUPS.find(([n]) => n === group)![1];
          const shown = statuses.length ? rows.filter((c) => statuses.includes(c.status)) : rows;
          return <Card>{shown.length === 0 ? <Empty>No changes here.</Empty> : <ChangeTable rows={shown} />}</Card>;
        }}
      </Live>
    </>
  );
}

type ChangeRow = NonNullable<ReturnType<typeof useQueryState<typeof api.changes.list>>["data"]>[number];

export function ChangeTable({ rows }: { rows: ChangeRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Change</th><th>Reference</th><th>What</th><th>Status</th><th>Approvals</th><th>Proposed</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => go(`changes/${c.id}`)}>
              <td><a href={`#/changes/${c.id}`}>CHG-{c.number}</a></td>
              <td><Ref value={c.ref} /></td>
              <td>{c.operation === "rollback" ? `Roll back to r${c.toRevision}` : c.operation === "create" ? "Introduce" : "Retarget"}{c.promotedFrom && <span className="muted small"> from {c.promotedFrom.ref}</span>}<div className="muted small">{c.reason}</div></td>
              <td><Badge status={c.status} /></td>
              <td className="num">{c.approvals.length}/{c.impact.requiredApprovals}</td>
              <td className="small"><Actor id={c.proposedBy} type={c.proposedByType} /><div className="muted">{when(c.proposedAt)}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STEPS = ["proposed", "validated", "approved", "executed", "verified"];
function stepOf(status: string): number {
  return { proposed: 0, ready: 1, invalid: 1, approved: 2, executing: 3, unknown: 3, failed: 3, verified: 4 }[status] ?? 0;
}

export function ChangeDetail({ id }: { id: string }) {
  const app = useApp();
  const state = useQueryState(api.changes.get, { id });
  const trail = useQueryState(api.activity.list, { subjectId: id });
  const approve = useMutation(api.changes.approve);
  const reject = useMutation(api.changes.reject);
  const cancel = useMutation(api.changes.cancel);
  const revert = useMutation(api.changes.proposeRevert);
  const [note, setNote] = useState("");
  return (
    <Live state={state}>
      {({ change: c, policy, requiredApprovals, currentRevision }) => {
        const terminal = ["verified", "failed", "superseded", "rejected", "cancelled", "invalid"].includes(c.status);
        const mine = c.proposedBy === app.principal.id;
        const approvedByMe = c.approvals.some((a) => a.by === app.principal.id);
        const mayApprove = can(app.permissions, "changes.approve") && (!policy.protected || can(app.permissions, "changes.approve.protected")) && app.principal.type === "user" && !mine && !approvedByMe;
        const step = stepOf(c.status);
        return (
          <>
            <PageHead title={<><a className="crumb" href="#/changes">Changes</a> / CHG-{c.number}</>} actions={<Badge status={c.status} />}>
              {c.operation === "rollback" ? `Roll back ` : c.operation === "create" ? "Introduce " : "Retarget "}<Ref value={c.ref} />{c.operation === "rollback" && ` to revision ${c.toRevision}`} — {c.reason}
            </PageHead>
            <ol className={`steps ${["failed", "unknown", "invalid"].includes(c.status) ? "steps-bad" : ""}`}>
              {STEPS.map((s, i) => <li key={s} className={i < step || (i === step && c.status === "verified") ? "done" : i === step && !terminal ? "now" : i === step ? "stop" : ""}>{s}</li>)}
              {terminal && c.status !== "verified" && <li className="stop">{STATUS_LABEL[c.status]}</li>}
            </ol>

            {(c.status === "ready" || (c.status === "approved" && policy.frozen)) && (
              <Card title="Decision" subtitle={`${c.approvals.length} of ${requiredApprovals} approvals from different people${policy.protected ? " · protected environment: needs changes.approve.protected" : ""}${policy.frozen ? " · environment frozen" : ""}`}>
                {currentRevision !== null && currentRevision !== c.basedOnRevision && <p className="error-text">The reference is now at revision {currentRevision}; this change was proposed against {c.basedOnRevision} and will be superseded.</p>}
                <div className="decision">
                  <input placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
                  {c.status === "ready" && <button className="btn primary" disabled={!mayApprove} title={mayApprove ? "" : mine ? "You proposed it" : approvedByMe ? "You already approved" : "You may not approve here"} onClick={() => attempt(app, () => approve({ id: c.id, ...(note ? { note } : {}) }), "Approval recorded.")}>Approve</button>}
                  {can(app.permissions, "changes.approve") && <button className="btn danger" disabled={note.trim().length < 3} onClick={() => attempt(app, () => reject({ id: c.id, note }), "Rejected.")}>Reject</button>}
                </div>
                {!mayApprove && c.status === "ready" && <p className="muted small">{mine ? "The proposer of a change may not approve it." : approvedByMe ? "Another person must approve." : app.principal.type !== "user" ? "Only a person may approve." : "Your roles do not allow approving in this environment."}</p>}
              </Card>
            )}

            <div className="grid-2">
              <Card title="Proposal" subtitle={`By ${c.proposedBy} (${c.proposedByType}) ${exact(c.proposedAt)}`}>
                <dl className="facts">
                  <dt>Based on</dt><dd>revision {c.basedOnRevision}{currentRevision !== null && currentRevision !== c.basedOnRevision && !terminal && <> · <span className="error-text">now r{currentRevision}</span></>}</dd>
                  {c.promotedFrom && <><dt>Promoted from</dt><dd><Ref value={c.promotedFrom.ref} /> r{c.promotedFrom.revision}</dd></>}
                  {c.revertOf && <><dt>Reverts</dt><dd><a href={`#/changes/${c.revertOf}`}>an earlier change</a></dd></>}
                  {c.ttlSeconds !== undefined && <><dt>TTL</dt><dd>{c.ttlSeconds} s</dd></>}
                </dl>
                <div className="diff">
                  <div><h3>Before</h3><Json value={c.basedOnTargets.length ? { strategy: c.basedOnStrategy ?? "single", targets: c.basedOnTargets } : "nothing"} /></div>
                  <div><h3>After</h3><Json value={c.operation === "rollback" ? `the binding of revision ${c.toRevision}, exactly as Resolver recorded it` : c.binding} /></div>
                </div>
              </Card>
              <Card title={<>Impact <Basis kind="derived" /></>} subtitle={`Assessed ${when(c.impact.computedAt)}, when proposed`}>
                <ul className="list tight">{c.impact.differences.map((d, i) => <li key={i}>{d}</li>)}</ul>
                <dl className="facts">
                  <dt>Environment</dt><dd>{c.environment} {c.impact.protected && <Badge status="warning" label="protected" />}</dd>
                  <dt>Criticality</dt><dd><Badge status={c.impact.criticality} /> · <Badge status={c.impact.changeClass} /></dd>
                  <dt>Consumers <Basis kind="declared" /></dt><dd>{c.impact.declaredConsumers.length ? c.impact.declaredConsumers.map((x) => x.application).join(", ") : <span className="muted">none declared</span>}</dd>
                  {c.impact.observedRelationships.length > 0 && <><dt>Related <Basis kind="observed" /></dt><dd>{c.impact.observedRelationships.map((r) => <div key={r.ref}><Ref value={r.ref} /> <span className="muted small">{r.relation}</span></div>)}</dd></>}
                  <dt>Fallback</dt><dd>{c.impact.fallback}</dd>
                  <dt>Propagation</dt><dd className="small">{c.impact.propagation}</dd>
                </dl>
                {c.impact.warnings.length > 0 && <ul className="list tight warn-list">{c.impact.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                <details><summary className="small">Unknown ({c.impact.unknowns.length})</summary><ul className="list tight muted small">{c.impact.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul></details>
              </Card>
            </div>

            <Card title="Validation" subtitle={c.validation ? `By ${c.validation.by} ${when(c.validation.at)}, against Resolver` : "Waiting for the resolver component"}>
              {!c.validation ? <Empty>Not validated yet.</Empty> : <Checks checks={c.validation.checks} />}
            </Card>

            <div className="grid-2">
              <Card title="Approvals" subtitle={`${c.approvals.length} of ${c.impact.requiredApprovals} required at proposal; ${requiredApprovals} under the policy now`}>
                {c.approvals.length === 0 ? <Empty>None yet.</Empty> : <ul className="list">{c.approvals.map((a) => <li key={a.by}><strong>{a.by}</strong> <span className="muted small">{exact(a.at)}</span>{a.note && <div className="small">{a.note}</div>}</li>)}</ul>}
                {c.decision && <p><Badge status={c.decision.outcome} /> by {c.decision.by} {when(c.decision.at)}{c.decision.note && `: ${c.decision.note}`}</p>}
              </Card>
              <Card title={<>Execution <Basis kind="observed" /></>} subtitle={c.execution ? `Attempt ${c.execution.attempt} by ${c.execution.claimedBy}` : "Not executed"}>
                {!c.execution ? <Empty>{c.status === "approved" ? (policy.frozen ? "Approved, held: the environment is frozen." : "Approved; the resolver component executes it on its next pass.") : "Nothing has been sent to Resolver."}</Empty> : (
                  <dl className="facts">
                    <dt>Started</dt><dd>{exact(c.execution.claimedAt)}</dd>
                    {c.execution.finishedAt && <><dt>Finished</dt><dd>{exact(c.execution.finishedAt)}</dd></>}
                    {c.execution.resolverRevision !== undefined && <><dt>Resolver revision</dt><dd>{c.execution.resolverRevision}</dd></>}
                    {c.execution.error && <><dt>Resolver said</dt><dd className="error-text">{c.execution.error.code}{c.execution.error.reason && ` (${c.execution.error.reason})`}: {c.execution.error.message}</dd></>}
                    {c.execution.note && <><dt>Note</dt><dd>{c.execution.note}</dd></>}
                  </dl>
                )}
              </Card>
            </div>

            {c.verification && (
              <Card title={<>Verification <Basis kind="observed" /></>} subtitle={`${c.verification.passed ? "Passed" : "Did not pass"} ${exact(c.verification.at)} · written as revision ${c.verification.revision} by ${c.verification.actor ?? "?"} · Resolver now at ${c.verification.currentRevision}`}>
                <Checks checks={c.verification.checks} />
                {c.verification.selected !== undefined && <details><summary className="small">What consumers resolve now</summary><Json value={c.verification.selected} /></details>}
              </Card>
            )}

            <div className="row-actions">
              {mine && ["proposed", "ready", "approved", "invalid"].includes(c.status) && <button className="btn ghost" onClick={() => attempt(app, () => cancel({ id: c.id }), "Withdrawn.")}>Withdraw</button>}
              {c.status === "verified" && c.basedOnRevision > 0 && can(app.permissions, "changes.propose") && (
                <button className="btn ghost" onClick={async () => {
                  const reason = window.prompt("Why revert this change?");
                  if (!reason) return;
                  const next = await attempt(app, () => revert({ id: c.id, reason }));
                  if (next) go(`changes/${next.id}`);
                }}>Propose revert</button>
              )}
            </div>

            <Card title="Audit trail">
              <Live state={trail}>
                {(events) => events.length === 0 ? <Empty>Nothing yet.</Empty> : (
                  <ul className="timeline">
                    {[...events].reverse().map((e) => (
                      <li key={e.id}><span className="t-label">{EVENT_LABEL[e.type] ?? e.type}</span> <span className="muted small"><Actor id={e.actor} type={e.actorType} /> · {exact(e.at)} · <code title="AppPort request id">{e.requestId}</code></span></li>
                    ))}
                  </ul>
                )}
              </Live>
            </Card>
          </>
        );
      }}
    </Live>
  );
}

function Checks({ checks }: { checks: Array<{ id: string; label: string; outcome: string; detail: string }> }) {
  return (
    <table className="table compact">
      <tbody>
        {checks.map((k) => (
          <tr key={k.id}><td><Badge status={k.outcome} /></td><td><strong>{k.label}</strong><div className="muted small">{k.detail}</div></td></tr>
        ))}
      </tbody>
    </table>
  );
}
