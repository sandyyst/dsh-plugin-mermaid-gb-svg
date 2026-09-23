/**
 * engine.js —— Mermaid 流程图 → GB/T 1526-1989 SVG 转换引擎（ESM）
 *
 * 本文件由 tools/build-plugin-engine.js 从命令行版 tools/mermaid2gb-svg.js 生成，
 * 请勿直接编辑：改引擎请改命令行版后重新生成。
 *
 * 导出的都是纯函数：解析 → 布局 → 画 SVG → 分页，不读写文件系统。
 * 图形符号依据 GB/T 1526-1989（等同采用 ISO 5807:1985）。
 *
 * @module dsh-plugin-mermaid-gb-svg/engine
 */
const CJK_RE = /[\u1100-\u115F\u2E80-\u303F\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 估算一段文字在给定字号下的像素宽度（中文全角按 1em 计） */
function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) {
    if (ch === '\t') { w += size * 2; continue; }
    if (ch === ' ') { w += size * 0.3; continue; }
    if (CJK_RE.test(ch)) { w += size; continue; }
    if (/[iIlj.,;:!|'`\[\](){}]/.test(ch)) { w += size * 0.3; continue; }
    if (/[A-Z@%&#WMmw]/.test(ch)) { w += size * 0.68; continue; }
    w += size * 0.55;
  }
  return w;
}

const num = (v) => (Math.round(v * 100) / 100).toString();

/** 拆分多行标签：<br/>、<br>、\n 都算换行 */
function splitLabel(label) {
  const parts = String(label == null ? '' : label)
    .split(/<br\s*\/?>|\\n|\n/gi)
    .map((s) => s.trim());
  return parts.length ? parts : [''];
}

/* =========================================================================
 * 1. 命令行参数
 * ======================================================================= */

function parseArgs(argv) {
  const o = {
    out: null, title: null, dir: null,
    font: "SimSun, '宋体', 'Microsoft YaHei', sans-serif",
    fontSize: 14, gap: 72, nodeGap: 48, padding: 30, stroke: 1.6,
    caption: true, check: true, quiet: false, help: false,
    paper: 'none', margin: 12, marginLeft: 20, frame: true,
    inputs: [],
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error('选项 ' + name + ' 缺少参数');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-o': case '--out': o.out = need(i, a); i++; break;
      case '-t': case '--title': o.title = need(i, a); i++; break;
      case '--dir': o.dir = String(need(i, a)).toLowerCase(); i++; break;
      case '--font': o.font = need(i, a); i++; break;
      case '--font-tu':                                    // 技术制图字体（GB/T 14691 长仿宋）
        o.font = "FangSong, '仿宋', '仿宋_GB2312', STFangsong, SimSun, serif";
        o.captionFont = "FangSong, '仿宋', '仿宋_GB2312', STFangsong, SimSun, serif";
        break;
      case '--font-size': o.fontSize = Number(need(i, a)); i++; break;
      case '--gap': o.gap = Number(need(i, a)); i++; break;
      case '--node-gap': o.nodeGap = Number(need(i, a)); i++; break;
      case '--padding': o.padding = Number(need(i, a)); i++; break;
      case '--stroke': o.stroke = Number(need(i, a)); i++; break;
      case '--no-caption': o.caption = false; break;
      case '--no-check': o.check = false; break;
      case '--paper': o.paper = String(need(i, a)).toLowerCase(); i++; break;
      case '--no-page': case '--no-pages': o.paper = 'none'; break;
      case '--margin': o.margin = Number(need(i, a)); i++; break;
      case '--margin-left': o.marginLeft = Number(need(i, a)); i++; break;
      case '--no-frame': o.frame = false; break;
      case '--frame': o.frame = true; break;
      case '-q': case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error('未知选项：' + a);
        o.inputs.push(a);
    }
  }
  if (o.dir && !['td', 'tb', 'lr', 'bt', 'rl'].includes(o.dir)) {
    throw new Error('--dir 只能是 td / lr / bt / rl');
  }
  return o;
}

const HELP = `
mermaid2gb-svg —— Mermaid 流程图 → GB/T 1526 合规 SVG

用法:
  node mermaid2gb-svg.js <输入.mmd | 输入.md | 目录> [选项]

选项:
  -o, --out <文件>       输出 SVG；.md 内含多张图时作为前缀（out-1.svg、out-2.svg）
  -t, --title <文字>     图题（.md 未指定时自动取代码块上方最近的标题）
      --dir <方向>       强制流向 td | lr | bt | rl（默认沿用图内声明）
      --paper <幅面>     a4 | a4l | a3 | a3l | none（默认 none＝一图一文件，不拆分）
                         a4/a3 等：超出幅面自动拆成 -p1/-p2…（图框+页码+换页连接符号）
      --no-page          等价于 --paper none
      --margin <mm>      页边距，默认 12
      --margin-left <mm> 装订边，默认 20
      --no-frame         分页图纸不画图框
      --font <字体族>    默认 SimSun, '宋体', 'Microsoft YaHei', sans-serif
      --font-tu          改用技术制图字体（GB/T 14691：仿宋/长仿宋）
      --font-size <n>    正文字号，默认 14（≈五号）
      --gap <n>          层间距，默认 72
      --node-gap <n>     同层节点间距，默认 48
      --padding <n>      画布留白，默认 30
      --stroke <n>       图线宽度，默认 1.6
      --no-caption       不绘制图题
      --no-check         关闭生成后的几何自检
  -q, --quiet            静默模式
  -h, --help             显示本帮助

符号映射（GB/T 1526-1989，等同采用 ISO 5807:1985）:
  A((x)) A([x]) A(x)       起止          → 圆角矩形
  A[x]                     处理          → 矩形
  A{x}                     判断          → 菱形
  A[/x/] A[\\x\\]           数据（输入/输出）→ 平行四边形
  A{{x}}                   准备          → 六边形
  A[[x]]                   预定义处理    → 双边矩形
  A[(x)]                   直接存取存储  → 圆柱
  A{/x/}                   人工操作      → 梯形
  A{\\x\\}                  人工输入      → 顶边倾斜四边形
  A>x]                     注释          → 方括号（左边虚线）
  其余符号（文档、多文档、显示、延迟、内部存储、连接符、换页连接符…）用 Mermaid v11 属性写法：
  A@{ shape: doc,    label: "报表" }      → 文档
  A@{ shape: docs,   label: "批量报表" }  → 多文档
  A@{ shape: display,label: "显示" }      → 显示
  A@{ shape: delay,  label: "等待" }      → 延迟
  A@{ shape: internal-storage, label: "内部存储" } → 内部存储
  A@{ shape: connector, label: "A" }      → 连接符（页内，圆）
  A@{ shape: off-page,  label: "B" }      → 换页连接符（异地，五边形）
  shape 也接受中文名：处理/起止/判断/数据/准备/预定义处理/直接存取存储/人工输入/人工操作/
                    文档/多文档/显示/延迟/内部存储/注释/连接符/换页连接符
约定:
  流向自左而右、自上而下；流程线正交、带实心箭头
  判断框出口：标注"是"从底顶点向下，标注"否"从右顶点先向右再转向
  所有入线从图形上中部垂直进入；每根流程线最多 3 个转折
  超过幅面时用异地连接符（五边形）换页，两张图框内位置与编号一一对应

示例:
  node mermaid2gb-svg.js 流程.mmd -o 流程.svg -t "图 1  属性配置文件创建流程"
  node mermaid2gb-svg.js 设计文档.md -o out/fig
`;

/* =========================================================================
 * 2. Mermaid 解析
 * ======================================================================= */

const SHAPE_BY_OPEN = {
  '((': { close: '))', shape: 'terminal' },
  '([': { close: '])', shape: 'terminal' },
  '{{': { close: '}}', shape: 'preparation' },
  '[[': { close: ']]', shape: 'subroutine' },
  '[(': { close: ')]', shape: 'storage' },
  '[/': { close: '/]', shape: 'io' },
  '[\\': { close: '\\]', shape: 'io_rev' },
  '{/': { close: '/}', shape: 'manual_op' },
  '{\\': { close: '\\}', shape: 'manual_input' },
  '>': { close: ']', shape: 'comment' },
  '[': { close: ']', shape: 'process' },
  '{': { close: '}', shape: 'decision' },
  '(': { close: ')', shape: 'terminal' },
};

/**
 * 形状别名 → 内部符号。
 * 左列是 Mermaid 语法名（含 v11 @{shape:...}）与 GB/T 1526 中文名，右侧是内部符号名。
 * 符号名对应 GB/T 1526-1989（等同采用 ISO 5807:1985）规定的图形符号。
 */
const SHAPE_ALIAS = {
  // 起止（圆角矩形/扁圆框）
  terminal: 'terminal', rounded: 'terminal', stadium: 'terminal', pill: 'terminal',
  doublecircle: 'terminal', '起止': 'terminal', '起止框': 'terminal',
  // 处理（矩形）
  process: 'process', rect: 'process', 'rect2': 'process', '处理': 'process', '处理框': 'process',
  // 判断（菱形）
  decision: 'decision', diamond: 'decision', rhombus: 'decision', question: 'decision',
  '判断': 'decision', '判断框': 'decision', '决策': 'decision',
  // 数据（平行四边形，输入/输出）
  io: 'io', data: 'io', parallelogram: 'io', 'input-output': 'io', lean_r: 'io',
  '输入输出': 'io', '数据': 'io', '输入': 'io', '输出': 'io',
  lean_l: 'io_rev', 'io_rev': 'io_rev',
  // 准备（六边形）
  preparation: 'preparation', hexagon: 'preparation', '准备': 'preparation',
  // 预定义处理（双边矩形）
  subroutine: 'subroutine', 'predefined-process': 'subroutine', predefined: 'subroutine',
  '预定义处理': 'subroutine', '子流程': 'subroutine', '子程序': 'subroutine',
  // 直接存取存储（圆柱）
  storage: 'storage', cylinder: 'storage', database: 'storage', 'direct-access-storage': 'storage',
  '直接存取存储': 'storage', '数据存储': 'storage', '数据库': 'storage',
  // 内部存储（矩形带左上线）
  internal_storage: 'internal_storage', 'internal-storage': 'internal_storage', 'stored-data': 'internal_storage',
  '内部存储': 'internal_storage',
  // 人工输入（顶边倾斜四边形）
  manual_input: 'manual_input', 'manual-input': 'manual_input', 'rengong-shuru': 'manual_input',
  '人工输入': 'manual_input',
  // 人工操作（梯形）
  manual_op: 'manual_op', trapezoid: 'manual_op', 'manual-operation': 'manual_op', 'manual-op': 'manual_op',
  '人工操作': 'manual_op',
  // 文档 / 多文档
  document: 'document', doc: 'document', '文档': 'document',
  multi_document: 'multi_document', documents: 'multi_document', docs: 'multi_document',
  'multi-document': 'multi_document', '多文档': 'multi_document',
  // 显示
  display: 'display', '显示': 'display',
  // 延迟
  delay: 'delay', '延迟': 'delay',
  // 注释
  comment: 'comment', annotation: 'comment', '注释': 'comment',
  // 连接符（页内，圆）
  connector: 'connector', circle: 'connector', 'sm-circ': 'connector',
  '连接符': 'connector', '页内连接符': 'connector',
  // 换页连接符（五边形）
  off_page: 'off_page', 'off-page': 'off_page', offpage: 'off_page', 'home-plate': 'off_page',
  '换页连接符': 'off_page', '异地连接符': 'off_page', '页外连接符': 'off_page',
};

const shapeOf = (name) => {
  if (!name) return null;
  const k = String(name).trim().replace(/^["']|["']$/g, '').toLowerCase();
  return SHAPE_ALIAS[k] || SHAPE_ALIAS[String(name).trim()] || null;
};

/** 解析 `@{ shape: doc, label: "说明" }` 形式的属性块 */
function readAttrs(s, i) {
  if (!s.startsWith('@{', i)) return null;
  let depth = 0, j = i, inStr = null;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  if (j >= s.length) return null;
  const body = s.slice(i + 2, j);
  const attrs = {};
  const re = /([A-Za-z_][\w-]*)\s*:\s*("[^"]*"|'[^']*'|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) {
    attrs[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { attrs, next: j + 1 };
}

const ID_RE = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff.\-]*/;
// 判断分支标注：是 / 否
const YES_RE = /^(是|对|真|通过|y|yes|true|ok)/i;
const NO_RE = /^(否|不|假|失败|n|no|false)/i;

function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 解析一个节点引用（可能带形状与标签） */
function readNode(s, i) {
  const m = ID_RE.exec(s.slice(i));
  if (!m) return null;
  const id = m[0];
  let j = i + id.length;
  // Mermaid v11 属性写法：A@{ shape: doc, label: "说明" }
  const at = readAttrs(s, j);
  if (at) {
    const shape = shapeOf(at.attrs.shape);
    const label = at.attrs.label != null ? at.attrs.label : id;
    if (shape || at.attrs.label != null) {
      return { node: { id, label, shape: shape || 'process', explicit: true }, next: at.next };
    }
  }
  const openers = ['((', '([', '{{', '[[', '[(', '[/', '[\\', '{/', '{\\', '>', '[', '{', '('];
  for (const op of openers) {
    if (s.startsWith(op, j)) {
      const spec = SHAPE_BY_OPEN[op];
      if (!spec) continue;
      const closeIdx = s.indexOf(spec.close, j + op.length);
      if (closeIdx < 0) continue;
      let label = s.slice(j + op.length, closeIdx).trim();
      if ((label.startsWith('"') && label.endsWith('"')) || (label.startsWith("'") && label.endsWith("'"))) {
        label = label.slice(1, -1);
      }
      return { node: { id, label, shape: spec.shape, explicit: true }, next: closeIdx + spec.close.length };
    }
  }
  return { node: { id, label: id, shape: null, explicit: false }, next: j };
}

/** 解析 "A & B & C" 形式的节点列表 */
function readNodeList(s, i) {
  const nodes = [];
  let cur = readNode(s, skipSpace(s, i));
  if (!cur) return null;
  nodes.push(cur.node);
  let j = skipSpace(s, cur.next);
  while (s[j] === '&') {
    j = skipSpace(s, j + 1);
    cur = readNode(s, j);
    if (!cur) break;
    nodes.push(cur.node);
    j = skipSpace(s, cur.next);
  }
  return { nodes, next: j };
}

/** 匹配连线操作符，返回 {next, label, style} */
function matchLink(s, i) {
  const rest = s.slice(i);
  let m;
  if ((m = /^<?-\.\s*(.+?)\s*\.-+>?/.exec(rest))) {
    return { next: i + m[0].length, label: m[1], style: { dashed: true } };
  }
  if ((m = /^<?-\.-+>?/.exec(rest))) return { next: i + m[0].length, label: '', style: { dashed: true } };
  if ((m = /^<?==\s*(.+?)\s*==+>?/.exec(rest))) return { next: i + m[0].length, label: m[1], style: { thick: true } };
  if ((m = /^<?==+>?/.exec(rest))) return { next: i + m[0].length, label: '', style: { thick: true } };
  if ((m = /^<?--\s*(.+?)\s*--+[>ox]?/.exec(rest))) return { next: i + m[0].length, label: m[1], style: {} };
  if ((m = /^<?-{2,}[>ox]?/.exec(rest))) return { next: i + m[0].length, label: '', style: {} };
  if ((m = /^<?-{1}>/.exec(rest))) return { next: i + m[0].length, label: '', style: {} };
  if ((m = /^~~~+/.exec(rest))) return { next: i + m[0].length, label: '', style: { invisible: true } };
  return null;
}

function readPipeLabel(s, i) {
  const j = skipSpace(s, i);
  if (s[j] === '|') {
    const e = s.indexOf('|', j + 1);
    if (e > 0) return { i: e + 1, label: s.slice(j + 1, e).trim() };
  }
  return { i, label: null };
}

class Graph {
  constructor(direction) {
    this.direction = direction || 'td';
    this.nodes = new Map();     // id -> node
    this.edges = [];
    this.subgraphs = [];        // {id, title, members:[]}
    this._sub = null;
  }
  addNode(n) {
    let cur = this.nodes.get(n.id);
    if (!cur) {
      cur = { id: n.id, label: n.label, shape: n.shape || 'process', explicit: !!n.explicit };
      this.nodes.set(n.id, cur);
    } else if (n.explicit && !cur.explicit) {
      cur.label = n.label; cur.shape = n.shape; cur.explicit = true;
    }
    if (this._sub && !this._sub.members.includes(n.id)) this._sub.members.push(n.id);
    return cur;
  }
  addEdge(a, b, label, style) {
    if (style && style.invisible) return;
    this.edges.push({
      from: a.id, to: b.id,
      label: label || (style && style.label) || '',
      dashed: !!(style && style.dashed),
      thick: !!(style && style.thick),
    });
  }
}

function parseMermaid(code) {
  const g = new Graph();
  const rawLines = String(code).replace(/\r\n?/g, '\n').split('\n');
  // 去注释、按 ; 拆语句
  const stmts = [];
  for (let line of rawLines) {
    const c = line.indexOf('%%');
    if (c >= 0) line = line.slice(0, c);
    for (const part of line.split(';')) {
      const t = part.trim();
      if (t) stmts.push(t);
    }
  }
  let headerSeen = false;
  for (const stmt of stmts) {
    let m;
    if ((m = /^(?:graph|flowchart)\s+(TB|TD|BT|LR|RL)\b/i.exec(stmt))) {
      g.direction = m[1].toLowerCase();
      headerSeen = true;
      continue;
    }
    if (/^(?:graph|flowchart)\b/i.test(stmt)) { headerSeen = true; continue; }
    if ((m = /^subgraph\s+(.*)$/i.exec(stmt))) {
      const spec = m[1].trim();
      let id = spec, title = spec;
      const bm = /^([^\s\[]+)\s*\[(.*)\]$/.exec(spec);
      if (bm) { id = bm[1]; title = bm[2].replace(/^["']|["']$/g, ''); }
      g._sub = { id, title, members: [] };
      g.subgraphs.push(g._sub);
      continue;
    }
    if (/^end\b/i.test(stmt)) { g._sub = null; continue; }
    if (/^(?:style|classDef|class|linkStyle|click|direction|accTitle|accDescr|title)\b/i.test(stmt)) continue;

    // 解析节点/连线语句
    let i = 0;
    let left = readNodeList(stmt, i);
    if (!left) continue;
    i = left.next;
    for (const n of left.nodes) g.addNode(n);
    let linked = false;
    for (;;) {
      const j = skipSpace(stmt, i);
      const op = matchLink(stmt, j);
      if (!op) break;
      let label = op.label;
      const pl = readPipeLabel(stmt, op.next);
      i = pl.i;
      if (pl.label !== null) label = pl.label;
      const right = readNodeList(stmt, i);
      if (!right) break;
      i = right.next;
      for (const b of right.nodes) g.addNode(b);
      for (const a of left.nodes) for (const b of right.nodes) g.addEdge(a, b, label, op.style);
      left = right;
      linked = true;
    }
    if (!linked) continue;
  }
  if (!headerSeen && !g.direction) g.direction = 'td';
  return g;
}

/* =========================================================================
 * 3. 布局（分层 + 排序 + 正交走线）
 * ======================================================================= */

const ARROW_LEN = 10;
const ARROW_HALF = 4.5;

function nodeBox(label, shape, fs) {
  const lines = splitLabel(label);
  const lh = Math.round(fs * 1.45);
  const tw = Math.max(1, ...lines.map((l) => textWidth(l, fs)));
  const padX = 18, padY = 13;
  const th = lines.length * lh;
  let w, h;
  switch (shape) {
    case 'terminal':          w = tw + 2 * 18; h = th + 22; break;
    case 'decision':          w = tw * 1.5 + 30; h = th * 1.9 + 34; break;
    case 'io':
    case 'io_rev':            w = tw + 2 * padX + 28; h = th + 2 * padY; break;
    case 'preparation':       w = tw + 2 * padX + 28; h = th + 2 * padY; break;
    case 'subroutine':        w = tw + 2 * padX + 12; h = th + 2 * padY; break;
    case 'storage':           w = tw + 2 * padX; h = th + 2 * padY + 14; break;
    case 'internal_storage':  w = tw + 2 * padX + 10; h = th + 2 * padY + 10; break;
    case 'manual_input':      w = tw + 2 * padX + 16; h = th + 2 * padY + 8; break;
    case 'manual_op':         w = tw + 2 * padX + 24; h = th + 2 * padY; break;
    case 'document':          w = tw + 2 * padX + 8; h = th + 2 * padY + 14; break;
    case 'multi_document':    w = tw + 2 * padX + 20; h = th + 2 * padY + 22; break;
    case 'display':           w = tw + 2 * padX + 18; h = th + 2 * padY; break;
    case 'delay':             w = tw + 2 * padX + 18; h = th + 2 * padY; break;
    case 'comment':           w = tw + 2 * padX + 12; h = th + 2 * padY; break;
    case 'connector':         w = Math.max(38, tw + 26); h = w; break;
    case 'off_page':          w = Math.max(42, tw + 26); h = th + 30; break;
    default:                  w = Math.max(tw + 2 * padX, 64); h = th + 2 * padY;
  }
  return { w: Math.ceil(w), h: Math.ceil(h), lines, lh, tw };
}

function layout(g, o) {
  const vertical = g.direction === 'td' || g.direction === 'tb' || !g.direction;
  const fs = o.fontSize;
  const ids = [...g.nodes.keys()];
  const N = new Map();
  for (const id of ids) {
    const n = g.nodes.get(id);
    const box = nodeBox(n.label, n.shape, fs);
    const along = vertical ? box.h : box.w;   // 分层轴尺寸
    const cross = vertical ? box.w : box.h;   // 同层次轴尺寸
    N.set(id, Object.assign({}, n, box, { along, cross }));
  }
  const nodeArr = ids.map((id) => N.get(id));
  const nodes = new Map(N);

  // --- 3.1 回边检测（DFS） ---
  const out = new Map(ids.map((id) => [id, []]));
  const inMap = new Map(ids.map((id) => [id, []]));
  g.edges.forEach((e, idx) => {
    if (!nodes.has(e.from) || !nodes.has(e.to)) return;
    out.get(e.from).push(idx);
    inMap.get(e.to).push(idx);
  });
  const state = new Map();
  const back = new Set();
  const self = new Set();
  const dfs = (id) => {
    state.set(id, 1);
    for (const ei of out.get(id) || []) {
      const e = g.edges[ei];
      if (e.from === e.to) { self.add(ei); continue; }
      const st = state.get(e.to) || 0;
      if (st === 1) back.add(ei);
      else if (st === 0) dfs(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) dfs(id);

  // --- 3.2 分层（DAG 最长路径） ---
  const rank = new Map(ids.map((id) => [id, 0]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  const dag = g.edges.map((e, i) => ({ e, i })).filter(({ i }) => !back.has(i) && !self.has(i));
  for (const { e } of dag) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const queue = ids.filter((id) => (indeg.get(id) || 0) === 0);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const ei of out.get(id) || []) {
      if (back.has(ei) || self.has(ei)) continue;
      const t = g.edges[ei].to;
      rank.set(t, Math.max(rank.get(t), rank.get(id) + 1));
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  for (const id of ids) if (!topo.includes(id)) topo.push(id); // 环内节点兜底

  const maxRank = Math.max(0, ...ids.map((id) => rank.get(id)));
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of ids) layers[rank.get(id)].push(id);

  // --- 3.3 同层排序（重心法，减少交叉） ---
  const posInLayer = () => {
    const p = new Map();
    layers.forEach((L, r) => L.forEach((id, i) => p.set(id, i)));
    return p;
  };
  const bary = (id, side) => {
    const list = side === 'up' ? inMap.get(id) : out.get(id);
    const rel = (list || [])
      .map((ei) => g.edges[ei])
      .filter((e) => !self.has(g.edges.indexOf(e)))
      .map((e) => (side === 'up' ? e.from : e.to))
      .filter((x) => x !== id && pos.has(x));
    if (!rel.length) return null;
    return rel.reduce((s, x) => s + pos.get(x), 0) / rel.length;
  };
  let pos = posInLayer();
  for (let it = 0; it < 4; it++) {
    const order = it % 2 === 0
      ? layers.map((_, r) => r)
      : layers.map((_, r) => r).reverse();
    for (const r of order) {
      const L = layers[r];
      if (L.length < 2) continue;
      const keyed = L.map((id, i) => {
        const b = bary(id, it % 2 === 0 ? 'up' : 'down');
        return { id, k: b === null ? i : b, i };
      });
      keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
      layers[r] = keyed.map((x) => x.id);
      pos = posInLayer();
    }
  }

  // --- 3.4 分层轴坐标 ---
  const gap = o.gap, nodeGap = o.nodeGap;
  const depth = layers.map((L) => Math.max(0, ...L.map((id) => nodes.get(id).along)));
  const alongStart = [];
  let acc = 0;
  for (let r = 0; r <= maxRank; r++) {
    alongStart[r] = acc;
    acc += depth[r] + gap;
  }
  for (let r = 0; r <= maxRank; r++) {
    for (const id of layers[r]) {
      const n = nodes.get(id);
      n.rank = r;
      n.alongCenter = alongStart[r] + depth[r] / 2;
      n.bandA0 = alongStart[r];
      n.bandA1 = alongStart[r] + depth[r];
    }
  }

  // --- 3.5 同层次轴坐标（每层居中） ---
  const layerCross = [];
  for (let r = 0; r <= maxRank; r++) {
    const L = layers[r];
    const total = L.reduce((s, id) => s + nodes.get(id).cross, 0) + nodeGap * Math.max(0, L.length - 1);
    let cur = -total / 2;
    for (const id of L) {
      const n = nodes.get(id);
      n.crossCenter = cur + n.cross / 2;
      n.crossMin = cur;
      n.crossMax = cur + n.cross;
      cur += n.cross + nodeGap;
    }
    layerCross.push(total);
  }
  const allCrossMin = Math.min(...nodeArr.map((n) => n.crossMin));
  const allCrossMax = Math.max(...nodeArr.map((n) => n.crossMax));

  // --- 3.6 走线 ---
  const bboxHit = (c, a0, a1, skip) => {
    for (const n of nodes.values()) {
      if (skip.has(n.id)) continue;
      if (c > n.crossMin - 6 && c < n.crossMax + 6 && a1 > n.bandA0 - 6 && a0 < n.bandA1 + 6) return true;
    }
    return false;
  };
  const findLane = (cands, a0, a1, skip, hRefs) => {
    let best = cands[0], bestScore = Infinity;
    for (const c of cands) {
      let s = 0;
      if (bboxHit(c, a0, a1, skip)) s += 100;
      if (laneConflictV(c, a0, a1)) s += 10;
      if (hRefs) for (const h of hRefs) {
        if (laneConflictH(Math.min(c, h.c), Math.max(c, h.c), h.a)) s += 3;
      }
      if (s < bestScore) { bestScore = s; best = c; if (s === 0) break; }
    }
    return best;
  };
  // 已布竖直通道，用于避免自环/跨层线互相压线
  const lanes = [];
  const laneConflictV = (c, a0, a1) =>
    lanes.some((l) => Math.abs(l.c - c) < 6 && Math.min(a1, l.a1) - Math.max(a0, l.a0) > 0);
  const laneConflictH = (c0, c1, a) =>
    lanes.some((l) => a >= l.a0 - 3 && a <= l.a1 + 3 &&
      l.c > Math.min(c0, c1) - 3 && l.c < Math.max(c0, c1) + 3);

  // 点是否压在节点图形上（多边形按真实轮廓判断）
  const RECT_SHAPES = new Set(['process', 'terminal', 'subroutine', 'storage']);
  const nodeHit = (n, c, a, m) => {
    const c0 = n.crossMin, c1 = n.crossMax;
    const a0 = n.alongCenter - n.along / 2, a1 = n.alongCenter + n.along / 2;
    if (c <= c0 + m || c >= c1 - m || a <= a0 + m || a >= a1 - m) return false;
    if (RECT_SHAPES.has(n.shape)) return true;
    const poly = shapePath(n).pts;
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > a) !== (yj > a)) && (c < ((xj - xi) * (a - yi)) / (yj - yi) + xi)) hit = !hit;
    }
    return hit;
  };
  const pathClear = (pts, skip) => {
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const len = Math.hypot(p1.c - p0.c, p1.a - p0.a);
      const steps = Math.max(2, Math.ceil(len / 5));
      for (let s = 1; s < steps; s++) {
        const c = p0.c + (p1.c - p0.c) * (s / steps);
        const a = p0.a + (p1.a - p0.a) * (s / steps);
        for (const n of nodes.values()) {
          if (skip.has(n.id)) continue;
          if (nodeHit(n, c, a, 1.5)) return false;
        }
      }
    }
    return true;
  };

  // --- 3.7 出入口分配：同一节点的多条分支必须落在不同点上，避免连线重合 ---
  const outIdx = new Map(), inIdx = new Map();
  g.edges.forEach((e, idx) => {
    if (!nodes.has(e.from) || !nodes.has(e.to) || self.has(idx)) return;
    if (!outIdx.has(e.from)) outIdx.set(e.from, []);
    outIdx.get(e.from).push(idx);
    if (!inIdx.has(e.to)) inIdx.set(e.to, []);
    inIdx.get(e.to).push(idx);
  });
  const exitAt = new Map(), entryAt = new Map();
  const tgtCross = (i) => nodes.get(g.edges[i].to).crossCenter;
  const srcCross = (i) => nodes.get(g.edges[i].from).crossCenter;
  for (const [id, list] of outIdx) {
    const u = nodes.get(id);
    const fwd = list.filter((i) => !back.has(i));
    const sorted = fwd.slice().sort((a, b) => tgtCross(a) - tgtCross(b));
    const allSorted = list.slice().sort((a, b) => tgtCross(a) - tgtCross(b));   // 含回边，回边出口另算但会占用顶点
    const aBottom = u.alongCenter + u.along / 2;
    if (u.shape === 'decision' && allSorted.length >= 2) {
      // 判断符号：标注"是"的分支从底顶点向下走，标注"否"的从右顶点出发（先水平向右再转向）
      const leftV = { c: u.crossMin, a: u.alongCenter };
      const bottomV = { c: u.crossCenter, a: aBottom };
      const rightV = { c: u.crossMax, a: u.alongCenter };
      const rest = [];
      let usedBottom = false, usedRight = false;
      for (const i of allSorted) {
        const lab = String(g.edges[i].label || '').trim();
        if (lab && YES_RE.test(lab) && !usedBottom) {
          exitAt.set(i, { c: bottomV.c, a: bottomV.a }); usedBottom = true;
        } else if (lab && NO_RE.test(lab) && !usedRight) {
          exitAt.set(i, { c: rightV.c, a: rightV.a, side: 'right' }); usedRight = true;
        } else {
          rest.push(i);
        }
      }
      if (rest.length) {
        // 未标注 / 超出顶点数的分支：按目标左右位置落到剩余顶点（左→下→右）
        const slots = [leftV];
        if (!usedBottom) slots.push(bottomV);
        if (!usedRight) slots.push(rightV);
        slots.sort((p, q) => p.c - q.c);
        rest.sort((a, b) => tgtCross(a) - tgtCross(b));
        rest.forEach((i, j) => {
          const s = slots[Math.min(j, slots.length - 1)];
          exitAt.set(i, { c: s.c, a: s.a, side: s === rightV ? 'right' : undefined });
        });
      }
    } else {
      sorted.forEach((i, j) => {
        const t = sorted.length === 1 ? 0.5 : j / (sorted.length - 1);
        const off = (t - 0.5) * Math.min(u.cross * 0.5, 72);
        exitAt.set(i, { c: u.crossCenter + off, a: aBottom });
      });
    }
  }
  for (const [id, list] of inIdx) {
    const v = nodes.get(id);
    // GB 画法：所有入线一律从图形上中部的同一点垂直进入，不做分散
    const vTop = v.alongCenter - v.along / 2;
    for (const i of list) entryAt.set(i, { c: v.crossCenter, a: vTop });
  }

  const routed = [];
  const chanUse = new Map();   // 相邻两层之间的横向通道占用计数，避免分支线互相压线
  g.edges.forEach((e, idx) => {
    const u = nodes.get(e.from), v = nodes.get(e.to);
    if (!u || !v) return;
    let pts = [], tip = null;
    const isBack = back.has(idx);
    const isSelf = self.has(idx);

    if (isSelf) {
      // 自环放在右侧；若右侧已有通道经过，则改放左侧
      let side = 1;
      const y0 = u.alongCenter - 8, y1 = u.alongCenter + 8;
      const span = (c0, c1) => laneConflictH(c0, c1, y0) || laneConflictH(c0, c1, y1);
      if (side > 0) {
        if (span(u.crossMax, u.crossMax + 26 + ARROW_LEN) || laneConflictV(u.crossMax + 26, y0, y1)) side = -1;
      } else if (span(u.crossMin - 26 - ARROW_LEN, u.crossMin) || laneConflictV(u.crossMin - 26, y0, y1)) {
        side = 1;
      }
      const c = side > 0 ? u.crossMax : u.crossMin;
      const c2 = c + side * 26;
      pts = [
        { c, a: y0 },
        { c: c2, a: y0 },
        { c: c2, a: y1 },
        { c: c + side * ARROW_LEN, a: y1 },
      ];
      tip = { c, a: y1 };
    } else if (isBack) {
      const lo = Math.min(u.rank, v.rank), hi = Math.max(u.rank, v.rank);
      let cmin = Infinity, cmax = -Infinity;
      for (let r = lo; r <= hi; r++) for (const id of layers[r]) {
        const n = nodes.get(id); cmin = Math.min(cmin, n.crossMin); cmax = Math.max(cmax, n.crossMax);
      }
      // 横向出/入段是否被同层或其它节点的图框挡住
      const crossBlocked = (c0, c1, a, skip) => {
        const lo2 = Math.min(c0, c1), hi2 = Math.max(c0, c1);
        for (const n of nodes.values()) {
          if (skip.has(n.id)) continue;
          if (a > n.alongCenter - n.along / 2 - 6 && a < n.alongCenter + n.along / 2 + 6 &&
              hi2 > n.crossMin - 6 && lo2 < n.crossMax + 6) return true;
        }
        return false;
      };
      const laneGap = o.gap * 0.45;
      // 回边一律绕到侧边通道，再上升到目标上方，从"上中部"垂直进入
      const en = entryAt.get(idx) || { c: v.crossCenter, a: v.alongCenter - v.along / 2 };
      const laneY = v.bandA0 - gap * 0.35;
      // 回边也按标注选边：否→先向右出，是→向左出
      const lab = String(e.label || '').trim();
      const prefer = NO_RE.test(lab) ? ['right', 'left']
        : (YES_RE.test(lab) ? ['left', 'right']
          : (v.crossCenter <= u.crossCenter ? ['left', 'right'] : ['right', 'left']));
      let left = prefer[0] === 'left';
      let lane = null;
      const a0 = Math.min(u.alongCenter, laneY), a1 = Math.max(u.alongCenter, laneY);
      for (const side of prefer) {
        const L = side === 'left';
        const candLane = L ? cmin - laneGap : cmax + laneGap;
        if (crossBlocked(L ? u.crossMin : u.crossMax, candLane, u.alongCenter, new Set([u.id]))) continue;
        if (crossBlocked(candLane, en.c, laneY, new Set([u.id, v.id]))) continue;
        if (bboxHit(candLane, a0, a1, new Set([u.id, v.id]))) continue;
        lane = candLane; left = L; break;
      }
      if (lane === null) {
        left = prefer[0] === 'left';
        lane = left ? cmin - laneGap : cmax + laneGap;
      }
      pts = [
        { c: left ? u.crossMin : u.crossMax, a: u.alongCenter },
        { c: lane, a: u.alongCenter },
        { c: lane, a: laneY },
        { c: en.c, a: laneY },
        { c: en.c, a: en.a - ARROW_LEN },
      ];
      tip = { c: en.c, a: en.a };
    } else {
      const ex = exitAt.get(idx) || { c: u.crossCenter, a: u.alongCenter + u.along / 2 };
      const en = entryAt.get(idx) || { c: v.crossCenter, a: v.alongCenter - v.along / 2 };
      const side = ex.side === 'right';              // 判断框"否"：从右顶点出发
      const S = { c: ex.c, a: ex.a };
      const endA = en.a - ARROW_LEN;                 // 自上而下落到入口点
      const lastPt = { c: en.c, a: endA };
      const skip = new Set([u.id, v.id]);
      const y1 = u.bandA1 + gap * 0.35;
      const y2 = v.bandA0 - gap * 0.35;
      const ck = u.rank + '>' + v.rank;
      const cn = chanUse.get(ck) || 0;
      chanUse.set(ck, cn + 1);
      const step = Math.min(14, gap / 5);
      const co = cn === 0 ? 0 : Math.ceil(cn / 2) * step * (cn % 2 ? 1 : -1);
      const mid = (u.bandA1 + v.bandA0) / 2 + co;

      // 依次尝试 0/1/2/3 转折的标准画法，取第一个不压节点的 —— 每根线最多三个转折
      const ladder = [];
      if (Math.abs(S.c - en.c) < 0.5) ladder.push([S, lastPt]);                       // 0 转折
      if (side && en.c > S.c + 0.5) ladder.push([S, { c: en.c, a: S.a }, lastPt]);     // 1 转折：先向右
      for (const yA of [mid, y1, y2]) {                                              // 2 转折：竖-横-竖
        ladder.push([S, { c: S.c, a: yA }, { c: en.c, a: yA }, lastPt]);
      }
      for (let r = u.rank + 1; r < v.rank; r++) {   // 中间各层间隙也多试几个横向通道
        const yA = alongStart[r] + depth[r] + gap * 0.35;
        ladder.push([S, { c: S.c, a: yA }, { c: en.c, a: yA }, lastPt]);
      }
      // 3 转折：横-竖-横-竖（"否"只能先向右；其余出口左右都可作兜底）
      const lanesC = [en.c];
      for (let d = 30; d <= 420; d += 30) lanesC.push(en.c + d, en.c - d);
      for (const L of lanesC) {
        if (side && L <= S.c + 0.5) continue;
        if (!side && Math.abs(L - S.c) < 0.5) continue;
        ladder.push([S, { c: L, a: S.a }, { c: L, a: y2 }, { c: en.c, a: y2 }, lastPt]);
      }
      let chosen = null;
      for (const cand of ladder) if (pathClear(cand, skip)) { chosen = cand; break; }

      if (chosen) {
        pts = chosen;
      } else {
        // 兜底：绕行通道（该情形下转折会超过三个，通常因层间被节点占满）
        const exC = side ? (en.c > ex.c + 1 ? en.c : ex.c) : ex.c;
        const head = [{ c: ex.c, a: ex.a }];
        if (side && exC > ex.c + 1) head.push({ c: exC, a: ex.a });
        if (v.rank === u.rank + 1) {
          pts = head.concat([{ c: exC, a: mid }, { c: en.c, a: mid }, { c: en.c, a: endA }]);
        } else {
          const cands = [en.c, exC];
          for (let d = 30; d <= 420; d += 30) cands.push(en.c - d, en.c + d, exC - d, exC + d);
          const lane = findLane(cands, y1, y2, skip, [{ a: y1, c: exC }, { a: y2, c: en.c }]);
          pts = head.concat([{ c: exC, a: y1 }, { c: lane, a: y1 }, { c: lane, a: y2 },
                 { c: en.c, a: y2 }, { c: en.c, a: endA }]);
        }
      }
      tip = { c: en.c, a: en.a };
    }

    // 去掉重合点与共线中间点
    pts = pts.filter((p, i) => i === 0 || Math.abs(p.c - pts[i - 1].c) > 0.01 || Math.abs(p.a - pts[i - 1].a) > 0.01);
    const simple = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (simple.length >= 2) {
        const a = simple[simple.length - 2], b = simple[simple.length - 1];
        const col = (Math.abs(a.c - b.c) < 0.01 && Math.abs(b.c - p.c) < 0.01) ||
                    (Math.abs(a.a - b.a) < 0.01 && Math.abs(b.a - p.a) < 0.01);
        if (col) { simple[simple.length - 1] = p; continue; }
      }
      simple.push(p);
    }
    const last = simple[simple.length - 1];
    for (let i = 1; i < simple.length; i++) {
      const p0 = simple[i - 1], p1 = simple[i];
      if (Math.abs(p0.c - p1.c) < 0.01 && Math.abs(p0.a - p1.a) > 12) {
        lanes.push({ c: p0.c, a0: Math.min(p0.a, p1.a), a1: Math.max(p0.a, p1.a) });
      }
    }
    routed.push({ edge: e, pts: simple, tip, dir: { c: tip.c - last.c, a: tip.a - last.a } });
  });

  return {
    nodes, layers, routed, maxRank, vertical,
    crossMin: allCrossMin, crossMax: allCrossMax,
    alongMin: 0, alongMax: alongStart[maxRank] + depth[maxRank],
    bands: alongStart.map((s, r) => ({ a0: s, a1: s + depth[r] })),   // 各层占位（分页切点用）
    subgraphs: g.subgraphs,
  };
}

/* =========================================================================
 * 4. SVG 生成
 * ======================================================================= */

/** 椭圆弧采样（抽象坐标，用于圆柱、显示、延迟等符号的曲线边） */
function arcPts(cx, cy, rx, ry, d0, d1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = d0 + (d1 - d0) * (i / n);
    const r = (t * Math.PI) / 180;
    out.push([cx + rx * Math.cos(r), cy + ry * Math.sin(r)]);
  }
  return out;
}

/**
 * 按 GB/T 1526-1989（等同采用 ISO 5807:1985）给出各图形符号的轮廓。
 * 抽象坐标：c = 同层次轴（TD 时为横轴），a = 分层轴（TD 时为纵轴，向下增大）。
 */
function shapePath(n, L) {
  const c0 = n.crossMin, c1 = n.crossMax;
  const a0 = n.alongCenter - n.along / 2, a1 = n.alongCenter + n.along / 2;
  const cm = (c0 + c1) / 2, am = (a0 + a1) / 2;
  const w = c1 - c0, h = a1 - a0;
  const B = { c0, c1, a0, a1 };
  const rect = [[c0, a0], [c1, a0], [c1, a1], [c0, a1]];
  const s = Math.min(15, w * 0.18);
  switch (n.shape) {
    // 起止：圆角矩形
    case 'terminal':
      return { kind: 'rect', rx: true, pts: rect, ...B };
    // 判断：菱形
    case 'decision':
      return { kind: 'poly', pts: [[cm, a0], [c1, am], [cm, a1], [c0, am]], ...B };
    // 数据（输入/输出）：平行四边形
    case 'io':
      return { kind: 'poly', pts: [[c0 + s, a0], [c1, a0], [c1 - s, a1], [c0, a1]], ...B };
    case 'io_rev':
      return { kind: 'poly', pts: [[c0, a0], [c1 - s, a0], [c1, a1], [c0 + s, a1]], ...B };
    // 准备：六边形
    case 'preparation':
      return { kind: 'poly', pts: [[c0 + s, a0], [c1 - s, a0], [c1, am], [c1 - s, a1], [c0 + s, a1], [c0, am]], ...B };
    // 预定义处理：双边矩形
    case 'subroutine':
      return { kind: 'rect', pts: rect, ...B, extras: [
        { pts: [[c0 + 9, a0], [c0 + 9, a1]] }, { pts: [[c1 - 9, a0], [c1 - 9, a1]] }] };
    // 直接存取存储：圆柱
    case 'storage': {
      const ry = Math.min(8, h * 0.16);
      const p = [[c0, a0 + ry], ...arcPts(cm, a0 + ry, w / 2, ry, 180, 360, 8),
                 [c1, a1 - ry], ...arcPts(cm, a1 - ry, w / 2, ry, 0, 180, 8)];
      return { kind: 'poly', pts: p, ...B, extras: [{ pts: arcPts(cm, a0 + ry, w / 2, ry, 0, 180, 8) }] };
    }
    // 内部存储：矩形，左上两条边内缩
    case 'internal_storage':
      return { kind: 'rect', pts: rect, ...B, extras: [
        { pts: [[c0 + 10, a0], [c0 + 10, a1]] }, { pts: [[c0, a0 + 10], [c1, a0 + 10]] }] };
    // 人工输入：顶边倾斜的四边形
    case 'manual_input':
      return { kind: 'poly', pts: [[c0, a0 + Math.min(14, h * 0.28)], [c1, a0], [c1, a1], [c0, a1]], ...B };
    // 人工操作：上宽下窄的梯形
    case 'manual_op':
      return { kind: 'poly', pts: [[c0, a0], [c1, a0], [c1 - s * 1.4, a1], [c0 + s * 1.4, a1]], ...B };
    // 文档：底边波浪的矩形
    case 'document': {
      const base = a1 - Math.min(9, h * 0.2), amp = Math.min(6, h * 0.14);
      const pts = [[c0, a0], [c1, a0], [c1, base]];
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        pts.push([c1 - w * t, base + amp * Math.sin(Math.PI * 2 * t)]);
      }
      pts.push([c0, a0]);
      return { kind: 'poly', pts, ...B };
    }
    // 多文档：叠放的多份文档
    case 'multi_document': {
      const dx = Math.min(9, w * 0.12), dy = Math.min(9, h * 0.16);
      const base = a1 - Math.min(9, h * 0.18), amp = Math.min(5, h * 0.12);
      const f0 = c0, f1 = c1 - 2 * dx, g0 = a0 + 2 * dy, g1 = a1;
      const pts = [[f0, g0], [f1, g0], [f1, base - dy]];
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        pts.push([f1 - (f1 - f0) * t, base - dy + amp * Math.sin(Math.PI * 2 * t)]);
      }
      pts.push([f0, g0]);
      return { kind: 'poly', pts, ...B, extras: [
        { pts: [[c0 + dx, a0 + dy], [c1 - dx, a0 + dy], [c1 - dx, a1 - dy]] },
        { pts: [[c0 + 2 * dx, a0], [c1, a0], [c1, a1]] }] };
    }
    // 显示：左边尖、右边圆弧
    case 'display': {
      const D = Math.min(14, h * 0.3);
      const p = [[c0 + 12, a0], [c1 - D, a0], ...arcPts(c1 - D, am, D * 1.15, h / 2, -90, 90, 10),
                 [c0 + 12, a1], [c0, am]];
      return { kind: 'poly', pts: p, ...B };
    }
    // 延迟：右侧半圆的 D 形
    case 'delay': {
      const r = h / 2;
      const p = [[c0, a0], [c1 - r, a0], ...arcPts(c1 - r, am, r, r, -90, 90, 12), [c0, a1]];
      return { kind: 'poly', pts: p, ...B };
    }
    // 注释：方括号（上、右、下三边实线，左边用虚线接流程线）
    case 'comment':
      return { kind: 'open', pts: [[c0, a0], [c1, a0], [c1, a1], [c0, a1]], ...B,
               extras: [{ pts: [[c0, a0], [c0, a1]], dash: true }] };
    // 连接符（页内）：圆
    case 'connector': {
      const r = Math.min(w, h) / 2;
      return { kind: 'poly', pts: arcPts(cm, am, r, r, 0, 360, 28), ...B };
    }
    // 换页连接符（异地连接符）：五边形，尖端朝下（流向页外）
    case 'off_page': {
      const hh = Math.min(13, h * 0.32);
      return { kind: 'poly', pts: [[c0, a0], [c1, a0], [c1, a1 - hh], [cm, a1], [c0, a1 - hh]], ...B };
    }
    // 处理：矩形
    default:
      return { kind: 'rect', pts: rect, ...B };
  }
}

function buildSVG(g, L, o, meta) {
  const dir = g.direction || 'td';
  const map = (c, a) => {
    switch (dir) {
      case 'lr': return [a, c];
      case 'rl': return [-a, c];
      case 'bt': return [c, -a];
      default: return [c, a];
    }
  };
  const mapDir = (dc, da) => {
    const p0 = map(0, 0), p1 = map(dc, da);
    return [p1[0] - p0[0], p1[1] - p0[1]];
  };

  const fs = o.fontSize;
  const lh = Math.round(fs * 1.45);
  const sw = o.stroke;
  const lineW = Math.max(1, Math.round(sw * 8) / 10);
  const parts = [];
  const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x, y) => {
    bbox.x0 = Math.min(bbox.x0, x); bbox.y0 = Math.min(bbox.y0, y);
    bbox.x1 = Math.max(bbox.x1, x); bbox.y1 = Math.max(bbox.y1, y);
  };

  // --- 节点几何 ---
  const nodeGeo = new Map();
  for (const n of L.nodes.values()) {
    const sp = shapePath(n, L);
    const dpts = sp.pts.map(([c, a]) => map(c, a));
    const xs = dpts.map((p) => p[0]), ys = dpts.map((p) => p[1]);
    xs.forEach((x, i) => grow(x, ys[i]));
    const [cx, cy] = map(n.crossCenter, n.alongCenter);
    nodeGeo.set(n.id, {
      ...n, device: dpts,
      rect: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
      cx, cy,
    });
  }

  // --- 连线 ---
  const edgeGeo = [];
  for (const r of L.routed) {
    const dpts = r.pts.map((p) => map(p.c, p.a));
    const tip = map(r.tip.c, r.tip.a);
    const [dx, dy] = mapDir(r.dir.c, r.dir.a);
    const len = Math.hypot(dx, dy) || 1;
    dpts.forEach((p) => grow(p[0], p[1]));
    grow(tip[0], tip[1]);
    let labelPos = null;
    if (r.edge.label) {
      // 标注靠近分支出口：沿线取 min(0.35 总长, 42px)，再沿法线偏移
      const segs = [];
      let total = 0;
      for (let i = 1; i < dpts.length; i++) {
        const d = Math.hypot(dpts[i][0] - dpts[i - 1][0], dpts[i][1] - dpts[i - 1][1]);
        segs.push(d); total += d;
      }
      let want = Math.min(total * 0.35, 42), k = 0;
      while (k < segs.length - 1 && want > segs[k]) { want -= segs[k]; k++; }
      const a = dpts[k], b = dpts[k + 1] || dpts[k];
      const sx = b[0] - a[0], sy = b[1] - a[1];
      const sl = Math.hypot(sx, sy) || 1;
      const px = a[0] + (sx / sl) * want, py = a[1] + (sy / sl) * want;
      const nx = sy / sl, ny = -sx / sl;         // 法线：竖线取右侧、横线取上方
      const off = 12;
      labelPos = { x: px + nx * off, y: py + ny * off };
      const w = textWidth(r.edge.label, fs - 2);
      grow(labelPos.x - w / 2 - 3, labelPos.y - 10);
      grow(labelPos.x + w / 2 + 3, labelPos.y + 10);
    }
    edgeGeo.push({ dpts, tip, dir: [dx / len, dy / len], label: r.edge.label, labelPos, dashed: r.edge.dashed, thick: r.edge.thick });
  }

  // --- 子图边界 ---
  const subGeo = [];
  for (const sg of L.subgraphs) {
    const members = sg.members.map((id) => nodeGeo.get(id)).filter(Boolean);
    if (!members.length) continue;
    const x0 = Math.min(...members.map((m) => m.rect.x0)) - 18;
    const y0 = Math.min(...members.map((m) => m.rect.y0)) - 30;
    const x1 = Math.max(...members.map((m) => m.rect.x1)) + 18;
    const y1 = Math.max(...members.map((m) => m.rect.y1)) + 14;
    grow(x0, y0 - 6); grow(x1, y1);
    subGeo.push({ sg, x0, y0, x1, y1 });
  }

  // --- 画布 ---
  const pad = o.padding;
  const captionH = (o.caption && meta.caption) ? Math.round(fs * 1.6) + 18 : 0;
  const ox = pad - bbox.x0, oy = pad - bbox.y0;
  const width = Math.ceil(bbox.x1 - bbox.x0 + pad * 2);
  const height = Math.ceil(bbox.y1 - bbox.y0 + pad * 2 + captionH);

  // 以下 parts 里的坐标都是"图面坐标"（未平移），分页时再套不同的 translate
  const P = (p) => num(p[0]) + ',' + num(p[1]);

  // 形状（按 GB/T 1526 符号轮廓绘制）
  for (const n of nodeGeo.values()) {
    const common = `fill="#FFFFFF" stroke="#000000" stroke-width="${num(sw)}" stroke-linejoin="round"`;
    const sp = shapePath(n, L);
    const dmap = (p) => map(p[0], p[1]);
    if (sp.kind === 'rect') {
      const r = n.rect;
      const rr = sp.rx ? Math.min((r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2) : 0;
      const rxs = sp.rx ? ` rx="${num(rr)}" ry="${num(rr)}"` : '';
      parts.push(`<rect x="${num(r.x0)}" y="${num(r.y0)}" width="${num(r.x1 - r.x0)}" height="${num(r.y1 - r.y0)}"${rxs} ${common}/>`);
    } else if (sp.kind === 'open') {
      parts.push(`<polyline points="${sp.pts.map((p) => P(dmap(p))).join(' ')}" fill="none" stroke="#000000" stroke-width="${num(sw)}" stroke-linejoin="round"/>`);
    } else {
      parts.push(`<polygon points="${sp.pts.map((p) => P(dmap(p))).join(' ')}" ${common}/>`);
    }
    // 符号内的辅助线（双边矩形、内部存储、圆柱端线、多文档副本、注释左边虚线）
    for (const ex of (sp.extras || [])) {
      const d = 'M' + ex.pts.map((p) => P(dmap(p))).join(' L');
      const dash = ex.dash ? ' stroke-dasharray="5,3"' : '';
      parts.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="${num(lineW)}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  }

  // 子图框
  for (const s of subGeo) {
    parts.push(`<rect x="${num(s.x0)}" y="${num(s.y0)}" width="${num(s.x1 - s.x0)}" height="${num(s.y1 - s.y0)}" fill="none" stroke="#000000" stroke-width="${num(lineW)}" stroke-dasharray="6,4"/>`);
  }

  // 流程线
  for (const e of edgeGeo) {
    const d = 'M' + e.dpts.map(P).join(' L');
    const dash = e.dashed ? ' stroke-dasharray="7,4"' : '';
    const w = e.thick ? num(sw * 1.6) : num(lineW);
    parts.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="${w}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  // 箭头（实心三角，落点即节点边界）
  for (const e of edgeGeo) {
    const [tx, ty] = e.tip;
    const [dx, dy] = e.dir;
    const nx = -dy, ny = dx;
    const b1 = [tx - dx * ARROW_LEN + nx * ARROW_HALF, ty - dy * ARROW_LEN + ny * ARROW_HALF];
    const b2 = [tx - dx * ARROW_LEN - nx * ARROW_HALF, ty - dy * ARROW_LEN - ny * ARROW_HALF];
    parts.push(`<polygon points="${num(b1[0])},${num(b1[1])} ${num(b2[0])},${num(b2[1])} ${num(tx)},${num(ty)}" fill="#000000" stroke="none"/>`);
  }

  // 节点文字
  for (const n of nodeGeo.values()) {
    const lines = n.lines;
    const y0 = n.cy - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => {
      parts.push(`<text x="${num(n.cx)}" y="${num(y0 + i * lh)}" dy="0.35em">${esc(ln)}</text>`);
    });
  }

  // 分支标注（带白色衬底，避免压线）
  for (const e of edgeGeo) {
    if (!e.labelPos) continue;
    const w = textWidth(e.label, fs - 2);
    parts.push(`<rect x="${num(e.labelPos.x - w / 2 - 3)}" y="${num(e.labelPos.y - 10)}" width="${num(w + 6)}" height="20" fill="#FFFFFF" stroke="none"/>`);
    parts.push(`<text x="${num(e.labelPos.x)}" y="${num(e.labelPos.y)}" dy="0.35em" font-size="${fs - 2}">${esc(e.label)}</text>`);
  }

  const fontAttrs = `font-family="${esc(o.font)}" font-size="${fs}" fill="#000000" text-anchor="middle" stroke-linejoin="round" stroke-linecap="round"`;
  const content = { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 };
  const title = meta.title || meta.docTitle || '流程图';
  const svg = [];
  svg.push('<?xml version="1.0" encoding="UTF-8"?>');
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="figTitle">`);
  svg.push(`  <title id="figTitle">${esc(meta.title || meta.docTitle || '流程图')}</title>`);
  if (meta.desc) svg.push(`  <desc>${esc(meta.desc)}</desc>`);
  svg.push(`  <rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF"/>`);
  svg.push('  <!-- 图形符号（GB/T 1526） -->');
  svg.push(`  <g ${fontAttrs}>`);
  svg.push(`    <g transform="translate(${num(ox)},${num(oy)})">`);
  parts.forEach((p) => svg.push('  ' + p));
  svg.push('    </g>');
  svg.push('  </g>');
  if (o.caption && meta.caption) {
    const cx = width / 2;
    const cy = height - pad / 2 - 2;
    svg.push(`  <text x="${num(cx)}" y="${num(cy)}" text-anchor="middle" fill="#000000" font-family="${esc(o.captionFont || "SimHei, '黑体', 'Microsoft YaHei', sans-serif")}" font-size="${fs - 2}">${esc(meta.caption)}</text>`);
  }
  svg.push('</svg>');
  return {
    svg: svg.join('\n') + '\n', nodeGeo, edgeGeo, width, height, title, ox, oy,
    parts, fontAttrs, content, bands: L.bands, dir, mapPoint: map,
    captionFontSize: fs - 2,
    captionText: (o.caption && meta.caption) ? meta.caption : null,
  };
}

/* =========================================================================
 * 5. 分页（A4 等幅面放不下时拆成多张，带换页连接符号）
 * ======================================================================= */

const MM2PX = 96 / 25.4;
const PAPERS = {
  a4: { w: 210, h: 297, name: 'A4 纵向' },
  a4l: { w: 297, h: 210, name: 'A4 横向' },
  a3: { w: 297, h: 420, name: 'A3 纵向' },
  a3l: { w: 420, h: 297, name: 'A3 横向' },
};

function resolvePaper(o, dir) {
  const key = o.paper === 'auto' ? ((dir === 'lr' || dir === 'rl') ? 'a4l' : 'a4') : o.paper;
  if (!key || key === 'none') return null;
  const p = PAPERS[key];
  if (!p) throw new Error('未知幅面：' + o.paper);
  const ml = (o.marginLeft != null ? o.marginLeft : 20) * MM2PX;
  const m = (o.margin != null ? o.margin : 12) * MM2PX;
  return {
    key, name: p.name,
    w: p.w * MM2PX, h: p.h * MM2PX, wmm: p.w, hmm: p.h,
    ml, mr: m, mt: m, mb: m,
  };
}

/** 在 [lo,hi] 上按 usable 长度贪心切分，切点尽量落在 safe 空隙里 */
function axisCuts(lo, hi, usable, gaps) {
  const cuts = [];
  let start = lo, guard = 0;
  while (hi - start > usable + 0.5 && guard++ < 500) {
    const limit = start + usable;
    let pick = null;
    for (const g of gaps) {
      if (g[1] <= start + 20) continue;
      if (g[0] < limit && g[1] > limit) {
        // 空隙跨过页末：切点取空隙中部，避开节点边界与箭头区
        const mid = (g[0] + g[1]) / 2;
        const at = (g[1] - g[0] <= 400) ? mid : Math.min(limit, g[1] - 14);
        pick = { at: Math.max(at, start + 30), safe: true };
        break;
      }
      if (g[1] <= limit && g[0] > start + 20) pick = { at: (g[0] + g[1]) / 2, safe: true };
    }
    if (!pick) { cuts.push({ at: limit, safe: false }); start = limit; }
    else { cuts.push(pick); start = pick.at; }
  }
  return cuts;
}

/** 折线与某条切线的交点（含箭头段，避免切点落在箭头区时漏连接符号） */
function cutCrossings(edgeGeo, axis, at) {
  const out = [];
  for (const e of edgeGeo) {
    const p = e.dpts;
    for (let i = 1; i < p.length; i++) {
      const v0 = axis === 'y' ? p[i - 1][1] : p[i - 1][0];
      const v1 = axis === 'y' ? p[i][1] : p[i][0];
      if ((v0 - at) * (v1 - at) > 0) continue;
      if (v0 === v1) continue;
      const t = (at - v0) / (v1 - v0);
      if (t < 0 || t > 1) continue;
      out.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]);
    }
    // 末端箭头三角区
    const last = p[p.length - 1];
    const v0 = axis === 'y' ? last[1] : last[0];
    const v1 = axis === 'y' ? e.tip[1] : e.tip[0];
    if (v0 !== v1 && (v0 - at) * (v1 - at) <= 0) {
      const t = (at - v0) / (v1 - v0);
      out.push([last[0] + (e.tip[0] - last[0]) * t, last[1] + (e.tip[1] - last[1]) * t]);
    }
  }
  // 同位置合并，避免圆圈叠在一起
  const uniq = [];
  for (const p of out) if (!uniq.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 18)) uniq.push(p);
  return uniq;
}

const pageLabel = (n) => {
  let s = '';
  n = n + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** 生成分页方案：{paper, pages:[{x0,y0,x1,y1,row,col}], cols, rows, fit, connectors} */
function planPages(res, o) {
  const paper = resolvePaper(o, res.dir);
  if (!paper) return null;
  const capH = (o.caption && res.captionText) ? Math.round(res.captionFontSize * 1.6) + 16 : 0;
  const uW = paper.w - paper.ml - paper.mr;
  const uH = paper.h - paper.mt - paper.mb - capH;
  const b = res.content;
  const pad = 16;                              // 相邻张重叠一点，让连接符号落在图框内

  // 沿流程图方向的切点：层与层之间的空档
  const rankAxis = (res.dir === 'lr' || res.dir === 'rl') ? 'x' : 'y';
  const alongGaps = [];
  for (let r = 0; r + 1 < res.bands.length; r++) {
    const g0 = res.bands[r].a1, g1 = res.bands[r + 1].a0;
    const p0 = res.mapPoint(0, g0), p1 = res.mapPoint(0, g1);
    const k = rankAxis === 'x' ? 0 : 1;
    alongGaps.push([Math.min(p0[k], p1[k]), Math.max(p0[k], p1[k])]);
  }
  // 交叉方向的切点：节点图框之间的空档
  const crossAxis = rankAxis === 'x' ? 'y' : 'x';
  const iv = [...res.nodeGeo.values()].map((n) => {
    const k = crossAxis === 'x' ? [n.rect.x0, n.rect.x1] : [n.rect.y0, n.rect.y1];
    return k;
  }).sort((p, q) => p[0] - q[0]);
  const crossGaps = [];
  let cur = b[crossAxis === 'x' ? 'x0' : 'y0'];
  for (const [s, e] of iv) { if (s - cur > 8) crossGaps.push([cur, s]); cur = Math.max(cur, e); }
  const hiC = b[crossAxis === 'x' ? 'x1' : 'y1'];
  if (hiC - cur > 8) crossGaps.push([cur, hiC]);

  const alongLo = b[rankAxis === 'x' ? 'x0' : 'y0'];
  const alongHi = b[rankAxis === 'x' ? 'x1' : 'y1'];
  const crossLo = b[crossAxis === 'x' ? 'x0' : 'y0'];
  const crossHi = b[crossAxis === 'x' ? 'x1' : 'y1'];

  const alongUsable = rankAxis === 'x' ? uW : uH;
  const crossUsable = rankAxis === 'x' ? uH : uW;
  const alongCuts = axisCuts(alongLo, alongHi, alongUsable, alongGaps);
  const crossCuts = axisCuts(crossLo, crossHi, crossUsable, crossGaps);

  // 每一维的分段边界
  const edgesOf = (lo, hi, cuts) => [lo, ...cuts.map((c) => c.at), hi];
  const aEdges = edgesOf(alongLo, alongHi, alongCuts);
  const cEdges = edgesOf(crossLo, crossHi, crossCuts);

  // 组装每一张的取景范围（图面坐标）
  const winOf = (edges, k) => {
    const lo = k === 0 ? edges[0] : edges[k] - pad;
    const hi = k === edges.length - 2 ? edges[edges.length - 1] : edges[k + 1] + pad;
    return [lo, hi];
  };
  const pages = [];
  const nA = aEdges.length - 1, nC = cEdges.length - 1;
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nC; j++) {
      const [a0, a1] = winOf(aEdges, i);
      const [c0, c1] = winOf(cEdges, j);
      const win = rankAxis === 'x'
        ? { x0: a0, x1: a1, y0: c0, y1: c1 }
        : { x0: c0, x1: c1, y0: a0, y1: a1 };
      pages.push({ ...win, row: i, col: j });
    }
  }

  // 换页连接符号：每条切线上被流程线穿过的地方放一个圆圈
  const connectors = [];
  let seq = 0;
  const addCut = (axis, at, strictLo, strictHi, cutIndex) => {
    for (const [x, y] of cutCrossings(res.edgeGeo, axis, at)) {
      const v = axis === 'x' ? y : x;
      if (v < strictLo - 1 || v > strictHi + 1) continue;
      connectors.push({ x, y, label: pageLabel(seq++), axis, at, cutIndex });
    }
  };
  alongCuts.forEach((c, i) => {
    const strict = rankAxis === 'x' ? [crossLo, crossHi] : [crossLo, crossHi];
    addCut(rankAxis, c.at, strict[0], strict[1], i);
  });
  crossCuts.forEach((c, i) => {
    addCut(crossAxis, c.at, alongLo, alongHi, i);
  });

  const fits = alongCuts.length === 0 && crossCuts.length === 0;
  return {
    paper, pages, connectors, fits,
    rows: nA, cols: nC,
    unsafe: [...alongCuts, ...crossCuts].filter((c) => !c.safe).length,
    usable: { w: uW, h: uH }, capH,
  };
}

/** 输出一张（图面裁剪 + 换页连接符号 + 图题页码） */
function buildPageSVG(res, o, meta, plan, page, pageNo, pageTotal) {
  const { paper, capH } = plan;
  const tx = paper.ml - page.x0;
  const ty = paper.mt - page.y0;
  const fontAttrs = res.fontAttrs;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${paper.wmm}mm" height="${paper.hmm}mm" viewBox="0 0 ${num(paper.w)} ${num(paper.h)}" role="img" aria-labelledby="figTitle">`);
  out.push(`  <title id="figTitle">${esc((meta.title || '流程图') + '（第 ' + pageNo + '/' + pageTotal + ' 页）')}</title>`);
  out.push(`  <rect x="0" y="0" width="${num(paper.w)}" height="${num(paper.h)}" fill="#FFFFFF"/>`);
  if (o.frame !== false) {
    out.push(`  <rect x="${num(paper.ml)}" y="${num(paper.mt)}" width="${num(paper.w - paper.ml - paper.mr)}" height="${num(paper.h - paper.mt - paper.mb)}" fill="none" stroke="#000000" stroke-width="0.8"/>`);
  }
  out.push('  <defs><clipPath id="pageClip">');
  out.push(`    <rect x="${num(paper.ml)}" y="${num(paper.mt)}" width="${num(paper.w - paper.ml - paper.mr)}" height="${num(paper.h - paper.mt - paper.mb)}"/>`);
  out.push('  </clipPath></defs>');
  out.push(`  <g ${fontAttrs}>`);
  out.push('    <g clip-path="url(#pageClip)">');
  out.push(`      <g transform="translate(${num(tx)},${num(ty)})">`);
  res.parts.forEach((p) => out.push('    ' + p));
  out.push('      </g>');
  // 换页连接符（GB/T 1526 异地连接符：五边形，尖端指向流向）
  for (const cn of plan.connectors) {
    const inOwn = cn.axis === 'x'
      ? (cn.x >= page.x0 - 0.5 && cn.x <= page.x1 + 0.5) && (cn.y >= page.y0 && cn.y <= page.y1)
      : (cn.y >= page.y0 - 0.5 && cn.y <= page.y1 + 0.5) && (cn.x >= page.x0 && cn.x <= page.x1);
    if (!inOwn) continue;
    const cx = cn.x + tx, cy = cn.y + ty;
    // 判断本张在切线的哪一侧，决定五边形尖端朝向
    let dir;
    if (cn.axis === 'y') dir = ((page.y0 + page.y1) / 2 < cn.y) ? 'down' : 'up';
    else dir = ((page.x0 + page.x1) / 2 < cn.x) ? 'right' : 'left';
    const r = 9;
    const tip = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] }[dir];
    const nx = -tip[1], ny = tip[0];                 // 侧向单位向量
    const back = [cx - tip[0] * r * 0.7, cy - tip[1] * r * 0.7];
    const sh = [cx + tip[0] * r * 0.3, cy + tip[1] * r * 0.3];   // 肩部
    const pts = [
      [back[0] + nx * r, back[1] + ny * r],
      [sh[0] + nx * r, sh[1] + ny * r],
      [cx + tip[0] * r * 1.2, cy + tip[1] * r * 1.2],
      [sh[0] - nx * r, sh[1] - ny * r],
      [back[0] - nx * r, back[1] - ny * r],
    ];
    out.push(`      <polygon class="gb-offpage" points="${pts.map((p) => num(p[0]) + ',' + num(p[1])).join(' ')}" fill="#FFFFFF" stroke="#000000" stroke-width="1"/>`);
    out.push(`      <text x="${num(back[0] + tip[0] * r * 0.1)}" y="${num(back[1] + tip[1] * r * 0.1)}" dy="0.34em" font-size="9" font-family="Arial, sans-serif">${esc(cn.label)}</text>`);
  }
  out.push('    </g>');
  out.push('  </g>');
  if (o.caption && meta.caption) {
    out.push(`  <text x="${num(paper.w / 2)}" y="${num(paper.h - paper.mb / 2 - 2)}" text-anchor="middle" fill="#000000" font-family="${esc(o.captionFont || "SimHei, '黑体', 'Microsoft YaHei', sans-serif")}" font-size="${res.captionFontSize}">${esc(meta.caption + '（第 ' + pageNo + '/' + pageTotal + ' 页）')}</text>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/* =========================================================================
 * 6. 自检
 * ======================================================================= */

function selfCheck(out, o) {
  const warn = [];
  const rects = [...out.nodeGeo.values()].map((n) => ({ id: n.id, ...n.rect }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const ov2 = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ov > 1 && ov2 > 1) warn.push(`节点「${a.id}」与「${b.id}」图框重叠 ${Math.round(Math.min(ov, ov2))}px`);
    }
  }
  const RECT_SHAPES = new Set(['process', 'terminal', 'subroutine', 'storage']);
  // 点是否落在节点图框内（多边形符号按真实轮廓判断，避免外接矩形误报）
  const inNode = (n, x, y, m) => {
    const r = n.rect;
    if (x <= r.x0 + m || x >= r.x1 - m || y <= r.y0 + m || y >= r.y1 - m) return false;
    if (RECT_SHAPES.has(n.shape) || !n.device) return true;
    const p = n.device;
    let hit = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) hit = !hit;
    }
    return hit;
  };
  const nodes = [...out.nodeGeo.values()];
  for (const e of out.edgeGeo) {
    for (let i = 1; i < e.dpts.length; i++) {
      const [ax, ay] = e.dpts[i - 1], [bx, by] = e.dpts[i];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.ceil(len / 6));
      for (let s = 1; s < steps; s++) {
        const x = ax + (bx - ax) * (s / steps), y = ay + (by - ay) * (s / steps);
        for (const r of nodes) {
          if (inNode(r, x, y, 2)) {
            warn.push(`流程线穿越节点「${r.id}」`);
            i = e.dpts.length; break;
          }
        }
      }
    }
  }
  return [...new Set(warn)];
}

/* =========================================================================
 * 6. 输入提取 / 主流程
 * ======================================================================= */

function extractDiagrams(text, file) {
  const out = [];
  const isMmd = /\.(mmd|mermaid)$/i.test(file);
  if (isMmd) return [{ code: text, caption: null }];
  const re = /^[ \t]*```[ \t]*(mermaid|mmd)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index).split(/\r?\n/);
    let caption = null;
    for (let i = before.length - 1; i >= 0; i--) {
      const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(before[i]);
      if (h) { caption = h[1].trim(); break; }
      if (before[i].trim() && !/^```/.test(before[i].trim())) continue;
    }
    out.push({ code: m[2], caption });
  }
  if (!out.length && /^\s*(graph|flowchart)\s+(TB|TD|BT|LR|RL)/im.test(text)) {
    out.push({ code: text, caption: null });
  }
  return out;
}

function describe(g) {
  const shapes = {};
  for (const n of g.nodes.values()) shapes[n.shape] = (shapes[n.shape] || 0) + 1;
  return `节点 ${g.nodes.size} 个（${Object.entries(shapes).map(([k, v]) => k + '×' + v).join('，')}），连线 ${g.edges.length} 条，流向 ${(g.direction || 'td').toUpperCase()}`;
}

/** 解析 + 布局 + 生成 SVG（供 CLI 与自测复用） */
function renderDiagram(code, o, meta) {
  const g = parseMermaid(code);
  if (!g.nodes.size) return null;
  if (o.dir) g.direction = o.dir;
  else if (g.direction === 'tb') g.direction = 'td';
  const L = layout(g, o);
  const res = buildSVG(g, L, o, meta);
  const warns = o.check ? selfCheck(res, o) : [];
  return { g, layout: L, res, warns };
}

/** 渲染默认选项（与 CLI 默认值一致）。 */
export const DEFAULT_OPTIONS = Object.freeze({
  font: "SimSun, '\u5B8B\u4F53', 'Microsoft YaHei', sans-serif",
  fontSize: 14, gap: 72, nodeGap: 48, padding: 30, stroke: 1.6,
  caption: true, check: true, quiet: true, dir: null,
  paper: 'none', margin: 12, marginLeft: 20, frame: true,
});

export {
  parseMermaid, layout, buildSVG, renderDiagram, selfCheck,
  textWidth, nodeBox, planPages, buildPageSVG, resolvePaper, PAPERS,
  extractDiagrams, describe as describeGraph, MM2PX,
};
