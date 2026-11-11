import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Actor, Badge, Basis, can, Card, Empty, EVENT_LABEL, exact, go, Json, Kind, Live, PageHead, Ref, useApp, when } from "../ui";

const CATEGORIES = ["ai", "search", "email", "communications", "payments", "identity", "storage", "analytics", "data", "processing", "integrations", "operations", "credentials", "configuration", "agents", "other"];

export function Dependencies() {
  const app = useApp();
  const inventory = useQueryState(api.catalog.inventory, {});
  const [env, setEnv] = useState("");
  const [kind, setKind] = useState("");
  const [governance, setGovernance] = useState("");
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead title="Dependencies" actions={can(app.permissions, "changes.propose") && <button className="btn" onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "Introduce a reference"}</button>}>
        Everything your applications resolve through Resolver, joined with what people know about it. <Basis kind="observed" /> columns come from Resolver; <Basis kind="declared" /> ones from people and consumers.
      </PageHead>
      {creating && <IntroduceForm onDone={() => setCreating(false)} />}
      <Live state={inventory}>
        {(rows) => {
          const envs = [...new Set(rows.map((r) => r.environment))].sort();
          const kinds = [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort() as string[];
          const q = text.trim().toLowerCase();
          const shown = rows.filter((r) => (!env || r.environment === env) && (!kind || r.kind === kind) && (!governance || r.governance === governance) && (!q || [r.ref, r.title, r.owner, r.summary, r.category].some((v) => v?.toLowerCase().includes(q))));
          return (
            <Card>
              <div className="filters">
                <input placeholder="Search refs, titles, owners, targets" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
                <select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
                  <option value="">All environments</option>
                  {envs.map((e) => <option key={e}>{e}</option>)}
                </select>
                <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                  <option value="">All kinds</option>
                  {kinds.map((k) => <option key={k}>{k}</option>)}
                </select>
                <select value={governance} onChange={(e) => setGovernance(e.target.value)} aria-label="Governance">
                  <option value="">Any governance</option>
                  <option value="governed">Governed</option>
                  <option value="unregistered">Unregistered</option>
                  <option value="not_in_resolver">Not in Resolver</option>
                  <option value="not_visible">Not visible</option>
                </select>
                <span className="muted small">{shown.length} of {rows.length}</span>
              </div>
              {rows.length === 0 ? (
                <Empty>No references yet. Once the resolver component observes Resolver, every reference the executor key may read appears here.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Reference</th>
                        <th>Kind</th>
                        <th>Resolves to <Basis kind="observed" /></th>
                        <th>Rev</th>
                        <th>Owner · criticality <Basis kind="declared" /></th>
                        <th>Change class</th>
                        <th className="num">Consumers</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.ref} className="clickable" onClick={() => go(`dependencies/${encodeURIComponent(r.ref)}`)}>
                          <td>
                            <Ref value={r.ref} />
                            {r.title && <div className="muted small">{r.title}</div>}
                          </td>
                          <td><Kind kind={r.kind} /></td>
                          <td className="summary">{r.summary ?? <span className="muted">not observed</span>}{r.state === "revoked" && <> <Badge status="revoked" /></>}</td>
                          <td className="num">{r.revision ?? "—"}</td>
                          <td>{r.owner ?? <span className="muted">no owner</span>}{r.criticality && <> · <Badge status={r.criticality} /></>}</td>
                          <td>{r.changeClass ? <Badge status={r.changeClass} /> : <span className="muted">—</span>}</td>
                          <td className="num">{r.consumers || <span className="muted">0</span>}</td>
                          <td>
                            <Badge status={r.governance} />
                            {r.openChange && <a className="badge info" href={`#/changes/${r.openChange.id}`} onClick={(e) => e.stopPropagation()}>CHG-{r.openChange.number}</a>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        }}
      </Live>
    </>
  );
}

function IntroduceForm({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const create = useMutation(api.changes.proposeCreate);
  const [ref, setRef] = useState("ref://staging/");
  const [kind, setKind] = useState<"value" | "model" | "endpoint" | "agent">("endpoint");
  const [binding, setBinding] = useState('{ "value": { "url": "https://" } }');
  const [reason, setReason] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(binding);
    } catch {
      app.report(new Error("The binding is not valid JSON."));
      return;
    }
    const change = await attempt(app, () => create({ ref, kind, binding: parsed, reason }), "Proposed. The resolver component validates it next.");
    if (change) {
      onDone();
      go(`changes/${change.id}`);
    }
  };
  return (
    <Card title="Introduce a runtime reference" subtitle="Turns an embedded choice into an explicit, governed reference. The consumer still has to resolve it in code once.">
      <form className="form" onSubmit={submit}>
        <label>Reference<input value={ref} onChange={(e) => setRef(e.target.value)} required /></label>
        <label>Kind
          <select value={kind} onChange={(e) => {
            const k = e.target.value as typeof kind;
            setKind(k);
            setBinding({ endpoint: '{ "value": { "url": "https://" } }', model: '{ "value": { "provider": "", "model": "", "credential": "ref://<env>/llm/<key>" } }', value: '{ "value": {} }', agent: '{ "value": { "origin": "https://" } }' }[k]);
          }}>
            <option>endpoint</option><option>model</option><option>value</option><option>agent</option>
          </select>
        </label>
        <label className="wide">Binding (JSON: {"{ value }"} or {"{ strategy, targets }"})<textarea rows={5} value={binding} onChange={(e) => setBinding(e.target.value)} spellCheck={false} /></label>
        <label className="wide">Why<input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required placeholder="What this makes possible" /></label>
        <div className="form-actions"><button className="btn primary">Propose</button></div>
      </form>
    </Card>
  );
}

export function DependencyDetail({ refName }: { refName: string }) {
  const app = useApp();
  const detail = useQueryState(api.catalog.detail, { ref: refName });
  return (
    <Live state={detail}>
      {(d) => {
        const o = d.observation;
        const governance = !o ? "not_in_resolver" : !o.visible ? "not_visible" : d.dependency ? "governed" : "unregistered";
        return (
          <>
            <PageHead title={<><a className="crumb" href="#/dependencies">Dependencies</a> / <code>{d.ref}</code></>}>
              {d.dependency?.title ?? "No description recorded."} <Kind kind={o?.kind} /> <Badge status={governance} /> {d.policy.protected && <Badge status="warning" label="protected environment" />} {d.policy.frozen && <Badge status="action" label="frozen" />}
            </PageHead>
            <div className="grid-2">
              <Card title={<>Current resolution <Basis kind="observed" /></>} subtitle={o ? `Revision ${o.revision} · read ${when(o.observedAt)} · changed in Resolver ${new Date(o.updatedAt).toLocaleString()}` : undefined}>
                {!o ? (
                  <Empty>Not observed in Resolver. It does not exist yet, or the executor key may not read it.</Empty>
                ) : (
                  <>
                    <p className="resolution">{d.summary}</p>
                    <dl className="facts">
                      <dt>Strategy</dt><dd>{o.strategy ?? "single"}</dd>
                      <dt>State</dt><dd><Badge status={o.state} /></dd>
                      {o.ttlSeconds !== undefined && <><dt>Propagation</dt><dd>live stream; at most {o.ttlSeconds} s (TTL)</dd></>}
                    </dl>
                    <details><summary>Targets as Resolver returned them</summary><Json value={o.targets} /></details>
                  </>
                )}
              </Card>
              <DescribeCard d={d} />
            </div>
            {o && o.kind !== "secret" && o.state === "active" && can(app.permissions, "changes.propose") && <ProposeCard observation={o} />}
            <div className="grid-2">
              <ConsumersCard refName={d.ref} consumers={d.consumers} />
              <Card title={<>Relationships <Basis kind="observed" /></>} subtitle="Read from bindings; Resolver reports no consumers">
                {d.credentials.length === 0 && d.dependents.length === 0 ? <Empty>No credential relationships.</Empty> : (
                  <ul className="list">
                    {d.credentials.map((c) => (
                      <li key={c.ref}>Uses credential <Ref value={c.ref} /> {c.observed ? <>r{c.revision} <Badge status={c.state ?? "unknown"} /></> : <Badge status="warning" label="not observed" />}</li>
                    ))}
                    {d.dependents.map((m) => (
                      <li key={m.ref}>Credential of model <Ref value={m.ref} /> (r{m.revision})</li>
                    ))}
                  </ul>
                )}
                {o?.kind === "secret" && <p className="muted small">Secret material is never read by this application. Rotate or set it in Resolver; propose a rollback from its history below.</p>}
              </Card>
            </div>
            <div className="grid-2">
              <Card title="Other environments" subtitle="The same path elsewhere">
                {d.counterparts.length === 0 ? <Empty>This path exists in no other observed environment.</Empty> : (
                  <table className="table compact">
                    <tbody>
                      {d.counterparts.map((c) => (
                        <tr key={c.ref}>
                          <td><Ref value={c.ref} /></td>
                          <td className="summary">{c.summary}</td>
                          <td>{c.same ? <Badge status="ok" label="same" /> : <Badge status="warning" label="differs" />}</td>
                          <td>{!c.same && o?.kind !== "secret" && can(app.permissions, "changes.propose") && <PromoteButton from={c.ref} to={d.environment} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <Card title="Changes">
                {d.changes.length === 0 ? <Empty>No change has been proposed here.</Empty> : (
                  <ul className="list">
                    {d.changes.map((c) => (
                      <li key={c.id}><a href={`#/changes/${c.id}`}>CHG-{c.number}</a> {c.operation} <Badge status={c.status} /> <span className="muted">{c.reason}</span><div className="muted small">{c.proposedBy} · {when(c.proposedAt)}</div></li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            {o && <HistoryCard refName={d.ref} observation={o} />}
            <Card title="Audit trail">
              {d.events.length === 0 ? <Empty>Nothing recorded for this reference yet.</Empty> : (
                <ul className="timeline">
                  {d.events.map((e) => (
                    <li key={e.id}>
                      <span className="t-label">{EVENT_LABEL[e.type] ?? e.type}</span> <span className="muted small"><Actor id={e.actor} type={e.actorType} /> · {exact(e.at)} · <code title="AppPort request id">{e.requestId}</code></span>
                      {e.data && Object.keys(e.data).length > 0 && <details><summary className="small muted">details</summary><Json value={e.data} /></details>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        );
      }}
    </Live>
  );
}

type Detail = NonNullable<ReturnType<typeof useQueryState<typeof api.catalog.detail>>["data"]>;

function DescribeCard({ d }: { d: Detail }) {
  const app = useApp();
  const register = useMutation(api.catalog.register);
  const [editing, setEditing] = useState(false);
  const dep = d.dependency;
  const [form, setForm] = useState({ title: dep?.title ?? "", category: dep?.category ?? "other", owner: dep?.owner ?? "", criticality: dep?.criticality ?? "medium", changeClass: dep?.changeClass ?? "unknown", contract: dep?.contract ?? "", changeClassNote: dep?.changeClassNote ?? "", description: dep?.description ?? "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await attempt(app, () => register({ ref: d.ref, title: form.title, category: form.category as never, criticality: form.criticality as never, changeClass: form.changeClass as never, ...(form.owner ? { owner: form.owner } : {}), ...(form.contract ? { contract: form.contract } : {}), ...(form.changeClassNote ? { changeClassNote: form.changeClassNote } : {}), ...(form.description ? { description: form.description } : {}) }), "Recorded.");
    if (ok) setEditing(false);
  };
  return (
    <Card title={<>What is known <Basis kind="declared" /></>} actions={can(app.permissions, "catalog.write") && <button className="btn small" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : dep ? "Edit" : "Register"}</button>}>
      {editing ? (
        <form className="form" onSubmit={submit}>
          <label>Title<input value={form.title} onChange={set("title")} required /></label>
          <label>Owner<input value={form.owner} onChange={set("owner")} placeholder="team or person" /></label>
          <label>Category<select value={form.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>Criticality<select value={form.criticality} onChange={set("criticality")}><option>low</option><option>medium</option><option>high</option><option>critical</option></select></label>
          <label>Change class
            <select value={form.changeClass} onChange={set("changeClass")}>
              <option value="runtime">runtime: compatible implementations, switch in Resolver</option>
              <option value="adapter">adapter: consumers need an adapter first</option>
              <option value="migration">migration: data or contract migration</option>
              <option value="unknown">unknown: not assessed</option>
            </select>
          </label>
          <label className="wide">Contract consumers rely on<input value={form.contract} onChange={set("contract")} placeholder="e.g. OpenAI-compatible chat completions" /></label>
          <label className="wide">Why this change class<input value={form.changeClassNote} onChange={set("changeClassNote")} /></label>
          <div className="form-actions"><button className="btn primary">Save</button></div>
        </form>
      ) : !dep ? (
        <Empty>Nobody has recorded what this is, who owns it, how critical it is, or what changing it takes.</Empty>
      ) : (
        <dl className="facts">
          <dt>Owner</dt><dd>{dep.owner ?? <span className="muted">none</span>}</dd>
          <dt>Category</dt><dd>{dep.category}</dd>
          <dt>Criticality</dt><dd><Badge status={dep.criticality} /></dd>
          <dt>Change class</dt><dd><Badge status={dep.changeClass} />{dep.changeClassNote && <div className="muted small">{dep.changeClassNote}</div>}</dd>
          {dep.contract && <><dt>Contract</dt><dd>{dep.contract}</dd></>}
          <dt>Recorded</dt><dd className="small muted">by {dep.updatedBy} {when(dep.updatedAt)}</dd>
        </dl>
      )}
    </Card>
  );
}

function ConsumersCard({ refName, consumers }: { refName: string; consumers: Detail["consumers"] }) {
  const app = useApp();
  const declare = useMutation(api.catalog.declareConsumer);
  const remove = useMutation(api.catalog.removeConsumer);
  const [application, setApplication] = useState("");
  const [usage, setUsage] = useState("");
  return (
    <Card title={<>Consumers <Basis kind="declared" /></>} subtitle="Resolver does not report who resolves a reference. These are declarations, not observations.">
      {consumers.length === 0 ? <Empty>No consumer declared: the blast radius of a change is unknown.</Empty> : (
        <ul className="list">
          {consumers.map((c) => (
            <li key={c.id}>
              <strong>{c.application}</strong> {c.usage && <span className="muted">— {c.usage}</span>}
              <div className="muted small">{c.source === "declared_by_consumer" ? "declared by the application itself" : `declared by ${c.declaredBy}`} · {when(c.declaredAt)} {can(app.permissions, "consumers.write") && <button className="link small" onClick={() => attempt(app, () => remove({ id: c.id }))}>remove</button>}</div>
            </li>
          ))}
        </ul>
      )}
      {can(app.permissions, "consumers.write") && (
        <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (await attempt(app, () => declare({ ref: refName, application, ...(usage ? { usage } : {}) }))) { setApplication(""); setUsage(""); } }}>
          <input placeholder="application" value={application} onChange={(e) => setApplication(e.target.value)} required />
          <input placeholder="what it uses it for" value={usage} onChange={(e) => setUsage(e.target.value)} />
          <button className="btn small">Declare</button>
        </form>
      )}
    </Card>
  );
}

type Observation = NonNullable<Detail["observation"]>;

function ProposeCard({ observation: o }: { observation: Observation }) {
  const app = useApp();
  const propose = useMutation(api.changes.proposeRetarget);
  const current = useMemo(() => (o.strategy ?? "single") === "single" && o.targets.length === 1 ? { value: (o.targets[0] as { value: unknown }).value } : { strategy: o.strategy, targets: o.targets }, [o]);
  const [open, setOpen] = useState(false);
  const [binding, setBinding] = useState(JSON.stringify(current, null, 2));
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState("");
  const first = (o.targets[0] as { value: unknown } | undefined)?.value;
  const shapes: Array<[string, unknown]> = [
    ["Current", current],
    ["Canary 10% (edit the canary target)", { strategy: "weighted", targets: [{ value: first, weight: 90, label: "stable" }, { value: first, weight: 10, label: "canary" }] }],
    ["Failover (edit the primary)", { strategy: "failover", targets: [{ value: first, label: "primary" }, { value: first, label: "fallback" }] }],
  ];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(binding);
    } catch {
      app.report(new Error("The binding is not valid JSON."));
      return;
    }
    const change = await attempt(app, () => propose({ ref: o.ref, basedOnRevision: o.revision, binding: parsed, reason, ...(ttl ? { ttlSeconds: Number(ttl) } : {}) }), "Proposed. Nothing changes until it is validated, approved and executed.");
    if (change) go(`changes/${change.id}`);
  };
  return (
    <Card title="Propose a change" subtitle={`Based on revision ${o.revision}. If the reference moves before execution, Resolver refuses the write and the change is superseded.`} actions={<button className="btn small" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Change what this resolves to"}</button>}>
      {open && (
        <form className="form" onSubmit={submit}>
          <div className="wide shapes">{shapes.map(([label, value]) => <button type="button" key={label} className="btn small ghost" onClick={() => setBinding(JSON.stringify(value, null, 2))}>{label}</button>)}</div>
          <label className="wide">New binding (JSON)<textarea rows={10} value={binding} onChange={(e) => setBinding(e.target.value)} spellCheck={false} /></label>
          <label className="wide">Why<input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required placeholder="The reason approvers will read, recorded in Resolver's history too" /></label>
          <label>Cache TTL seconds (optional)<input type="number" min={0} max={86400} value={ttl} onChange={(e) => setTtl(e.target.value)} /></label>
          <div className="form-actions"><button className="btn primary">Propose</button></div>
        </form>
      )}
    </Card>
  );
}

function PromoteButton({ from, to }: { from: string; to: string }) {
  const app = useApp();
  const promote = useMutation(api.changes.proposePromotion);
  return (
    <button className="btn small ghost" onClick={async () => {
      const reason = window.prompt(`Why give ${to} the binding of ${from}?`);
      if (!reason) return;
      const change = await attempt(app, () => promote({ from, toEnvironment: to, reason }));
      if (change) go(`changes/${change.id}`);
    }}>Propose using this here</button>
  );
}

function HistoryCard({ refName, observation: o }: { refName: string; observation: Observation }) {
  const app = useApp();
  const rollback = useMutation(api.changes.proposeRollback);
  return (
    <Card title={<>Resolver history <Basis kind="observed" /></>} subtitle={`The ${o.history.length} newest revisions, as Resolver recorded them. History is never edited here.`}>
      <table className="table compact">
        <thead><tr><th>Rev</th><th>Action</th><th>Binding</th><th>By</th><th>Reason</th><th>When</th><th /></tr></thead>
        <tbody>
          {o.history.map((h) => {
            const ours = (h.reason ?? "").includes("[resolver-control CHG-");
            return (
              <tr key={h.revision}>
                <td className="num">{h.revision}{h.revision === o.revision && <> <Badge status="ok" label="current" /></>}</td>
                <td>{h.action}{h.restoredFrom ? ` of r${h.restoredFrom}` : ""}</td>
                <td className="summary small">{h.targets ? <details><summary>{h.strategy ?? "single"}, {h.targets.length} target(s)</summary><Json value={h.targets} /></details> : "—"}</td>
                <td className="small"><Actor id={h.actor} /></td>
                <td className="small">{ours ? <Badge status="ok" label="governed" /> : h.action !== "create" && <Badge status="warning" label="direct" />} {h.reason}</td>
                <td className="small muted">{new Date(h.at).toLocaleString()}</td>
                <td>{h.revision < o.revision && h.targets && h.action !== "revoke" && can(app.permissions, "changes.propose") && (
                  <button className="btn small ghost" onClick={async () => {
                    const reason = window.prompt(`Why restore revision ${h.revision} of ${refName}?`);
                    if (!reason) return;
                    const change = await attempt(app, () => rollback({ ref: refName, toRevision: h.revision, basedOnRevision: o.revision, reason }));
                    if (change) go(`changes/${change.id}`);
                  }}>Propose rollback</button>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
