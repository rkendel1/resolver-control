import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Badge, Basis, Card, Empty, Live, PageHead, Ref } from "../ui";

export function Insights() {
  const findings = useQueryState(api.insights.findings, {});
  return (
    <>
      <PageHead title="Insights">Findings computed by deterministic rules from what Resolver reports and what people declared. No model is involved; each finding names its basis. Where data does not exist (consumers, health), the finding says so instead of estimating.</PageHead>
      <Live state={findings}>
        {(rows) => (
          <Card>
            {rows.length === 0 ? <Empty>No findings.</Empty> : (
              <table className="table">
                <thead><tr><th>Severity</th><th>Finding</th><th>Basis</th><th>Where</th></tr></thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id}>
                      <td><Badge status={f.severity} /></td>
                      <td><strong>{f.title}</strong><div className="muted small">{f.detail}</div></td>
                      <td><Basis kind={f.basis} /></td>
                      <td>{f.ref && <Ref value={f.ref} />}{f.changeId && <a href={`#/changes/${f.changeId}`}>change</a>}</td>
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
