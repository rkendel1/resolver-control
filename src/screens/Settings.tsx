import { useEffect, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { Button, Form, MetadataList, TextField } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, can, Card, exact, Live, PageHead, State, useApp } from "../ui";

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
  const writable = can(app.permissions, "settings.write");
  return (
    <>
      <PageHead title="Settings" />
      <Live state={state} what="settings">
        {({ settings, sync }) => (
          <>
            <Card title="Resolver" subtitle="Where the resolver component connects, and which reference namespaces (environments) it manages.">
              {writable ? (
                <Form
                  label="Resolver connection"
                  submitLabel="Save"
                  onSubmit={() => void attempt(app, () => save({ resolverUrl: url, namespaces: namespaces.split(/[\s,]+/).filter(Boolean), syncIntervalSeconds: Number(interval) }), "Saved. The resolver component uses it on its next pass.")}
                >
                  <TextField name="resolver-origin" label="Resolver origin" placeholder="https://resolver.internal.example.com" value={url} onChange={setUrl} required />
                  <TextField name="environments-namespaces" label="Environments (namespaces)" hint="Comma-separated" value={namespaces} onChange={setNamespaces} required />
                  <TextField name="sync-interval-seconds" label="Sync interval (seconds)" type="number" min={1} max={3600} value={interval} onChange={setInterval_} />
                </Form>
              ) : (
                <MetadataList
                  items={[
                    { label: "Resolver origin", value: settings?.resolverUrl ?? null, mono: true },
                    { label: "Environments", value: settings?.namespaces.join(", ") ?? null },
                    { label: "Sync interval", value: settings ? `${settings.syncIntervalSeconds} s` : null },
                  ]}
                />
              )}
              {settings && <p className="small muted">Last changed by {settings.updatedBy} {exact(settings.updatedAt)}.</p>}
            </Card>
            <Card title="Resolver component" subtitle="The only part of this application that talks to Resolver, and the only holder of its API key.">
              <MetadataList
                items={[
                  { label: "Last report", value: sync ? <><State field="resolver-control.sync.state" value={sync.state} detail={`${exact(sync.at)} · ${sync.references} references`} />{sync.detail && <div className="small">{sync.detail}</div>}</> : "None yet" },
                  { label: "API key", value: <>The component credential <code>resolver-api-key</code>: <code>FELTKIT_CREDENTIAL_RESOLVER_API_KEY</code> under FeltKit, or the host's secret file under AppBoundry. It is never stored in this application's data and never shown here.</> },
                  { label: "Key's grants", value: <>Create it in Resolver with <code>read</code> on every managed namespace and <code>write</code> only where this application may execute changes, e.g. <code>resolver keys create resolver-control --grant read,write:ref://staging/* --grant read,write:ref://prod/*</code>. Resolver enforces them on every write.</> },
                ]}
              />
            </Card>
            {can(app.permissions, "demo.seed") && (
              <Card title="Demo" subtitle="Governance metadata for the references scripts/demo.mjs creates in a real Resolver. Does not touch Resolver.">
                <Button label="Load demo policies, owners and consumers" variant="secondary" onClick={() => void attempt(app, () => seed({}), "Demo metadata recorded.")} />
              </Card>
            )}
          </>
        )}
      </Live>
    </>
  );
}
