import { MODELS } from "../src/models.generated.js";
import type { Api, Model } from "../src/types.js";
import {
	type ResolvedProviderHandoffFamily,
	STABLE_HANDOFF_APIS,
	snapshotProviderHandoffFamily,
} from "./provider-handoff-families.js";

const supportedHandoffApis = new Set<string>(STABLE_HANDOFF_APIS);

export function getCatalogProviderHandoffModels(): ResolvedProviderHandoffFamily[] {
	const catalog = MODELS as unknown as Record<string, Record<string, Model<Api>>>;
	const families: ResolvedProviderHandoffFamily[] = [];
	for (const [provider, models] of Object.entries(catalog)) {
		for (const model of Object.values(models)) {
			if (!supportedHandoffApis.has(model.api)) {
				throw new Error(`Unsupported catalog handoff API: ${model.api}`);
			}
			if (model.provider !== provider) {
				throw new Error(`Catalog provider mismatch for ${provider}/${model.id}: ${model.provider}`);
			}
			families.push({
				fixture: snapshotProviderHandoffFamily(model, false),
				model,
			});
		}
	}
	return families;
}
