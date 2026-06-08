import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";

export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };

export interface ToolExecutionContext {
	setWorkingMessage(message?: string): void;
}

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface ToolRenderContext<TState = unknown, TArgs = unknown> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TParams;
	renderShell?: "default" | "self";
	prepareArguments?: (args: unknown) => Static<TParams>;
	executionMode?: ToolExecutionMode;
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx?: ToolExecutionContext,
	): Promise<AgentToolResult<TDetails>>;
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

export type AnyToolDefinition = ToolDefinition<any, any, any>;

export function defineTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}
