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
// export:embed 构建里没有生效（@components 等别名 resolve 失败，
// 见 build-upstream-apk.yml 报错）。这里显式补一份 extraNodeModules
// 做兜底，跟 tsconfig.json 的 paths 保持同步——两边同时改。
config.resolver.extraNodeModules = {
  ...monorepoPackages,
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
config.resolver.blacklistRE = [/packages\/.*/]
config.resolver.assetExts.push('proto', 'bin')

module.exports = config
