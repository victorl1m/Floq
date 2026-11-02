$ErrorActionPreference = 'Stop'
$source = (Resolve-Path (Join-Path $PSScriptRoot '..\skills\floq-orchestrate')).Path
$image = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\runtime\image\skills')).Path 'floq-orchestrate'
New-Item -ItemType Directory -Force -Path $image | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $image -Recurse -Force
$files = Get-ChildItem -LiteralPath $source -File -Recurse
foreach ($file in $files) {
    $relative = $file.FullName.Substring($source.Length).TrimStart('\')
    $target = Join-Path $image $relative
    if (-not (Test-Path -LiteralPath $target)) { throw "Missing image copy: $relative" }
    $a = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
    $b = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash
    if ($a -ne $b) { throw "Floq orchestration skill image copy differs: $relative" }
}
Write-Output 'Floq orchestration skill image copy is synchronized.'
