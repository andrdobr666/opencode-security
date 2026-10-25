import { tool } from "@opencode-ai/plugin"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAgentConfigs } from "./opencode/agents.js"
import { createRuntime } from "./opencode/runtime.js"
import { runScan } from "./opencode/scan-runner.js"
import { progressLine, writeWorkflowStatus } from "./opencode/workflow-status.js"

const root = dirname(fileURLToPath(import.meta.url))
const skillDir = join(root, "skills", "opencode-security")
const scripts = join(root, "scripts")
const scanPath = join(root, "workflows", "scan.js")

function commandTemplate() {
  return `Session start (UTC): !\`date -u +%Y%m%d-%H%M%S\`
Existing reports: !\`find . -maxdepth 1 -type d -name "OPENCODE-SECURITY-2*" -print\`
Python: !\`python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'\`

You are the OpenCode Security lead.

PLUGIN_ROOT: ${root}
SCRIPTS: ${scripts}
SKILL_DIR: ${skillDir}

Read ${skillDir}/SKILL.md and follow it. Use the three paths above wherever that file says PLUGIN_ROOT, SCRIPTS, or SKILL_DIR. Read ${skillDir}/role.md when the skill tells you to.

User request:
$ARGUMENTS

A scan runs only through the security_scan tool. Pass the scan settings as \`payload\`. The tool blocks until that workflow run finishes and names an output file. Dispatch specialists with the task tool and \`background\` false. Ask the user with the question tool.`
}

function normalizePayload(args) {
  if (!args || typeof args !== "object") return {}
  const payload = args.payload
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload)
    } catch {
      return { raw: payload }
    }
  }
  if (payload && typeof payload === "object") return payload
  return args
}

async function OpenCodeSecurityPlugin(input) {
  const agents = await loadAgentConfigs(root)
  return {
    config: async (config) => {
      config.agent = { ...config.agent, ...agents }
      config.command = {
        ...config.command,
        "opencode-security": {
          description: "Scan a repository, scan a change, or suggest patches for confirmed findings",
          agent: "opencode-security",
          template: commandTemplate(),
        },
      }
    },
    "tool.execute.after": async (event, output) => {
      if (event.tool !== "bash") return
      if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") return
      if (/^off$/i.test(process.env.OPENCODE_SECURITY_SCAN_TIP || "")) return
      const command = String(event.args?.command || "")
      if (!/^\s*git\s+push\b/.test(command) && !/^\s*gh\s+pr\s+create\b/.test(command)) return
      output.output = `${output.output || ""}\n\nOpenCode Security: this branch was just published. Run /opencode-security to scan the changes.`
    },
    tool: {
      security_scan: tool({
        description:
          "Run one OpenCode Security scan workflow (workflows/scan.js) inside OpenCode. Blocks until that run finishes. Pass the scan settings object as payload (scanRoot, runDir, mode, effort, and the other fields the scan job names). Writes {result} to an output file and returns that path. Do not dispatch researchers yourself.",
        args: {
          payload: tool.schema
            .any()
            .describe("Scan settings object, or a JSON string of that object"),
        },
        async execute(args, context) {
          const payload = normalizePayload(args)
          const logs = []
          const scanID = context.sessionID || `scan-${process.pid}-${Date.now()}`
          let latest = { phase: "starting", phases: [], active: 0, waiting: 0, tasks: [], logs: [] }
          const publish = (state) => {
            try {
              writeWorkflowStatus({
                id: scanID,
                updatedAt: new Date().toISOString(),
                directory: context.directory,
                parentSessionID: context.sessionID,
                effort: typeof payload.effort === "string" ? payload.effort : undefined,
                mode: typeof payload.mode === "string" ? payload.mode : undefined,
                scope: typeof payload.scope === "string" ? payload.scope : undefined,
                state,
                phase: latest.phase,
                phases: latest.phases,
                active: latest.active,
                waiting: latest.waiting,
                tasks: latest.tasks,
                findings: latest.findings || [],
                log: latest.logs.slice(-20),
              })
            } catch {
              // The scan continues when the status file cannot be written.
            }
          }
          const runtime = createRuntime({
            client: input.client,
            directory: context.directory,
            parentSessionID: context.sessionID,
            signal: context.abort,
            concurrency: process.env.OPENCODE_SECURITY_CONCURRENCY,
            onProgress(event) {
              latest = event
              logs.splice(0, logs.length, ...event.logs)
              publish("running")
              context.metadata({
                title: progressLine(event).slice(0, 80),
                metadata: { phase: event.phase, lines: logs.length, active: event.active },
              })
            },
          })
          publish("running")
          let result
          try {
            result = await runScan(scanPath, payload, runtime)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            latest = { ...latest, logs: [...latest.logs, message] }
            publish("failed")
            return {
              title: "Scan failed",
              output: `security_scan failed before it could write a result: ${message}`,
            }
          }
          publish(result?.started === false ? "not-started" : "finished")
          const runDir = typeof result?.runDir === "string" ? result.runDir : context.directory
          await mkdir(runDir, { recursive: true })
          const outputFile = join(runDir, `workflow-output-${Date.now()}.json`)
          await writeFile(outputFile, JSON.stringify({ result }, null, 2))
          const findings = Array.isArray(result?.findings) ? result.findings.length : 0
          const recent = logs.slice(-40).join("\n")
          const reason = result?.started === false ? `reason: ${result.reason || "not started"}\n` : ""
          return {
            title: result?.started === false ? "Scan did not start" : `Scan run finished (${findings} findings)`,
            output: [
              `output file: ${outputFile}`,
              reason.trimEnd(),
              `findings in this run: ${findings}`,
              recent ? `narrator:\n${recent}` : "",
              "Run save_result.py on the output file and the run directory, then do what it prints.",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: { outputFile, findings, started: result?.started !== false },
          }
        },
      }),
    },
  }
}

export { OpenCodeSecurityPlugin }
export default OpenCodeSecurityPlugin
