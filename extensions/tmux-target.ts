import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface PaneInfo {
	sessionName: string;
	windowIndex: string;
	windowId: string;
	windowName: string;
	paneIndex: string;
	paneId: string;
	paneTitle: string;
	currentCommand: string;
	currentPath: string;
	isActive: boolean;
}

interface PaneOption {
	pane: PaneInfo;
	preview: string;
	label: string;
}

interface PersistedState {
	version: 4;
	trackedPaneIds: string[];
	knownPanes: PaneInfo[];
}

type PaneScope = "current" | "all" | "tracked";

interface PaneBrowserResult {
	trackedPaneIds: string[];
	cancelled: boolean;
}

interface CurrentPaneContext {
	paneId: string;
	windowId: string;
}

type AsyncJobStatus = "running" | "success" | "error" | "cancelled";

interface AsyncJobRecord {
	version: 1;
	jobId: string;
	name: string;
	task: string;
	status: AsyncJobStatus;
	paneId?: string;
	createdAt: string;
	doneAt?: string;
	cwd: string;
	parentSessionFile: string | null;
	autoKillOnDone: boolean;
	trackPane: boolean;
	callbackSent: boolean;
	logPath: string;
	stderrPath: string;
	donePath: string;
	scriptPath: string;
	taskPath: string;
	model?: string;
	tools?: string;
}

interface AsyncDoneRecord {
	jobId: string;
	paneId?: string;
	status: "success" | "error" | "cancelled";
	exitCode: number;
	finishedAt: string;
}

const TMUX_TARGET_ENTRY_TYPE = "tmux-target";
const TMUX_JOBS_DIR = path.join(getAgentDir(), "tmux-target-jobs");
const TMUX_JOBS_META_DIR = path.join(TMUX_JOBS_DIR, "jobs");
const TMUX_JOBS_TASKS_DIR = path.join(TMUX_JOBS_DIR, "tasks");
const TMUX_JOBS_LOGS_DIR = path.join(TMUX_JOBS_DIR, "logs");
const TMUX_JOBS_SCRIPTS_DIR = path.join(TMUX_JOBS_DIR, "scripts");
const TMUX_LIST_FORMAT =
	"#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_active}";

function inTmux(): boolean {
	return typeof process.env.TMUX === "string" && process.env.TMUX.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseRegex(raw: string): RegExp {
	const trimmed = raw.trim();
	const slashMatch = trimmed.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
	if (slashMatch) {
		return new RegExp(slashMatch[1], slashMatch[2]);
	}
	return new RegExp(trimmed, "i");
}

function ensureDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function ensureJobsDirs(): void {
	ensureDir(TMUX_JOBS_DIR);
	ensureDir(TMUX_JOBS_META_DIR);
	ensureDir(TMUX_JOBS_TASKS_DIR);
	ensureDir(TMUX_JOBS_LOGS_DIR);
	ensureDir(TMUX_JOBS_SCRIPTS_DIR);
}

function makeJobId(): string {
	return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
	const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	fs.renameSync(tmpPath, filePath);
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function parseAsyncJobRecord(data: unknown): AsyncJobRecord | undefined {
	if (!isRecord(data)) return undefined;
	if (data.version !== 1) return undefined;
	if (typeof data.jobId !== "string") return undefined;
	if (typeof data.name !== "string") return undefined;
	if (typeof data.task !== "string") return undefined;
	if (typeof data.status !== "string") return undefined;
	if (typeof data.createdAt !== "string") return undefined;
	if (typeof data.cwd !== "string") return undefined;
	if (typeof data.parentSessionFile !== "string" && data.parentSessionFile !== null) return undefined;
	if (typeof data.autoKillOnDone !== "boolean") return undefined;
	if (typeof data.trackPane !== "boolean" && data.trackPane !== undefined) return undefined;
	if (typeof data.callbackSent !== "boolean") return undefined;
	if (typeof data.logPath !== "string") return undefined;
	if (typeof data.stderrPath !== "string") return undefined;
	if (typeof data.donePath !== "string") return undefined;
	if (typeof data.scriptPath !== "string") return undefined;
	if (typeof data.taskPath !== "string") return undefined;

	const status = data.status as AsyncJobStatus;
	if (status !== "running" && status !== "success" && status !== "error" && status !== "cancelled") return undefined;

	return {
		version: 1,
		jobId: data.jobId,
		name: data.name,
		task: data.task,
		status,
		paneId: typeof data.paneId === "string" ? data.paneId : undefined,
		createdAt: data.createdAt,
		doneAt: typeof data.doneAt === "string" ? data.doneAt : undefined,
		cwd: data.cwd,
		parentSessionFile: data.parentSessionFile,
		autoKillOnDone: data.autoKillOnDone,
		trackPane: typeof data.trackPane === "boolean" ? data.trackPane : true,
		callbackSent: data.callbackSent,
		logPath: data.logPath,
		stderrPath: data.stderrPath,
		donePath: data.donePath,
		scriptPath: data.scriptPath,
		taskPath: data.taskPath,
		model: typeof data.model === "string" ? data.model : undefined,
		tools: typeof data.tools === "string" ? data.tools : undefined,
	};
}

function listAsyncJobs(): AsyncJobRecord[] {
	ensureJobsDirs();
	const jobs: AsyncJobRecord[] = [];
	for (const fileName of fs.readdirSync(TMUX_JOBS_META_DIR)) {
		if (!fileName.endsWith(".job.json")) continue;
		const parsed = parseAsyncJobRecord(readJsonFile(path.join(TMUX_JOBS_META_DIR, fileName)));
		if (parsed) jobs.push(parsed);
	}
	jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	return jobs;
}

function jobMetaPath(jobId: string): string {
	return path.join(TMUX_JOBS_META_DIR, `${jobId}.job.json`);
}

function updateJobMeta(job: AsyncJobRecord): void {
	writeJsonAtomic(jobMetaPath(job.jobId), job);
}

function getAssistantTextFromMessage(message: unknown): string {
	if (!isRecord(message)) return "";
	if (message.role !== "assistant") return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
			return part.text.trim();
		}
	}
	return "";
}

function summarizeJsonLog(logPath: string): { finalOutput: string; progress: string } {
	if (!fs.existsSync(logPath)) return { finalOutput: "", progress: "No log yet" };
	try {
		const raw = fs.readFileSync(logPath, "utf-8");
		const lines = raw
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		let finalOutput = "";
		let progress = "Working...";
		for (const line of lines.slice(-600)) {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(event)) continue;
			if (event.type === "tool_execution_start") {
				progress = `Running tool: ${typeof event.toolName === "string" ? event.toolName : "unknown"}`;
			}
			if (event.type === "tool_execution_end") {
				progress = `Finished tool: ${typeof event.toolName === "string" ? event.toolName : "unknown"}`;
			}
			if (event.type === "message_end") {
				const text = getAssistantTextFromMessage(event.message);
				if (text.length > 0) {
					finalOutput = text;
					progress = truncate(text.replace(/\s+/g, " "), 120);
				}
			}
		}
		return { finalOutput, progress };
	} catch {
		return { finalOutput: "", progress: "Unable to read log" };
	}
}

function readTail(filePath: string, lines = 12): string {
	if (!fs.existsSync(filePath)) return "";
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return raw
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.slice(-lines)
			.join("\n");
	} catch {
		return "";
	}
}

function buildJsonPaneFormatterScript(): string {
	return [
		"#!/usr/bin/env node",
		"const readline = require(\"node:readline\");",
		"",
		"function isRecord(value) {",
		"\treturn typeof value === \"object\" && value !== null;",
		"}",
		"",
		"function truncate(text, max) {",
		"\tif (typeof text !== \"string\") return \"\";",
		"\tif (text.length <= max) return text;",
		"\tif (max <= 1) return \"…\";",
		"\treturn text.slice(0, max - 1) + \"…\";",
		"}",
		"",
		"function getAssistantText(message) {",
		"\tif (!isRecord(message)) return \"\";",
		"\tif (message.role !== \"assistant\") return \"\";",
		"\tif (!Array.isArray(message.content)) return \"\";",
		"\tfor (const part of message.content) {",
		"\t\tif (isRecord(part) && part.type === \"text\" && typeof part.text === \"string\" && part.text.trim().length > 0) {",
		"\t\t\treturn part.text.trim();",
		"\t\t}",
		"\t}",
		"\treturn \"\";",
		"}",
		"",
		"const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
		"rl.on(\"line\", (line) => {",
		"\tconst trimmed = line.trim();",
		"\tif (!trimmed) return;",
		"\tlet event;",
		"\ttry {",
		"\t\tevent = JSON.parse(trimmed);",
		"\t} catch {",
		"\t\treturn;",
		"\t}",
		"\tif (!isRecord(event)) return;",
		"",
		"\tif (event.type === \"tool_execution_start\") {",
		"\t\tconst toolName = typeof event.toolName === \"string\" ? event.toolName : \"unknown\";",
		"\t\tlet args = \"\";",
		"\t\tif (isRecord(event.args)) {",
		"\t\t\ttry {",
		"\t\t\t\targs = JSON.stringify(event.args);",
		"\t\t\t} catch {}",
		"\t\t}",
		"\t\tconst suffix = args ? \" \" + truncate(args, 110) : \"\";",
		"\t\tconsole.log(\"→ \" + toolName + suffix);",
		"\t\treturn;",
		"\t}",
		"",
		"\tif (event.type === \"tool_execution_end\") {",
		"\t\tconst toolName = typeof event.toolName === \"string\" ? event.toolName : \"unknown\";",
		"\t\tconsole.log(\"✓ \" + toolName);",
		"\t\treturn;",
		"\t}",
		"",
		"\tif (event.type === \"message_end\") {",
		"\t\tconst text = getAssistantText(event.message);",
		"\t\tif (text.length > 0) {",
		"\t\t\tconsole.log(\"\");",
		"\t\t\tconsole.log(text);",
		"\t\t\tconsole.log(\"\");",
		"\t\t}",
		"\t}",
		"});",
	].join("\n");
}

function buildAsyncWorkerScript(args: {
	jobId: string;
	taskPath: string;
	logPath: string;
	stderrPath: string;
	donePath: string;
	formatterPath: string;
	model?: string;
	tools?: string;
	keepPaneAlive: boolean;
}): string {
	return `#!/usr/bin/env bash
set +e
JOB_ID=${shellQuote(args.jobId)}
TASK_PATH=${shellQuote(args.taskPath)}
LOG_PATH=${shellQuote(args.logPath)}
STDERR_PATH=${shellQuote(args.stderrPath)}
DONE_PATH=${shellQuote(args.donePath)}
FORMATTER_PATH=${shellQuote(args.formatterPath)}
MODEL=${shellQuote(args.model ?? "")}
TOOLS=${shellQuote(args.tools ?? "")}
KEEP_PANE_ALIVE=${shellQuote(args.keepPaneAlive ? "1" : "")}

TASK_CONTENT="$(cat "$TASK_PATH")"
CMD_ARGS=(--mode json -p --no-session)
if [ -n "$MODEL" ]; then
  CMD_ARGS+=(--model "$MODEL")
fi
if [ -n "$TOOLS" ]; then
  CMD_ARGS+=(--tools "$TOOLS")
fi

pi "\${CMD_ARGS[@]}" "$TASK_CONTENT" > >(tee "$LOG_PATH" >(node "$FORMATTER_PATH") >/dev/null) 2> >(tee "$STDERR_PATH" >&2)
EXIT_CODE=$?
STATUS="error"
if [ "$EXIT_CODE" -eq 0 ]; then
  STATUS="success"
fi
FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PANE_ID="\${TMUX_PANE:-unknown}"
TMP_PATH="\${DONE_PATH}.tmp"
cat >"$TMP_PATH" <<JSON
{"jobId":"$JOB_ID","paneId":"$PANE_ID","status":"$STATUS","exitCode":$EXIT_CODE,"finishedAt":"$FINISHED_AT"}
JSON
mv "$TMP_PATH" "$DONE_PATH"

if [ -n "$KEEP_PANE_ALIVE" ]; then
  echo ""
  echo "[tmux-subagent] Job $JOB_ID finished with status=$STATUS exit=$EXIT_CODE"
  echo "[tmux-subagent] Pane kept alive (autoKillOnDone=false). Type 'exit' to close."
  exec "\${SHELL:-bash}" -i
fi

exit "$EXIT_CODE"
`;
}

function parsePaneLine(line: string): PaneInfo | undefined {
	const parts = line.split("\t");
	if (parts.length < 10) return undefined;

	return {
		sessionName: parts[0],
		windowIndex: parts[1],
		windowId: parts[2],
		windowName: parts[3],
		paneIndex: parts[4],
		paneId: parts[5],
		paneTitle: parts[6],
		currentCommand: parts[7],
		currentPath: parts[8],
		isActive: parts[9] === "1",
	};
}

function paneIdentifier(pane: PaneInfo): string {
	return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
}

function paneLabel(pane: PaneInfo): string {
	const active = pane.isActive ? "*" : " ";
	const ident = paneIdentifier(pane);
	const command = truncate(pane.currentCommand || "-", 20);
	const title = truncate(pane.paneTitle || "-", 16);
	return `${active} ${ident} ${pane.paneId} win=${pane.windowId} cmd=${command} title=${title}`;
}

function paneSearchText(pane: PaneInfo, preview: string): string {
	return [
		pane.sessionName,
		pane.windowIndex,
		pane.windowId,
		pane.windowName,
		pane.paneIndex,
		pane.paneId,
		pane.paneTitle,
		pane.currentCommand,
		pane.currentPath,
		preview,
		`${pane.windowIndex}.${pane.paneIndex}`,
		`${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`,
	]
		.join(" ")
		.toLowerCase();
}

function parsePersistedState(data: unknown): PersistedState | undefined {
	if (!isRecord(data)) return undefined;
	const version = data.version;
	if (version !== 3 && version !== 4) return undefined;
	if (!Array.isArray(data.trackedPaneIds) || !Array.isArray(data.knownPanes)) return undefined;

	const trackedPaneIds = data.trackedPaneIds.filter((value): value is string => typeof value === "string");
	const knownPanes: PaneInfo[] = [];

	for (const item of data.knownPanes) {
		if (!isRecord(item)) continue;
		const parsed = parsePaneLine(
			[
				item.sessionName,
				item.windowIndex,
				item.windowId,
				item.windowName,
				item.paneIndex,
				item.paneId,
				item.paneTitle,
				item.currentCommand,
				item.currentPath,
				item.isActive ? "1" : "0",
			].join("\t"),
		);
		if (parsed) knownPanes.push(parsed);
	}

	return {
		version: 4,
		trackedPaneIds,
		knownPanes,
	};
}

async function runTmux(pi: ExtensionAPI, args: string[], timeout = 3000): Promise<string> {
	const result = await pi.exec("tmux", args, { timeout });
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		throw new Error(stderr.length > 0 ? stderr : `tmux ${args.join(" ")} failed`);
	}
	return result.stdout;
}

async function listPanes(pi: ExtensionAPI): Promise<PaneInfo[]> {
	const output = await runTmux(pi, ["list-panes", "-a", "-F", TMUX_LIST_FORMAT]);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map(parsePaneLine)
		.filter((pane): pane is PaneInfo => pane !== undefined);
}

async function getCurrentSessionName(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const output = await runTmux(pi, ["display-message", "-p", "#{session_name}"], 1500);
		const value = output.trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

async function getCurrentPaneContext(pi: ExtensionAPI): Promise<CurrentPaneContext | undefined> {
	try {
		const output = await runTmux(pi, ["display-message", "-p", "#{pane_id}\t#{window_id}"], 1500);
		const [paneIdRaw, windowIdRaw] = output.trim().split("\t");
		const paneId = paneIdRaw?.trim();
		const windowId = windowIdRaw?.trim();
		if (!paneId || !windowId) return undefined;
		return { paneId, windowId };
	} catch {
		return undefined;
	}
}

function previewFromCapture(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	return truncate(lines[lines.length - 1].replace(/\s+/g, " "), 70);
}

async function panePreview(pi: ExtensionAPI, paneId: string): Promise<string> {
	try {
		const capture = await runTmux(pi, ["capture-pane", "-t", paneId, "-p", "-S", "-15"], 1200);
		return previewFromCapture(capture);
	} catch {
		return "";
	}
}

async function buildPaneOptions(pi: ExtensionAPI, panes: PaneInfo[]): Promise<PaneOption[]> {
	const previews = await Promise.all(panes.map((pane) => panePreview(pi, pane.paneId)));
	return panes.map((pane, index) => {
		const preview = previews[index];
		const suffix = preview.length > 0 ? ` | ${preview}` : "";
		return {
			pane,
			preview,
			label: `${paneLabel(pane)}${suffix}`,
		};
	});
}

function formatScopeLabel(scope: PaneScope, currentSessionName: string | undefined): string {
	if (!currentSessionName) {
		return scope === "tracked" ? "○ All | ◉ Tracked" : "◉ All | ○ Tracked";
	}
	if (scope === "current") return "◉ Current Session | ○ All | ○ Tracked";
	if (scope === "tracked") return "○ Current Session | ○ All | ◉ Tracked";
	return "○ Current Session | ◉ All | ○ Tracked";
}

function formatTargetsLines(trackedPaneIds: Set<string>, paneCache: Map<string, PaneInfo>): string {
	const lines = Array.from(trackedPaneIds)
		.slice(0, 12)
		.map((paneId) => {
			const pane = paneCache.get(paneId);
			if (!pane) return `- ${paneId}`;
			return `- ${pane.paneId} ${paneIdentifier(pane)} cmd=${pane.currentCommand}`;
		});
	return lines.length > 0 ? lines.join("\n") : "- none";
}

function resolveScopeOptions(
	allOptions: PaneOption[],
	scope: PaneScope,
	currentSessionName: string | undefined,
	trackedPaneIds: Set<string>,
): PaneOption[] {
	if (scope === "tracked") {
		return allOptions.filter((option) => trackedPaneIds.has(option.pane.paneId));
	}
	if (scope === "all" || !currentSessionName) return allOptions;
	const currentOnly = allOptions.filter((option) => option.pane.sessionName === currentSessionName);
	return currentOnly.length > 0 ? currentOnly : allOptions;
}

async function openPaneBrowser(
	ctx: ExtensionContext,
	allOptions: PaneOption[],
	currentSessionName: string | undefined,
	initialTrackedPaneIds: Set<string>,
): Promise<PaneBrowserResult> {
	if (allOptions.length === 0) {
		return { trackedPaneIds: Array.from(initialTrackedPaneIds), cancelled: true };
	}
	if (!ctx.hasUI) {
		return { trackedPaneIds: Array.from(initialTrackedPaneIds), cancelled: false };
	}

	return ctx.ui.custom<PaneBrowserResult>((tui, theme, _keybindings, done) => {
		let scope: PaneScope = currentSessionName ? "current" : "all";
		let tracked = new Set(initialTrackedPaneIds);
		let cursor = 0;

		const scopeOrder: PaneScope[] = currentSessionName ? ["current", "all", "tracked"] : ["all", "tracked"];
		const nextScope = (value: PaneScope): PaneScope => {
			const index = scopeOrder.indexOf(value);
			if (index < 0) return scopeOrder[0];
			return scopeOrder[(index + 1) % scopeOrder.length];
		};

		const visibleOptions = (): PaneOption[] => resolveScopeOptions(allOptions, scope, currentSessionName, tracked);
		const finish = (cancelled: boolean): void => {
			done({ trackedPaneIds: Array.from(tracked), cancelled });
		};

		return {
			render: (width: number): string[] => {
				const lines: string[] = [];
				const items = visibleOptions();
				cursor = Math.max(0, Math.min(Math.max(items.length - 1, 0), cursor));

				lines.push(theme.fg("accent", theme.bold(" TMUX Targets ")));
				lines.push(theme.fg("muted", formatScopeLabel(scope, currentSessionName)));
				lines.push(theme.fg("dim", "↑↓ move · tab scope · t toggle · enter toggle+close · esc apply+close · q cancel"));
				lines.push(theme.fg("dim", `tracked=${tracked.size} total=${allOptions.length}`));
				lines.push("");

				if (items.length === 0) {
					lines.push(theme.fg("warning", "No panes for this scope"));
					return lines;
				}

				const maxRows = Math.max(6, Math.min(12, items.length));
				const half = Math.floor(maxRows / 2);
				const maxStart = Math.max(0, items.length - maxRows);
				const start = Math.max(0, Math.min(cursor - half, maxStart));
				const end = Math.min(items.length, start + maxRows);

				for (let index = start; index < end; index++) {
					const option = items[index];
					const pointer = index === cursor ? theme.fg("accent", "❯") : " ";
					const isTracked = tracked.has(option.pane.paneId) ? theme.fg("warning", "T") : " ";
					lines.push(truncate(`${pointer} [${isTracked}] ${option.label}`, Math.max(12, width)));
				}

				if (end < items.length) {
					lines.push(theme.fg("dim", `... ${items.length - end} more`));
				}
				return lines;
			},
			invalidate: () => {},
			handleInput: (data: string): boolean => {
				const items = visibleOptions();
				if (matchesKey(data, "up")) {
					cursor = Math.max(0, cursor - 1);
					tui.requestRender();
					return true;
				}
				if (matchesKey(data, "down")) {
					cursor = Math.min(Math.max(items.length - 1, 0), cursor + 1);
					tui.requestRender();
					return true;
				}
				if (matchesKey(data, "tab")) {
					scope = nextScope(scope);
					cursor = 0;
					tui.requestRender();
					return true;
				}
				if (items.length > 0 && (data === "t" || data === "T" || matchesKey(data, "return"))) {
					const paneId = items[cursor].pane.paneId;
					if (tracked.has(paneId)) tracked.delete(paneId);
					else tracked.add(paneId);
					if (matchesKey(data, "return")) {
						finish(false);
					} else {
						tui.requestRender();
					}
					return true;
				}
				if (matchesKey(data, "escape")) {
					finish(false);
					return true;
				}
				if (data === "q" || data === "Q") {
					finish(true);
					return true;
				}
				return false;
			},
		};
	});
}

export default function tmuxTargetExtension(pi: ExtensionAPI) {
	const trackedPaneIds = new Set<string>();
	const paneCache = new Map<string, PaneInfo>();
	const subagentRootPaneByWindowId = new Map<string, string>();
	let currentSessionFile: string | null = null;
	let jobsWatcher: ReturnType<typeof setInterval> | null = null;
	let jobsPolling = false;

	const cachePanes = (panes: PaneInfo[]): void => {
		for (const pane of panes) {
			paneCache.set(pane.paneId, pane);
		}
	};

	const syncLiveState = (panes: PaneInfo[]): void => {
		cachePanes(panes);
		const livePaneIds = new Set(panes.map((pane) => pane.paneId));

		for (const paneId of trackedPaneIds) {
			if (!livePaneIds.has(paneId)) {
				trackedPaneIds.delete(paneId);
			}
		}

		for (const paneId of paneCache.keys()) {
			if (!livePaneIds.has(paneId) && !trackedPaneIds.has(paneId)) {
				paneCache.delete(paneId);
			}
		}

		for (const [windowId, paneId] of subagentRootPaneByWindowId.entries()) {
			if (!livePaneIds.has(paneId)) {
				subagentRootPaneByWindowId.delete(windowId);
			}
		}
	};

	const persistState = (): void => {
		const state: PersistedState = {
			version: 4,
			trackedPaneIds: Array.from(trackedPaneIds),
			knownPanes: Array.from(paneCache.values()),
		};
		pi.appendEntry(TMUX_TARGET_ENTRY_TYPE, state);
	};

	const trackedPaneKey = (): string => Array.from(trackedPaneIds).sort().join("|");

	const isJobInActiveSession = (job: AsyncJobRecord): boolean => {
		return job.parentSessionFile === currentSessionFile;
	};

	const filterJobsForActiveSession = (jobs: AsyncJobRecord[], includeAllSessions = false): AsyncJobRecord[] => {
		if (includeAllSessions) return jobs;
		return jobs.filter((job) => isJobInActiveSession(job));
	};

	const refreshLiveTracking = async (): Promise<void> => {
		if (!inTmux()) return;
		const beforeTracked = trackedPaneKey();
		const panes = await listPanes(pi);
		syncLiveState(panes);

		const livePaneIds = new Set(panes.map((pane) => pane.paneId));
		for (const job of filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone))) {
			if (job.status !== "running" || !job.paneId) continue;
			if (job.trackPane === false) continue;
			if (!livePaneIds.has(job.paneId)) continue;
			trackedPaneIds.add(job.paneId);
		}

		if (beforeTracked !== trackedPaneKey()) {
			persistState();
		}
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const runningJobs = filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone)).filter(
			(job) => job.status === "running",
		).length;
		if (trackedPaneIds.size === 0 && runningJobs === 0) {
			ctx.ui.setStatus("tmux-target", undefined);
			return;
		}
		ctx.ui.setStatus("tmux-target", `tmux: ${trackedPaneIds.size} tracked | jobs: ${runningJobs} running`);
	};

	const restoreState = async (ctx: ExtensionContext): Promise<void> => {
		trackedPaneIds.clear();
		paneCache.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== TMUX_TARGET_ENTRY_TYPE) continue;
			const parsed = parsePersistedState(entry.data);
			if (!parsed) continue;

			trackedPaneIds.clear();
			for (const paneId of parsed.trackedPaneIds) trackedPaneIds.add(paneId);
			paneCache.clear();
			for (const pane of parsed.knownPanes) paneCache.set(pane.paneId, pane);
		}

		try {
			await refreshLiveTracking();
		} catch {
			// Keep restored state if tmux refresh fails.
		}
		updateStatus(ctx);
	};

	const applyBrowserResult = (result: PaneBrowserResult): void => {
		if (result.cancelled) return;
		trackedPaneIds.clear();
		for (const paneId of result.trackedPaneIds) trackedPaneIds.add(paneId);
		for (const job of filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone))) {
			if (job.status !== "running" || !job.paneId) continue;
			const desired = trackedPaneIds.has(job.paneId);
			if (job.trackPane !== desired) {
				job.trackPane = desired;
				updateJobMeta(job);
			}
		}
		persistState();
	};

	const refreshPaneOptions = async (): Promise<{ options: PaneOption[]; currentSessionName: string | undefined }> => {
		const [panes, currentSessionName] = await Promise.all([listPanes(pi), getCurrentSessionName(pi)]);
		syncLiveState(panes);
		const options = await buildPaneOptions(pi, panes);
		return { options, currentSessionName };
	};

	const matchPanes = async (criteria: { pane?: string; regex?: string }): Promise<PaneInfo[]> => {
		const panes = await listPanes(pi);
		syncLiveState(panes);

		const paneId = criteria.pane?.trim();
		if (paneId && paneId.length > 0) {
			const pane = panes.find((entry) => entry.paneId === paneId);
			return pane ? [pane] : [];
		}

		const regexRaw = criteria.regex?.trim();
		if (regexRaw && regexRaw.length > 0) {
			const regex = parseRegex(regexRaw);
			return panes.filter((pane) => {
				regex.lastIndex = 0;
				return regex.test(paneSearchText(pane, ""));
			});
		}

		return [];
	};

	const selectPreferredPane = (panes: PaneInfo[]): PaneInfo | undefined => {
		if (panes.length === 0) return undefined;
		return panes.find((pane) => pane.isActive) ?? panes[0];
	};

	const loadJob = (jobId: string): AsyncJobRecord | undefined => {
		return parseAsyncJobRecord(readJsonFile(jobMetaPath(jobId)));
	};

	const refreshJobFromDone = (job: AsyncJobRecord): AsyncJobRecord => {
		const done = readJsonFile<AsyncDoneRecord>(job.donePath);
		if (!done) return job;
		job.status = done.status;
		job.doneAt = done.finishedAt;
		if (typeof done.paneId === "string" && done.paneId.length > 0) {
			job.paneId = done.paneId;
		}
		return job;
	};

	const killPaneSafely = async (paneId: string, cwd: string): Promise<"killed" | "missing" | "error"> => {
		const result = await pi.exec("tmux", ["kill-pane", "-t", paneId], { timeout: 2000, cwd });
		if (result.code === 0) return "killed";
		const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
		if (message.includes("can't find pane") || message.includes("no such pane") || message.includes("pane not found")) {
			return "missing";
		}
		return "error";
	};

	const setRunningJobsTrackPreference = (paneIds: Set<string>, trackPane: boolean): void => {
		for (const job of filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone))) {
			if (job.status !== "running") continue;
			if (!job.paneId || !paneIds.has(job.paneId)) continue;
			if (job.trackPane === trackPane) continue;
			job.trackPane = trackPane;
			updateJobMeta(job);
		}
	};

	const launchPaneWithCommand = async (
		cwd: string,
		command: string,
		options?: {
			horizontal?: boolean;
			track?: boolean;
			targetPane?: string;
		},
	): Promise<PaneInfo | undefined> => {
		const [panesBeforeLaunch, currentPaneContext] = await Promise.all([listPanes(pi), getCurrentPaneContext(pi)]);
		syncLiveState(panesBeforeLaunch);

		const splitArgs = ["split-window", "-P", "-F", "#{pane_id}"];
		if (options?.targetPane) {
			splitArgs.push("-t", options.targetPane);
		}
		if (options?.horizontal === true) {
			splitArgs.push("-h", "-d");
		} else if (options?.horizontal === false) {
			splitArgs.push("-v", "-d");
		} else if (options?.targetPane) {
			splitArgs.push("-d");
		} else if (currentPaneContext) {
			const rootPaneId = subagentRootPaneByWindowId.get(currentPaneContext.windowId);
			const existingRoot = rootPaneId
				? panesBeforeLaunch.find((pane) => pane.windowId === currentPaneContext.windowId && pane.paneId === rootPaneId)
				: undefined;
			if (existingRoot) {
				splitArgs.push("-t", existingRoot.paneId, "-v", "-d");
			} else {
				splitArgs.push("-t", currentPaneContext.paneId, "-h", "-p", "50", "-d");
			}
		} else {
			splitArgs.push("-d");
		}
		splitArgs.push("-c", cwd, command);

		const paneId = (await runTmux(pi, splitArgs, 5000)).trim();
		if (paneId.length === 0) return undefined;

		const panes = await listPanes(pi);
		syncLiveState(panes);
		const pane = panes.find((entry) => entry.paneId === paneId);
		if (pane) paneCache.set(pane.paneId, pane);

		if (currentPaneContext && options?.horizontal === undefined && !options?.targetPane && pane) {
			const existingRootId = subagentRootPaneByWindowId.get(currentPaneContext.windowId);
			const existingRootIsLive =
				typeof existingRootId === "string" &&
				panes.some((entry) => entry.windowId === currentPaneContext.windowId && entry.paneId === existingRootId);
			if (!existingRootIsLive) {
				subagentRootPaneByWindowId.set(currentPaneContext.windowId, pane.paneId);
			}
		}

		if (options?.track !== false) trackedPaneIds.add(paneId);
		persistState();
		return pane;
	};

	const launchSubagent = async (
		cwd: string,
		options?: {
			prompt?: string;
			horizontal?: boolean;
			noSession?: boolean;
			track?: boolean;
			targetPane?: string;
		},
	): Promise<PaneInfo | undefined> => {
		const piArgs: string[] = [];
		if (options?.noSession === true) piArgs.push("--no-session");
		const prompt = options?.prompt?.trim();
		if (prompt && prompt.length > 0) piArgs.push(prompt);
		const piCommand = `pi${piArgs.length > 0 ? ` ${piArgs.map(shellQuote).join(" ")}` : ""}`;
		return launchPaneWithCommand(cwd, piCommand, {
			horizontal: options?.horizontal,
			track: options?.track,
			targetPane: options?.targetPane,
		});
	};

	const pollAsyncJobs = async (): Promise<void> => {
		if (jobsPolling) return;
		jobsPolling = true;
		try {
			for (const raw of listAsyncJobs()) {
				try {
					const job = refreshJobFromDone(raw);
					if (!fs.existsSync(job.donePath)) {
						if (job.status !== "running") {
							job.status = "running";
							updateJobMeta(job);
						}
						continue;
					}
					if (job.callbackSent) continue;
					if (!isJobInActiveSession(job)) continue;

					const done = readJsonFile<AsyncDoneRecord>(job.donePath);
					if (!done) continue;
					job.status = done.status;
					job.doneAt = done.finishedAt;
					if (typeof done.paneId === "string" && done.paneId.length > 0) {
						job.paneId = done.paneId;
					}

					let paneLifecycle = job.autoKillOnDone ? "auto-killed on completion" : "kept alive";
					if (job.autoKillOnDone && job.paneId) {
						const killResult = await killPaneSafely(job.paneId, job.cwd);
						if (killResult === "killed") {
							trackedPaneIds.delete(job.paneId);
							paneLifecycle = "auto-killed on completion";
						} else if (killResult === "missing") {
							trackedPaneIds.delete(job.paneId);
							paneLifecycle = "already closed by tmux before auto-kill";
						} else {
							paneLifecycle = "auto-kill failed";
						}
					}

					const summary = summarizeJsonLog(job.logPath);
					const stderrTail = readTail(job.stderrPath, 12);
					let callback = "";
					callback += `[tmux-subagent] ${job.name} finished\n`;
					callback += `jobId: ${job.jobId}\n`;
					callback += `pane: ${job.paneId ?? "unknown"}\n`;
					callback += `status: ${done.status} (exit ${done.exitCode})\n`;
					callback += `pane lifecycle: ${paneLifecycle}\n\n`;
					if (summary.finalOutput.length > 0) callback += summary.finalOutput;
					else if (stderrTail.length > 0) callback += `stderr tail:\n${stderrTail}`;
					else callback += "(no output captured)";

					pi.sendUserMessage(callback, { deliverAs: "followUp" });
					job.callbackSent = true;
					updateJobMeta(job);
					persistState();
				} catch (error) {
					console.error("[tmux-target] async job polling error", error);
				}
			}
		} finally {
			jobsPolling = false;
		}
	};

	const ensureJobsWatcher = (): void => {
		if (jobsWatcher) return;
		jobsWatcher = setInterval(() => {
			void pollAsyncJobs().catch((error) => {
				console.error("[tmux-target] jobs watcher poll failed", error);
			});
		}, 1500);
	};

	const stopJobsWatcher = (): void => {
		if (!jobsWatcher) return;
		clearInterval(jobsWatcher);
		jobsWatcher = null;
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureJobsDirs();
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		await restoreState(ctx);
		ensureJobsWatcher();
	});
	pi.on("session_switch", async (_event, ctx) => {
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		await restoreState(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		await restoreState(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		await restoreState(ctx);
	});
	pi.on("session_shutdown", async () => {
		stopJobsWatcher();
	});
	pi.on("turn_start", async (_event, ctx) => {
		try {
			await refreshLiveTracking();
			await pollAsyncJobs();
		} catch {
			// Ignore tmux refresh errors during turn start.
		}
		updateStatus(ctx);
	});

	pi.registerCommand("tmux-targets", {
		description: "Manage tracked tmux panes (t toggle target, Tab current/all/tracked, Enter toggle+close)",
		handler: async (_args, ctx) => {
			if (!inTmux()) {
				ctx.ui.notify("Not in tmux environment", "warning");
				return;
			}
			try {
				const { options, currentSessionName } = await refreshPaneOptions();
				const result = await openPaneBrowser(ctx, options, currentSessionName, new Set(trackedPaneIds));
				applyBrowserResult(result);
				updateStatus(ctx);
			} catch (error) {
				ctx.ui.notify(`tmux targets error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tmux-launch-subagent", {
		description: "Split current tmux window, launch a new pi, and auto-track new pane",
		handler: async (args, ctx) => {
			if (!inTmux()) {
				ctx.ui.notify("Not in tmux environment", "warning");
				return;
			}
			try {
				const pane = await launchSubagent(ctx.cwd, {
					prompt: args.trim().length > 0 ? args.trim() : undefined,
					track: true,
				});
				if (pane) {
					ctx.ui.notify(`Launched subagent in ${pane.paneId} (${paneIdentifier(pane)})`, "info");
				}
				updateStatus(ctx);
			} catch (error) {
				ctx.ui.notify(`tmux launch error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "tmux_list_targets",
		label: "tmux list targets",
		description: "List tracked tmux targets. Use bash for tmux commands/capture.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				if (inTmux()) {
					const panes = await listPanes(pi);
					syncLiveState(panes);
					persistState();
				}
				const lines: string[] = [];
				lines.push(`Tracked count: ${trackedPaneIds.size}`);
				lines.push("Targets:");
				lines.push(formatTargetsLines(trackedPaneIds, paneCache));

				const jobs = filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone));
				const runningJobs = jobs.filter((job) => job.status === "running");
				if (runningJobs.length > 0) {
					lines.push("");
					lines.push(`Running async jobs (this session): ${runningJobs.length}`);
					for (const job of runningJobs.slice(0, 8)) {
						const summary = summarizeJsonLog(job.logPath);
						lines.push(`- ${job.jobId} ${job.paneId ?? "?"} ${job.name} :: ${summary.progress}`);
					}
				}

				updateStatus(ctx);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						trackedPaneIds: Array.from(trackedPaneIds),
						runningJobs: runningJobs.map((job) => ({ jobId: job.jobId, paneId: job.paneId, name: job.name })),
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `tmux list targets error: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "tmux_track_pane",
		label: "tmux track pane",
		description: "Track or untrack tmux pane(s) by pane id or regex. Set untrack=true to remove matches.",
		parameters: Type.Object({
			pane: Type.Optional(Type.String({ description: 'Exact pane id like "%3"' })),
			regex: Type.Optional(Type.String({ description: "Regex or /regex/flags" })),
			allMatches: Type.Optional(Type.Boolean({ description: "Apply to all matches (default: false)" })),
			untrack: Type.Optional(Type.Boolean({ description: "Set true to untrack instead of track" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!inTmux()) {
				return {
					content: [{ type: "text", text: "Not in tmux environment" }],
					isError: true,
					details: {},
				};
			}

			try {
				const matches = await matchPanes({ pane: params.pane, regex: params.regex });
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: "No panes matched. Provide pane or regex." }],
						isError: true,
						details: {},
					};
				}

				const panes = params.allMatches === true ? matches : [selectPreferredPane(matches)!];
				const action = params.untrack === true ? "untrack" : "track";

				if (action === "track") {
					for (const pane of panes) {
						paneCache.set(pane.paneId, pane);
						trackedPaneIds.add(pane.paneId);
					}
				} else {
					for (const pane of panes) {
						trackedPaneIds.delete(pane.paneId);
					}
				}

				setRunningJobsTrackPreference(new Set(panes.map((pane) => pane.paneId)), action === "track");
				persistState();
				updateStatus(ctx);
				const list = panes.map((pane) => `${pane.paneId} (${paneIdentifier(pane)})`).join(", ");
				return {
					content: [{ type: "text", text: action === "track" ? `Tracked pane(s): ${list}` : `Untracked pane(s): ${list}` }],
					details: {
						action,
						trackedPaneIds: Array.from(trackedPaneIds),
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `tmux track error: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "tmux_subagent_job",
		label: "tmux subagent job",
		description:
			"Async non-interactive subagent jobs in tmux (print/json worker). start spawns a pane and runs a task; when done, parent gets follow-up callback and pane can auto-kill. list/progress/cancel are session-scoped by default (allSessions=true to override).",
		parameters: Type.Object({
			action: StringEnum(["start", "list", "progress", "cancel"] as const),
			task: Type.Optional(Type.String({ description: "Task prompt for start" })),
			jobId: Type.Optional(Type.String({ description: "Job id for progress/cancel" })),
			name: Type.Optional(Type.String({ description: "Optional name for start" })),
			cwd: Type.Optional(Type.String({ description: "Optional working directory for start" })),
			horizontal: Type.Optional(Type.Boolean({ description: "Force horizontal split (-h)" })),
			targetPane: Type.Optional(Type.String({ description: "Optional tmux target pane (e.g. %3)" })),
			model: Type.Optional(Type.String({ description: "Optional model override for worker" })),
			tools: Type.Optional(Type.String({ description: "Optional comma-separated worker tools" })),
			autoKillOnDone: Type.Optional(Type.Boolean({ description: "Kill pane when job finishes (default true)", default: true })),
			track: Type.Optional(Type.Boolean({ description: "Track spawned pane (default true)" })),
			limit: Type.Optional(Type.Number({ description: "Max rows for list/progress", default: 20 })),
			allSessions: Type.Optional(Type.Boolean({ description: "Include jobs from all sessions (default false)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!inTmux()) {
				return {
					content: [{ type: "text", text: "Not in tmux environment" }],
					isError: true,
					details: {},
				};
			}
			ensureJobsDirs();

			if (params.action === "start") {
				const task = params.task?.trim();
				if (!task) {
					return {
						content: [{ type: "text", text: "start requires task" }],
						isError: true,
						details: {},
					};
				}

				const jobId = makeJobId();
				const name = (params.name?.trim() || truncate(task.replace(/\s+/g, " "), 36)).replace(/\n/g, " ");
				const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
				const autoKillOnDone = params.autoKillOnDone !== false;
				const track = params.track !== false;

				const taskPath = path.join(TMUX_JOBS_TASKS_DIR, `${jobId}.task.txt`);
				const scriptPath = path.join(TMUX_JOBS_SCRIPTS_DIR, `${jobId}.run.sh`);
				const formatterPath = path.join(TMUX_JOBS_SCRIPTS_DIR, `${jobId}.format.cjs`);
				const logPath = path.join(TMUX_JOBS_LOGS_DIR, `${jobId}.jsonl`);
				const stderrPath = path.join(TMUX_JOBS_LOGS_DIR, `${jobId}.stderr.log`);
				const donePath = path.join(TMUX_JOBS_META_DIR, `${jobId}.done.json`);

				fs.writeFileSync(taskPath, task, "utf-8");
				fs.writeFileSync(formatterPath, buildJsonPaneFormatterScript(), { mode: 0o700 });
				fs.writeFileSync(
					scriptPath,
					buildAsyncWorkerScript({
						jobId,
						taskPath,
						logPath,
						stderrPath,
						donePath,
						formatterPath,
						model: params.model,
						tools: params.tools,
						keepPaneAlive: !autoKillOnDone,
					}),
					{ mode: 0o700 },
				);

				let pane: PaneInfo | undefined;
				try {
					pane = await launchPaneWithCommand(cwd, `bash ${shellQuote(scriptPath)}`, {
						horizontal: params.horizontal,
						targetPane: params.targetPane,
						track,
					});
				} catch (error) {
					for (const filePath of [taskPath, scriptPath, formatterPath, logPath, stderrPath, donePath]) {
						try {
							if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
						} catch {
							// Ignore cleanup errors.
						}
					}
					return {
						content: [{ type: "text", text: `tmux subagent launch error: ${error instanceof Error ? error.message : String(error)}` }],
						isError: true,
						details: {},
					};
				}

				const job: AsyncJobRecord = {
					version: 1,
					jobId,
					name,
					task,
					status: "running",
					paneId: pane?.paneId,
					createdAt: new Date().toISOString(),
					cwd,
					parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
					autoKillOnDone,
					trackPane: track,
					callbackSent: false,
					logPath,
					stderrPath,
					donePath,
					scriptPath,
					taskPath,
					model: params.model,
					tools: params.tools,
				};
				updateJobMeta(job);
				updateStatus(ctx);

				return {
					content: [
						{
							type: "text",
							text:
								`Spawned async subagent job ${jobId}.\n` +
								`pane: ${pane?.paneId ?? "unknown"}\n` +
								`name: ${name}\n` +
								`autoKillOnDone: ${autoKillOnDone}\n` +
								"Monitor with tmux_subagent_job(action=\"progress\") or tmux_list_targets.\n" +
								"Job visibility is session-scoped by default (set allSessions=true to query globally).\n" +
								"For steerable interactive panes, use tmux_launch_subagent.",
						},
					],
					details: { jobId, paneId: pane?.paneId, status: "running" },
				};
			}

			if (params.action === "list") {
				const limit = Math.max(1, Math.min(100, params.limit ?? 20));
				const jobs = filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone), params.allSessions === true).slice(0, limit);
				if (jobs.length === 0) {
					return {
						content: [{ type: "text", text: params.allSessions === true ? "No async tmux jobs yet." : "No async tmux jobs in this session yet." }],
						details: { jobs: [] },
					};
				}
				const counts = {
					running: jobs.filter((job) => job.status === "running").length,
					success: jobs.filter((job) => job.status === "success").length,
					error: jobs.filter((job) => job.status === "error").length,
					cancelled: jobs.filter((job) => job.status === "cancelled").length,
				};
				const lines: string[] = [];
				lines.push(
					`Jobs: ${jobs.length} (running ${counts.running}, success ${counts.success}, error ${counts.error}, cancelled ${counts.cancelled})`,
				);
				if (params.allSessions !== true) lines.push("scope: current session");
				lines.push("");
				for (const job of jobs) {
					lines.push(`${job.jobId} [${job.status}] ${job.paneId ?? "?"} ${job.name}`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { jobs, allSessions: params.allSessions === true },
				};
			}

			if (params.action === "progress") {
				const limit = Math.max(1, Math.min(100, params.limit ?? 20));
				const jobs = filterJobsForActiveSession(listAsyncJobs().map(refreshJobFromDone), params.allSessions === true);
				const selected = params.jobId ? jobs.filter((job) => job.jobId === params.jobId) : jobs.slice(0, limit);
				if (selected.length === 0) {
					const notFoundText = params.jobId
						? params.allSessions === true
							? `Job not found: ${params.jobId}`
							: `Job not found in this session: ${params.jobId}`
						: "No jobs found";
					return {
						content: [{ type: "text", text: notFoundText }],
						isError: Boolean(params.jobId),
						details: {},
					};
				}
				const lines: string[] = [];
				for (const job of selected) {
					const summary = summarizeJsonLog(job.logPath);
					lines.push(`${job.jobId} [${job.status}] ${job.paneId ?? "?"} ${job.name}`);
					lines.push(`progress: ${summary.progress}`);
					if (job.status === "running" && job.paneId) {
						const paneResult = await pi.exec("tmux", ["capture-pane", "-p", "-t", job.paneId, "-S", "-40"], {
							timeout: 1500,
							cwd: ctx.cwd,
						});
						if (paneResult.code === 0) {
							const textTail = paneResult.stdout
								.split(/\r?\n/)
								.filter((line) => line.trim().length > 0)
								.slice(-10)
								.join("\n");
							if (textTail.length > 0) lines.push(`pane tail:\n${textTail}`);
						}
					} else {
						if (summary.finalOutput.length > 0) lines.push(`final:\n${summary.finalOutput}`);
						const stderrTail = readTail(job.stderrPath, 10);
						if (stderrTail.length > 0) lines.push(`stderr tail:\n${stderrTail}`);
					}
					lines.push("---");
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { jobs: selected, allSessions: params.allSessions === true },
				};
			}

			if (!params.jobId) {
				return {
					content: [{ type: "text", text: "cancel requires jobId" }],
					isError: true,
					details: {},
				};
			}
			const job = loadJob(params.jobId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Job not found: ${params.jobId}` }],
					isError: true,
					details: {},
				};
			}
			if (params.allSessions !== true && !isJobInActiveSession(job)) {
				return {
					content: [
						{
							type: "text",
							text: `Job ${params.jobId} belongs to a different session. Set allSessions=true to override.`,
						},
					],
					isError: true,
					details: {},
				};
			}

			let paneKillState: "killed" | "missing" | "error" | "none" = "none";
			if (job.paneId) {
				paneKillState = await killPaneSafely(job.paneId, job.cwd);
				if (paneKillState === "killed" || paneKillState === "missing") {
					trackedPaneIds.delete(job.paneId);
				}
			}
			if (!fs.existsSync(job.donePath)) {
				const doneRecord: AsyncDoneRecord = {
					jobId: job.jobId,
					paneId: job.paneId,
					status: "cancelled",
					exitCode: 130,
					finishedAt: new Date().toISOString(),
				};
				writeJsonAtomic(job.donePath, doneRecord);
			}
			job.status = "cancelled";
			job.doneAt = new Date().toISOString();
			job.callbackSent = true;
			updateJobMeta(job);
			persistState();
			updateStatus(ctx);
			const paneStateText =
				paneKillState === "killed"
					? `pane ${job.paneId ?? "unknown"} killed`
					: paneKillState === "missing"
						? `pane ${job.paneId ?? "unknown"} already closed`
						: paneKillState === "error"
							? `pane ${job.paneId ?? "unknown"} kill failed`
							: "no pane to kill";
			return {
				content: [{ type: "text", text: `Cancelled job ${job.jobId}; ${paneStateText}.` }],
				details: { job, paneKillState },
			};
		},
	});

	pi.registerTool({
		name: "tmux_launch_subagent",
		label: "tmux launch subagent",
		description: "Launch an interactive, steerable subagent in a tmux split and optionally track that pane.",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Optional initial prompt for the subagent" })),
			cwd: Type.Optional(Type.String({ description: "Optional working directory for launch" })),
			horizontal: Type.Optional(Type.Boolean({ description: "Force horizontal split (-h)" })),
			noSession: Type.Optional(Type.Boolean({ description: "Launch with --no-session" })),
			targetPane: Type.Optional(Type.String({ description: "Optional tmux target pane (e.g. %3)" })),
			track: Type.Optional(Type.Boolean({ description: "Track spawned pane (default true)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!inTmux()) {
				return {
					content: [{ type: "text", text: "Not in tmux environment" }],
					isError: true,
					details: {},
				};
			}
			try {
				const launchCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
				const pane = await launchSubagent(launchCwd, {
					prompt: params.prompt?.trim().length ? params.prompt.trim() : undefined,
					horizontal: params.horizontal,
					noSession: params.noSession,
					track: params.track,
					targetPane: params.targetPane,
				});
				updateStatus(ctx);
				if (!pane) {
					return {
						content: [{ type: "text", text: "Failed to launch subagent pane" }],
						isError: true,
						details: {},
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Launched interactive subagent in ${pane.paneId} (${paneIdentifier(pane)}).\n` +
								"This pane is steerable: switch to it in tmux and continue chatting with that agent.",
						},
					],
					details: { paneId: pane.paneId, paneIdentifier: paneIdentifier(pane) },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `tmux launch error: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});
}
