import { AGENT_TYPE_MAP, toolsFor } from "./agents.js"
import { parseJsonObject, textFromMessage } from "./json-result.js"
import { notePanel } from "./panel-findings.js"
import { outcomeBody, outcomeSummary, promptExcerpt, summarizeSession } from "./session-activity.js"

const DEFAULT_CONCURRENCY = 6
const DEFAULT_STALL_MS = 600_000

function unwrap(result) {
  if (!result) throw new Error("OpenCode returned an empty response")
  if (result.error) {
    const error = result.error
    const message = error.message || error.data?.message || JSON.stringify(error)
    throw new Error(String(message).slice(0, 500))
  }
  return result.data ?? result
}

// OpenCode parses a model string on the first slash. A model id that itself
// contains a slash, such as beast/big under provider beast, then looks up the
// wrong key. The parent session already stores the pair separately.
export function modelFromMessages(rows) {
  const list = Array.isArray(rows) ? rows : []
  for (let i = list.length - 1; i >= 0; i--) {
    const info = list[i]?.info ?? list[i]
    if (!info || typeof info !== "object") continue
    const user = info.model
    if (info.role === "user" && user?.providerID && user?.modelID) {
      return { providerID: String(user.providerID), modelID: String(user.modelID) }
    }
    if (info.role === "assistant" && info.providerID && info.modelID) {
      return { providerID: String(info.providerID), modelID: String(info.modelID) }
    }
  }
  return undefined
}

async function specialistText(client, directory, sessionID, message) {
  let text = textFromMessage(message)
  if (text.trim()) return text
  const listed = unwrap(await client.session.messages({ path: { id: sessionID }, query: { directory } }))
  const rows = Array.isArray(listed) ? listed : []
  for (let i = rows.length - 1; i >= 0; i--) {
    text = textFromMessage(rows[i])
    if (text.trim()) return text
  }
  return ""
}

function snapshotTasks(tasks) {
  return tasks.map((task) => ({
    ...task,
    activity: Array.isArray(task.activity) ? task.activity.slice() : [],
  }))
}

function applySnapshot(task, snap) {
  if (!snap) return false
  let changed = false
  if (snap.model && snap.model !== task.model) {
    task.model = snap.model
    changed = true
  }
  if (snap.tokens > (Number(task.tokens) || 0)) {
    task.tokens = snap.tokens
    changed = true
  }
  if (snap.toolCount > (Number(task.toolCount) || 0)) {
    task.toolCount = snap.toolCount
    changed = true
  }
  const next = Array.isArray(snap.activity) ? snap.activity : []
  if (next.length && next.join("\n") !== (task.activity || []).join("\n")) {
    task.activity = next.slice()
    changed = true
  }
  return changed
}

export function createRuntime({ client, directory, parentSessionID, signal, onProgress, concurrency, pollMs }) {
  const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY)
  const watchMs = Math.max(250, Number(pollMs) || 2000)
  let active = 0
  const waiting = []
  const logs = []
  const tasks = []
  const phases = []
  let phaseTitle = "starting"
  let findings = []

  function emit(kind, message) {
    onProgress?.({
      kind,
      message,
      logs,
      phase: phaseTitle,
      phases: phases.slice(),
      active,
      waiting: waiting.length,
      tasks: snapshotTasks(tasks),
      findings: findings.map((finding) => ({ ...finding, votes: finding.votes.map((vote) => ({ ...vote })) })),
    })
  }

  function note(kind, message) {
    if (kind === "phase") {
      phaseTitle = message
      phases.push(message)
    }
    logs.push(message)
    emit(kind, message)
  }

  function touch() {
    emit("activity", logs.at(-1) || "")
  }

  function watch(sessionID, task) {
    let stopped = false
    let pulling = false
    const pull = async () => {
      if (stopped || pulling) return
      pulling = true
      try {
        const listed = unwrap(await client.session.messages({ path: { id: sessionID }, query: { directory } }))
        if (stopped) return
        if (applySnapshot(task, summarizeSession(listed))) touch()
      } catch {
        // The specialist keeps running when a progress read fails.
      } finally {
        pulling = false
      }
    }
    const timer = setInterval(pull, watchMs)
    pull()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  let modelPromise
  function parentModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        if (!parentSessionID) return undefined
        try {
          const listed = unwrap(
            await client.session.messages({ path: { id: parentSessionID }, query: { directory } }),
          )
          return modelFromMessages(listed)
        } catch {
          return undefined
        }
      })()
    }
    return modelPromise
  }

  async function acquire() {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise((resolve) => waiting.push(resolve))
    active += 1
  }

  function release() {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }

  async function agent(prompt, opts = {}) {
    const requested = opts.agentType || opts.agent || "security-researcher"
    const agentName = AGENT_TYPE_MAP[requested] || requested
    const label = opts.label || agentName
    const stallMs = Number(opts.stallMs) > 0 ? Number(opts.stallMs) : DEFAULT_STALL_MS
    await acquire()
    let sessionID
    let stopWatch = () => {}
    const excerpt = promptExcerpt(prompt)
    const task = {
      label,
      agent: agentName,
      phase: String(opts.phase || phaseTitle || ""),
      status: "running",
      sessionID: "",
      detail: "",
      model: "",
      tokens: 0,
      toolCount: 0,
      activity: [],
      prompt: excerpt.text,
      promptLines: excerpt.lines,
      outcome: "",
      outcomeBody: "",
      startedAt: new Date().toISOString(),
      finishedAt: "",
    }
    tasks.push(task)
    try {
      if (signal?.aborted) throw new Error("the scan was aborted")
      findings = notePanel(findings, label, prompt, null)
      note("agent", `${label}: dispatching ${agentName}`)
      const created = unwrap(
        await client.session.create({
          query: { directory },
          body: { parentID: parentSessionID, title: String(label).slice(0, 120) },
        }),
      )
      sessionID = created.id
      task.sessionID = sessionID
      const schema = opts.schema
        ? `\n\nReply with one JSON object and nothing else. No markdown fence. It must match this JSON Schema:\n${JSON.stringify(opts.schema)}`
        : "\n\nReply with the result and nothing else."
      const effort = opts.effort ? `\nDispatch effort: ${opts.effort}.` : ""
      const model = await parentModel()
      if (model?.modelID) task.model = model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID
      touch()
      stopWatch = watch(sessionID, task)
      const prompted = client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          agent: agentName,
          ...(model ? { model } : {}),
          tools: opts.tools || toolsFor(agentName),
          parts: [{ type: "text", text: `${prompt}${effort}${schema}` }],
        },
      })
      let stallTimer
      const timeout = new Promise((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error(`${label}: specialist timed out after ${stallMs}ms`)), stallMs)
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(stallTimer)
            reject(new Error(`${label}: the scan was aborted`))
          },
          { once: true },
        )
      })
      let message
      try {
        message = unwrap(await Promise.race([prompted, timeout]))
      } finally {
        clearTimeout(stallTimer)
      }
      stopWatch()
      stopWatch = () => {}
      applySnapshot(task, summarizeSession(message))
      const text = await specialistText(client, directory, sessionID, message)
      const parsed = parseJsonObject(text)
      if (!parsed) throw new Error(`${label}: specialist returned no JSON object`)
      findings = notePanel(findings, label, prompt, parsed)
      task.status = "returned"
      task.finishedAt = new Date().toISOString()
      task.outcome = outcomeSummary(parsed)
      task.outcomeBody = outcomeBody(parsed)
      note("agent", `${label}: returned`)
      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      task.status = "failed"
      task.finishedAt = new Date().toISOString()
      task.detail = message.slice(0, 200)
      note("agent", `${label}: ${message}`)
      if (sessionID) {
        await client.session.abort({ path: { id: sessionID }, query: { directory } }).catch(() => {})
      }
      throw error instanceof Error ? error : new Error(message)
    } finally {
      stopWatch()
      release()
    }
  }

  async function parallel(thunks) {
    return Promise.all(thunks.map((thunk) => thunk()))
  }

  async function pipeline(items, ...stages) {
    return parallel(
      items.map((item) => async () => {
        let value = item
        for (const stage of stages) value = await stage(value)
        return value
      }),
    )
  }

  function phase(title) {
    note("phase", String(title))
  }

  function log(message) {
    note("log", String(message))
  }

  return { agent, parallel, pipeline, phase, log, logs }
}
