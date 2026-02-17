Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeInput
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$MOUSEEVENTF_LEFTDOWN   = 0x0002
$MOUSEEVENTF_LEFTUP     = 0x0004
$MOUSEEVENTF_RIGHTDOWN  = 0x0008
$MOUSEEVENTF_RIGHTUP    = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP   = 0x0040
$MOUSEEVENTF_WHEEL      = 0x0800
$KEYEVENTF_KEYUP        = 0x0002
$script:DisplayBounds   = $null

function Clamp-01 {
    param([double]$Value)
    if ($Value -lt 0) { return 0.0 }
    if ($Value -gt 1) { return 1.0 }
    return $Value
}

function Try-ParseDouble {
    param($Value)
    $parsed = 0.0
    if ([double]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $null
}

function Resolve-DisplayBounds {
    param($Candidate)

    if ($null -eq $Candidate) { return $null }

    $left = Try-ParseDouble -Value $Candidate.left
    $top = Try-ParseDouble -Value $Candidate.top
    $width = Try-ParseDouble -Value $Candidate.width
    $height = Try-ParseDouble -Value $Candidate.height

    if ($null -eq $left -or $null -eq $top -or $null -eq $width -or $null -eq $height) {
        return $null
    }

    if ($width -le 0 -or $height -le 0) {
        return $null
    }

    return [PSCustomObject]@{
        left = $left
        top = $top
        width = $width
        height = $height
    }
}

function Get-DisplayBoundsFromEnv {
    $candidate = [PSCustomObject]@{
        left = $env:REMOTE_DISPLAY_LEFT
        top = $env:REMOTE_DISPLAY_TOP
        width = $env:REMOTE_DISPLAY_WIDTH
        height = $env:REMOTE_DISPLAY_HEIGHT
    }
    return Resolve-DisplayBounds -Candidate $candidate
}

function Update-DisplayBoundsFromEvent {
    param($Event)

    if ($null -eq $Event) { return }
    $displayProperty = $Event.PSObject.Properties["__display"]
    if ($null -eq $displayProperty) { return }

    $resolved = Resolve-DisplayBounds -Candidate $displayProperty.Value
    if ($null -ne $resolved) {
        $script:DisplayBounds = $resolved
    }
}

$script:DisplayBounds = Get-DisplayBoundsFromEnv

function Get-ScreenCoordinates {
    param([double]$XNorm, [double]$YNorm)

    $left = 0.0
    $top = 0.0
    $width = 0.0
    $height = 0.0

    if ($null -ne $script:DisplayBounds) {
        $left = [double]$script:DisplayBounds.left
        $top = [double]$script:DisplayBounds.top
        $width = [double]$script:DisplayBounds.width
        $height = [double]$script:DisplayBounds.height
    } else {
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $left = [double]$screen.Left
        $top = [double]$screen.Top
        $width = [double]$screen.Width
        $height = [double]$screen.Height
    }

    $x = [int][Math]::Round($left + ((Clamp-01 -Value $XNorm) * [Math]::Max(1, ($width - 1))))
    $y = [int][Math]::Round($top + ((Clamp-01 -Value $YNorm) * [Math]::Max(1, ($height - 1))))
    return @($x, $y)
}

function Get-MouseFlags {
    param([string]$Button, [bool]$IsDown)

    switch ($Button) {
        "right" { return $(if ($IsDown) { $MOUSEEVENTF_RIGHTDOWN } else { $MOUSEEVENTF_RIGHTUP }) }
        "middle" { return $(if ($IsDown) { $MOUSEEVENTF_MIDDLEDOWN } else { $MOUSEEVENTF_MIDDLEUP }) }
        default { return $(if ($IsDown) { $MOUSEEVENTF_LEFTDOWN } else { $MOUSEEVENTF_LEFTUP }) }
    }
}

function Move-Cursor {
    param($Event)
    if ($null -eq $Event.x -or $null -eq $Event.y) { return }
    $coords = Get-ScreenCoordinates -XNorm ([double]$Event.x) -YNorm ([double]$Event.y)
    [NativeInput]::SetCursorPos($coords[0], $coords[1]) | Out-Null
}

function Invoke-Mouse {
    param([string]$Type, $Event)

    Move-Cursor -Event $Event

    if ($Type -eq "move") { return }

    if ($Type -eq "wheel") {
        $deltaY = if ($null -ne $Event.deltaY) { [double]$Event.deltaY } else { 0.0 }
        if ([Math]::Abs($deltaY) -lt 0.001) { return }
        $wheelDelta = if ($deltaY -gt 0) { -120 } else { 120 }
        [NativeInput]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, [uint32]$wheelDelta, [UIntPtr]::Zero)
        return
    }

    $button = if ($Event.button) { [string]$Event.button } else { "left" }

    if ($Type -eq "click") {
        $downFlag = Get-MouseFlags -Button $button -IsDown $true
        $upFlag = Get-MouseFlags -Button $button -IsDown $false
        [NativeInput]::mouse_event([uint32]$downFlag, 0, 0, 0, [UIntPtr]::Zero)
        [NativeInput]::mouse_event([uint32]$upFlag, 0, 0, 0, [UIntPtr]::Zero)
        return
    }

    if ($Type -eq "mouse-down" -or $Type -eq "mouse-up") {
        $flag = Get-MouseFlags -Button $button -IsDown ($Type -eq "mouse-down")
        [NativeInput]::mouse_event([uint32]$flag, 0, 0, 0, [UIntPtr]::Zero)
    }
}

function Get-VirtualKey {
    param([string]$Key, [string]$Code)

    if (-not [string]::IsNullOrWhiteSpace($Code)) {
        switch ($Code) {
            "Enter" { return 0x0D }
            "NumpadEnter" { return 0x0D }
            "Tab" { return 0x09 }
            "Escape" { return 0x1B }
            "Backspace" { return 0x08 }
            "Delete" { return 0x2E }
            "Insert" { return 0x2D }
            "Home" { return 0x24 }
            "End" { return 0x23 }
            "PageUp" { return 0x21 }
            "PageDown" { return 0x22 }
            "ArrowUp" { return 0x26 }
            "ArrowDown" { return 0x28 }
            "ArrowLeft" { return 0x25 }
            "ArrowRight" { return 0x27 }
            "ShiftLeft" { return 0xA0 }
            "ShiftRight" { return 0xA1 }
            "ControlLeft" { return 0xA2 }
            "ControlRight" { return 0xA3 }
            "AltLeft" { return 0xA4 }
            "AltRight" { return 0xA5 }
            "MetaLeft" { return 0x5B }
            "MetaRight" { return 0x5C }
            "Space" { return 0x20 }
            "CapsLock" { return 0x14 }
            "NumLock" { return 0x90 }
            "ScrollLock" { return 0x91 }
            "Pause" { return 0x13 }
            "PrintScreen" { return 0x2C }
            "Backquote" { return 0xC0 }
            "Minus" { return 0xBD }
            "Equal" { return 0xBB }
            "BracketLeft" { return 0xDB }
            "BracketRight" { return 0xDD }
            "Backslash" { return 0xDC }
            "Semicolon" { return 0xBA }
            "Quote" { return 0xDE }
            "Comma" { return 0xBC }
            "Period" { return 0xBE }
            "Slash" { return 0xBF }
            "NumpadMultiply" { return 0x6A }
            "NumpadAdd" { return 0x6B }
            "NumpadSubtract" { return 0x6D }
            "NumpadDecimal" { return 0x6E }
            "NumpadDivide" { return 0x6F }
            "F1" { return 0x70 }
            "F2" { return 0x71 }
            "F3" { return 0x72 }
            "F4" { return 0x73 }
            "F5" { return 0x74 }
            "F6" { return 0x75 }
            "F7" { return 0x76 }
            "F8" { return 0x77 }
            "F9" { return 0x78 }
            "F10" { return 0x79 }
            "F11" { return 0x7A }
            "F12" { return 0x7B }
        }

        if ($Code -match "^Key([A-Z])$") {
            return [int][char]$Matches[1]
        }

        if ($Code -match "^Digit([0-9])$") {
            return 0x30 + [int]$Matches[1]
        }

        if ($Code -match "^Numpad([0-9])$") {
            return 0x60 + [int]$Matches[1]
        }
    }

    if ([string]::IsNullOrWhiteSpace($Key)) { return 0 }

    switch ($Key) {
        " " { return 0x20 }
        "Shift" { return 0x10 }
        "Control" { return 0x11 }
        "Alt" { return 0x12 }
        "Meta" { return 0x5B }
        "CapsLock" { return 0x14 }
        "-" { return 0xBD }
        "_" { return 0xBD }
        "=" { return 0xBB }
        "+" { return 0xBB }
        "[" { return 0xDB }
        "{" { return 0xDB }
        "]" { return 0xDD }
        "}" { return 0xDD }
        "\" { return 0xDC }
        "|" { return 0xDC }
        ";" { return 0xBA }
        ":" { return 0xBA }
        "'" { return 0xDE }
        "," { return 0xBC }
        "<" { return 0xBC }
        "." { return 0xBE }
        ">" { return 0xBE }
        "/" { return 0xBF }
        "?" { return 0xBF }
    }

    if ($Key.Length -eq 1) {
        $charCode = [int][char]$Key.ToUpperInvariant()
        if ($charCode -ge 48 -and $charCode -le 57) { return $charCode }
        if ($charCode -ge 65 -and $charCode -le 90) { return $charCode }
    }

    return 0
}

function Invoke-Key {
    param([string]$Type, $Event)

    $key = if ($null -ne $Event.key) { [string]$Event.key } else { "" }
    $code = if ($null -ne $Event.code) { [string]$Event.code } else { "" }
    $virtualKey = Get-VirtualKey -Key $key -Code $code
    if ($virtualKey -eq 0) { return }

    $flags = if ($Type -eq "key-up") { $KEYEVENTF_KEYUP } else { 0 }
    [NativeInput]::keybd_event([byte]$virtualKey, 0, [uint32]$flags, [UIntPtr]::Zero)
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) {
        Start-Sleep -Milliseconds 15
        continue
    }

    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    try {
        $event = $line | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $event) { continue }
        Update-DisplayBoundsFromEvent -Event $event
        if ($null -eq $event.type) { continue }

        $type = [string]$event.type
        switch ($type) {
            "move" { Invoke-Mouse -Type $type -Event $event }
            "click" { Invoke-Mouse -Type $type -Event $event }
            "mouse-down" { Invoke-Mouse -Type $type -Event $event }
            "mouse-up" { Invoke-Mouse -Type $type -Event $event }
            "wheel" { Invoke-Mouse -Type $type -Event $event }
            "key-down" { Invoke-Key -Type $type -Event $event }
            "key-up" { Invoke-Key -Type $type -Event $event }
        }
    } catch {
        # ignore malformed events
    }
}
