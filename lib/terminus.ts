import { exec, spawn } from 'child_process'
export { computeStages, findByPrefix } from '@/lib/pipeline'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

const ENV = { ...process.env, TERMINUS_HIDE_UPDATE_MESSAGE: '1' }

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
}

function isNoise(line: string): boolean {
  return /^\s*(Deprecated|Warning|Notice|PHP):/i.test(line)
}

export function run(cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(cmd, { env: ENV }, (err, stdout, stderr) => {
      resolve({
        stdout: stripAnsi(stdout ?? ''),
        stderr: stripAnsi(stderr ?? ''),
        code: err ? (err.code ?? 1) : 0,
      })
    })
  })
}

// Streams stdout/stderr line-by-line into onLine as the command runs.
// Use for long Terminus operations so output appears in real time.
export function runStream(
  cmd: string,
  onLine: (line: string) => void,
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env: ENV })

    const handle = (data: Buffer) => {
      const lines = stripAnsi(data.toString()).split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed && !isNoise(trimmed)) onLine(trimmed)
      }
    }

    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('close', (code) => resolve({ code: code ?? 0 }))
  })
}

export async function getLatestCommitHash(site: string, env: string): Promise<string | null> {
  const result = await run(`terminus env:code-log ${site}.${env} --format=json 2>/dev/null`)
  try {
    const data = JSON.parse(result.stdout)
    const first = data[0]
    for (const key of ['hash', 'Hash', 'commit', 'sha']) {
      if (first?.[key]) return String(first[key])
    }
  } catch {}
  return null
}
