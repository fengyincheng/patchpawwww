import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePRTask } from '../src/runner/command.ts';

test('slash command scope is deterministic; plain mentions and quoted commands are conversation', () => {
  for (const [body, task] of [
    ['@patchpawwww /conflict', 'conflict'], ['@patchpawwww[bot] /confict 请修复', 'conflict'],
    ['@patchpawwww\n/review', 'review'], ['@patchpawwww /CI', 'ci'], ['@patchpawwww /ci 请处理', 'ci'],
    ['@patchpawwww /stop', 'stop'], ['@patchpawwww[bot] /STOP 汇报', 'stop'],
    ['@patchpawwww 解释 /stop', 'conversation'], ['> @patchpawwww /stop', 'conversation'],
    ['@patchpawwww /stop /CI', 'conversation'], ['@patchpawwww /stopping', 'conversation'],
    ['@patchpawwww 你好', 'conversation'], ['@patchpawwww 帮我改代码', 'conversation'],
    ['@patchpawwww 解释 /CI 的作用', 'conversation'], ['@someoneelse /CI', 'conversation'],
    ['> @patchpawwww /CI', 'conversation'], ['```\n@patchpawwww /CI\n```\n@patchpawwww 这是什么意思？', 'conversation'],
    ['@patchpawwww /review /CI', 'conversation'], ['@patchpawwww /review\n@patchpawwww /CI', 'conversation'],
    ['@patchpawwww /close', 'close'], ['@patchpawwww[bot] /CLOSE 谢谢', 'close'],
    ['@patchpawwww\n/close', 'close'], ['@patchpawwww /close 本地会话结束', 'close'],
    ['@patchpawwww /close /stop', 'conversation'], ['@patchpawwww 解释 /close', 'conversation'],
    ['@patchpawwww /closing', 'conversation'], ['> @patchpawwww /close', 'conversation'],
    ['```\n@patchpawwww /close\n```\n@patchpawwww 这是什么意思？', 'conversation'],
  ]) assert.equal(parsePRTask(body, 'patchpawwww'), task, body);
});
