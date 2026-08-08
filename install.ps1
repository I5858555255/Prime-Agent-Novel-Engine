<#
.SYNOPSIS
	Installs Prime Agent on Windows.

.DESCRIPTION
	Windows counterpart of install.sh. It performs the same steps: preflight the
	Node.js/npm toolchain, resolve the release version for a channel, download the
	published tarball together with SHA256SUMS, verify the checksum, and install
	the package globally with npm.

.EXAMPLE
	irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex

.EXAMPLE
	powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.7.0
#>

[CmdletBinding()]
param(
	# Release channel ("stable"/"beta") or an explicit version such as "0.7.0".
	[Parameter(Position = 0)]
	[string] $Version,
	# Install without prompting. Implied when stdin is not an interactive console.
	[switch] $Yes,
	# Prepare the IPython runtime (uv + Python + ipykernel) during install.
	[switch] $BootstrapKernel,
	# Skip the IPython runtime preparation.
	[switch] $NoBootstrapKernel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
$UnconfiguredBaseUrl = '__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'
$UnconfiguredDefaultReleaseChannel = '__PRIME_AGENT_DEFAULT_RELEASE_' + 'CHANNEL__'

$BaseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) { $env:PRIME_AGENT_DOWNLOAD_BASE_URL } else { '__PRIME_AGENT_DOWNLOAD_BASE_URL__' }
$BaseUrl = $BaseUrl.TrimEnd('/')

$DefaultReleaseChannel = '__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__'
if ($DefaultReleaseChannel -eq $UnconfiguredDefaultReleaseChannel) { $DefaultReleaseChannel = 'stable' }

$ReleaseChannel = if ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $DefaultReleaseChannel }
$PackageName = if ($env:PRIME_AGENT_PACKAGE) { $env:PRIME_AGENT_PACKAGE } else { 'prime-agent' }
$CommandName = if ($env:PRIME_AGENT_CMD) { $env:PRIME_AGENT_CMD } else { 'prime-agent' }

# Matches the floor enforced by install.sh's preflight check.
$MinNodeVersion = [Version]'20.6.0'

function Write-Title($text) { Write-Host "`n  $text" -ForegroundColor White }
function Write-Step($text) { Write-Host "  $text" -ForegroundColor DarkGray }
function Write-Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  $text" -ForegroundColor Red }

function Test-Interactive {
	if ($Yes) { return $false }
	if ($env:PRIME_AGENT_NONINTERACTIVE -eq '1') { return $false }
	try { return -not [Console]::IsInputRedirected } catch { return $false }
}

function Read-YesNo($question, $detail) {
	if (-not (Test-Interactive)) { return $true }
	Write-Host ''
	Write-Host "  $question" -ForegroundColor White
	if ($detail) { Write-Step $detail }
	while ($true) {
		$answer = Read-Host '  [Y/n]'
		if ([string]::IsNullOrWhiteSpace($answer)) { return $true }
		switch -Regex ($answer.Trim()) {
			'^(y|yes)$' { return $true }
			'^(n|no)$' { return $false }
			default { Write-Step 'Please answer y or n.' }
		}
	}
}

function Resolve-CommandPath($name) {
	$command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($command) { return $command.Source }
	return $null
}

function Get-NodeVersion {
	$nodePath = Resolve-CommandPath 'node'
	if (-not $nodePath) { return $null }
	$raw = & $nodePath --version 2>$null
	if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
	$trimmed = ([string]$raw).Trim().TrimStart('v')
	# Strip prerelease/build metadata so [Version] can parse it.
	$core = ($trimmed -split '[-+]')[0]
	try { return [Version]$core } catch { return $null }
}

function Invoke-Preflight {
	$failed = $false

	$nodeVersion = Get-NodeVersion
	if (-not $nodeVersion) {
		Write-Fail "error: Node.js $MinNodeVersion or newer is required to install Prime Agent."
		Write-Step 'Install it from https://nodejs.org/en/download or with: winget install OpenJS.NodeJS.LTS'
		$failed = $true
	} elseif ($nodeVersion -lt $MinNodeVersion) {
		Write-Fail "error: Prime Agent requires Node.js $MinNodeVersion or newer. Found $nodeVersion."
		$failed = $true
	}

	if (-not (Resolve-CommandPath 'npm') -and -not (Resolve-CommandPath 'npm.cmd')) {
		Write-Fail 'error: npm is required to install Prime Agent.'
		$failed = $true
	}

	$existing = Resolve-CommandPath $CommandName
	if ($existing) { Write-Warn "Existing $CommandName found at: $existing" }

	return -not $failed
}

function Test-BashAvailable {
	# The agent shells out to bash for its Bash tool, so Git Bash (or an
	# equivalent) is a hard runtime requirement on Windows.
	foreach ($candidate in @(
			(Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
			(Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
			(Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
		)) {
		if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $true }
	}
	$onPath = Get-Command 'bash.exe' -CommandType Application -ErrorAction SilentlyContinue
	foreach ($command in @($onPath)) {
		if (-not $command) { continue }
		# C:\Windows\System32\bash.exe is the WSL launcher, which cannot run in a
		# Windows working directory; it does not count as a usable shell here.
		if ($command.Source -notlike "$env:SystemRoot\*") { return $true }
	}
	return $false
}

function ConvertTo-NormalizedVersion($value) {
	$candidate = ([string]$value).Trim().TrimStart('v')
	if ([string]::IsNullOrEmpty($candidate)) { throw 'error: empty Prime Agent version.' }
	if ($candidate -notmatch '^[0-9A-Za-z.\-]+$') { throw "error: invalid Prime Agent version: $value" }
	return $candidate
}

function Resolve-PrimeAgentVersion($requested) {
	if ($requested) {
		if ($requested -in @('stable', 'beta')) {
			$channel = $requested
		} else {
			return ConvertTo-NormalizedVersion $requested
		}
	} else {
		$channel = $ReleaseChannel
	}

	if ($env:PRIME_AGENT_VERSION) { return ConvertTo-NormalizedVersion $env:PRIME_AGENT_VERSION }

	if ($channel -notin @('stable', 'beta')) {
		throw "error: invalid Prime Agent release channel: $channel"
	}

	Write-Step "Resolving the $channel release channel."
	try {
		$response = Invoke-WebRequest -Uri "$BaseUrl/$channel" -UseBasicParsing
	} catch {
		throw "error: could not resolve latest Prime Agent version from $BaseUrl/$channel"
	}
	$channelVersion = ([string]$response.Content).Trim()
	if (-not $channelVersion) {
		throw "error: could not resolve latest Prime Agent version from $BaseUrl/$channel"
	}
	return ConvertTo-NormalizedVersion $channelVersion
}

function Save-Download($uri, $destination) {
	try {
		Invoke-WebRequest -Uri $uri -OutFile $destination -UseBasicParsing
	} catch {
		throw "error: could not download $uri"
	}
}

function Assert-Checksum($checksumsPath, $tarballPath) {
	$tarballName = Split-Path -Leaf $tarballPath
	$expected = $null
	foreach ($line in Get-Content -LiteralPath $checksumsPath) {
		# SHA256SUMS lines are "<hex>  <name>"; the name may carry a binary marker.
		$fields = ($line -split '\s+', 2)
		if ($fields.Count -lt 2) { continue }
		if ($fields[1].Trim().TrimStart('*') -eq $tarballName) { $expected = $fields[0].Trim(); break }
	}
	if (-not $expected) {
		throw "error: checksum for $tarballName was not found in $checksumsPath"
	}

	$actual = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash
	if ($actual -ne $expected.ToUpperInvariant()) {
		throw "error: checksum mismatch for $tarballName (expected $expected, got $actual)"
	}
	Write-Ok 'Verified SHA-256 checksum.'
}

function Install-PrimeAgentPackage($tarballPath, $bootstrapKernel) {
	$npm = Resolve-CommandPath 'npm.cmd'
	if (-not $npm) { $npm = Resolve-CommandPath 'npm' }
	if (-not $npm) { throw 'error: npm is required to install Prime Agent.' }

	$previous = @{
		PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL  = $env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL
		PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = $env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL
		PRIME_AGENT_INSTALL_UV                  = $env:PRIME_AGENT_INSTALL_UV
	}
	try {
		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = '1'
		if ($bootstrapKernel) {
			$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = '1'
			$env:PRIME_AGENT_INSTALL_UV = '1'
		}
		& $npm install -g --no-fund --no-audit --loglevel=error --progress=false $tarballPath
		if ($LASTEXITCODE -ne 0) { throw "error: npm install -g failed with exit code $LASTEXITCODE" }
	} finally {
		foreach ($key in $previous.Keys) {
			Set-Item -Path "Env:$key" -Value $previous[$key] -ErrorAction SilentlyContinue
			if (-not $previous[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
		}
	}
}

function Invoke-Main {
	if ($BaseUrl -eq $UnconfiguredBaseUrl) {
		Write-Fail 'error: installer download URL is not configured.'
		Write-Step 'Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.'
		exit 1
	}

	Write-Title 'Installing Prime Agent'
	Write-Step 'npm global install'

	if (-not (Invoke-Preflight)) { exit 1 }

	$resolvedVersion = Resolve-PrimeAgentVersion $Version
	$tarballName = "$PackageName-$resolvedVersion.tgz"
	$tarballUrl = "$BaseUrl/releases/v$resolvedVersion/$tarballName"
	$checksumsUrl = "$BaseUrl/releases/v$resolvedVersion/SHA256SUMS"

	if (-not (Read-YesNo "Install Prime Agent v$resolvedVersion globally with npm?" 'Downloads the verified release and runs npm install -g.')) {
		Write-Host ''
		Write-Host '  Installation cancelled.'
		exit 0
	}

	$bootstrapKernel = $true
	if ($NoBootstrapKernel) {
		$bootstrapKernel = $false
	} elseif ($BootstrapKernel) {
		$bootstrapKernel = $true
	} elseif ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq '0') {
		$bootstrapKernel = $false
	} elseif ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -ne '1') {
		$bootstrapKernel = Read-YesNo 'Prepare IPython runtime now?' 'Installs uv, Python 3.11, ipykernel, and Prime Agent runtime.'
	}

	$downloadDir = Join-Path ([System.IO.Path]::GetTempPath()) ("prime-agent-install-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
	New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
	try {
		$tarballPath = Join-Path $downloadDir $tarballName
		$checksumsPath = Join-Path $downloadDir 'SHA256SUMS'

		Write-Step 'Downloading release checksums.'
		Save-Download $checksumsUrl $checksumsPath
		Write-Step "Downloading Prime Agent v$resolvedVersion."
		Save-Download $tarballUrl $tarballPath
		Assert-Checksum $checksumsPath $tarballPath

		Write-Step 'Installing Prime Agent.'
		Install-PrimeAgentPackage $tarballPath $bootstrapKernel
	} finally {
		Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
	}

	Write-Host ''
	$installed = Resolve-CommandPath $CommandName
	if ($installed) {
		Write-Ok "Prime Agent installed: $installed"
	} else {
		Write-Warn "Prime Agent installed, but $CommandName is not on PATH yet."
		Write-Step 'Open a new terminal, or add the npm global bin directory to PATH:'
		Write-Step '  npm prefix -g'
	}

	if (-not (Test-BashAvailable)) {
		Write-Host ''
		Write-Warn 'No usable bash found. Prime Agent runs shell commands through bash on Windows.'
		Write-Step 'Install Git for Windows: https://git-scm.com/download/win'
		Write-Step 'Or set "shellPath" in ~/.prime/agent/settings.json to your bash.exe.'
	}

	Write-Host ''
	Write-Step "Start it from the directory you want it to work in: $CommandName"
	Write-Host ''
}

Invoke-Main
