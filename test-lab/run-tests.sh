#!/bin/sh
# my-agent 编排功能测试：驱动 pi 非交互模式，独立验证完成条件 C1-C5
# 用法：sh test-lab/run-tests.sh
# 注意：真实调用 DashScope 模型，消耗少量 API 额度，属预期。
set -u

BASE_DIR="/Users/apple/Program/my-agent"
LAB="$BASE_DIR/test-lab"
OUT="$LAB/out"
AGENTS_MD="/Users/apple/知识库/技能/AGENTS.md"
MODEL="dashscope/deepseek-v4-flash-0731"
SUB_TOOLS="read,bash,edit,write,grep,find,ls"
EXT="$BASE_DIR/extensions/index.ts"
REGISTRY="$HOME/.pi/agent/my-agent-sessions.json"

PASS=0; FAIL=0; SKIP=0
RESULTS=""

# 本次测试使用的 session key（带时间戳避免与历史冲突）
TS=$(date +%s)
SK_A="rv-a-$TS"

report() { # name status detail
	RESULTS="$RESULTS\n[$2] $1 — $3"
	case "$2" in
	PASS) PASS=$((PASS+1));;
	FAIL) FAIL=$((FAIL+1));;
	SKIP) SKIP=$((SKIP+1));;
	esac
	printf "[%s] %s — %s\n" "$2" "$1" "$3"
}

# run_pi <name> <ext_flag> <prompt> [extra args...]
# ext_flag: ext（加载编排扩展）/ none（不加载扩展，可跟额外 pi 参数）
run_pi() {
	name="$1"; ext_flag="$2"; prompt="$3"; shift 3
	log="$OUT/$name.jsonl"
	if [ "$ext_flag" = "ext" ]; then
		pi --mode json -p \
			--extension "$EXT" \
			--append-system-prompt "$AGENTS_MD" \
			--model "$MODEL" \
			"$prompt" >"$log" 2>"$log.err" || true
	else
		pi --mode json -p --no-extensions \
			--tools "$SUB_TOOLS" \
			--model "$MODEL" \
			"$@" \
			"$prompt" >"$log" 2>"$log.err" || true
	fi
}

# 解析 jsonl：取最后一条 assistant 文本
last_text() {
	jq -rs '
		[ .[] | select(.type=="message_end" and .message.role=="assistant")
		  | .message.content[]? | select(.type=="text") | .text
		] | last // ""
	' "$1" 2>/dev/null
}

# 判定辅助
contains() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }
not_contains() { ! contains "$1" "$2"; }

mkdir -p "$OUT"

printf "=== my-agent 编排测试开始（模型 %s）===\n" "$MODEL"

# ---------- 链路自检：裸模型可通 ----------
printf "\n[0/5] 模型链路自检\n"
run_pi link none "只回复两个字：就绪"
t=$(last_text "$OUT/link.jsonl")
if contains "$t" "就绪"; then
	report "链路自检" PASS "裸模型回复就绪"
else
	report "链路自检" FAIL "裸模型未回复就绪，后续依赖网络的用例结果存疑：$(echo "$t" | head -c 100)"
fi

# ---------- C1：系统提示含 AGENTS.md 内容 ----------
printf "\n[1/5] C1 系统提示注入\n"
run_pi c1 ext "你的系统提示里是否包含一条关于『不无条件附和用户』的规范？只回答 有 或 没有，并引用该条开头几个字。"
t=$(last_text "$OUT/c1.jsonl")
if contains "$t" "有"; then
	report "C1 系统提示注入" PASS "主智能体确认含该规范：$(echo "$t" | head -c 80)"
else
	report "C1 系统提示注入" FAIL "未确认含 AGENTS.md 内容：$(echo "$t" | head -c 120)"
fi

# ---------- C2/C4/C5：一次派生同时验证三项 ----------
printf "\n[2/5] C2 派生 + C4 身份声明 + C5 工具白名单\n"
P2="调用 spawn_agent 派生角色「验证员」，session_id 传 \"$SK_A\"，instruction 为：请完成三件事并汇总回复：1）逐字引用你收到的指令开头的身份声明原文；2）回答当前可用工具清单里是否包含 spawn_agent；3）读取 /Users/apple/Program/my-agent/test-lab/secret.txt 并回复暗号。之后原样返回子智能体的完整回复。"
run_pi c2 ext "$P2"
t=$(last_text "$OUT/c2.jsonl")
SESSION_DIR="$HOME/.pi/agent/sessions/--Users-apple-Program-my-agent--"

ok_c2=""; ok_c4=""; ok_c5=""
contains "$t" "蓝鲸-42" && ok_c2=1
contains "$t" "你是子智能体（验证员），由主智能体派生" && ok_c4=1
contains "$t" "不包含" && contains "$t" "spawn_agent" && ok_c5=1
contains "$t" "没有" && contains "$t" "spawn_agent" && ok_c5=1
contains "$t" "无 spawn_agent" && ok_c5=1
contains "$t" "spawn_agent" || true

[ -n "$ok_c2" ] \
	&& report "C2 派生+上下文独立" PASS "子智能体独立读出暗号：$(echo "$t" | head -c 80)" \
	|| report "C2 派生+上下文独立" FAIL "未见暗号：$(echo "$t" | head -c 150)"

[ -n "$ok_c4" ] \
	&& report "C4 身份声明自动注入" PASS "逐字命中模板" \
	|| report "C4 身份声明自动注入" FAIL "未逐字命中：$(echo "$t" | head -c 150)"

[ -n "$ok_c5" ] \
	&& report "C5 无 spawn_agent" PASS "子智能体确认工具清单无 spawn_agent" \
	|| report "C5 无 spawn_agent" FAIL "未能确认：$(echo "$t" | head -c 150)"

# ---------- C3：同一 session_id 续聊 ----------
printf "\n[3/5] C3 续聊\n"
# 第二轮先追加一句上下文，第三轮再追问
P3a="调用 spawn_agent 派生角色「验证员」，session_id 传 \"$SK_A\"，instruction 为：请记住以下事实并复述它：暗号已在上轮读取。之后原样返回子智能体的完整回复。"
run_pi c3a ext "$P3a"

P3b="调用 spawn_agent 派生角色「验证员」，session_id 传 \"$SK_A\"，instruction 为：暗号是什么？这句暗号在当前会话里是哪一轮被读取的？之后原样返回子智能体的完整回复。"
run_pi c3b ext "$P3b"
t3=$(last_text "$OUT/c3b.jsonl")
ok_c3=""
contains "$t3" "蓝鲸-42" && ok_c3=1
# 轮次计数 >=3 更稳：t 是三轮总计
TURNS=$(jq -r --arg k "$SK_A" '.[$k].turns // 0' "$REGISTRY" 2>/dev/null)
TURNS="${TURNS:-0}"
if [ -n "$ok_c3" ]; then
	report "C3 续聊" PASS "第三轮答出暗号，注册表 turns=$TURNS"
else
	report "C3 续聊" FAIL "第三轮未答出：$(echo "$t3" | head -c 150)（turns=$TURNS）"
fi

# ---------- 注册表持久化 ----------
printf "\n[4/5] 注册表持久化\n"
REG_OK=""
if jq -e --arg k "$SK_A" '.[$k] | select(.turns >= 3 and .sessionId != null and .role == "验证员")' "$REGISTRY" >/dev/null 2>&1; then
	REG_OK=1
fi
[ -n "$REG_OK" ] \
	&& report "注册表落盘" PASS "$REGISTRY 中 $SK_A turns>=3 且元数据完整" \
	|| report "注册表落盘" FAIL "$REGISTRY 中无 $SK_A 完整记录（turns=$TURNS）"

# ---------- C6：技能加载（pi 原生技能发现，含 symlink） ----------
printf "\n[5/5] C6 技能加载\n"

# C6a：对照组 —— --no-skills 禁用发现后应无技能区块
run_pi c6a none "列出你系统提示里 <available_skills> 中的所有技能 name（用逗号分隔，只回名称，不要别的）。如果系统提示里没有 <available_skills> 区块，只回复：无" --no-skills
t=$(last_text "$OUT/c6a.jsonl")
if contains "$t" "无" && not_contains "$t" "code-cluster"; then
	report "C6a 对照组（--no-skills）" PASS "禁用发现后回复无技能区块：$(echo "$t" | head -c 60)"
else
	report "C6a 对照组（--no-skills）" FAIL "禁用发现后仍列出技能：$(echo "$t" | head -c 100)"
fi

# C6b：实验组 —— 默认发现应列出全部 6 个技能（symlink 目录）
run_pi c6b ext "列出你系统提示里 <available_skills> 中的所有技能 name（用逗号分隔，只回名称，不要别的）。如果系统提示里没有 <available_skills> 区块，只回复：无"
t=$(last_text "$OUT/c6b.jsonl")
MISSING=""
for s in code-cluster coder-role doc-manager humanizer-zh parallel-dispatch reviewer-role; do
	contains "$t" "$s" || MISSING="$MISSING $s"
done
if [ -z "$MISSING" ]; then
	report "C6b 技能发现（symlink）" PASS "6 个技能全部列出：$(echo "$t" | head -c 90)"
else
	report "C6b 技能发现（symlink）" FAIL "缺失技能：$MISSING；回复：$(echo "$t" | head -c 100)"
fi

# C6c：内容级 —— 让模型 read 一个 SKILL.md，断言 read 工具调用路径与内容
run_pi c6c ext "用 read 工具读取 coder-role 技能的 SKILL.md，然后只回复该文件 frontmatter 里 description 字段的前 10 个字。"
t=$(last_text "$OUT/c6c.jsonl")
TOOLPATH=$(jq -rs '[.. | objects | select(.type?=="toolcall_end") | .. | .path? // empty] | .[0] // ""' "$OUT/c6c.jsonl" 2>/dev/null)
TOOLPATH="${TOOLPATH:-}"
ok_path=""; ok_content=""
contains "$TOOLPATH" "/.agents/skills/coder-role/SKILL.md" && ok_path=1
contains "$t" "编码修复" && ok_content=1
if [ -n "$ok_path" ] && [ -n "$ok_content" ]; then
	report "C6c 技能内容读取" PASS "read 路径命中且内容正确"
else
	report "C6c 技能内容读取" FAIL "path_ok=${ok_path:-0} content_ok=${ok_content:-0}"
fi

# ---------- 汇总 ----------
printf "\n=== 汇总 ===\n"
printf "PASS=%d FAIL=%d SKIP=%d\n" "$PASS" "$FAIL" "$SKIP"
printf "%b\n" "$RESULTS" > "$OUT/results.txt"
printf "\n原始日志目录：%s\n" "$OUT"
[ "$FAIL" -eq 0 ]
