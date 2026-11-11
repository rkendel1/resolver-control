import { useQueryState } from "@feltdb/feltkit/react";
import { ActivityTimeline } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, Card, EVENT_LABEL, Json, Live, PageHead, Ref } from "../ui";

export function Activity() {
  const events = useQueryState(api.activity.list, { limit: 300 });
  return (
    <>
      <PageHead title="Activity">The append-only audit trail (FeltKit app.auditTrail). Each entry was written in the same transaction as the change it describes, and names the AppPort request that caused it.</PageHead>
      <Live state={events} what="activity">
        {(rows) => (
          <Card>
            <ActivityTimeline
              label="Activity"
              emptyTitle="Nothing recorded yet"
              hasMore={rows.length >= 300}
              items={rows.map((e) => ({
                id: e.id,
                at: e.at,
                actor: <Actor id={e.actor} type={e.actorType} />,
                summary: (
                  <span className={e.type === "resolver.change.out_of_band" ? "out-of-band" : undefined}>
                    {EVENT_LABEL[e.type] ?? e.type} {e.subjectType === "dependency" ? <Ref value={e.subjectId} /> : e.subjectType === "change" ? <a href={`#/changes/${e.subjectId}`}>change</a> : <span className="small muted">{e.subjectType}</span>}
                  </span>
                ),
                detail: <><code title="AppPort request id">{e.requestId}</code>{e.data && Object.keys(e.data).length > 0 && <details><summary>details</summary><Json value={e.data} /></details>}</>,
              }))}
            />
          </Card>
        )}
      </Live>
    </>
  );
}
