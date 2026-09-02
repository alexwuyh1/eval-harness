# my-agent

pi CLI 的多智能体编排扩展：给 pi 加上派生子智能体（身份声明自动注入）、session 续聊、任务池调度基础，让规范+技能体系脱离 Zed 独立运行。

## 怎么跑

前置依赖：pi CLI（@earendil-works/pi-coding-agent）；DashScope API key 在 ~/.zshenv 的 `DASHSCOPE_PROGRAM_KEY`；模型端点走 DashScope OpenAI 兼容模式。

启动：`pi`（交互式）；非交互用 `pi -p "任务"`。规范、技能、扩展、默认模型全部常驻在 `~/.pi/agent/` 和 `~/.agents/skills/` 的 symlink 上，无需启动参数。

## 目录结构

```
my-agent/
├── models.json        # 模型与端点配置（改模型/换端点/调上下文窗口改这里；apiKey 只含 $ENV 引用，真值不落盘）
├── extensions/        # 编排机制层：spawn_agent、续聊、身份声明注入（改编排能力改这里）
└── test-lab/          # 自测素材
```

规则层（规范/技能）不在本仓库：在知识库，经 symlink 常驻到 `~/.pi/agent/` 和 `~/.agents/skills/`。改流程规则去知识库改，改完 Zed 和 pi 同时生效。
