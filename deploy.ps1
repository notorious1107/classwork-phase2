# One-command updates for the existing classwork-phase2 LAN installation.
# .\deploy.ps1 -Check   compares the committed app with the live installation.
# .\deploy.ps1          backs up, switches code, and checks the live site.
# .\deploy.ps1 -SavePassword -Check   remembers or updates the SSH password for this Windows user.
[CmdletBinding()]
param([switch]$Check, [switch]$SavePassword)

$ErrorActionPreference = 'Stop'
$target = 'root@10.176.34.96'
$repository = $PSScriptRoot
$revision = git -C $repository rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the project Git revision.' }
$changes = git -C $repository status --porcelain -- classwork-repo/backend classwork-repo/frontend
if ($LASTEXITCODE -ne 0) { throw 'Cannot check the working tree.' }
if ($changes) { Write-Warning 'Uncommitted application changes are present. This run uses the committed version.' }

$archive = Join-Path ([IO.Path]::GetTempPath()) ("classwork-" + [guid]::NewGuid().ToString('N') + ".tar.gz")
try {
    git -C $repository -c core.autocrlf=false archive --format=tar.gz "--output=$archive" "${revision}:classwork-repo" backend frontend
    if ($LASTEXITCODE -ne 0) { throw 'Cannot package the application.' }
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    $payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive), [Base64FormattingOptions]::InsertLineBreaks)
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}

# Send a checksum-verified archive and the deployment commands in one SSH session.
# All interpolated values below are generated locally (hex, base64, or a fixed mode).
$remote = @'
set -euo pipefail
main() {
    umask 077
    container=classwork-phase2
    url=http://10.176.34.96:5173
    mode=__MODE__
    revision=__REVISION__
    exec 9>/run/lock/classwork-phase2-deploy.lock
    flock -n 9 || { echo 'Another deployment is in progress.' >&2; return 1; }
    app=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}' "$container")
    data=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container")
    [[ "$app" == /opt/classwork-*/app && "$(readlink -f "$app")" == "$app" && -f "$app/serve.sh" ]] || {
        echo 'The expected classwork application mount was not found.' >&2; return 1;
    }
    [[ "$data" == /var/lib/classwork-phase2 && -f "$data/.classwork-phase2" && -s "$data/classwork.sqlite" ]] || {
        echo 'The expected classwork database mount was not found.' >&2; return 1;
    }
    release_dir=$(dirname "$app")
    stage=$(mktemp -d "$release_dir/.deploy.XXXXXX")
    backup=''
    switching=0
    health() {
        curl --noproxy '*' -fsS --max-time 2 "$url/api/health" 2>/dev/null | grep -Fq '"ok":true' &&
            curl --noproxy '*' -fsS --max-time 2 -o /dev/null "$url/"
    }
    wait_ready() {
        local attempt
        for attempt in {1..20}; do
            if health; then return 0; fi
            sleep 1
        done
        return 1
    }
    restore_app() {
        if [[ -d "$backup/app" ]]; then
            docker stop "$container" >/dev/null || return 1
            if [[ -d "$app" ]]; then mv -T -- "$app" "$backup/failed-app" || return 1; fi
            mv -T -- "$backup/app" "$app" || return 1
        fi
        docker start "$container" >/dev/null && wait_ready
    }
    finish() {
        result=$?
        trap - EXIT
        trap '' HUP INT TERM
        set +e
        if [[ $result != 0 && $switching == 1 ]]; then
            echo "Update failed. Recovering the previous app. Backup: $backup" >&2
            if restore_app; then echo "Previous app is ready: $url" >&2
            else echo "Recovery needs inspection. Keep $backup and check docker logs $container." >&2; fi
        fi
        rm -rf -- "$stage"
        exit "$result"
    }
    trap finish EXIT
    trap 'exit 1' HUP INT TERM
    base64 -d > "$stage/app.tar.gz" <<'CLASSWORK_ARCHIVE'
__PAYLOAD__
CLASSWORK_ARCHIVE
    printf '%s  %s\n' '__DIGEST__' "$stage/app.tar.gz" | sha256sum --check --status
    (
        umask 022
        mkdir "$stage/app"
        tar -xzf "$stage/app.tar.gz" --no-same-owner --no-same-permissions -C "$stage/app"
    )
    if diff -qr "$stage/app/backend" "$app/backend" >/dev/null && diff -qr "$stage/app/frontend" "$app/frontend" >/dev/null; then
        if health; then echo "UP TO DATE  $url  ($revision)"; return 0; fi
        if [[ "$mode" == check ]]; then echo 'Code matches; website health check failed.' >&2; return 1; fi
        if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == false ]]; then docker start "$container" >/dev/null; fi
        wait_ready || { echo "Health check failed. Check docker logs $container." >&2; return 1; }
        echo "READY  $url  ($revision)"; return 0
    fi
    if [[ "$mode" == check ]]; then
        echo "UPDATE AVAILABLE  $revision"
        health || { echo 'Current website health check failed.' >&2; return 1; }
        return 0
    fi
    # Carry forward the installation's LAN launcher and other deployment files.
    tar -C "$app" --exclude=./backend --exclude=./frontend -cf - . | tar -C "$stage/app" -xpf -
    if command -v selinuxenabled >/dev/null && selinuxenabled; then
        chcon -R --reference="$app" "$stage/app"
    fi
    backup=$(mktemp -d "$release_dir/backup-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
    echo "Updating to $revision. Backup: $backup"
    switching=1
    docker stop "$container" >/dev/null
    tar -C "$data" -czf "$backup/data.tar.gz" .
    gzip -t "$backup/data.tar.gz"
    mv -T -- "$app" "$backup/app"
    mv -T -- "$stage/app" "$app"
    docker start "$container" >/dev/null
    if ! wait_ready; then docker logs --tail 15 "$container" >&2; return 1; fi
    switching=0
    echo "READY  $url  ($revision)"
}
main
'@
$mode = if ($Check) { 'check' } else { 'deploy' }
$remote = $remote.Replace('__MODE__', $mode).Replace('__REVISION__', $revision).Replace('__DIGEST__', $digest).Replace('__PAYLOAD__', $payload)
Write-Host "Classwork $mode | $($revision.Substring(0, 7)) | $target"
$sshOptions = @('-T', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15')
$credentialDir = Join-Path $env:LOCALAPPDATA 'ClassworkDeploy'
$credentialFile = Join-Path $credentialDir "$target.dpapi"
$useSavedPassword = $SavePassword -or (Test-Path -LiteralPath $credentialFile -PathType Leaf)
$askpass = $null
try {
    if ($useSavedPassword) {
        if ($SavePassword) {
            $secret = Read-Host "SSH password for $target" -AsSecureString
            try {
                if ($null -eq $secret -or $secret.Length -eq 0) { throw 'No password entered.' }
                $encrypted = ConvertFrom-SecureString -SecureString $secret
            } finally {
                if ($null -ne $secret) { $secret.Dispose() }
            }
        } else {
            $encrypted = [IO.File]::ReadAllText($credentialFile).Trim()
        }

        # Windows OpenSSH handles the password through a separate pipe; deployment still uses stdin.
        $helper = @'
@echo off
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $secret=ConvertTo-SecureString $env:CLASSWORK_SSH_DPAPI; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Net.NetworkCredential]::new('', $secret).Password)"
'@
        $priorAskpass = $env:SSH_ASKPASS
        $priorRequire = $env:SSH_ASKPASS_REQUIRE
        $priorEncrypted = $env:CLASSWORK_SSH_DPAPI
        $askpass = Join-Path ([IO.Path]::GetTempPath()) ("classwork-askpass-" + [guid]::NewGuid().ToString('N') + ".cmd")
        [IO.File]::WriteAllText($askpass, ($helper -replace '\r?\n', "`r`n"), [Text.Encoding]::ASCII)
        $env:CLASSWORK_SSH_DPAPI = $encrypted
        $env:SSH_ASKPASS = $askpass
        $env:SSH_ASKPASS_REQUIRE = 'force'
        $sshOptions += @('-o', 'StrictHostKeyChecking=yes', '-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1')
    }

    # Windows PowerShell writes CRLF to native stdin. Strip CR before Linux bash reads it.
    $remote | ssh.exe @sshOptions $target "tr -d '\r' | bash -s"
    $sshExit = $LASTEXITCODE
} finally {
    if ($askpass) {
        $env:SSH_ASKPASS = $priorAskpass
        $env:SSH_ASKPASS_REQUIRE = $priorRequire
        $env:CLASSWORK_SSH_DPAPI = $priorEncrypted
        if (Test-Path -LiteralPath $askpass) { Remove-Item -LiteralPath $askpass }
    }
}
if ($sshExit -ne 0) {
    if ($sshExit -eq 255 -and $useSavedPassword) { Write-Warning 'If the SSH password changed, run deploy.ps1 -SavePassword -Check again.' }
    exit $sshExit
}
if ($SavePassword) {
    [IO.Directory]::CreateDirectory($credentialDir) | Out-Null
    $pending = Join-Path $credentialDir ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($pending, $encrypted, [Text.Encoding]::ASCII)
        if ([IO.File]::Exists($credentialFile)) {
            [IO.File]::Replace($pending, $credentialFile, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($pending, $credentialFile)
        }
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
    }
    Write-Host "SSH password saved for $target under the current Windows account."
}
