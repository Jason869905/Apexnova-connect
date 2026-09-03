import { backendFailure } from "./backend-errors.js";
import type { CommandRunner } from "./command-runner.js";
import { CredentialStoreError } from "./errors.js";
import type { CredentialBackend } from "./types.js";

const MAX_CREDENTIAL_BLOB_BYTES = 2_560;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ApexnovaCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref Credential credential, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
  public static extern void CredFree(IntPtr buffer);
}
'@

function Write-Result($value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress))
}

$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = $data.service + '/' + $data.account
$genericType = 1
$persistLocalMachine = 2
$notFound = 1168
$noLogonSession = 1312

if ($data.operation -eq 'set') {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$data.secret)
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    $credential = New-Object ApexnovaCredentialManager+Credential
    $credential.Type = $genericType
    $credential.TargetName = $target
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $pointer
    $credential.Persist = $persistLocalMachine
    if (-not [ApexnovaCredentialManager]::CredWrite([ref]$credential, 0)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($errorCode -eq $noLogonSession) {
        Write-Result @{ status = 'unavailable' }
        return
      }
      throw (New-Object ComponentModel.Win32Exception($errorCode))
    }
    Write-Result @{ status = 'ok' }
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    if ($pointer -ne [IntPtr]::Zero) {
      for ($index = 0; $index -lt $bytes.Length; $index++) {
        [Runtime.InteropServices.Marshal]::WriteByte($pointer, $index, 0)
      }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
    }
  }
} elseif ($data.operation -eq 'get') {
  $pointer = [IntPtr]::Zero
  if (-not [ApexnovaCredentialManager]::CredRead($target, $genericType, 0, [ref]$pointer)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq $notFound) {
      Write-Result @{ status = 'missing' }
      exit 0
    }
    if ($errorCode -eq $noLogonSession) {
      Write-Result @{ status = 'unavailable' }
      exit 0
    }
    throw (New-Object ComponentModel.Win32Exception($errorCode))
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer,
      [type]'ApexnovaCredentialManager+Credential'
    )
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy(
      $credential.CredentialBlob,
      $bytes,
      0,
      $credential.CredentialBlobSize
    )
    try {
      Write-Result @{ status = 'found'; secret = [Convert]::ToBase64String($bytes) }
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } finally {
    [ApexnovaCredentialManager]::CredFree($pointer)
  }
} elseif ($data.operation -eq 'delete') {
  if (-not [ApexnovaCredentialManager]::CredDelete($target, $genericType, 0)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq $noLogonSession) {
      Write-Result @{ status = 'unavailable' }
      exit 0
    }
    if ($errorCode -ne $notFound) {
      throw (New-Object ComponentModel.Win32Exception($errorCode))
    }
  }
  Write-Result @{ status = 'ok' }
} else {
  throw 'Unsupported credential operation.'
}
`;

interface CredentialManagerResult {
  readonly status: "ok" | "found" | "missing" | "unavailable";
  readonly secret?: string;
}

export class WindowsCredentialManagerBackend implements CredentialBackend {
  readonly #runner: CommandRunner;
  readonly #encodedScript = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString(
    "base64",
  );

  constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  async #run(
    operation: "set" | "get" | "delete",
    service: string,
    account: string,
    secret?: string,
  ): Promise<CredentialManagerResult> {
    try {
      const result = await this.#runner.run({
        executable: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          this.#encodedScript,
        ],
        stdin: JSON.stringify({ operation, service, account, secret }),
      });
      if (result.exitCode !== 0) throw backendFailure("Windows Credential Manager");
      const parsed = JSON.parse(result.stdout) as Partial<CredentialManagerResult>;
      if (
        parsed.status !== "ok" &&
        parsed.status !== "found" &&
        parsed.status !== "missing" &&
        parsed.status !== "unavailable"
      ) {
        throw new Error("Credential helper returned an invalid result.");
      }
      if (parsed.status === "unavailable") {
        throw new CredentialStoreError(
          "BACKEND_UNAVAILABLE",
          "Windows Credential Manager is unavailable in the current logon session.",
        );
      }
      return parsed as CredentialManagerResult;
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("Windows Credential Manager", cause);
    }
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    if (Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_BLOB_BYTES) {
      throw new CredentialStoreError(
        "INVALID_SECRET",
        `Windows Credential Manager credentials cannot exceed ${MAX_CREDENTIAL_BLOB_BYTES} UTF-8 bytes.`,
      );
    }
    const result = await this.#run("set", service, account, secret);
    if (result.status !== "ok") throw backendFailure("Windows Credential Manager");
  }

  async get(service: string, account: string): Promise<string | null> {
    const result = await this.#run("get", service, account);
    if (result.status === "missing") return null;
    if (result.status !== "found" || typeof result.secret !== "string") {
      throw backendFailure("Windows Credential Manager");
    }
    return Buffer.from(result.secret, "base64").toString("utf8");
  }

  async delete(service: string, account: string): Promise<void> {
    const result = await this.#run("delete", service, account);
    if (result.status !== "ok") throw backendFailure("Windows Credential Manager");
  }
}
