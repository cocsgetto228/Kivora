# Kivora build script for Windows 10/11 (PowerShell).
#
#   .\build.ps1              собрать сервер вместе с веб-клиентом
#   .\build.ps1 -Run         собрать и сразу запустить
#   .\build.ps1 -Task test   прогнать все тесты
#   .\build.ps1 -Task desktop собрать десктоп-приложение (нужен Rust)
#   .\build.ps1 -Task package три готовые поставки: сервер, Windows, Linux
#
# Требуется Go 1.24+ и Node 20+ в PATH.

param(
    [ValidateSet("server", "web", "desktop", "brand", "test", "release", "package", "clean")]
    [string]$Task = "server",
    [switch]$Run,
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$LdFlags = "-s -w -X github.com/kivora-im/kivora/server/internal/api.Version=$Version"

function Require-Tool($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Не найден $name. $hint"
    }
}

# Brand assets are committed; this only runs when the artwork changed.
function Build-Brand {
    if (-not (Test-Path "web\public\brand\favicon.ico")) {
        Write-Host "> генерация логотипов из brand-source" -ForegroundColor Cyan
        npm install --no-audit --no-fund
        node scripts\brand.mjs
    }
}

function Build-Web {
    Require-Tool npm "Установите Node.js 20+ с https://nodejs.org"
    Build-Brand
    Write-Host "> сборка веб-клиента" -ForegroundColor Cyan
    # Vite — обычный путь. На машине без доступа к реестру npm (закрытый
    # контур, блокирующий прокси) собираем тем же исходником через bun.
    npm --prefix web install --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) {
        npm --prefix web run build
    } elseif (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Host "  реестр npm недоступен — собираю через bun" -ForegroundColor Yellow
        node scripts\build-web.mjs
    } else {
        throw "не удалось поставить зависимости веб-клиента и нет bun"
    }
    # Веб-клиент вкомпилируется в бинарник, поэтому деплой — это один файл.
    Remove-Item -Recurse -Force server\internal\webui\dist -ErrorAction SilentlyContinue
    Copy-Item -Recurse web\dist server\internal\webui\dist
}

function Build-Server {
    Require-Tool go "Установите Go 1.24+ с https://go.dev/dl/"
    Build-Web
    Write-Host "> сборка сервера" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    Push-Location server
    try {
        go build -trimpath -ldflags $LdFlags -o ..\dist\kivorad.exe .\cmd\kivorad
    } finally {
        Pop-Location
    }
    $size = [math]::Round((Get-Item dist\kivorad.exe).Length / 1MB, 2)
    Write-Host "готово: dist\kivorad.exe ($size МБ)" -ForegroundColor Green
}

switch ($Task) {
    "web" { Build-Web }

    "brand" {
        npm install --no-audit --no-fund
        node scripts\brand.mjs
    }

    "server" { Build-Server }

    "desktop" {
        Require-Tool cargo "Установите Rust с https://rustup.rs"
        Build-Web
        Write-Host "> сборка десктоп-приложения" -ForegroundColor Cyan
        npm --prefix desktop install --no-audit --no-fund
        npm --prefix desktop run build
    }

    "test" {
        Require-Tool go "Установите Go 1.24+"
        Write-Host "> тесты сервера" -ForegroundColor Cyan
        Push-Location server
        try {
            go vet ./...
            go test -race ./...
        } finally { Pop-Location }

        Write-Host "> тесты криптографии" -ForegroundColor Cyan
        Push-Location packages\kivora-crypto
        try {
            npm install --no-audit --no-fund
            npm test
        } finally { Pop-Location }

        Write-Host "> проверка типов клиента" -ForegroundColor Cyan
        npm --prefix web install --no-audit --no-fund
        npm --prefix web run typecheck
    }

    "release" {
        Build-Web
        New-Item -ItemType Directory -Force -Path release | Out-Null
        $targets = @(
            @{ os = "windows"; arch = "amd64"; ext = ".exe" },
            @{ os = "linux";   arch = "amd64"; ext = "" },
            @{ os = "linux";   arch = "arm64"; ext = "" },
            @{ os = "darwin";  arch = "arm64"; ext = "" }
        )
        Push-Location server
        try {
            foreach ($t in $targets) {
                Write-Host "> $($t.os)/$($t.arch)" -ForegroundColor Cyan
                $env:GOOS = $t.os; $env:GOARCH = $t.arch; $env:CGO_ENABLED = "0"
                go build -trimpath -ldflags $LdFlags `
                    -o "..\release\kivorad-$($t.os)-$($t.arch)$($t.ext)" .\cmd\kivorad
            }
        } finally {
            Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
            Pop-Location
        }
        Get-ChildItem release | Format-Table Name, @{ n = "МБ"; e = { [math]::Round($_.Length / 1MB, 2) } }
    }

    "package" {
        # Three deliverables, because three different people download them:
        # someone putting Kivora on a server, someone installing it on Windows,
        # someone installing it on Linux. One folder holding all of it makes
        # each of them read past two thirds of it to find their part.
        & $PSCommandPath -Task release
        $sh = Get-Command sh -ErrorAction SilentlyContinue
        if ($sh) {
            $env:VERSION = $Version
            & sh scripts/package.sh
        } else {
            throw "нужен sh (Git Bash или WSL): поставки собирает scripts/package.sh"
        }
    }

    "clean" {
        foreach ($p in @("dist", "release", "web\dist", "server\internal\webui\dist", "desktop\src-tauri\target")) {
            Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
        }
        Write-Host "очищено" -ForegroundColor Green
    }
}

if ($Run) {
    Write-Host "`n> запуск на http://localhost:8080 — зарегистрируйтесь первым, чтобы стать администратором`n" -ForegroundColor Green
    .\dist\kivorad.exe
}
