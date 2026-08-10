// Bundle entry for the Bedrock provider.
//
// pi-ai loads Bedrock through a variable specifier (importNodeOnlyProvider) so
// that browser bundles don't pull in the AWS SDK. esbuild therefore cannot see
// the import and emits no chunk for it, while the runtime import still resolves
// relative to the emitted chunk directory. Building this file as an entry named
// "amazon-bedrock" puts the module exactly where that runtime import looks.
//
// Only pi-ai's public ./bedrock-provider export is used, and the named exports
// match what loadBedrockProviderModule() destructures.
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";

export const streamBedrock = bedrockProviderModule.streamBedrock;
export const streamSimpleBedrock = bedrockProviderModule.streamSimpleBedrock;
