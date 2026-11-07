// FileTree / DirectoryPicker / FileBrowser 共用的树查找与不可变更新（单源）。
// 三处各自维护时签名与判空口径已经漂移（是否接受 null root、children 缺省），
// 收敛到这里；SessionList 的 findNode 操作的是另一棵树（SessionTreeNode），
// 不在收敛范围。

import type { TreeNode } from '@/components/FileTree.js'

/** 在树中按 path 查找节点（深度优先）。node 为 null 时返回 null。 */
export function findNode(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path === path) return node
  for (const c of node.children ?? []) {
    const found = findNode(c, path)
    if (found) return found
  }
  return null
}

/** 不可变更新：设置 path 节点的 children。路径未命中/子树未加载时原样返回入参引用。 */
export function setChildren(node: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (node.path === path) return { ...node, children }
  if (!node.children) return node
  return { ...node, children: node.children.map((c) => setChildren(c, path, children)) }
}
