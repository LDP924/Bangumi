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
    await resolveCommand(options)
    return
  }

  if (command === 'upload') {
    await uploadCommand(options)
    return
  }

  throw new Error('Usage: upstream-apk.mjs <resolve|upload> [--tag <x.y.z>] [--apk <path>] [--sha <path>]')
}

async function resolveCommand(options) {
  const requestedTag = (options.tag || process.env.REQUESTED_TAG || '').trim()
  const forceRebuild = isTruthy(process.env.FORCE_REBUILD)
  const tags = await listUpstreamSemverTags()
  const tag = requestedTag || tags[0]

  if (!semverTagPattern.test(tag)) {
    throw new Error(`Upstream tag must match x.y.z, got: ${tag}`)
  }

  if (!tags.includes(tag)) {
    throw new Error(`Upstream tag not found in ${upstreamRepo}: ${tag}`)
  }

  const releaseTag = releaseTagFor(tag)
  const assetName = apkAssetName(tag)
  const shaName = `${assetName}.sha256`
  const release = await getReleaseByTag(targetRepo(), releaseTag)
  const assets = release ? await listReleaseAssets(targetRepo(), release.id) : []
  const hasApk = assets.some(asset => asset.name === assetName)
  const hasSha = assets.some(asset => asset.name === shaName)
  const shouldBuild = forceRebuild || !(hasApk && hasSha) ? 'true' : 'false'

  setOutput('tag', tag)
  setOutput('release_tag', releaseTag)
  setOutput('asset_name', assetName)
  setOutput('sha_name', shaName)
  setOutput('should_build', shouldBuild)

  console.log(`Upstream tag: ${tag}`)
  console.log(`Target release: ${releaseTag}`)
  console.log(
    forceRebuild
      ? `Force rebuild requested; existing ${assetName} and ${shaName} will be replaced if present.`
      : hasApk && hasSha
      ? `Existing APK and checksum assets found: ${assetName}, ${shaName}`
      : `APK assets will be built: ${assetName}, ${shaName}`,
  )
}

async function uploadCommand(options) {
  const tag = requiredOption(options, 'tag')
  const apkPath = requiredOption(options, 'apk')
  const shaPath = requiredOption(options, 'sha')

  if (!semverTagPattern.test(tag)) {
    throw new Error(`Upstream tag must match x.y.z, got: ${tag}`)
  }

  ensureFile(apkPath)
  ensureFile(shaPath)

  const repo = targetRepo()
  const releaseTag = releaseTagFor(tag)
  const assetName = apkAssetName(tag)
  const shaName = `${assetName}.sha256`
  const release = await ensureRelease(repo, tag, releaseTag)
  const assets = await listReleaseAssets(repo, release.id)
  const hasApk = assets.some(asset => asset.name === assetName)
  const hasSha = assets.some(asset => asset.name === shaName)
  const forceRebuild = isTruthy(process.env.FORCE_REBUILD)

  if (hasApk && hasSha && !forceRebuild) {
    console.log(`Release already has ${assetName} and ${shaName}; leaving them unchanged.`)
    return
  }

  for (const asset of assets.filter(asset => asset.name === assetName || asset.name === shaName)) {
    await deleteReleaseAsset(repo, asset.id)
  }

  await uploadAssetWithRetry(release.upload_url, apkPath, assetName, 'application/vnd.android.package-archive')
  await uploadAssetWithRetry(release.upload_url, shaPath, shaName, 'text/plain; charset=utf-8')

  console.log(`Uploaded ${assetName} and ${shaName}`)
  console.log(`Release URL: ${release.html_url}`)
}

async function listUpstreamSemverTags() {
  const tags = []

  for (let page = 1; page <= 20; page += 1) {
    const pageTags = await githubJson(`/repos/${upstreamRepo}/tags?per_page=100&page=${page}`)
    if (!Array.isArray(pageTags)) {
      throw new Error('Unexpected GitHub tags response')
    }

    tags.push(...pageTags.map(tag => tag.name).filter(name => semverTagPattern.test(name)))

    if (pageTags.length < 100) {
      break
    }
  }

  const uniqueTags = [...new Set(tags)]
  uniqueTags.sort(compareSemverDesc)

  if (!uniqueTags.length) {
    throw new Error(`No semantic version tags found in ${upstreamRepo}`)
  }

  return uniqueTags
}

async function ensureRelease(repo, upstreamTag, releaseTag) {
  const existing = await getReleaseByTag(repo, releaseTag)
  const body = releaseBody(upstreamTag)

  if (existing) {
    return githubJson(`/repos/${repo}/releases/${existing.id}`, {
      method: 'PATCH',
      body: {
        name: releaseName(upstreamTag),
        body,
        prerelease: false,
        draft: false,
        make_latest: 'false',
      },
    })
  }

  return githubJson(`/repos/${repo}/releases`, {
    method: 'POST',
    body: {
      tag_name: releaseTag,
      name: releaseName(upstreamTag),
      body,
      prerelease: false,
      draft: false,
      make_latest: 'false',
    },
  })
}

async function getReleaseByTag(repo, tag) {
  return githubJson(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    allow404: true,
  })
}

async function listReleaseAssets(repo, releaseId) {
  return githubJson(`/repos/${repo}/releases/${releaseId}/assets?per_page=100`)
}

async function deleteReleaseAsset(repo, assetId) {
  await githubJson(`/repos/${repo}/releases/assets/${assetId}`, {
    method: 'DELETE',
    expectJson: false,
  })
}

async function uploadAssetWithRetry(uploadUrlTemplate, filePath, name, contentType) {
  const uploadUrl = `${uploadUrlTemplate.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`
  const size = statSync(filePath).size

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: githubHeaders({
          'Content-Type': contentType,
          'Content-Length': String(size),
        }),
        body: createReadStream(filePath),
        duplex: 'half',
      })

      if (response.ok) {
        return
      }

      const errorText = await response.text()
      lastError = new Error(`GitHub upload failed (${response.status}): ${errorText}`)

      if (response.status === 422) {
        throw lastError
      }

      console.error(`Upload attempt ${attempt}/${maxRetries} failed: ${lastError.message}`)
    } catch (error) {
      if (error.message.includes('422')) {
        throw error
      }
      lastError = error
      console.error(`Upload attempt ${attempt}/${maxRetries} failed: ${error.message}`)
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
    }
  }

  throw lastError
}

async function githubJson(path, options = {}) {
  const {
    method = 'GET',
    body,
    allow404 = false,
    expectJson = true,
  } = options

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: githubHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    })

    if (allow404 && response.status === 404) {
      return null
    }

    if (!response.ok) {
      const message = await response.text()
      lastError = new Error(`GitHub API ${method} ${path} failed (${response.status}): ${message}`)

      if (response.status === 404 || response.status === 422 || response.status < 500) {
        throw lastError
      }

      console.error(`API attempt ${attempt}/${maxRetries} failed: ${lastError.message}`)
    } else {
      if (!expectJson || response.status === 204) {
        return null
      }
      return response.json()
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
    }
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

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const equalsIndex = arg.indexOf('=')
    if (equalsIndex > -1) {
      options[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1)
      continue
    }

    const key = arg.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    options[key] = value
    index += 1
  }

  return { command, options }
}

function compareSemverDesc(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index]
    }
  }

  return 0
}

function releaseBody(tag) {
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${targetRepo()}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null

  return [
    `Automated signed APK build for upstream Bangumi tag \`${tag}\`.`,
    `Source: https://github.com/${upstreamRepo}/tree/${tag}`,
    `Source archive: https://github.com/${upstreamRepo}/archive/refs/tags/${tag}.zip`,
    `This APK is signed with the project release keystore and ready for installation on arm64-v8a (64-bit ARM) devices running Android 5.0+ (API 21).`,
    `SHA256 checksum is provided alongside the APK for integrity verification.`,
    runUrl ? `Build run: ${runUrl}` : null,
  ].filter(Boolean).join('\n\n')
}

function releaseName(tag) {
  return `Bangumi ${tag} APK`
}

function releaseTagFor(tag) {
  return `upstream-apk-${tag}`
}

function apkAssetName(tag) {
  return `Bangumi-${tag}.apk`
}

function targetRepo() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY is required')
  }
  return repo
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    throw new Error('GITHUB_TOKEN is required')
  }
  return token
}

function requiredOption(options, name) {
  const value = (options[name] || '').trim()
  if (!value) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function isTruthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase())
}

function ensureFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`)
  }

  if (!statSync(filePath).isFile()) {
    throw new Error(`Path is not a file: ${filePath}`)
  }
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`)
  }
}

main().catch(error => {
  console.error(`::error::${error.message}`)
  process.exit(1)
})
