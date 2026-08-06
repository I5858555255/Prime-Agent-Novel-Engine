$ErrorActionPreference = "Stop"

$launcherPath = Join-Path $PSScriptRoot "prime-agent.cmd"
$env:PRIME_AGENT_LAUNCHER_PATH = $launcherPath

try {
	$buildId = (& git -C $PSScriptRoot describe --tags --always --dirty 2>$null)
	if ($LASTEXITCODE -eq 0 -and $buildId) {
		$env:PRIME_AGENT_BUILD_ID = $buildId.Trim()
	}
} catch {
	# Git metadata is optional when running from a source archive.
}

$useDist = $false
$forwardedArguments = @()
foreach ($argument in $args) {
	switch ($argument) {
		"--no-env" {
			$apiKeyNames = @(
				"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "PRIME_API_KEY",
				"GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
				"OPENROUTER_API_KEY", "ZAI_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY",
				"MINIMAX_CN_API_KEY", "AI_GATEWAY_API_KEY", "OPENCODE_API_KEY",
				"COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN",
				"GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT",
				"GOOGLE_CLOUD_LOCATION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
				"AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK",
				"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
				"AWS_WEB_IDENTITY_TOKEN_FILE", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL",
				"AZURE_OPENAI_RESOURCE_NAME"
			)
			foreach ($name in $apiKeyNames) {
				Remove-Item "Env:$name" -ErrorAction SilentlyContinue
			}
			Write-Host "Running Prime Agent without API keys..."
		}
		"--dist" {
			$useDist = $true
		}
		default {
			$forwardedArguments += $argument
		}
	}
}

if ($useDist) {
	$entrypoint = Join-Path $PSScriptRoot "packages\coding-agent\dist\bundle\cli.js"
	if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
		Write-Error "Bundle not found at $entrypoint. Run npm run build first."
		exit 1
	}
} else {
	$tsxEntrypoint = Join-Path $PSScriptRoot "node_modules\tsx\dist\cli.mjs"
	if (-not (Test-Path -LiteralPath $tsxEntrypoint -PathType Leaf)) {
		Write-Error "tsx not found at $tsxEntrypoint. Run npm install from the repo root first."
		exit 1
	}
	$entrypoint = $tsxEntrypoint
	$forwardedArguments = @((Join-Path $PSScriptRoot "packages\coding-agent\src\cli.ts")) + $forwardedArguments
}

& node $entrypoint @forwardedArguments
exit $LASTEXITCODE
