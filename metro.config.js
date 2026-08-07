/*
 * @Author: czy0729
 * @Date: 2023-04-15 04:37:50
 * @Last Modified by: czy0729
 * @Last Modified time: 2026-04-21 13:05:10
 */
/** Learn more https://docs.expo.io/guides/customizing-metro */
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

// const FileStore = require('metro-cache').FileStore
// const path = require('path')
// config.cacheStores = [new FileStore({ root: path.join(__dirname, 'metro-cache') })]

const monorepoPackages = {
  stream: require.resolve('stream-browserify')
}

// [修复 2026-08] Metro 原生 tsconfig 路径解析在这个项目的 CI/Gradle
// export:embed 构建里没有生效，@components/@utils 等别名 resolve 失败
// （见 build-upstream-apk.yml 报错）。
//
// 这里用 resolveRequest 自己做前缀匹配做兜底，不用 extraNodeModules——
// extraNodeModules 对 '@xxx' 这种以 @ 开头的 key 只能精确匹配整个模块名，
// 遇到 '@utils/hooks' 这种带子路径的导入会被当成一个独立的 scoped 包名
// 去查找（跟 '@babel/core' 是同一个包同理），查不到对应条目，
// 所以只有不带子路径的用法（如 '@components'）能生效，带子路径的
// （如 '@utils/hooks'）全部会漏网。
//
// 下面这份要跟 tsconfig.json 的 paths 保持同步——两边同时改。
const aliasMap = {
  '@_': path.resolve(__dirname, 'src/screens/_'),
  '@assets': path.resolve(__dirname, 'src/assets'),
  '@bgm': path.resolve(__dirname, 'src/assets/images/bgm'),
  '@components': path.resolve(__dirname, 'src/components'),
  '@constants': path.resolve(__dirname, 'src/constants'),
  '@screens': path.resolve(__dirname, 'src/screens'),
  '@stores': path.resolve(__dirname, 'src/stores'),
  '@styles': path.resolve(__dirname, 'src/styles'),
  '@tinygrail': path.resolve(__dirname, 'src/screens/tinygrail'),
  '@types': path.resolve(__dirname, 'src/types'),
  '@utils': path.resolve(__dirname, 'src/utils'),
  '@src': path.resolve(__dirname, 'src'),
  '@': path.resolve(__dirname, './')
}

// 按 key 长度从长到短排序：保证更具体的前缀（比如 '@utils'）
// 优先于更短/更宽泛的前缀（比如兜底用的 '@'）被匹配到
const aliasKeys = Object.keys(aliasMap).sort((a, b) => b.length - a.length)

config.resolver.extraNodeModules = monorepoPackages

const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const key of aliasKeys) {
    if (moduleName === key || moduleName.startsWith(key + '/')) {
      const rest = moduleName.slice(key.length)
      const target = aliasMap[key] + rest
      return context.resolveRequest(context, target, platform)
    }
  }

  if (upstreamResolveRequest) {
    return upstreamResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

config.resolver.blacklistRE = [/packages\/.*/]
config.resolver.assetExts.push('proto', 'bin')

module.exports = config
