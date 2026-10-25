import { createSignal, onCleanup, onMount } from "solid-js"
import { projectWorkflowDir, readWorkflowStatuses } from "./opencode/workflow-status.js"
import { clampWorkflowNav, initialWorkflowNav, readWorkflowModel, reduceWorkflowNav, workflowColumns } from "./opencode/workflow-nav.js"

const VISIBLE = 14

function themeOf(api) {
  try {
    return api.theme?.current || {}
  } catch {
    return {}
  }
}

function windowRows(rows) {
  if (!Array.isArray(rows) || rows.length <= VISIBLE) return rows || []
  const selected = rows.findIndex((row) => row.selected)
  const index = selected < 0 ? 0 : selected
  const start = Math.min(Math.max(0, index - 3), rows.length - VISIBLE)
  return rows.slice(start, start + VISIBLE)
}

function markColor(mark, theme, selected) {
  if (selected) return theme.selectedListItemText || theme.background || "black"
  if (mark === "✓") return theme.success || "green"
  if (mark === "✗") return theme.error || "red"
  if (mark === "●") return theme.warning || theme.accent || "yellow"
  return theme.textMuted || "gray"
}

function Row(props) {
  const theme = () => props.theme || {}
  const selected = () => Boolean(props.selected)
  const fg = () => (selected() ? theme().selectedListItemText || theme().background || "black" : theme().text || "white")
  return (
    <box
      width="100%"
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      {...(selected() ? { backgroundColor: theme().accent || "#c45c26" } : {})}
    >
      {props.header ? (
        <text fg={theme().textMuted || "gray"} wrapMode="none">{props.header}</text>
      ) : null}
      <box width="100%" flexDirection="row" gap={1}>
        {props.mark ? <text fg={markColor(props.mark, theme(), selected())} wrapMode="none">{props.mark}</text> : null}
        <text fg={fg()} wrapMode="none" flexGrow={1}>{props.primary || " "}</text>
        {props.aside ? <text fg={fg()} wrapMode="none">{props.aside}</text> : null}
      </box>
      {props.secondary ? (
        <text fg={selected() ? fg() : theme().textMuted || "gray"} wrapMode="none">{`  ${props.secondary}`}</text>
      ) : null}
    </box>
  )
}

function Column(props) {
  const theme = () => props.theme || {}
  const active = () => Boolean(props.active)
  return (
    <box
      flexDirection="column"
      {...(props.width ? { width: props.width, flexGrow: 0 } : { flexGrow: 1 })}
      border
      borderColor={active() ? theme().borderActive || theme().accent || "white" : theme().borderSubtle || theme().border || "gray"}
      paddingTop={1}
      paddingBottom={1}
    >
      {props.heading ? <text fg={theme().text || "white"} wrapMode="none">{` ${props.heading}`}</text> : null}
      {props.sub ? <text fg={theme().textMuted || "gray"} wrapMode="word">{` ${props.sub}`}</text> : null}
      <box flexDirection="column" flexGrow={1}>
        {(props.rows || []).length === 0 ? (
          <text fg={theme().textMuted || "gray"}>{props.empty || "  Nothing in this section yet."}</text>
        ) : (
          windowRows(props.rows).map((row) => <Row theme={theme()} {...row} />)
        )}
      </box>
    </box>
  )
}

function WorkflowBoard(props) {
  const [model, setModel] = createSignal(props.model)
  const [nav, setNav] = createSignal(initialWorkflowNav())
  let seenKey = ""
  let seenAt = 0

  const applyKey = (key) => {
    const now = Date.now()
    if (key === seenKey && now - seenAt < 16) return
    seenKey = key
    seenAt = now
    if (key === "escape") {
      props.onClose?.()
      return
    }
    if (!["up", "down", "left", "right", "return"].includes(key)) return
    setNav((current) => reduceWorkflowNav(current, key, model()))
  }

  onMount(() => {
    props.api?.ui?.dialog?.setSize?.("xlarge")
    const timer = setInterval(() => {
      const next = readWorkflowModel(readWorkflowStatuses(projectWorkflowDir(props.directory)))
      setModel(next)
      setNav((current) => clampWorkflowNav(current, next))
    }, 1000)
    const stopTimer = () => clearInterval(timer)
    props.bind?.(applyKey, stopTimer)
    onCleanup(stopTimer)
  })

  const onKeyDown = (event) => {
    const name = event?.name || event?.key || ""
    const key = name === "enter" ? "return" : name
    if (!["up", "down", "left", "right", "return", "escape"].includes(key)) return
    event.preventDefault?.()
    event.stopPropagation?.()
    applyKey(key)
  }

  return <BoardFrame api={props.api} model={model} nav={nav} onKeyDown={onKeyDown} />
}

function BoardFrame(props) {
  const theme = () => themeOf(props.api)
  const view = () => workflowColumns(props.model(), props.nav())
  return (
    <box width="100%" flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingBottom={1} focused onKeyDown={props.onKeyDown}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text || "white"} wrapMode="none">{view().title}</text>
        <text fg={theme().textMuted || "gray"}>esc</text>
      </box>
      {view().empty ? (
        <text fg={theme().textMuted || "gray"}>{view().empty}</text>
      ) : (
        <box flexDirection="column" flexGrow={1} gap={1}>
          <box flexDirection="row" flexGrow={1} gap={1}>
            <Column
              theme={theme()}
              width={34}
              active={view().stage === "sections"}
              heading={view().stage === "detail" ? "Descriptions" : "Phases"}
              rows={view().left}
              empty="  No phases yet."
            />
            <Column
              theme={theme()}
              active={view().stage !== "sections"}
              heading={view().right.heading}
              sub={view().right.sub}
              rows={view().right.rows}
              empty={view().stage === "detail" ? "  No description yet." : "  No agents in this section yet."}
            />
          </box>
          <text fg={theme().textMuted || "gray"}>{view().hint}</text>
        </box>
      )}
    </box>
  )
}

export function mountWorkflows(api, directory) {
  if (!api.ui?.dialog?.replace) return null
  let stopped = false
  let handle = (key) => {
    void key
  }
  let halt = () => {}
  let release = () => {}
  const stop = () => {
    if (stopped) return
    stopped = true
    halt()
    release()
    handle = () => {}
    api.ui.dialog.clear()
  }
  try {
    if (typeof api.keymap?.registerLayer === "function") {
      const names = ["up", "down", "left", "right", "return", "escape"]
      const registered = api.keymap.registerLayer({
        commands: names.map((key) => ({
          name: `opencode-security.workflows.nav.${key}`,
          title: `Workflow ${key}`,
          hidden: true,
          run: () => handle(key === "return" ? "return" : key),
        })),
        bindings: [
          ...names.map((key) => ({ key, cmd: `opencode-security.workflows.nav.${key}` })),
          { key: "enter", cmd: "opencode-security.workflows.nav.return" },
        ],
      })
      if (typeof registered === "function") release = registered
    }
    const scans = readWorkflowStatuses(projectWorkflowDir(directory))
    api.ui.dialog.replace(
      () => (
        <WorkflowBoard
          api={api}
          directory={directory}
          model={readWorkflowModel(scans)}
          bind={(fn, stopTimer) => {
            handle = fn
            halt = stopTimer || (() => {})
          }}
          onClose={stop}
        />
      ),
      stop,
    )
    api.ui.dialog.setSize("xlarge")
  } catch (error) {
    release()
    throw error
  }
  return stop
}
