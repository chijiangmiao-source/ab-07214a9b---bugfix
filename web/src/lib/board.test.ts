import { describe, expect, it } from 'vitest';
import { mergeBoardSnapshot } from './board';
import type { IssuedOperation } from './types';

function op(revision: number, overrides: Partial<IssuedOperation> = {}): IssuedOperation {
  return {
    scene_id: 'S1',
    client_op_id: 'op-1',
    notes: `备注 r${revision}`,
    shot_number: 1,
    created_at: '2026-09-15T00:00:00.000Z',
    notes_revision: revision,
    ...overrides,
  };
}

describe('mergeBoardSnapshot', () => {
  it('本地为空时采用新快照', () => {
    const fetched = [op(0)];
    expect(mergeBoardSnapshot([], fetched, 'S1')).toEqual(fetched);
  });

  it('相同修订号的轮询快照采用服务端行', () => {
    const result = mergeBoardSnapshot(
      [op(2, { notes: '本终端保存响应写入的 r2 文本' })],
      [op(2, { notes: '服务端轮询回来的 r2 文本' })],
      'S1',
    );
    expect(result[0].notes_revision).toBe(2);
    expect(result[0].notes).toBe('服务端轮询回来的 r2 文本');
  });

  it('较旧的轮询响应不能覆盖新修订（核心不变式）', () => {
    const result = mergeBoardSnapshot(
      [op(3, { notes: '最新 r3 文本（更新的轮询或本终端保存响应）' })],
      [op(1, { notes: '旧 r1 文本（迟到的响应）' })],
      'S1',
    );
    expect(result[0].notes_revision).toBe(3);
    expect(result[0].notes).toBe('最新 r3 文本（更新的轮询或本终端保存响应）');
  });

  it('较新的轮询响应正常推进修订', () => {
    const result = mergeBoardSnapshot(
      [op(1, { notes: 'r1 文本' })],
      [op(2, { notes: 'r2 文本' })],
      'S1',
    );
    expect(result[0].notes_revision).toBe(2);
    expect(result[0].notes).toBe('r2 文本');
  });

  it('不同行按操作标识独立归并，并按镜号排序', () => {
    const previous = [
      op(0, { client_op_id: 'a', shot_number: 1 }),
      op(0, { client_op_id: 'b', shot_number: 2 }),
    ];
    const fetched = [
      op(2, { client_op_id: 'b', shot_number: 2, notes: 'b 的 r2' }),
      op(1, { client_op_id: 'c', shot_number: 3 }),
    ];
    const result = mergeBoardSnapshot(previous, fetched, 'S1');
    expect(result.map((row) => row.client_op_id)).toEqual(['a', 'b', 'c']);
    expect(result[1].notes_revision).toBe(2);
  });

  it('场次直接 A→B 切换：旧场次行不与新快照做并集，看板只保留 B 的完整快照', () => {
    const sceneA = [
      op(0, { scene_id: 'A', client_op_id: 'a1', shot_number: 1, notes: 'A 的第一条' }),
      op(0, { scene_id: 'A', client_op_id: 'a2', shot_number: 2, notes: 'A 的第二条' }),
    ];
    const sceneB = [
      op(0, { scene_id: 'B', client_op_id: 'b1', shot_number: 1, notes: 'B 的第一条' }),
    ];
    const result = mergeBoardSnapshot(sceneA, sceneB, 'B');
    expect(result.map((row) => row.client_op_id)).toEqual(['b1']);
    expect(result.every((row) => row.scene_id === 'B')).toBe(true);
  });

  it('即使新场次快照为空，旧场次行也必须全部移除', () => {
    const sceneA = [
      op(1, { scene_id: 'A', client_op_id: 'a1', shot_number: 1 }),
    ];
    expect(mergeBoardSnapshot(sceneA, [], 'B')).toEqual([]);
  });

  it('场次参数带空白时按 trim 后的场次判定边界', () => {
    const sceneA = [op(0, { scene_id: 'A', client_op_id: 'a1', shot_number: 1 })];
    const sceneB = [op(0, { scene_id: 'B', client_op_id: 'b1', shot_number: 1 })];
    const result = mergeBoardSnapshot(sceneA, sceneB, '  B ');
    expect(result.map((row) => row.client_op_id)).toEqual(['b1']);
  });

  it('快照中混入的异场次行不并入当前看板（防御接口异常）', () => {
    const result = mergeBoardSnapshot(
      [op(0, { scene_id: 'B', client_op_id: 'b1', shot_number: 1 })],
      [
        op(0, { scene_id: 'B', client_op_id: 'b1', shot_number: 1 }),
        op(0, { scene_id: 'A', client_op_id: 'a9', shot_number: 9 }),
      ],
      'B',
    );
    expect(result.map((row) => row.client_op_id)).toEqual(['b1']);
  });

  it('切换到新场次后，同场次迟到响应的修订号只升不降保护仍然生效', () => {
    // 先完成 A→B 切换（A 行被丢弃），随后 B 的两个响应乱序到达：
    // 较新的 r2 先到、迟到的 r1 后到，r1 不能覆盖 r2。
    const afterSwitch = mergeBoardSnapshot(
      [op(0, { scene_id: 'A', client_op_id: 'a1', shot_number: 1 })],
      [op(2, { scene_id: 'B', client_op_id: 'b1', shot_number: 1, notes: 'B r2' })],
      'B',
    );
    const staleLate = mergeBoardSnapshot(
      afterSwitch,
      [op(1, { scene_id: 'B', client_op_id: 'b1', shot_number: 1, notes: 'B r1 迟到' })],
      'B',
    );
    expect(staleLate.map((row) => row.client_op_id)).toEqual(['b1']);
    expect(staleLate[0].notes_revision).toBe(2);
    expect(staleLate[0].notes).toBe('B r2');
  });
});
