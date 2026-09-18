import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// 场次切换回归验收：
// 前置：场次 A、B 各至少有一条记录；浏览器先加载 A 的看板，再不经过空值直接
// 把场次输入改成 B。
// 预期：B 的轮询响应不得与既有 A 行做并集——看板只显示 B 的完整快照；旧 A 行
// 不再挂载行内编辑器，无法从 B 的标题下修订 A 的记录。同场次内 B 行仍可正常
// 行内修订（“修订号只升不降”的迟到响应保护不受影响）。

async function issueViaApi(
  request: import('@playwright/test').APIRequestContext,
  scene: string,
  notes: string,
): Promise<string> {
  const clientOpId = randomUUID();
  const resp = await request.post('/api/shot-numbers', {
    data: { scene_id: scene, client_op_id: clientOpId, notes },
  });
  expect(resp.status()).toBe(201);
  return clientOpId;
}

test('场次直接 A→B 切换：旧场次行不并入新看板，且无法在 B 标题下修订 A', async ({
  page,
  request,
}) => {
  const sceneA = 'E2E-SCENE-SWITCH-A';
  const sceneB = 'E2E-SCENE-SWITCH-B';
  const notesA = '仅属于场次A的备注：切换后必须消失';
  const notesB = '仅属于场次B的备注：切换后唯一可见';

  const opA = await issueViaApi(request, sceneA, notesA);
  await issueViaApi(request, sceneB, notesB);

  await page.goto('/');

  // 1) 先打开场次 A，等待看板加载出 A 的行。
  await page.getByTestId('scene-input').fill(sceneA);
  const board = page.getByTestId('scene-board');
  await expect(board).toContainText(`场次看板：${sceneA}`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).toContainText(notesA);

  // 2) 不经过空值，直接把场次输入从 A 改成 B（fill 一次性替换为 B）。
  await page.getByTestId('scene-input').fill(sceneB);

  // 3) 标题切换为 B，且看板只剩 B 的完整快照：A 的行不能被并进来。
  await expect(board).toContainText(`场次看板：${sceneB}`);
  await expect(board).toContainText('已发放 1 条');
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).toContainText(notesB);
  await expect(board).not.toContainText(notesA);

  // 再多等一个轮询周期（3s）：迟到/后续轮询也不能把 A 行并回来。
  await page.waitForTimeout(3500);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).not.toContainText(notesA);

  // 4) 旧 A 行不再挂载 NotesCell：当前唯一一行是 B，对其行内修订应作用于 B。
  const row = board.getByTestId('scene-op-row').first();
  await expect(row).toContainText(notesB);
  await row.getByTestId('edit-notes-button').click();
  await row.getByTestId('notes-draft-input').fill('在 B 看板里修订后的备注');
  await row.getByTestId('save-notes-button').click();
  await expect(row.getByTestId('notes-revision')).toHaveText('r1');

  // A 的记录在服务端保持原样（仍为发放修订 r0、备注未改）：
  // 证明无法从错误的 B 看板修订 A 的记录。
  const aAfter = await request.get(`/api/operations/${opA}`);
  expect(aAfter.ok()).toBeTruthy();
  const aBody = (await aAfter.json()) as { notes: string; notes_revision: number };
  expect(aBody.notes_revision).toBe(0);
  expect(aBody.notes).toBe(notesA);
});
