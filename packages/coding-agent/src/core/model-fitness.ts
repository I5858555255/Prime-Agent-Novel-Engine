import type { Api, Model, ModelBenchmarks, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { HostRequestHandler } from "./kernel/index.js";

export interface ModelFitnessModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Read-only model metadata projected to the model-fitness skill. Never include credentials or provider config. */
export interface ModelFitnessCandidate {
	provider: string;
	id: string;
	name: string;
	selector: string;
	reasoning: boolean;
	supportedThinkingLevels: ModelThinkingLevel[];
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: ModelFitnessModelCost;
	featured?: boolean;
	/** Generation-time benchmark indices; absent means "no coverage", not zero. */
	benchmarks?: ModelBenchmarks;
}

export interface ModelFitnessCandidatesResult {
	models: ModelFitnessCandidate[];
}

export type ModelFitnessCandidatesHandler = () => ModelFitnessCandidatesResult | Promise<ModelFitnessCandidatesResult>;

/** Project an already-authorized/scope-filtered model for advisory fitness ranking. */
export function projectModelFitnessCandidate(model: Model<Api>): ModelFitnessCandidate {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		selector: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: { ...model.cost },
		...(model.featured ? { featured: true } : {}),
		...(model.benchmarks ? { benchmarks: { ...model.benchmarks } } : {}),
	};
}

export function createModelFitnessCandidatesHostHandler(handler: ModelFitnessCandidatesHandler): HostRequestHandler {
	return async () => ({ models: (await handler()).models });
}
