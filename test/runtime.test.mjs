import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseJsonObject } from "../opencode/json-result.js"
import { loadAgentConfigs } from "../opencode/agents.js"
import { modelFromMessages } from "../opencode/runtime.js"
import { notePanel, panelClaim } from "../opencode/panel-findings.js"
import { summarizeSession } from "../opencode/session-activity.js"
import { createRuntime } from "../opencode/runtime.js"
import { findingDetail, formatWorkflowList, formatWorkflowStatus, phaseDetail, projectWorkflowDir, readWorkflowStatuses, taskDetail, workflowBoard, writeWorkflowStatus } from "../opencode/workflow-status.js"
import { runScan } from "../opencode/scan-runner.js"

const exec = promisify(execFile)
const root = fileURLToPath(new URL("..", import.meta.url))
const scanPath = join(root, "workflows", "scan.js")
const scripts = join(root, "scripts")

function runtime(agent) {
  const logs = []
  return {
    logs,
    agent,
    async parallel(thunks) {
      return Promise.all(thunks.map((thunk) => thunk()))
    },
    async pipeline(items, ...stages) {
      return Promise.all(
        items.map(async (item) => {
          let value = item
          for (const stage of stages) value = await stage(value)
          return value
        }),
      )
    },
    phase(title) {
      logs.push(`phase:${title}`)
    },
    log(message) {
      logs.push(String(message))
    },
  }
}

test("panel votes accumulate on the candidate shown in workflows", () => {
  const prompt = `<untrusted-finding>
file: api/users.py
line: 40
cwe as reported: CWE-89
severity as reported: HIGH
title: SQL injection in login
rationale: The query concatenates the request body.
evidence as cited by the reporter: query = "SELECT * FROM users WHERE name='" + name + "'"
sink line as quoted by the reporter: cursor.execute(query)
enclosing symbol: login
reported independently by 1 researcher pass(es)
</untrusted-finding>`
  assert.equal(panelClaim(prompt).title, "SQL injection in login")
  let findings = notePanel([], "panel:C19:v1", prompt, null)
  findings = notePanel(findings, "panel:C19:v1", prompt, { verdict: "TRUE_POSITIVE", reasoning: "sink confirmed" })
  findings = notePanel(findings, "panel:C19:v2", prompt, { verdict: "FALSE_POSITIVE", reasoning: "query is parameterized" })
  assert.equal(findings.length, 1)
  assert.deepEqual(
    findings[0].votes.map((vote) => vote.verdict),
    ["TRUE_POSITIVE", "FALSE_POSITIVE"],
  )
  const board = workflowBoard([{ directory: "/repo", phase: "Panel", state: "running", findings, tasks: [], phases: ["Panel"] }])
  assert.ok(board.options.some((option) => option.category.endsWith("candidates") && option.title.includes("C19")))
  assert.match(findingDetail(findings[0]), /1 true of 2 vote/)
  assert.match(findingDetail(findings[0]), /description\nThe query concatenates/)
  assert.match(findingDetail(findings[0]), /sink line\ncursor.execute/)
  assert.match(findingDetail(findings[0]), /evidence\nquery = /)
  assert.match(findingDetail(findings[0]), /sink confirmed/)
  const row = board.options.find((option) => option.title.includes("C19"))
  assert.match(row.description, /concatenates the request body/)
})

test("workflow status lists the phase and the specialists still running", async () => {
  const status = {
    updatedAt: "2026-10-11T14:25:01.000Z",
    directory: "/repo",
    state: "running",
    phase: "Research",
    phases: ["Inventory", "Threat model", "Research"],
    active: 2,
    waiting: 1,
    tasks: [
      { label: "inventory", agent: "security-inventory", status: "returned" },
      { label: "research:api-web:auth", agent: "security-researcher", status: "running" },
      { label: "research:api-web:crypto", agent: "security-researcher", status: "failed", detail: "timed out" },
    ],
    log: ["Research"],
  }
  const text = formatWorkflowStatus(status)
  assert.match(text, /Research · running · 14:25:01 UTC/)
  assert.match(text, /Inventory → Threat model → Research/)
  assert.match(text, /●  research:api-web:auth  security-researcher/)
  assert.match(text, /✓  inventory: returned/)
  assert.match(text, /✗  research:api-web:crypto: failed — timed out/)
  assert.match(text, /Inventory\s+1\/1/)
  assert.match(text, /Research\s+1\/2/)
  assert.match(text, /1 running · research:api-web:auth/)

  const project = await mkdtemp(join(tmpdir(), "workflow-project-"))
  const stored = { ...status, id: "ses_proj", directory: project }
  const written = writeWorkflowStatus(stored)
  assert.equal(written, join(projectWorkflowDir(project), "ses_proj.json"))
  const saved = JSON.parse(await readFile(written, "utf8"))
  assert.equal(saved.text, formatWorkflowStatus(stored))
  const ignore = await readFile(join(projectWorkflowDir(project), ".gitignore"), "utf8")
  assert.match(ignore, /^\*\n/)

  const board = workflowBoard([
    status,
    { ...status, id: "ses_b", directory: "/repo-b", phase: "Inventory", state: "running", updatedAt: "2026-10-11T14:26:00.000Z" },
  ])
  assert.match(board.title, /2 scans/)
  assert.ok(board.options.some((option) => option.title.includes("research:api-web:auth")))
  assert.match(taskDetail(status.tasks[2], status), /timed out/)
  assert.match(taskDetail(status.tasks[2], status), /Enter returns to the board/)

  const dir2 = await mkdtemp(join(tmpdir(), "workflow-status-"))
  writeWorkflowStatus({ ...status, id: "ses_a", directory: "/repo-a", phase: "Research" }, join(dir2, "ses_a.json"))
  writeWorkflowStatus(
    { ...status, id: "ses_b", directory: "/repo-b", phase: "Inventory", updatedAt: "2026-10-11T14:26:00.000Z" },
    join(dir2, "ses_b.json"),
  )
  const listed = formatWorkflowList(readWorkflowStatuses(dir2))
  assert.match(listed, /scan 1 of 2/)
  assert.match(listed, /\/repo-a/)
  assert.match(listed, /\/repo-b/)
  assert.match(listed, /Inventory · running/)
})

test("workflow board shows phase progress and what each agent is doing", () => {
  const now = Date.parse("2026-10-11T14:30:20.000Z")
  const scan = {
    id: "ses_scan",
    directory: "/repo",
    phase: "Research",
    state: "running",
    phases: ["Inventory", "Threat model", "Research"],
    tasks: [
      {
        label: "inventory",
        agent: "security-inventory",
        phase: "Inventory",
        status: "returned",
        outcome: "4 component(s) · api",
        startedAt: "2026-10-11T14:20:00.000Z",
        finishedAt: "2026-10-11T14:21:05.000Z",
      },
      {
        label: "research:api:injection",
        agent: "security-researcher",
        phase: "Research",
        status: "running",
        model: "beast/big",
        tokens: 176800,
        toolCount: 12,
        startedAt: "2026-10-11T14:20:00.000Z",
        prompt: "Hunt for vulnerabilities in one component, through one category lens.",
        promptLines: 44,
        activity: ["Read(core/request_pin.py)", "Bash(grep -n pin core/request_pin.py)"],
      },
    ],
  }
  const board = workflowBoard([scan], now)
  assert.match(board.title, /Research 0\/1/)
  assert.match(board.title, /research:api:injection/)
  assert.match(board.title, /grep -n pin/)
  const phase = board.options.find((option) => option.value.type === "phase" && option.value.phase === "Research")
  assert.match(phase.title, /Research\s+0\/1/)
  assert.match(phase.description, /1 running · research:api:injection/)
  assert.match(phase.description, /grep -n pin/)
  const agent = board.options.find((option) => option.title.includes("research:api:injection"))
  assert.equal(agent.category.endsWith("Research  0/1"), true)
  assert.match(agent.description, /beast\/big/)
  assert.match(agent.description, /176\.8k tok/)
  assert.match(agent.description, /10m20s/)
  assert.match(agent.description, /12 tools/)
  assert.match(agent.description, /grep -n pin/)
  const detail = taskDetail(scan.tasks[1], scan, now)
  assert.match(detail, /Running/)
  assert.match(detail, /Prompt · 44 lines/)
  assert.match(detail, /Hunt for vulnerabilities/)
  assert.match(detail, /Activity · last 2 of 12/)
  assert.match(detail, /Bash\(grep -n pin/)
  assert.match(phaseDetail("Research", scan, now), /grep -n pin/)
  assert.match(phaseDetail("Sweep", { ...scan, phase: "Sweep", tasks: [] }, now), /starting/)
})

test("session activity keeps the model, tokens, and recent tool calls", () => {
  const snap = summarizeSession([
    {
      info: {
        role: "assistant",
        providerID: "beast",
        modelID: "big",
        tokens: { input: 80000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "grep -n pin core/request_pin.py" } } },
        { type: "text", text: "looking" },
      ],
    },
    {
      type: "assistant",
      model: { providerID: "beast", modelID: "big" },
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "tool", name: "read", state: { status: "running", title: "core/request_pin.py" } }],
    },
  ])
  assert.equal(snap.model, "beast/big")
  assert.equal(snap.tokens, 82000)
  assert.equal(snap.toolCount, 2)
  assert.deepEqual(snap.activity, ["Bash(grep -n pin core/request_pin.py)", "Read(core/request_pin.py)"])
})

test("a running specialist publishes its phase, prompt, and live tool use", async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const seen = []
  const client = {
    session: {
      async create() {
        return { data: { id: "ses_child" } }
      },
      async messages() {
        return {
          data: [
            {
              info: {
                role: "assistant",
                providerID: "beast",
                modelID: "big",
                tokens: { input: 170000, output: 6800, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [
                {
                  type: "tool",
                  tool: "bash",
                  state: { status: "running", input: { command: "grep -n pin core/request_pin.py" } },
                },
              ],
            },
          ],
        }
      },
      async prompt() {
        await gate
        return {
          data: {
            info: {
              role: "assistant",
              providerID: "beast",
              modelID: "big",
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: '{"findings":[]}' }],
          },
        }
      },
      async abort() {},
    },
  }
  const runtime = createRuntime({
    client,
    directory: "/repo",
    concurrency: 1,
    pollMs: 250,
    onProgress(event) {
      seen.push(event)
    },
  })
  const pending = runtime.agent("Hunt for vulnerabilities in one component.", {
    label: "research:api:injection",
    phase: "Research",
    agentType: "security-researcher",
  })
  try {
    const start = Date.now()
    let live
    while (Date.now() - start < 2000) {
      live = [...seen].reverse().find((event) => event.tasks?.some((task) => task.activity?.length))
      if (live) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!live) throw new Error("specialist activity was not published")
    const task = live.tasks.find((item) => item.label === "research:api:injection")
    assert.equal(task.phase, "Research")
    assert.equal(task.status, "running")
    assert.match(task.prompt, /Hunt for vulnerabilities/)
    assert.equal(task.model, "beast/big")
    assert.equal(task.tokens, 176800)
    assert.match(task.activity.at(-1), /grep -n pin/)
  } finally {
    release()
  }
  const parsed = await pending
  assert.deepEqual(parsed, { findings: [] })
  const done = seen.at(-1).tasks.find((item) => item.label === "research:api:injection")
  assert.equal(done.status, "returned")
  assert.equal(done.outcome, "no findings")
  assert.match(done.activity.at(-1), /grep -n pin/)
})

test("modelFromMessages keeps a slashed model id intact", () => {
  const model = modelFromMessages([
    { info: { role: "assistant", providerID: "openrouter", modelID: "old" } },
    { info: { role: "user", model: { providerID: "beast", modelID: "beast/big" } } },
  ])
  assert.deepEqual(model, { providerID: "beast", modelID: "beast/big" })
  assert.equal(modelFromMessages([]), undefined)
})

test("parseJsonObject accepts a fenced object", () => {
  assert.deepEqual(parseJsonObject('note\n```json\n{"findings":[]}\n```'), { findings: [] })
  assert.equal(parseJsonObject("no object here"), null)
})

test("agent prompts are registered under OpenCode names", async () => {
  const agents = await loadAgentConfigs(root)
  assert.equal(agents["opencode-security"].mode, "primary")
  assert.equal(agents["security-researcher"].mode, "subagent")
  assert.equal(agents["security-loader"].permission.bash, "deny")
  assert.equal(agents["security-researcher"].permission.edit, "deny")
  assert.match(agents["security-researcher"].prompt, /security-explore/)
  assert.match(agents["opencode-security"].prompt, /security_scan/)
})

test("scan.js refuses a bare invocation without dispatching", async () => {
  let calls = 0
  const result = await runScan(scanPath, {}, runtime(async () => {
    calls += 1
    return { findings: [] }
  }))
  assert.equal(result.started, false)
  assert.equal(result.reason, "no-args")
  assert.equal(calls, 0)
})

test("scan.js refuses an unknown effort tier", async () => {
  const result = await runScan(
    scanPath,
    { scanRoot: "/tmp", runDir: "/tmp", mode: "scan", effort: "extreme" },
    runtime(async () => ({ findings: [] })),
  )
  assert.equal(result.started, false)
  assert.equal(result.reason, "unknown-effort")
})

test("a low-effort scan with no findings records through save_result.py", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-security-"))
  const repo = join(dir, "repo")
  const runDir = join(repo, "OPENCODE-SECURITY-test", ".opencode-security-run")
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, "app.py"), "print('hello')\n")
  await exec("git", ["init"], { cwd: repo })
  await exec("git", ["add", "app.py"], { cwd: repo })
  await exec("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init"], { cwd: repo })
  await mkdir(runDir, { recursive: true })
  await exec("python3", [join(scripts, "write_scan_meta.py"), runDir, repo, "--mode", "scan", "--effort", "low"])

  const calls = []
  const result = await runScan(
    scanPath,
    {
      scanRoot: repo,
      runDir,
      mode: "scan",
      effort: "low",
      scope: null,
      range: null,
      changedFileCount: null,
      changedFiles: null,
      diffLineCount: null,
      scopeFileCount: null,
      fileCount: 1,
      topLevelDirs: null,
      dirFileCounts: null,
      focus: null,
    },
    runtime(async (_prompt, opts) => {
      calls.push(opts.agentType)
      return { findings: [] }
    }),
  )

  assert.deepEqual(calls, ["opencode-security:scan-researcher"])
  assert.equal(result.findings.length, 0)
  assert.equal(result.votes.provenance, "workflows/scan.js")
  assert.equal(result.runDir, runDir)

  const outputFile = join(runDir, "workflow-output.json")
  await writeFile(outputFile, JSON.stringify({ result }))
  const saved = await exec("python3", [join(scripts, "save_result.py"), outputFile, runDir])
  assert.match(saved.stdout, /0 findings/)
  assert.match(saved.stdout, /next: write OPENCODE-SECURITY-RESULTS.md/)
})
