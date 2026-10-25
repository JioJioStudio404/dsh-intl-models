# dsh-intl-models

DeepSeek Harness 的国际模型插件，支持 OpenAI、Anthropic Claude、xAI Grok、OpenRouter、OpenCode、Google Gemini、Cloudflare Workers AI、Vercel AI Gateway。

## 功能

- 每个接入点可放多个 API Key，显示是否可用、余额、今日与本月的用量和花费
- 余额不足、额度用尽或 Key 无效时，自动换到下一个 Key
- 每个模型走自己的协议（Responses、Messages、Chat Completions、Gemini）
- 推理强度、工具调用、思考内容回传、Claude 提示缓存
- 按平台分标签管理，可隐藏不用的平台

## 安装

```bash
git clone https://github.com/JioJioStudio404/dsh-intl-models.git
dsh plugin --profile desktop add "/path/to/dsh-intl-models"
```

安装后重启 DeepSeek Harness。

## 许可证

MIT
