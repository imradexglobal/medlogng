// One Host inference lane for local clinical-note generation. Speech recognition
// is online and does not run through this local CPU/RAM queue.
export function createInferenceScheduler() {
  let tail = Promise.resolve()
  let active = ''
  let waiting = 0
  return {
    run(kind, work) {
      waiting += 1
      const job = tail.then(async () => {
        waiting -= 1
        active = kind
        try { return await work() }
        finally { active = '' }
      })
      tail = job.catch(() => {})
      return job
    },
    status() { return { active, waiting, concurrency: 1 } },
  }
}
