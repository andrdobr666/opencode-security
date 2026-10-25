const PANEL = /^panel:(C\d+):v(\d+)$/
const CLAIM_KEYS = [
  "file",
  "line",
  "cwe as reported",
  "severity as reported",
  "title",
  "rationale",
  "evidence as cited by the reporter",
  "sink line as quoted by the reporter",
  "enclosing symbol",
  "link to the change as claimed by the reporter",
]

function claimField(fields, key) {
  const value = fields[key]
  if (!value || value === "(none)") return ""
  return value.slice(0, 800)
}

export function panelClaim(prompt) {
  const block = String(prompt || "").match(/<untrusted-finding>\n([\s\S]*?)\n<\/untrusted-finding>/)
  if (!block) return null
  const fields = {}
  let current = ""
  for (const line of block[1].split("\n")) {
    const key = CLAIM_KEYS.find((name) => line.startsWith(`${name}:`))
    if (key) {
      current = key
      fields[key] = line.slice(key.length + 1).trim()
      continue
    }
    if (current && line.trim() && !line.startsWith("reported independently")) {
      fields[current] = `${fields[current]}\n${line}`
    }
  }
  return {
    file: claimField(fields, "file"),
    line: claimField(fields, "line"),
    cweId: claimField(fields, "cwe as reported"),
    severity: claimField(fields, "severity as reported"),
    title: claimField(fields, "title"),
    rationale: claimField(fields, "rationale"),
    evidence: claimField(fields, "evidence as cited by the reporter"),
    snippet: claimField(fields, "sink line as quoted by the reporter"),
    symbol: claimField(fields, "enclosing symbol"),
    viaChange: claimField(fields, "link to the change as claimed by the reporter"),
  }
}

export function notePanel(findings, label, prompt, parsed) {
  const match = PANEL.exec(String(label || ""))
  if (!match) return findings
  const cid = match[1]
  const voter = Number(match[2])
  const list = Array.isArray(findings) ? findings.slice() : []
  const index = list.findIndex((item) => item.cid === cid)
  const claim = panelClaim(prompt) || {}
  const current = index >= 0 ? list[index] : { cid, votes: [] }
  const next = {
    cid,
    title: current.title || claim.title || cid,
    file: current.file || claim.file || "",
    line: current.line || claim.line || "",
    cweId: current.cweId || claim.cweId || "",
    severity: current.severity || claim.severity || "",
    rationale: current.rationale || claim.rationale || "",
    evidence: current.evidence || claim.evidence || "",
    snippet: current.snippet || claim.snippet || "",
    symbol: current.symbol || claim.symbol || "",
    viaChange: current.viaChange || claim.viaChange || "",
    votes: Array.isArray(current.votes) ? current.votes.slice() : [],
  }
  if (parsed && typeof parsed.verdict === "string" && parsed.verdict) {
    const vote = {
      voter,
      verdict: parsed.verdict,
      reasoning: String(parsed.reasoning || "").slice(0, 240),
      severity: typeof parsed.severity === "string" ? parsed.severity : "",
    }
    next.votes = [...next.votes.filter((item) => item.voter !== voter), vote].sort((a, b) => a.voter - b.voter)
  }
  if (index >= 0) list[index] = next
  else list.push(next)
  return list
}
