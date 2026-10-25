import assert from "node:assert/strict"
import test from "node:test"
import { workflowModel } from "../opencode/workflow-status.js"
import { initialWorkflowNav, reduceWorkflowNav, renderWorkflowText, workflowColumns } from "../opencode/workflow-nav.js"

const now = Date.parse("2026-10-11T14:30:20.000Z")

function scan() {
  return {
    id: "ses_scan",
    directory: "/repo/VAmPI",
    scope: "api_views",
    effort: "medium",
    phase: "Research",
    state: "running",
    phases: ["Inventory", "Research"],
    tasks: [
      {
        label: "inventory",
        phase: "Inventory",
        status: "returned",
        outcome: "4 component(s) · api",
        startedAt: "2026-10-11T14:20:00.000Z",
        finishedAt: "2026-10-11T14:21:05.000Z",
      },
      {
        label: "research:api:injection",
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
}

function failedScan() {
  return {
    id: "ses_fail",
    directory: "/repo/VAmPI",
    phase: "Research",
    state: "failed",
    phases: ["Research"],
    tasks: [
      {
        label: "research:repository:all",
        phase: "Research",
        status: "failed",
        detail: "the scan was aborted",
        startedAt: "2026-10-11T14:20:00.000Z",
        finishedAt: "2026-10-11T14:21:00.000Z",
      },
    ],
  }
}

test("workflow model keeps a phase count off the agent description", () => {
  const model = workflowModel([scan()], now)
  const research = model.sections.find((section) => section.name === "Research")
  assert.equal(research.count, "0/1")
  assert.match(research.blurb, /1 running · research:api:injection/)
  assert.equal(research.items[0].label, "research:api:injection")
  assert.match(research.items[0].stats, /beast\/big/)
  assert.match(research.items[0].stats, /176\.8k tok/)
  assert.match(research.items[0].description, /grep -n pin/)
  const failed = workflowModel([failedScan()], now).sections[0]
  assert.equal(failed.blurb, "1 failed")
  assert.equal(failed.mark, "✗")
})

test("arrows move from sections to descriptions and back", () => {
  const model = workflowModel([scan()], now)
  let nav = initialWorkflowNav()
  assert.equal(nav.stage, "sections")

  nav = reduceWorkflowNav(nav, "down", model)
  assert.equal(model.sections[nav.section].name, "Research")

  nav = reduceWorkflowNav(nav, "right", model)
  assert.equal(nav.stage, "items")
  let view = workflowColumns(model, nav)
  assert.equal(view.left.find((row) => row.selected).primary, "Research")
  assert.equal(view.right.rows.find((row) => row.selected).primary, "research:api:injection")
  assert.match(view.hint, /← sections/)

  nav = reduceWorkflowNav(nav, "right", model)
  assert.equal(nav.stage, "detail")
  view = workflowColumns(model, nav)
  assert.deepEqual(
    view.left.map((row) => row.primary),
    ["research:api:injection"],
  )
  assert.match(view.right.rows.map((row) => row.primary).join("\n"), /Hunt for vulnerabilities/)
  assert.match(view.right.rows.map((row) => row.primary).join("\n"), /Bash\(grep -n pin/)
  assert.match(view.hint, /← descriptions/)

  nav = reduceWorkflowNav(nav, "left", model)
  assert.equal(nav.stage, "items")
  view = workflowColumns(model, nav)
  assert.equal(view.left.find((row) => row.selected).primary, "Research")
  assert.equal(view.right.rows[0].primary, "research:api:injection")

  nav = reduceWorkflowNav(nav, "left", model)
  assert.equal(nav.stage, "sections")
})

test("moving between sections resets the description, and detail scrolls", () => {
  const model = {
    title: "Workflows",
    empty: "",
    sections: [
      {
        key: "a",
        group: "one",
        mark: "✓",
        name: "Inventory",
        count: "1/1",
        blurb: "1 finished",
        items: [{ key: "i", mark: "✓", label: "inventory", stats: "", description: "done", detail: "inventory body" }],
      },
      {
        key: "b",
        group: "two",
        mark: "●",
        name: "Research",
        count: "0/2",
        blurb: "2 running",
        items: [
          { key: "r1", mark: "●", label: "research:one", stats: "", description: "first", detail: "one" },
          { key: "r2", mark: "●", label: "research:two", stats: "", description: "second", detail: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") },
        ],
      },
    ],
  }
  let nav = reduceWorkflowNav(initialWorkflowNav(), "down", model)
  nav = reduceWorkflowNav(nav, "right", model)
  nav = reduceWorkflowNav(nav, "down", model)
  assert.equal(nav.item, 1)
  nav = reduceWorkflowNav(nav, "left", model)
  assert.equal(nav.stage, "sections")
  nav = reduceWorkflowNav(nav, "up", model)
  assert.equal(model.sections[nav.section].name, "Inventory")
  assert.equal(nav.item, 0)
  nav = reduceWorkflowNav(nav, "down", model)
  assert.equal(nav.item, 0)
  assert.equal(model.sections[nav.section].name, "Research")

  nav = reduceWorkflowNav({ stage: "detail", section: 1, item: 1, scroll: 0 }, "down", model)
  assert.equal(nav.scroll, 1)
  const lines = workflowColumns(model, nav).right.rows.map((row) => row.primary)
  assert.equal(lines[0], "line 1")
  assert.equal(lines.length, 14)
  const text = renderWorkflowText(model, nav, 80)
  assert.match(text, /research:two/)
  assert.match(text, /line 1/)
  assert.match(text, /← descriptions/)
})
