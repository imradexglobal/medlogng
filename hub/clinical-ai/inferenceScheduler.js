// One Host inference lane shared by local AI generation and Whisper. It keeps
// CPU/RAM intensive model runs from overlapping on low-memory Windows Hosts.
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
