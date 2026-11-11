# Architecture and integration map

Resolver Control governs the runtime dependencies applications resolve through
[Resolver](https://www.npmjs.com/package/@appport/resolver) (`@appport/resolver` 0.3.3). It is a
FeltKit 0.3.24 application, buildable as an immutable AppBoundry artifact.

## The one rule: who owns what

| State | Authority | How this application touches it |
|---|---|---|
| What `ref://…` resolves to; revisions, history, rollback, grants, secret material, change notifications | **Resolver** | Read by the `resolver` component. Written **only** by that component, **only** for an approved change, **only** with a conditional write (`expectedRevision` = the revision the change was proposed against), with the change's correlation tag in Resolver's `reason`. |
| `observations`: what Resolver answered, at which revision, when | Resolver (projected) | A read-only projection for display and impact analysis. It is never the basis of a write: Resolver rejects a stale write. Each row carries `revision` and `observedAt`. |
| Owner, criticality, change class, contract (`dependencies`); declared consumers (`consumers`); `policies`; `changes` (proposal, impact, validation, approvals, execution, verification); `candidates`; `events` | **This application** (FeltDB) | FeltKit functions, transactional, each with an audit event in the same transaction. |
| The Resolver API key | Host secret store (FeltKit credential custody: `FELTKIT_CREDENTIAL_RESOLVER_API_KEY`; AppBoundry: the operator's secret file) | Declared by the component (`credentials: ["resolver-api-key"]`), read only by it, never written to state, logs or records. |
| Secret material | Resolver's vault | Never read. The executor key has no `reveal` grant. Rollbacks of a secret restore a custody pointer. |

There is no second store, second permission system or second vault.

## Components

```
 people (UI) ─┐                                           ┌──────────── Resolver (@appport/resolver) ───────────┐
 agents (MCP, │   AppPort capabilities, roles,            │ references · revisions · history · grants · vault   │
 AppPort) ────┤   authorize, audit                        │ resolver.list / history / resolve / put / rollback  │
 consumer apps┘          │                                └──────▲───────────────────────────────────▲──────────┘
                         ▼                                       │ executor key (read + write on       │ consumer keys
 ┌──────────── Resolver Control (one application) ──────────┐    │ managed namespaces; no reveal)     │ (read, reveal)
 │ guest: feltkit/*.ts  (WebAssembly in AppBoundry,          │    │                                    │
 │        network: none)                                     │    │                       running applications
 │   catalog · changes · policies · insights · discovery     │    │                       (resolver-client; never
 │   FeltDB: dependencies, consumers, observations, changes, │    │                        redeployed for a change)
 │           policies, candidates, events, settings          │    │
 │        ▲ ctx.call(..) as component:resolver (executor)    │    │
 │ component: component/*.ts (Node, network: egress) ────────┼────┘
 │   observe → supersede stale → validate → reconcile →      │
 │   execute (conditional write) → verify → re-observe       │
 └───────────────────────────────────────────────────────────┘
```

* **Guest** (`feltkit/`): every business rule. It has no network and no secrets, and it compiles to the AppBoundry
  WebAssembly guest unchanged (`npm run test:artifact`).
* **Component** (`component/`): FeltKit `components` / AppBoundry `components@1`. It is the only code that talks to
  Resolver, and it holds no state of its own. It acts on the application only through the guest's functions
  (`ctx.call`) as `component:resolver` with the `executor` role, which grants `observations.write` and
  `changes.execute` and nothing a person has. A restart loses nothing: every step is recorded in FeltDB or in
  Resolver.

## The change lifecycle

```
proposed ──validate──▶ ready ──approve × N──▶ approved ──claim──▶ executing ──▶ verified
   ├─▶ invalid            ├─▶ rejected            ├─▶ rejected          ├─▶ failed       Resolver refused; reference unchanged
   └─▶ superseded         ├─▶ cancelled           └─▶ cancelled         ├─▶ superseded   the reference moved before execution
                          └─▶ superseded (the reference moved)          └─▶ unknown      no answer → reconciled from Resolver's history
```

| Step | Who | Enforced by |
|---|---|---|
| Propose (retarget, introduce, rollback, revert, promote) | `changes.propose` (engineers, agents) | FeltKit roles. Basis revision must equal the observed one. One open change per reference. Never secret material. |
| Impact | rule (`_rules.ts computeImpact`) at proposal | Recorded on the change: differences, declared consumers, observed credential relationships, fallback, propagation (TTL), warnings, unknowns. |
| Validate | component | Resolver's own `checkBinding` (`@appport/resolver-core`), revision freshness (Resolver's history), environment isolation, credential existence and kind (resolve as executor). Catalog, schema, agent pins and write grant are **deferred** to Resolver's write and labelled so. |
| Approve | a **person** with `changes.approve` (+ `changes.approve.protected` in protected environments) | Not the proposer; not twice; not in a frozen environment; not if the reference moved. Required count = policy, at least 2 for `critical`. |
| Execute | component, on `claim` | `claim` re-checks policy and approvals at execution time (a tightened policy sends the change back). Concurrent claims conflict in FeltDB. Resolver `put`/`rollback` with `expectedRevision`; reason `[resolver-control CHG-n id] …`. |
| Verify | component, fresh client (no cache) | The revision is in Resolver's history; its reason carries the tag; its binding equals the approved one (Resolver's normalization); a fresh resolution returns it. Only then `verified`. |
| Reconcile | component | For `unknown` or an expired claim: find the tag in Resolver's history. Found means verify it. Not found with the reference unmoved means requeue (the conditional write makes re-execution exactly what was approved). Moved means superseded. |
| Audit | every mutation | `events`: written in the same transaction as the change, with the AppPort request id. |

A change written directly in Resolver (CLI, its pages, another key) shows up in its history without the tag. It is
recorded as `resolver.change.out_of_band` and surfaced in Insights. It also supersedes any pending change, because
Resolver refuses that change's conditional write.

## Domain model

`feltkit/app.ts` declares nine collections: `settings`, `syncStatus`, `dependencies`, `observations`, `consumers`,
`policies`, `changes`, `candidates` and `events`. FeltDB enforces their schema. The roles are `viewer`, `engineer`,
`approver`, `prod_approver`, `admin`, `agent`, `consumer_app` and `executor`.

Change class records the second half of the product thesis: what it actually takes to change a dependency.

| Class | Meaning | What the product does |
|---|---|---|
| `runtime` | Compatible implementations exist behind the contract | Change it here; verified; consumers follow |
| `adapter` | Another implementation needs adapter code in consumers first | Impact warns on provider or system changes |
| `migration` | Data, schema or contract migration (e.g. provider-specific payment tokens) | Impact warns; Resolver alone cannot make it |
| `unknown` | Not assessed | Insight: assess it |

## Integration map (Phase 0)

What the build relies on, classified from the code (not the docs) of each repository at the time of writing.

| Capability needed | Where | Status | Used as |
|---|---|---|---|
| Named references, kinds, bindings, steering | Resolver `@appport/resolver-core` | **Exists, usable** | Data model; `checkBinding` reused for validation and verification |
| List, resolve (incl. pinned), history, put/rollback with `expectedRevision`, watch | Resolver capabilities via `@appport/resolver-client` 0.2.4 | **Exists, usable** | Component; history is oldest-first with `limit` keeping the newest |
| Grants per key and pattern | Resolver | **Exists, usable** | Environment boundary for the executor key (proven: a key without `write` on prod fails the change) |
| Revision history with actor and reason | Resolver | **Exists** (not tamper-evident: Resolver's README) | Verification and correlation |
| Dry-run validation, consumer usage, readable value schemas, approval enforcement | Resolver | **Missing** | Gaps R1–R4 (docs/PLATFORM-GAPS.md) |
| App model, transactions, sequences, roles, `authorize`, live queries, audit | FeltKit 0.3.24 | **Exists, usable** | Everything in `feltkit/` |
| Capabilities published over AppPort and MCP | FeltKit + AppPort | **Exists, usable** | 30 capabilities; agents use MCP (e2e) |
| Components with declared credential, egress and principal | FeltKit `components` | **Exists, usable** under `feltkit dev/start` | The Resolver executor (e2e) |
| Components in an artifact (`components@1`) | AppBoundry | **Partially implemented**: tested locally, gate off, image and runtime unpublished | Built into `resolver-control.app`; not deployed (gap A1) |
| Durable component work (`afterCommit.work`) | FeltKit | Exists, **refused in artifacts** | Not used; the change record is the queue |
| `approval: "required"` mutations | FeltKit | Exists, **refused in artifacts** | Not used; approvals are domain state (needed for N-of-M and protected rules anyway) |
| FeltKit integrations resolving endpoints and credentials through Resolver | FeltKit | **Planned, not implemented** (`docs/RESOLVER-INTEGRATIONS-PLAN.md`) | Consumers use `@appport/resolver-client` directly (`examples/consumer-app.mjs`) |
| FeltKit agent model through Resolver | FeltKit | **Exists** | Any FeltKit app's `agent.model` reference is governed here like any other model reference |
| Secret custody for the executor key | FeltKit credential custody / AppBoundry secret files | **Exists** | `resolver-api-key` |
