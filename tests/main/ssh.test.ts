import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSshConnectArgs,
  buildSshProbeArgs,
  buildSshResolveArgs,
  classifySshFailure,
  parseSshConfigAliases
} from '../../src/main/control/ssh'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{ root: string; config: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'prime-ssh-test-'))
  temporaryDirectories.push(root)
  const sshDirectory = path.join(root, '.ssh')
  await mkdir(sshDirectory, { recursive: true })
  return { root, config: path.join(sshDirectory, 'config') }
}

describe('SSH config discovery', () => {
  it('keeps concrete aliases while ignoring negated and wildcard entries', async () => {
    const { root, config } = await fixture()
    await writeFile(
      config,
      [
        'Host *',
        '  ServerAliveInterval 30',
        'Host devbox !blocked gpu-*',
        '  HostName 10.0.0.4',
        'Host "quoted-host" another_host',
        '  User prime'
      ].join('\n')
    )

    const aliases = await parseSshConfigAliases({ configPath: config, homeDirectory: root })
    expect(aliases.map(({ alias }) => alias)).toEqual(['devbox', 'quoted-host', 'another_host'])
  })

  it('recursively expands Include globs and terminates cycles', async () => {
    const { root, config } = await fixture()
    const includes = path.join(path.dirname(config), 'conf.d')
    await mkdir(includes)
    await writeFile(config, ['Include conf.d/*.conf', 'Host root-host', '  HostName root'].join('\n'))
    await writeFile(
      path.join(includes, '10-work.conf'),
      ['Host work', '  HostName work.internal', 'Include ../config'].join('\n')
    )
    await writeFile(path.join(includes, '20-lab.conf'), ['Host lab work', '  HostName lab'].join('\n'))

    const aliases = await parseSshConfigAliases({ configPath: config, homeDirectory: root })
    expect(aliases.map(({ alias }) => alias)).toEqual(['work', 'lab', 'root-host'])
    expect(aliases.find(({ alias }) => alias === 'work')?.sourceFiles).toHaveLength(2)
  })

  it('ignores missing Include matches without hiding aliases in the root config', async () => {
    const { root, config } = await fixture()
    await writeFile(config, ['Include missing/*.conf', 'Host still-here', '  HostName example.test'].join('\n'))

    await expect(parseSshConfigAliases({ configPath: config, homeDirectory: root })).resolves.toEqual([
      { alias: 'still-here', sourceFiles: [await import('node:fs/promises').then(({ realpath }) => realpath(config))] }
    ])
  })
})

describe('SSH command construction', () => {
  it('uses fixed token arrays for resolution, probe, and the persistent connection', () => {
    expect(buildSshResolveArgs('devbox')).toEqual(['-G', 'devbox'])
    expect(buildSshProbeArgs('devbox')).toEqual(['devbox', 'prime-agent-hostd', 'probe', '--json'])
    expect(buildSshConnectArgs('devbox')).toEqual([
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      'devbox',
      'prime-agent-hostd',
      'connect',
      '--stdio'
    ])
  })

  it('rejects aliases that could be interpreted as options or shell text', () => {
    expect(() => buildSshProbeArgs('-oProxyCommand=bad')).toThrow()
    expect(() => buildSshProbeArgs('host; calc')).toThrow()
    expect(() => buildSshConnectArgs('*.internal')).toThrow()
  })

  it('turns common OpenSSH failures into actionable structured categories', () => {
    expect(classifySshFailure(undefined, 'devbox', 'Host key verification failed').code).toBe(
      'ssh.host_key_verification_failed'
    )
    expect(classifySshFailure(undefined, 'devbox', 'Permission denied (publickey)').code).toBe(
      'ssh.authentication_required'
    )
  })
})
