# Governed execution: Resolver Control × Resolver 0.4.0

Status: **design, before implementation.** Integrates this application with Resolver's mutation policies and
observability (`@appport/resolver` 0.4.0, unpublished; its `docs/governance-guarantees.md`). The packages are
published only after this application passes its integration tests against these exact builds.

## Responsibilities stay where they are

| | Owns |
|---|---|
| **Resolver** | enforcement (policies, verification, consumption, break-glass) and runtime evidence (revisions, resolutions, usage, adoption) |
| **Resolver Control** | proposals, impact, approvals, execution workflow, the operator experience, and interpreting adoption |
| **The approval signer** (new, `signer/`) | the change-authorization signing key, and the rule that only an approved change is signed |

## The boundary: Resolver Control never holds the signing key

The component cannot hold it, because under FeltKit a component runs in the application's process and reads
credentials from its environment. A key there would let anyone who compromises the app, or obtains the executor
credential, mint authorizations for any reference and binding.

So signing happens in a **separate process with its own key custody**: the approval signer.

```
component (executor) ──"sign change <id>"──▶ signer ──reads change <id> as its own principal──▶ Resolver Control
       │                                        │      (changes.read, activity.read only)
       │◀──────────── authorization ────────────┘  checks the record, derives every claim from it, signs
       │
       └── put/rollback/revoke + authorization ──▶ Resolver (verifies locally, consumes with the revision)
```

The component sends **only a change id**. The signer refuses unless Resolver Control's record shows:

1. the change is `executing`, claimed by the executor, at the attempt the request names;
2. its validation passed;
3. it has at least `max(required approvals recorded now, SIGNER_MIN_APPROVALS)` approvals from distinct
   principals, none of them the proposer;
4. each approval is matched by a `change.approval_recorded` audit event whose actor is that approver and whose
   actor type is a person (`user`);
5. its reference is inside the signer's configured scope (patterns) and tenant.

Every signed claim (tenant, reference, operation, expected revision, the canonical digest of the binding, kind
and ttl, or the restored revision) is **derived from the record**, never taken from the request. The jti is
`<change id>.<attempt>`, so a re-request for the same attempt yields a token Resolver will consume at most once.
Validity is short (default 300 s, capped by the Resolver policy).

**What this protects:** a compromised component, or a leaked executor credential, can obtain authorizations only
for changes that people approved through Resolver Control's own access rules. The executor role cannot approve,
and approvals require a person.

**What it trusts:** Resolver Control's records as read through its API: its code and its database. An
administrator of that database could forge an approved record. Approvals signed by the approvers' own keys would
remove that trust; that is out of scope here.

## Execution

* **With a signer configured:**
  1. claim the change;
  2. request the authorization;
  3. write with it;
  4. verify by `governance.jti` in Resolver's history (authoritative), and keep the reason tag.
* **Signer refuses:** the change fails with the signer's reason. Nothing was sent to Resolver.
* **Signer unreachable:** the change is requeued under the same approval. Nothing was sent.
* **Resolver refuses the authorization** (expired, invalid): the change fails with Resolver's reason, and the
  reference is unchanged.
* **Lost answer:** reconciliation finds the write by `governance.jti` (or the tag): verified, consumed once.
* **Without a signer:** unchanged from today. Under a policy, the change fails safely
  (`resolver.authorization-required`).

## Adoption and impact

The component reads, per observed reference, `resolver.consumers.list`: declared, registered, resolved and used,
kept apart. For each recently verified change it reads `resolver.adoption`. Impact analysis shows **observed**
consumers next to declared ones. A change's page shows its stages: authorized, committed, available, fetched,
adopted, functionally verified (none yet). It never treats a notification as adoption.

## Tests across the component boundary (real Resolver 0.4.0, real signer, the engine)

* expired authorization
* signer refusals:
  * not approved
  * self-approval
  * approval not by a person
  * out of scope
  * attempt mismatch
* signer outage, then retry
* concurrent approvals
* two executors at once
* stale revision
* lost answer after the write
* Resolver unreachable after signing
* adoption across a real consumer process
