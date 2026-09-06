# my-agent

pi 驱动的模型智能体评测框架：HumanEval+ 多轮对话评测，二维评分（功能正确性 + 健壮性），支持任意模型 × 智能体形态矩阵。

## 1 怎么跑

前置依赖：pi CLI（@earendil-works/pi-coding-agent）；DashScope API key 在 ~/.zshenv 的 `DASHSCOPE_CODING_KEY`。

启动：`node probe/eval.mjs [选项]`

访问：无 web 界面（终端汇总表 + JSONL）；前端可视化在 `view/`（`cd view && bun run dev`，访问 http://localhost:5173）

## 2 目录结构

```
my-agent/
├── models.json        # 模型+端点+价格配置（改模型/换端点/调价格改这里；apiKey 只含 $ENV 引用，真值不落盘）
├── package.json       # 顶层 script（eval）
├── probe/
│   ├── eval.mjs       # 评测框架（pi RPC 多轮对话：发题→agent 出码→跑 base/plus 测试→未全通过反馈→agent 修正，最多 maxTurns 轮）
│   ├── eval.config.json # 测试参数（agentProfiles/models/thinking/maxTurns/二维评分权重/超时，调参不改代码）
│   ├── datasets/      # HumanEval+ 数据集（humanevalplus/humanevalplus.jsonl，含 baseTest+test，gitignore）
│   └── results/       # 测试产物 JSONL（累积，按 batchId 区分批次，gitignore）
├── view/              # P3 前端可视化（bun+Vite+UnoCSS+Preact）
└── models-archive.json # 放弃用模型归档（无权限，开通后取回 models.json）
```

评测对象矩阵 = `agentProfiles × models`（config 驱动）。CLI 可限定子集：`--profile bare,harness --model glm-5.2-fast-preview,deepseek-v4-flash-0731`。

评分二维：E₁（功能正确性，base test 通过 100/0）+ E₂（健壮性，plus test 通过 100/0），加权合成 E；T（速度）/C（成本）用参测单元中位数基线，单单元参测时置 null。

规则层（规范/技能）不在本仓库：在知识库，经 symlink 常驻到 `~/.pi/agent/` 和 `~/.agents/skills/`。改流程规则去知识库改，改完 Zed 和 pi 同时生效。
