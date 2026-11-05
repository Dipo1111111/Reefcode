# REEF

A coding agent harness. One script, many tool calls.

REEF gives the model a small surface — a `script` tool that runs JavaScript in a sandbox with every
other tool reachable from inside it — instead of a dozen separate tool declarations. A turn becomes a
program instead of a single call, so work that took six round trips takes one.

```
npm install -g reef-harness
reef
```

## Install

```bash
npm install -g reef-harness      # or: pnpm add -g reef-harness
reef --version
```

From a checkout, without publishing:

```bash
cd code/reef
npm run build
scripts/package.sh --install            # builds build/reef-harness-<version>.tgz and installs it
```

Requires **Node 22 or newer**. The npm package bundles its own runtime; the only dependency it
resolves at install time is `quickjs-wasi`, the WebAssembly engine behind `script`.

## First run

```bash
reef login          # inside the TUI: pick a provider and authenticate
reef                # start a session in the current directory
reef -p "what does src/main.ts do"   # headless, prints the answer
```

Credentials live in `~/.reef/agent/auth.json`; API keys in the environment work too
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on). `reef auth` prints what is ready,
`reef doctor` prints everything else: node, bundle integrity, provider, skills, sessions.

Pick a model with `/model` in the TUI or `--model provider/id`. `--thinking low|medium|high`
sets reasoning effort. There is no per-model tuning — one prompt and one tool surface for all of them.

## The script tool

```js
// one turn, four tool calls
const pkg = JSON.parse(await tools.read({ path: "package.json" }));
const hits = await tools.bash({ command: "rg -n 'TODO' src | head -20" });
await tools.edit({ path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] });
await tools.write({ path: "notes.md", content: `# ${pkg.name}\n\n${hits}` });
```

Tools available inside a script: `bash`, `read`, `write`, `edit`, `exec`, `search`, plus `task` and
`task_output` when the tasks extension is enabled. `tools.shell` and `tools.exec` are aliases for
`bash`. `console.log` streams back; the script's last value is the result.

## Safety

Every tool call a script makes passes through the same permission engine as a direct call.

| Rule | Default |
|---|---|
| Tier | `medium` — reads and writes allowed, destructive shell asks |
| Blocked | `rm -rf /`, `curl \| sh`, `git push --force`, writes to `.env`, secret reads |
| Headless | asks are denied, never auto-approved |
| Override | `REEF_TIER=none\|low\|medium\|high`, `REEF_SKIP_APPROVALS=1` |

```bash
reef permissions list                 # effective policy and where each rule came from
reef permissions check "rm -rf build" # ask what would happen, without running it
reef permissions validate             # lint project policy files
```

Policy files: `~/.reef/agent/policy.json`, then project `./.reef/policy.json`, then
`./.reef/policy.local.json`. Precedence `builtin → user → project → local`; `block` beats `ask` beats
`allow`; a malformed file fails closed.

## Commands

| Command | What it does |
|---|---|
| `reef` | interactive session |
| `reef -p "<task>"` | one prompt, print, exit |
| `reef exec --list-tools` | what the model sees, and what the prompt costs |
| `reef exec` | headless JSON event stream (RPC v1) |
| `reef doctor` | install, provider and runtime report |
| `reef search` | search sessions |
| `reef permissions …` | inspect and lint the safety floor |
| `reef --list-models` | models this install can reach |
| `reef update` | update REEF, extensions and model catalogs |

Inside a session: `/cost` (spend and cache), `/context` (what a request contains), `/trace` (the
request compiler's budget report), `/model`, `/skills`, `/safety`, `/doctor`.

## Where things live

```
~/.reef/agent/
  settings.json     model, theme, extensions, footer facts
  auth.json         provider credentials
  sessions/         one JSONL per session
  skills/           skills, one directory each
  themes/           themes
```

Sessions are append-only JSONL. Resume with `reef -c` (most recent here) or `reef -r` (pick one).

## Efficiency, measured

Same model, same scenarios, script surface versus direct tools — the only difference is the engine:

| Suite | Script | Direct | Delta |
|---|---|---|---|
| micro (24 runs) | 6,288 tok · 2.79 req | 6,923 tok · 2.88 req | **−9.2% tokens** |
| real (16 runs) | 35,484 tok · 6.75 req | 43,865 tok · 8.13 req | **−19.1% tokens, −17% requests** |

Pass rates: 96% and 100%. Reproduce with `evals/run.mjs --suite micro --script off`.

## License

MIT. REEF is an independent project, not a distribution of, endorsed by, or affiliated with any other
harness. It is built on the vendored MIT-licensed pi core, pinned by commit; the exact changes are in
`vendor/pi.patch` and the attribution is in `NOTICE`.
