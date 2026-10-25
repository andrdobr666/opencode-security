import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const MARK = { running: "●", returned: "✓", failed: "✗" }

export function projectWorkflowDir(directory) {
  return join(directory, ".opencode", "security-workflows")
}

export function workflowStatusFile(id, dir) {
  const safe = String(id || "scan").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "scan"
  return join(dir, `${safe}.json`)
}

function clock(value) {
  return typeof value === "string" ? value.slice(11, 19) : ""
}

const PHASE_ORDER = ["Inventory", "Threat model", "Research", "Sweep", "Panel"]
const STATUS_WORD = { running: "Running", returned: "Completed", failed: "Failed" }

function scanGroup(scan) {
  const repo = basename(scan.directory || "project")
  const bits = [repo]
  if (scan.scope) bits.push(String(scan.scope))
  if (scan.effort) bits.push(String(scan.effort))
  const id = String(scan.id || "").slice(-4)
  if (id) bits.push(id)
  return bits.join(" · ")
}

export function formatTokens(value) {
  const n = Number(value) || 0
  if (n <= 0) return ""
  if (n < 1000) return `${Math.round(n)} tok`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`
  return `${(n / 1_000_000).toFixed(1)}m tok`
}

export function formatDuration(startedAt, finishedAt, now = Date.now()) {
  const start = Date.parse(startedAt || "")
  if (!Number.isFinite(start)) return ""
  const end = finishedAt ? Date.parse(finishedAt) : now
  if (!Number.isFinite(end) || end < start) return ""
  const sec = Math.round((end - start) / 1000)
  const seconds = sec % 60
  const minutes = Math.floor(sec / 60) % 60
  const hours = Math.floor(sec / 3600) % 24
  const days = Math.floor(sec / 86400)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (Math.floor(sec / 60) > 0) return `${Math.floor(sec / 60)}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function taskPhase(task) {
  if (task?.phase) return String(task.phase)
  const label = String(task?.label || "")
  if (label.startsWith("model:")) return "Threat model"
  if (label.startsWith("research:") || label.startsWith("boundary:") || label.startsWith("load:changed")) return "Research"
  if (label.startsWith("sweep:")) return "Sweep"
  if (label.startsWith("panel:") || label.startsWith("load:")) return "Panel"
  if (label.startsWith("inventory")) return "Inventory"
  return ""
}

function phaseOf(task, scan) {
  return taskPhase(task) || scan?.phase || "starting"
}

function scanTasks(scan) {
  return Array.isArray(scan?.tasks) ? scan.tasks.filter(Boolean) : []
}

function tasksInPhase(scan, phase) {
  return scanTasks(scan).filter((task) => phaseOf(task, scan) === phase)
}

function visiblePhases(scan) {
  const named = Array.isArray(scan?.phases) ? scan.phases.filter(Boolean) : []
  const fromTasks = scanTasks(scan).map((task) => phaseOf(task, scan))
  const seen = new Set()
  const ordered = []
  for (const name of [...PHASE_ORDER, ...named, ...fromTasks]) {
    if (!name || seen.has(name)) continue
    if (!named.includes(name) && !fromTasks.includes(name)) continue
    seen.add(name)
    ordered.push(name)
  }
  return ordered.filter((phase) => tasksInPhase(scan, phase).length > 0 || scan?.phase === phase)
}

function phaseCounts(tasks) {
  const done = tasks.filter((task) => task.status === "returned" || task.status === "failed").length
  return { done, total: tasks.length }
}

function phaseMark(phase, tasks, scan) {
  if (tasks.some((task) => task.status === "running")) return MARK.running
  if (!tasks.length && scan?.phase === phase && scan?.state !== "finished" && scan?.state !== "failed" && scan?.state !== "not-started") {
    return MARK.running
  }
  if (tasks.some((task) => task.status === "returned")) return MARK.returned
  if (tasks.length && tasks.every((task) => task.status === "failed")) return MARK.failed
  return "·"
}

function workLine(task) {
  const activity = Array.isArray(task?.activity) ? task.activity.at(-1) : ""
  if (task?.status === "running") return activity || task?.prompt || ""
  if (task?.status === "failed") return task?.detail || task?.outcome || activity || ""
  return task?.outcome || activity || task?.prompt || ""
}

function taskStats(task, now) {
  const tools = Number(task?.toolCount) > 0 ? `${task.toolCount} tools` : ""
  return [task?.model, formatTokens(task?.tokens), formatDuration(task?.startedAt, task?.finishedAt, now), tools]
    .filter(Boolean)
    .join(" · ")
}

function phaseBlurb(phase, tasks, scan) {
  const running = tasks.filter((task) => task.status === "running")
  const failed = tasks.filter((task) => task.status === "failed")
  if (!tasks.length) return scan?.phase === phase ? "starting" : "not started"
  if (running.length) {
    const head = running.at(-1)
    const doing = workLine(head)
    return `${running.length} running · ${head?.label || "agent"}${doing ? ` — ${doing}` : ""}`
  }
  if (failed.length) {
    const finished = tasks.length - failed.length
    return finished ? `${failed.length} failed · ${finished} finished` : `${failed.length} failed`
  }
  return `${tasks.length} finished`
}

function phaseProgress(phase, tasks) {
  const { done, total } = phaseCounts(tasks)
  return total ? `${phase}  ${done}/${total}` : phase
}

export function progressLine(status, now = Date.now()) {
  if (!status || typeof status !== "object") return "starting"
  const phase = status.phase || "starting"
  const tasks = tasksInPhase(status, phase)
  const { done, total } = phaseCounts(tasks)
  const count = total ? ` ${done}/${total}` : ""
  const head = tasks.filter((task) => task.status === "running").at(-1)
  const doing = head ? workLine(head) : ""
  const who = head?.label ? `${head.label}${doing ? ` — ${doing}` : ""}` : ""
  return `${phase}${count}${who ? ` · ${who}` : ""}`.replace(/\s+/g, " ").trim().slice(0, 140)
}

export function formatWorkflowStatus(status, now = Date.now()) {
  if (!status || typeof status !== "object") return "No security scan has reported status yet."
  const when = clock(status.updatedAt)
  const phases = Array.isArray(status.phases) ? status.phases.filter(Boolean) : []
  const tasks = scanTasks(status)
  const running = tasks.filter((task) => task?.status === "running")
  const recent = tasks.filter((task) => task?.status && task.status !== "running").slice(-10)
  const log = Array.isArray(status.log) ? status.log.slice(-6) : []
  const lines = [
    `${status.phase || "starting"} · ${status.state || "running"}${when ? ` · ${when} UTC` : ""}`,
  ]
  if (phases.length) lines.push(phases.join(" → "))
  if (status.directory) lines.push(String(status.directory))
  lines.push(`active ${Number(status.active) || 0} · waiting ${Number(status.waiting) || 0}`)
  const shown = visiblePhases(status)
  if (shown.length) {
    lines.push("", "phases")
    for (const phase of shown) {
      const group = tasksInPhase(status, phase)
      const blurb = phaseBlurb(phase, group, status)
      lines.push(`  ${phaseMark(phase, group, status)}  ${phaseProgress(phase, group)}${blurb ? ` — ${blurb}` : ""}`)
    }
  }
  lines.push("", "running")
  if (running.length === 0) lines.push("  (none)")
  for (const task of running) {
    const doing = workLine(task)
    const stats = taskStats(task, now)
    const extra = [stats, doing].filter(Boolean).join(" — ")
    lines.push(`  ${MARK.running}  ${task.label}  ${task.agent || ""}${extra ? ` — ${extra}` : ""}`.trimEnd())
  }
  lines.push("", "recent")
  if (recent.length === 0) lines.push("  (none)")
  for (const task of recent) {
    const mark = MARK[task.status] || "·"
    const detail = task.status === "failed" && task.detail ? ` — ${String(task.detail).slice(0, 140)}` : ""
    lines.push(`  ${mark}  ${task.label}: ${task.status}${detail}`)
  }
  if (log.length) {
    lines.push("", "narrator")
    for (const line of log) lines.push(`  ${line}`)
  }
  return lines.join("\n")
}

export function taskDetail(task, scan, now = Date.now()) {
  const statusWord = STATUS_WORD[task?.status] || task?.status || "unknown"
  const lines = [statusWord, task?.agent || "specialist"]
  const stats = taskStats(task, now)
  if (stats) lines.push(stats)
  const doing = task?.status === "running" ? workLine(task) : ""
  if (doing) lines.push(doing)
  const phase = phaseOf(task, scan)
  if (phase) lines.push(`stage ${phase}`)
  const meta = [scan?.mode, scan?.effort, scan?.scope].filter(Boolean).join(" · ")
  if (meta) lines.push(meta)
  if (task?.sessionID) lines.push(`session ${task.sessionID}`)
  const started = clock(task?.startedAt)
  if (started) lines.push(`started ${started} UTC`)
  if (task?.prompt) lines.push("", `Prompt${task.promptLines ? ` · ${task.promptLines} lines` : ""}`, task.prompt)
  const activity = Array.isArray(task?.activity) ? task.activity.filter(Boolean) : []
  if (activity.length) {
    const shown = activity.slice(-3)
    lines.push("", `Activity · last ${shown.length} of ${Number(task.toolCount) || activity.length}`)
    for (const line of shown) lines.push(`  ${line}`)
  }
  if (task?.outcome || task?.outcomeBody) {
    lines.push("", "Outcome")
    if (task.outcome) lines.push(task.outcome)
    if (task.outcomeBody && task.outcomeBody !== task.outcome) lines.push(task.outcomeBody)
  }
  if (task?.detail) lines.push("", String(task.detail))
  if (scan?.directory) lines.push("", String(scan.directory))
  lines.push("", "Enter returns to the board.")
  return lines.join("\n")
}

export function phaseDetail(phase, scan, now = Date.now()) {
  const tasks = tasksInPhase(scan, phase)
  const lines = [
    `${phaseMark(phase, tasks, scan)}  ${phaseProgress(phase, tasks)}`,
    phaseBlurb(phase, tasks, scan),
  ]
  const ranked = tasks.map((task, index) => ({ task, index }))
  ranked.sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index)
  if (ranked.length) lines.push("")
  for (const { task } of ranked) {
    const mark = MARK[task.status] || "·"
    const stats = taskStats(task, now)
    const doing = workLine(task)
    lines.push(`${mark}  ${task.label}`)
    const extra = [task.agent, stats, doing].filter(Boolean).join(" · ")
    if (extra) lines.push(`   ${extra}`)
  }
  if (!ranked.length) lines.push("", "No agent has been dispatched for this phase yet.")
  lines.push("", "Enter returns to the board.")
  return lines.join("\n")
}

function rank(task) {
  if (task?.status === "running") return 0
  if (task?.status === "failed") return 2
  return 1
}

export function findingDetail(finding) {
  const votes = Array.isArray(finding?.votes) ? finding.votes : []
  const confirmed = votes.filter((vote) => vote.verdict === "TRUE_POSITIVE").length
  const where = [finding?.file, finding?.line].filter((part) => part !== undefined && part !== "").join(":")
  const lines = [
    finding?.title || finding?.cid || "candidate",
    [where, finding?.severity, finding?.cweId, finding?.symbol].filter(Boolean).join(" · "),
    `${confirmed} true of ${votes.length} vote(s) returned`,
  ]
  if (finding?.rationale) lines.push("", "description", finding.rationale)
  if (finding?.snippet) lines.push("", "sink line", finding.snippet)
  if (finding?.evidence) lines.push("", "evidence", finding.evidence)
  if (finding?.viaChange) lines.push("", "change", finding.viaChange)
  lines.push("", "votes")
  if (votes.length === 0) lines.push("  (none yet)")
  for (const vote of votes) {
    lines.push(`  v${vote.voter} ${vote.verdict}${vote.reasoning ? ` — ${vote.reasoning}` : ""}`)
  }
  lines.push("", "A candidate is kept only after the panel finishes.", "Enter returns to the board.")
  return lines.join("\n")
}

function scanKey(scan) {
  return String(scan?.id || scan?.directory || "scan")
}

export function workflowBoard(scans, now = Date.now()) {
  if (!scans?.length) {
    return {
      title: "Workflows",
      empty: "No scan is running in this project. Start one with /opencode-security.",
      options: [],
    }
  }
  const options = []
  for (const scan of scans) {
    const group = scanGroup(scan)
    const key = scanKey(scan)
    for (const phase of visiblePhases(scan)) {
      const groupTasks = tasksInPhase(scan, phase)
      const blurb = phaseBlurb(phase, groupTasks, scan)
      options.push({
        title: `${phaseMark(phase, groupTasks, scan)}  ${phaseProgress(phase, groupTasks)}`,
        description: blurb.slice(0, 180),
        category: `${group} · phases`,
        value: { type: "phase", key: `phase:${key}:${phase}`, phase, scan },
      })
      const ranked = groupTasks.map((task, index) => ({ task, index }))
      ranked.sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index)
      for (const { task } of ranked) {
        const mark = MARK[task.status] || "·"
        const stats = taskStats(task, now)
        const doing = workLine(task)
        options.push({
          title: `${mark}  ${task.label}`,
          description: [stats, doing].filter(Boolean).join(" · ").slice(0, 200),
          category: `${group} · ${phaseProgress(phase, groupTasks)}`,
          value: {
            type: "task",
            key: `task:${key}:${task.label}:${task.startedAt || ""}`,
            task,
            scan,
          },
          ...(doing ? { footer: String(doing).slice(0, 200) } : {}),
        })
      }
    }
    const findings = Array.isArray(scan.findings) ? scan.findings : []
    for (const finding of findings) {
      const votes = Array.isArray(finding.votes) ? finding.votes : []
      const confirmed = votes.filter((vote) => vote.verdict === "TRUE_POSITIVE").length
      const where = [finding.file, finding.line].filter((part) => part !== undefined && part !== "").join(":")
      options.push({
        title: `${finding.cid}  ${finding.title || ""}`.trim(),
        description: [finding.rationale, where, finding.severity, `${confirmed} true / ${votes.length} votes`]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 180),
        category: `${group} · candidates`,
        value: { type: "finding", key: `finding:${key}:${finding.cid}`, finding, scan },
      })
    }
  }
  const when = clock(scans[0]?.updatedAt)
  const title =
    scans.length === 1
      ? `Workflows · ${progressLine(scans[0], now)}${when ? ` · ${when}` : ""}`
      : `Workflows · ${scans.length} scans${when ? ` · ${when}` : ""}`
  return { title, empty: "", options }
}

export function workflowModel(scans, now = Date.now()) {
  const sections = []
  for (const scan of scans || []) {
    const group = scanGroup(scan)
    const key = scanKey(scan)
    for (const phase of visiblePhases(scan)) {
      const tasks = tasksInPhase(scan, phase)
      const counts = phaseCounts(tasks)
      const ranked = tasks.map((task, index) => ({ task, index }))
      ranked.sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index)
      sections.push({
        key: `phase:${key}:${phase}`,
        group,
        mark: phaseMark(phase, tasks, scan),
        name: phase,
        count: counts.total ? `${counts.done}/${counts.total}` : "",
        blurb: phaseBlurb(phase, tasks, scan),
        items: ranked.map(({ task }) => ({
          key: `task:${key}:${task.label}:${task.startedAt || ""}`,
          mark: MARK[task.status] || "·",
          label: String(task.label || task.agent || "agent"),
          stats: taskStats(task, now),
          description: workLine(task),
          detail: taskDetail(task, scan, now),
        })),
      })
    }
    const findings = Array.isArray(scan.findings) ? scan.findings : []
    if (findings.length) {
      sections.push({
        key: `candidates:${key}`,
        group,
        mark: "·",
        name: "Candidates",
        count: String(findings.length),
        blurb: `${findings.length} candidate(s) under review`,
        items: findings.map((finding) => ({
          key: `finding:${key}:${finding.cid}`,
          mark: "·",
          label: `${finding.cid}  ${finding.title || ""}`.trim(),
          stats: [finding.severity, finding.file && finding.line ? `${finding.file}:${finding.line}` : finding.file]
            .filter(Boolean)
            .join(" · "),
          description: String(finding.rationale || "").replace(/\s+/g, " ").trim(),
          detail: findingDetail(finding),
        })),
      })
    }
  }
  const when = clock(scans?.[0]?.updatedAt)
  const title = !scans?.length
    ? "Workflows"
    : scans.length === 1
      ? `Workflows · ${progressLine(scans[0], now)}${when ? ` · ${when}` : ""}`
      : `Workflows · ${scans.length} scans${when ? ` · ${when}` : ""}`
  return {
    title,
    empty: scans?.length ? "" : "No scan is running in this project. Start one with /opencode-security.",
    sections,
  }
}

function writeGitignore(dir) {
  const ignore = join(dir, ".gitignore")
  try {
    writeFileSync(ignore, "*\n!.gitignore\n", { flag: "wx" })
  } catch {
    // The ignore file is already in place.
  }
}

export function writeWorkflowStatus(status, file) {
  const directory = status?.directory
  const target =
    file ||
    (directory
      ? workflowStatusFile(status.id || status.parentSessionID, projectWorkflowDir(directory))
      : null)
  if (!target) throw new Error("workflow status needs a project directory")
  const body = { ...status, text: formatWorkflowStatus(status) }
  mkdirSync(dirname(target), { recursive: true })
  writeGitignore(dirname(target))
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(body, null, 2))
  renameSync(tmp, target)
  return target
}

export function readWorkflowStatuses(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const scans = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const status = JSON.parse(readFileSync(join(dir, name), "utf8"))
      if (status && typeof status === "object") scans.push(status)
    } catch {
      // Skip a file another scan is still replacing.
    }
  }
  scans.sort((a, b) => {
    const rank = (state) => (state === "running" ? 0 : 1)
    const byState = rank(a.state) - rank(b.state)
    if (byState) return byState
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  })
  const running = scans.filter((status) => status.state === "running")
  const finished = scans.filter((status) => status.state !== "running").slice(0, 5)
  return [...running, ...finished]
}

export function formatWorkflowList(scans, now = Date.now()) {
  if (!scans?.length) {
    return "No security scans are reporting status in this project. Start one with /opencode-security."
  }
  const blocks = scans.map((status, index) => {
    const body = formatWorkflowStatus(status, now)
    if (scans.length === 1) return body
    return `scan ${index + 1} of ${scans.length}\n${body}`
  })
  return blocks.join("\n\n")
}
