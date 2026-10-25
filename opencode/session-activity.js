function sessionRows(listed) {
  if (Array.isArray(listed)) return listed
  if (Array.isArray(listed?.data)) return listed.data
  if (listed && typeof listed === "object" && (listed.info || listed.parts || listed.type || listed.role)) return [listed]
  return []
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== "object") return 0
  if (Number(tokens.total) > 0) return Number(tokens.total)
  return (Number(tokens.input) || 0) + (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0)
}

function modelName(info) {
  const model = info?.model
  const id = info?.modelID || model?.modelID || (typeof model === "string" ? model : "")
  const provider = info?.providerID || model?.providerID || ""
  if (!id) return ""
  if (provider && !String(id).startsWith(`${provider}/`)) return `${provider}/${id}`
  return String(id)
}

function inputHint(input) {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  for (const key of ["command", "cmd", "path", "filePath", "file_path", "pattern", "query", "url", "description"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function toolLabel(name) {
  const text = String(name || "tool")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function toolLine(part) {
  const state = part?.state || {}
  const title = typeof state.title === "string" ? state.title : ""
  const hint = title || inputHint(state.input)
  const text = hint.replace(/\s+/g, " ").trim().slice(0, 120)
  const name = toolLabel(part?.tool || part?.name)
  return text ? `${name}(${text})` : name
}

// OpenCode has shipped session transcripts as `{ info, parts }` and as flat
// message objects. Both carry the model, token use, and tool calls a workflow
// row needs while a specialist is still running.
export function summarizeSession(listed) {
  let model = ""
  let tokens = 0
  const tools = []
  for (const row of sessionRows(listed)) {
    if (!row || typeof row !== "object") continue
    const info = row.info && typeof row.info === "object" ? row.info : row
    const role = info.role || info.type
    let rowTokens = 0
    if (role === "assistant") {
      const name = modelName(info)
      if (name) model = name
      rowTokens = tokenTotal(info.tokens)
      tokens += rowTokens
    }
    if (info.type === "shell" && info.command) tools.push(toolLine({ tool: "shell", state: { title: String(info.command) } }))
    const parts = Array.isArray(row.parts) ? row.parts : Array.isArray(info.content) ? info.content : []
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      if (part.type === "tool") tools.push(toolLine(part))
      if (part.type === "step-finish" && !rowTokens) tokens += tokenTotal(part.tokens)
    }
  }
  return { model, tokens, toolCount: tools.length, activity: tools.slice(-8) }
}

export function promptExcerpt(prompt) {
  const text = String(prompt || "").trim()
  if (!text) return { text: "", lines: 0 }
  const lines = text.split("\n")
  const body = lines.slice(0, 12).join("\n").slice(0, 900)
  const more = lines.length > 12 ? `\n… ${lines.length - 12} more lines` : ""
  return { text: `${body}${more}`.slice(0, 980), lines: lines.length }
}

export function outcomeSummary(parsed) {
  if (!parsed || typeof parsed !== "object") return ""
  if (typeof parsed.verdict === "string" && parsed.verdict) {
    const head = [parsed.verdict, parsed.severity].filter(Boolean).join(" · ")
    const why = typeof parsed.reasoning === "string" ? parsed.reasoning.replace(/\s+/g, " ").trim().slice(0, 160) : ""
    return [head, why].filter(Boolean).join(" — ")
  }
  if (Array.isArray(parsed.findings)) {
    const first = parsed.findings.find((item) => item && (item.title || item.file))
    const name = first ? String(first.title || first.file).replace(/\s+/g, " ").trim().slice(0, 100) : ""
    if (!parsed.findings.length) return "no findings"
    return `${parsed.findings.length} finding(s)${name ? ` · ${name}` : ""}`
  }
  if (Array.isArray(parsed.components)) {
    const first = parsed.components.find((item) => item?.name)
    return `${parsed.components.length} component(s)${first ? ` · ${first.name}` : ""}`
  }
  return ""
}

export function outcomeBody(parsed) {
  if (!parsed || typeof parsed !== "object") return ""
  try {
    return JSON.stringify(parsed, null, 2).slice(0, 1500)
  } catch {
    return ""
  }
}
