/**
 * Keys the *server* emits for user-visible copy. The Web client renders them
 * through the same catalog, so a phrase lives in exactly one place.
 *
 * Flat dotted keys on purpose: the lookup is a plain record access, and the
 * key string itself is what travels inside a `TextRef`.
 */
export const zh = {
  "server.fork.branchName": "分支",
  "server.fork.branchSuffix": "（分支）",
  "server.routingTier.advanced.label": "高级",
  "server.routingTier.advanced.description": "最强能力，复杂任务与深度推理",
  "server.routingTier.fast.label": "快速",
  "server.routingTier.fast.description": "低延迟，简单问答与快速检索",
  "server.routingTier.economy.label": "经济",
  "server.routingTier.economy.description": "省成本，批量与低风险子任务",
  "server.commands.review.description": "按严重程度审查代码改动",
  "server.commands.explain.description": "解释指定目标的实现",
  "server.picker.chooseDirectory": "选择项目目录",
  "server.error.exportFailed": "导出会话失败",
} as const;
