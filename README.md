# my-agent

pi CLI 的多智能体编排扩展：给 pi 加上派生子智能体（身份声明自动注入）、session 续聊、任务池调度基础，让规范+技能体系脱离 Zed 独立运行。

## 怎么跑

前置依赖：pi CLI（@earendil-works/pi-coding-agent）；DashScope API key 在 ~/.zshenv 的 `DASHSCOPE_PROGRAM_KEY`；模型端点走 DashScope OpenAI 兼容模式。

启动：`pi`（交互式）；非交互用 `pi -p "任务"`。规范、技能、扩展、默认模型全部常驻在 `~/.pi/agent/` 和 `~/.agents/skills/` 的 symlink 上，无需启动参数。

## 目录结构

```
my-agent/
├── models.json        # DashScope provider 配置（apiKey 只含 $ENV 引用，真值不落盘）
├── extensions/        # 编排扩展（spawn_agent 工具 + /spawned 命令 + session 注册表）
└── test-lab/          # 自测素材
```

扩展经 `~/.pi/agent/extensions/my-agent` symlink 被 pi 全局自动发现。
