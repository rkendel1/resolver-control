import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Badge, can, Card, Empty, Live, PageHead, useApp, when } from "../ui";

export function Discovery() {
  const app = useApp();
  const [status, setStatus] = useState<"open" | "adopted" | "dismissed">("open");
  const list = useQueryState(api.discovery.list, { status });
  const resolve = useMutation(api.discovery.resolve);
  return (
    <>
      <PageHead title="Discovery">Operational decisions still embedded in code (a model id, a provider URL, an API host read from the environment) that could become explicit runtime references. Found by the deterministic scanner (<code>npm run discover -- &lt;repo&gt;</code>), a person, or an agent. A candidate is a suggestion: adopting it records the decision; the consumer still has to resolve the reference in code once, and only compatible implementations can be swapped at run time.</PageHead>
      <div className="tabs">{(["open", "adopted", "dismissed"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{s}</button>)}</div>
      <Live state={list}>
        {(rows) => (
          <Card>
            {rows.length === 0 ? <Empty>{status === "open" ? "No open candidates. Run the scanner on a repository to find some." : "None."}</Empty> : (
              <table className="table">
                <thead><tr><th>Where</th><th>Found</th><th>Suggested reference</th><th>Why</th><th /></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td><code className="small">{c.repository}:{c.location}</code><div className="muted small">{c.source} · {c.submittedBy} · {when(c.submittedAt)}</div></td>
                      <td><Badge status="info" label={c.category} /> <code className="small">{c.excerpt}</code><div className="muted small">pattern: {c.pattern}</div></td>
                      <td>{c.resolution?.ref ?? c.suggestedRef ?? <span className="muted">—</span>} <span className="muted small">({c.suggestedKind})</span></td>
                      <td className="small">{c.rationale}{c.resolution?.note && <div className="muted">Note: {c.resolution.note}</div>}</td>
                      <td>{c.status === "open" && can(app.permissions, "discovery.write") && (
                        <div className="btn-row">
                          <button className="btn small" onClick={() => {
                            const ref = window.prompt("Adopt as which reference?", c.suggestedRef ?? "ref://");
                            if (ref) void attempt(app, () => resolve({ id: c.id, status: "adopted", ref }), "Adopted. Introduce the reference from Dependencies when ready.");
                          }}>Adopt</button>
                          <button className="btn small ghost" onClick={() => {
                            const note = window.prompt("Why dismiss it?");
                            if (note) void attempt(app, () => resolve({ id: c.id, status: "dismissed", note }));
                          }}>Dismiss</button>
                        </div>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </Live>
    </>
  );
}
