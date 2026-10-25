import { projectWorkflowDir, readWorkflowStatuses } from "./opencode/workflow-status.js"
import { initialWorkflowNav, readWorkflowModel, reduceWorkflowNav, renderWorkflowText } from "./opencode/workflow-nav.js"

function projectDirectory(api) {
  return api.state?.path?.directory || api.state?.path?.worktree || ""
}

function openText(api, directory) {
  const DialogAlert = api.ui?.DialogAlert
  if (!DialogAlert || !api.ui?.dialog) return () => {}
  let stopped = false
  let view = 0
  let nav = initialWorkflowNav()
  let timer
  let release = () => {}
  let last = ""
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    release()
    api.ui.dialog.clear()
  }
  const modelNow = () => readWorkflowModel(readWorkflowStatuses(projectWorkflowDir(directory)))
  const paint = () => {
    if (stopped) return
    const model = modelNow()
    const message = model.empty ? `${model.empty}\n\nesc closes` : renderWorkflowText(model, nav)
    if (message === last) return
    last = message
    const gen = ++view
    api.ui.dialog.replace(
      () =>
        DialogAlert({
          title: model.title,
          message,
          onConfirm: () => handle("return"),
        }),
      () => {
        if (gen === view) stop()
      },
    )
    api.ui.dialog.setSize("xlarge")
  }
  const handle = (key) => {
    if (stopped) return
    if (key === "escape") {
      stop()
      return
    }
    const next = reduceWorkflowNav(nav, key, modelNow())
    if (next.stage === nav.stage && next.section === nav.section && next.item === nav.item && next.scroll === nav.scroll) return
    nav = next
    last = ""
    paint()
  }
  if (typeof api.keymap?.registerLayer === "function") {
    const names = ["up", "down", "left", "right", "return", "escape"]
    const registered = api.keymap.registerLayer({
      commands: names.map((key) => ({
        name: `opencode-security.workflows.nav.${key}`,
        title: `Workflow ${key}`,
        hidden: true,
        run: () => handle(key),
      })),
      bindings: [
        ...names.map((key) => ({ key, cmd: `opencode-security.workflows.nav.${key}` })),
        { key: "enter", cmd: "opencode-security.workflows.nav.return" },
      ],
    })
    if (typeof registered === "function") release = registered
  }
  paint()
  timer = setInterval(paint, 1000)
  return stop
}

const tui = async (api) => {
  let stopLive = () => {}
  let opening = 0

  const open = () => {
    const gen = ++opening
    stopLive()
    stopLive = () => {}
    const DialogAlert = api.ui?.DialogAlert
    if (!api.ui?.dialog) return
    const directory = projectDirectory(api)
    if (!directory) {
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() =>
        DialogAlert({
          title: "Workflows",
          message: "Open a project, then run /workflows again.",
          onConfirm: () => api.ui.dialog.clear(),
        }),
      )
      return
    }
    import("./tui-board.tsx")
      .then(({ mountWorkflows }) => {
        if (gen !== opening) return
        const stop = mountWorkflows(api, directory)
        if (gen !== opening) {
          stop?.()
          return
        }
        if (typeof stop !== "function") {
          stopLive = openText(api, directory)
          return
        }
        stopLive = stop
      })
      .catch(() => {
        if (gen !== opening) return
        stopLive = openText(api, directory)
      })
  }

  api.lifecycle?.onDispose?.(() => stopLive())

  const command = {
    name: "opencode-security.workflows",
    title: "Workflows",
    description: "Show security scans in this project",
    category: "Security",
    namespace: "palette",
    slashName: "workflows",
    slash: { name: "workflows" },
    run: open,
    onSelect: open,
  }

  if (typeof api.keymap?.registerLayer === "function") {
    api.keymap.registerLayer({ commands: [command] })
    return
  }
  api.command?.register?.(() => [
    {
      title: command.title,
      value: command.name,
      description: command.description,
      category: command.category,
      slash: command.slash,
      onSelect: open,
    },
  ])
}

export default {
  id: "opencode-security.workflows",
  tui,
}
