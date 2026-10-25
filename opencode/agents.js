import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

const FILE_NAMES = {
  "opencode-security.md": "opencode-security",
  "explore.md": "security-explore",
  "scan-researcher.md": "security-researcher",
  "scan-verifier.md": "security-verifier",
  "scan-inventory.md": "security-inventory",
  "scan-loader.md": "security-loader",
  "scan-redactor.md": "security-redactor",
  "patch-generator.md": "security-patch-generator",
  "patch-verifier.md": "security-patch-verifier",
}

const COLORS = {
  purple: "#7c3aed",
  red: "#dc2626",
  orange: "#ea580c",
  green: "#16a34a",
  cyan: "#0891b2",
  yellow: "#ca8a04",
  blue: "#2563eb",
}

export const AGENT_TYPE_MAP = {
  "opencode-security:scan-researcher": "security-researcher",
  "opencode-security:scan-verifier": "security-verifier",
  "opencode-security:scan-inventory": "security-inventory",
  "opencode-security:scan-loader": "security-loader",
  "opencode-security:scan-redactor": "security-redactor",
  "opencode-security:patch-generator": "security-patch-generator",
  "opencode-security:patch-verifier": "security-patch-verifier",
  "opencode-security:explore": "security-explore",
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, body: String(text) }
  const data = {}
  for (const line of match[1].split("\n")) {
    const found = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!found) continue
    data[found[1]] = unquote(found[2])
  }
  return { data, body: match[2] }
}

function mentions(tools, name) {
  return tools.includes(name)
}

function taskRule(allow) {
  return { "*": "deny", ...Object.fromEntries(allow.map((name) => [name, "allow"])) }
}

export function permissionsFor(name, tools) {
  const read = mentions(tools, "Read") ? "allow" : "deny"
  const edit = mentions(tools, "Write") || mentions(tools, "Edit") ? "allow" : "deny"
  const search = mentions(tools, "Glob") || mentions(tools, "Grep") ? "allow" : "deny"
  const bash = mentions(tools, "Bash") ? "allow" : "deny"
  const explore = mentions(tools, "explore")
  const permission = {
    read,
    edit,
    glob: mentions(tools, "Glob") ? "allow" : search === "allow" ? "allow" : "deny",
    grep: mentions(tools, "Grep") ? "allow" : search === "allow" ? "allow" : "deny",
    bash,
    webfetch: "deny",
    question: name === "opencode-security" ? "allow" : "deny",
    skill: "deny",
    external_directory: "allow",
    task: "deny",
  }
  if (name === "opencode-security") {
    permission.task = taskRule([
      "security-researcher",
      "security-verifier",
      "security-inventory",
      "security-loader",
      "security-redactor",
      "security-patch-generator",
      "security-patch-verifier",
      "security-explore",
    ])
    permission.skill = "allow"
  } else if (explore) {
    permission.task = taskRule(["security-explore"])
  }
  return permission
}

export function toolsFor(name) {
  if (name === "security-loader") {
    return { write: false, edit: false, apply_patch: false, bash: false, grep: false, glob: false, task: false, webfetch: false, question: false, skill: false }
  }
  if (name === "security-inventory") {
    return { write: false, edit: false, apply_patch: false, bash: false, task: false, webfetch: false, question: false, skill: false }
  }
  if (name === "security-redactor") {
    return { bash: false, task: false, webfetch: false, question: false, skill: false }
  }
  if (name === "security-explore") {
    return { write: false, edit: false, apply_patch: false, task: false, webfetch: false, question: false, skill: false }
  }
  if (name === "security-patch-generator") {
    return { webfetch: false, question: false, skill: false }
  }
  if (name === "security-patch-verifier" || name === "security-researcher" || name === "security-verifier") {
    return { write: false, edit: false, apply_patch: false, webfetch: false, question: false, skill: false }
  }
  return {}
}

function adaptPrompt(name, body, root) {
  let prompt = body
    .replaceAll("opencode-security:explore", "security-explore")
    .replaceAll("opencode-security:scan-researcher", "security-researcher")
    .replaceAll("opencode-security:scan-verifier", "security-verifier")
    .replaceAll("opencode-security:scan-inventory", "security-inventory")
    .replaceAll("opencode-security:scan-loader", "security-loader")
    .replaceAll("opencode-security:scan-redactor", "security-redactor")
    .replaceAll("opencode-security:patch-generator", "security-patch-generator")
    .replaceAll("opencode-security:patch-verifier", "security-patch-verifier")
    .replaceAll("`opencode-security:scan` workflow", "`security_scan` tool")
    .replaceAll("Workflow tool", "security_scan tool")
  if (name === "opencode-security") {
    prompt += `

## OpenCode

You are running inside OpenCode. PLUGIN_ROOT is \`${root}\`. SCRIPTS is \`${root}/scripts\`. SKILL_DIR is \`${root}/skills/opencode-security\`.

Read \`${root}/skills/opencode-security/SKILL.md\` and follow it. Read \`${root}/skills/opencode-security/role.md\` when it tells you to. A scan runs only through the \`security_scan\` tool. Dispatch specialists with the task tool (\`subagent_type\` one of security-researcher, security-verifier, security-inventory, security-loader, security-redactor, security-patch-generator, security-patch-verifier, security-explore; \`background\` false). Ask the user with the question tool.
`
  } else if (name !== "security-loader" && name !== "security-inventory" && name !== "security-redactor") {
    prompt += `

## OpenCode

Dispatch security-explore with the task tool: \`subagent_type\` "security-explore", \`background\` false. There is no Agent tool and no Workflow tool.
`
  }
  return prompt.trim()
}

export async function loadAgentConfigs(root) {
  const dir = join(root, "agents")
  const files = await readdir(dir)
  const configs = {}
  for (const file of files) {
    const name = FILE_NAMES[file]
    if (!name) continue
    const raw = await readFile(join(dir, file), "utf8")
    const { data, body } = parseFrontmatter(raw)
    const tools = data.tools || ""
    configs[name] = {
      description: data.description || name,
      mode: name === "opencode-security" ? "primary" : "subagent",
      hidden: name !== "opencode-security",
      color: COLORS[data.color] || data.color,
      prompt: adaptPrompt(name, body, root),
      permission: permissionsFor(name, tools),
    }
  }
  return configs
}
