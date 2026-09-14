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

$acl = Get-Acl -LiteralPath $Path

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
  Set-Acl -LiteralPath $Path -AclObject $acl
  $acl = Get-Acl -LiteralPath $Path
}

$entries = @($acl.Access | ForEach-Object { Convert-RuleToJson $_ })
[PSCustomObject]@{ entries = $entries } | ConvertTo-Json -Compress -Depth 5
