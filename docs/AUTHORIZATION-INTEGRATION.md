# Governed execution: Resolver Control × Resolver 0.4.0

Status: **implemented and tested against the exact unpublished builds** of `@appport/resolver` 0.4.0,
`@appport/resolver-client` 0.3.0 and `@appport/resolver-core` 0.2.0. They are vendored in `vendor/` as `npm pack`
tarballs: sha256 `b8809d1e…`, `7bc76575…`, `f12a95d8…`, rebuilt from rkendel1/resolver `286183b` byte-identical. The
design below was committed before the code; [What was built](#what-was-built) records where the implementation
differs, and [Evidence](#evidence) what proves it. The packages are published (by their owner) only after this
application passes against these exact builds. It does now (see Evidence).

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

## What was built

| Part | Where |
|---|---|
| The signer: the decision rules above, claims derived from the record | `signer/core.ts` |
| The signer as a process: `POST /sign` (Bearer client token), `GET /key`, `GET /ready`; reads this application over HTTP with its own session; decision logs carry ids, never tokens; `--generate` makes a key pair | `signer/server.ts`, `npm run signer` |
| Role `signer` (`changes.read`, `activity.read`); `settings.signerUrl`; component credential `approval-signer-token` | `feltkit/app.ts`, `feltkit/settings.ts` |
| Execution with an authorization, the outcomes above, reconciliation by `governance.decision`, the verification check "Authorized for this change" | `component/engine.ts` |
| Issuance evidence (`execution.authorization`: jti and expiry, never the token; event `change.authorization_issued`) | `feltkit/changes.ts` `recordAuthorization` |
| Adoption per verified change for 24 h (`changes.adoption`, events `change.revision_fetched` / `change.revision_adopted`, once per consumer) | `changes.ts` `recordAdoption`, engine `#adoption` |
| Observed consumers per reference (every 30 s), in impact next to declared ones | `observations.ts` `recordConsumers`, `_rules.ts` `computeImpact` |
| Break-glass revisions surfaced as `resolver.change.break_glass` | `observations.ts` `upsert` |
| UI: authorization and signer refusals under Execution, an Adoption card with each stage's basis, observed consumers on the change and the dependency | `src/screens/Changes.tsx`, `Dependencies.tsx`, `Settings.tsx` |
| `npm run demo -- --governed --consumer`: prod under a policy (Resolver's operator CLI), the signer, a registered consumer | `scripts/demo.mjs` |

Where it differs from the design, or adds to it:

* **No signer token, no claim.** With `signerUrl` set and no `approval-signer-token`, approved changes wait and the
  tick reports why. Nothing is claimed or sent.
* **Backoff.** After `SIGNER_UNAVAILABLE`, a change is not claimed again for 10 s.
* **Claim age.** The signer refuses a claim older than 60 s (the lease).
* **Consumed authorization.** `resolver.authorization-consumed` from Resolver is treated like a stale write:
  settled from history.
* **This component is not a consumer.** Resolver records this component's own reads (synchronization,
  verification) as resolutions, and has no "who am I" (gap R9). So the component's live connection registers with
  Resolver as consumer `resolver-control` / `control-plane`. Its principal is learned from that registration (or
  from the actor on its own writes), kept in `syncStatus.principal`, and excluded from consumers and adoption.
  Found by the UI walkthrough, then covered by a test.
* **Fetched comes from resolutions, not notifications.** A live client's stream notification only invalidates its
  cache, and the fetch happens on the application's next `resolve`. Adoption reflects exactly that. "Not yet
  fetched" lists live registrations behind the revision.

## Evidence

`tests/governance.test.ts` runs against the real Resolver 0.4.0 enforcing a policy on `ref://prod/*` (in-process,
its own install), the real signer over HTTP, and the engine as the component principal. 20 tests, all pass.
`e2e/governed.test.mjs` runs every part as its own process: `resolver serve` with the policy and key set by
`resolver policy set` / `resolver signing-key add`; `feltkit dev` with the component; `signer/server.ts`; a
registered consumer. 1/1 passes.

| Scenario | Shown by | Result |
|---|---|---|
| Approved change → authorization → Resolver verifies and consumes it → verified, with the check "Authorized for this change"; Resolver's revision names jti, decision and approvers | governance test 1; e2e | pass |
| Governed rollback (revert) | governance 2 | pass |
| Signer configured, token missing: nothing claimed | governance 3 | pass |
| Signer refuses: out of scope; below its approval floor; not executing; wrong attempt; unauthenticated; unknown change. Extra request fields are ignored: the claims match the record | governance 4 (3 subtests) | pass; Resolver unchanged |
| Tampered record (approval without an audit event; approval event not by a person; self-approval) refused | governance 4 | pass; mutation check: dropping the audit cross-check fails it |
| Expired authorization (signer clock 10 min behind) | governance 5 | Resolver `authorization-invalid` (expired); failed; unchanged |
| Revoked signing key | governance 6 | Resolver `authorization-invalid`; failed; unchanged |
| Signer down, then back: requeued under the same approval, backoff, then attempt 2 executes once | governance 7 | pass; one write |
| Signer cannot read this application (503) | governance 8 | requeued, then verified |
| Concurrent approvals (two required) | governance 9 | approved once, both approvers in Resolver's record |
| Two executors at once | governance 10 | one revision, one authorization consumed |
| Stale revision (operator break-glass after approval) | governance 11 | superseded; break-glass surfaced |
| Lost answer after the governed write | governance 12 | reconciled by Resolver's governance record; verified with attempt 1's jti |
| Resolver unreachable after signing | governance 13 | requeued; attempt 3 re-signed and written; the jti of attempt 1 never consumed |
| Adoption: fetched (observed) ≠ notified; adopted (asserted) ≠ fetched; idle instance not yet fetched; this component excluded even before its first write | governance 14 | pass; mutation check: without self-exclusion it fails |
| Consumer facts survive a new revision | governance 15 | pass; mutation check: without the fix it fails |
| Signer core: attempt mismatch, expired claim, secret put not signable; `GET /key` matches the registered key | governance 16 | pass |
| Private key never in the application's output; tokens never in records, audit or signer logs | e2e; governance 1 | pass |
| The artifact declares `approval-signer-token`, and no signing key anywhere | `npm run test:artifact` | pass |

## Guarantees and limits

**Guaranteed (by Resolver, given the policy):**

* No write to a governed reference without an authorization from a trusted key, bound to the tenant, reference,
  operation, expected revision and binding digest, and consumed once with the revision.
* Operator break-glass is the only exception, and it is recorded.

**Guaranteed by this integration:**

* This application holds no signing key.
* The signer signs only a change that its record shows validated, approved by enough distinct people (none of them
  the proposer, each backed by a person's audit event), and being executed now by the executor. Every claim comes
  from that record.

**Not guaranteed:**

* **The signer trusts this application's records.** An administrator of this application's FeltDB could forge an
  approved change with matching audit events. Closing that needs approvals signed by the approvers' own keys. Not
  built.
* **One signer, no high availability.** An outage holds approved changes; nothing executes without it. Key
  rotation is Resolver's (retire, then add) plus a restart of the signer with the new key. Rotation was not
  exercised end to end here (Resolver's own tests cover retire/revoke semantics).
* **The signer runs from a checkout** (`node --import tsx`). It is not packaged or deployed anywhere; no AppBoundry
  or FeltKit target runs it.
* **Adoption is only as good as consumers' cooperation.** Unregistered consumers appear only once they resolve.
  `adopted` is what consumers report. `functionallyVerified` has no producer.
* **Not exercised:** multi-host FeltDB for Resolver, Resolver's MCP and management pages for governed writes (as
  stated for Resolver 0.4.0), and the AppBoundry companion on a real host (gap A1).
