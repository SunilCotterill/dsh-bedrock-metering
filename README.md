# dsh-bedrock-metering

A local DeepSeek Harness (dsh 0.2.1 release candidates, rc.2 onward) plugin that meters every model call, prices it with
published Amazon Bedrock on-demand rates, shows what each conversation has spent, warns as a
conversation approaches its budget, and stops the agent once that conversation's budget is spent.

- **Meter:** wraps the `llm/stream` waterfall and appends one row per model call (loop steps,
  session titles, compaction, subagents) to a shared JSONL ledger. Only routes listed in
  `meter.providers` (default `amazon-bedrock`) count toward the budget; every other route is logged
  with token counts and `usd: 0`.
- **Budget per conversation:** by default (`budget.window: session`) the limit applies to each
  conversation (a dsh session together with its subagents) on its own: $300 per conversation by
  default. The composer pill shows the conversation's total spend, subagents included. See
  [What counts as a conversation](#what-counts-as-a-conversation).
- **Warn:** each `warnAt` threshold (default 80% and 95%) is announced once per conversation per
  process, as a durable session record, a logger line and, in the headless profile, a stderr line.
- **Stop:** at `stopAt` (default 100%) the `agent/pre-step` gate rejects the step (the turn ends
  `blocked`, no model request), and the `llm/stream` guard throws a non-retryable
  `LlmError` with code `BUDGET_EXCEEDED` for any other metered call in that conversation. Both
  check the calling conversation's own spend, so a stop in one conversation never blocks another.
- **Recover:** a stopped conversation stays stopped (there is no calendar reset). Start a new
  conversation, run `/budget override <minutes>` (at most 120) in the stopped one, or raise
  `budget.limitUsd`.

## Install

Each release is a tag on GitHub. The built `lib/` is committed, so an install copies files and
runs no build step.

**From the web UI.** Open **Plugins** in the sidebar, click **Add plugin**, paste

```text
github:SunilCotterill/dsh-bedrock-metering#v0.2.1
```

then click **Install** and, when it finishes, **Enable now** (closing the dialog instead leaves the
plugin installed but off). The page manages only the profile `dsh web` is running. Restart
`dsh web` if the page says a restart is needed.

**From the command line**, which also reaches profiles the web UI does not, such as `headless`.
Run it for each dsh profile that reaches Bedrock (here the `web` and `headless` profiles of
`~/.dsh-local`; change `DSH_HOME` and `--profile` to match your setup):

```bash
DSH_HOME=$HOME/.dsh-local npx -y @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile web add "github:SunilCotterill/dsh-bedrock-metering#v0.2.1"
```

```bash
DSH_HOME=$HOME/.dsh-local npx -y @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile headless add "github:SunilCotterill/dsh-bedrock-metering#v0.2.1"
```

`dsh plugin` runs `pnpm add` in the profile directory, so any git spec pnpm accepts works. A tag
can be moved, so to install exactly the code you reviewed, put a commit hash in place of `v0.2.1`. The package declares `dsh.bundle.patch`, so `add` also appends
`dsh-bedrock-metering` to the profile's bundle list, and its `cordis.patch.yml` inserts the
`bedrock-metering` row with the defaults below. Restart dsh to load it (a running `dsh web` keeps
its old tree), then check that startup printed no `skipping profile bundle` line and that the row
is in the composed tree:

```bash
DSH_HOME=$HOME/.dsh-local npx -y @deepseek-ai/dsh@0.2.1-rc.5 --profile web --dump-config | grep -A3 bedrock-metering
```

pnpm's `Issues with peer dependencies found` warning during `add` is expected: dsh supplies the
harness packages itself at startup.

To upgrade from the command line, run the same `add` commands with the new tag and restart. In the
web UI, uninstall the plugin and add it again with the new tag (the page offers **Update** only for
official plugins). To uninstall from the command line, run
`plugin --profile <name> remove dsh-bedrock-metering`.

Before you rely on it:

- **Your Bedrock provider must be called `amazon-bedrock`.** Only routes listed in
  `meter.providers` count toward the budget. If your `llm-pi-ai` provider has another name, add it
  there (see Configuration), or the plugin logs your calls at $0 and never stops you.
- **The budget is yours, not the team's.** The ledger lives on your machine, so each person gets
  their own limit ($300 per conversation by default). Set yours in your profile
  patch. A per-conversation limit does not cap a day's total: many conversations can each spend up
  to the limit. A cap on the shared AWS account needs AWS Budgets; this plugin cannot see other
  people's spend.
- **Upgrading from 0.1.x changes the default** from $300 per day to $300 per conversation. To keep
  a daily limit, set `window: day` and your `limitUsd` in the profile patch (see Configuration).
- **Prices are estimates** until the Kimi K3 row has been checked against an AWS bill (see Prices).

**Harness versions.** The plugin accepts any dsh from 0.2.1-rc.2 up to and including the final
0.2.1 (peer range `>=0.2.1-rc.2 <0.2.2-0`). It was built on rc.2 and re-checked on rc.5. A plain
`npx -y @deepseek-ai/dsh` fetches whatever dsh was published last, and once that is 0.2.2 or later,
dsh skips the plugin at startup with
`dsh: skipping profile bundle "dsh-bedrock-metering": … is incompatible with dsh …`. Metering and
the budget stop are then off. So launch a pinned version, the same one for the whole team:

```bash
DSH_HOME=$HOME/.dsh-local npx -y @deepseek-ai/dsh@0.2.1-rc.5 web
```

Move the pin to a newer dsh only together with a plugin release whose peer range covers it.

## Configuration

Defaults (from `cordis.patch.yml`):

```yaml
ledgerPath: ~/.dsh-bedrock-metering/ledger.jsonl   # shared by every DSH_HOME and process
budget:
  window: session         # session (one conversation) | day | month; day and month start at local midnight
  limitUsd: 300           # USD per window: per conversation by default
  warnAt: [0.8, 0.95]     # fractions of limitUsd, each announced once per conversation (or window) per process
  stopAt: 1               # fraction of limitUsd at which the agent stops
meter:
  providers: [amazon-bedrock]   # routes that count toward the budget
  region: us                    # preferred bundled row when a model id has several regional prices
  unpricedModel: warn-zero      # warn-zero: count $0 and warn once | block: refuse the call
  cacheFallback: input-rate     # cache reads where no cache price is published: input-rate | zero
  notifyModel: false            # also inject warnings as model-visible context
override:
  allow: true                   # /budget override <minutes>
  maxMinutes: 120
prices: {}                      # provider route -> model id -> {input, output, cacheRead?, cacheWrite?}, USD per 1M tokens
```

**$300 per conversation is the default** (chosen 2026-11-03); set your own `limitUsd` to change
it. The config value for a conversation is `session` (a dsh session with its subagents).

Override in `~/.dsh-local/profiles/<web|headless>/cordis.patch.yml`. A patch replaces the row's
whole `config`, so restate every key:

```yaml
- id: bedrock-metering
  config:
    ledgerPath: ~/.dsh-bedrock-metering/ledger.jsonl
    budget: { window: session, limitUsd: 25, warnAt: [0.8, 0.95], stopAt: 1 }
    meter: { providers: [amazon-bedrock], region: us, unpricedModel: warn-zero, cacheFallback: input-rate, notifyModel: false }
    override: { allow: true, maxMinutes: 120 }
    prices: {}
```

The web profile reloads patch edits live (`patchReload: live`); other profiles read them at start.
Keep the same `ledgerPath` and limit in both profiles: the ledger is shared, so each process sums
the same rows against its own configured limit.

### What counts as a conversation

A conversation is a top-level dsh session together with the subagents it starts (and theirs).
Every ledger row carries the session id of the call that produced it; a subagent's rows also carry
`conversation`, the top-level session id. The conversation window sums every row of the
conversation, however many days it spans.

- **Loop calls, session titles and compaction** carry the conversation's own session id, so they
  count toward it and are refused once it is stopped.
- **Subagents count toward their parent conversation.** dsh runs each subagent in a child session
  with a fresh id and records the parent in the child's header (`origin: subagent`,
  `parentSession`). The plugin follows that link, through nested subagents too, and stamps the
  top-level id on the child's rows. A subagent's spend therefore shows in the parent's pill and
  `/budget status` (which say how much of it came from subagents) and counts toward the parent's
  limit. Once the conversation is over the limit, the parent and its running subagents all stop.
  Opening a subagent's session shows the whole conversation's total.
- **A forked conversation is a new conversation.** A user fork also records `parentSession`, but
  without `origin: subagent`, so it starts its own count.
- **Subagent spend from before 0.2.1 stays under its own session.** Those rows have no
  `conversation`, and a finished subagent's session is no longer live for the plugin to look up.
  On this machine that is $0.58 from two subagents of one conversation on 30 October.
- **Each headless run is its own conversation** (a new session id) and starts at $0, unless it
  resumes a session with `--session-id`.
- **A call with no session id counts toward no conversation and is never refused.** It is still
  logged. In dsh 0.2.1-rc.5 only the experimental auto-review reviewer makes such calls, and it is
  not enabled in the `~/.dsh-local` profiles.
- **Override and reset are per conversation.** `/budget override` and `/budget reset` apply only to
  the conversation they are typed in, subagents included, even when typed in a subagent's session.

Rows written before 0.2.0 already carry session ids, so each past conversation keeps its spend.
With `window: day` or `month` the plugin goes back to calendar windows shared by every
conversation and process.

Pricing rules: input, output and cache buckets are disjoint (the harness `TokenUsage` contract), so
`usd = in × input + out × output + cacheRead × (cacheRead or fallback) + cacheWrite × (cacheWrite or 0)`,
per 1M tokens. Output is treated as inclusive of reasoning; reasoning tokens are added at
the output rate only when the reported total shows they are outside `outputTokens`.

## Budget pill in the web composer

The web UI shows a pill beside the model picker in the chat composer. Its label is the total
spent in the current conversation, and its bar and colour measure that spend against the
per-conversation limit:

| Conversation spend | Pill |
|---|---|
| Below the first `warnAt` threshold | `$1.23`, neutral |
| From the first threshold (80%) | amber |
| From the last threshold (95%, when there are several) | red |
| Stopped | `$300.12 · stopped`, red |
| Over the limit with an active override | amber, e.g. `$312.00` |

A thin bar shows the fraction of the limit used. Hovering shows the conversation's spend, limit
and percentage (for example `$12.30 of $300.00 Bedrock budget for this conversation (4%)`), how
much of it came from subagents, the thresholds, any active override or `/budget reset` and, when
stopped, how to continue. Under a
`day` or `month` window the label is the window's spend and the hover text adds the reset time.
The pill reads `GET /bedrock-metering/status?session=<id>` every 10 seconds and when the window
regains focus, so new spend or a `/budget override` shows up within about 10 seconds. The composer
slot is session-scoped, so dsh hands the pill the conversation's session id. The route sits behind the web UI's
browser-trust check (an untrusted request gets the check's status code and no body) and is mounted
only where the web server runs. The browser half is `client/budget-pill.js`, hand-written in dsh's
client module format with React supplied by the shell, so the package needs no bundler.

## The `/budget` command

Type it in the web chat composer:

| Command | Effect |
|---|---|
| `/budget` or `/budget status` | This conversation's spend against the limit (subagents included, with their share), thresholds, override state, total metered calls and tokens, per-route calls and tokens (metered and not), refused and unpriced calls, price-table date, ledger path |
| `/budget override <minutes>` | Lift this conversation's stop for 1 to `maxMinutes` minutes. Other conversations are not affected. Written to the ledger (with `window: session` and the session id) and recorded on the conversation. Under a `day` or `month` window it lifts the stop for every dsh process sharing the ledger, including headless subprocesses |
| `/budget reset` | Restart this conversation's count from now (for mistakes); other conversations are not affected. Written to the ledger and recorded on the conversation. Under a `day` or `month` window it starts a fresh window for everyone |

`/budget` still works in a stopped conversation: commands do not go through the agent loop.

The headless runner sends its task text straight to the agent and never parses slash commands, so
`/budget` is registered there but unreachable. Use the web UI, or read the ledger.

## Headless behaviour

- A crossed threshold prints `dsh: budget: 82% of $300.00 conversation limit used ($246.00)` on stderr.
- A stopped run prints
  `dsh: budget: stopped: $300.12 of $300.00 conversation Bedrock budget used; this conversation stays stopped. Start a new conversation, run /budget override <minutes> in this one in the web UI, or raise budget.limitUsd in the profile patch to continue.`
  and exits 1 (the turn ends `blocked`; the runner exits 1 on any non-`completed` turn). A new
  headless run is a new conversation and starts at $0.
- A refusal by the stream guard ends the turn with an error, and the runner adds its own
  `dsh: BUDGET_EXCEEDED: …` line.

## Ledger

`~/.dsh-bedrock-metering/ledger.jsonl`, created on the first metered call (directory 0700, file
0600). One JSON object per line, appended with a single `O_APPEND` write; readers fold new bytes
incrementally, skip a partial trailing line, and dedupe by `(kind, session, turn, step, attempt)`.

```json
{"v":1,"ts":"2026-10-28T18:32:05.701Z","home":"/Users/x/.dsh-local","profile":"web","session":"session-…","kind":"usage","turn":1,"step":1,"attempt":"…","provider":"amazon-bedrock","model":"global.moonshotai.kimi-k3","in":2000,"out":340,"cacheRead":10000,"cacheWrite":0,"reasoning":0,"usd":0.0141,"metered":true,"priced":true,"price":"kimi-k3-global","outcome":"stop"}
```

A subagent's rows (every kind) also carry `"conversation"`, the top-level session id of the
conversation they count toward.

Other kinds: `refused` (a call the guard stopped; carries `purpose` such as `session-title`),
`override` (`until`, `minutes`, `window`) and `reset` (`window`). An override or reset written
under the conversation window (`"window":"session"`) applies only to its own conversation, and
calendar windows ignore it. Rows from 0.1.x have no `window`; calendar windows apply them to
everyone, and the conversation window applies them to the session they name. The conversation
window keeps every ledger row in memory, since a conversation has no start date. A call that fails after reporting usage is still billed;
one that fails before any usage chunk writes nothing.

Durable session records (skipped by readers without this plugin, never model-visible):
`plugin:dsh-bedrock-metering/warning`, `/stop`, `/override`, `/reset`.

## Prices and the refresh script

`prices/bedrock.json` holds Standard on-demand rates in USD per 1M tokens read from
https://aws.amazon.com/bedrock/pricing/ on 2026-10-28. Every row is `verified: false`: the page
shows names, not model ids. The ids are inferred and cross-checked against the Bedrock catalog
bundled with the harness's pi-ai 1.4.0 adapter, which agrees with the page rates. Confirm the
`global.moonshotai.kimi-k3` row against an AWS bill line before trusting totals.

| Key | Model ids | Input | Output | Cache read | Cache write |
|---|---|---|---|---|---|
| kimi-k3-global | `global.moonshotai.kimi-k3` | 3.00 | 15.00 | 0.30 | 3.75 |
| kimi-k3-us | `us.moonshotai.kimi-k3` | 3.30 | 16.50 | 0.33 | 4.125 |
| kimi-k2-thinking-us | `moonshot.kimi-k2-thinking`, `us.moonshotai.kimi-k2-thinking` | 0.60 | 2.50 | n/a | n/a |
| kimi-k2.5-us | `moonshotai.kimi-k2.5`, `us.moonshotai.kimi-k2.5` | 0.60 | 3.00 | n/a | n/a |
| deepseek-v3.2-us | `deepseek.v3.2`, `us.deepseek.v3.2` | 0.62 | 1.85 | n/a | n/a |
| deepseek-v3.2-mumbai-… | `deepseek.v3.2` (region `mumbai-saopaulo-jakarta-tokyo-stockholm`) | 0.74 | 2.22 | n/a | n/a |
| deepseek-v3.2-sydney | `deepseek.v3.2`, `apac.deepseek.v3.2` | 0.6386 | 1.9055 | n/a | n/a |
| deepseek-v3.1-sydney | `apac.deepseek.v3.1`, `deepseek.v3-v1:0` | 0.5974 | 1.7304 | n/a | n/a |
| deepseek-v3.1-us | `deepseek.v3-v1:0`, `us.deepseek.v3-v1:0` | 0.58 | 1.68 | n/a | n/a |
| deepseek-r1-us | `us.deepseek.r1-v1:0`, `deepseek.r1-v1:0` | 1.35 | 5.40 | n/a | n/a |

Refresh against the live page (no AWS credentials needed):

```bash
pnpm refresh-prices
```

```bash
pnpm refresh-prices --write
```

The script fetches the page, parses its server-rendered tables, resolves the client-rendered
`{priceOf!…}` cells (DeepSeek-R1, DeepSeek-V3.1) from the public feed
`https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json`, finds the
cell each row names in its `page` field (section, tab panel, row name, region), and prints rate
changes, rows it could not find (exit 1), new rows in the same tab panels, and the full table.
`--write` rewrites the rates and `retrievedAt`; rows stay `verified: false`. `--html` and `--feed`
take saved copies for offline runs. Run on 2026-10-28 it matched all 10 rows with no changes.

## Verified behaviours (M0 on 0.2.1-rc.2, re-checked on 0.2.1-rc.5)

| Question | Answer | Evidence |
|---|---|---|
| `llm/stream` request fields | `provider`, `model`, plus `sessionId` (loop calls) and `purpose` (`session-title`, `compaction`) | `dsh-llm` types; observed in ledger rows from the offline run below |
| Where `ctx.logger` writes in headless | Nowhere visible. Cordis's `LoggerService` keeps messages in an in-memory ring (1000 entries); `dsh-app-boot` adds an exporter only on a boot-diagnostics context that collects warn/error for startup-failure reports and is disposed when boot ends. No installed package registers another exporter. | Source of `cordis`, `dsh-app-boot`; headless runs printed exactly one line per notice (the plugin's direct stderr write), never a logger echo. The plugin writes `process.stderr` itself when the `headlessStartup` service exists |
| What the web client shows for a `blocked` turn | Observed on 0.2.1-rc.5 (2026-10-30): the prompt disappears and the turn shows **"Completed in 1s"** with no error. The loop appends `turn/end {kind: blocked}` with no step, the claimed prompt is never re-emitted as `user/message`, and the chat UI special-cases only `aborted`, `interrupted` and `error`. The red `Bedrock stopped` pill in the composer, and `/budget status`, are what explain it | Scratch web instance in a browser; `dsh-agent-loop` `turn()`; `dsh-client-ui-chat` turn rendering |
| Does Bedrock usage report cache buckets (Kimi 3)? | Cache reads yes, cache writes no, reasoning folded into output. In 205 logged `amazon-bedrock/global.moonshotai.kimi-k3` responses: `cacheReadTokens` on 203, `cacheWriteTokens` on 0, `reasoningTokens` on 0; `totalTokens` on all 205 and always equal to input + output + cache read. pi-ai sends explicit cache points only for Claude models (or `AWS_BEDROCK_FORCE_CACHE=1`), so Kimi caching is automatic. The cache-write price is therefore never applied on this route; if Bedrock bills unreported writes, the meter undercounts (M3 reconciliation) | Usage fields (counts only) read from `~/.dsh-local/sessions`; pi-ai `bedrock-converse-stream` source |
| How a local plugin resolves `@deepseek-ai/*` (`file:` vs `link:`) | The runtime resolver (`dsh-app-boot` profile-resolution bootstrap) routes every bare import named in the plugin's own `peerDependencies` to the installation copy, for both profile-layer (`file:`) and linked-root (`link:`) installs. `file:` copies only the packed `files`, never this folder's `node_modules`. Chosen form: `file:`. `link:` is also safe by the same rule, as long as every harness import stays a peer, but was not exercised | Resolver source; with the `file:` install, `appendPluginRecord` succeeded (it uses a private field of the harness `Session` class, which a second module copy would reject) and the agent loop's `instanceof LlmError` matched the plugin's error (headless printed `dsh: BUDGET_UNPRICED_MODEL: …` and `turn/end` carried that code instead of `UNKNOWN`) |
| Can a plugin add session event types? | Not safely through `SessionEventMap`: the session reader refuses a log holding an event type outside its built-in list unless the event is marked `ignorable`, and `Session.append` cannot set that marker. `appendPluginRecord` writes `plugin:<name>/…` records with `ignorable: true`. The plugin uses those | `dsh-session` `KNOWN_SESSION_EVENT_TYPES` and persistence admission; a scratch session with a `stop` record resumed with `--session-id` |
| Does a thrown `llm/stream` error get retried? | No. `agent/request-error` (where `llm-retry` acts) only sees `error` finish chunks; a listener throw ends the turn as `error` directly | `dsh-agent-loop` `step()`; offline guard run: no retry, `turn/end {kind: error}` |
| Which session id each metered call carries (0.2.0, rc.5) | Loop steps: the agent's session. Session titles: the session being titled (`purpose: session-title`). Compaction: the compacted agent's session (`purpose: compaction`). Subagents: dsh-subagent mints a fresh child id (`randomUUID`) and runs the child agent on its own session (header `origin: subagent`, `parentSession`), so its loop calls carry the child id; the plugin maps it to the parent through that header. A user fork sets `parentSession` without `origin`. The plugin's `agent/pre-step` listener also sees child agents: its context has no scope tag, and the scope filter passes such listeners for every agent. Only the experimental auto-review reviewer calls without a session id | Source of `dsh-agent-loop`, `dsh-session-title-llm`, `dsh-compaction-basic`, `dsh-subagent`, `dsh-scope`, `dsh-experimental-auto-review`. The real ledger from 30 October holds two subagent sessions (`57d5c73e…`, `88e33182…`) logged under their own ids, whose headers name `session-5b8f…` as parent |
| Does the composer pill know its conversation? | Yes. `conversation.input.right` is declared `scope: "session"`, and the session scope's built-in standard source gives every entry a `sessionId` prop, although the composer renders the slot with empty owner props. The pill sends it as `?session=` | Source of `dsh-client-ui-conversation`, `dsh-client-ui-renderer`, `dsh-client-ui-session` (rc.5). Not yet seen in a browser with 0.2.0 |
| Pricing page structure | Static HTML tables plus client-rendered `{priceOf}` cells backed by the public `meteredUnitMaps` feed (prices per 1K tokens, ×1000). DeepSeek-R1 and DeepSeek-V3.1 live in the client-rendered table, which is why a no-JavaScript read missed them | Live page and feed, 2026-10-28 |

## Smoke tests (2026-10-28)

These ran on 0.1.0, whose default was a daily window, so the messages below say `daily`.

Run in the `~/.dsh-local` headless profile with a temporary full `config:` block in its
`cordis.patch.yml` (removed afterwards; the file was restored byte-identical). The headless route is
`deepseek-official`, which was listed in `meter.providers` and priced with a config override for the
test. Test rows went to a scratch ledger, not the shared one.

| Test | Result |
|---|---|
| `limitUsd: 0.001`, test ledger seeded with $0.0042 of today's spend | Exit 1; stderr `dsh: budget: stopped: $0.0042 of $0.001 daily Bedrock budget used; …`; no model request |
| `warnAt: [0]`, empty test ledger | stderr `dsh: budget: 0% of $50.00 daily limit used ($0.00)`, then the run failed with `MISSING_CREDENTIAL` because no DeepSeek API key is set for headless in this shell (unrelated to the plugin) |

One real Bedrock call (2026-10-29) went through the headless profile with
the plugin at its defaults and the shared ledger. A one-run `--patch` overlay (no profile file
edited) re-enabled the harness credentials store, routed to `amazon-bedrock` /
`global.moonshotai.kimi-k3` capped at 2000 output tokens, and turned session titles off so only
one call was made:

```yaml
- id: credentials
  disabled: false
- id: session-title
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      amazon-bedrock:
        apiKeyEnv: AMAZON_BEDROCK_API_KEY
        models:
          - id: global.moonshotai.kimi-k3
            maxTokens: 2000
- id: agent-default-model
  config:
    provider: amazon-bedrock
    model: global.moonshotai.kimi-k3
```

Result: exit 0, one ledger row (`in` 4989, `out` 51, no cache) priced from `kimi-k3-global` at
$0.015732, matching the usage in the session log.

Offline end-to-end in a scratch `DSH_HOME`, with the plugin installed the same way and a local
mock OpenAI-compatible server behind the real pi-ai adapter: three runs at `limitUsd: 0.05` produced
priced rows (`$0.0141` each for 2000 input + 340 output + 10000 cache-read tokens at 3/15/0.30, for
both the loop call and the `session-title` call), a `56%` warning, and a stop on the third run;
`unpricedModel: block` produced `dsh: BUDGET_UNPRICED_MODEL: …` from the stream guard.

Git install (2026-10-30, dsh 0.2.1-rc.5, fresh scratch `DSH_HOME`): `plugin add
"git+file://…/dsh-bedrock-metering#v0.1.0"` copied exactly the published files and selected the
bundle, with no build step and no skip line at startup. A headless run with the stop test's
over-limit overlay exited 1 with the stop message and sent no model request. `add` with a newer tag
replaced the installed version in place, and `remove dsh-bedrock-metering` dropped both the
dependency and the bundle entry.

## Development

```bash
pnpm install
```

```bash
pnpm test
```

`pnpm test` compiles `src/` to `lib/` with `tsc` (TypeScript 7), type-checks the tests, and runs the
`node:test` suites in `test/` (pricing, conversation and calendar windows and thresholds, ledger
replay, hooks and the command, the status route and the browser pill) directly from TypeScript. The harness packages are `devDependencies` for types and tests
and `peerDependencies` at runtime. The dev copies are pinned (0.2.1-rc.5) so tests run against a known
version, and the peers are a range (`>=0.2.1-rc.2 <0.2.2-0`) so dsh accepts later 0.2.1 candidates.

Modules: `src/index.ts` (config schema, wiring), `src/pricing.ts`, `src/ledger.ts`, `src/budget.ts`
(pure, clock-injected), `src/runtime.ts` (shared per-process state and side effects),
`src/hooks.ts` (`llm/stream` meter and guard, `agent/pre-step` gate), `src/command.ts`,
`src/events.ts` (plugin record declarations), `src/web.ts` (status route and pill colour bands),
`client/budget-pill.js` (browser half).

To try a change before releasing it, install your checkout by absolute path; the `file:` form
copies only the published files (`lib/`, `client/`, `prices/`, `scripts/`, `cordis.patch.yml`,
`package.json`, this README, `LICENSE`), so run `pnpm build` and the `add` again after each change:

```bash
DSH_HOME=$HOME/.dsh-local npx -y @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile web add "file:$PWD"
```

### Releasing

1. Run `pnpm test`. It rebuilds `lib/`, which teammates install as committed.
2. Bump `version` in `package.json` (and the peer range, if the release supports a newer dsh).
3. Commit everything, `lib/` included, and tag the commit: `git tag -a v<version> -m v<version>`
   (annotated, so `--follow-tags` pushes it).
4. Push the branch and the tag: `git push --follow-tags`.
5. Tell the team the new tag, and the dsh version to pin if it changed.

Do not add a `prepare`, `prepack` or `install` script. pnpm runs those on every git install, and
dsh refuses dependency build scripts until each person approves them.

## Licence

MIT. See [LICENSE](LICENSE).
