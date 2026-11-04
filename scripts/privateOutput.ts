import { execFile } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Creates a new owner-only directory for private operator output; refuses an existing path. */
export async function privateDirectory(path: string) {
  const directory = resolve(path);
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    // Windows ignores POSIX modes. Install an owner-only inheritable ACL before writing content.
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = '${directory.replace(/'/g, "''")}'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($path, $acl)
$check = [System.IO.Directory]::GetAccessControl($path)
if (-not $check.AreAccessRulesProtected -or $check.Access.Count -ne 1 -or $check.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private directory ACL verification failed' }
`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true },
    );
  }
  return directory;
}
export async function privateFile(
  directory: string,
  name: string,
  content: string,
) {
  const file = await open(join(directory, name), "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}
