# 发布与分发指南

本包已经处于"可直接发布"状态：`npm test` 通过、`npm pack` 产物干净、依赖在公共 npm 上都能解析、
包名 `dsh-plugin-mermaid-gb-svg` 未被占用。

## 一、发到 npm（推荐，别人 `npm i` 就能用）

只有一步需要你自己做——登录（我无法代持你的凭据）：

```bash
cd dsh-plugin-mermaid-gb-svg
npm login                 # 浏览器/OTP 完成登录
npm publish               # prepublishOnly 会先跑测试；publishConfig.access=public
```

发完任何人都可以：

```bash
npm i -g @deepseek-ai/dsh                       # 如果还没装 DSH
dsh plugin --profile web add dsh-plugin-mermaid-gb-svg
```

然后重启 `dsh web`，新会话里模型就有 `mermaid_to_gb_svg` 工具了。

常用后续：

```bash
npm version patch && npm publish        # 升版本再发
npm unpublish dsh-plugin-mermaid-gb-svg@0.1.0 --force   # 72 小时内可撤
```

## 二、不要 npm 账号也能分发

```bash
npm pack                                 # 生成 dsh-plugin-mermaid-gb-svg-0.1.0.tgz
```

把这个 `.tgz` 直接发给别人（邮件/网盘/群里），对方：

```bash
dsh plugin --profile web add ./dsh-plugin-mermaid-gb-svg-0.1.0.tgz
```

已验证：从 `.tgz` 安装到全新 profile 能正确注册为 bundle 层并被 loader 组装。

## 三、发到 GitHub / Gitee，让别人 clone

包目录已经是可推送的 git 仓库（已提交 3 个 commit）：

```bash
cd dsh-plugin-mermaid-gb-svg
git remote add origin https://github.com/sandyyst/dsh-plugin-mermaid-gb-svg.git
git push -u origin main          # 本机装了 Git Credential Manager，会弹浏览器登录
```

> 注意：要出现在 <https://github.com/topics/dsh-plugin>，仓库必须是 **public** 并且**打上 topic**。
> topic 不是文件内容，push 不会自动带上去，必须单独设置（见下）。

### 打 topic（两条路，任选）

**A. 网页**：打开仓库 → 右侧 **About** 的齿轮 ⚙ → **Topics** 填：

```
dsh-plugin  dsh  dsh-bundle  deepseek-harness  mermaid  flowchart  gb-t-1526  iso-5807  svg
```

**B. API（需一个 PAT，勾 `public_repo` 即可）**：

```bash
curl -X PUT \
  -H "Authorization: Bearer <你的PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/sandyyst/dsh-plugin-mermaid-gb-svg/topics \
  -d '{"names":["dsh-plugin","dsh","dsh-bundle","deepseek-harness","mermaid","flowchart","gb-t-1526","iso-5807","svg"]}'
```

### 检查

```bash
curl -s https://api.github.com/repos/sandyyst/dsh-plugin-mermaid-gb-svg/topics
# 期望: {"names":["dsh-plugin", ...]}
```

打上后通常在几十分钟内出现在 topic 页面（生态里的 `dsh-find-plugin` 插件就是按这个 topic 抓取并排序的）。

别人可以直接从仓库装：

```bash
dsh plugin --profile web add github:sandyyst/dsh-plugin-mermaid-gb-svg
```

配好 `.github/workflows/release.yml` + 仓库 secret `NPM_TOKEN` 后，打 tag 会自动发布到 npm：

```bash
git tag v0.1.1 && git push --tags
```

## 四、收录进 DSH 插件目录（拿流量 + 拿评论区）

DSH 生态的插件发现入口是 **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**
（17k+ stars，4200+ 插件）。被它收录后会自动出现在：

- **dsh-market**（DSH 界面里的"插件市场"）——用户能一键安装
- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) / [dshmarket.com](https://dshmarket.com)
- 而且**每个插件卡片自带一个 GitHub Discussions 评论线程**（giscus 驱动，三处共用同一个帖子）——这是目前最有效的意见收集渠道：用户就在用的地方留言

### 提交方式：一个文件一个 PR

在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，新增**一个文件**
`data/plugins/sandyyst__dsh-plugin-mermaid-gb-svg.yml`：

```yaml
url: https://github.com/sandyyst/dsh-plugin-mermaid-gb-svg
name: sandyyst/dsh-plugin-mermaid-gb-svg
category: tools
description:
  en: Converts Mermaid flowcharts into GB/T 1526-1989 (ISO 5807) compliant SVG through one model-facing tool, with optional A4/A3 pagination.
  zh: 把 Mermaid 流程图转成符合 GB/T 1526-1989（等同 ISO 5807）图形符号的 SVG，可选用 A4/A3 幅面自动分页。
```

> 注意：描述里若含半角 `: `（冒号+空格）必须给整行加引号，否则 YAML 解析失败。
> 可用 `category`：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。
> 一个 PR 最多 3 条。

### 收录硬性条件（对照我们的状态）

| 条件 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | ✅ |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 真实可用的代码（非占位/纯 README） | ✅（引擎 + 插件 + 14 项测试） |
| 仓库创建满 **1 天** | ⚠️ 2026-09-29 创建 —— **次日再提 PR**（CI 自动检查） |
| 仓库打了 `dsh-plugin` topic | ✅ |
| 描述属实、不带营销词 | ✅ |
| `peerDependencies` 含**显式预发布分支** | ✅ 0.1.3 已修（见下） |
| npm 包的 `repository` 指回本仓库 | ✅ 0.1.2 起 |
| 截图（可选，推荐） | ⬜ 见下 |

**预发布区间这个坑值得单独记一笔**：node-semver 只有当范围里某个比较符与该版本的
`major.minor.patch` 元组完全一致、且自身带预发布标签时，才放行预发布版本。所以
`^0.1.5-rc.1` 匹配不到 `0.1.7-alpha.2`，用户会撞上 `ERESOLVE`。正确写法是显式 `||` 分支：

```jsonc
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.0.2-0 || >=0.1.5-0 <0.1.6-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0 || >=0.1.8-0 <0.2.0-0"
```

### 截图（可选，提升安装转化）

在**本仓库**（不是上游）放 `screenshots.json`，列 1–8 张图，路径相对该文件：

```jsonc
// screenshots.json
["assets/screenshot-1.png", "assets/screenshot-2.png"]
```

做法：用浏览器打开 `examples/gb-1526-symbols.svg` 和 `examples/attribute-config.svg` 截图存 PNG。
（不声明也行：市场会从 README 自动抽取图片，即那两张 SVG。）

## 五、发布前检查清单

- [ ] `npm test` 全绿（引擎 8 项 + 插件 6 项）
- [ ] `npm pack --dry-run` 只含 7 个文件（lib/、cordis.patch.yml、README、LICENSE、package.json）
- [ ] `package.json` 里 `repository` / `homepage` / `bugs` 指向本仓库
- [ ] `peerDependencies` 是显式预发布分支写法
- [ ] 仓库已设为 public 并打了 `dsh-plugin` topic
- [ ] 若改了 `tools/mermaid2gb-svg.js`，先 `node tools/build-plugin-engine.js` 重新生成引擎
