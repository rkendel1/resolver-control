import { useQueryState } from "@feltdb/feltkit/react";
import { DataTable } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { Basis, Card, Live, PageHead, Ref, State } from "../ui";

export function Insights() {
  const findings = useQueryState(api.insights.findings, {});
  return (
    <>
      <PageHead title="Insights">Findings computed by deterministic rules from what Resolver reports and what people declared. No model is involved; each finding names its basis. Where data does not exist (consumers, health), the finding says so instead of estimating.</PageHead>
      <Live state={findings} what="findings">
        {(rows) => (
          <Card>
            <DataTable
              label="Findings"
              emptyTitle="No findings"
              columns={[{ id: "sev", header: "Severity" }, { id: "finding", header: "Finding" }, { id: "basis", header: "Basis" }, { id: "where", header: "Where" }]}
              rows={rows.map((f) => ({
                key: f.id,
                cells: {
                  sev: <State field="resolver-control.finding.severity" value={f.severity} />,
                  finding: <><strong>{f.title}</strong><div className="small muted">{f.detail}</div></>,
                  basis: <Basis kind={f.basis} />,
                  where: <>{f.ref && <Ref value={f.ref} />}{f.changeId && <a href={`#/changes/${f.changeId}`}>change</a>}</>,
                },
              }))}
            />
          </Card>
        )}
      </Live>
    </>
  );
}
