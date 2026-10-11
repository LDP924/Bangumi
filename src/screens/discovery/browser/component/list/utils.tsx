/*
 * @Author: czy0729
 * @Date: 2024-01-11 05:20:21
 * @Last Modified by: czy0729
 * @Last Modified time: 2026-10-10 10:20:00
 *
 * 列表 renderItem
 */
import Item from '../item'

import type { TagItem } from '@stores/tag/types'
import type { RenderItem } from '@types'

export function renderItem({ item, index }: RenderItem<TagItem>) {
  return <Item item={item} index={index} />
}
