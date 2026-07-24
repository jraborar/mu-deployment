import { exec } from 'child_process'
export { computeStages, findByPrefix } from '@/lib/pipeline'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
}

export function run(cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { env: { ...process.env, TERMINUS_HIDE_UPDATE_MESSAGE: '1' } },
      (err, stdout, stderr) => {
        resolve({
          stdout: stripAnsi(stdout ?? ''),
          stderr: stripAnsi(stderr ?? ''),
          code: err ? (err.code ?? 1) : 0,
        })
      },
    )
  })
}

export async function getLatestCommitHash(site: string, env: string): Promise<string | null> {
  const result = await run(`terminus env:code-log -- ${site}.${env} --format=json 2>/dev/null`)
  try {
    const data = JSON.parse(result.stdout)
    const first = data[0]
    for (const key of ['hash', 'Hash', 'commit', 'sha']) {
      if (first?.[key]) return String(first[key])
    }
  } catch {}
  return null
}

