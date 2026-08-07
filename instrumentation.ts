// Node.js-only startup logic lives in instrumentation.node.ts.
// Next.js (15.3+) runs that file exclusively in the Node.js runtime,
// avoiding edge-runtime static analysis warnings on process.on / process.exit.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startSocketMode } = await import('./lib/socketMode')
    await startSocketMode()
  }
}
