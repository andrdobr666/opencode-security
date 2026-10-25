# OpenCode Security

OpenCode Security scans a repository or a change with a verified agent pipeline and can suggest patch files. The scan pipeline, report scripts, and agent prompts started from Anthropic's security plugin 0.12.0. This repo runs that pipeline inside [OpenCode](https://opencode.ai): specialists are OpenCode subagents, questions use OpenCode's question tool, and `workflows/scan.js` is executed by the `security_scan` tool so the verification tally is still computed in code.

## Install

Python 3.9 or newer must be on `PATH`. A git checkout is required to scan changes and to suggest patches. A whole-repository scan works without one.

This directory is the plugin. `opencode.json` here points OpenCode at it, so starting OpenCode in this repo loads the plugin. To use it in every project, add the directory to the `plugin` array in `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```json
{
  "plugin": ["opencode-models-discovery@latest", "/absolute/path/to/opencode-security"]
}
```

Install the plugin dependency once, next to `index.js`:

```sh
npm install
```

Restart OpenCode. In a session, run `/opencode-security`. You can also switch to the `opencode-security` agent.

`OPENCODE_SECURITY_CONCURRENCY` caps how many specialist sessions run at once (default 6). `OPENCODE_SECURITY_SCAN_TIP=off` stops the hint after `git push` or `gh pr create`. This port does not send Anthropic telemetry.

## What changed in this port

- `/opencode-security` is the menu. The jobs are the same: scan the codebase, scan a change, suggest patches.
- `security_scan` runs `workflows/scan.js` and waits until that run finishes. It writes `{ "result": ... }` for `scripts/save_result.py`.
- Researchers, verifiers, the redactor, and the patch agents are OpenCode subagents named `security-*`. The patch job dispatches them with the task tool.
- Report directories are `OPENCODE-SECURITY-<timestamp>/`.

The rest of this file describes what a scan does.

---

# OpenCode Security

Put a team of agents to work as security researchers on your codebase: map the architecture, build a threat model, hunt across every component, and independently verify every finding before it reaches the report. Then, if you want, turn the confirmed findings into suggested fixes delivered as targeted patch files you review and apply when you choose.

It runs entirely inside your OpenCode session — no separate process, no daemon.

## Recommended models

We recommend Opus 5.5 or Fable 5.1 for best performance. Pick a model using OpenCode's `/model` command.

In Opus 5.5 or Fable 5.1, portions of a scan may occasionally be downgraded to Opus 4.8. The rest of the scan will complete on your chosen model. Please share feedback with `/feedback` so we can keep improving our cybersecurity safeguards.

## Where it runs

A scan and a fix both run in your OpenCode session, under your permissions. The plugin reads the repository you have open the same way you would, and adds no isolation of its own: the directory's `.git/config`, its settings and hooks, and its instruction files all apply exactly as they would in any other session.

That makes it a natural fit for code you control — your own repositories, where the question is which bugs are in the code rather than whether the code is trying something. If you are scanning a repository that you do not trust, such as a third-party dependency or an unfamiliar repository, we suggest running the whole session inside [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime).

## Installation

OpenCode loads this directory as a plugin. The install steps are at the top of this file.


## Getting started

Run `/opencode-security` for the menu. It offers the three jobs the plugin does:

| Job | What it scans |
| --- | --- |
| **Scan codebase** | The whole repository, or a scoped part of it |
| **Scan changes** | This branch's diff, a pull request's diff (with its branch checked out), or one commit |
| **Suggest patches** | A report's findings, turned into patch files |

You can skip the menu. Type the job after the command (`/opencode-security scan my branch at high`) or ask in plain words ("run an OpenCode Security scan on the whole repo at medium"). A scan asks you once to confirm its time and token cost, unless your request already accepts it.

Everything happens in your session. A scan reports each stage as it starts, with the detail available by running `/workflows`, then assembles the report when the agents are done.

## Choosing scope and effort

Two things shape a scan: **scope**, how much of the tree it looks at, and **effort**, how much work it does there. Say what you want if you know; if you don't, the plugin works it out with you rather than making you guess.

It reads the repository before it asks — how large the tree is, which directories hold real code, what branch you are on, whether there is a diff to scan — so the choice you are offered is concrete, with the cost of each option stated, and every question carries an "I don't know" that resolves to a sensible default. It then says what it settled on before the work starts.

From there the scan sizes itself to the target. A narrow scope gets a pass proportionate to it, verified to the same standard: a thorough scan covers more ground, but every finding a quick scan does report has cleared the same verification bar. A large repository is scanned with attention on the code an attacker can reach, treating tests, fixtures and generated code as background rather than targets, plus a dedicated secrets pass that still checks fixtures for real committed keys. Unless you point the scan at it, a codebase scan is told to ignore vendored and installed third-party code, such as `node_modules` or a virtual environment: to read there only to understand your own code, and to report no finding there. A scan of changes still reviews a change to such code. A target with nothing in it is not scanned at all; the run says there is nothing to scan.

A scan of changes is a security review of the diff. It reports only flaws the change takes part in and leaves the rest to a scan of the codebase. For a feature-sized change, choose `high` effort.

## What a scan gives you

Every scan writes its results into a timestamped `OPENCODE-SECURITY-<timestamp>/` directory in the repository:

- **`OPENCODE-SECURITY-RESULTS.md`** — the human-readable report: each finding with its impact, exploit scenario, preconditions, severity (CRITICAL, HIGH, MEDIUM or LOW, assigned from exploitability and impact along the lines of the [CVSS v4.0](https://www.first.org/cvss/v4-0/specification-document) qualitative scale), confidence, and an outcome-focused recommendation.
- **`OPENCODE-SECURITY-RESULTS.jsonl`** — the same findings in machine-readable form, one JSON object per line. Each record carries a `opencodeSecurityPluginFindingId`, designed to stay the same from scan to scan so tooling can tell a known finding from a new one. The SARIF log carries the same id. Neither this file nor the SARIF log quotes the source line of a hard-coded credential finding, since that line is the credential; file, line and symbol locate it.
- **`OPENCODE-SECURITY-RESULTS.sarif`** — the same findings as a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) log for GitHub code scanning, IDE SARIF viewers, and other tooling that speaks the standard.
- **`OPENCODE-SECURITY-REVISION-<sha12>.json`** — the revision stamp: which commit was scanned, at what effort, the severity counts, and how thoroughly the run was verified. The filename carries `-dirty` when uncommitted changes were part of the scanned tree, so a report is always tied to the code it describes.

Once these files are written, an agent replaces each credential value it finds in the report, the JSONL and the SARIF log with `[REDACTED]`. It is a model's best effort, not a guarantee, so look over the files before you share them; if it fails or reports a file it could not clean, the scan says so.

That is the whole report — the run's working files are removed once it is written, so the directory holds only what you read. It carries its own `.gitignore`, so a stray `git add` never sweeps a report or a suggested patch into a commit; the report stays searchable where it sits, and if you want it in history, delete that one `.gitignore` and commit it like any other file.

A whole-repository scan accounts for the whole repository. Every top-level directory has to be either scanned or explicitly set aside with a reason — vendored code, generated code, documentation — and that accounting is checked before the search begins, not taken on trust. Whatever was left out, and why, is named in the report's Coverage section. A clean result tells you what was examined rather than leaving you to assume it.

## How a finding earns its place

However much effort a scan spends, a finding reaches the report only after surviving verification. Every candidate is handed to independent verifiers whose job is to disprove it, working from the code rather than from the report of it, and told to call it a false positive unless they can confirm a real path to exploitation. Findings that survive that are what you read; the rest are discarded, never shown. That is why the reports stay short.

A finding also cannot claim more confidence than its verification earned, nor, once two of the verifiers who confirmed it have rated it, a higher severity than they support, and the record of how thoroughly a run was verified is computed in code rather than asserted by the model that produced the findings — so the report's own account of its rigor is one you can check.

Throughout, what the repository says is evidence rather than instruction. Code, comments, and any instruction file in the tree are read as data under review, so text addressed to the scan is noted rather than obeyed. Under the trusted-code model this keeps the work anchored to the evidence; it is not a defense against a hostile repository.

Scans are nondeterministic. Two scans of the same code can surface different findings, and the same scan finds more over time as models improve; running scans regularly builds coverage. OpenCode Security reasons about code the way a human security researcher does, which complements SAST, dependency scanning, and code review rather than replacing them.

## Addressing vulnerabilities

"Suggest patches" from the menu turns a report's findings into patch files you apply when you choose — from an existing report you pick, or from a fresh scan it runs first. The report has to still describe the code you have: the plugin will not draft a fix against code the scan never saw, and it will tell you when a report has gone stale rather than patch from it.

Each fix is developed away from your working tree, in a scratch copy of the repository — your own checkout and index are never touched — and then reviewed by agents independent of the one that wrote it, including a review of your project's tests against the change and a fresh look at the diff on its own terms for anything new it might introduce.

A patch is written only when that review can vouch for three things: the change addresses that one finding, it introduces no new vulnerability, and it leaves the code's behaviour otherwise unchanged — and a change to which inputs the code accepts counts as a behaviour change. When it cannot vouch for all three, you get a short note explaining why instead of a patch. When the review marks the patched code as exercised by none of your project's tests, the patch notes that no project test of it was run, and its behaviour claim then rests on review rather than on a test run.

The patches land in the report's `patches/` folder: one `F<n>.patch` per finding, a short note beside each explaining the change and how to apply it (`git apply OPENCODE-SECURITY-<ts>/patches/F<n>.patch`), and an index. Nothing is applied for you — the job does not apply, commit, or push anything. If you want a patch applied or turned into a pull request, ask, and OpenCode does that as a separate request you can watch.

## Requirements

- OpenCode with this plugin installed
- Python 3.9 or newer on `PATH`
- A git checkout for scanning changes and suggesting patches — a whole-repository scan works without one

## Telemetry

This port does not send usage counts to Anthropic. `OPENCODE_SECURITY_SCAN_TIP=off` stops the hint after `git push` or `gh pr create`.

## Security

The trust model and how to report a vulnerability in the plugin itself are in [SECURITY.md](SECURITY.md).
