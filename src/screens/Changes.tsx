import { useState, type ReactNode } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { ActivityTimeline, Alert, Button, DataTable, EvidenceSummary, MetadataList, StatusIndicator, Tabs, TabPanel, TextField, type VerificationState } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { askReason, attempt, Actor, Basis, can, Card, Empty, EVENT_LABEL, exact, go, Json, Live, PageHead, Ref, State, useApp, when } from "../ui";

const GROUPS: Array<[string, string, string[]]> = [
  ["open", "Open", ["proposed", "ready", "approved", "executing", "unknown"]],
  ["verified", "Verified", ["verified"]],
  ["stopped", "Did not happen", ["failed", "invalid", "superseded", "rejected", "cancelled"]],
  ["all", "All", []],
];

export function Changes() {
  const all = useQueryState(api.changes.list, { limit: 500 });
  const [group, setGroup] = useState("open");
  return (
    <>
      <PageHead title="Changes">Every change to what a reference resolves to, from proposal to verified execution. A proposal never executes by itself.</PageHead>
      <Tabs label="Changes by status" idPrefix="changes" panelId="changes-panel" active={group} onSelect={setGroup} tabs={GROUPS.map(([id, label]) => ({ id, label }))} />
      <TabPanel id="changes-panel" idPrefix="changes" active={group}>
        <Live state={all} what="changes">
          {(rows) => {
            const statuses = GROUPS.find(([id]) => id === group)![2];
            return <Card><ChangeTable label="Changes" rows={statuses.length ? rows.filter((c) => statuses.includes(c.status)) : rows} /></Card>;
          }}
        </Live>
      </TabPanel>
    </>
  );
}

type ChangeRow = NonNullable<ReturnType<typeof useQueryState<typeof api.changes.list>>["data"]>[number];

export function ChangeTable({ rows, label, emptyTitle = "No changes here" }: { rows: ChangeRow[]; label: string; emptyTitle?: string }) {
  return (
    <DataTable
      label={label}
      emptyTitle={emptyTitle}
      columns={[{ id: "n", header: "Change" }, { id: "ref", header: "Reference" }, { id: "what", header: "What" }, { id: "status", header: "Status" }, { id: "approvals", header: "Approvals", align: "end" }, { id: "by", header: "Proposed" }]}
      rows={rows.map((c) => ({
        key: c.id,
        onSelect: () => go(`changes/${c.id}`),
        cells: {
          n: `CHG-${c.number}`,
          ref: <Ref value={c.ref} link={false} />,
          what: <>{c.operation === "rollback" ? `Roll back to r${c.toRevision}` : c.operation === "create" ? "Introduce" : "Retarget"}{c.promotedFrom && <span className="small muted"> from {c.promotedFrom.ref}</span>}<div className="small muted">{c.reason}</div></>,
          status: <State field="resolver-control.change.status" value={c.status} />,
          approvals: `${c.approvals.length}/${c.impact.requiredApprovals}`,
          by: <><Actor id={c.proposedBy} type={c.proposedByType} /><div className="small muted">{when(c.proposedAt)}</div></>,
        },
      }))}
    />
  );
}

const STEPS = ["proposed", "validated", "approved", "executed", "verified"];
function stepOf(status: string): number {
  return { proposed: 0, ready: 1, invalid: 1, approved: 2, executing: 3, unknown: 3, failed: 3, verified: 4 }[status] ?? 0;
}

const CHECK: Record<string, VerificationState> = { pass: "verified", fail: "verification_failed", deferred: "not_evaluated" };

/** Checks as Stack evidence: each a claim with its own verification state. */
function Checks({ title, outcome, source, at, checks }: { title: string; outcome: ReactNode; source: string; at: number; checks: Array<{ id: string; label: string; outcome: string; detail: string }> }) {
  return (
    <EvidenceSummary
      title={title}
      headingLevel={2}
      outcome={outcome}
      source={source}
      recordedAt={at}
      // Stack treats "verified" without its checks as not evaluated (rightly): each claim carries the check that decided it.
      claims={checks.map((k) => ({
        label: k.label,
        value: k.detail,
        verification: CHECK[k.outcome] ?? "not_evaluated",
        ...(k.outcome === "pass" || k.outcome === "fail" ? { checks: [{ label: k.label, status: k.outcome === "pass" ? ("passed" as const) : ("failed" as const) }] } : {}),
        attrs: { "data-check": k.id, "data-outcome": k.outcome },
      }))}
    />
  );
}

type Consumer = { principal: string; application?: string; environment?: string; instance?: string; registration?: string; resolvedRevision?: number; usedRevision?: number; usedOutcome?: string };

export function Consumers({ list }: { list: Consumer[] }) {
  return (
    <ul className="list tight">
      {list.map((x) => (
        <li key={`${x.principal}/${x.instance ?? ""}`}>
          <strong>{x.application ?? "unregistered"}</strong>
          {x.instance && <span className="small muted"> {x.instance}</span>} <code className="small">{x.principal}</code>
          {x.registration && <span className="chip">{x.registration}</span>}
          {x.resolvedRevision !== undefined && <span className="small"> · resolved r{x.resolvedRevision}</span>}
          {x.usedRevision !== undefined && <span className="small"> · reported using r{x.usedRevision} ({x.usedOutcome})</span>}
        </li>
      ))}
    </ul>
  );
}

type AdoptionDoc = NonNullable<NonNullable<ReturnType<typeof useQueryState<typeof api.changes.get>>["data"]>["change"]["adoption"]>;

/** Resolver's adoption stages for the revision this change committed. Each keeps its basis; a notification is none of them. */
function AdoptionCard({ adoption: a }: { adoption: AdoptionDoc | undefined }) {
  if (!a) return <Card title="Adoption"><Empty title="Not read yet">The resolver component reads Resolver's adoption record for a day after verification (Resolver 0.4.0 or later).</Empty></Card>;
  return (
    <Card title="Adoption" subtitle={`Revision ${a.revision} · read from Resolver ${when(a.at)}`}>
      <MetadataList
        items={[
          { label: <>Authorized <Basis kind="observed" /></>, value: a.authorized.mode === "authorized" ? <>change authorization <code>{a.authorized.jti}</code> from {a.authorized.issuer}, consumed {a.authorized.consumedAt}</> : a.authorized.mode },
          { label: <>Committed <Basis kind="observed" /></>, value: a.committedAt },
          { label: <>Available <Basis kind="observed" /></>, value: a.available.current ? "current: consumers resolving now get it" : `superseded${a.available.until ? ` at ${a.available.until}` : ""} (Resolver is at r${a.currentRevision})` },
          { label: <>Fetched <Basis kind="observed" /></>, value: a.fetched.length ? <Consumers list={a.fetched} /> : "nobody has resolved it yet" },
          { label: <>Not yet fetched <Basis kind="derived" /></>, value: a.notYetFetched.length ? <Consumers list={a.notYetFetched} /> : "no live registered consumer is behind" },
          { label: <>Adopted <Basis kind="asserted" /></>, value: a.adopted.length ? <Consumers list={a.adopted} /> : "no consumer has reported using it" },
          { label: <>Functionally verified <Basis kind="unknown" /></>, value: "No verifier exists: nothing checks that the new target works for consumers." },
        ]}
      />
      <p className="small muted">A change notification reaching a consumer is not adoption: only a resolution shows a fetch, only a consumer's report shows use. Consumers that are not registered with Resolver appear only once they resolve.</p>
    </Card>
  );
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
    <Live state={state} what="this change">
      {({ change: c, policy, requiredApprovals, currentRevision }) => {
        const terminal = ["verified", "failed", "superseded", "rejected", "cancelled", "invalid"].includes(c.status);
        const mine = c.proposedBy === app.principal.id;
        const approvedByMe = c.approvals.some((a) => a.by === app.principal.id);
        const mayApprove = can(app.permissions, "changes.approve") && (!policy.protected || can(app.permissions, "changes.approve.protected")) && app.principal.type === "user" && !mine && !approvedByMe;
        const step = stepOf(c.status);
        return (
          <>
            <PageHead title={`CHG-${c.number}`} crumbs={[{ label: "Changes", href: "#/changes" }]} status={<State field="resolver-control.change.status" value={c.status} />}>
              {c.operation === "rollback" ? "Roll back " : c.operation === "create" ? "Introduce " : "Retarget "}
              <Ref value={c.ref} />
              {c.operation === "rollback" && ` to revision ${c.toRevision}`} — {c.reason}
            </PageHead>
            <ol className={`steps ${["failed", "unknown", "invalid"].includes(c.status) ? "steps-bad" : ""}`} aria-label="Lifecycle">
              {STEPS.map((s, i) => <li key={s} className={i < step || (i === step && c.status === "verified") ? "done" : i === step && !terminal ? "now" : i === step ? "stop" : ""}>{s}</li>)}
            </ol>

            {(c.status === "ready" || (c.status === "approved" && policy.frozen)) && (
              <Card title="Decision" subtitle={`${c.approvals.length} of ${requiredApprovals} approvals from different people${policy.protected ? " · protected environment: needs changes.approve.protected" : ""}${policy.frozen ? " · environment frozen" : ""}`}>
                {currentRevision !== null && currentRevision !== c.basedOnRevision && <Alert tone="critical">The reference is now at revision {currentRevision}; this change was proposed against {c.basedOnRevision} and will be superseded.</Alert>}
                <div className="decision">
                  <TextField name="note" label="Note" hint="Required to reject" value={note} onChange={setNote} />
                  <div className="decision-actions">
                    {c.status === "ready" && <Button label="Approve" variant="primary" disabled={!mayApprove} onClick={() => void attempt(app, () => approve({ id: c.id, ...(note ? { note } : {}) }), "Approval recorded.")} />}
                    {can(app.permissions, "changes.approve") && <Button label="Reject" variant="danger" disabled={note.trim().length < 3} onClick={() => void attempt(app, () => reject({ id: c.id, note }), "Rejected.")} />}
                  </div>
                </div>
                {!mayApprove && c.status === "ready" && <p className="small muted">{mine ? "The proposer of a change may not approve it." : approvedByMe ? "Another person must approve." : app.principal.type !== "user" ? "Only a person may approve." : "Your roles do not allow approving in this environment."}</p>}
              </Card>
            )}

            <div className="grid-2">
              <Card title="Proposal" subtitle={`By ${c.proposedBy} (${c.proposedByType}) ${exact(c.proposedAt)}`}>
                <MetadataList
                  items={[
                    { label: "Based on", value: <>revision {c.basedOnRevision}{currentRevision !== null && currentRevision !== c.basedOnRevision && !terminal && <span className="error-text"> · now r{currentRevision}</span>}</> },
                    ...(c.promotedFrom ? [{ label: "Promoted from", value: <><Ref value={c.promotedFrom.ref} /> r{c.promotedFrom.revision}</> }] : []),
                    ...(c.revertOf ? [{ label: "Reverts", value: <a href={`#/changes/${c.revertOf}`}>an earlier change</a> }] : []),
                    ...(c.ttlSeconds !== undefined ? [{ label: "TTL", value: `${c.ttlSeconds} s` }] : []),
                  ]}
                />
                <div className="diff">
                  <div><h3>Before</h3><Json label="Binding before" value={c.basedOnTargets.length ? { strategy: c.basedOnStrategy ?? "single", targets: c.basedOnTargets } : "nothing"} /></div>
                  <div><h3>After</h3><Json label="Binding after" value={c.operation === "rollback" ? `the binding of revision ${c.toRevision}, exactly as Resolver recorded it` : c.binding} /></div>
                </div>
              </Card>
              <Card title={<>Impact <Basis kind="derived" /></>} subtitle={`Assessed ${when(c.impact.computedAt)}, when proposed`}>
                <ul className="list tight">{c.impact.differences.map((d, i) => <li key={i}>{d}</li>)}</ul>
                <MetadataList
                  items={[
                    { label: "Environment", value: <>{c.environment}{c.impact.protected && <span className="chip">protected</span>}</> },
                    { label: "Criticality", value: <><State field="resolver-control.dependency.criticality" value={c.impact.criticality} /> · <State field="resolver-control.dependency.change_class" value={c.impact.changeClass} /></> },
                    { label: <>Consumers <Basis kind="declared" /></>, value: c.impact.declaredConsumers.length ? c.impact.declaredConsumers.map((x) => x.application).join(", ") : "none declared" },
                    { label: <>Consumers <Basis kind="observed" /></>, value: c.impact.observedConsumers === undefined ? "not read from Resolver" : c.impact.observedConsumers.length ? <Consumers list={c.impact.observedConsumers} /> : "none seen resolving" },
                    ...(c.impact.observedRelationships.length ? [{ label: <>Related <Basis kind="observed" /></>, value: <>{c.impact.observedRelationships.map((r) => <div key={r.ref}><Ref value={r.ref} /> <span className="small muted">{r.relation}</span></div>)}</> }] : []),
                    { label: "Fallback", value: c.impact.fallback },
                    { label: "Propagation", value: c.impact.propagation },
                  ]}
                />
                {c.impact.warnings.length > 0 && <Alert tone="attention" title="Warnings"><ul className="list tight">{c.impact.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Alert>}
                <details><summary className="small">Unknown ({c.impact.unknowns.length})</summary><ul className="list tight small muted">{c.impact.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul></details>
              </Card>
            </div>

            {c.validation ? (
              <Checks title="Validation" outcome={<StatusIndicator tone={c.validation.passed ? "positive" : "critical"} label={c.validation.passed ? "Passed" : "Failed"} />} source={`Checked by ${c.validation.by} against Resolver`} at={c.validation.at} checks={c.validation.checks} />
            ) : (
              <Card title="Validation"><Empty title="Not validated yet">Waiting for the resolver component.</Empty></Card>
            )}

            <div className="grid-2">
              <Card title="Approvals" subtitle={`${c.approvals.length} of ${c.impact.requiredApprovals} required at proposal; ${requiredApprovals} under the policy now`}>
                {c.approvals.length === 0 ? <Empty title="None yet" /> : <ul className="list">{c.approvals.map((a) => <li key={a.by}><strong>{a.by}</strong> <span className="small muted">{exact(a.at)}</span>{a.note && <div className="small">{a.note}</div>}</li>)}</ul>}
                {c.decision && <p><State field="resolver-control.change.status" value={c.decision.outcome} /> by {c.decision.by} {when(c.decision.at)}{c.decision.note && `: ${c.decision.note}`}</p>}
              </Card>
              <Card title={<>Execution <Basis kind="observed" /></>} subtitle={c.execution ? `Attempt ${c.execution.attempt} by ${c.execution.claimedBy}` : "Not executed"}>
                {!c.execution ? (
                  <Empty title={c.status === "approved" ? (policy.frozen ? "Approved, held: the environment is frozen" : "Approved; executes on the component's next pass") : "Nothing has been sent to Resolver"} />
                ) : (
                  <MetadataList
                    items={[
                      { label: "Started", value: exact(c.execution.claimedAt) },
                      ...(c.execution.finishedAt ? [{ label: "Finished", value: exact(c.execution.finishedAt) }] : []),
                      ...(c.execution.authorization ? [{ label: "Authorization", value: <><code>{c.execution.authorization.jti}</code> <span className="small muted">issued {exact(c.execution.authorization.issuedAt)} by the approval signer, valid until {c.execution.authorization.expiresAt}</span></> }] : []),
                      ...(c.execution.resolverRevision !== undefined ? [{ label: "Resolver revision", value: String(c.execution.resolverRevision), mono: true }] : []),
                      ...(c.execution.error ? [{ label: c.execution.error.code.startsWith("SIGNER_") ? "Approval signer said" : "Resolver said", value: <span className="error-text">{c.execution.error.code}{c.execution.error.reason && ` (${c.execution.error.reason})`}: {c.execution.error.message}</span> }] : []),
                      ...(c.execution.note ? [{ label: "Note", value: c.execution.note }] : []),
                    ]}
                  />
                )}
              </Card>
            </div>

            {c.verification && (
              <Checks
                title="Verification"
                outcome={<><StatusIndicator tone={c.verification.passed ? "positive" : "critical"} label={c.verification.passed ? "Verified" : "Not verified"} /> <span className="small summary">Written as revision {c.verification.revision} by <code>{c.verification.actor ?? "?"}</code>; Resolver now at {c.verification.currentRevision}.</span></>}
                source="Checked by the resolver component against Resolver's history and a fresh resolution"
                at={c.verification.at}
                checks={c.verification.checks}
              />
            )}
            {c.verification?.selected !== undefined && <details><summary className="small">What consumers resolve now</summary><Json value={c.verification.selected} /></details>}
            {c.status === "verified" && <AdoptionCard adoption={c.adoption} />}

            <div className="row-actions">
              {mine && ["proposed", "ready", "approved", "invalid"].includes(c.status) && <Button label="Withdraw" variant="ghost" onClick={() => void attempt(app, () => cancel({ id: c.id }), "Withdrawn.")} />}
              {c.status === "verified" && c.basedOnRevision > 0 && can(app.permissions, "changes.propose") && (
                <Button
                  label="Propose revert"
                  variant="secondary"
                  onClick={async () => {
                    const reason = await askReason(`Revert CHG-${c.number}`, `Proposes restoring revision ${c.basedOnRevision} of ${c.ref}. It is a new change with its own approval; history is kept.`, "Propose revert");
                    if (!reason) return;
                    const next = await attempt(app, () => revert({ id: c.id, reason }));
                    if (next) go(`changes/${next.id}`);
                  }}
                />
              )}
            </div>

            <Card title="Audit trail">
              <Live state={trail} what="the audit trail">
                {(events) => (
                  <ActivityTimeline
                    label="Audit trail"
                    emptyTitle="Nothing yet"
                    items={[...events].reverse().map((e) => ({ id: e.id, at: e.at, actor: <Actor id={e.actor} type={e.actorType} />, summary: EVENT_LABEL[e.type] ?? e.type, detail: <code title="AppPort request id">{e.requestId}</code> }))}
                  />
                )}
              </Live>
            </Card>
          </>
        );
      }}
    </Live>
  );
}
