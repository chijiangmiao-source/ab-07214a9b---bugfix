import type { IssuedOperation } from './types';

/**
 * 合并一次看板轮询结果与本地已知行。
 *
 * 看板永远只归属唯一一个场次：fetched 是某场次的完整快照，因此 previous 中
 * 属于其它场次的行必须整体丢弃（场次直接 A→B 切换、不经过空值时，旧场次 A 的
 * 行不能与 B 的快照做并集，否则 A 的行会挂在 B 的标题下、仍可被行内修订）。
 *
 * 同一场次内维持不变式：任何行的备注修订号只升不降——较旧的轮询响应（网络
 * 抖动下可能晚到）绝不允许用旧修订覆盖本地已有的新修订（可能来自更新的轮询，
 * 或本终端刚保存成功后由 PATCH 响应写入的行）。镜号、场次、操作标识本身恒定，
 * 按标识归并。
 */
export function mergeBoardSnapshot(
  previous: IssuedOperation[],
  fetched: IssuedOperation[],
  sceneId: string,
): IssuedOperation[] {
  const scene = sceneId.trim();
  const byId = new Map(
    previous
      // 场次边界：只保留当前场次的行，切换前的旧场次行一律移除。
      .filter((op) => op.scene_id === scene)
      .map((op) => [op.client_op_id, op]),
  );
  for (const op of fetched) {
    // 防御：接口只应返回该场次的行；混入的异场次行绝不并入当前看板。
    if (op.scene_id !== scene) continue;
    const local = byId.get(op.client_op_id);
    if (!local || op.notes_revision >= local.notes_revision) {
      byId.set(op.client_op_id, op);
    }
  }
  return [...byId.values()].sort((a, b) => a.shot_number - b.shot_number);
}
