/**
 * 引擎层自测：解析 → 布局 → SVG → 分页。
 * 只依赖 node 内置模块，可直接 `node --test test/` 运行。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_OPTIONS, PAPERS, buildPageSVG, describeGraph,
  extractDiagrams, planPages, renderDiagram,
} from '../lib/engine.js';

const opts = (extra = {}) => ({ ...DEFAULT_OPTIONS, ...extra });
const meta = (title = '测试', caption = null) => ({ title, caption, docTitle: title });

test('解析并渲染一张基本流程图', () => {
  const r = renderDiagram('graph TD\n A([开始]) --> B[处理]\n B --> C([结束])', opts(), meta());
  assert.equal(r.g.nodes.size, 3);
  assert.equal(r.g.edges.length, 2);
  assert.match(r.res.svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(r.res.svg, /<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.deepEqual(r.warns, []);
});

test('GB/T 1526 符号集全部可用（含 Mermaid v11 属性写法与中文名）', () => {
  const code = [
    'graph TD',
    'S0([起止]) --> P1[处理]',
    'P1 --> D1{判断}',
    'D1 -- 是 --> I1[/数据/]',
    'D1 -- 否 --> M1@{ shape: manual-input, label: "人工输入" }',
    'M1 --> M2@{ shape: 人工操作, label: "人工操作" }',
    'M2 --> H1{{准备}}',
    'H1 --> R1[[预定义处理]]',
    'R1 --> C1[(直接存取存储)]',
    'C1 --> N1@{ shape: internal-storage, label: "内部存储" }',
    'N1 --> DO1@{ shape: doc, label: "文档" }',
    'DO1 --> DO2@{ shape: docs, label: "多文档" }',
    'DO2 --> DI1@{ shape: display, label: "显示" }',
    'DI1 --> DE1@{ shape: delay, label: "延迟" }',
    'DE1 --> CO1@{ shape: comment, label: "注释" }',
    'CO1 --> CN1@{ shape: connector, label: "A" }',
    'CN1 --> OP1@{ shape: off-page, label: "B" }',
    'OP1 --> E0([结束])',
  ].join('\n');
  const r = renderDiagram(code, opts(), meta());
  const shapes = new Set([...r.g.nodes.values()].map((n) => n.shape));
  for (const s of ['terminal', 'process', 'decision', 'io', 'manual_input', 'manual_op',
    'preparation', 'subroutine', 'storage', 'internal_storage', 'document', 'multi_document',
    'display', 'delay', 'comment', 'connector', 'off_page']) {
    assert.ok(shapes.has(s), `缺少符号 ${s}`);
  }
  assert.deepEqual(r.warns, []);
  assert.ok(!r.res.svg.includes('NaN') && !r.res.svg.includes('undefined'));
});

test('判断框：是走底顶点向下、否走右顶点先向右', () => {
  const r = renderDiagram([
    'graph TD', 'A([开始]) --> D{判断}',
    'D -- 是 --> Y[是分支]', 'D -- 否 --> N[否分支]',
    'Y --> E([结束])', 'N --> E',
  ].join('\n'), opts(), meta());
  const node = (id) => r.layout.nodes.get(id);
  const routed = (to) => r.layout.routed.find((x) => x.edge.to === to);
  const d = node('D');
  const yes = routed('Y');
  const no = routed('N');
  assert.ok(Math.abs(yes.pts[0].a - (d.alongCenter + d.along / 2)) < 0.6, '是应从底顶点出发');
  assert.ok(Math.abs(no.pts[0].c - d.crossMax) < 0.6, '否应从右顶点出发');
});

test('每根流程线最多 3 个转折', () => {
  const lines = ['graph TD', 'N0([开始]) --> N1[步骤一]'];
  for (let i = 1; i <= 12; i++) lines.push(`N${i} --> N${i + 1}[步骤${i + 1}]`);
  lines.push('N13 --> N14([结束])');
  const r = renderDiagram(lines.join('\n'), opts(), meta());
  for (const ro of r.layout.routed) {
    const p = ro.pts;
    let turns = 0, prev = null;
    for (let i = 1; i < p.length; i++) {
      const dir = Math.abs(p[i].c - p[i - 1].c) < 0.01 ? 'v' : 'h';
      if (prev && dir !== prev) turns++;
      prev = dir;
    }
    assert.ok(turns <= 3, `${ro.edge.from}->${ro.edge.to} 有 ${turns} 个转折`);
  }
});

test('入线一律落在图形上中部', () => {
  const r = renderDiagram([
    'graph TD', 'A([开始]) --> B[处理]', 'B --> C{判断}',
    'C -- 是 --> D[甲]', 'C -- 否 --> E[乙]', 'D --> F([结束])', 'E --> F',
  ].join('\n'), opts(), meta());
  const horizontal = r.res.dir === 'lr' || r.res.dir === 'rl';
  for (const e of r.res.edgeGeo) {
    const hit = [...r.res.nodeGeo.values()].some((n) => (horizontal
      ? Math.abs(e.tip[0] - n.rect.x0) < 0.6 && Math.abs(e.tip[1] - n.cy) < 0.6
      : Math.abs(e.tip[0] - n.cx) < 0.6 && Math.abs(e.tip[1] - n.rect.y0) < 0.6));
    assert.ok(hit, `箭头落点不在上中部：${e.tip}`);
  }
});

test('.md 抽取多个 mermaid 代码块并取标题', () => {
  const md = [
    '# 3 设计', '', '## 3.1 主流程', '', '```mermaid', 'graph TD', 'A([开始]) --> B[处理]', '```',
    '', '## 3.2 异常', '', '```mermaid', 'graph LR', 'X([故障]) --> Y[记录]', '```', '',
  ].join('\n');
  const ds = extractDiagrams(md, 'doc.md');
  assert.equal(ds.length, 2);
  assert.equal(ds[0].caption, '3.1 主流程');
  assert.equal(ds[1].caption, '3.2 异常');
});

test('超幅面自动分页：每张 A4，异地连接符两页对应', () => {
  const lines = ['graph TD', 'Z0([开始]) --> N1[步骤一]'];
  for (let i = 1; i <= 26; i++) lines.push(`N${i} --> N${i + 1}[步骤${i + 1}]`);
  lines.push('N27 --> Z2([结束])');
  const o = opts({ paper: 'auto' });
  const m = meta('长流程', '图 1  长流程');
  const r = renderDiagram(lines.join('\n'), o, m);
  const plan = planPages(r.res, o);
  assert.ok(plan && !plan.fits, '长图应判定超出 A4');
  assert.equal(plan.unsafe, 0);
  assert.ok(plan.pages.length >= 2);
  const pages = plan.pages.map((pg, i) =>
    buildPageSVG(r.res, o, m, plan, pg, i + 1, plan.pages.length));
  pages.forEach((svg) => assert.match(svg, /width="210mm" height="297mm"/));

  const marks = pages.map((svg) => [...svg.matchAll(/<polygon class="gb-offpage" points="([^"]+)"/g)]
    .map((mm) => {
      const pts = mm[1].trim().split(/\s+/).map((s) => s.split(',').map(Number));
      return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }));
  const H = 1122.52;
  for (let i = 0; i + 1 < pages.length; i++) {
    const bottom = marks[i].filter((c) => c[1] > H * 0.75).map((c) => Math.round(c[0]));
    const top = marks[i + 1].filter((c) => c[1] < H * 0.25).map((c) => Math.round(c[0]));
    assert.deepEqual(bottom.sort(), top.sort(), `第 ${i + 1}/${i + 2} 张连接符不匹配`);
  }
});

test('幅面表与描述函数', () => {
  assert.equal(PAPERS.a4.w, 210);
  assert.equal(PAPERS.a4l.h, 210);
  const r = renderDiagram('graph TD\nA([开始]) --> B[处理]', opts(), meta());
  assert.match(describeGraph(r.g), /节点 2 个/);
});
