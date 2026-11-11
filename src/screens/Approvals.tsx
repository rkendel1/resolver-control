import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Card, Live, PageHead } from "../ui";
import { ChangeTable } from "./Changes";

export function Approvals() {
  const ready = useQueryState(api.changes.list, { status: "ready" });
  const approved = useQueryState(api.changes.list, { status: "approved" });
  const unknown = useQueryState(api.changes.list, { status: "unknown" });
  return (
    <>
      <PageHead title="Approvals">Validated changes waiting for people. Only a person may approve, never the proposer, never twice; protected environments need a production approver.</PageHead>
      <Card title="Awaiting approval"><Live state={ready} what="changes awaiting approval">{(rows) => <ChangeTable label="Awaiting approval" rows={rows} emptyTitle="Nothing awaits a decision" />}</Live></Card>
      <Card title="Approved, not yet executed" subtitle="The resolver component executes these on its next pass, unless the environment is frozen."><Live state={approved} what="approved changes">{(rows) => <ChangeTable label="Approved, not yet executed" rows={rows} emptyTitle="None" />}</Live></Card>
      <Card title="Outcome unknown" subtitle="Resolver did not answer. The component reconciles these from Resolver's history; if one stays here, look at it."><Live state={unknown} what="unsettled changes">{(rows) => <ChangeTable label="Outcome unknown" rows={rows} emptyTitle="None" />}</Live></Card>
    </>
  );
}
