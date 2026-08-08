import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it.each([
    ['malformed JSON', '{not-json', 'storage.malformed_json'],
    ['a non-array root', '{"commands":[]}', 'storage.invalid_root'],
  ])('fails closed for %s without overwriting durable bytes', async (_label, contents, code) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prime-store-fail-closed-test-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'outbox.json')
    await writeFile(file, contents)
    const store = new AtomicJsonStore<unknown[]>(file, () => [], 1024, {
      malformedJson: 'error',
      validateRoot: (value): value is unknown[] => Array.isArray(value),
    })
    let updateCalled = false

    await expect(store.read()).rejects.toMatchObject({ code })
    await expect(store.update((current) => {
      updateCalled = true
      return [...current, { commandId: 'must-not-write' }]
    })).rejects.toMatchObject({ code })
    expect(updateCalled).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(contents)
  })

  it('keeps latency observations bounded', async () => {
    const recorder = new LatencyRecorder()
    for (let index = 0; index < 300; index += 1) {
      await recorder.measure('test', async () => index)
    }
    expect(recorder.snapshot()).toHaveLength(256)
  })
})
