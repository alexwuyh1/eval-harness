/**
 * my-agent 编排扩展
 *
 * 为 pi 增加 spawn_agent 工具：派生独立上下文的子智能体，支持按 session_id 续聊。
 *
 * 设计：
 * - 子智能体 = 独立 pi 子进程（`pi --mode json -p`），天然隔离上下文、工具与持久化。
 * - 身份声明由本工具在派生指令开头逐字自动注入，主智能体无需手写。
 * - 续聊复用 pi 原生 session：`--session-id <id>`（不存在则建、存在则续），pi 重启后仍可续。
 * - 子智能体不含 spawn_agent（子进程不加载本扩展，代码级硬约束，非文本约定）。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 身份声明前缀（逐字），<角色名> 由 role 参数替换 */
const IDENTITY_TEMPLATE =
	"你是子智能体（{role}），由主智能体派生，只做指令内的任务并返回结果；你不是主智能体，不能再派生子智能体";

/** 子智能体可用的内建工具（无 spawn_agent，无法二次派生） */
const SUBAGENT_TOOLS = "read,bash,edit,write,grep,find,ls";

const DEFAULT_MODEL = "dashscope/deepseek-v4-flash-0731";

const TOOL_DESCRIPTION = [
	"派生一个独立上下文的子智能体执行指令并返回其最终回复。",
	"子智能体是全新的会话：看不到当前对话历史，也拿不到 spawn_agent 工具（不能再次派生）。",
	"指令开头会自动注入身份声明，无需手写。",
	"传 session_id 可在同一子智能体上多轮续聊（首次自动建档，跨重启可续）。",
].join("");

const parameters = Type.Object({
	role: Type.String({ description: "子智能体角色名，注入身份声明，如：编码修复、评审" }),
	instruction: Type.String({ description: "派生指令正文（身份声明会自动加在最前面，不要自己写）" }),
	session_id: Type.Optional(
		Type.String({
			description: "子智能体会话 id；传同一 id 即在该会话上续聊，省略则新建一次性会话",
		}),
	),
	model: Type.Optional(
		Type.String({ description: `覆盖模型（provider/id），默认 ${DEFAULT_MODEL}` }),
	),
});

interface SessionRecord {
	sessionId: string;
	role: string;
	model: string;
	createdAt: string;
	turns: number;
}

type Registry = Record<string, SessionRecord>;

/** pi 会话目录名规则：cwd 中的 "/" 替换为 "-"，前缀 "--" */
function sessionDirFor(cwd: string): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions", `--${cwd.replace(/\//g, "-")}`);
}

/** 从 session 文件回读最后一条 assistant 文本（兑底用） */
function readLastAssistantText(cwd: string, sessionId: string): string {
	try {
		const dir = sessionDirFor(cwd);
		const file = fs
			.readdirSync(dir)
			.filter((f) => f.includes(sessionId) && f.endsWith(".jsonl"))
			.sort()
			.pop();
		if (!file) return "";
		const lines = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			let entry: any;
			try {
				entry = JSON.parse(lines[i]);
			} catch {
				continue;
			}
			const msg = entry?.message;
			if ((entry?.type === "message" || entry?.type === "session_message") && msg?.role === "assistant") {
				const texts = (msg.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text as string);
				if (texts.length > 0) return texts.join("");
			}
		}
	} catch {
		/* 目录不存在等情况静默 */
	}
	return ""
}

export default function (pi: ExtensionAPI) {
	const registryFile = path.join(os.homedir(), ".pi", "agent", "my-agent-sessions.json");

	const loadRegistry = (): Registry => {
		try {
			return JSON.parse(fs.readFileSync(registryFile, "utf8")) as Registry;
		} catch {
			return {};
		}
	};

	const saveRegistry = (registry: Registry) => {
		fs.mkdirSync(path.dirname(registryFile), { recursive: true });
		fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), "utf8");
	};

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: TOOL_DESCRIPTION,
		promptSnippet: "派生独立上下文的子智能体执行指令，支持按 session_id 续聊",
		promptGuidelines: [
			"用 spawn_agent 派生子智能体处理需要独立上下文的任务；它会自动在指令开头注入身份声明，instruction 里不要重复写身份声明。",
			"要在同一子智能体上续聊时，给 spawn_agent 传相同的 session_id。",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = params.model ?? DEFAULT_MODEL;
			const instruction = params.instruction.trim();
			const prompt = `${IDENTITY_TEMPLATE.replace("{role}", params.role)}\n\n${instruction}`;

			const registry = loadRegistry();
			const requestedId = params.session_id?.trim();
			const record = requestedId ? registry[requestedId] : undefined;
			const isContinuation = Boolean(record);
			const sessionId = record?.sessionId ?? crypto.randomUUID();

			const args: string[] = [
				"--mode", "json",
				"-p",
				"--session-id", sessionId,
				"--no-extensions",
				"--tools", SUBAGENT_TOOLS,
				"--model", model,
				prompt,
			];

			const progress: string[] = [];
			const emitUpdate = () => {
				onUpdate?.({
					content: [{ type: "text", text: progress.join("") || "(子智能体运行中...)" }],
					details: {},
				});
			};

			const run = new Promise<{ code: number; finalText: string; stderrTail: string }>((resolve) => {
				// 父 pi 会向环境写入 PI_SESSION_FILE / PI_SESSION_ID 等变量；
				// 子进程若继承会复用父会话句柄而直接空跑。剥离全部 PI_SESSION_* 再 spawn。
				const env = Object.fromEntries(
					Object.entries(process.env).filter(([k]) => !k.startsWith("PI_SESSION")),
				);
				const proc = spawn("pi", args, {
					cwd: ctx.cwd,
					env,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let buffer = "";
				let finalText = "";
				let stderrTail = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						progress.push(event.assistantMessageEvent.delta as string);
						emitUpdate();
					}
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const texts = (event.message.content ?? [])
							.filter((c: any) => c?.type === "text")
							.map((c: any) => c.text as string);
						if (texts.length > 0) finalText = texts.join("");
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data) => {
					stderrTail = (stderrTail + data.toString()).slice(-4000);
				});

				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					resolve({ code: code ?? 0, finalText, stderrTail });
				});

				proc.on("error", (err) => {
					resolve({ code: 1, finalText: "", stderrTail: String(err) });
				});

				if (signal) {
					const kill = () => proc.kill("SIGTERM");
					if (signal.aborted) kill();
					else signal.addEventListener("abort", kill, { once: true });
				}
			});

			let { code, finalText, stderrTail } = await run;

			// 兕底：若 stdout 未捕获到最终文本（异常退出/缓冲丢失），从 pi 落盘的 session 文件回读最后一条 assistant 文本
			if (!finalText) {
				const recovered = readLastAssistantText(ctx.cwd, sessionId);
				if (recovered) finalText = recovered;
			}

			if (code !== 0 && !finalText) {
				return {
					content: [{ type: "text", text: `子智能体进程退出码 ${code}。stderr 尾部：\n${stderrTail || "(无)"}` }],
					details: { sessionId, exitCode: code },
					isError: true,
				};
			}

			// 运行成功才登记/累加轮次
			const next: SessionRecord = {
				sessionId,
				role: params.role,
				model,
				createdAt: record?.createdAt ?? new Date().toISOString(),
				turns: (record?.turns ?? 0) + 1,
			};
			registry[requestedId ?? sessionId] = next;
			if (requestedId && requestedId !== sessionId) {
				// 允许首次调用时自定义可读 id；建档后统一以该 id 为键
				delete registry[sessionId];
			}
			saveRegistry(registry);

			const state = isContinuation ? `续聊第 ${next.turns} 轮` : "新会话第 1 轮";
			const header = `[子智能体 ${params.role} | session ${requestedId ?? sessionId} | ${state}]\n\n`;
			return {
				content: [{ type: "text", text: header + (finalText || "(子智能体无文本回复)") }],
				details: { sessionId, continued: isContinuation, turns: next.turns },
			};
		},
	});

	// 观察命令：查看已登记的子智能体会话
	pi.registerCommand("spawned", {
		description: "列出本扩展登记的子智能体会话（session_id → 轮次/角色/模型）",
		handler: async (_args, cmdCtx) => {
			const registry = loadRegistry();
			const keys = Object.keys(registry);
			if (keys.length === 0) {
				cmdCtx.ui.notify("尚无登记的子智能体会话", "info");
				return;
			}
			const lines = keys.map((k) => {
				const r = registry[k];
				return `${k} → ${r.role} | ${r.turns} 轮 | ${r.model}`;
			});
			cmdCtx.ui.notify(lines.join("\n"), "info");
		},
	});
}
