#!/bin/sh
# my-agent 一行启动：加载编排扩展、注入团队 AGENTS.md，默认走 DashScope 模型
# 用法：my-agent            （交互）
#       my-agent -p "..."   （非交互）
set -eu

# 取密钥：优先用当前环境变量；缺失时从 zshrc 兜底提取（只进环境，不落盘）
if [ -z "${DASHSCOPE_PROGRAM_KEY:-}" ]; then
	key=$(sed -n 's/^export DASHSCOPE_PROGRAM_KEY="\(.*\)"/\1/p' "$HOME/.zshrc" | tail -1)
	if [ -n "$key" ]; then
		export DASHSCOPE_PROGRAM_KEY="$key"
	else
		echo "缺少 DASHSCOPE_PROGRAM_KEY（未在环境中，也未在 ~/.zshrc 配置）" >&2
		exit 1
	fi
fi

exec pi \
	--extension /Users/apple/Program/my-agent/extensions/index.ts \
	--append-system-prompt /Users/apple/知识库/技能/AGENTS.md \
	--model dashscope/deepseek-v4-flash-0731 \
	"$@"
