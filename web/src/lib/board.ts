import type { IssuedOperation } from './types';

/**
 * 合并一次看板轮询结果与本地已知行（仅限同一场次）。
 *
 * 两条不变式：
 * 1. 场次隔离——fetched 是某场次的完整快照，看板只能呈现该场次的行。切换场次后
 *    previous 中属于旧场次的行必须整体丢弃，绝不与新场次快照做并集；否则旧场次的
 *    行会挂在新场次标题下，且仍挂着行内编辑器，被从错误的看板修订。fetched 中若
 *    混入异场次行（调用方误用）同样不得进入看板。
 * 2. 修订号只升不降——同一场次内按操作标识归并，较旧的轮询响应（网络抖动下可能
 *    晚到）绝不允许用旧修订覆盖本地已有的新修订（可能来自更新的轮询，或本终端刚
 *    保存成功后由 PATCH 响应写入的行）。镜号、场次、操作标识本身恒定。
 */
export function mergeBoardSnapshot(
  previous: IssuedOperation[],
  fetched: IssuedOperation[],
  sceneId: string,
): IssuedOperation[] {
  const byId = new Map<string, IssuedOperation>();
  for (const op of previous) {
    if (op.scene_id === sceneId) byId.set(op.client_op_id, op);
  }
  for (const op of fetched) {
    if (op.scene_id !== sceneId) continue;
    const local = byId.get(op.client_op_id);
    if (!local || op.notes_revision >= local.notes_revision) {
      byId.set(op.client_op_id, op);
    }
  }
  return [...byId.values()].sort((a, b) => a.shot_number - b.shot_number);
}
