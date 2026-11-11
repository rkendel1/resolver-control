# Platform gap register

Gaps found while building Resolver Control, each verified against code or by a test. **Platform** gaps
belong to Resolver, FeltKit, AppBoundry or AppPort; **application** gaps belong to this repository. Each
entry gives its effect on the product and the smallest change that would close it.

## Resolver (`@appport/resolver` 0.3.3)

**Next milestone:** R1 (consumer registration and resolution observability) and R4 (enforced mutation authority)
are designed in [RESOLVER-NEXT-MILESTONE.md](RESOLVER-NEXT-MILESTONE.md), grounded in Resolver's code. Change
notifications to running consumers already exist and work (watch stream; proven by the e2e). The missing half is
*adoption*, which the milestone's resolution records make observable.

| # | Gap | Evidence | Effect here | What would close it |
|---|---|---|---|---|
| R1 | **No consumer or usage information.** Resolver authenticates every resolution by API key, but exposes nothing about who resolved what. | `CAPABILITIES` in `resolver-core/protocol.ts`: no usage capability | Impact analysis can only use *declared* consumers, and says so ("an undeclared application may also resolve this reference"). Blast radius is unknown for undeclared consumers. | `resolver.usage { ref }` → principals (key names) that resolved it, last time, revision. Counts, never values. This is the single largest improvement available. |
| R2 | **No dry run.** Catalog checks (provider/model), value-schema checks and agent contract pins run only inside `put`. | `resolver.ts put` | Validation marks these checks `deferred`. A change can be approved, then refused at execution (`failed`, reference unchanged). Safe, but late. | `put { …, dryRun: true }` returning the same refusal without writing. |
| R3 | **A value reference's JSON Schema is not readable.** | `ResolveResult` has no schema | Value bindings cannot be checked before execution. | Include `schema` in `resolve` (or a `describe` capability). |
| R4 | **Resolver cannot require approval.** Any key with `write` changes a reference directly. | Grants are `read/reveal/write/admin` | Governance holds only if the executor key is the only prod writer. Direct writes are *detected* (out-of-band events, superseded changes), not *prevented*. | A grant mode such as `write:approved`: writes must carry an approval attestation signed by a configured approver service (this application). |
| R5 | **History is not tamper-evident**, and the correlation tag in `reason` is unsigned. | Resolver README, Limits | Evidence that the store's administrator can edit. | Hash-chained or signed revisions. |
| R6 | **History has no cursor.** It is oldest first, and `limit` keeps the newest N (max 1000). | `resolver.ts history`: `rows.slice(-limit)` | Reconciliation searches the newest 100 revisions for a change's tag. A reference rewritten more than 100 times between attempt and reconciliation would be reported `unknown`, not guessed. | `history { before?: revision, limit }`. |
| R7 | **Grants are per API key, with no groups or roles.** | Resolver README, Limits | One key per environment boundary must be managed by hand. | Groups, or keys scoped to a pattern set at creation. |
| R8 | **No target health.** Resolver knows where a reference points, not whether it works. | Design | "Healthy" is never claimed here. Verification proves resolution, not behaviour. | Out of Resolver's scope. A consumer-reported health signal would belong next to R1. |

## FeltKit (0.3.24)

| # | Gap | Evidence | Effect here | What would close it |
|---|---|---|---|---|
| F1 | **Integrations do not resolve through Resolver.** Only the agent's model reference does. | `docs/RESOLVER-INTEGRATIONS-PLAN.md` ("plan only"); `IntegrationConfig.baseUrl` is `string \| { env }` | A FeltKit app cannot yet make its `app.integration` endpoint or credential a governed runtime reference without code of its own. The example consumer uses `@appport/resolver-client` directly. | Implement the plan's `{ ref }` forms. |
| F2 | **The test harness does not run components.** | `createTestApp` has no component support | The engine is unit-tested through a binding that calls functions as the component principal. The real component wiring is proven only by the multi-process e2e. | `createTestApp({ components: true })` |
| F3 | **`ctx.afterCommit.work` is refused in AppBoundry artifacts.** | `docs/COMPONENTS.md` | The change record doubles as the work queue, with a claim fenced by FeltDB conflicts and a 60 s lease. That is about 40 lines that durable work would have provided. | Durable work in `components@1`. |
| F4 | **`approval: "required"` is refused in artifacts.** | `appboundry/build.ts` | Not needed: N-of-M, protected-environment and separation-of-duties rules are domain logic anyway. | — |
| F5 | **Components have no non-secret configuration.** They see declared credentials only. | `ComponentContext` | The Resolver origin is application state (`settings`), set by an admin and audited. That is arguably better. | — |

## AppBoundry

Tracked separately from Resolver's gaps: this is an execution-platform limitation, not a missing Resolver capability.

| # | Gap | Evidence | Effect here | What would close it |
|---|---|---|---|---|
| A1 | **Companion execution cannot run on a real host today.** It is off by default (`APPBOUNDRY_COMPANION_EXECUTION`). The companion image is defined but not built or published, and a published runtime refuses `components@1` (`ARTIFACT_INTERFACE_UNSUPPORTED`). Component routing (Caddy) is not deployed. | `appboundry/docs/contracts/feltkit-deploy/COMPONENTS.md` §8 | **`resolver-control.app` builds and its guest runs the full lifecycle in FeltKit's reference AppBoundry host, but it has not been deployed to an AppBoundry host.** Without its component, a deployed artifact would be a read-only governance record that never executes. | Publish the companion image and a runtime with `componentTokens`; enable the gate on a host. |
| A2 | **No egress allowlist.** `egress` means unrestricted. | COMPONENTS.md §3 | The component could reach any host. Only the Resolver origin is needed. | Per-component allowlist (the Resolver origin). |
| A3 | **Component secrets are host files with no API.** | COMPONENTS.md §4 | An operator places `resolver-api-key` on the host by hand. | A secret-management API. |
| A4 | **Accounts and tenancy are not available to artifacts.** | FeltKit `docs/APPBOUNDRY.md` | People get sessions from AppBoundry's operator (`appboundry admin sessions issue`). This app does not use `auth.accounts`, so it stays portable. | — |

## AppPort

No blocking gap found. The application publishes 30 capabilities, and agents discover and call them over MCP
(e2e). Authorization is decided before handlers run, and handler-level rules (person-only approval, not the
proposer) are enforced in the handler and tested.

## Application gaps (this repository)

| Gap | Why it is open |
|---|---|
| **No model-backed advice.** Explanations, provider recommendations, drafted justifications and adapter generation are not built. | Deliberate for this release. Every workflow works without a model, and the deterministic Insights and impact analysis come first. A model would *propose* (`changes.propose` as an agent) and could not approve. The capabilities it needs exist. |
| Not deployed to production; only development and the artifact host were exercised. | A1. FeltKit's own targets (`feltkit deploy --target container`) were not run for this app. |
| One Resolver connection (one origin, one tenant). | Sufficient for a first release; `settings` is a single record. |
| No notification when a change awaits approval. | AppPort Services notifications are available. Not wired. |
| Endpoint reachability is never probed. | Probing arbitrary targets from the executor is an SSRF risk; reported as `deferred`. |
| Multi-instance component not tested. | Claims are FeltDB-conflict fenced and writes are conditional, so a second instance cannot double-apply. Not exercised. |
| Discovery is pattern-based. | It reports candidates with evidence and judges nothing: compatibility and adapters are for people, or a future model-backed proposal. |
