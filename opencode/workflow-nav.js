import { workflowModel } from "./workflow-status.js"

const DETAIL_ROWS = 14

export function initialWorkflowNav() {
  return { stage: "sections", section: 0, item: 0, scroll: 0 }
}

function clampIndex(index, length) {
  if (length <= 0) return 0
  return Math.min(Math.max(0, index), length - 1)
}

export function clampWorkflowNav(nav, model) {
  const sections = model?.sections || []
  const section = clampIndex(nav?.section || 0, sections.length)
  const items = sections[section]?.items || []
  const item = clampIndex(nav?.item || 0, items.length)
  let stage = nav?.stage || "sections"
  if (stage !== "sections" && items.length === 0) stage = "sections"
  if (!["sections", "items", "detail"].includes(stage)) stage = "sections"
  const lines = (items[item]?.detail || "").split("\n")
  const maxScroll = Math.max(0, lines.length - DETAIL_ROWS)
  const scroll = stage === "detail" ? Math.min(Math.max(0, nav?.scroll || 0), maxScroll) : 0
  return { stage, section, item, scroll }
}

export function reduceWorkflowNav(nav, key, model) {
  const current = clampWorkflowNav(nav, model)
  const sections = model?.sections || []
  const section = sections[current.section]
  const items = section?.items || []
  if (key === "up" || key === "down") {
    const dir = key === "down" ? 1 : -1
    if (current.stage === "sections") {
      return { stage: "sections", section: clampIndex(current.section + dir, sections.length), item: 0, scroll: 0 }
    }
    if (current.stage === "items") {
      return { ...current, item: clampIndex(current.item + dir, items.length), scroll: 0 }
    }
    const lines = (items[current.item]?.detail || "").split("\n")
    const maxScroll = Math.max(0, lines.length - DETAIL_ROWS)
    return { ...current, scroll: Math.min(maxScroll, Math.max(0, current.scroll + dir)) }
  }
  if (key === "right" || key === "return") {
    if (current.stage === "sections" && items.length > 0) return { ...current, stage: "items", scroll: 0 }
    if (current.stage === "items") return { ...current, stage: "detail", scroll: 0 }
    return current
  }
  if (key === "left") {
    if (current.stage === "detail") return { ...current, stage: "items", scroll: 0 }
    if (current.stage === "items") return { ...current, stage: "sections", scroll: 0 }
  }
  return current
}

function rowText(row) {
  return [row.stats, row.description].filter(Boolean).join(" · ")
}

export function workflowColumns(model, nav) {
  const safe = clampWorkflowNav(nav, model || { sections: [] })
  const sections = model?.sections || []
  const section = sections[safe.section]
  const item = section?.items?.[safe.item]
  const groups = new Set(sections.map((entry) => entry.group).filter(Boolean))
  const showGroups = groups.size > 1
  const left =
    safe.stage === "detail"
      ? (section?.items || []).map((entry, index) => ({
          key: entry.key,
          selected: index === safe.item,
          mark: entry.mark,
          primary: entry.label,
          aside: "",
          header: "",
        }))
      : sections.map((entry, index) => ({
          key: entry.key,
          selected: index === safe.section,
          mark: entry.mark,
          primary: entry.name,
          aside: entry.count,
          header: showGroups && (index === 0 || sections[index - 1].group !== entry.group) ? entry.group : "",
        }))
  const lines = (item?.detail || "").split("\n")
  const right =
    safe.stage === "detail"
      ? {
          heading: item?.label || section?.name || "",
          sub: item ? rowText(item) : "",
          rows: lines.slice(safe.scroll, safe.scroll + DETAIL_ROWS).map((line, index) => ({
            key: `line:${safe.scroll + index}`,
            selected: false,
            mark: "",
            primary: line,
            secondary: "",
          })),
        }
      : {
          heading: section ? `${section.name}${section.count ? `  ${section.count}` : ""}` : "",
          sub: section?.blurb || "",
          rows: (section?.items || []).map((entry, index) => ({
            key: entry.key,
            selected: safe.stage === "items" && index === safe.item,
            mark: entry.mark,
            primary: entry.label,
            secondary: rowText(entry),
          })),
        }
  const hint =
    safe.stage === "detail"
      ? "↑↓ scroll    ← descriptions"
      : safe.stage === "items"
        ? "↑↓ description    ← sections    → open"
        : "↑↓ section    → descriptions"
  return {
    title: model?.title || "Workflows",
    empty: model?.empty || "",
    stage: safe.stage,
    hint,
    left,
    right,
  }
}

export function readWorkflowModel(scans, now) {
  return workflowModel(scans, now)
}

function clip(text, width) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}…`
}

function pad(text, width) {
  const value = clip(text, width)
  return value + " ".repeat(Math.max(0, width - value.length))
}

export function renderWorkflowText(model, nav, width = 100) {
  const view = workflowColumns(model, nav)
  if (view.empty) return `${view.title}\n\n${view.empty}\n\nesc closes`
  const leftWidth = 32
  const rightWidth = Math.max(24, width - leftWidth - 3)
  const leftLines = []
  for (const row of view.left) {
    if (row.header) leftLines.push(pad(row.header, leftWidth))
    const cursor = row.selected && view.stage !== "items" ? ">" : " "
    const body = [row.mark, row.primary, row.aside].filter(Boolean).join(" ")
    leftLines.push(pad(`${cursor} ${body}`, leftWidth))
  }
  const rightLines = []
  if (view.right.heading) rightLines.push(clip(view.right.heading, rightWidth))
  if (view.right.sub) rightLines.push(clip(view.right.sub, rightWidth))
  if (!view.right.rows.length) rightLines.push("Nothing in this section yet.")
  for (const row of view.right.rows) {
    if (view.stage === "detail") {
      rightLines.push(String(row.primary || "").slice(0, rightWidth))
      continue
    }
    const cursor = row.selected ? ">" : " "
    rightLines.push(clip(`${cursor} ${[row.mark, row.primary].filter(Boolean).join(" ")}`, rightWidth))
    if (row.secondary) rightLines.push(clip(`    ${row.secondary}`, rightWidth))
  }
  const rows = Math.max(leftLines.length, rightLines.length, 1)
  const lines = []
  for (let i = 0; i < rows; i++) lines.push(`${pad(leftLines[i] || "", leftWidth)} │ ${rightLines[i] || ""}`)
  lines.push("", view.hint)
  return lines.join("\n")
}
