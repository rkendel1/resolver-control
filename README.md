# Resolver Control

**Change what applications depend on without changing how they are deployed.**

Applications name what they need (`ref://prod/ai/default`, `ref://prod/search`, `ref://prod/payments`) and resolve it
at run time through [Resolver](https://www.npmjs.com/package/@appport/resolver). Resolver Control is where an
organization:

* sees those dependencies;
* records who owns them, how critical they are, and what changing them really takes;
* proposes a change and understands its impact;
* gets it approved by the right people;
* has it executed through Resolver;
* verifies the result.

Running applications pick up the change without a redeploy.

It is a [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit) application. Its domain logic compiles to an
AppBoundry WebAssembly guest with no network. The only code that talks to Resolver is one declared component
(`component/`), which holds the only Resolver key.

## What it does

| Area | |
|---|---|
| **Dependencies** | Every reference Resolver resolves in the managed environments (*observed*), joined with owner, criticality, change class and the contract consumers rely on, and with declared consumers (*declared*). Every fact says where it came from. Secrets show only custody metadata. |
| **Changes** | Propose a retarget, a new reference, a rollback, a revert or a promotion between environments. Each proposal is based on the revision you inspected. Impact is assessed when it is proposed: differences, consumers, credential relationships, fallback, propagation, warnings, and an explicit list of unknowns. |
| **Validation** | Checked against Resolver with Resolver's own binding rules: revision freshness, environment isolation, credential existence. Checks only Resolver can make at write time are marked *deferred*, not passed. |
| **Approvals** | People only, never the proposer, never twice. Protected environments need production approvers. Critical dependencies need two people. Frozen environments hold everything. |
| **Execution** | A conditional write to Resolver (refused if the reference moved), tagged with the change id in Resolver's own history. If no answer comes back, the outcome is reconciled from that history rather than guessed. |
| **Verification** | Resolver's history has the revision, its reason names the change, the recorded binding is the approved one, and a fresh resolution returns it. Only then is a change *verified*. |
| **Environments** | Policies per namespace, freeze, and side-by-side comparison. |
| **Insights** | Deterministic findings: ungoverned or unowned dependencies, critical single points of failure, missing consumers, drift, changes made directly in Resolver (outside governance), revoked credentials still in use, stale proposals. |
| **Discovery** | `npm run discover -- <repo>` finds decisions still embedded in code (model ids, provider hosts, endpoints and keys read from the environment) and submits them as candidates. It does not judge them. |
| **Agents** | Every operation is an AppPort capability, also served over MCP. Agents inspect, declare consumers, propose and submit findings. They cannot approve or execute. |

## Run it

```bash
npm install
```

```bash
npm run demo
```

This starts the real Resolver (its own CLI, state in `.tmp/demo`), creates references in `staging` and `prod`,
an executor key and a consumer key, and runs this app under `feltkit dev` with the executor key in FeltKit's
credential custody. Then open the app URL it prints:

1. As **Ada**, go to **Settings**: set the origin `http://127.0.0.1:4300` and the environments `staging, prod`, then Save. Then **Load demo policies, owners and consumers**.
2. As **Grace**, open **Dependencies → `ref://prod/ai/default` → Propose a change**. Edit the binding (e.g. `anthropic/claude-sonnet-5-5`), give a reason, and Propose. Within seconds it is validated.
3. As **Barbara**, open the change: she may not approve a protected environment. As **Linus**, approve it.
4. Watch it execute and verify. Then **Environments**, **Insights** and **Activity**.

Add `-- --consumer` to also run `examples/consumer-app.mjs`. It is a consuming application started once, and it
prints what it resolves every 2 seconds, so you can watch it switch with no restart. It registers with Resolver
as `support-assistant` and reports each revision it uses.

Add `-- --governed` to have Resolver enforce approvals. Resolver's host operator CLI puts `ref://prod/*` under a
mutation policy and trusts a new signing key. The approval signer runs with that key and its own read-only
session. In **Settings**, also set **Approval signer origin** to `http://127.0.0.1:8790`. A prod change then
executes only with an authorization the signer issued for that approved change. Its page shows the authorization
and, once consumers resolve and report, its adoption.

```bash
npm run demo -- --governed --consumer
```

Against your own Resolver:

* create a key with `read` on every managed namespace and `write` only where changes may execute;
* set it as `FELTKIT_CREDENTIAL_RESOLVER_API_KEY`;
* run `npm run dev`;
* set the origin in Settings.

```bash
resolver keys create resolver-control --grant read,write:ref://staging/* --grant read,write:ref://prod/*
```

## Test it

```bash
npm test
```

12 tests against the real Resolver, in process: lifecycle, failures, concurrency, authority, recovery, agents and discovery.

```bash
npm run test:e2e
```

Separate processes: Resolver's CLI, `feltkit dev` with the component, a consumer process, and an agent over MCP.

```bash
npm run test:artifact
```

Builds `resolver-control.app` and runs the lifecycle through its WebAssembly guest.

## Documents

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): ownership, components, the change lifecycle, domain model, and the integration map.
* [docs/PLATFORM-GAPS.md](docs/PLATFORM-GAPS.md): what Resolver, FeltKit and AppBoundry lack, and what this application lacks.
* [docs/RESOLVER-NEXT-MILESTONE.md](docs/RESOLVER-NEXT-MILESTONE.md): the next Resolver milestone (consumer registration, resolution observability, enforced mutation authority), designed against Resolver's code.
* [docs/AUTHORIZATION-INTEGRATION.md](docs/AUTHORIZATION-INTEGRATION.md): governed execution with Resolver 0.4.0. The approval signer, adoption, the tests, and the limits.
* [docs/EVIDENCE.md](docs/EVIDENCE.md): what works and how it was proven, what was reused, custom code size, what changes without redeploying, and the current limits.

## Limits, briefly

* **Resolver 0.4.0 is not published yet.** This application builds and tests against it from `vendor/`. With an
  older Resolver, consumers are declared only, and writes carry no authorization.
* **Governed writes need the approval signer** (`signer/`) running, with its key registered with Resolver. It is
  not packaged or deployed yet, and it trusts this application's records.
* **Observed consumers are what Resolver saw resolve.** "Adopted" is what consumers report.
* **Verification proves what a reference resolves to, not that the target works.**
* **The AppBoundry artifact builds and its guest is tested, but it cannot run its component on an AppBoundry host yet** (platform gap A1). Run it with FeltKit.
* **No model-backed advice yet, by choice.** Every workflow works without one.
