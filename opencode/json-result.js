// Specialists are asked for one JSON object. Models still wrap it in prose or fences.
export function parseJsonObject(text) {
  const source = String(text ?? "").trim()
  if (!source) return null
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = fence ? [fence[1].trim(), source] : [source]
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === "object" && !Array.isArray(value)) return value
    } catch {
      const start = candidate.indexOf("{")
      const end = candidate.lastIndexOf("}")
      if (start >= 0 && end > start) {
        try {
          const value = JSON.parse(candidate.slice(start, end + 1))
          if (value && typeof value === "object" && !Array.isArray(value)) return value
        } catch {
          // try the next candidate
        }
      }
    }
  }
  return null
}

export function textFromMessage(message) {
  const parts = message?.parts || message?.info?.parts || []
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}
