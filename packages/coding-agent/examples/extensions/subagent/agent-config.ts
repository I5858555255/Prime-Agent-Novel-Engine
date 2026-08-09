export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function parseAgentConfig(
	frontmatter: Record<string, unknown>,
	body: string,
	source: "user" | "project",
	filePath: string,
): AgentConfig | undefined {
	const name = frontmatter.name;
	const description = frontmatter.description;
	if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
		return undefined;
	}
	if (
		frontmatter.thinking !== undefined &&
		(typeof frontmatter.thinking !== "string" || !frontmatter.thinking.trim())
	) {
		return undefined;
	}

	const tools =
		typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean)
			: undefined;

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

export function buildAgentProcessArgs(agent: AgentConfig): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	return args;
}
