import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type APIRequestContext, type Route } from '@playwright/test';

// 场次切换缺陷回归：
// 浏览器先加载场次 A，再不经过空值直接切到 B。看板必须整体替换为 B 的完整快照，
// 旧场次 A 的行不得并入 B 的看板，也不能在 B 的标题下继续被行内修订；
// 同时同一场次内“修订号只升不降”的迟到响应保护仍然有效。

async function seedScene(
  request: APIRequestContext,
  scene: string,
  notesList: string[],
): Promise<void> {
  for (const notes of notesList) {
    const resp = await request.post('/api/shot-numbers', {
      data: { scene_id: scene, client_op_id: randomUUID(), notes },
    });
    expect(resp.ok()).toBeTruthy();
  }
}

async function openSceneAndWait(page: Page, scene: string, count: number) {
  await page.goto('/');
  await page.getByTestId('scene-input').fill(scene);
  const board = page.getByTestId('scene-board');
  await expect(board).toContainText(`场次看板：${scene}（已发放 ${count} 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(count);
  return board;
}

test('直接从场次 A 切到 B：看板只显示 B 的完整快照，A 的行不能在 B 标题下编辑', async ({
  page,
  request,
}) => {
  const sceneA = 'E2E-SWITCH-A';
  const sceneB = 'E2E-SWITCH-B';
  const noteA1 = 'A 场次第一条记录';
  const noteA2 = 'A 场次第二条记录';
  const noteB1 = 'B 场次第一条记录';
  await seedScene(request, sceneA, [noteA1, noteA2]);
  await seedScene(request, sceneB, [noteB1]);

  // 1) 打开场次 A，等待看板加载出 A 的两条记录
  const board = await openSceneAndWait(page, sceneA, 2);
  await expect(board).toContainText(noteA1);
  await expect(board).toContainText(noteA2);

  // 2) 不经过空值，直接把场次输入改为 B，等待 B 的轮询响应
  await page.getByTestId('scene-input').fill(sceneB);

  // 3) 标题为场次 B 的看板行只能是 B 的完整快照（1 条），A 的行不得残留
  await expect(board).toContainText(`场次看板：${sceneB}（已发放 1 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).toContainText(noteB1);
  await expect(board).not.toContainText(noteA1);
  await expect(board).not.toContainText(noteA2);
  // A 的行没有挂载任何编辑器：无法从错误看板修订 A
  await expect(board.getByTestId('edit-notes-button')).toHaveCount(1);

  // 4) 后续轮询（3s）后 A 仍不会回流
  await page.waitForTimeout(3500);
  await expect(board).toContainText(`场次看板：${sceneB}（已发放 1 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).not.toContainText(noteA1);

  // 5) 在 B 看板行内修订：只能改到 B；A 的记录服务端保持原样（r0）
  await board.getByTestId('edit-notes-button').click();
  await board.getByTestId('notes-draft-input').fill('B 场次记录被本终端修订');
  await board.getByTestId('save-notes-button').click();
  await expect(board.getByTestId('notes-revision').first()).toHaveText('r1');

  const aOps = await (await request.get(`/api/scenes/${sceneA}/operations`)).json();
  expect(aOps).toHaveLength(2);
  for (const op of aOps as Array<{ notes: string; notes_revision: number }>) {
    expect(op.notes_revision).toBe(0);
    expect([noteA1, noteA2]).toContain(op.notes);
  }
  const bOps = await (await request.get(`/api/scenes/${sceneB}/operations`)).json();
  expect(bOps).toHaveLength(1);
  expect((bOps as Array<{ notes: string; notes_revision: number }>)[0]).toMatchObject({
    notes: 'B 场次记录被本终端修订',
    notes_revision: 1,
  });

  // 6) 切回 A：A 的完整快照仍在，看板是按场次隔离而非丢失数据
  await page.getByTestId('scene-input').fill(sceneA);
  await expect(board).toContainText(`场次看板：${sceneA}（已发放 2 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(2);
  await expect(board).toContainText(noteA1);
  await expect(board).toContainText(noteA2);
});

test('场次切换后晚到的行内保存响应不会把旧场次行写回新看板', async ({ page, request }) => {
  const sceneA = 'E2E-SWITCH-PATCH-A';
  const sceneB = 'E2E-SWITCH-PATCH-B';
  const noteA = 'A 场次保存前的备注';
  const noteB = 'B 场次自己的备注';
  await seedScene(request, sceneA, [noteA]);
  await seedScene(request, sceneB, [noteB]);

  const aOps = (await (
    await request.get(`/api/scenes/${sceneA}/operations`)
  ).json()) as Array<{ client_op_id: string }>;
  expect(aOps).toHaveLength(1);

  const board = await openSceneAndWait(page, sceneA, 1);

  // 挂起 PATCH：点保存后请求一直不返回，期间把场次切到 B
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/operations/*/notes', async (route: Route) => {
    await gate;
    await route.continue();
  });

  await board.getByTestId('edit-notes-button').click();
  await board.getByTestId('notes-draft-input').fill('A 场次保存响应晚到的修订');
  await board.getByTestId('save-notes-button').click();
  await expect(board.getByTestId('save-notes-button')).toHaveText('保存中…');

  // 保存请求在途时直接切到 B：看板立刻只显示 B
  await page.getByTestId('scene-input').fill(sceneB);
  await expect(board).toContainText(`场次看板：${sceneB}（已发放 1 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).toContainText(noteB);
  await expect(board).not.toContainText(noteA);

  // 放行被挂起的 PATCH（A 行的保存响应此刻才回来）：不得把 A 行写回 B 看板
  release();
  await page.waitForTimeout(500);
  await expect(board).toContainText(`场次看板：${sceneB}（已发放 1 条）`);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).not.toContainText('A 场次保存响应晚到的修订');

  // 修订本身已在服务端生效；切回 A 时通过正常轮询看到它
  await page.getByTestId('scene-input').fill(sceneA);
  await expect(board.getByTestId('scene-op-row')).toHaveCount(1);
  await expect(board).toContainText('A 场次保存响应晚到的修订');
  await expect(board.getByTestId('notes-revision')).toHaveText('r1');
});
