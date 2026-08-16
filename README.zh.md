# dsh-vision-plugin

> 给 DeepSeek Harness 的纯文本模型装上"眼睛"。

[English](README.md) | **中文**

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-bundle%20composition-1f6feb)

**v1.3.0** · MIT License

---

deepseek-v4 系列是纯文本模型：你可以在对话框里粘贴截图、照片，但它看不见。这个插件在中间加了一层——图片先交给视觉模型（qwen3.7-plus、kimi-k3 等）转写成文字描述，再把描述交给主模型。从此**粘贴图片、切换任何文本模型，都能正常"看图"**。

## 效果

```
你：这是什么？                          （粘贴了一张 Clash Verge Logo）

助手：这是 Clash Verge 的标志（Logo）。左侧是一个黑色的猫头剪影，
     右侧是文字 "Clash Verge"。它是一款基于 Clash 内核的图形化
     代理客户端软件……
```

图片由视觉模型自动转写，主模型看到的是文字描述，回答和读图效果一样自然。

## 三个能力

1. **粘贴图片直接问** —— 对话框粘贴或拖入图片，任意文本模型都能回答图片内容，不需要任何特殊指令。
2. **`vision_analyze` 工具** —— 模型可以主动调用它分析本地图片文件，还能指定问题（"图中表格第三行数据是多少？"）和具体视觉模型。
3. **设置页配置视觉模型** —— DSH 设置面板新增"视觉模型"页：选默认视觉模型、看当前路由，中英双语、跟随界面语言。

## 快速开始

### 永久安装 —— 每次 dsh 启动自动载入

本仓库根目录就是一个 dsh **bundle 包**（`dsh-vision-plugin`）：宿主半部
[`lib/index.js`](lib/index.js)、浏览器半部 [`lib/client.js`](lib/client.js)、
插件行 [`cordis.patch.yml`](cordis.patch.yml)。把 bundle 注册进你的 profile，
dsh 启动时就会自动挂载插件——不需要 `cordis_define`/`cordis_run`，重启也不丢。

**① 用 `dsh plugin` 安装。** 包已发布到 npm，一条命令搞定——`dsh plugin` 用 pnpm 装好包后，因为包声明了 `dsh.bundle`，会自动把它追加进 `dsh.profile.bundles`：

```bash
dsh plugin --profile web add dsh-vision-plugin
```

正在开发插件本身？改用本地检出安装——下次重启 dsh 即生效，无需走 registry：

```bash
dsh plugin --profile web add /绝对路径/deepseek-harness-plug
# 或在检出目录里直接：
dsh plugin --profile web add .
```

然后确认行已合成：

```bash
dsh --profile web --dump-config        # 合成树里应出现 "vision" 行
```

**② 声明图片能力。** 宿主在消息进入会话前会检查当前模型的输入能力。为了让文本模型收下图片（收下后由插件转写），在 `~/.dsh/settings.yaml` 里给它们声明：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      modelOverrides:
        deepseek-v4-flash:
          input: [text, image]
        deepseek-v4-pro:
          input: [text, image]
        # 其他可能切换到的文本模型同理；原生视觉模型无需声明
```

文件会被自动热加载，不用重启。**建议把每个你可能用到的文本模型都写上**——否则切到未声明的模型后粘贴图片，会在插件转写之前就被拒绝。

**③ 重启 dsh。** 启动时 loader 会挂载 `vision` 行：注册 `vision_analyze` 工具、开启 `llm/stream` 图片转写瀑布、`/vision/api/state` 服务设置页，浏览器半部由 `/plugins/dsh-vision-plugin/client.js` 提供。验证：设置面板出现"视觉模型"页、工具列表里有 `vision_analyze`，然后粘贴图片开聊。

## 设置界面

打开 DSH 左下角 ⚙️ 设置 → "视觉模型"页：

- 状态徽章显示运行状态和版本号
- 下拉框选择默认视觉模型（自动选择，或指定某个模型）——保存立即生效，且选择会被**记住**（浏览器本地存储），下次启动自动恢复
- 底部说明当前生效的模型和路由

界面语言跟随 DSH 设置（通用 → 语言），中英文自动切换。

## 常见问题

**切到其他文本模型后粘贴图片被拒？**
settings.yaml 里没有给那个模型声明图片能力。按上面步骤 ② 补上即可，热加载立即生效。

**没有配置 opencode-go 怎么办？**
不影响。v1.1.0 起插件会遍历所有已配置的 provider，自动找到第一个带视觉模型的路由；一个都没有时才会降级（对话继续，提示图片不可用）。

**我的 provider 拒绝图片，报 `unknown variant \`image_url\`, expected \`text\``？**
这个错误说明图片块被发给了只接受文本的模型。自动选择绝不会这么做：只会自动挑原生视觉白名单（`lib/engine.js` 里的 `NATIVE_VISION_MODELS`）内的模型。但设置页会列出**所有 provider 上目录声明支持图片的全部模型**——白名单内和你在 settings.yaml 里用 `modelOverrides` 声明图片能力的都算，显式选择（设置页或 `vision_analyze` 的 `model` 参数）会被采纳。如果选中的模型上游实际拒绝图片，调用会自动回退到白名单视觉模型（一个都没有时降级为占位提示）。如果你用的模型确实支持原生视觉但还没进白名单，把它加进去，自动选择就会优先用它。

**DSH 重启后插件还在吗？**
会。永久安装把 bundle 注册进 profile 的 `dsh.profile.bundles`，每次启动都会自动载入——这正是它的目的。

**会多花钱吗？**
转写会调用一次视觉模型；同一张图、同一个问题有缓存，多轮追问不会重复调用。视觉模型优先级：工具显式参数（model/provider）> 设置页配置 > 自动选择。

**我选的视觉模型会被记住吗？**
会。v1.2.0 起设置页的选择保存在浏览器（localStorage），下次启动 dsh 自动恢复；自动转写瀑布也走同一路由。宿主侧的路由本身是进程内的。

**视觉模型出错了会怎样？**
不会中断对话：输出了一部分就保留一部分；完全失败就换备用模型再试一次；视觉调用挂起超过两分钟会被掐断并视为失败（从而触发备用模型重试）；还不行就告诉模型"图片暂时不可用"，对话照常继续。

## Bundle 结构

- [`lib/engine.js`](lib/engine.js) —— **共享引擎，单一事实源**：`vision_analyze` 工具、`llm/stream` 转写瀑布、路由发现、缓存与超时。刻意零 import（pnpm 不会为 `link:` profile 插件安装依赖）。
- [`lib/index.js`](lib/index.js) —— bundle 宿主适配器（组合插件行 `vision`）：在 `ctx.webServer` 上注册工具、瀑布与 `/vision/api/state`、`/vision/api/model` JSON 接口。
- [`lib/client.js`](lib/client.js) —— bundle 浏览器半部（`dsh.client` 名册条目）："视觉模型"设置页，由 web shell 在 `/plugins/dsh-vision-plugin/client.js` 提供。
- [`cordis.patch.yml`](cordis.patch.yml) —— 挂载该 bundle 的 loader 补丁行（`dsh.bundle.patch`）。
- [`scripts/check.js`](scripts/check.js) —— 一致性检查（`npm run check`）：校验版本号在各处一致、`lib/engine.js` 保持零 import。
- [`test/engine.test.js`](test/engine.test.js) —— 引擎测试套件（`npm test`）：路由发现、override 优先级、缓存/去重、超时、瀑布、工具。

开发插件本身：改 [`lib/engine.js`](lib/engine.js)（宿主逻辑）或 [`lib/client.js`](lib/client.js)（界面），然后 `npm run check && npm test`。

## 深入细节（可选阅读）

工作流程：图片进入会话 → `llm/stream` 监听器判断目标模型——原生视觉模型（白名单）直接看原图；文本模型则先由视觉模型转写成文字再派发。图片检测是递归的（与宿主一致）：嵌套在 `tool-result` 里的图片、以及助手消息里的图片（来自视觉模型会话的历史）同样会被转写或替换，保证任何图片块都不会到达纯文本模型。转写请求带 Symbol 标记防递归，结果按"图片 + 问题"缓存（TTL + FIFO 上限，并发同图共享一次在途调用）。

设置页会列出所有 provider 上目录声明支持图片的全部模型——不限于 opencode 路由：白名单原生视觉模型，以及你通过 `modelOverrides` 声明图片能力的模型都显示。只有自动选择走白名单门控：`resolveVisionRoute` 只会挑 `NATIVE_VISION_MODELS` 里的模型，因为仅凭目录的"图片能力"无法和 `modelOverrides` 广告区分，纯文本模型会在上游直接拒绝图片块（`unknown variant \`image_url\``）。显式选择则信任用户配置；若所选模型上游失败，现有重试逻辑会自动回退到白名单视觉模型。

可调常量都在 [`lib/engine.js`](lib/engine.js) 顶部：`DEFAULT_MODEL`（兜底模型）、`NATIVE_VISION_MODELS`（自动选择用的原生视觉白名单）、`MODEL_PRIORITY`（自动选择顺序）、`STREAM_TIMEOUT_MS`（视觉调用挂起超时）、`CACHE_TTL_MS` / `CACHE_MAX`（转写缓存）、`CATALOG_TTL_MS`（模型目录缓存）。

## License

MIT
