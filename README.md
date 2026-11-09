# dsh-intl-models

DeepSeek Harness 的国际模型插件，支持 OpenAI、Anthropic Claude、xAI Grok、OpenRouter、OpenCode（Zen / Go）、Google Gemini、Cloudflare Workers AI、Vercel AI Gateway，以及开源模型平台 Groq、DeepInfra、Novita、Hugging Face、NVIDIA。

## 功能

- 每个接入点可放多个 API Key，显示是否可用、余额、今日与本月的用量和花费
- 余额不足、额度用尽或 Key 无效时，自动换到下一个 Key
- OpenRouter、Vercel、Novita 显示余额；OpenCode Go 显示 5 小时、每周、每月额度
- 每个模型走自己的协议（Responses、Messages、Chat Completions、Gemini）
- 推理强度、工具调用、思考内容回传、Claude 提示缓存；思考签名只回传给生成它的 Key
- 请求体超限（413）时自动替换旧图片或压缩上下文，最大输出按上下文大小设置，自动压缩按时触发
- 标出 DeepSeek Harness 不支持在对话中途切换到的模型（「切换受限」）
- 按平台分标签管理，可隐藏不用的平台

## 安装

需要 Node.js 24.9 或更高版本（DeepSeek Harness 0.2.2 的最低要求）。

```bash
git clone https://github.com/JioJioStudio404/dsh-intl-models.git
dsh plugin --profile desktop add "/path/to/dsh-intl-models"
```

安装后重启 DeepSeek Harness。

## 许可证

MIT
