# Evidence report

What was built, what was proven and how, what was reused, and what is still missing. Every claim
names the test or command that shows it. Numbers are from the last full run (2026-11-11).

## How it was verified

| Check | Command | Result |
|---|---|---|
| Types (backend, component, frontend, tests) | `npm run typecheck` | clean |
| Unit and integration tests, against the **real** Resolver (`@appport/resolver` 0.3.3 from npm, run in-process as its own install) | `npm test` | 12/12 pass |
| Multi-process e2e: Resolver's own CLI (`init`, `serve`, `keys`, `set`), `feltkit dev` running the component, a separate consumer process, people over HTTP, an agent over MCP | `npm run test:e2e` | 1/1 pass |
| The compiled AppBoundry artifact: build it, then run the full lifecycle through its WebAssembly guest in FeltKit's reference AppBoundry host | `npm run test:artifact` | 1/1 pass |
| Artifact reproducibility | two `feltkit build --target appboundry` runs, no source change | `manifest.json`, `module.wasm` and `components/resolver.mjs` byte-identical |
| The UI, driven in Chromium through the model scenario (configure, load metadata, propose as Grace, refused for Barbara, approved by Linus, verified) | Playwright, by hand during development (not a committed test) | no console errors; screens reviewed at 1440 px and 390 px (no horizontal overflow) |

Nothing in any test fakes Resolver. Two tests inject transport faults by **wrapping** the real client: one where
the write happens but its answer is lost, and one where the write never happens. Resolver itself answers
everything.

## What actually works

1. **Inventory.** Every reference the executor key may read in the managed environments, joined with
   ownership, criticality, change class and declared consumers. Every value is labelled *observed*,
   *declared* or *derived*. Secrets appear as custody metadata only (`lifecycle.test.ts`).
2. **The change lifecycle.** Proposal → validation against Resolver → approval by people → execution
   through Resolver's conditional write → verification → audit (`lifecycle.test.ts`, e2e, artifact test).
3. **The thesis, demonstrated.** A consumer process started once (`examples/consumer-app.mjs`) resolves
   `openai/gpt-4o` at r1. After a governed change it resolves `anthropic/claude-sonnet-5-5` at r2
   **with the same process id**: no restart, no redeploy (e2e).
4. **Not only models.** The search endpoint moves to provider B with A as failover. The consumer resolves the
   failover binding (`lifecycle.test.ts`). Promotion of `ref://staging/search` to prod also works (`failures.test.ts`).
5. **Rollback as a new operation.** A revert is a new change with its own approval. It executes as Resolver's
   `rollback`. History reads r1, r2, r3, and nothing is erased (`lifecycle.test.ts`).
6. **Authority.**
   - Only a person approves.
   - Never the proposer, even one holding both roles (`failures.test.ts`, separation of duties).
   - Never twice.
   - Protected environments need `changes.approve.protected`.
   - Critical dependencies need two people.
   - Agents propose but cannot approve, settle, change policy or reconfigure. This holds in-process (`agents.test.ts`) and over MCP (e2e).
7. **Resolver's grants as the hard boundary.** An executor key without `write` on prod makes an approved
   prod change `failed` with `FORBIDDEN`, and the reference stays unchanged (`failures.test.ts`).
8. **Concurrency.**
   - A direct write in Resolver after approval makes the conditional write fail; the change becomes `superseded`, and the direct write is recorded as out-of-band and flagged in Insights.
   - A proposal awaiting approval goes stale and cannot be approved (`failures.test.ts`).
9. **Recovery.**
   - Lost answer after the write: `unknown`, then reconciled by the change's tag in Resolver's history, then `verified`. Written exactly once.
   - Lost before the write: `unknown`, then `requeue`, then executed once (`failures.test.ts`).
10. **Policy and durability.** A frozen environment holds approved changes; unfreezing releases them. Approvals,
    policy and changes survive an application restart (`failures.test.ts`).
11. **No secret leakage.** The provider key's material appears in no inventory, detail, change, activity or
    insight record (`failures.test.ts`). It is absent from the application's output and the consumer's output
    (e2e), and from the artifact manifest (artifact test). The executor key never has `reveal`.
12. **Discovery.** The scanner finds hardcoded model ids, provider hosts, and endpoints and credentials read
    from the environment. It redacts key-shaped strings, skips test directories and model catalogs (and
    reports which), and deduplicates by fingerprint across rescans (`agents.test.ts`). On real repositories it
    found 2 candidates in supply-desk, 2 in FeltKit and 15 in AppPort Services, after skipping
    AppPort Services' model catalog. Several are platform infrastructure (`FELTDB_URL`) that should *not*
    become a Resolver reference. The scanner cannot judge that; a person dismisses them.

## What was reused

| From | What |
|---|---|
| Resolver | All resolution state, history, rollback, grants and the vault. `@appport/resolver-client` for every call. `@appport/resolver-core`'s `checkBinding` for validation **and** verification, so the app applies exactly Resolver's rules. The correlation tag rides in Resolver's own `reason` field. |
| FeltKit | Application model, collections and schema enforcement, transactions with read fences (claims), sequences, roles, live queries, AppPort capability publishing, MCP for agents, sessions, credential custody for the executor key, `components` (process, health, principal, credential), the build, and the AppBoundry compiler. |
| FeltDB | The single durable store, through FeltKit. |
| AppPort | Capability contracts (30 published), authorization before handlers, MCP bridge. |
| AppBoundry | The artifact format (`appboundry.app/1`, `components@1`) and FeltKit's reference host for running it. |
| Starter and supply-desk | Theme tokens, the shell pattern, audit-event pattern. |

Nothing was rebuilt that Resolver already does. Resolver's own pages (references, models, secrets, access) stay
the place for secret rotation and key management. This application adds what Resolver lacks: ownership,
consumers, policy, approvals, impact, verification evidence and discovery.

## Custom code

Non-blank lines, counted from this repository:

| Area | Lines | Notes |
|---|---|---|
| Domain logic (`feltkit/`, excluding generated) | 1,608 | `changes.ts` 412, `app.ts` 265 (declarations), `catalog.ts` 244, `_rules.ts` 201 (pure rules) |
| Resolver component (`component/`) | 431 | The only Resolver I/O |
| Frontend (`src/`) | 1,594 | Including CSS |
| Scripts and example consumer | 306 | Demo, discovery scanner, consumer app |
| Tests (unit, e2e, artifact) | 787 | |

What this code is **not**: a store, a permission system, a vault, a resolution engine, an API server, a
deployment pipeline or a sidecar. One process under FeltKit, one artifact for AppBoundry.

## What can change without redeploying consumers

Anything a consumer resolves through Resolver's client, once the consumer resolves it:

* model provider, model, endpoint, options and credential reference;
* service endpoints (search, email, payments, any HTTP API), including failover lists and weighted canaries;
* agent origins and their pinned capability digests;
* configuration values (`value` references);
* rollback of any of these to an earlier revision, including a secret's earlier material;
* provider keys rotated in Resolver (consumers pick up new material on next use).

Propagation, as measured by Resolver's client: at once over the live stream. A missed notification is bounded by
the reference's TTL, so `ttlSeconds` is the guarantee, not the typical case.

## What still requires a code change or redeploy

* **The first adoption.** A consumer that reads a value from code or its environment must be changed once to
  resolve it. Discovery finds those places; it does not change them.
* **Different contracts.** Another provider with a different API needs an adapter in the consumer
  (`changeClass: adapter`). Resolver changes *which* implementation, not *how to talk to it*.
* **Data migrations.** For example, payment methods tokenized by one provider (`changeClass: migration`).
* **FeltKit integrations.** `app.integration` endpoints and credentials are not resolvable through Resolver yet
  (gap F1). Only the FeltKit agent's model reference is.
* **This application itself.** A change to its rules is a code change and a new artifact.

## The current operational limitation

**The AppBoundry deployment is blocked by the platform, not by this application (gap A1).** The artifact
builds reproducibly, and its guest passes the full lifecycle in FeltKit's reference AppBoundry host. But no
AppBoundry host can run its `components@1` companion today: the gate is off, and the image and runtime are
unpublished. Without the component, a deployed artifact can record governance but never observe or execute.
Today the product runs under `feltkit dev` / `feltkit start`, where components run in-process. The FeltKit
production targets (`feltkit deploy`) were not exercised for this application.

Second: **blast radius is declared, not observed (gap R1).** Impact analysis is honest about it, but it is the
main thing standing between this product and a trustworthy "who is affected".

## What would make Resolver substantially more powerful for this product

In order of value:

1. **Usage reporting (R1).** Which principals resolved a reference, when, and at which revision. This would turn
   impact analysis from declared to observed, catch undeclared consumers, and show when a change has actually
   propagated (all consumers on the new revision), which today can only be inferred from TTL.
2. **Approval-enforced writes (R4).** Today governance is a convention backed by key hygiene; this would make it a
   Resolver guarantee.
3. **Dry run (R2) and readable schemas (R3).** All validation would happen before approval instead of some at
   execution.
4. **History cursor and tamper evidence (R6, R5).** For evidence that survives an administrator and references
   with long histories.
