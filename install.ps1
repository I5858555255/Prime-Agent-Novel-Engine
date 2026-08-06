$ErrorActionPreference = "Stop"

$unconfiguredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_" + "URL__"
$unconfiguredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_" + "CHANNEL__"
$baseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_URL__"
$defaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"
$packageName = "prime-agent"

if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) {
	$baseUrl = $env:PRIME_AGENT_DOWNLOAD_BASE_URL
}
if ($baseUrl -eq $unconfiguredBaseUrl) {
	throw "Installer download URL is not configured. Use the installer published by the release workflow."
}
if ($defaultChannel -eq $unconfiguredDefaultChannel) {
	$defaultChannel = "stable"
}

$release = if ($args.Count -gt 0) { $args[0] } elseif ($env:PRIME_AGENT_VERSION) { $env:PRIME_AGENT_VERSION } elseif ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $defaultChannel }
$baseUrl = $baseUrl.TrimEnd("/")

function Get-PrimeAgentVersion {
	param([string]$Release)

	if ($Release -in @("stable", "beta")) {
		Write-Host "Resolving the $Release release..."
		$Release = (Invoke-RestMethod -UseBasicParsing -Uri "$baseUrl/$Release" -Method Get).ToString().Trim()
	}

	$version = $Release.Trim().TrimStart("v")
	if (-not $version -or $version -notmatch "^[0-9A-Za-z.-]+$") {
		throw "Invalid Prime Agent version: $Release"
	}
	return $version
}

function Assert-Command {
	param([string]$Name, [string]$InstallMessage)

	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "$Name is required. $InstallMessage"
	}
}

function Invoke-PrimeAgentDownload {
	param([string]$Uri, [string]$OutFile)

	$ProgressPreference = "SilentlyContinue"
	Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
}

Assert-Command "node" "Install Node.js 22.8 or newer from https://nodejs.org/."
Assert-Command "npm.cmd" "Install Node.js 22.8 or newer from https://nodejs.org/."

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeParts = $nodeVersion.Split(".")
if ([int]$nodeParts[0] -lt 22 -or ([int]$nodeParts[0] -eq 22 -and [int]$nodeParts[1] -lt 8)) {
	throw "Prime Agent requires Node.js 22.8 or newer; found $nodeVersion."
}

$version = Get-PrimeAgentVersion $release
$tarballName = "$packageName-$version.tgz"
$releaseUrl = "$baseUrl/releases/v$version"
$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) "prime-agent-$([Guid]::NewGuid().ToString('N'))"
$tarballPath = Join-Path $tempDirectory $tarballName
$checksumsPath = Join-Path $tempDirectory "SHA256SUMS"

New-Item -ItemType Directory -Path $tempDirectory | Out-Null
try {
	Write-Host "Downloading Prime Agent v$version..."
	Invoke-PrimeAgentDownload -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumsPath
	Invoke-PrimeAgentDownload -Uri "$releaseUrl/$tarballName" -OutFile $tarballPath

	$checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($tarballName))$" } | Select-Object -First 1
	if (-not $checksumLine) {
		throw "Checksum for $tarballName was not found in SHA256SUMS."
	}
	$expectedChecksum = ($checksumLine -split "\s+")[0].ToLowerInvariant()
	$actualChecksum = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actualChecksum -ne $expectedChecksum) {
		throw "SHA-256 verification failed for $tarballName."
	}

	Write-Host "Installing Prime Agent globally with npm..."
	$previousToolsBootstrap = $env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL
	$previousKernelBootstrap = $env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL
	$previousInstallUv = $env:PRIME_AGENT_INSTALL_UV
	try {
		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
		$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "1"
		$env:PRIME_AGENT_INSTALL_UV = "1"
		& npm.cmd install -g --no-fund --no-audit --loglevel=error --progress=false $tarballPath
		if ($LASTEXITCODE -ne 0) {
			throw "npm install failed with exit code $LASTEXITCODE."
		}
	} finally {
		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = $previousToolsBootstrap
		$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = $previousKernelBootstrap
		$env:PRIME_AGENT_INSTALL_UV = $previousInstallUv
	}
} finally {
	Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Prime Agent v$version installed successfully."
Write-Host "Run it with: prime-agent"
