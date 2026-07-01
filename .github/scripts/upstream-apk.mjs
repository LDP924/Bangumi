#!/usr/bin/env node

import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs'

const upstreamRepo = 'czy0729/Bangumi'
const semverTagPattern = /^\d+\.\d+\.\d+$/
const apiBase = 'https://api.github.com'
const apiVersion = '2022-11-28'
const maxRetries = 3
const retryDelayMs = 2000

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))

  if (command === 'resolve') {
    await resolveCommand()
    return
  }

  if (command === 'upload') {
    await uploadCommand(options)
    return
  }

  throw new Error('Usage: upstream-apk.mjs <resolve|upload> [--tag] [--apk] [--clone-apk] [--source-ref] [--mode]')
}

async function resolveCommand() {
  const tags = await listUpstreamSemverTags()
  const baseVersion = tags[0]

  const latestCommit = await getUpstreamHeadCommit()
  const tagCommit = await getTagCommit(baseVersion)

  if (latestCommit === tagCommit) {
    const releaseTag = releaseTagFor(baseVersion)
    const release = await getReleaseByTag(targetRepo(), releaseTag)
    const assets = release ? await listReleaseAssets(targetRepo(), release.id) : []
    const hasOriginal = assets.some(a => a.name === apkAssetName(baseVersion))
    const hasClone = assets.some(a => a.name === cloneAssetName(baseVersion))
    const shouldBuild = !(hasOriginal && hasClone) ? 'true' : 'false'

    setOutput('should_build', shouldBuild)
    setOutput('build_tag', baseVersion)
    setOutput('source_ref', baseVersion)
    setOutput('build_mode', 'release')
    setOutput('asset_name', apkAssetName(baseVersion))
    setOutput('clone_asset_name', cloneAssetName(baseVersion))

    console.log(`Mode: release | Version: ${baseVersion} | ${shouldBuild === 'true' ? 'Will build' : 'Already built'}`)
    return
  }

  const prevBuild = await findLatestCommitBuild(baseVersion)
  const lastBuiltCommit = prevBuild ? extractBuiltFrom(prevBuild.body) : null

  if (lastBuiltCommit && lastBuiltCommit === latestCommit) {
    const prevTag = prevBuild.tag.replace(/^upstream-apk-/, '')
    const release = await getReleaseByTag(targetRepo(), prevBuild.tag)
    const assets = release ? await listReleaseAssets(targetRepo(), release.id) : []
    const hasOriginal = assets.some(a => a.name === apkAssetName(prevTag))
    const hasClone = assets.some(a => a.name === cloneAssetName(prevTag))
    const shouldBuild = !(hasOriginal && hasClone) ? 'true' : 'false'

    setOutput('should_build', shouldBuild)
    setOutput('build_tag', prevTag)
    setOutput('source_ref', latestCommit)
    setOutput('build_mode', 'commit')
    setOutput('asset_name', apkAssetName(prevTag))
    setOutput('clone_asset_name', cloneAssetName(prevTag))

    console.log(`Mode: commit | ${shouldBuild === 'true' ? 'Rebuilding (missing assets)' : 'Already built'} for ${latestCommit.slice(0, 7)}`)
    return
  }

  const nextIncrement = prevBuild ? nextIncrementTag(baseVersion, prevBuild.tag) : `${baseVersion}.1`

  setOutput('should_build', 'true')
  setOutput('build_tag', nextIncrement)
  setOutput('source_ref', latestCommit)
  setOutput('build_mode', 'commit')
  setOutput('asset_name', apkAssetName(nextIncrement))
  setOutput('clone_asset_name', cloneAssetName(nextIncrement))

  console.log(`Mode: commit | Version: ${nextIncrement} | Source: ${latestCommit.slice(0, 7)} | Will build`)
}

async function uploadCommand(options) {
  const buildTag = requiredOption(options, 'tag')
  const apkPath = requiredOption(options, 'apk')
  const sourceRef = requiredOption(options, 'source-ref')
  const mode = requiredOption(options, 'mode')
  const cloneApkPath = requiredOption(options, 'clone-apk')

  ensureFile(apkPath)
  ensureFile(cloneApkPath)

  const repo = targetRepo()
  const releaseTag = releaseTagFor(buildTag)
  const assetName = apkAssetName(buildTag)
  const cloneName = cloneAssetName(buildTag)
  const body = await buildReleaseBody(buildTag, sourceRef, mode)

  const release = await ensureRelease(repo, releaseTag, buildTag, body)
  const assets = await listReleaseAssets(repo, release.id)

  const toDelete = [assetName, cloneName]
  for (const asset of assets.filter(a => toDelete.includes(a.name))) {
    await deleteReleaseAsset(repo, asset.id)
  }

  await uploadAssetWithRetry(release.upload_url, apkPath, assetName, 'application/vnd.android.package-archive')
  await uploadAssetWithRetry(release.upload_url, cloneApkPath, cloneName, 'application/vnd.android.package-archive')

  console.log(`Uploaded ${assetName} and ${cloneName}`)
  console.log(`Release URL: ${release.html_url}`)
}

async function buildReleaseBody(buildTag, sourceRef, mode) {
  if (mode === 'release') {
    const upstreamRelease = await fetchUpstreamRelease(buildTag)
    const body = upstreamRelease?.body?.trim() || ''
    return `${body}\n\n<!-- built-from: ${sourceRef} -->`
  }

  const parts = buildTag.split('.')
  const baseVersion = `${parts[0]}.${parts[1]}.${parts[2]}`

  const prevBuild = await findLatestCommitBuild(baseVersion)
  const sinceRef = prevBuild ? extractBuiltFrom(prevBuild.body) : baseVersion

  if (sinceRef === sourceRef && prevBuild?.body) {
    return prevBuild.body
  }

  let commits = []
  try {
    commits = await fetchCommitsBetween(sinceRef, sourceRef)
  } catch (error) {
    console.error('Failed to fetch commits:', error.message)
  }

  if (commits.length === 0) {
    const shortSha = sourceRef.slice(0, 7)
    return `- [Update to ${shortSha}](https://github.com/${upstreamRepo}/commit/${sourceRef})\n\n<!-- built-from: ${sourceRef} -->`
  }

  const lines = commits.map(c => `- ${c.message} (${c.sha})`)
  lines.push('')
  lines.push(`<!-- built-from: ${sourceRef} -->`)

  return lines.join('\n')
}

async function fetchUpstreamRelease(tag) {
  try {
    return await githubJson(`/repos/${upstreamRepo}/releases/tags/${tag}`, { allow404: true })
  } catch {
    return null
  }
}

async function fetchCommitsBetween(fromRef, toRef) {
  try {
    const compare = await githubJson(
      `/repos/${upstreamRepo}/compare/${fromRef}...${toRef}`,
      { allow404: true },
    )
    if (!compare || !Array.isArray(compare.commits)) return []

    return compare.commits
      .map(item => ({
        message: (item.commit?.message || '').split('\n')[0].trim(),
        sha: (item.sha || '').slice(0, 7),
      }))
      .filter(c => c.message)
  } catch {
    return []
  }
}

async function getUpstreamHeadCommit() {
  const data = await githubJson(`/repos/${upstreamRepo}/commits/master`)
  if (!data?.sha) throw new Error('Failed to get upstream master HEAD')
  return data.sha
}

async function getTagCommit(tag) {
  const data = await githubJson(`/repos/${upstreamRepo}/commits/${tag}`)
  if (!data?.sha) throw new Error(`Failed to get commit for tag ${tag}`)
  return data.sha
}

async function findLatestCommitBuild(baseVersion) {
  const releases = await githubJson(`/repos/${targetRepo()}/releases?per_page=100`)
  if (!Array.isArray(releases)) return null

  const prefix = `upstream-apk-${baseVersion}.`
  const matching = releases
    .filter(r => r.tag_name.startsWith(prefix))
    .sort((a, b) => compareIncrementTags(a.tag_name, b.tag_name))

  if (matching.length === 0) return null
  const latest = matching[matching.length - 1]
  return { tag: latest.tag_name, body: latest.body || '' }
}

function nextIncrementTag(baseVersion, prevReleaseTag) {
  const prevTag = prevReleaseTag.replace(/^upstream-apk-/, '')
  const parts = prevTag.split('.')
  const lastPart = parseInt(parts[parts.length - 1], 10) || 0
  return `${baseVersion}.${lastPart + 1}`
}

function compareIncrementTags(a, b) {
  const aParts = a.replace(/^upstream-apk-/, '').split('.').map(Number)
  const bParts = b.replace(/^upstream-apk-/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const av = aParts[i] || 0
    const bv = bParts[i] || 0
    if (av !== bv) return av - bv
  }
  return 0
}

function extractBuiltFrom(body) {
  if (!body) return null
  const match = body.match(/<!-- built-from: ([a-f0-9]+) -->/)
  return match ? match[1] : null
}

async function listUpstreamSemverTags() {
  const tags = []
  for (let page = 1; page <= 20; page += 1) {
    const pageTags = await githubJson(`/repos/${upstreamRepo}/tags?per_page=100&page=${page}`)
    if (!Array.isArray(pageTags)) break
    tags.push(...pageTags.map(t => t.name).filter(n => semverTagPattern.test(n)))
    if (pageTags.length < 100) break
  }
  const unique = [...new Set(tags)]
  unique.sort(compareSemverDesc)
  if (!unique.length) throw new Error(`No semantic version tags found in ${upstreamRepo}`)
  return unique
}

async function ensureRelease(repo, releaseTag, buildTag, body) {
  const existing = await getReleaseByTag(repo, releaseTag)
  const name = `Bangumi ${buildTag} unsigned APK`

  if (existing) {
    return githubJson(`/repos/${repo}/releases/${existing.id}`, {
      method: 'PATCH',
      body: { name, body, prerelease: false, draft: false, make_latest: 'true' },
    })
  }

  return githubJson(`/repos/${repo}/releases`, {
    method: 'POST',
    body: { tag_name: releaseTag, name, body, prerelease: false, draft: false, make_latest: 'true' },
  })
}

async function getReleaseByTag(repo, tag) {
  return githubJson(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
}

async function listReleaseAssets(repo, releaseId) {
  return githubJson(`/repos/${repo}/releases/${releaseId}/assets?per_page=100`)
}

async function deleteReleaseAsset(repo, assetId) {
  await githubJson(`/repos/${repo}/releases/assets/${assetId}`, { method: 'DELETE', expectJson: false })
}

async function uploadAssetWithRetry(uploadUrlTemplate, filePath, name, contentType) {
  const uploadUrl = `${uploadUrlTemplate.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`
  const size = statSync(filePath).size

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: githubHeaders({ 'Content-Type': contentType, 'Content-Length': String(size) }),
        body: createReadStream(filePath),
        duplex: 'half',
      })
      if (response.ok) return
      const errorText = await response.text()
      lastError = new Error(`Upload failed (${response.status}): ${errorText}`)
      if (response.status === 422) throw lastError
    } catch (error) {
      if (error.message.includes('422')) throw error
      lastError = error
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, retryDelayMs * attempt))
  }
  throw lastError
}

async function githubJson(path, options = {}) {
  const { method = 'GET', body, allow404 = false, expectJson = true } = options

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: githubHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    })

    if (allow404 && response.status === 404) return null
    if (!response.ok) {
      const message = await response.text()
      lastError = new Error(`GitHub API ${method} ${path} (${response.status}): ${message}`)
      if (response.status === 404 || response.status === 422 || response.status < 500) throw lastError
    } else {
      if (!expectJson || response.status === 204) return null
      return response.json()
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, retryDelayMs * attempt))
  }
  throw lastError
}

function githubHeaders(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken()}`,
    'X-GitHub-Api-Version': apiVersion,
    ...extra,
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > -1) { options[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const val = rest[i + 1]
    if (!val || val.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = val
    i += 1
  }
  return { command, options }
}

function compareSemverDesc(a, b) {
  const ap = a.split('.').map(Number)
  const bp = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (ap[i] !== bp[i]) return bp[i] - ap[i]
  }
  return 0
}

function releaseTagFor(buildTag) {
  return `upstream-apk-${buildTag}`
}

function apkAssetName(buildTag) {
  return `bangumi_v${buildTag}_arm64-v8a.apk`
}

function cloneAssetName(buildTag) {
  return `bangumi_clone_v${buildTag}_arm64-v8a.apk`
}

function targetRepo() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  return repo
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')
  return token
}

function requiredOption(options, name) {
  const value = (options[name] || '').trim()
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function ensureFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`)
  if (!statSync(filePath).isFile()) throw new Error(`Path is not a file: ${filePath}`)
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) appendFileSync(outputPath, `${name}=${value}\n`)
}

main().catch(error => {
  console.error(`::error::${error.message}`)
  process.exit(1)
})
