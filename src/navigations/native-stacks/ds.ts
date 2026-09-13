/*
 * @Author: czy0729
 * @Date: 2023-08-14 04:04:06
 * @Last Modified by: czy0729
 * @Last Modified time: 2025-04-03 20:24:37
 */
import { IOS } from '@constants'

export const DEFAULT_SCREEN_OPTIONS = {
  statusBarColor: 'transparent',
  headerShown: false,
  headerTransparent: false,
  headerShadowVisible: false,

  /**
   * 这里不再设置 cardStyle
   * cardStyle 是 @react-navigation/stack (JS 栈) 的选项, native-stack 6.x 源码里没有任何引用, 写了也不生效
   * 页面容器底色由 getScreenOptions 里的 contentStyle 提供
   */
  ...(IOS
    ? {}
    : {
        cardStyle: {
          backgroundColor: 'transparent',
          elevation: 0
        }
      }),

  /**
   * 失焦页面冻结 React 树 (screens 的 Screen 默认取 freezeEnabled(), 即 false)
   * 之前显式关掉, 导致已 push 的页面全部继续保活, 是跳转几个页面后内存打满的原因之一
   * 若发现返回页面时局部状态 / 动画不刷新, 改回 false 即可回滚
   */
  freezeOnBlur: true
} as const

export const ANIMATIONS = {
  horizontal: 'slide_from_right',
  vertical: 'slide_from_bottom',

  /**
   * 第三项 (渐变): 安卓 = 右→左滑动 + 新页渐显 (无缩放)
   *
   * 为什么借 'fade_from_bottom': 它对应的一组资源 (rns_fade_from_bottom / rns_no_animation_350 /
   * rns_no_animation_250 / rns_fade_to_bottom) 在 ScreenStack.kt 里角色正交, 且没有别的动画类型使用,
   * 四个方向刚好能各自定义 (覆盖见 android/app/src/main/res/anim/)。
   * - 'fade' 不行: open / close 复用同一对资源, 表达不了方向差异
   * - 'default' 不行: 库内 res/v33/anim-v33 有 API33+ 变体, app 侧 res/anim 的覆盖对其无效
   *
   * iOS 保持原样 (原生 fade)
   */
  scale: IOS ? 'fade' : 'fade_from_bottom'
} as const
