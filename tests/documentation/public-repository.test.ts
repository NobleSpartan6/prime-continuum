import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepositoryFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('public repository surface', () => {
  it('keeps the source quickstart short and executable without global pnpm', () => {
    const readme = readRepositoryFile('README.md')
    expect(readme).toContain('corepack pnpm install')
    expect(readme).toContain('corepack pnpm dev')
    expect(readme).toContain('A global pnpm installation is not required.')
    expect(readme).toContain('Development preview')
    expect(readme).not.toContain('npm install --global pnpm')
  })

  it('publishes the expected community and security files', () => {
    for (const path of [
      'LICENSE',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'THIRD_PARTY_NOTICES.md',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/pull_request_template.md',
      '.github/dependabot.yml',
      'third_party/licenses/APACHE-2.0.txt',
      'third_party/licenses/DEVELOPMENT-SKILLS-MIT.txt',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true)
    }
  })

  it('declares public package metadata without making the app publishable to npm', () => {
    const manifest = JSON.parse(readRepositoryFile('package.json')) as Record<string, unknown>
    expect(manifest.private).toBe(true)
    expect(manifest.license).toBe('MIT')
    expect(manifest.homepage).toBe('https://github.com/NobleSpartan6/prime-continuum#readme')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/NobleSpartan6/prime-continuum.git',
    })
  })

  it('keeps common local credentials and generated browser state out of Git', () => {
    const ignore = readRepositoryFile('.gitignore')
    for (const pattern of [
      '.env',
      '.env.*',
      'auth.json',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '.playwright-cli/',
      'playwright-report/',
    ]) {
      expect(ignore, pattern).toContain(pattern)
    }
  })

  it('does not leak a developer home path or credential-shaped value through public docs', () => {
    const publicDocs = [
      'README.md',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'THIRD_PARTY_NOTICES.md',
    ].map(readRepositoryFile).join('\n')

    expect(publicDocs).not.toMatch(/\/(?:Users|home)\/[^/<\s]+/u)
    expect(publicDocs).not.toMatch(/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u)
    expect(publicDocs).not.toMatch(/\b(?:gh[pousr]_|github_pat_|sk-proj-)[A-Za-z0-9_-]{16,}/u)
  })
})
