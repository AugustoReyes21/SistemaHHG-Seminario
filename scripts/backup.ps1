$ErrorActionPreference = 'Stop'

$envFile = Join-Path (Resolve-Path ".") ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    $parts = $_ -split '=',2
    if ($parts.Length -eq 2) {
      $name = $parts[0].Trim()
      $value = $parts[1].Trim().Trim('"')
    if ($name) { Set-Item -Path "Env:$name" -Value $value }
  }
}
}

Write-Host "Ejecutando backup..."

