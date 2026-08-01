import { getModels } from "../src/models.js";
import type { Model } from "../src/types.js";

const ZAI_TEST_MODEL_PREFERENCE = ["glm-5.2", "glm-5-turbo", "glm-4.7"];

export function getZaiTestModel(options: { toolStream?: boolean } = {}): Model<"openai-completions"> {
	const models = getModels("zai");
	const eligible = options.toolStream ? models.filter((model) => model.compat?.zaiToolStream) : models;
	for (const id of ZAI_TEST_MODEL_PREFERENCE) {
		const model = eligible.find((candidate) => candidate.id === id);
		if (model) return model;
	}
	const model = eligible[0];
	if (!model) {
		throw new Error(`No ${options.toolStream ? "tool_stream-capable " : ""}z.ai model is available`);
	}
	return model;
}
