param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $false)][string]$Sid,
  [Parameter(Mandatory = $true)][ValidateSet('set', 'verify')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidateSet('file', 'directory')][string]$Kind
)

$ErrorActionPreference = 'Stop'

function Convert-RuleToJson($Rule) {
  $ruleSid = $Rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  [PSCustomObject]@{
    sid = $ruleSid
    rights = $Rule.FileSystemRights.ToString()
    type = $Rule.AccessControlType.ToString()
    inherited = [bool]$Rule.IsInherited
    inheritance = $Rule.InheritanceFlags.ToString()
    propagation = $Rule.PropagationFlags.ToString()
  }
}

function Get-PathAcl {
  if ($Kind -eq 'directory') {
    return [System.IO.Directory]::GetAccessControl($Path)
  }
  return [System.IO.File]::GetAccessControl($Path)
}

function Set-PathAcl($Acl) {
  if ($Kind -eq 'directory') {
    [System.IO.Directory]::SetAccessControl($Path, $Acl)
    return
  }
  [System.IO.File]::SetAccessControl($Path, $Acl)
}

$acl = Get-PathAcl

if ($Mode -eq 'set') {
  if ([string]::IsNullOrWhiteSpace($Sid)) {
    throw 'A Windows account SID is required when setting an ACL.'
  }

  $identity = New-Object System.Security.Principal.SecurityIdentifier($Sid)
  $account = $identity.Translate([System.Security.Principal.NTAccount])

  # Remove inherited entries and every explicit entry. The resulting DACL is
  # deliberately minimal: only the current account may access this path.
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }

  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($Kind -eq 'directory') {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }

  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $account,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  Set-PathAcl $acl
  $acl = Get-PathAcl
}

$entries = @($acl.Access | ForEach-Object { Convert-RuleToJson $_ })
[PSCustomObject]@{ entries = $entries } | ConvertTo-Json -Compress -Depth 5
