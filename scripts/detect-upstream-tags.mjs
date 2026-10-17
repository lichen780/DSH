#!/usr/bin/env node
/**
 * Detect upstream release tags that this repository has not packaged yet.
 *
 * Upstream tag pushes cannot reach a third-party repository, so this runs on a schedule and
 * derives "already handled" from this repository's own releases: one release named
 * `<PROCESSED_PREFIX><upstream-tag>` exists per successfully packaged tag, so the pipeline keeps
 * no external state and is idempotent across reruns.
 *
 * Reads everything over the REST API, so a local dry run needs no git remote access:
 *   node scripts/detect-upstream-tags.mjs --self-test
 */

import { appendFileSync } from 'node:fs'

const UPSTREAM = process.env.UPSTREAM_REPO ?? 'deepseek-ai/deepseek-harness'
const TAG_PREFIX = process.env.UPSTREAM_TAG_PREFIX ?? 'dsh-v'
const PROCESSED_PREFIX = process.env.PROCESSED_TAG_PREFIX ?? 'desktop-'
const MAX_TAGS = Number.parseInt(process.env.MAX_TAGS_PER_RUN ?? '3', 10)
const RUNNERS = JSON.parse(process.env.TARGET_RUNNERS ?? '{"win-x64":"windows-latest"}')
const REQUIRE_NPM = process.env.REQUIRE_NPM_RUNTIME !== 'false'
const SELF = process.env.GITHUB_REPOSITORY ?? process.env.STATE_REPOSITORY ?? ''
const FORCE_TAG = (process.env.FORCE_TAG ?? '').trim()
/** npm package holding the runtime each installer bundles; rename it here if upstream renames it. */
const NPM_PACKAGE = process.env.NPM_RUNTIME_PACKAGE ?? '@deepseek-ai/dsh'

/** The unsigned packaging entry point upstream exposes for each supported target. */
const PACKAGE_SCRIPTS = {
  'win-x64': 'package:win:x64:unsigned',
  'mac-arm64': 'package:mac:arm64:unsigned',
  'mac-x64': 'package:mac:x64:unsigned',
}

/** Numeric-identifier-aware semver comparison; a missing prerelease ranks highest. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  // A release outranks any of its own prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const one = a.pre[index]
    const two = b.pre[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    const numericOne = /^\d+$/u.test(one)
    const numericTwo = /^\d+$/u.test(two)
    if (numericOne && numericTwo) {
      const delta = Number(one) - Number(two)
      if (delta !== 0) return delta
      continue
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (numericOne !== numericTwo) return numericOne ? -1 : 1
    const delta = one.localeCompare(two)
    if (delta !== 0) return delta
  }
  return 0
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function apiHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'desktop-tag-watch',
    ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
  }
}

async function apiPage(url) {
  const response = await fetch(url, { headers: apiHeaders() })
  if (response.status === 404) return undefined
  if (response.status === 403 || response.status === 429) {
    // Distinguish the two causes: a spent quota clears itself, a missing permission does not.
    const remaining = response.headers.get('x-ratelimit-remaining')
    throw new Error(remaining === '0'
      ? `${url}: GitHub API rate limit exhausted; set GITHUB_TOKEN or wait for the window to reset`
      : `${url}: access denied (403); the workflow token needs contents: read on this repository`)
  }
  if (response.status !== 200) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`)
  }
  return response.json()
}

/**
 * All upstream tag names under the release prefix.
 *
 * Returns the total tag count as well: a repository that clearly has tags but yields no match means
 * the naming convention moved, and that must fail loudly instead of reporting "nothing to do".
 */
async function upstreamTags() {
  const names = []
  let truncated = false
  const MAX_PAGES = 50
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await apiPage(`https://api.github.com/repos/${UPSTREAM}/tags?per_page=100&page=${page}`)
    if (batch === undefined) throw new Error(`upstream repository ${UPSTREAM} is not reachable`)
    names.push(...batch.map(entry => entry.name))
    if (batch.length < 100) break
    if (page === MAX_PAGES) truncated = true
  }
  const unique = [...new Set(names)]
  const matched = unique.filter(name => name.startsWith(TAG_PREFIX))
  if (matched.length === 0 && unique.length > 0) {
    throw new Error(
      `upstream ${UPSTREAM} has ${unique.length} tags but none start with "${TAG_PREFIX}"; `
      + `the tag convention probably changed (newest seen: "${unique[0]}"). `
      + `Update UPSTREAM_TAG_PREFIX instead of touching this script.`,
    )
  }
  return { matched, total: unique.length, truncated }
}

/** Upstream tags this repository already published a desktop release for. */
async function processedTags() {
  // Fixture hook for local dry runs and pipeline self-tests.
  const fixture = (process.env.PROCESSED_TAGS_FIXTURE ?? '').trim()
  if (fixture !== '') return new Set(fixture.split(',').map(tag => tag.trim()).filter(tag => tag !== ''))
  if (SELF === '') return new Set()
  const tags = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await apiPage(`https://api.github.com/repos/${SELF}/releases?per_page=100&page=${page}`)
    if (batch === undefined) {
      // An unreachable ledger must not silently become an empty one: that would republish the
      // newest tag on every run and delete its existing release.
      throw new Error(`ledger repository ${SELF} is not readable; check that this workflow runs in that repository and the token has contents: read`)
    }
    tags.push(...batch.map(entry => entry.tag_name))
    if (batch.length < 100) break
  }
  return new Set(tags.filter(tag => tag.startsWith(PROCESSED_PREFIX))
    .map(tag => tag.slice(PROCESSED_PREFIX.length)))
}

/** The packaged runtime is installed from npm, so an unpublished version cannot be packaged yet. */
async function publishedOnNpm(version) {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json', 'user-agent': 'desktop-tag-watch' },
  })
  return response.status === 200
}

async function main() {
  const targets = Object.entries(RUNNERS).map(([target, runsOn]) => ({ target, runsOn }))
  const known = await processedTags()
  const version = tag => tag.slice(TAG_PREFIX.length)
  const { matched, total, truncated } = await upstreamTags()

  // A version scheme this parser no longer understands would skip every tag as "unparseable".
  const parseable = matched.filter(tag => parseVersion(version(tag)) !== undefined)
  if (matched.length > 0 && parseable.length === 0) {
    throw new Error(
      `${matched.length} upstream tags start with "${TAG_PREFIX}" but none parse as semver `
      + `(newest: "${matched[0]}"); the version scheme changed and this pipeline needs updating.`,
    )
  }

  // The newest already-published version bounds the work: a tag older than it is release history,
  // not a new release, so publishing it would backfill and re-publish stale installers.
  let newestKnown
  for (const tag of known) {
    const candidate = version(tag)
    if (parseVersion(candidate) === undefined) continue
    if (newestKnown === undefined || compareVersions(candidate, newestKnown) > 0) newestKnown = candidate
  }

  const pending = [...parseable]
    .sort((left, right) => compareVersions(version(right), version(left)))
    .filter(tag => !known.has(tag)
      && (newestKnown === undefined || compareVersions(version(tag), newestKnown) > 0))

  // A fresh ledger would otherwise walk the whole back catalogue one entry per scheduled run.
  const queue = newestKnown === undefined ? pending.slice(0, 1) : pending.slice(0, MAX_TAGS)

  const selected = []
  const skipped = []
  // A manual run pins one tag and repackages it even when the ledger already lists it.
  const pool = FORCE_TAG === '' ? queue : [FORCE_TAG]
  for (const tag of pool) {
    const candidate = version(tag)
    if (parseVersion(candidate) === undefined) {
      skipped.push({ tag, reason: 'unparseable version' })
      continue
    }
    // Still refuse a version npm cannot serve, because the runtime install would fail anyway.
    if (REQUIRE_NPM && !await publishedOnNpm(candidate)) {
      skipped.push({ tag, reason: 'runtime not published to npm yet' })
      continue
    }
    selected.push({ tag, version: candidate })
  }

  const matrix = selected.flatMap(({ tag, version }) => targets.map(({ target, runsOn }) => ({
    tag,
    version,
    target,
    runsOn,
    script: PACKAGE_SCRIPTS[target],
    // Artifact names must survive a round trip through an artifact name, so keep them conservative.
    artifact: `${target}-${version}`.replaceAll(/[^0-9A-Za-z._-]/gu, '-'),
  })))

  // A misspelled target would otherwise reach the build job as an undefined script name.
  const unknown = matrix.find(entry => entry.script === undefined)
  if (unknown !== undefined) throw new Error(`unsupported target: ${unknown.target}`)

  const npmBlocked = skipped.filter(entry => entry.reason === 'runtime not published to npm yet')
  const warnings = [
    ...(truncated ? [`Only the first ${total} upstream tags were read; raise MAX pages if the history grows.`] : []),
    // Every candidate blocked on npm usually means the package was renamed, not that npm is slow
    // for weeks — surface it as an annotation instead of a quietly green run.
    ...(pending.length > 0 && selected.length === 0 && npmBlocked.length === pending.length
      ? [`All ${npmBlocked.length} pending tag(s) are missing from npm as \`${NPM_PACKAGE}\`; if this persists, the runtime package was probably renamed (set NPM_RUNTIME_PACKAGE).`]
      : []),
  ]

  const summary = [
    '## Upstream tag watch',
    '',
    `Upstream: \`${UPSTREAM}\` | ledger: \`${SELF || 'not configured'}\` | tags seen: ${total} | released: ${known.size} | newest released: \`${newestKnown ?? 'none'}\``,
    '',
    selected.length === 0
      ? `Nothing to package. Pending newer tags: ${pending.length}.`
      : `Selected: ${selected.map(entry => `\`${entry.tag}\``).join(', ')} (newer than \`${newestKnown ?? 'ledger bootstrap'}\`)`,
    ...(skipped.length === 0 ? [] : ['', 'Skipped:', ...skipped.map(entry => `- \`${entry.tag}\`: ${entry.reason}`)]),
    ...(warnings.length === 0 ? [] : ['', ...warnings.map(text => `> [!WARNING]\n> ${text}`)]),
  ].join('\n')

  // GitHub renders ::warning:: as an annotation on the run, which is visible without opening logs.
  for (const text of warnings) console.log(`::warning::${text}`)

  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `has_work=${matrix.length > 0}`,
      `count=${selected.length}`,
      `matrix=${JSON.stringify(matrix)}`,
      `tags=${JSON.stringify(selected.map(entry => entry.tag))}`,
      '',
    ].join('\n'))
  }
  if (!process.env.GITHUB_OUTPUT || process.argv.includes('--self-test')) {
    console.log(JSON.stringify({ matrix }, undefined, 2))
    const sample = ['0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1', '0.1.7-rc.1', '0.2.0-rc.2']
    console.log(`semver order: ${[...sample].sort(compareVersions).join(' < ')}`)
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('detect-upstream-tags.mjs')) {
  await main()
}
