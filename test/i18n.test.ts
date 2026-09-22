import test from 'node:test';
import assert from 'node:assert/strict';
import { countLabel, message } from '../web/src/i18n.tsx';

test('provides Chinese as the first-run language and preserves English as an option', () => {
  assert.equal(message('zh-CN', 'loginTitle'), '配置随仓库交付的 Agent。');
  assert.equal(message('en', 'loginTitle'), 'Configure the agent that ships with your repository.');
  assert.equal(message('zh-CN', 'sessionActiveUntil', { time: '12:34' }), '会话有效至 12:34');
  assert.equal(message('zh-CN', 'setupGuideTitle'), '登录前检查公开来源地址');
  assert.equal(message('en', 'setupGuideTitle'), 'Check the public origin before signing in');
  assert.equal(message('zh-CN', 'readWriteApproval'), '读写（需审批）');
  assert.equal(message('en', 'readWriteApproval'), 'Read + write (approval required)');
  assert.equal(message('zh-CN', 'approvalPermissionHint'), '首次执行只读并发布计划；必须在 PR 中单独发送 /approval 才会进入写回阶段。');
  assert.equal(message('en', 'planModeBinding'), 'Plan Mode binding');
  assert.equal(countLabel('zh-CN', 2, 'repository', 'repositoriesPlural'), '2 个仓库');
  assert.equal(countLabel('en', 1, 'repository', 'repositoriesPlural'), '1 repository');
});
