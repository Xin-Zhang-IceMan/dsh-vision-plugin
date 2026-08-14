# dsh-vision-plugin

> 让纯文本模型（如 deepseek-v4）拥有视觉能力的 DeepSeek Harness 动态 Cordis 插件。

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-dynamic%20cordis-1f6feb)

## 功能

1. **`vision_analyze` 工具** — 模型可直接调用，分析本地图片文件（PNG / JPEG / WebP / GIF），返回视觉模型的详细文字描述。
2. **粘贴图片自动转写** — 在对话框粘贴/上传的图片会进入会话；当目标模型是纯文本模型时，`llm/stream` waterfall 监听器自动调用视觉模型把图片转写为文字描述，再交给主模型作答。**文本模型也能"看见"图片**。

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

- 复用部署自身配置的 LLM 路由（默认 `opencode-go`），**无需额外 API Key**。
- 视觉模型自动选择：优先 `qwen3.7-plus`，按优先级列表 `qwen3.7-plus → kimi-k3 → grok-4.5 → minimax-m3 → …`，也可在调用时手动指定。
- 转写结果按 `attachmentId + 问题文本` 缓存（上限 300 条），多轮追问不重复调用视觉模型。
- 监听器注册在根上下文，对所有会话生效；插件停止时自动卸载。

## 容错设计

| 场景 | 行为 |
| --- | --- |
| 视觉模型输出了内容但流结束时报错 | **保留已生成内容**，不判定失败 |
| 视觉模型完全失败（无输出） | **自动换备用模型重试一次** |
| 重试仍失败 | **降级为占位文本**，对话继续，不中断整轮 |
| 错误信息 | **透传上游真实原因**（错误码 / HTTP 状态） |

## 安装

### 1. 加载插件（DSH 动态插件机制）

把 [`plugin/vision-plugin.js`](plugin/vision-plugin.js) 的内容作为 `code.host` 传入 `cordis_define`（`idPrefix` 自拟，如 `visn`），然后用 `cordis_run` 激活：

```
cordis_define  → 返回 pluginId / packageId
cordis_run     → 激活
```

### 2. 配置部署（让纯文本模型能接收粘贴图片）

宿主在消息进入会话前会校验当前模型的 `inputModalities`。为了让纯文本模型通过校验（图片进入会话后由本插件转写），需要在 `~/.dsh/settings.yaml` 中为其声明图片能力：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      # 文本模型声明为支持图片：聊天允许粘贴图片，
      # 实际内容由本插件的 llm/stream 监听器转写为文字。
      modelOverrides:
        deepseek-v4-flash:
          input: [text, image]
```

> settings.yaml 由 chokidar 热加载，修改后即时生效，无需重启。
> 其他纯文本模型（如 `deepseek-v4-pro`）如需同样的能力，在 `modelOverrides` 中追加同名条目即可。

## 使用

### 粘贴图片

直接在对话框粘贴（或拖拽/上传）图片，配上一句话（如"这张图里有什么？"），纯文本模型即可回答图片内容。

### vision_analyze 工具

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | ✅ | 图片文件路径（PNG/JPEG/WebP/GIF） |
| `question` | ❌ | 对图片的具体问题；缺省时输出整图详细描述 |
| `model` | ❌ | 指定视觉模型 id（如 `kimi-k3`）；缺省自动选择 |
| `provider` | ❌ | LLM 提供方路由；缺省 `opencode-go` |

## 配置常量（编辑 `plugin/vision-plugin.js`）

| 常量 | 说明 |
| --- | --- |
| `DEFAULT_PROVIDER` | LLM 路由（默认 `opencode-go`） |
| `DEFAULT_MODEL` | 兜底视觉模型（默认 `qwen3.7-plus`） |
| `NATIVE_VISION_MODELS` | 原生视觉模型白名单（白名单内图片直接原生发送，不转写） |
| `MODEL_PRIORITY` | 视觉模型自动选择优先级 |

## 注意事项

- 插件是**进程内动态插件**：DSH 重启后需重新运行 `cordis_run`（`pluginId` / `packageId` 保持不变即可）；如需持久化，可将代码迁移为 host 组合中的插件行。
- 模型选择 UI 中，被 `modelOverrides` 声明的文本模型会显示"支持图片"标记——这是有意的（经过转写它确实能处理图片）。
- 转写依赖部署路由存在可用的视觉模型；若路由变更，请同步更新 `DEFAULT_PROVIDER` / `NATIVE_VISION_MODELS` / `MODEL_PRIORITY`。

## License

MIT
