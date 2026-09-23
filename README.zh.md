# dsh-plugin-mermaid-gb-svg

把 **Mermaid 流程图**转换成符合 **GB/T 1526-1989**（等同采用 ISO 5807:1985）图形符号的 **SVG**，
并作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件向模型暴露一个工具。

> 说人话：你给模型一段 mermaid（或一个 `.md`），它给你一张黑白、正交走线、符号合规的国标流程图，
> 放不下 A4 还会自动拆成多张并画好换页连接符。

## 安装

```bash
# 1) 装进某个 profile（这里以 web 为例）
dsh plugin --profile web add dsh-plugin-mermaid-gb-svg

# 2) 让 loader 加载它：在 $DSH_HOME/profiles/web/cordis.patch.yml 里加一行
```

`cordis.patch.yml` 追加内容（见本包 `cordis.patch.example.yml`）：

```yaml
- insert:
    - id: mermaid-gb-svg
      name: dsh-plugin-mermaid-gb-svg
      # 可选：覆盖默认值
      # config:
      #   fontSize: 14
      #   paper: none
```

本地开发可直接指向源码目录：`dsh plugin --profile web add /path/to/dsh-plugin-mermaid-gb-svg`。

## 工具：`mermaid_to_gb_svg`

| 参数 | 类型 | 说明 |
|---|---|---|
| `out` | string，**必填** | 输出路径。以 `.svg` 结尾＝文件名（多图自动加 `-1/-2`），否则作为输出目录/前缀 |
| `source` | string | Mermaid 源码（与 `path` 二选一） |
| `path` | string | 输入文件：`.mmd`／`.mermaid`，或含 ` ```mermaid ` 代码块的 `.md`（会抽取全部代码块，取上方最近标题作图题） |
| `title` | string | 图题 |
| `dir` | `td`\|`lr`\|`bt`\|`rl` | 强制流向，默认沿用图内声明 |
| `paper` | `none`\|`auto`\|`a4`\|`a4l`\|`a3`\|`a3l` | 幅面；`none` 默认只出一张大图，其余超幅面自动拆页 |
| `font_size` | integer | 正文字号（px，14≈五号） |
| `font_tu` | boolean | 改用技术制图字体（GB/T 14691 长仿宋/仿宋） |
| `caption` | boolean | 是否画图题，默认 true |

返回：`files`（写出的 SVG 路径）、`diagrams`、`pages`、`summary`、`warnings`。

调用示例（模型侧）：

```
mermaid_to_gb_svg({
  source: "graph TD\n A((开始)) --> B[创建配置对象]\n B --> C{遍历列表}\n C -- 是 --> D[追加路径]\n D --> C\n C -- 否 --> E((结束))",
  out: "docs/fig/配置流程.svg",
  title: "图 1  属性配置文件创建流程"
})
```

## 图形符号（GB/T 1526-1989）

| 符号 | 含义 | Mermaid 写法 |
|---|---|---|
| 圆角矩形 | 起止 | `A([x])` `A((x))` `A(x)` |
| 矩形 | 处理 | `A[x]` |
| 菱形 | 判断 | `A{x}` |
| 平行四边形 | 数据（输入/输出） | `A[/x/]` `A[\x\]` |
| 六边形 | 准备 | `A{{x}}` |
| 双边矩形 | 预定义处理 | `A[[x]]` |
| 圆柱 | 直接存取存储 | `A[(x)]` |
| 梯形 | 人工操作 | `A{/x/}` |
| 顶边倾斜四边形 | 人工输入 | `A{\x\}` |
| 方括号 | 注释 | `A>x]` |
| 圆 | 连接符（页内） | `A@{ shape: connector, label: "A" }` |
| **五边形** | **换页连接符（异地）** | `A@{ shape: off-page, label: "B" }` |
| — | 文档 / 多文档 | `A@{ shape: doc, label: "报表" }` / `docs` |
| — | 显示 / 延迟 | `A@{ shape: display, label: "显示" }` / `delay` |
| — | 内部存储 | `A@{ shape: internal-storage, label: "内部存储" }` |

`shape` 同时接受 Mermaid v11 名称与中文名（处理/起止/判断/数据/准备/预定义处理/直接存取存储/
人工输入/人工操作/文档/多文档/显示/延迟/内部存储/注释/连接符/换页连接符）。

## 制图约定

- 流向**自左而右、自上而下**；流程线正交、末端实心箭头。
- 判断框分支：标注**「是」从底顶点向下**，标注**「否」从右顶点出发（先向右再转向）**。
- 所有**入线从图形上中部垂直进入**，不分散到两侧。
- 每根流程线**最多 3 个转折**：按 0→1→2→3 转折依次择优选路，取第一个不压节点的画法。
- 同层节点不重叠、流程线不穿越节点；生成后自动做几何自检并在 `warnings` 里返回问题。

## 分页（可选）

`paper: a4`（或 `a3`/`auto`）时，超出幅面会拆成多张：

- 按**层间空隙**切分（另一方向切在节点列之间的空隙），不会切断节点；
- 每张按真实幅面输出（`width="210mm" height="297mm"`），带图框、装订边与「第 n/N 页」图题；
- 断线处画 **异地连接符（五边形）**，尖端朝流向；相邻两张图框内位置与编号一一对应。

## 配置

profile 补丁行的 `config` 可覆盖默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `font` | `SimSun, '宋体', 'Microsoft YaHei', sans-serif` | 正文/图题字体族 |
| `fontSize` | `14` | 正文字号 px |
| `stroke` | `1.6` | 图线宽度 |
| `paper` | `none` | 默认幅面（`none` 不分页） |

## 沙箱与安全

写文件走 Harness 的 `ctx.fs` seam，并沿用会话的沙箱策略；被沙箱拒绝时，模型可以带
`sandbox_permissions` + `justification` 做**一次性升权重试**（与内置 `write` 工具同一套语义）。

## 开发与测试

```bash
npm test        # test/engine.test.mjs + test/plugin.test.mjs
```

- `lib/engine.js` 是从命令行版 `tools/mermaid2gb-svg.js` **生成**的（纯函数：解析→布局→画图→分页），
  改引擎请改命令行版后重新生成，两端行为保持一致。
- 插件层测试用替身 `ctx`（`tools.register` / `ctx.fs`）直接跑工具，不需要 DSH 运行时；
  但需要 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-sandbox`、`@deepseek-ai/schemastery`
  这几个 peer 依赖可解析（本地开发在包内 `node_modules/@deepseek-ai` 联接到 dsh 安装目录即可）。

## 许可

MIT
