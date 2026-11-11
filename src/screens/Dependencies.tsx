import { useMemo, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { ActivityTimeline, Button, DataTable, FilterBar, Form, FreshnessLabel, MetadataList, Select, TextField } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { askReason, attempt, Actor, Basis, can, Card, Empty, EVENT_LABEL, go, Json, Live, PageHead, Ref, State, useApp, when } from "../ui";

const CATEGORIES = ["ai", "search", "email", "communications", "payments", "identity", "storage", "analytics", "data", "processing", "integrations", "operations", "credentials", "configuration", "agents", "other"];

export function Dependencies() {
  const app = useApp();
  const inventory = useQueryState(api.catalog.inventory, {});
  const [filters, setFilters] = useState<Record<string, string>>({ q: "", env: "", kind: "", governance: "" });
  const [creating, setCreating] = useState(false);
  const set = (id: string, value: string) => setFilters((f) => ({ ...f, [id]: value }));
  return (
    <>
      <PageHead title="Dependencies" actions={can(app.permissions, "changes.propose") && <Button label={creating ? "Close" : "Introduce a reference"} variant="secondary" onClick={() => setCreating((v) => !v)} />}>
        Everything your applications resolve through Resolver, joined with what people know about it. <Basis kind="observed" /> columns come from Resolver; <Basis kind="declared" /> ones from people and consumers.
      </PageHead>
      {creating && <IntroduceForm onDone={() => setCreating(false)} />}
      <Live state={inventory} what="dependencies">
        {(rows) => {
          const envs = [...new Set(rows.map((r) => r.environment))].sort();
          const kinds = [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort() as string[];
          const q = filters["q"]!.trim().toLowerCase();
          const shown = rows.filter(
            (r) =>
              (!filters["env"] || r.environment === filters["env"]) &&
              (!filters["kind"] || r.kind === filters["kind"]) &&
              (!filters["governance"] || r.governance === filters["governance"]) &&
              (!q || [r.ref, r.title, r.owner, r.summary, r.category].some((v) => v?.toLowerCase().includes(q))),
          );
          const applied = Object.values(filters).filter(Boolean).length;
          return (
            <Card>
              <FilterBar
                live
                label="Filter dependencies"
                applied={applied}
                result={`${shown.length} of ${rows.length} references`}
                onChange={set}
                onClear={() => setFilters({ q: "", env: "", kind: "", governance: "" })}
                filters={[
                  { id: "q", label: "Search", value: filters["q"]!, placeholder: "Refs, titles, owners, targets" },
                  { id: "env", label: "Environment", type: "select", value: filters["env"]!, options: [{ value: "", label: "All" }, ...envs] },
                  { id: "kind", label: "Kind", type: "select", value: filters["kind"]!, options: [{ value: "", label: "All" }, ...kinds] },
                  { id: "governance", label: "Governance", type: "select", value: filters["governance"]!, options: [{ value: "", label: "Any" }, { value: "governed", label: "Governed" }, { value: "unregistered", label: "Unregistered" }, { value: "not_in_resolver", label: "Not in Resolver" }, { value: "not_visible", label: "Not visible" }] },
                ]}
              />
              <DataTable
                label="Dependencies"
                noMatch={rows.length > 0 && shown.length === 0}
                noMatchTitle="No reference matches these filters"
                emptyTitle="No references yet"
                emptyBody="Once the resolver component observes Resolver, every reference the executor key may read appears here."
                columns={[
                  { id: "ref", header: "Reference" },
                  { id: "summary", header: <>Resolves to <Basis kind="observed" /></> },
                  { id: "rev", header: "Rev", align: "end" },
                  { id: "owner", header: <>Owner · criticality <Basis kind="declared" /></> },
                  { id: "class", header: "Change class" },
                  { id: "consumers", header: "Consumers", align: "end" },
                  { id: "status", header: "Status" },
                ]}
                rows={shown.map((r) => ({
                  key: r.ref,
                  onSelect: () => go(`dependencies/${encodeURIComponent(r.ref)}`),
                  cells: {
                    ref: <><Ref value={r.ref} link={false} {...(r.kind ? { kind: r.kind } : {})} />{r.title && <div className="small muted">{r.title}</div>}</>,
                    summary: r.summary ? <span className="summary">{r.summary}{r.state === "revoked" && <> <State field="resolver.reference.state" value="revoked" /></>}</span> : <span className="muted">not observed</span>,
                    rev: r.revision ?? null,
                    owner: <>{r.owner ?? <span className="muted">no owner</span>}{r.criticality && <> · <State field="resolver-control.dependency.criticality" value={r.criticality} /></>}</>,
                    class: r.changeClass ? <State field="resolver-control.dependency.change_class" value={r.changeClass} /> : null,
                    consumers: r.consumers,
                    status: <><State field="resolver-control.dependency.governance" value={r.governance} />{r.openChange && <div><a href={`#/changes/${r.openChange.id}`} onClick={(e) => e.stopPropagation()}>CHG-{r.openChange.number}</a></div>}</>,
                  },
                }))}
              />
            </Card>
          );
        }}
      </Live>
    </>
  );
}

function parse(app: ReturnType<typeof useApp>, text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    app.report(new Error("The binding is not valid JSON."));
    return { ok: false };
  }
}

const TEMPLATES: Record<string, string> = {
  endpoint: '{ "value": { "url": "https://" } }',
  model: '{ "value": { "provider": "", "model": "", "credential": "ref://<env>/llm/<key>" } }',
  value: '{ "value": {} }',
  agent: '{ "value": { "origin": "https://" } }',
};

function IntroduceForm({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const create = useMutation(api.changes.proposeCreate);
  const [ref, setRef] = useState("ref://staging/");
  const [kind, setKind] = useState<"value" | "model" | "endpoint" | "agent">("endpoint");
  const [binding, setBinding] = useState(TEMPLATES["endpoint"]!);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Introduce a runtime reference" subtitle="Turns an embedded choice into an explicit, governed reference. The consumer still has to resolve it in code once.">
      <Form
        label="Introduce a runtime reference"
        submitLabel="Propose"
        busy={busy}
        onSubmit={async () => {
          const parsed = parse(app, binding);
          if (!parsed.ok) return;
          setBusy(true);
          const change = await attempt(app, () => create({ ref, kind, binding: parsed.value, reason }), "Proposed. The resolver component validates it next.");
          setBusy(false);
          if (change) {
            onDone();
            go(`changes/${change.id}`);
          }
        }}
        actions={<Button label="Cancel" variant="ghost" onClick={onDone} />}
      >
        <TextField name="reference" label="Reference" value={ref} onChange={setRef} required />
        <Select name="kind" label="Kind" value={kind} options={["endpoint", "model", "value", "agent"]} onChange={(k) => { setKind(k as typeof kind); setBinding(TEMPLATES[k]!); }} />
        <TextField name="binding" label="Binding" hint="JSON: { value } or { strategy, targets }" multiline rows={5} spellcheck="false" value={binding} onChange={setBinding} required />
        <TextField name="why" label="Why" hint="What this makes possible" value={reason} onChange={setReason} minlength={3} required />
      </Form>
    </Card>
  );
}

type Detail = NonNullable<ReturnType<typeof useQueryState<typeof api.catalog.detail>>["data"]>;
type Observation = NonNullable<Detail["observation"]>;

export function DependencyDetail({ refName }: { refName: string }) {
  const app = useApp();
  const detail = useQueryState(api.catalog.detail, { ref: refName });
  return (
    <Live state={detail} what="this dependency">
      {(d) => {
        const o = d.observation;
        const governance = !o ? "not_in_resolver" : !o.visible ? "not_visible" : d.dependency ? "governed" : "unregistered";
        return (
          <>
            <PageHead
              title={d.ref}
              crumbs={[{ label: "Dependencies", href: "#/dependencies" }]}
              status={<State field="resolver-control.dependency.governance" value={governance} />}
            >
              {d.dependency?.title ?? "No description recorded."} {o && <span className="chip">{o.kind}</span>} {d.policy.protected && <span className="chip">protected environment</span>} {d.policy.frozen && <span className="chip chip-warn">frozen</span>}
            </PageHead>
            <div className="grid-2">
              <Card title={<>Current resolution <Basis kind="observed" /></>} subtitle={o ? <>Revision {o.revision} · <FreshnessLabel freshness="cached" asOf={o.observedAt} source="Resolver" /></> : undefined}>
                {!o ? (
                  <Empty title="Not observed in Resolver">It does not exist yet, or the executor key may not read it.</Empty>
                ) : (
                  <>
                    <p className="resolution">{d.summary}</p>
                    <MetadataList
                      items={[
                        { label: "Strategy", value: o.strategy ?? "single", mono: true },
                        { label: "State", value: <State field="resolver.reference.state" value={o.state} /> },
                        { label: "Changed in Resolver", value: new Date(o.updatedAt).toLocaleString() },
                        ...(o.ttlSeconds !== undefined ? [{ label: "Propagation", value: `live stream; at most ${o.ttlSeconds} s (TTL)` }] : []),
                      ]}
                    />
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
                {d.credentials.length === 0 && d.dependents.length === 0 ? <Empty title="No credential relationships" /> : (
                  <ul className="list">
                    {d.credentials.map((c) => (
                      <li key={c.ref}>Uses credential <Ref value={c.ref} /> {c.observed ? <>r{c.revision} <State field="resolver.reference.state" value={c.state ?? "unknown"} /></> : <span className="muted">not observed</span>}</li>
                    ))}
                    {d.dependents.map((m) => <li key={m.ref}>Credential of model <Ref value={m.ref} /> (r{m.revision})</li>)}
                  </ul>
                )}
                {o?.kind === "secret" && <p className="small muted">Secret material is never read by this application. Rotate or set it in Resolver; propose a rollback from its history below.</p>}
              </Card>
            </div>
            <div className="grid-2">
              <Card title="Other environments" subtitle="The same path elsewhere">
                <DataTable
                  label="The same path in other environments"
                  emptyTitle="This path exists in no other observed environment"
                  columns={[{ id: "ref", header: "Reference" }, { id: "summary", header: "Resolves to" }, { id: "same", header: "Compared" }, { id: "act", header: "" }]}
                  rows={d.counterparts.map((c) => ({
                    key: c.ref,
                    cells: {
                      ref: <Ref value={c.ref} />,
                      summary: <span className="summary">{c.summary}</span>,
                      same: <State field="resolver-control.comparison" value={c.same ? "same" : "differs"} />,
                      act: !c.same && o?.kind !== "secret" && can(app.permissions, "changes.propose") ? <PromoteButton from={c.ref} to={d.environment} /> : null,
                    },
                  }))}
                />
              </Card>
              <Card title="Changes">
                <DataTable
                  label="Changes to this reference"
                  emptyTitle="No change has been proposed here"
                  columns={[{ id: "n", header: "Change" }, { id: "what", header: "What" }, { id: "status", header: "Status" }, { id: "by", header: "Proposed" }]}
                  rows={d.changes.map((c) => ({
                    key: c.id,
                    onSelect: () => go(`changes/${c.id}`),
                    cells: { n: `CHG-${c.number}`, what: <>{c.operation}<div className="small muted">{c.reason}</div></>, status: <State field="resolver-control.change.status" value={c.status} />, by: <>{c.proposedBy}<div className="small muted">{when(c.proposedAt)}</div></> },
                  }))}
                />
              </Card>
            </div>
            {o && <HistoryCard refName={d.ref} observation={o} />}
            <Card title="Audit trail">
              <ActivityTimeline
                label="Audit trail"
                emptyTitle="Nothing recorded for this reference yet"
                items={d.events.map((e) => ({
                  id: e.id,
                  at: e.at,
                  actor: <Actor id={e.actor} type={e.actorType} />,
                  summary: EVENT_LABEL[e.type] ?? e.type,
                  detail: <><code title="AppPort request id">{e.requestId}</code>{e.data && Object.keys(e.data).length > 0 && <details><summary>details</summary><Json value={e.data} /></details>}</>,
                }))}
              />
            </Card>
          </>
        );
      }}
    </Live>
  );
}

function DescribeCard({ d }: { d: Detail }) {
  const app = useApp();
  const register = useMutation(api.catalog.register);
  const [editing, setEditing] = useState(false);
  const dep = d.dependency;
  const [form, setForm] = useState({ title: dep?.title ?? "", category: dep?.category ?? "other", owner: dep?.owner ?? "", criticality: dep?.criticality ?? "medium", changeClass: dep?.changeClass ?? "unknown", contract: dep?.contract ?? "", changeClassNote: dep?.changeClassNote ?? "" });
  const set = (k: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [k]: value }));
  return (
    <Card title={<>What is known <Basis kind="declared" /></>} actions={can(app.permissions, "catalog.write") && <Button label={editing ? "Cancel" : dep ? "Edit" : "Register"} size="sm" variant="secondary" onClick={() => setEditing((v) => !v)} />}>
      {editing ? (
        <Form
          label="What is known about this dependency"
          submitLabel="Save"
          onSubmit={async () => {
            const ok = await attempt(app, () => register({ ref: d.ref, title: form.title, category: form.category as never, criticality: form.criticality as never, changeClass: form.changeClass as never, ...(form.owner ? { owner: form.owner } : {}), ...(form.contract ? { contract: form.contract } : {}), ...(form.changeClassNote ? { changeClassNote: form.changeClassNote } : {}) }), "Recorded.");
            if (ok) setEditing(false);
          }}
        >
          <TextField name="title" label="Title" value={form.title} onChange={set("title")} required />
          <TextField name="owner" label="Owner" hint="A team or a person" value={form.owner} onChange={set("owner")} />
          <Select name="category" label="Category" value={form.category} options={CATEGORIES} onChange={set("category")} />
          <Select name="criticality" label="Criticality" value={form.criticality} options={["low", "medium", "high", "critical"]} onChange={set("criticality")} />
          <Select name="change-class"
            label="Change class"
            value={form.changeClass}
            onChange={set("changeClass")}
            options={[
              { value: "runtime", label: "Runtime: compatible implementations, switch in Resolver" },
              { value: "adapter", label: "Adapter: consumers need an adapter first" },
              { value: "migration", label: "Migration: data or contract migration" },
              { value: "unknown", label: "Unknown: not assessed" },
            ]}
          />
          <TextField name="contract-consumers-rely-on" label="Contract consumers rely on" hint="e.g. OpenAI-compatible chat completions" value={form.contract} onChange={set("contract")} />
          <TextField name="why-this-change-class" label="Why this change class" value={form.changeClassNote} onChange={set("changeClassNote")} />
        </Form>
      ) : !dep ? (
        <Empty title="Not described">Nobody has recorded what this is, who owns it, how critical it is, or what changing it takes.</Empty>
      ) : (
        <MetadataList
          items={[
            { label: "Owner", value: dep.owner ?? null },
            { label: "Category", value: dep.category },
            { label: "Criticality", value: <State field="resolver-control.dependency.criticality" value={dep.criticality} /> },
            { label: "Change class", value: <State field="resolver-control.dependency.change_class" value={dep.changeClass} />, ...(dep.changeClassNote ? { hint: dep.changeClassNote } : {}) },
            ...(dep.contract ? [{ label: "Contract", value: dep.contract }] : []),
            { label: "Recorded", value: `by ${dep.updatedBy} ${when(dep.updatedAt)}` },
          ]}
        />
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
      {consumers.length === 0 ? <Empty title="No consumer declared">The blast radius of a change is unknown.</Empty> : (
        <ul className="list">
          {consumers.map((c) => (
            <li key={c.id}>
              <strong>{c.application}</strong> {c.usage && <span className="muted">— {c.usage}</span>}
              <div className="small muted">
                {c.source === "declared_by_consumer" ? "declared by the application itself" : `declared by ${c.declaredBy}`} · {when(c.declaredAt)}{" "}
                {can(app.permissions, "consumers.write") && <Button label="Remove" variant="ghost" size="sm" onClick={() => void attempt(app, () => remove({ id: c.id }))} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {can(app.permissions, "consumers.write") && (
        <Form
          layout="inline"
          label="Declare a consumer"
          submitLabel="Declare"
          submitVariant="secondary"
          onSubmit={async () => {
            if (await attempt(app, () => declare({ ref: refName, application, ...(usage ? { usage } : {}) }))) {
              setApplication("");
              setUsage("");
            }
          }}
        >
          <TextField name="application" label="Application" value={application} onChange={setApplication} required />
          <TextField name="what-it-uses-it-for" label="What it uses it for" value={usage} onChange={setUsage} />
        </Form>
      )}
    </Card>
  );
}

function ProposeCard({ observation: o }: { observation: Observation }) {
  const app = useApp();
  const propose = useMutation(api.changes.proposeRetarget);
  const current = useMemo(() => ((o.strategy ?? "single") === "single" && o.targets.length === 1 ? { value: (o.targets[0] as { value: unknown }).value } : { strategy: o.strategy, targets: o.targets }), [o]);
  const [open, setOpen] = useState(false);
  const [binding, setBinding] = useState(JSON.stringify(current, null, 2));
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const first = (o.targets[0] as { value: unknown } | undefined)?.value;
  const shapes: Array<[string, unknown]> = [
    ["Current", current],
    ["Canary 10%", { strategy: "weighted", targets: [{ value: first, weight: 90, label: "stable" }, { value: first, weight: 10, label: "canary" }] }],
    ["Failover", { strategy: "failover", targets: [{ value: first, label: "primary" }, { value: first, label: "fallback" }] }],
  ];
  return (
    <Card
      title="Propose a change"
      subtitle={`Based on revision ${o.revision}. If the reference moves before execution, Resolver refuses the write and the change is superseded.`}
      actions={<Button label={open ? "Close" : "Change what this resolves to"} size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} />}
    >
      {open && (
        <>
          <div className="shapes" role="group" aria-label="Start from">
            {shapes.map(([label, value]) => <Button key={label} label={label} size="sm" variant="ghost" onClick={() => setBinding(JSON.stringify(value, null, 2))} />)}
          </div>
          <Form
            label="Propose a change"
            submitLabel="Propose"
            busy={busy}
            onSubmit={async () => {
              const parsed = parse(app, binding);
              if (!parsed.ok) return;
              setBusy(true);
              const change = await attempt(app, () => propose({ ref: o.ref, basedOnRevision: o.revision, binding: parsed.value, reason, ...(ttl ? { ttlSeconds: Number(ttl) } : {}) }), "Proposed. Nothing changes until it is validated, approved and executed.");
              setBusy(false);
              if (change) go(`changes/${change.id}`);
            }}
          >
            <TextField name="new-binding" label="New binding" hint="JSON. Edit the canary or fallback target after choosing a shape." multiline rows={10} spellcheck="false" value={binding} onChange={setBinding} required />
            <TextField name="why" label="Why" hint="The reason approvers read; it is recorded in Resolver's history too" value={reason} onChange={setReason} minlength={3} required />
            <TextField name="cache-ttl-seconds" label="Cache TTL seconds" hint="Optional" type="number" min={0} max={86400} value={ttl} onChange={setTtl} />
          </Form>
        </>
      )}
    </Card>
  );
}

function PromoteButton({ from, to }: { from: string; to: string }) {
  const app = useApp();
  const promote = useMutation(api.changes.proposePromotion);
  return (
    <Button
      label="Propose using this here"
      size="sm"
      variant="ghost"
      onClick={async () => {
        const reason = await askReason(`Use ${from} in ${to}`, `Proposes giving the ${to} reference the binding ${from} has now. It is validated and approved like any change.`, "Propose");
        if (!reason) return;
        const change = await attempt(app, () => promote({ from, toEnvironment: to, reason }));
        if (change) go(`changes/${change.id}`);
      }}
    />
  );
}

function HistoryCard({ refName, observation: o }: { refName: string; observation: Observation }) {
  const app = useApp();
  const rollback = useMutation(api.changes.proposeRollback);
  return (
    <Card title={<>Resolver history <Basis kind="observed" /></>} subtitle={`The ${o.history.length} newest revisions, as Resolver recorded them. History is never edited here.`}>
      <DataTable
        label="Resolver history"
        columns={[{ id: "rev", header: "Rev", align: "end" }, { id: "action", header: "Action" }, { id: "binding", header: "Binding" }, { id: "by", header: "By" }, { id: "reason", header: "Reason" }, { id: "at", header: "When" }, { id: "act", header: "" }]}
        rows={o.history.map((h) => {
          const ours = (h.reason ?? "").includes("[resolver-control CHG-");
          return {
            key: String(h.revision),
            cells: {
              rev: <>{h.revision}{h.revision === o.revision && <div className="small muted">current</div>}</>,
              action: `${h.action}${h.restoredFrom ? ` of r${h.restoredFrom}` : ""}`,
              binding: h.targets ? <details><summary>{h.strategy ?? "single"}, {h.targets.length} target(s)</summary><Json value={h.targets} /></details> : null,
              by: <Actor id={h.actor} />,
              reason: <>{ours ? <span className="chip">governed</span> : h.action !== "create" && <span className="chip chip-warn">direct</span>} {h.reason}</>,
              at: new Date(h.at).toLocaleString(),
              act:
                h.revision < o.revision && h.targets && h.action !== "revoke" && can(app.permissions, "changes.propose") ? (
                  <Button
                    label="Propose rollback"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const reason = await askReason(`Restore revision ${h.revision}`, `Proposes restoring the binding ${refName} had at revision ${h.revision}, exactly as Resolver recorded it. It is a new change with its own approval; history is kept.`, "Propose rollback");
                      if (!reason) return;
                      const change = await attempt(app, () => rollback({ ref: refName, toRevision: h.revision, basedOnRevision: o.revision, reason }));
                      if (change) go(`changes/${change.id}`);
                    }}
                  />
                ) : null,
            },
          };
        })}
      />
    </Card>
  );
}
