import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Badge, can, Card, exact, Live, PageHead, useApp } from "../ui";

export function Settings() {
  const app = useApp();
  const state = useQueryState(api.settings.get, {});
  const save = useMutation(api.settings.set);
  const seed = useMutation(api.demo.seed);
  const [url, setUrl] = useState("");
  const [namespaces, setNamespaces] = useState("dev, staging, prod");
  const [interval, setInterval_] = useState("5");
  useEffect(() => {
    if (state.data?.settings) {
      setUrl(state.data.settings.resolverUrl);
      setNamespaces(state.data.settings.namespaces.join(", "));
      setInterval_(String(state.data.settings.syncIntervalSeconds));
    }
  }, [state.data?.settings]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(app, () => save({ resolverUrl: url, namespaces: namespaces.split(/[\s,]+/).filter(Boolean), syncIntervalSeconds: Number(interval) }), "Saved. The resolver component uses it on its next pass.");
  };
  const writable = can(app.permissions, "settings.write");
  return (
    <>
      <PageHead title="Settings" />
      <Live state={state}>
        {({ settings, sync }) => (
          <>
            <Card title="Resolver" subtitle="Where the resolver component connects, and which reference namespaces (environments) it manages.">
              <form className="form" onSubmit={submit}>
                <label>Resolver origin<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://resolver.internal.example.com" disabled={!writable} required /></label>
                <label>Environments (namespaces)<input value={namespaces} onChange={(e) => setNamespaces(e.target.value)} disabled={!writable} required /></label>
                <label>Sync interval (seconds)<input type="number" min={1} max={3600} value={interval} onChange={(e) => setInterval_(e.target.value)} disabled={!writable} /></label>
                {writable && <div className="form-actions"><button className="btn primary">Save</button></div>}
              </form>
              {settings && <p className="muted small">Last changed by {settings.updatedBy} {exact(settings.updatedAt)}.</p>}
            </Card>
            <Card title="Resolver component" subtitle="The only part of this application that talks to Resolver, and the only holder of its API key.">
              <dl className="facts">
                <dt>Last report</dt><dd>{sync ? <><Badge status={sync.state} /> {exact(sync.at)} · {sync.references} references{sync.detail && <div className="small">{sync.detail}</div>}</> : "none yet"}</dd>
                <dt>API key</dt><dd>The component credential <code>resolver-api-key</code>: <code>FELTKIT_CREDENTIAL_RESOLVER_API_KEY</code> under FeltKit, or the host's secret file under AppBoundry. It is never stored in this application's data and never shown here.</dd>
                <dt>Key's grants</dt><dd>Create it in Resolver with <code>read</code> on every managed namespace and <code>write</code> only where this application may execute changes, e.g. <code>resolver keys create resolver-control --grant read,write:ref://staging/* --grant read,write:ref://prod/*</code>. Resolver enforces them on every write.</dd>
              </dl>
            </Card>
            {can(app.permissions, "demo.seed") && (
              <Card title="Demo" subtitle="Governance metadata for the references scripts/demo.mjs creates in a real Resolver. Does not touch Resolver.">
                <button className="btn" onClick={() => attempt(app, () => seed({}), "Demo metadata recorded.")}>Load demo policies, owners and consumers</button>
              </Card>
            )}
          </>
        )}
      </Live>
    </>
  );
}
