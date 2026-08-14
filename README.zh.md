# dsh-vision-plugin

> 让纯文本模型（如 deepseek-v4）拥有视觉能力的 DeepSeek Harness 动态 Cordis 插件。带双语设置界面，可配置视觉模型。

[English](README.md) | **中文**

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-dynamic%20cordis-1f6feb)

**当前版本：v1.1.0** — 界面只显示当前版本，无历史版本残留。

## 功能

1. **`vision_analyze` 工具** — 模型可直接调用，分析本地图片文件（PNG / JPEG / WebP / GIF），返回视觉模型的详细文字描述。
2. **粘贴图片自动转写** — 在对话框粘贴/上传的图片会进入会话；当目标模型是纯文本模型时，`llm/stream` waterfall 监听器自动调用视觉模型把图片转写为文字描述，再交给主模型作答。**文本模型也能"看见"图片**。
3. **双语设置界面** — DSH 设置面板新增"视觉模型 / Vision Model"页：显示当前版本状态，下拉配置默认视觉模型（自动选择或指定模型），保存立即生效；界面语言**跟随 DSH 界面语言自动切换**（设置 → 通用 → 语言）。

## 工作原理

```
粘贴图片 → 宿主入会话校验（modelOverrides 声明图片能力 → 放行）
        → 会话消息携带 image 块
        → llm/stream waterfall 监听器：
            1. 无图片 → 直接放行（零开销）
            2. 已由本插件处理（Symbol 标记）→ 放行（防递归）
            3. 目标模型是原生视觉模型（白名单）→ 放行（原生图片输入）
            4. 其他（纯文本模型）→ 视觉模型转写为文字 → 重新派发
        → 主模型基于文字描述正常作答
```

**视觉路由动态发现（不依赖任何写死的 provider）**：插件会遍历所有已配置的
LLM provider——优先使用触发请求自身的 provider，然后依次查询
`llm.listProviders()` 中的每个路由——选取第一个支持图片的模型（优先原生视觉
白名单，其次 `MODEL_PRIORITY` 顺序，最后是其余支持图片的模型）。转写因此跟随
会话当前使用的路由；只要**任意一个**已配置 provider 提供视觉模型即可工作，
**无需额外 API Key**。
- 视觉模型选择优先级：**界面配置 > 调用参数指定 > 自动选择**（`qwen3.7-plus → kimi-k3 → grok-4.5 → minimax-m3 → …`）。
- 转写结果按 `attachmentId + 问题文本` 缓存（上限 300 条），多轮追问不重复调用视觉模型。
- 监听器注册在根上下文，对所有会话生效；插件停止时自动卸载。

## 设置界面

DSH 设置面板（左下角 ⚙️）→ **视觉模型** 页：

- **状态徽章**：`● 运行中` + `v1.0.1`——只显示当前版本。
- **默认视觉模型**：下拉选择「自动选择（推荐）」或任一支持图片的模型（如 `kimi-k3`、`grok-4.5`），点保存立即生效。
- **信息区**：当前生效模型、LLM 路由、原生视觉模型白名单列表、转写机制说明。

## 容错设计

| 场景 | 行为 |
| --- | --- |
| 视觉模型输出了内容但流结束时报错 | **保留已生成内容**，不判定失败 |
| 视觉模型完全失败（无输出） | **自动换备用模型重试一次** |
| 重试仍失败 | **降级为占位文本**，对话继续，不中断整轮 |
| 错误信息 | **透传上游真实原因**（错误码 / HTTP 状态） |

## 安装

### 0. 一键安装（把下面的提示词发送给 DSH）

复制下面的提示词，发送给 DSH（运行 `cordis` agent 预设的会话）。Agent 会自动获取源码、定义并运行插件、配置 `settings.yaml` 并完成验证：

```text
请帮我安装 dsh-vision-plugin（DeepSeek Harness 视觉插件 v1.0.1）：

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

4. 如果 ~/.dsh/settings.yaml 尚未为纯文本默认模型声明图片能力，请添加（热加载，无需重启）：
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-flash:
             input: [text, image]

5. 验证：
   - Tool.listTools 中能看到 vision_analyze
   - 设置面板出现"视觉模型 / Vision Model"页（双语，跟随界面语言）
   - 在对话框粘贴图片会被自动转写
```

### 1. 加载插件（DSH 动态插件机制）

把 [`plugin/vision-plugin.js`](plugin/vision-plugin.js) 的内容作为 `code.host`、[`plugin/vision-plugin.client.js`](plugin/vision-plugin.client.js) 的内容作为 `code.client`，传入同一次 `cordis_define`（`idPrefix` 自拟，如 `visn`），然后用 `cordis_run` 激活：

```
cordis_define  → 返回 pluginId / packageId
cordis_run     → 激活（Client 部分需在 UI 中批准一次）
```

### 2. 配置部署（让纯文本模型能接收粘贴图片）

宿主在消息进入会话前会校验当前模型的 `inputModalities`。为了让纯文本模型通过校验（图片进入会话后由本插件转写），需要在 `~/.dsh/settings.yaml` 中为其声明图片能力：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      # 为所有纯文本模型声明图片能力：无论切换到哪个模型，聊天都允许粘贴
      # 图片，实际内容由本插件的 llm/stream 监听器在发送前转写为文字。
      # 原生视觉模型（qwen3.7-plus、kimi-k3 等）无需声明。
      modelOverrides:
        deepseek-v4-flash:
          input: [text, image]
        deepseek-v4-pro:
          input: [text, image]
        glm-5.1:
          input: [text, image]
        glm-5.2:
          input: [text, image]
        hy3:
          input: [text, image]
        qwen3.7-max:
          input: [text, image]
        minimax-m2.7:
          input: [text, image]
        mimo-v2.5-pro:
          input: [text, image]
```

> settings.yaml 由 chokidar 热加载，修改后即时生效，无需重启。
> 请为**每一个**可能在含图片会话中切换到的纯文本模型声明该覆盖；否则切到该模型后
> 粘贴图片会在插件转写之前就被宿主拒绝。

## 使用

### 粘贴图片

直接在对话框粘贴（或拖拽/上传）图片，配上一句话（如"这张图里有什么？"），纯文本模型即可回答图片内容。

### vision_analyze 工具

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | ✅ | 图片文件路径（PNG/JPEG/WebP/GIF） |
| `question` | ❌ | 对图片的具体问题；缺省时输出整图详细描述 |
| `model` | ❌ | 指定视觉模型 id（如 `kimi-k3`）；缺省按 界面配置 > 自动选择 |
| `provider` | ❌ | LLM 提供方路由；缺省时自动在所有已配置 provider 中发现 |

## 配置常量（编辑 `plugin/vision-plugin.js`）

| 常量 | 说明 |
| --- | --- |
| `VERSION` | 插件版本号（设置界面展示） |
| `DEFAULT_MODEL` | 兜底视觉模型 id（默认 `qwen3.7-plus`） |
| *（无 provider 常量）* | 视觉路由在所有已配置 provider 中动态发现 |
| `NATIVE_VISION_MODELS` | 原生视觉模型白名单（白名单内图片直接原生发送，不转写） |
| `MODEL_PRIORITY` | 视觉模型自动选择优先级 |

## 注意事项

- 插件是**进程内动态插件**：DSH 重启后需重新运行 `cordis_run`（`pluginId` / `packageId` 保持不变即可）；如需持久化，可将代码迁移为 host 组合中的插件行。
- 界面配置的默认视觉路由（provider + model）保存在**进程内存**中（动态插件生命周期内有效），重启后回到自动选择。
- **没有配置 opencode-go 也能用**：插件会自动在其他已配置 provider 上发现视觉模型；若所有 provider 都没有视觉模型，转写会降级为占位文本而非失败。
- 模型选择 UI 中，被 `modelOverrides` 声明的文本模型会显示"支持图片"标记——这是有意的（经过转写它确实能处理图片）。
- 转写依赖部署路由存在可用的视觉模型；若路由变更，请同步更新 `DEFAULT_PROVIDER` / `NATIVE_VISION_MODELS` / `MODEL_PRIORITY`。

## License

MIT
