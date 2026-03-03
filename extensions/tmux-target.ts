import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

type PaneScope = "current" | "all";

interface PaneBrowserResult {
	trackedPaneIds: string[];
	cancelled: boolean;
}

interface CurrentPaneContext {
	paneId: string;
	windowId: string;
}

const TMUX_TARGET_ENTRY_TYPE = "tmux-target";
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
	if (!currentSessionName) return "◉ All";
	if (scope === "current") return "◉ Current Session | ○ All";
	return "○ Current Session | ◉ All";
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
): PaneOption[] {
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

		const visibleOptions = (): PaneOption[] => resolveScopeOptions(allOptions, scope, currentSessionName);
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
				lines.push(theme.fg("dim", "↑↓ move · tab scope · t toggle · enter toggle+close · esc close"));
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
					scope = scope === "current" ? "all" : "current";
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
				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					finish(false);
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

	const refreshLiveTracking = async (): Promise<void> => {
		if (!inTmux()) return;
		const beforeTracked = trackedPaneKey();
		const panes = await listPanes(pi);
		syncLiveState(panes);
		if (beforeTracked !== trackedPaneKey()) {
			persistState();
		}
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("tmux-target", trackedPaneIds.size > 0 ? `tmux: ${trackedPaneIds.size} tracked` : undefined);
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

	const launchSubagent = async (
		cwd: string,
		options?: {
			prompt?: string;
			horizontal?: boolean;
			noSession?: boolean;
			track?: boolean;
		},
	): Promise<PaneInfo | undefined> => {
		const piArgs: string[] = [];
		if (options?.noSession === true) {
			piArgs.push("--no-session");
		}
		const prompt = options?.prompt?.trim();
		if (prompt && prompt.length > 0) {
			piArgs.push(prompt);
		}

		const piCommand = `pi${piArgs.length > 0 ? ` ${piArgs.map(shellQuote).join(" ")}` : ""}`;
		const [panesBeforeLaunch, currentPaneContext] = await Promise.all([listPanes(pi), getCurrentPaneContext(pi)]);
		syncLiveState(panesBeforeLaunch);

		const splitArgs = ["split-window", "-P", "-F", "#{pane_id}"];
		if (options?.horizontal === true) {
			splitArgs.push("-h");
		} else if (options?.horizontal === false) {
			splitArgs.push("-v");
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
		}
		splitArgs.push("-c", cwd, piCommand);

		const paneId = (await runTmux(pi, splitArgs, 5000)).trim();
		if (paneId.length === 0) {
			return undefined;
		}

		const panes = await listPanes(pi);
		syncLiveState(panes);
		const pane = panes.find((entry) => entry.paneId === paneId);
		if (pane) {
			paneCache.set(pane.paneId, pane);
		}

		if (currentPaneContext && options?.horizontal === undefined && pane) {
			const existingRootId = subagentRootPaneByWindowId.get(currentPaneContext.windowId);
			const existingRootIsLive =
				typeof existingRootId === "string" &&
				panes.some((entry) => entry.windowId === currentPaneContext.windowId && entry.paneId === existingRootId);
			if (!existingRootIsLive) {
				subagentRootPaneByWindowId.set(currentPaneContext.windowId, pane.paneId);
			}
		}

		if (options?.track !== false) {
			trackedPaneIds.add(paneId);
		}
		persistState();
		return pane;
	};

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
	pi.on("turn_start", async (_event, ctx) => {
		try {
			await refreshLiveTracking();
		} catch {
			// Ignore tmux refresh errors during turn start.
		}
		updateStatus(ctx);
	});

	pi.registerCommand("tmux-targets", {
		description: "Manage tracked tmux panes (t toggle target, Tab current/all, Enter toggle+close)",
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
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						trackedPaneIds: Array.from(trackedPaneIds),
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
		name: "tmux_launch_subagent",
		label: "tmux launch subagent",
		description: "Split current tmux window, launch a new pi in the new pane, and track it by default.",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Optional startup prompt for new pi" })),
			horizontal: Type.Optional(Type.Boolean({ description: "Use horizontal split (-h)" })),
			noSession: Type.Optional(Type.Boolean({ description: "Launch with --no-session" })),
			track: Type.Optional(Type.Boolean({ description: "Track launched pane (default: true)" })),
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
				const pane = await launchSubagent(ctx.cwd, {
					prompt: params.prompt,
					horizontal: params.horizontal,
					noSession: params.noSession === true,
					track: params.track !== false,
				});

				updateStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: pane
								? `Launched subagent in ${pane.paneId} (${paneIdentifier(pane)})`
								: "Launched subagent pane",
						},
					],
					details: {
						paneId: pane?.paneId,
						trackedPaneIds: Array.from(trackedPaneIds),
					},
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
