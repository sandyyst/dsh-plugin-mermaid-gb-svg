/**
 * 插件层自测：用假的 Cordis 上下文加载插件，检查工具注册与真实落盘结果。
 * 不需要 DSH 运行时，但需要 @deepseek-ai/dsh-tools 等 peer 依赖可解析
 * （本地开发用 node_modules/@deepseek-ai 联接指向 dsh 安装目录）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** 最小可用的 ctx.fs / ctx.tools 替身，语义对齐 dsh-fs 的 seam。 */
function makeCtx(root) {
  const registered = [];
  const observed = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    fs: {
      sandboxMode: undefined,
      async resolve(p) { return { displayPath: p, absPath: path.resolve(root, p) }; },
      async stat(target) {
        try { const s = await fs.stat(target.absPath); return { kind: 'file', size: s.size }; } catch { return undefined; }
      },
      async readText(target) { return fs.readFile(target.absPath, 'utf8'); },
      async writeText(target, content) {
        await fs.mkdir(path.dirname(target.absPath), { recursive: true });
        await fs.writeFile(target.absPath, content, 'utf8');
        return { operation: 'create', version: 1, before: null, after: content };
      },
    },
    waterfall: (_name, _target, _exec, next) => next(),
    emit: (ev, target) => observed.push([ev, target.displayPath]),
    get: () => undefined,
  };
  return { ctx, registered, observed };
}

const exec = (root) => ({ agent: { session: { header: { cwd: root } } }, callId: 'test-call', signal: undefined });

async function loadPlugin(root) {
  const { ctx, registered, observed } = makeCtx(root);
  const mod = await import('../lib/index.js');
  mod.apply(ctx, undefined);
  assert.equal(registered.length, 1, '应注册一个工具');
  return { mod, tool: registered[0], observed };
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gb-svg-plugin-'));
}

test('插件导出形状符合 Cordis 约定', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'mermaid-gb-svg');
  assert.deepEqual(mod.inject, ['tools', 'fs']);
  assert.equal(typeof mod.apply, 'function');
  assert.ok(mod.Config, '应导出 Config（schemastery）');
});

test('注册的工具声明完整', async () => {
  const root = await tmpdir();
  const { tool } = await loadPlugin(root);
  assert.equal(tool.name, 'mermaid_to_gb_svg');
  assert.ok(tool.description.includes('GB/T 1526-1989'));
  // defineTool 会把参数 DSL 编译成 JSON Schema
  const p = tool.parameters;
  assert.equal(p.type, 'object');
  assert.deepEqual(p.required, ['out']);
  assert.ok(p.properties.source && p.properties.path);
  assert.deepEqual(p.properties.paper.enum, ['none', 'auto', 'a4', 'a4l', 'a3', 'a3l']);
  assert.deepEqual(p.properties.dir.enum, ['td', 'lr', 'bt', 'rl']);
  assert.equal(tool.output.schema.properties.files.type, 'array');
  assert.equal(typeof tool.output.render, 'function');
  assert.match(tool.output.render({}, {
    files: ['a.svg'], diagrams: 1, pages: 0, summary: 'ok', warnings: ['w'],
  })[0].text, /ok[\s\S]*a\.svg[\s\S]*⚠ w/);
  assert.equal(typeof tool.execute, 'function');
  // presentCall 只在参数通过校验时给视图（defineTool 的约定）
  assert.equal(tool.presentCall({ out: 'a.svg' }).title, 'Mermaid → GB/T 1526 SVG');
  assert.equal(tool.presentCall({}), undefined);
});

test('内联源码 → 写出符合国标的 SVG', async () => {
  const root = await tmpdir();
  const { tool, observed } = await loadPlugin(root);
  const value = await tool.execute({
    source: 'graph TD\n A((开始)) --> B[创建Properties对象]\n B --> C{遍历列表模型}\n C -- 是 --> D[添加目录路径到属性]\n D --> C\n C -- 否 --> E((结束))',
    out: 'flow.svg',
    title: '图 1  属性配置文件创建流程',
  }, exec(root));

  assert.equal(value.diagrams, 1);
  assert.equal(value.pages, 0);
  assert.deepEqual(value.files, ['flow.svg']);
  assert.deepEqual(value.warnings, []);
  assert.ok(observed.length >= 1, '应发出 fs/observed 事件');

  const svg = await fs.readFile(path.join(root, 'flow.svg'), 'utf8');
  assert.match(svg, /<svg[^>]+width="\d+"/);
  assert.match(svg, /图 1  属性配置文件创建流程/);
  assert.match(svg, /<polygon points=/, '判断/菱形应为多边形');
  assert.match(svg, /rx="21"/, '起止应为圆角矩形');
});

test('文件输入（.md 多图）+ 幅面分页', async () => {
  const root = await tmpdir();
  const { tool } = await loadPlugin(root);
  const long = ['# 5 长流程', '', '```mermaid', 'graph TD', 'A([开始]) --> N1[步骤一]'];
  for (let i = 1; i <= 26; i++) long.push(`N${i} --> N${i + 1}[步骤${i + 1}]`);
  long.push('N27 --> Z([结束])', '```', '');
  await fs.writeFile(path.join(root, 'doc.md'), long.join('\n'), 'utf8');

  const value = await tool.execute({ path: 'doc.md', out: 'out', title: '图 5  长流程', paper: 'a4' }, exec(root));
  assert.equal(value.diagrams, 1);
  assert.ok(value.pages >= 2, '长图应分页');
  assert.ok(value.files.length >= 2);
  assert.ok(value.files.some((f) => /-p1\.svg$/.test(f)), '应有分页文件');
  const page = await fs.readFile(path.join(root, value.files.find((f) => /-p1\.svg$/.test(f))), 'utf8');
  assert.match(page, /width="210mm" height="297mm"/);
  assert.match(page, /class="gb-offpage"/, '分页应使用异地连接符（五边形）');
  assert.match(page, /第 1\/\d+ 页/);
});

test('输入校验与错误信息', async () => {
  const root = await tmpdir();
  const { tool } = await loadPlugin(root);
  await assert.rejects(() => tool.execute({ out: 'a.svg' }, exec(root)), /必须给 `source`/);
  await assert.rejects(() => tool.execute({ source: 'graph TD\nA-->B', path: 'x.mmd', out: 'a.svg' }, exec(root)), /只能给/);
  // out 是必填参数，由 defineTool 的参数校验先挡下
  await assert.rejects(() => tool.execute({ source: 'graph TD\nA-->B' }, exec(root)), /missing required property "out"/);
  // 只有注释 → 解析不出节点
  await assert.rejects(() => tool.execute({ source: '%% 只有注释，没有节点', out: 'a.svg' }, exec(root)), /没有可解析的流程图节点/);
  // .md 里没有 mermaid 代码块
  await fs.writeFile(path.join(root, 'empty.md'), '# 标题\n\n没有图。\n', 'utf8');
  await assert.rejects(() => tool.execute({ path: 'empty.md', out: 'a.svg' }, exec(root)), /没有可转换/);
  await assert.rejects(() => tool.execute({ path: '不存在.mmd', out: 'a.svg' }, exec(root)), /找不到输入文件/);
});

test('横向流程图使用 A4 横向并分栏', async () => {
  const root = await tmpdir();
  const { tool } = await loadPlugin(root);
  const chain = ['graph LR', 'S([开始]) --> A1[步骤一]'];
  for (let i = 1; i <= 18; i++) chain.push(`A${i} --> A${i + 1}[步骤${i + 1}]`);
  chain.push('A19 --> E([结束])');
  const value = await tool.execute({ source: chain.join('\n'), out: 'wide.svg', paper: 'auto' }, exec(root));
  assert.ok(value.pages >= 2, '超宽应分栏');
  const page = await fs.readFile(path.join(root, value.files.find((f) => /-p1\.svg$/.test(f))), 'utf8');
  assert.match(page, /width="297mm" height="210mm"/);
});
