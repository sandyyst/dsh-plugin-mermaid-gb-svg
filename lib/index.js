/**
 * dsh-plugin-mermaid-gb-svg —— DeepSeek Harness 插件
 *
 * 注册一个面向模型的工具 `mermaid_to_gb_svg`：把 Mermaid 流程图（内联源码或
 * .mmd/.md 文件）转换成符合 GB/T 1526-1989 的 SVG，可选按 A4/A3 幅面分页。
 *
 * 图形符号依据 GB/T 1526-1989（等同采用 ISO 5807:1985）：
 * 起止=圆角矩形、处理=矩形、判断=菱形、数据=平行四边形、准备=六边形、
 * 预定义处理=双边矩形、直接存取存储=圆柱、人工输入/人工操作、文档/多文档、
 * 显示、延迟、内部存储、注释、连接符（圆）、换页连接符（五边形）。
 *
 * @module dsh-plugin-mermaid-gb-svg
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  ESCALATION_TARGETS, approveEscalation, validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox';
import {
  DEFAULT_OPTIONS, PAPERS, buildPageSVG, describeGraph,
  extractDiagrams, planPages, renderDiagram,
} from './engine.js';

/** Cordis 插件名（loader 诊断用）。 */
const name = 'mermaid-gb-svg';

/** 依赖的服务：工具注册表与文件系统 seam。 */
const inject = ['tools', 'fs'];

/** 部署级默认值，可在 profile 补丁行的 config 里覆盖。 */
const Config = z.object({
  font: z.string().default(DEFAULT_OPTIONS.font),
  fontSize: z.number().default(DEFAULT_OPTIONS.fontSize),
  stroke: z.number().default(DEFAULT_OPTIONS.stroke),
  paper: z.string().default(DEFAULT_OPTIONS.paper),
});

const OUT_EXT_RE = /\.svg$/i;
const INPUT_EXT_RE = /\.(mmd|mermaid|md|markdown|txt)$/i;

/** 把不合法输入挡在模型边界上。 */
function assertInput(input) {
  const hasSource = typeof input.source === 'string' && input.source.trim() !== '';
  const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
  if (hasSource && hasPath) throw new Error('mermaid_to_gb_svg: 只能给 `source` 或 `path` 其中之一');
  if (!hasSource && !hasPath) throw new Error('mermaid_to_gb_svg: 必须给 `source`（Mermaid 源码）或 `path`（输入文件）');
  if (typeof input.out !== 'string' || input.out.trim() === '') {
    throw new Error('mermaid_to_gb_svg: `out` 必填（输出 SVG 路径或目录）');
  }
}

/**
 * 文件系统写入的沙箱策略控制器（与 dsh-tool-fs 的 write 工具同一套语义）：
 * 有沙箱后端时把会话策略盖到写入上，并支持一次性升权重试。
 */
class FsSandbox {
  constructor(ctx) {
    this.ctx = ctx;
    const mode = ctx.fs.sandboxMode;
    this.escalationModes = mode === undefined ? [] : ESCALATION_TARGETS;
    this.policy = mode === undefined ? undefined : ctx.get('sandboxPolicy');
    if (mode !== undefined && this.policy === undefined) {
      throw new Error('mermaid-gb-svg: 挂载的文件系统带沙箱，但缺少 ctx.sandboxPolicy');
    }
  }

  /** 升权参数（仅在带沙箱的组合里暴露给模型）。 */
  schemaFields() {
    if (this.escalationModes.length === 0) return {};
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: '本次写入需要的更宽沙箱模式。只在刚刚被沙箱拒绝后一次性重试时使用，需用户批准。',
      },
      justification: {
        type: 'string',
        description: '与 sandbox_permissions 搭配：一句话向用户说明为什么这次写入需要更宽权限。',
      },
    };
  }

  /** 本次调用的落盘策略：已批准的升权 grant，否则会话既定模式。 */
  async resolvePolicy(toolName, args, exec) {
    validateEscalationArgs(args.sandbox_permissions, args.justification);
    const standing = this.policy?.resolve({ ...(exec.agent ? { session: exec.agent.session } : {}) });
    if (args.sandbox_permissions === undefined || args.justification === undefined) return standing;
    if (this.escalationModes.length === 0) {
      throw new Error('sandbox_permissions 在当前组合里不可用（没有带沙箱的文件系统可升权）');
    }
    const approvedMode = await approveEscalation({
      requestedMode: args.sandbox_permissions,
      justification: args.justification,
      effectiveMode: standing.mode,
      subject: 'operation',
    }, {
      approver: this.ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal,
    });
    return { ...standing, mode: approvedMode };
  }
}

/** 组装一次渲染的选项：插件默认值 ← 插件配置 ← 本次调用参数。 */
function renderOptions(cfg, args) {
  const o = {
    ...DEFAULT_OPTIONS,
    ...(cfg.font !== undefined ? { font: cfg.font } : {}),
    ...(cfg.fontSize !== undefined ? { fontSize: cfg.fontSize } : {}),
    ...(cfg.paper !== undefined ? { paper: cfg.paper } : {}),
    ...(cfg.stroke !== undefined ? { stroke: cfg.stroke } : {}),
  };
  if (typeof args.font_size === 'number' && args.font_size > 0) o.fontSize = args.font_size;
  if (typeof args.dir === 'string') o.dir = args.dir;
  if (typeof args.paper === 'string') o.paper = args.paper;
  if (args.font_tu === true) {
    o.font = "FangSong, '仿宋', '仿宋_GB2312', STFangsong, SimSun, serif";
    o.captionFont = o.font;
  }
  if (args.caption === false) o.caption = false;
  return o;
}

/** 输出文件名规则：单图 out.svg；多图/多页在 out 前缀后接 -N / -pN。 */
function outputPlan(out, diagramCount) {
  const isFile = OUT_EXT_RE.test(out);
  const base = isFile ? out.replace(OUT_EXT_RE, '') : out;
  return { isFile, base };
}

function fileFor(plan, index, diagramCount, pageNo) {
  const suffix = pageNo !== undefined ? `-p${pageNo}`
    : (diagramCount > 1 ? `-${index + 1}` : '');
  return plan.isFile && diagramCount === 1 && pageNo === undefined
    ? `${plan.base}.svg`
    : `${plan.base}${suffix}.svg`;
}

/**
 * 注册 `mermaid_to_gb_svg` 工具。
 * @param ctx - 携带 tools 与 fs 的插件上下文。
 * @param config - 部署可覆盖的默认值（字体、字号、幅面、线宽）。
 */
function apply(ctx, config) {
  const cfg = config ?? {};
  const sandbox = new FsSandbox(ctx);

  /** 解析一个模型给的路径（沿用会话 cwd / 沙箱工作区根）。 */
  const resolve = (p, exec, policyRoot) => {
    const cwd = policyRoot ?? exec.agent?.session.header.cwd;
    return ctx.fs.resolve(p, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
  };

  const write = async (p, content, exec, policy) => {
    const target = await resolve(p, exec, policy?.workspaceRoot);
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined);
    const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, policy);
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
    return target.displayPath ?? p;
  };

  ctx.tools.register(defineTool({
    name: 'mermaid_to_gb_svg',
    description: [
      '把 Mermaid 流程图转换成符合 GB/T 1526-1989（等同采用 ISO 5807:1985）图形符号的 SVG。',
      '符号映射：起止=圆角矩形、处理=矩形、判断=菱形、数据=平行四边形、准备=六边形、',
      '预定义处理=双边矩形、直接存取存储=圆柱、人工输入/人工操作、文档/多文档、显示、延迟、',
      '内部存储、注释、连接符（页内圆）、换页连接符（异地五边形）；',
      'Mermaid v11 属性写法 A@{ shape: doc, label: "报表" } 也可用，shape 接受英文名或中文名。',
      '约定：流向自左而右/自上而下；判断框"是"从底顶点向下、"否"从右顶点先向右再转向；',
      '所有入线从图形上中部垂直进入；每根流程线最多 3 个转折。',
      '给 paper=a4/a4l/a3/a3l 时按幅面分页（图框+页码+异地连接符），默认不分页。',
      '输入用 source（Mermaid 源码）或 path（.mmd/.md 文件，md 会抽取全部 mermaid 代码块）。',
    ].join(' '),
    parameters: {
      out: {
        type: 'string',
        required: true,
        description: '输出路径：以 .svg 结尾时是文件名（多图会自动加 -1/-2），否则作为输出目录/前缀。',
      },
      source: {
        type: 'string',
        description: 'Mermaid 流程图源码（与 path 二选一）。',
      },
      path: {
        type: 'string',
        description: '输入文件路径（.mmd/.mermaid 或含 ```mermaid 代码块的 .md，与 source 二选一）。',
      },
      title: {
        type: 'string',
        description: '图题（写在图下方；.md 输入未给时取代码块上方最近的标题）。',
      },
      dir: {
        type: 'string',
        enum: ['td', 'lr', 'bt', 'rl'],
        description: '强制流向：td 自上而下（默认）/ lr 自左而右 / bt / rl。',
      },
      paper: {
        type: 'string',
        enum: ['none', 'auto', 'a4', 'a4l', 'a3', 'a3l'],
        description: '输出幅面：none 只出一张大图（默认）；auto 纵向流程用 A4 纵向、横向流程用 A4 横向；'
          + 'a4/a4l/a3/a3l 指定幅面；超出幅面时自动拆页。',
      },
      font_size: {
        type: 'integer',
        description: '正文字号（px，14≈五号，默认 14）。',
      },
      font_tu: {
        type: 'boolean',
        description: '改用技术制图字体（GB/T 14691 长仿宋/仿宋）。',
      },
      caption: {
        type: 'boolean',
        description: '是否绘制图题，默认 true。',
      },
      ...sandbox.schemaFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: { type: 'array', required: true, items: { type: 'string' }, description: '写出的 SVG 文件（相对路径）。' },
          diagrams: { type: 'integer', required: true, description: '转换的流程图数量。' },
          pages: { type: 'integer', required: true, description: '因超幅面额外拆出的分页文件数量。' },
          summary: { type: 'string', required: true, description: '一行结果摘要。' },
          warnings: { type: 'array', required: true, items: { type: 'string' }, description: '几何自检告警（重叠/穿越/切点落在图形上）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.summary + (value.files.length ? '\n' + value.files.map((f) => '  ' + f).join('\n') : '')
          + (value.warnings.length ? '\n告警：\n' + value.warnings.map((w) => '  ⚠ ' + w).join('\n') : ''),
      }],
    },
    async execute(args, exec) {
      const input = args ?? {};
      assertInput(input);
      const policy = await sandbox.resolvePolicy('mermaid_to_gb_svg', input, exec);

      // 读取输入
      let text = input.source;
      let sourceName = 'inline.mmd';
      if (text === undefined) {
        const target = await resolve(input.path, exec);
        const info = await ctx.fs.stat(target, exec.signal);
        if (info === undefined) throw new Error(`mermaid_to_gb_svg: 找不到输入文件 ${input.path}`);
        text = await ctx.fs.readText(target, exec.signal);
        sourceName = target.displayPath ?? input.path;
      }

      const diagrams = extractDiagrams(String(text), INPUT_EXT_RE.test(sourceName) ? sourceName : 'inline.mmd');
      if (diagrams.length === 0) throw new Error('mermaid_to_gb_svg: 输入里没有可转换的 Mermaid 流程图');

      const o = renderOptions(cfg, input);
      const plan = outputPlan(input.out, diagrams.length);
      const files = [];
      const warnings = [];
      let pages = 0;

      for (let i = 0; i < diagrams.length; i++) {
        const d = diagrams[i];
        const caption = o.caption ? (input.title || d.caption || null) : null;
        const meta = {
          caption,
          title: input.title || d.caption || sourceName,
          docTitle: d.caption || sourceName,
        };
        const r = renderDiagram(d.code, o, meta);
        if (!r) { warnings.push(`第 ${i + 1} 张图未解析到任何节点，已跳过`); continue; }

        files.push(await write(fileFor(plan, i, diagrams.length), r.res.svg, exec, policy));

        let p = null;
        try { p = planPages(r.res, o); } catch (e) { warnings.push(`分页失败：${e.message}`); }
        if (p && !p.fits) {
          for (let k = 0; k < p.pages.length; k++) {
            files.push(await write(fileFor(plan, i, diagrams.length, k + 1),
              buildPageSVG(r.res, o, meta, p, p.pages[k], k + 1, p.pages.length), exec, policy));
          }
          pages += p.pages.length;
          if (p.unsafe) warnings.push(`第 ${i + 1} 张图有 ${p.unsafe} 处切点落在图形上（该方向没有整列空隙）`);
        }
        for (const w of r.warns) warnings.push(`第 ${i + 1} 张图：${w}`);
      }

      if (files.length === 0) {
        throw new Error('mermaid_to_gb_svg: 输入里没有可解析的流程图节点（检查 Mermaid 语法）'
          + (warnings.length ? '：' + warnings.join('；') : ''));
      }
      const summary = `已生成 ${files.length} 个 SVG（流程图 ${diagrams.length} 张`
        + (pages ? `，其中分页拆出 ${pages} 张` : '')
        + `，幅面 ${input.paper && input.paper !== 'none' ? PAPERS[input.paper]?.name ?? input.paper : '不分页'}）：`;
      return { files, diagrams: diagrams.length, pages, summary, warnings };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Mermaid → GB/T 1526 SVG',
      kind: 'other',
      rawInput: args,
    }),
  }));
}

export { Config, apply, inject, name };
