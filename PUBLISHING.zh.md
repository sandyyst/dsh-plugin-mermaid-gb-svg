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

## 四、发布前检查清单

- [ ] `npm test` 全绿（引擎 8 项 + 插件 6 项）
- [ ] `npm pack --dry-run` 只含 7 个文件（lib/、cordis.patch.yml、README、LICENSE、package.json）
- [ ] `package.json` 里填好 `repository` / `homepage` / `bugs`（npm 搜索质量分的重要来源）
- [ ] 仓库已设为 public 并打了 `dsh-plugin` 等 topic
- [ ] 若改了 `tools/mermaid2gb-svg.js`，先 `node tools/build-plugin-engine.js` 重新生成引擎
