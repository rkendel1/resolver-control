import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { Button, DataTable, Tabs, TabPanel } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { askReason, attempt, can, Card, Live, PageHead, State, useApp, when } from "../ui";

export function Discovery() {
  const app = useApp();
  const [status, setStatus] = useState<"open" | "adopted" | "dismissed">("open");
  const list = useQueryState(api.discovery.list, { status });
  const resolve = useMutation(api.discovery.resolve);
  return (
    <>
      <PageHead title="Discovery">Operational decisions still embedded in code (a model id, a provider URL, an API host read from the environment) that could become explicit runtime references. Found by the deterministic scanner (<code>npm run discover -- &lt;repo&gt;</code>), a person, or an agent. A candidate is a suggestion: adopting it records the decision; the consumer still has to resolve the reference in code once, and only compatible implementations can be swapped at run time.</PageHead>
      <Tabs label="Candidates by status" idPrefix="discovery" panelId="discovery-panel" active={status} onSelect={(id) => setStatus(id as typeof status)} tabs={[{ id: "open", label: "Open" }, { id: "adopted", label: "Adopted" }, { id: "dismissed", label: "Dismissed" }]} />
      <TabPanel id="discovery-panel" idPrefix="discovery" active={status}>
        <Live state={list} what="candidates">
          {(rows) => (
            <Card>
              <DataTable
                label="Candidates"
                emptyTitle={status === "open" ? "No open candidates" : "None"}
                {...(status === "open" ? { emptyBody: "Run the scanner on a repository to find some." } : {})}
                columns={[{ id: "where", header: "Where" }, { id: "found", header: "Found" }, { id: "ref", header: "Suggested reference" }, { id: "why", header: "Why" }, { id: "act", header: "" }]}
                rows={rows.map((c) => ({
                  key: c.id,
                  cells: {
                    where: <><code className="small">{c.repository}:{c.location}</code><div className="small muted">{c.source} · {c.submittedBy} · {when(c.submittedAt)}</div></>,
                    found: <><span className="chip">{c.category}</span> <code className="small">{c.excerpt}</code><div className="small muted">pattern: {c.pattern}</div></>,
                    ref: <>{c.resolution?.ref ?? c.suggestedRef ?? null} <span className="small muted">({c.suggestedKind})</span>{c.status !== "open" && <div><State field="resolver-control.candidate.status" value={c.status} /></div>}</>,
                    why: <span className="small">{c.rationale}{c.resolution?.note && <span className="muted"> Note: {c.resolution.note}</span>}</span>,
                    act:
                      c.status === "open" && can(app.permissions, "discovery.write") ? (
                        <div className="btn-row">
                          <Button
                            label="Adopt"
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              const ref = await askReason("Adopt as a reference", "Names the reference this decision becomes. Introduce it from Dependencies when ready.", "Adopt", c.suggestedRef ?? "ref://");
                              if (ref) void attempt(app, () => resolve({ id: c.id, status: "adopted", ref }), "Adopted.");
                            }}
                          />
                          <Button
                            label="Dismiss"
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const note = await askReason("Dismiss the candidate", "Say why this should stay where it is (e.g. platform infrastructure, not an operational choice).", "Dismiss");
                              if (note) void attempt(app, () => resolve({ id: c.id, status: "dismissed", note }));
                            }}
                          />
                        </div>
                      ) : null,
                  },
                }))}
              />
            </Card>
          )}
        </Live>
      </TabPanel>
    </>
  );
}
