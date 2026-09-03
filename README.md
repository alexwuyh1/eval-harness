# my-agent

pi CLI 的多智能体编排扩展：给 pi 加上派生子智能体（身份声明自动注入）、session 续聊、任务池调度基础，让规范+技能体系脱离 Zed 独立运行。同一套编排代码也支撑模型评测（裸跑模式）。

## 怎么跑

前置依赖：pi CLI（@earendil-works/pi-coding-agent）；DashScope API key 在 ~/.zshenv 的 `DASHSCOPE_CODING_KEY`；模型端点走 DashScope OpenAI 兼容模式。

启动：
- 前端可视化：`cd view && bun run dev`（同时起后端 API + Vite dev，浏览器开 localhost:5173）
- 交互式：`pi`（加载编排扩展+AGENTS+技能）
- 评测框架：`npm run eval` 或 `node probe/eval.mjs [--mode standard] [--difficulty easy|medium|hard] [--question-id <id>]`
- 旧探针：`npm run probe`（API 层性能基线）

规范、技能、扩展、models.json 全部常驻在 `~/.pi/agent/` 和 `~/.agents/skills/` 的 symlink 上，无需启动参数。

## 目录结构

```
my-agent/
├── models.json        # 模型+端点+价格配置（改模型/换端点/调价格改这里；apiKey 只含 $ENV 引用，真值不落盘）
├── package.json       # 顶层 script（eval/probe）
├── extensions/        # 编排机制层：spawn_agent、续聊、身份声明注入（改编排能力改 index.ts）
├── probe/
│   ├── eval.mjs       # P1.1 统一评测框架（pi CLI 驱动，多模型并行，采集指标+执行测试用例+评分）
│   ├── eval.config.json # 测试参数（权重/惩罚/超时/难度/标准模式，调参不改代码）
│   ├── probe.mjs      # 旧探针（HTTP 流式，API 层性能基线）
│   ├── datasets/      # 数据集（humaneval/livecodebench，首次运行自动下载，gitignore）
│   └── results/       # 测试产物 JSONL（累积，gitignore）
├── view/              # P3 前端可视化（bun+Vite+UnoCSS+Preact）
├── models-archive.json # 放弃用模型归档（无权限，开通后取回 models.json）
└── test-lab/          # P0 编排自测沙盒（run-tests.sh 验证 C1-C6）
```

规则层（规范/技能）不在本仓库：在知识库，经 symlink 常驻到 `~/.pi/agent/` 和 `~/.agents/skills/`。改流程规则去知识库改，改完 Zed 和 pi 同时生效。
