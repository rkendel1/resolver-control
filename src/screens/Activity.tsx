import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, Card, Empty, EVENT_LABEL, exact, Json, Live, PageHead, Ref } from "../ui";

export function Activity() {
  const events = useQueryState(api.activity.list, { limit: 300 });
  return (
    <>
      <PageHead title="Activity">The append-only audit trail. Each entry was written in the same transaction as the change it describes, and names the AppPort request that caused it.</PageHead>
      <Live state={events}>
        {(rows) => (
          <Card>
            {rows.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
              <table className="table compact">
                <thead><tr><th>When</th><th>What</th><th>Subject</th><th>Who</th><th>Request</th></tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className={e.type === "resolver.change.out_of_band" ? "row-warn" : ""}>
                      <td className="small muted">{exact(e.at)}</td>
                      <td>{EVENT_LABEL[e.type] ?? e.type}{e.data && Object.keys(e.data).length > 0 && <details><summary className="small muted">details</summary><Json value={e.data} /></details>}</td>
                      <td>{e.ref ? <Ref value={e.ref} /> : e.subjectType === "change" ? <a href={`#/changes/${e.subjectId}`}>change</a> : <span className="muted small">{e.subjectType}</span>}</td>
                      <td className="small"><Actor id={e.actor} type={e.actorType} /></td>
                      <td><code className="small">{e.requestId}</code></td>
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
