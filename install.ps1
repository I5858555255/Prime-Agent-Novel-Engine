[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[string] $ChannelOrVersion
)

# The installer body runs inside this script block so `irm ... | iex` cannot leak
# its helpers, variables, strict mode, or preference changes into the caller's session.
& {
	param([string] $ChannelOrVersion)

	Set-StrictMode -Version Latest
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'

	if ($PSVersionTable.PSVersion.Major -lt 6) {
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	}

	# Keep these sentinels split so release publishing only rewrites the configured
	# values below; local or unpublished copies still need unreplaced values to compare.
	$PrimeAgentUnconfiguredBaseUrl = '__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'
	$PrimeAgentUnconfiguredDefaultReleaseChannel = '__PRIME_AGENT_DEFAULT_RELEASE_' + 'CHANNEL__'
	$PrimeAgentBaseUrl = '__PRIME_AGENT_DOWNLOAD_BASE_URL__'
	$PrimeAgentDefaultReleaseChannel = '__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__'

	if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) {
		$PrimeAgentBaseUrl = $env:PRIME_AGENT_DOWNLOAD_BASE_URL
	}
	$PrimeAgentBaseUrl = $PrimeAgentBaseUrl.TrimEnd('/')

	if ($PrimeAgentDefaultReleaseChannel -eq $PrimeAgentUnconfiguredDefaultReleaseChannel) {
		$PrimeAgentDefaultReleaseChannel = 'stable'
	}
	$PrimeAgentReleaseChannel = $PrimeAgentDefaultReleaseChannel
	if ($env:PRIME_AGENT_RELEASE_CHANNEL) {
		$PrimeAgentReleaseChannel = $env:PRIME_AGENT_RELEASE_CHANNEL
	}

	$PrimeAgentPackage = 'prime-agent'
	if ($env:PRIME_AGENT_PACKAGE) {
		$PrimeAgentPackage = $env:PRIME_AGENT_PACKAGE
	}

	$PrimeAgentCmd = 'prime-agent'
	if ($env:PRIME_AGENT_CMD) {
		$PrimeAgentCmd = $env:PRIME_AGENT_CMD
	}

	$PrimeAgentMinimumNodeVersion = [Version]'20.6.0'

	function Write-PrimeAgentLine {
		param([string] $Text = '')

		Write-Host $Text
	}

	function Write-PrimeAgentStep {
		param([string] $Text = '')

		Write-Host "  $Text"
	}

	function Write-PrimeAgentNote {
		param([string] $Text = '')

		Write-Host "  $Text" -ForegroundColor DarkGray
	}

	function Write-PrimeAgentWarning {
		param([string] $Text = '')

		Write-Host "  $Text" -ForegroundColor Yellow
	}

	function Write-PrimeAgentHeader {
		Write-PrimeAgentLine
		Write-Host '  Installing Prime Agent' -ForegroundColor Magenta
		Write-PrimeAgentNote 'npm global install'
		Write-PrimeAgentLine
	}

	function Test-PrimeAgentCanPrompt {
		try {
			if (-not [Environment]::UserInteractive) {
				return $false
			}
			if ([Console]::IsInputRedirected) {
				return $false
			}
		} catch {
			return $false
		}
		return $null -ne $Host.UI
	}

	function Read-PrimeAgentYesNo {
		param(
			[Parameter(Mandatory = $true)][string] $Question,
			[Parameter(Mandatory = $true)][string] $Detail
		)

		Write-PrimeAgentLine
		Write-PrimeAgentNote $Detail

		if (-not (Test-PrimeAgentCanPrompt)) {
			Write-PrimeAgentNote 'No terminal detected; continuing without confirmation.'
			return $true
		}

		$answer = $null
		try {
			$answer = Read-Host "  $Question [Y/n]"
		} catch {
			Write-PrimeAgentNote 'No terminal detected; continuing without confirmation.'
			return $true
		}

		if ($null -eq $answer) {
			$answer = ''
		}
		$answer = $answer.Trim().ToLowerInvariant()
		return -not ($answer -eq 'n' -or $answer -eq 'no')
	}

	function Get-PrimeAgentCommandPath {
		param([Parameter(Mandatory = $true)][string] $Name)

		$command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($command -and $command.Source) {
			return [string]$command.Source
		}
		return $null
	}

	function Get-PrimeAgentNpmPath {
		# npm ships as npm.cmd on Windows; the bare npm shim is a shell script that
		# PowerShell cannot execute, and npm.ps1 depends on the execution policy.
		foreach ($name in @('npm.cmd', 'npm.exe')) {
			$command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($command -and $command.Source) {
				return [string]$command.Source
			}
		}

		$command = Get-Command -Name 'npm' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($command -and $command.Source) {
			return [string]$command.Source
		}

		$command = Get-Command -Name 'npm' -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($command -and $command.Source) {
			$sibling = Join-Path (Split-Path -Parent ([string]$command.Source)) 'npm.cmd'
			if (Test-Path -LiteralPath $sibling) {
				return $sibling
			}
			return [string]$command.Source
		}

		return $null
	}

	function Get-PrimeAgentNodeVersion {
		$nodePath = Get-PrimeAgentCommandPath -Name 'node'
		if (-not $nodePath) {
			return $null
		}

		$output = $null
		try {
			$output = & $nodePath --version 2>&1 | Select-Object -First 1
		} catch {
			return $null
		}
		if (-not $output) {
			return $null
		}

		$match = [regex]::Match([string]$output, '(\d+)\.(\d+)\.(\d+)')
		if (-not $match.Success) {
			return $null
		}
		return [Version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$match.Groups[3].Value)
	}

	function Write-PrimeAgentNodeInstallHelp {
		Write-PrimeAgentWarning 'Install Node.js 20.6.0 or newer, then run this installer again.'
		Write-PrimeAgentLine
		Write-PrimeAgentStep 'With winget:'
		Write-PrimeAgentStep '  winget install OpenJS.NodeJS.LTS'
		Write-PrimeAgentLine
		Write-PrimeAgentStep 'Or download an installer from https://nodejs.org'
		Write-PrimeAgentNote 'Open a new terminal after installing so PATH picks up node and npm.'
		Write-PrimeAgentLine
	}

	function Test-PrimeAgentPrerequisites {
		$nodeVersion = Get-PrimeAgentNodeVersion
		if (-not $nodeVersion) {
			Write-PrimeAgentNodeInstallHelp
			throw 'Node.js 20.6.0 or newer is required to install Prime Agent.'
		}
		if ($nodeVersion -lt $PrimeAgentMinimumNodeVersion) {
			Write-PrimeAgentNodeInstallHelp
			throw "Prime Agent requires Node.js 20.6.0 or newer. Found v$nodeVersion."
		}

		if (-not (Get-PrimeAgentNpmPath)) {
			Write-PrimeAgentNodeInstallHelp
			throw 'npm is required to install Prime Agent.'
		}

		Write-PrimeAgentStep "Node.js v$nodeVersion detected."

		$existing = Get-PrimeAgentCommandPath -Name $PrimeAgentCmd
		if ($existing) {
			Write-PrimeAgentWarning "Existing $($PrimeAgentCmd) found at: $existing"
		}
	}

	function New-PrimeAgentTempDirectory {
		$path = Join-Path ([System.IO.Path]::GetTempPath()) "prime-agent-install-$([guid]::NewGuid().ToString('N'))"
		$null = New-Item -ItemType Directory -Path $path -Force
		return $path
	}

	function Save-PrimeAgentFile {
		param(
			[Parameter(Mandatory = $true)][string] $Uri,
			[Parameter(Mandatory = $true)][string] $Path
		)

		try {
			Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing
		} catch {
			throw "could not download $Uri`: $($_.Exception.Message)"
		}
	}

	function ConvertTo-PrimeAgentVersion {
		param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Version)

		$normalized = $Version.Trim()
		if ($normalized.StartsWith('v')) {
			$normalized = $normalized.Substring(1)
		}
		if (-not $normalized) {
			throw 'empty Prime Agent version.'
		}
		if ($normalized -notmatch '^[0-9A-Za-z.-]+$') {
			throw "invalid Prime Agent version: $Version"
		}
		return $normalized
	}

	function Resolve-PrimeAgentVersion {
		param([string] $ChannelOrVersion)

		$channel = $PrimeAgentReleaseChannel
		if ($ChannelOrVersion) {
			if ($ChannelOrVersion -eq 'stable' -or $ChannelOrVersion -eq 'beta') {
				$channel = $ChannelOrVersion
			} else {
				return ConvertTo-PrimeAgentVersion -Version $ChannelOrVersion
			}
		}

		if ($env:PRIME_AGENT_VERSION) {
			return ConvertTo-PrimeAgentVersion -Version $env:PRIME_AGENT_VERSION
		}

		if ($channel -ne 'stable' -and $channel -ne 'beta') {
			throw "invalid Prime Agent release channel: $channel"
		}

		$channelUrl = "$($PrimeAgentBaseUrl)/$channel"
		Write-PrimeAgentStep "Resolving the latest $channel release."

		$channelDir = New-PrimeAgentTempDirectory
		try {
			$channelPath = Join-Path $channelDir $channel
			Save-PrimeAgentFile -Uri $channelUrl -Path $channelPath
			$channelVersion = (Get-Content -LiteralPath $channelPath -Raw) -replace '\s', ''
		} finally {
			Remove-Item -LiteralPath $channelDir -Recurse -Force -ErrorAction SilentlyContinue
		}

		if (-not $channelVersion) {
			throw "could not resolve the latest Prime Agent version from $channelUrl"
		}
		return ConvertTo-PrimeAgentVersion -Version $channelVersion
	}

	function Test-PrimeAgentChecksum {
		param(
			[Parameter(Mandatory = $true)][string] $ChecksumsPath,
			[Parameter(Mandatory = $true)][string] $FilePath
		)

		$fileName = Split-Path -Leaf $FilePath
		$expected = $null
		foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
			$match = [regex]::Match($line, '^([0-9a-fA-F]{64})\s+\*?(.+)$')
			if ($match.Success -and $match.Groups[2].Value.Trim() -eq $fileName) {
				$expected = $match.Groups[1].Value
				break
			}
		}

		if (-not $expected) {
			throw "checksum for $fileName was not found in $ChecksumsPath"
		}

		$actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash
		if ($actual -ne $expected.ToUpperInvariant()) {
			throw "checksum mismatch for $fileName. Expected $($expected.ToLowerInvariant()), got $($actual.ToLowerInvariant())."
		}
		Write-PrimeAgentStep 'Verified the SHA-256 checksum.'
	}

	function Get-PrimeAgentKernelChoice {
		if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq '1') {
			return $true
		}
		if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq '0') {
			return $false
		}

		$prepare = Read-PrimeAgentYesNo `
			-Question 'Prepare IPython runtime now?' `
			-Detail 'Installs uv, Python 3.11, ipykernel, and the Prime Agent runtime.'
		if (-not $prepare) {
			Write-PrimeAgentNote 'Skipping IPython runtime setup; it is prepared on first ipython use.'
		}
		return $prepare
	}

	function Install-PrimeAgentPackage {
		param(
			[Parameter(Mandatory = $true)][string] $TarballPath,
			[switch] $BootstrapKernel
		)

		$npm = Get-PrimeAgentNpmPath
		if (-not $npm) {
			throw 'npm is required to install Prime Agent.'
		}

		$installEnv = @{ 'PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL' = '1' }
		if ($BootstrapKernel) {
			$installEnv['PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL'] = '1'
			$installEnv['PRIME_AGENT_INSTALL_UV'] = '1'
		}

		$previousEnv = @{}
		foreach ($name in @($installEnv.Keys)) {
			$previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
			[Environment]::SetEnvironmentVariable($name, $installEnv[$name], 'Process')
		}

		$npmArguments = @('install', '-g', '--no-fund', '--no-audit', '--loglevel=error', '--progress=false')
		try {
			$npmHelp = (& $npm install --help 2>$null | Out-String)
			if ($npmHelp -match '--allow-scripts') {
				$npmArguments += '--allow-scripts=prime-agent,zeromq,@google/genai,koffi,protobufjs'
			}
		} catch {
			# Older npm versions do not support per-package lifecycle-script approvals.
		}
		$npmArguments += $TarballPath

		Write-PrimeAgentStep 'Installing Prime Agent with npm.'
		$exitCode = 0
		try {
			& $npm @npmArguments
			$exitCode = $LASTEXITCODE
		} finally {
			foreach ($name in @($previousEnv.Keys)) {
				[Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
			}
		}

		if ($exitCode -ne 0) {
			throw "npm install -g failed with exit code $exitCode."
		}
	}

	function Get-PrimeAgentNpmPrefix {
		$npm = Get-PrimeAgentNpmPath
		if (-not $npm) {
			return $null
		}

		try {
			$prefix = & $npm config get prefix 2>$null | Select-Object -First 1
		} catch {
			return $null
		}
		if (-not $prefix) {
			return $null
		}
		return ([string]$prefix).Trim()
	}

	function Write-PrimeAgentCompletion {
		Write-PrimeAgentLine
		Write-PrimeAgentStep 'Prime Agent was installed successfully.'

		if (Get-PrimeAgentCommandPath -Name $PrimeAgentCmd) {
			Write-PrimeAgentStep "Run it with: $($PrimeAgentCmd)"
			Write-PrimeAgentLine
			return
		}

		$prefix = Get-PrimeAgentNpmPrefix
		Write-PrimeAgentLine
		Write-PrimeAgentWarning "The $($PrimeAgentCmd) command is not on your PATH yet."
		if ($prefix) {
			Write-PrimeAgentStep 'Add npm''s global bin directory to your PATH:'
			Write-PrimeAgentStep "  $prefix"
			Write-PrimeAgentLine
			Write-PrimeAgentStep 'For the current session:'
			Write-PrimeAgentStep "  `$env:Path = '$prefix;' + `$env:Path"
		} else {
			Write-PrimeAgentStep 'Find npm''s global bin directory with:'
			Write-PrimeAgentStep '  npm config get prefix'
			Write-PrimeAgentStep 'Then add that directory to your PATH.'
		}
		Write-PrimeAgentNote 'A new terminal also picks up PATH changes made by the Node.js installer.'
		Write-PrimeAgentLine
	}

	function Invoke-PrimeAgentInstall {
		param([string] $ChannelOrVersion)

		if ($PrimeAgentBaseUrl -eq $PrimeAgentUnconfiguredBaseUrl) {
			throw 'installer download URL is not configured. Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.'
		}

		Write-PrimeAgentHeader
		Test-PrimeAgentPrerequisites

		$version = Resolve-PrimeAgentVersion -ChannelOrVersion $ChannelOrVersion
		$tarballName = "$($PrimeAgentPackage)-$version.tgz"
		$releaseUrl = "$($PrimeAgentBaseUrl)/releases/v$version"
		$tarballUrl = "$releaseUrl/$tarballName"

		$install = Read-PrimeAgentYesNo `
			-Question "Install Prime Agent v$version globally with npm?" `
			-Detail "Downloads and verifies $tarballUrl, then runs npm install -g."
		if (-not $install) {
			Write-PrimeAgentLine
			Write-PrimeAgentStep 'Installation cancelled. No changes were made.'
			Write-PrimeAgentLine
			return
		}

		$bootstrapKernel = Get-PrimeAgentKernelChoice

		Write-PrimeAgentLine
		$downloadDir = New-PrimeAgentTempDirectory
		try {
			$tarballPath = Join-Path $downloadDir $tarballName
			$checksumsPath = Join-Path $downloadDir 'SHA256SUMS'

			Write-PrimeAgentStep "Downloading Prime Agent v$version."
			Save-PrimeAgentFile -Uri "$releaseUrl/SHA256SUMS" -Path $checksumsPath
			Save-PrimeAgentFile -Uri $tarballUrl -Path $tarballPath
			Test-PrimeAgentChecksum -ChecksumsPath $checksumsPath -FilePath $tarballPath
			Install-PrimeAgentPackage -TarballPath $tarballPath -BootstrapKernel:$bootstrapKernel
		} finally {
			Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
		}

		Write-PrimeAgentCompletion
	}

	Invoke-PrimeAgentInstall -ChannelOrVersion $ChannelOrVersion
} $ChannelOrVersion
