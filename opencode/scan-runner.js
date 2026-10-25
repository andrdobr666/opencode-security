import { readFile } from "node:fs/promises"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

let compiled

// workflows/scan.js is the OpenCode workflow module: top-level await, and
// agent/parallel/pipeline/phase/log/args injected by that runtime. Wrap it so
// the same file runs under Node with those bindings passed in.
export async function loadScan(scanPath) {
  if (compiled) return compiled
  const source = await readFile(scanPath, "utf8")
  if (!source.startsWith("export const meta=")) {
    throw new Error("workflows/scan.js no longer starts with its meta export; the OpenCode wrapper needs an update")
  }
  const body = source.replace(/^export const meta=/, "const meta=")
  // scan.js declares its own functions (including `rt`). Those hoist inside this
  // wrapper and would hide a parameter of the same name, so the runtime object
  // uses a name the workflow does not.
  const wrapped = `export async function run(args, __runtime) {
  const agent = __runtime.agent
  const parallel = __runtime.parallel
  const pipeline = __runtime.pipeline
  const phase = __runtime.phase
  const log = __runtime.log
  ${body}
}
`
  const dir = await mkdtemp(join(tmpdir(), "opencode-security-scan-"))
  const file = join(dir, "scan-run.mjs")
  await writeFile(file, wrapped)
  compiled = await import(pathToFileURL(file).href)
  return compiled
}

export async function runScan(scanPath, args, runtime) {
  const mod = await loadScan(scanPath)
  return mod.run(args ?? {}, runtime)
}
