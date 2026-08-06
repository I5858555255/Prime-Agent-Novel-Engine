#Requires -Version 5.1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$unconfiguredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE" + "_URL__"
$unconfiguredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_" + "CHANNEL__"
$configuredBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_URL__"
$configuredDefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"

$baseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) { $env:PRIME_AGENT_DOWNLOAD_BASE_URL } else { $configuredBaseUrl }
$baseUrl = $baseUrl.TrimEnd("/")
if ($baseUrl -eq $unconfiguredBaseUrl) {
    throw "Installer download URL is not configured. Set PRIME_AGENT_DOWNLOAD_BASE_URL or use published installer."
}

$defaultChannel = if ($configuredDefaultChannel -eq $unconfiguredDefaultChannel) { "stable" } else { $configuredDefaultChannel }
$releaseChannel = if ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $defaultChannel }
$packageName = if ($env:PRIME_AGENT_PACKAGE) { $env:PRIME_AGENT_PACKAGE } else { "prime-agent" }
$commandName = if ($env:PRIME_AGENT_CMD) { $env:PRIME_AGENT_CMD } else { "prime-agent" }
$minimumNodeVersion = [version]"22.8.0"
$ProgressPreference = "SilentlyContinue"

$escape = [char]27
$reset = "$escape[0m"
$bold = "$escape[1m"
$hideCursor = "$escape[?25l"
$showCursor = "$escape[?25h"
$homeCursor = "$escape[H"
$clearScreen = "$escape[2J$escape[H"
$clearLine = "$escape[K"
$syncStart = "$escape[?2026h"
$syncEnd = "$escape[?2026l"
$colorText = "$escape[38;2;244;244;245m"
$colorMuted = "$escape[38;2;161;161;170m"
$colorDim = "$escape[38;2;113;113;122m"
$colorPrimary = "$escape[38;2;127;91;213m"
$colorScan = "$escape[38;2;14;165;233m"
$colorWarning = "$escape[38;2;245;158;11m"

$script:InstallerScreenEnabled = $false
$script:InstallerScreenFrame = 0
$script:InstallerScreenCols = 80
$script:InstallerScreenRows = 24
$script:InstallerScreenDrawn = $false
$script:InstallerScreenLastCols = 0
$script:InstallerScreenLastRows = 0
$script:InstallerScreenLayoutReady = $false
$script:InstallerScreenLayoutShowLogo = $false
$script:InstallerScreenLayoutLabWidth = 0
$script:InstallerScreenRenderLabWidth = 0
$script:InstallerScreenCompact = $false
$script:InstallerScreenTitle = ""
$script:InstallerScreenDetail = ""
$script:InstallerScreenQuestion = ""
$script:InstallerAnimationFrame = 0
$script:InstallerDownloadDir = $null
$script:InstallerOriginalOutputEncoding = $null

function Write-InstallerMessage {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)

    Write-Information $Message -InformationAction Continue
}

function Write-InstallerTerminal {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute("PSAvoidUsingWriteHost", "", Justification = "Installer TUI requires direct terminal control.")]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    [Console]::Write($Text)
}

function Test-InstallerScreenAvailable {
    if ($env:PRIME_AGENT_INSTALLER_PLAIN -eq "1") { return $false }
    if ($env:TERM -eq "dumb") { return $false }
    try {
        if ([Console]::IsOutputRedirected) { return $false }
    }
    catch {
        Write-Verbose "Could not inspect console redirection."
    }

    try {
        if (-not $Host.UI.SupportsVirtualTerminal -and -not $env:WT_SESSION) { return $false }
    }
    catch {
        if (-not $env:WT_SESSION) { return $false }
    }
    return $true
}

function Initialize-InstallerScreen {
    $script:InstallerScreenEnabled = Test-InstallerScreenAvailable
    if ($script:InstallerScreenEnabled) {
        try {
            $script:InstallerOriginalOutputEncoding = [Console]::OutputEncoding
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        }
        catch {
            Write-Verbose "Could not enable UTF-8 terminal output."
        }
    }
}

function Restore-InstallerTerminal {
    if ($script:InstallerScreenEnabled) {
        Write-InstallerTerminal "$reset$showCursor"
    }
    if ($script:InstallerOriginalOutputEncoding) {
        try {
            [Console]::OutputEncoding = $script:InstallerOriginalOutputEncoding
        }
        catch {
            Write-Verbose "Could not restore terminal output encoding."
        }
        $script:InstallerOriginalOutputEncoding = $null
    }
}

function Read-InstallerTerminalSize {
    $cols = 80
    $rows = 24
    try {
        $size = $Host.UI.RawUI.WindowSize
        if ($size.Width -gt 0) { $cols = $size.Width }
        if ($size.Height -gt 0) { $rows = $size.Height }
    }
    catch {
        Write-Verbose "Could not read terminal dimensions."
    }
    $script:InstallerScreenCols = [math]::Max($cols, 1)
    $script:InstallerScreenRows = [math]::Max($rows, 1)
}

function Get-IntegerQuotient {
    param(
        [Parameter(Mandatory)][int]$Dividend,
        [Parameter(Mandatory)][int]$Divisor
    )

    return [int][math]::Truncate($Dividend / $Divisor)
}

function Test-InstallerTerminalSupportsLogo {
    return $script:InstallerScreenRows -ge 22 -and $script:InstallerScreenCols -ge 42
}

function Get-InstallerLabWidth {
    param([Parameter(Mandatory)][int]$Cols)

    $width = $Cols - 6
    $width = [math]::Min($width, 78)
    $width = [math]::Max($width, 42)
    $maxSafeWidth = [math]::Max($Cols - 1, 1)
    $width = [math]::Min($width, $maxSafeWidth)
    return [math]::Max($width, 32)
}

function Initialize-InstallerScreenLayout {
    if ($script:InstallerScreenLayoutReady) { return }

    $script:InstallerScreenLayoutReady = $true
    $script:InstallerScreenLayoutShowLogo = $false
    $script:InstallerScreenLayoutLabWidth = 0
    $script:InstallerScreenRenderLabWidth = 0
    if (Test-InstallerTerminalSupportsLogo) {
        $script:InstallerScreenLayoutShowLogo = $true
        $script:InstallerScreenLayoutLabWidth = Get-InstallerLabWidth $script:InstallerScreenCols
    }
}

function Select-InstallerScreenLayoutMode {
    $script:InstallerScreenCompact = $false
    $script:InstallerScreenRenderLabWidth = 0
    if (-not $script:InstallerScreenLayoutShowLogo) { return }
    if ($script:InstallerScreenRows -lt 17) {
        $script:InstallerScreenCompact = $true
        return
    }

    $maxSafeWidth = $script:InstallerScreenCols - 1
    if ($maxSafeWidth -lt 32) {
        $script:InstallerScreenCompact = $true
        return
    }
    $script:InstallerScreenRenderLabWidth = [math]::Min($script:InstallerScreenLayoutLabWidth, $maxSafeWidth)
}

function Test-InstallerLogoVisible {
    return $script:InstallerScreenLayoutShowLogo -and
    -not $script:InstallerScreenCompact -and
    $script:InstallerScreenRenderLabWidth -ge 32
}

function Get-InstallerLogoLine {
    param([Parameter(Mandatory)][int]$Row)

    switch ($Row) {
        2 { return "                          ▄▄███▀" }
        3 { return "    ▄▄▄▄▄              ▄█████▀" }
        4 { return "    ██████▄         ▄██████▀" }
        5 { return "   ▄███▀███▄     ▄███▀▄██▀" }
        6 { return "   ███ ▄████▄▄▄████▀▄▄██" }
        7 { return "  ▀██  ▀█████████▀▀▀▀▀▀" }
        8 { return "  ▄██   ██████▀▀ ▄███" }
        9 { return " █████    ▀█▄▄▄█████▀" }
        10 { return "███████▄  ████████▀" }
        11 { return "▀███▀▀    █████▀" }
        default { return "" }
    }
}

function Get-InstallerLabCell {
    param(
        [Parameter(Mandatory)][int]$X,
        [Parameter(Mandatory)][int]$Y,
        [Parameter(Mandatory)][int]$Width
    )

    $height = 14
    $frame = $script:InstallerScreenFrame
    $char = " "
    $style = ""
    $hash = ($X * 37 + $Y * 53 + $frame * 11 + $X * $Y * 3) % 101
    if ($hash -lt 3) {
        $char = "·"
        $style = $colorDim
    }

    $centerX = Get-IntegerQuotient ($Width * 36) 100
    $centerY = Get-IntegerQuotient ($height * 54) 100
    $dx = [math]::Abs($X - $centerX)
    $dy = [math]::Abs($Y - $centerY)
    $contour = $dx + $dy * 4 + (Get-IntegerQuotient $X 6) - $frame
    $contourMod = (($contour % 24) + 24) % 24
    if ($X -lt (Get-IntegerQuotient ($Width * 82) 100) -and $contourMod -eq 12) {
        $char = if ((($X + $Y) % 5) -eq 0) { "╌" } else { "·" }
        $style = $colorDim
    }

    $horizonY = Get-IntegerQuotient ($height * 58) 100
    if ($Y -eq $horizonY -and ($X % 2) -eq 0 -and (($X + $frame) % 13) -lt 2) {
        $char = "─"
        $style = if ($X -gt (Get-IntegerQuotient ($Width * 60) 100)) { $colorPrimary } else { $colorDim }
    }

    $scanStart = Get-IntegerQuotient $Width 2
    if ($X -ge $scanStart) {
        $scanOffset = $X - $scanStart
        if (($scanOffset % 5) -eq 0) {
            $scanIndex = Get-IntegerQuotient $scanOffset 5
            $scanTop = 1 + (($scanIndex + (Get-IntegerQuotient $frame 3)) % 3)
            $scanBottom = $height - 2 - (($scanIndex * 2 + (Get-IntegerQuotient $frame 4)) % 3)
            if ($Y -ge $scanTop -and $Y -le $scanBottom -and (($Y + $scanIndex + $frame) % 6) -ne 0) {
                $char = if ((($scanIndex + $Y) % 4) -eq 0) { "┃" } else { "╎" }
                $style = $colorScan
            }
        }
    }

    for ($traceIndex = 0; $traceIndex -lt 3; $traceIndex += 1) {
        $base = switch ($traceIndex) {
            0 { Get-IntegerQuotient ($height * 30) 100 }
            1 { Get-IntegerQuotient ($height * 49) 100 }
            default { Get-IntegerQuotient ($height * 72) 100 }
        }
        $wave = ($X * 2 + $frame + $traceIndex * 7) % 16
        if ($wave -gt 7) { $wave = 15 - $wave }
        $traceY = $base + (Get-IntegerQuotient ($wave - 3) 2)
        if ($Y -eq $traceY) {
            if ((($X + $frame + $traceIndex * 13) % 41) -eq 0) {
                $char = "◆"
                $style = $colorWarning
            }
            elseif ((($X + $frame) % 12) -eq 0) {
                $char = "•"
                $style = $colorPrimary
            }
            else {
                $char = "·"
                $style = $colorPrimary
            }
        }
    }
    return [pscustomobject]@{ Char = $char; Style = $style }
}

function Get-InstallerLabBackgroundRange {
    param(
        [Parameter(Mandatory)][int]$Row,
        [Parameter(Mandatory)][int]$Start,
        [Parameter(Mandatory)][int]$End,
        [Parameter(Mandatory)][int]$Width
    )

    $activeStyle = ""
    $line = [Text.StringBuilder]::new()
    for ($x = $Start; $x -lt $End; $x += 1) {
        $cell = Get-InstallerLabCell -X $x -Y $Row -Width $Width
        if ($cell.Style -ne $activeStyle) {
            if ($activeStyle) { [void]$line.Append($reset) }
            if ($cell.Style) { [void]$line.Append($cell.Style) }
            $activeStyle = $cell.Style
        }
        [void]$line.Append($cell.Char)
    }
    if ($activeStyle) { [void]$line.Append($reset) }
    return $line.ToString()
}

function Get-InstallerLabLine {
    param([Parameter(Mandatory)][int]$Row)

    $width = $script:InstallerScreenRenderLabWidth
    $logoLine = Get-InstallerLogoLine $Row
    if ($logoLine) {
        $logoStart = Get-IntegerQuotient ($width - 32) 2
        $logoEnd = $logoStart + 32
        $left = Get-InstallerLabBackgroundRange -Row $Row -Start 0 -End $logoStart -Width $width
        $right = Get-InstallerLabBackgroundRange -Row $Row -Start $logoEnd -End $width -Width $width
        return "$left$colorText$logoLine$reset$right"
    }
    return Get-InstallerLabBackgroundRange -Row $Row -Start 0 -End $width -Width $width
}

function Get-InstallerFittedText {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory)][int]$MaxWidth
    )

    if ($Text.Length -le $MaxWidth) { return $Text }
    if ($MaxWidth -le 3) { return $Text.Substring(0, $MaxWidth) }
    return "$($Text.Substring(0, $MaxWidth - 3))..."
}

function Get-InstallerPrimaryText {
    if (-not $script:InstallerScreenQuestion) { return $script:InstallerScreenTitle }
    if ($script:InstallerScreenQuestion -like "*[Y/n]*") {
        return "$($script:InstallerScreenTitle) [Y/n] >"
    }
    return "$($script:InstallerScreenTitle) $($script:InstallerScreenQuestion)"
}

function Get-InstallerStyledTitle {
    param([Parameter(Mandatory)][string]$Title)

    if ($Title.Contains("Prime Agent")) {
        return "$bold$colorPrimary$($Title.Replace('Prime Agent', "${bold}${colorPrimary}PRIME Agent${reset}${bold}${colorPrimary}"))$reset"
    }
    return "$bold$colorPrimary$Title$reset"
}

function Get-InstallerContentHeight {
    return 2 + $(if (Test-InstallerLogoVisible) { 15 } else { 0 })
}

function Get-InstallerContentLine {
    param([Parameter(Mandatory)][int]$Index)

    if (Test-InstallerLogoVisible) {
        if ($Index -ge 0 -and $Index -le 13) {
            return [pscustomobject]@{ Text = Get-InstallerLabLine $Index; Width = $script:InstallerScreenRenderLabWidth }
        }
        if ($Index -eq 14) { return [pscustomobject]@{ Text = ""; Width = 0 } }
        $Index -= 15
    }
    if ($Index -lt 0) { return $null }

    $maxWidth = [math]::Max($script:InstallerScreenCols - 4, 1)
    if ($Index -eq 0) {
        if ($script:InstallerScreenQuestion) {
            $text = Get-InstallerFittedText -Text (Get-InstallerPrimaryText) -MaxWidth $maxWidth
            return [pscustomobject]@{ Text = "$bold$colorText$text$reset"; Width = $text.Length }
        }
        $text = Get-InstallerFittedText -Text $script:InstallerScreenTitle -MaxWidth $maxWidth
        return [pscustomobject]@{ Text = Get-InstallerStyledTitle $text; Width = $text.Length }
    }
    if ($Index -eq 1) {
        if ($script:InstallerScreenQuestion) {
            $text = Get-InstallerFittedText -Text "Press Enter to continue; type n to cancel." -MaxWidth $maxWidth
            return [pscustomobject]@{ Text = "$colorMuted$text$reset"; Width = $text.Length }
        }
        if ($script:InstallerScreenDetail) {
            $text = Get-InstallerFittedText -Text $script:InstallerScreenDetail -MaxWidth $maxWidth
            return [pscustomobject]@{ Text = "$colorMuted$text$reset"; Width = $text.Length }
        }
        return [pscustomobject]@{ Text = ""; Width = 0 }
    }
    return $null
}

function Get-InstallerCenteredLine {
    param([AllowNull()][object]$Content)

    if (-not $Content) {
        $left = Get-IntegerQuotient $script:InstallerScreenCols 2
        return "$(' ' * $left)$clearLine"
    }
    $left = [math]::Max((Get-IntegerQuotient ($script:InstallerScreenCols - $Content.Width) 2), 0)
    return "$(' ' * $left)$($Content.Text)$clearLine"
}

function Get-InstallerScreenFrameText {
    $contentHeight = Get-InstallerContentHeight
    $top = [math]::Max((Get-IntegerQuotient ($script:InstallerScreenRows - $contentHeight) 2), 0)
    $lines = [Collections.Generic.List[string]]::new()
    for ($y = 0; $y -lt $script:InstallerScreenRows; $y += 1) {
        $content = Get-InstallerContentLine ($y - $top)
        $lines.Add((Get-InstallerCenteredLine $content))
    }
    return $lines -join "`n"
}

function Show-InstallerScreen {
    param(
        [Parameter(Mandatory)][string]$Title,
        [AllowEmptyString()][string]$Detail = "",
        [AllowEmptyString()][string]$Question = ""
    )

    if (-not $script:InstallerScreenEnabled) { return }
    $script:InstallerScreenTitle = $Title
    $script:InstallerScreenDetail = $Detail
    $script:InstallerScreenQuestion = $Question
    $script:InstallerScreenFrame += 1
    Read-InstallerTerminalSize
    Initialize-InstallerScreenLayout
    Select-InstallerScreenLayoutMode

    $resized = $script:InstallerScreenCols -ne $script:InstallerScreenLastCols -or
    $script:InstallerScreenRows -ne $script:InstallerScreenLastRows
    $prefix = if (-not $script:InstallerScreenDrawn -or $resized) {
        $script:InstallerScreenDrawn = $true
        $script:InstallerScreenLastCols = $script:InstallerScreenCols
        $script:InstallerScreenLastRows = $script:InstallerScreenRows
        "$reset$clearScreen$hideCursor"
    }
    else {
        "$reset$homeCursor$hideCursor"
    }
    Write-InstallerTerminal "$syncStart$prefix$(Get-InstallerScreenFrameText)$syncEnd"
}

function Show-InstallerPromptCursor {
    if (-not $script:InstallerScreenEnabled) { return }
    $maxWidth = [math]::Max($script:InstallerScreenCols - 4, 1)
    $promptText = Get-InstallerFittedText -Text (Get-InstallerPrimaryText) -MaxWidth $maxWidth
    $contentHeight = Get-InstallerContentHeight
    $top = [math]::Max((Get-IntegerQuotient ($script:InstallerScreenRows - $contentHeight) 2), 0)
    $promptIndex = if (Test-InstallerLogoVisible) { 15 } else { 0 }
    $row = $top + $promptIndex + 1
    $col = (Get-IntegerQuotient ($script:InstallerScreenCols - $promptText.Length) 2) + $promptText.Length + 2
    $col = [math]::Max([math]::Min($col, $script:InstallerScreenCols), 1)
    Write-InstallerTerminal "$reset$showCursor$escape[$row;${col}H"
}

function Confirm-PrimeAgentAction {
    param(
        [Parameter(Mandatory)][string]$Message,
        [AllowEmptyString()][string]$Detail = ""
    )

    if ($script:InstallerScreenEnabled -and -not [Console]::IsInputRedirected) {
        Show-InstallerScreen -Title $Message -Detail $Detail -Question "[Y/n]"
        Show-InstallerPromptCursor
        $answer = [Console]::ReadLine()
    }
    else {
        $answer = Read-Host "$Message [Y/n]"
    }
    return $answer -notmatch "^(n|no)$"
}

function Get-InstallerPulse {
    switch ($script:InstallerScreenFrame % 4) {
        0 { return "." }
        1 { return ".." }
        2 { return "..." }
        default { return "" }
    }
}

function Get-InstallerAnimationDetail {
    param([Parameter(Mandatory)][string[]]$Details)

    if ($Details.Count -eq 0) { return "" }
    $frame = [math]::Max($script:InstallerAnimationFrame, 1)
    $index = [math]::Min((Get-IntegerQuotient ($frame - 1) 24), $Details.Count - 1)
    return $Details[$index]
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Argument)

    if ($Argument -notmatch '[\s"]') { return $Argument }
    $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return "`"$escaped`""
}

function Invoke-InstallerNativeCommand {
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string[]]$Details,
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    if (-not $script:InstallerScreenEnabled) {
        Write-InstallerMessage "$Status..."
        & $FilePath @Arguments 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "$Status failed with exit code $LASTEXITCODE." }
        return
    }

    $argumentLine = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " "
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    if ([IO.Path]::GetExtension($FilePath) -in @(".cmd", ".bat")) {
        $commandLine = "$(ConvertTo-NativeArgument $FilePath) $argumentLine"
        $startInfo.FileName = $env:ComSpec
        $startInfo.Arguments = "/d /s /c `"$commandLine`""
    }
    else {
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $argumentLine
    }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $script:InstallerAnimationFrame = 0
        while (-not $process.WaitForExit(180)) {
            $script:InstallerAnimationFrame += 1
            Show-InstallerScreen -Title "$Title$(Get-InstallerPulse)" -Detail (Get-InstallerAnimationDetail $Details)
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            Restore-InstallerTerminal
            if ($stdout) { [Console]::Error.Write($stdout) }
            if ($stderr) { [Console]::Error.Write($stderr) }
            throw "$Status failed with exit code $($process.ExitCode)."
        }
    }
    finally {
        if (-not $process.HasExited) {
            try { $process.Kill() } catch { Write-Verbose "Could not stop interrupted installer child process." }
        }
        $process.Dispose()
    }
}

function Invoke-InstallerDownload {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$OutFile,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Detail
    )

    if (-not $script:InstallerScreenEnabled) {
        Write-InstallerMessage "$Status..."
        Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
        return
    }

    Add-Type -AssemblyName System.Net.Http
    $client = [Net.Http.HttpClient]::new()
    try {
        $task = $client.GetByteArrayAsync($Uri)
        while (-not $task.Wait(180)) {
            Show-InstallerScreen -Title "$Title$(Get-InstallerPulse)" -Detail $Detail
        }
        [IO.File]::WriteAllBytes($OutFile, $task.GetAwaiter().GetResult())
    }
    finally {
        $client.Dispose()
    }
}

function Get-PrimeAgentCommand {
    param([Parameter(Mandatory)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    return $null
}

function Install-WithWinget {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Name
    )

    $winget = Get-PrimeAgentCommand @("winget.exe", "winget")
    if (-not $winget) { throw "$Name is required. Install it manually because winget is unavailable." }

    $details = @(
        "Using winget.",
        "Resolving packages.",
        "Downloading $Name.",
        "Installing $Name.",
        "Refreshing your PATH."
    )
    Invoke-InstallerNativeCommand -Title "Installing $Name" -Status "Installing $Name" -Details $details `
        -FilePath $winget -Arguments @("install", "--id", $Id, "--exact", "--accept-package-agreements", "--accept-source-agreements")
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($machinePath, $userPath) -join ";"
}

function Get-NodeCommand {
    $node = Get-PrimeAgentCommand @("node.exe", "node")
    if (-not $node) { return $null }
    $versionText = (& $node --version).Trim().TrimStart("v")
    if ($LASTEXITCODE -ne 0) { return $null }
    $version = $null
    if (-not [version]::TryParse($versionText, [ref]$version)) { return $null }
    if ($version -lt $minimumNodeVersion) { return $null }
    return $node
}

function Initialize-NodeAndNpm {
    $node = Get-NodeCommand
    $npm = Get-PrimeAgentCommand @("npm.cmd", "npm")
    if ($node -and $npm) { return $npm }

    if (-not (Confirm-PrimeAgentAction -Message "Install Node.js and npm with winget?" -Detail "Required before Prime Agent can be installed.")) {
        throw "Prime Agent requires Node.js $minimumNodeVersion or newer and npm."
    }
    Install-WithWinget -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS"
    $node = Get-NodeCommand
    $npm = Get-PrimeAgentCommand @("npm.cmd", "npm")
    if (-not $node -or -not $npm) {
        throw "Node.js installation completed, but Node.js $minimumNodeVersion or newer and npm are unavailable. Restart PowerShell and run installer again."
    }
    return $npm
}

function Find-Bash {
    $settingsPath = Join-Path $HOME ".prime\agent\settings.json"
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        try {
            $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
            if ($settings.shellPath -and (Test-Path -LiteralPath $settings.shellPath -PathType Leaf)) {
                return [string]$settings.shellPath
            }
        }
        catch {
            Write-Verbose "Ignoring invalid Prime Agent settings while locating bash."
        }
    }
    $gitBash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
    if (Test-Path -LiteralPath $gitBash -PathType Leaf) { return $gitBash }
    return Get-PrimeAgentCommand @("bash.exe", "bash")
}

function Initialize-Bash {
    if (Find-Bash) { return }
    if (-not (Confirm-PrimeAgentAction -Message "Install Git for Windows with winget?" -Detail "Prime Agent requires Git Bash or another bash shell.")) {
        throw "Prime Agent requires Git Bash, Cygwin, MSYS2, or WSL on Windows."
    }
    Install-WithWinget -Id "Git.Git" -Name "Git for Windows"
    if (-not (Find-Bash)) {
        throw "Git installation completed, but bash.exe was not found. Restart PowerShell and run installer again."
    }
}

function ConvertTo-PrimeAgentVersion {
    param([Parameter(Mandatory)][string]$Version)

    $normalized = $Version.Trim().TrimStart("v")
    if ($normalized -notmatch "^[0-9A-Za-z.-]+$") { throw "Invalid Prime Agent version: $Version" }
    return $normalized
}

function Resolve-PrimeAgentVersion {
    param([string]$RequestedRelease)

    if ($RequestedRelease -and $RequestedRelease -notin @("stable", "beta")) {
        return ConvertTo-PrimeAgentVersion $RequestedRelease
    }
    $channel = if ($RequestedRelease) { $RequestedRelease } else { $releaseChannel }
    if ($channel -notin @("stable", "beta")) { throw "Invalid Prime Agent release channel: $channel" }
    if ($env:PRIME_AGENT_VERSION) { return ConvertTo-PrimeAgentVersion $env:PRIME_AGENT_VERSION }

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-channel-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    try {
        $channelPath = Join-Path $tempDir $channel
        Invoke-InstallerDownload -Uri "$baseUrl/$channel" -OutFile $channelPath -Title "Resolving latest release" `
            -Status "Resolving latest release" -Detail "Checking the $channel release channel."
        return ConvertTo-PrimeAgentVersion (Get-Content -LiteralPath $channelPath -Raw)
    }
    finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-PrimeAgentChecksum {
    param(
        [Parameter(Mandatory)][string]$ChecksumsPath,
        [Parameter(Mandatory)][string]$TarballPath
    )

    $tarballName = Split-Path $TarballPath -Leaf
    $escapedName = [regex]::Escape($tarballName)
    $checksumLine = Get-Content -LiteralPath $ChecksumsPath | Where-Object {
        $_ -match "^([0-9A-Fa-f]{64})\s+\*?$escapedName$"
    } | Select-Object -First 1
    if (-not $checksumLine) { throw "Checksum for $tarballName was not found." }

    $expected = ([regex]::Match($checksumLine, "^[0-9A-Fa-f]{64}")).Value.ToUpperInvariant()
    $stream = [IO.File]::OpenRead($TarballPath)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    if ($actual -ne $expected) { throw "Checksum verification failed for $tarballName." }
}

function Install-PrimeAgentPackage {
    param(
        [Parameter(Mandatory)][string]$Npm,
        [Parameter(Mandatory)][string]$TarballPath,
        [Parameter(Mandatory)][bool]$BootstrapKernel
    )

    $previousTools = $env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL
    $previousKernel = $env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL
    $previousUv = $env:PRIME_AGENT_INSTALL_UV
    try {
        $env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
        if ($BootstrapKernel) {
            $env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "1"
            $env:PRIME_AGENT_INSTALL_UV = "1"
        }
        $details = @(
            "Preparing global install.",
            "Linking command binaries.",
            "Installing runtime packages.",
            "Preloading search tools.",
            $(if ($BootstrapKernel) { "Preparing IPython kernel." } else { "Finalizing npm install." }),
            "Finalizing npm install."
        )
        $arguments = @("install", "-g", "--no-fund", "--no-audit", "--loglevel=error", "--progress=false", $TarballPath)
        Invoke-InstallerNativeCommand -Title "Installing Prime Agent" -Status "Installing Prime Agent" `
            -Details $details -FilePath $Npm -Arguments $arguments
    }
    finally {
        $env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = $previousTools
        $env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = $previousKernel
        $env:PRIME_AGENT_INSTALL_UV = $previousUv
    }
}

function Invoke-PrimeAgentInstaller {
    param([object[]]$RequestedArguments = @())

    if ($env:OS -ne "Windows_NT") { throw "install.ps1 supports Windows only." }
    if ($RequestedArguments.Count -gt 1) { throw "Usage: install.ps1 [stable|beta|version]" }

    Initialize-InstallerScreen
    if ($script:InstallerScreenEnabled) {
        Show-InstallerScreen -Title "Installing Prime Agent"
    }
    else {
        Write-InstallerMessage ""
        Write-InstallerMessage "  Installing Prime Agent"
        Write-InstallerMessage "  npm global install"
        Write-InstallerMessage ""
    }

    Show-InstallerScreen -Title "Checking Node.js and npm"
    $npmCommand = Initialize-NodeAndNpm
    Initialize-Bash
    Show-InstallerScreen -Title "Environment ready" -Detail "Node.js, npm, and bash are available."

    $requestedRelease = if ($RequestedArguments.Count -eq 1) { [string]$RequestedArguments[0] } else { $null }
    $version = Resolve-PrimeAgentVersion $requestedRelease
    $tarballName = "$packageName-$version.tgz"
    $releaseUrl = "$baseUrl/releases/v$version"

    if (-not (Confirm-PrimeAgentAction -Message "Install Prime Agent v$version globally with npm?" `
                -Detail "Downloads the verified release and runs npm install -g.")) {
        Show-InstallerScreen -Title "Installation cancelled" -Detail "No changes were made."
        if (-not $script:InstallerScreenEnabled) { Write-InstallerMessage "Installation cancelled." }
        return
    }

    $bootstrapKernel = if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq "1") {
        $true
    }
    elseif ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq "0") {
        $false
    }
    else {
        Confirm-PrimeAgentAction -Message "Prepare IPython runtime now?" `
            -Detail "Installs uv, Python 3.11, ipykernel, and Prime Agent runtime."
    }

    $script:InstallerDownloadDir = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $script:InstallerDownloadDir | Out-Null
    $checksumsPath = Join-Path $script:InstallerDownloadDir "SHA256SUMS"
    $tarballPath = Join-Path $script:InstallerDownloadDir $tarballName

    Invoke-InstallerDownload -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumsPath -Title "Downloading checksums" `
        -Status "Downloading release checksums" -Detail "Prime Agent v$version"
    Invoke-InstallerDownload -Uri "$releaseUrl/$tarballName" -OutFile $tarballPath -Title "Downloading Prime Agent" `
        -Status "Downloading Prime Agent v$version" -Detail "Fetching the verified package."
    Show-InstallerScreen -Title "Verifying download" -Detail "Checking SHA-256."
    Assert-PrimeAgentChecksum -ChecksumsPath $checksumsPath -TarballPath $tarballPath
    Install-PrimeAgentPackage -Npm $npmCommand -TarballPath $tarballPath -BootstrapKernel $bootstrapKernel

    Remove-Item -LiteralPath $script:InstallerDownloadDir -Recurse -Force
    $script:InstallerDownloadDir = $null
    if (Get-Command $commandName -ErrorAction SilentlyContinue) {
        Show-InstallerScreen -Title "Prime Agent installed" -Detail "Run it with: $commandName"
        if (-not $script:InstallerScreenEnabled) {
            Write-InstallerMessage ""
            Write-InstallerMessage "Prime Agent v$version installed."
            Write-InstallerMessage "Run it with: $commandName"
        }
    }
    else {
        Show-InstallerScreen -Title "Prime Agent installed" -Detail "Restart PowerShell, then run: $commandName"
        if (-not $script:InstallerScreenEnabled) {
            Write-InstallerMessage "Prime Agent v$version installed, but $commandName is not on PATH yet."
            Write-InstallerMessage "Restart PowerShell, then run: $commandName"
        }
    }
}

try {
    Invoke-PrimeAgentInstaller -RequestedArguments @($args)
}
finally {
    if ($script:InstallerDownloadDir -and (Test-Path -LiteralPath $script:InstallerDownloadDir)) {
        Remove-Item -LiteralPath $script:InstallerDownloadDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Restore-InstallerTerminal
}


