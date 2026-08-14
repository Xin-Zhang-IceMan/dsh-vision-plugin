# dsh-vision-plugin

> 给 DeepSeek Harness 的纯文本模型装上"眼睛"。

[English](README.md) | **中文**

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-bundle%20composition-1f6feb)

**v1.1.1** · MIT License

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

### 方式 A：永久安装 —— 每次 dsh 启动自动载入（推荐）

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

### 方式 B：动态插件（不需要本地仓库检出）—— 进程内生效

不想维护本地 bundle 检出时用这个：把下面这段发给一个 DSH 会话，让 Agent 替你安装。动态插件是进程内的——dsh 重启后需要重新 `cordis_run`（pluginId / packageId 不变）。

```text
请帮我安装 dsh-vision-plugin（DeepSeek Harness 视觉插件 v1.1.1）：

1. 获取插件源码（用 curl 下载，或从本地检出目录读取）：
   - Host 半部：  https://raw.githubusercontent.com/Xin-Zhang-IceMan/dsh-vision-plugin/main/plugin/vision-plugin.js
   - Client 半部：https://raw.githubusercontent.com/Xin-Zhang-IceMan/dsh-vision-plugin/main/plugin/vision-plugin.client.js

2. 用 cordis_define 定义动态 Cordis 插件：
   - kind: "new"，idPrefix: "visn"
   - code.host   = vision-plugin.js 的完整内容（函数体）
   - code.client = vision-plugin.client.js 的完整内容（函数体）
   - name: "Vision Assistant"
   - purpose: 一句话描述插件用途

3. 用 cordis_run 激活（mode: "run"）；Client 部分提示审批时请批准。

4. 如果 ~/.dsh/settings.yaml 尚未为纯文本模型声明图片能力，请添加（热加载，无需重启）：
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-flash:
             input: [text, image]

5. 验证：
   - Tool.listTools 中能看到 vision_analyze
   - 设置面板出现"视觉模型 / Vision Model"页
   - 在对话框粘贴图片会被自动转写
```

## 设置界面

打开 DSH 左下角 ⚙️ 设置 → "视觉模型"页：

- 状态徽章显示运行状态和版本号
- 下拉框选择默认视觉模型（自动选择，或指定某个模型）——保存立即生效
- 底部说明当前生效的模型和路由

界面语言跟随 DSH 设置（通用 → 语言），中英文自动切换。

## 常见问题

**切到其他文本模型后粘贴图片被拒？**
settings.yaml 里没有给那个模型声明图片能力。按上面"方式 A ②"补上即可，热加载立即生效。

**没有配置 opencode-go 怎么办？**
不影响。v1.1.0 起插件会遍历所有已配置的 provider，自动找到第一个带视觉模型的路由；一个都没有时才会降级（对话继续，提示图片不可用）。

**DSH 重启后插件还在吗？**
永久安装（方式 A）每次启动都会自动载入——这正是它的目的。动态插件（方式 B）是进程内的，重启后需要重新 `cordis_run`。

**会多花钱吗？**
转写会调用一次视觉模型；同一张图、同一个问题有缓存，多轮追问不会重复调用。视觉模型优先级：设置页配置 > 调用参数 > 自动选择。

**视觉模型出错了会怎样？**
不会中断对话：输出了一部分就保留一部分；完全失败就换备用模型再试一次；还不行就告诉模型"图片暂时不可用"，对话照常继续。

## Bundle 结构

- [`lib/index.js`](lib/index.js) —— 宿主半部（组合插件行 `vision`）：`vision_analyze` 工具、`llm/stream` 转写瀑布、`/vision/api/state` 与 `/vision/api/model` JSON 接口。刻意零第三方 import（pnpm 不会为 `link:` profile 插件安装依赖）。
- [`lib/client.js`](lib/client.js) —— 浏览器半部（`dsh.client` 名册条目）："视觉模型"设置页，由 web shell 在 `/plugins/dsh-vision-plugin/client.js` 提供。
- [`cordis.patch.yml`](cordis.patch.yml) —— 挂载该 bundle 的 loader 补丁行（`dsh.bundle.patch`）。
- [`plugin/vision-plugin.js`](plugin/vision-plugin.js) / [`plugin/vision-plugin.client.js`](plugin/vision-plugin.client.js) —— 方式 B 使用的动态插件源码（同一引擎，`harness` API）。

## 深入细节（可选阅读）

工作流程：图片进入会话 → `llm/stream` 监听器判断目标模型——原生视觉模型（白名单）直接看原图；文本模型则先由视觉模型转写成文字再派发。转写请求带 Symbol 标记防递归，结果按"图片 + 问题"缓存。

可调常量都在 [`lib/index.js`](lib/index.js) 顶部注释里：`DEFAULT_MODEL`（兜底模型）、`NATIVE_VISION_MODELS`（原生视觉白名单）、`MODEL_PRIORITY`（自动选择顺序）。

## License

MIT
