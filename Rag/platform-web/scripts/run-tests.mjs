import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? collect(file) : /\.test\.(js|cjs)$/.test(entry.name) ? [file] : []
  })
}
const result = spawnSync(process.execPath, ['--test', ...collect(path.join(root, 'src')), ...collect(path.join(root, 'electron'))], { cwd: root, stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
