import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore, LatencyRecorder } from '../../src/main/control/storage'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('native atomic storage', () => {
  it('serializes updates and leaves a complete JSON document', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prime-store-test-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'outbox.json')
    const store = new AtomicJsonStore<number[]>(file, () => [])

    await Promise.all(
      Array.from({ length: 12 }, (_, value) => store.update((current) => [...current, value]))
    )

    expect(await store.read()).toEqual(Array.from({ length: 12 }, (_, value) => value))
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(12)
  })

  it('keeps latency observations bounded', async () => {
    const recorder = new LatencyRecorder()
    for (let index = 0; index < 300; index += 1) {
      await recorder.measure('test', async () => index)
    }
    expect(recorder.snapshot()).toHaveLength(256)
  })
})
