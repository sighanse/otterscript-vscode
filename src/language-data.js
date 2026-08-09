// @ts-check

/**
 * OtterScript language documentation model.
 *
 * IMPORTANT:
 * - This file contains plain data ONLY.
 * - No vscode imports, no MarkdownString, no runtime logic.
 * - All documentation values are plain strings.
 *
 * Rendering rules:
 * - extension.js is responsible for converting documentation strings
 *   to vscode.MarkdownString instances.
 * - Snippets here may contain escaped '$' or '@' when used standalone.
 */

/**
 * Describes a single symbol-based OtterScript construct.
 *
 * Applies to:
 * - operations (executable statements such as Log-Information)
 * - keywords (if, foreach, with, module, call, ...)
 * - variables (ProGet / execution context)
 * - scalar functions ($Function(...))
 * - vector functions (@Function(...))
 *
 * Required fields:
 * - name
 * - description
 * - namespace
 *
 * Optional fields:
 * - signature
 * - snippet
 * - documentation
 *
 * @typedef {Object} DocEntry
 * @property {string} name Human-readable name shown in completion and hover
 * @property {string} description Short summary shown in IntelliSense
 * @property {string | null} namespace The extension/product namespace this construct
 *   belongs to (e.g. "ProGet", "Otter", "InedoCore"), or null for core OtterScript
 *   language constructs that require no namespace prefix.
 * @property {string=} signature Usage syntax
 * @property {string=} snippet VS Code snippet insertion text
 * @property {string=} documentation Extended Markdown documentation
 */

/** @typedef {Record<string, DocEntry>} DocsTable */

// ============================================================
// OPERATION DOCS
// ============================================================

/** @type {DocsTable} */
const operationDocs = {
  "Log-Debug": {
    namespace: null,
    name: "Log-Debug",
    signature: 'Log-Debug "message";',
    snippet: 'Log-Debug "${1:message}";$0',
    description: "Writes a debug-level message to the execution log.",
    documentation: `
**Usage:**
\`\`\`otterscript
Log-Debug "Calculated value: $value";
\`\`\`

**Notes:**
- Intended for verbose or diagnostic output
- May be hidden or filtered depending on execution settings
- Does not affect execution flow
`
  },
  "Log-Information": {
    namespace: null,
    name: "Log-Information",
    signature: 'Log-Information "message";',
    snippet: 'Log-Information "${1:message}";$0',
    description: "Writes an informational message to the execution log.",
    documentation: `
**Usage:**
\`\`\`otterscript
Log-Information "Deployment started";
\`\`\`

**Notes:**
- Does not affect execution flow
- Used for general progress and status messages
- Visible in job / execution logs
`
  },
  "Log-Warning": {
    namespace: null,
    name: "Log-Warning",
    signature: 'Log-Warning "message";',
    snippet: 'Log-Warning "${1:message}";$0',
    description: "Writes a warning message to the execution log.",
    documentation: `
**Usage:**
\`\`\`otterscript
Log-Warning "Configuration value is deprecated";
\`\`\`

**Notes:**
- Indicates a potential problem or concern
- Does not stop execution
- Warnings may affect build or job status depending on configuration
`
  },
  "Log-Error": {
    namespace: null,
    name: "Log-Error",
    signature: 'Log-Error "message";',
    snippet: 'Log-Error "${1:message}";$0',
    description: "Writes an error message to the execution log.",
    documentation: `
**Usage:**
\`\`\`otterscript
Log-Error "Failed to connect to server";
\`\`\`

**Notes:**
- Indicates an execution error
- Does not automatically halt execution
- Combine with \`throw\` to stop execution
`
  },
  "Post-Http": {
    namespace: null,
    name: 'Post-Http',
    signature: 'Post-Http(Url: string, [options...])',
    snippet: 'Post-Http(\n    Url: "${1:https://example.com}",\n    ${2:ContentType: "application/json",}\n    ${3:TextData: "${4:request body}"},\n    ${5:FormData: %(\n        ${6:key}: "${7:value}"\n    )},\n    ${8:LogResponseBody: true}\n);',
    description: 'Executes an HTTP POST/PUT/PATCH request to a URL, typically used for RESTful operations.',
    documentation: `
**Required Argument:**
- \`Url\` - The target URL (text)

**Optional Arguments:**
- \`Method\` - HTTP method (integer: 0=POST, 1=PUT, 2=PATCH)
- \`ContentType\` - Request content type (text)
- \`TextData\` - Direct text input for request body (overrides FormData)
- \`FormData\` - Map of form data key/value pairs (e.g., \`%(key1: "value1", key2: "value2")\`)
- \`LogRequestData\` - Log the request data (true/false)
- \`LogResponseBody\` - Log the response body (true/false)
- \`ResponseBody\` - Store response body in a variable (text)
- \`ErrorStatusCodes\` - Comma-separated status codes or ranges that indicate failure (default: "400:599")
- \`RequestHeaders\` - Map of request headers (e.g., \`%(Authorization: "Bearer token")\`)
- \`MaxResponseLength\` - Maximum response length in bytes (integer)
- \`ProxyRequest\` - Proxy through the server in context (true/false)
- \`Credentials\` - Name of stored credentials (text)
- \`UserName\` - Basic auth username (text)
- \`Password\` - Basic auth password (text)
- \`IgnoreSslErrors\` - Ignore SSL certificate errors (true/false)

**Example:**
\`\`\`otterscript
# POST form data to a test service
Post-Http(
    Url: "http://httpbin.org/post",
    FormData: %(
        Var1: "value1",
        Var2: "value2"
    ),
    LogResponseBody: true
);

# POST JSON with Bearer token
Post-Http(
    Url: "https://api.example.com/data",
    ContentType: "application/json",
    TextData: $ToJson(%( name: "Test", value: 123 )),
    RequestHeaders: %( Authorization: "Bearer $ApiToken" ),
    LogResponseBody: true
);
\`\`\`
`
  },
  "Download-Http": {
    namespace: null,
    name: "Download-Http",
    signature: "Download-Http(FileName: <text>, Url: <text>, [LogResponseBody: <true/false>], [ErrorStatusCodes: <text>], [ResponseBody: <text>], [RequestHeaders: <%(key1: value1, ...)>], [MaxResponseLength: <integer>], [ProxyRequest: <true/false>], [Credentials: <text>], [UserName: <text>], [Password: <text>], [IgnoreSslErrors: <true/false>]);",
    snippet: "Download-Http ${1:https://example.com/file.zip}\n(\n    FileName: ${2:artifact.zip},\n    LogResponseBody: ${3:false}\n);$0",
    description: "Downloads a file from a specified URL using an HTTP GET.",
    documentation: `
Downloads a file from a specified URL using an HTTP GET.

**Script Usage:**
\`\`\`otterscript
Download-Http(
    FileName: <text>,
    Url: <text>,
    [LogResponseBody: <true/false>],
    [ErrorStatusCodes: <text>],
    [ResponseBody: <text>],
    [RequestHeaders: <%(key1: value1, ...)>],
    [MaxResponseLength: <integer>],
    [ProxyRequest: <true/false>],
    [Credentials: <text>],
    [UserName: <text>],
    [Password: <text>],
    [IgnoreSslErrors: <true/false>]
);
\`\`\`

**Arguments:**
- \`FileName\` (required) - Destination path for the downloaded file.
- \`Url\` (required) - Source URL to download from.
- \`LogResponseBody\` - Whether to log response body text.
- \`ErrorStatusCodes\` - Comma-separated status codes/ranges treated as failure (default: \`400:599\`).
- \`ResponseBody\` - Optional variable to store response text.
- \`RequestHeaders\` - Optional request headers map.
- \`MaxResponseLength\` - Maximum response length in bytes.
- \`ProxyRequest\` - Proxy through the server in context.
- \`Credentials\`, \`UserName\`, \`Password\` - Authentication options.
- \`IgnoreSslErrors\` - Ignore SSL certificate errors.

**Example:**
\`\`\`otterscript
Download-Http https://downloadurl.local
(
    FileName: destfilename
);
\`\`\`
`
  },
  "Upload-Http": {
    namespace: null,
    name: "Upload-Http",
    signature: "Upload-Http([Method: <integer>], FileName: <text>, Url: <text>, [LogResponseBody: <true/false>], [ErrorStatusCodes: <text>], [ResponseBody: <text>], [RequestHeaders: <%(key1: value1, ...)>], [MaxResponseLength: <integer>], [ProxyRequest: <true/false>], [Credentials: <text>], [UserName: <text>], [Password: <text>], [IgnoreSslErrors: <true/false>]);",
    snippet: "Upload-Http ${1:file.txt}\n(\n    Method: ${2:POST},\n    Url: ${3:url.local}\n);$0",
    description: "Uploads a file to a specified URL using an HTTP POST or PUT.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Upload-Http(
    [Method: <integer>],
    FileName: <text>,
    Url: <text>,
    [LogResponseBody: <true/false>],
    [ErrorStatusCodes: <text>],
    [ResponseBody: <text>],
    [RequestHeaders: <%(key1: value1, ...)>],
    [MaxResponseLength: <integer>],
    [ProxyRequest: <true/false>],
    [Credentials: <text>],
    [UserName: <text>],
    [Password: <text>],
    [IgnoreSslErrors: <true/false>]
);
\`\`\`

**Arguments:**
- \`FileName\` (required) - Path of the file to upload.
- \`Url\` (required) - Destination URL.
- \`Method\` - HTTP method.
- \`LogResponseBody\` - Whether to log response body text.
- \`ErrorStatusCodes\` - Comma-separated status codes/ranges treated as failure (default: \`400:599\`).
- \`ResponseBody\` - Optional variable to store response text.
- \`RequestHeaders\` - Optional request headers map.
- \`MaxResponseLength\` - Maximum response length in bytes.
- \`ProxyRequest\` - Proxy through the server in context.
- \`Credentials\`, \`UserName\`, \`Password\` - Authentication options.
- \`IgnoreSslErrors\` - Ignore SSL certificate errors.

**Example:**
\`\`\`otterscript
Upload-Http file.txt
(
    Method: POST,
    Url: url.local
);
\`\`\`
`
  },
  "Execute-PowerShell": {
    namespace: null,
    name: "Execute-PowerShell",
    signature: "Execute-PowerShell(Text: <text>, [Debug: <true/false>], [Verbose: <true/false>], [RunOnSimulation: <true/false>], [Isolated: <true/false>], [SuccessExitCode: <text>], [PreferWindowsPowerShell: <text>]);",
    snippet: "Execute-PowerShell >>\n    ${1:Get-Service | Where-Object { $_.Status -eq \"Running\" } | Out-String}\n>> (\n    Verbose: ${2:false},\n    Debug: ${3:false},\n    RunOnSimulation: ${4:false}\n);$0",
    description: "Executes a specified PowerShell script.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Execute-PowerShell(
    Text: <text>,
    [Debug: <true/false>],
    [Verbose: <true/false>],
    [RunOnSimulation: <true/false>],
    [Isolated: <true/false>],
    [SuccessExitCode: <text>],
    [PreferWindowsPowerShell: <text>]
);
\`\`\`

**Arguments:**
- \`Text\` (required) - PowerShell script text.
- \`Debug\` - Capture \`Write-Debug\` output in execution debug log.
- \`Verbose\` - Capture \`Write-Verbose\` output in execution debug log.
- \`RunOnSimulation\` - Whether the script executes in simulation mode.
- \`Isolated\` - Run script in a temporary AppDomain.
- \`SuccessExitCode\` - Exit code value/rule that indicates success.
- \`PreferWindowsPowerShell\` - Prefer Windows PowerShell 5.1 where available.

**Example:**
\`\`\`otterscript
Execute-PowerShell >>
    Get-Service | Where-Object { $_.Status -eq "Running" } | Out-String
>>;
\`\`\`

**Notes:**
- Docs also refer to this operation as PSExec / \`psexec\`.
`
  },
  "Ensure-Service": {
    namespace: null,
    name: "Ensure-Service",
    signature: "Ensure-Service(Name: <text>, [DisplayName: <text>], [Description: <text>], [Status: <integer>], [Exists: <true/false>], Path: <text>, [Startup: <integer>], [DelayedStart: <true/false>], [Credentials: <text>], [UserName: <text>], [Password: <text>], [FirstFailure: <integer>], [SecondFailure: <integer>], [SubsequentFailures: <integer>], [RestartDelay: <integer>], [OnFailureProgramPath: <text>], [RebootMessage: <text>], [Dependencies: <@(text)>], [StatusChangeTimeout: <TimeSpan>]);",
    snippet: "Ensure-Service(\n    Name: ${1:myName},\n    DisplayName: ${2:myDisplayName},\n    Status: ${3:Running},\n    Path: ${4:c:\\\\myservice.exe}\n);$0",
    description: "Ensures the configuration of a Windows service on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-Service(
    Name: <text>,
    [DisplayName: <text>],
    [Description: <text>],
    [Status: <integer>],
    [Exists: <true/false>],
    Path: <text>,
    [Startup: <integer>],
    [DelayedStart: <true/false>],
    [Credentials: <text>],
    [UserName: <text>],
    [Password: <text>],
    [FirstFailure: <integer>],
    [SecondFailure: <integer>],
    [SubsequentFailures: <integer>],
    [RestartDelay: <integer>],
    [OnFailureProgramPath: <text>],
    [RebootMessage: <text>],
    [Dependencies: <@(text)>],
    [StatusChangeTimeout: <TimeSpan>]
);
\`\`\`

**Key Arguments:**
- \`Name\` (required) - Service name.
- \`Path\` (required) - Service executable path (may include args).
- \`DisplayName\`, \`Description\` - Service metadata.
- \`Status\`, \`Startup\`, \`DelayedStart\` - Runtime/startup behavior.
- \`Exists\` - Ensure presence or absence.
- \`Credentials\` or \`UserName\`/\`Password\` - Service account.
- \`Dependencies\`, \`StatusChangeTimeout\` - Dependency and state transition controls.

**Example:**
\`\`\`otterscript
Ensure-Service
(
    Name: myName,
    DisplayName: myDisplayName,
    Status: Running,
    Path: c:\\myservice.exe
);
\`\`\`
`
  },
  "Ensure-Directory": {
    namespace: null,
    name: "Ensure-Directory",
    signature: "Ensure-Directory(Name: <text>, [Exists: <true/false>]);",
    snippet: "Ensure-Directory ${1:myFolderName}\n(\n    Exists: ${2:true}\n);$0",
    description: "Ensures the existence of a directory on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-Directory(
    Name: <text>,
    [Exists: <true/false>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Directory path/name.
- \`Exists\` - Ensure presence (true) or absence (false).

**Example:**
\`\`\`otterscript
Ensure-Directory myFolderName
(
    Exists: true
);
\`\`\`
`
  },
  "Ensure-Server": {
    namespace: null,
    name: "Ensure-Server",
    signature: "Ensure-Server(Name: <text>, [Exists: <true/false>], [Roles: <@(text)>], [Environments: <@(text)>], [RoutineExecutionType: <text>], [AgentConfigurationXml: <text>]);",
    snippet: "Ensure-Server ${1:myServerName}\n(\n    Exists: ${2:true}\n);$0",
    description: "Ensures that a server exists within Otter.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-Server(
    Name: <text>,
    [Exists: <true/false>],
    [Roles: <@(text)>],
    [Environments: <@(text)>],
    [RoutineExecutionType: <text>],
    [AgentConfigurationXml: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Server name.
- \`Exists\` - Ensure presence (true) or absence (false).
- \`Roles\` - Server roles.
- \`Environments\` - Environments membership.
- \`RoutineExecutionType\` - Drift remediation mode.
- \`AgentConfigurationXml\` - Serialized agent configuration.

**Example:**
\`\`\`otterscript
Ensure-Server myServerName
(
    Exists: true
);
\`\`\`
`
  },
  "Ensure-Asset": {
    namespace: null,
    name: "Ensure-Asset",
    signature: "Ensure-Asset(Name: <text>, [Raft: <text>], [Type: <integer>], [Exists: <true/false>], Directory: <text>, [FileName: <text>]);",
    snippet: "Ensure-Asset(\n    Exists: ${1:true},\n    Name: ${2:myAssetName},\n    Raft: ${3:Default},\n    Type: ${4:RoleConfigurationScript},\n    Directory: ${5:c:\\\\targetdir}\n);$0",
    description: "Ensures the existence of an asset file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-Asset(
    Name: <text>,
    [Raft: <text>],
    [Type: <integer>],
    [Exists: <true/false>],
    Directory: <text>,
    [FileName: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Asset name.
- \`Directory\` (required) - Target directory on server.
- \`Raft\` - Raft name.
- \`Type\` - Asset type.
- \`Exists\` - Ensure presence (true) or absence (false).
- \`FileName\` - Rename asset file on disk.

**Example:**
\`\`\`otterscript
Ensure-Asset
(
    Exists: true,
    Name: myAssetName,
    Raft: Default,
    Type: RoleConfigurationScript,
    Directory: c:\\targetdir
);
\`\`\`
`
  },
  "Ensure-PsModule": {
    namespace: null,
    name: "Ensure-PsModule",
    signature: "Ensure-PsModule(Module: <text>, [Version: <text>], [MinimumVersion: <text>], [Force: <true/false>], [Repository: <text>], [Scope: <text>], [Exists: <true/false>], [AllowClobber: <true/false>], [AllowPrerelease: <true/false>], [AcceptLicense: <true/false>], [AllVersions: <true/false>], [Parameters: <%(key1: value1, ...)>], [Verbose: <true/false>], [DebugLogging: <true/false>], [PreferWindowsPowerShell: <text>]);",
    snippet: "Ensure-PsModule\n(\n    Exists: ${1:true},\n    Module: ${2:PackageManagement},\n    MinimumVersion: ${3:1.4.6},\n    Repository: ${4:internal-powershell}\n);$0",
    description: "Ensures that the specified PowerShell module is installed.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-PsModule(
    Module: <text>,
    [Version: <text>],
    [MinimumVersion: <text>],
    [Force: <true/false>],
    [Repository: <text>],
    [Scope: <text>],
    [Exists: <true/false>],
    [AllowClobber: <true/false>],
    [AllowPrerelease: <true/false>],
    [AcceptLicense: <true/false>],
    [AllVersions: <true/false>],
    [Parameters: <%(key1: value1, ...)>],
    [Verbose: <true/false>],
    [DebugLogging: <true/false>],
    [PreferWindowsPowerShell: <text>]
);
\`\`\`
`
  },
  "Ensure-HostsEntry": {
    namespace: null,
    name: "Ensure-HostsEntry",
    signature: "Ensure-HostsEntry(Host: <text>, IP: <text>, [Exists: <true/false>]);",
    snippet: "Ensure-HostsEntry ${1:myHostName}\n(\n    Exists: ${2:true},\n    IP: ${3:127.0.0.1}\n);$0",
    description: "Ensures an entry in the hosts file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-HostsEntry(
    Host: <text>,
    IP: <text>,
    [Exists: <true/false>]
);
\`\`\`
`
  },
  "Acquire-Server": {
    namespace: null,
    name: "Acquire-Server",
    signature: "Acquire-Server([Role: <text>], [ServerName: <text>], [Verbose: <true/false>]);",
    snippet: "Acquire-Server(\n   Role: ${1:build-servers},\n   ServerName => ${2:\$AcquiredServerName}\n);$0",
    description: "Acquires a server from a resource pool defined by a server role.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Acquire-Server(
    [Role: <text>],
    [ServerName: <text>],
    [Verbose: <true/false>]
);
\`\`\`
`
  },
  "Get-Http": {
    namespace: null,
    name: "Get-Http",
    signature: "Get-Http([Method: <integer>], Url: <text>, [LogResponseBody: <true/false>], [ErrorStatusCodes: <text>], [ResponseBody: <text>], [RequestHeaders: <%(key1: value1, ...)>], [MaxResponseLength: <integer>], [ProxyRequest: <true/false>], [Credentials: <text>], [UserName: <text>], [Password: <text>], [IgnoreSslErrors: <true/false>]);",
    snippet: "Get-Http ${1:https://myurl.local}\n(\n    Method: ${2:GET}\n);$0",
    description: "Executes an HTTP GET, DELETE, or HEAD request against a URL.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Get-Http(
    [Method: <integer>],
    Url: <text>,
    [LogResponseBody: <true/false>],
    [ErrorStatusCodes: <text>],
    [ResponseBody: <text>],
    [RequestHeaders: <%(key1: value1, ...)>],
    [MaxResponseLength: <integer>],
    [ProxyRequest: <true/false>],
    [Credentials: <text>],
    [UserName: <text>],
    [Password: <text>],
    [IgnoreSslErrors: <true/false>]
);
\`\`\`
`
  },
  "Install-Package": {
    namespace: null,
    name: "Install-Package",
    signature: "Install-Package([PackageSource: <text>], Name: <text>, [Version: <text>], [To: <text>], [ClearTarget: <true/false>], [LocalRegistry: <integer>], [LocalCache: <true/false>], [DirectDownload: <true/false>], [Feed: <text>], [EndpointUrl: <text>], [UserName: <text>], [Password: <text>], [ApiKey: <text>], [FeedUrl: <text>]);",
    snippet: "Install-Package\n(\n    PackageSource: ${1:MyPackageSource},\n    Name: ${2:MyAppPackage},\n    Version: ${3:3.4.2},\n    To: ${4:C:\\\\MyApps\\\\MyApp}\n);$0",
    description: "Installs a universal package to a target location using a package source.",
    documentation: `
Installs a universal package to the specified location using a package source.

**Script Usage:**
\`\`\`otterscript
Install-Package(
    [PackageSource: <text>],
    Name: <text>,
    [Version: <text>],
    [To: <text>],
    [ClearTarget: <true/false>],
    [LocalRegistry: <integer>],
    [LocalCache: <true/false>],
    [DirectDownload: <true/false>],
    [Feed: <text>],
    [EndpointUrl: <text>],
    [UserName: <text>],
    [Password: <text>],
    [ApiKey: <text>],
    [FeedUrl: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Package name.
- \`PackageSource\` - Package source name.
- \`Version\` - Package version.
- \`To\` - Target installation directory.
- \`ClearTarget\` - Clear target directory before install.
- \`LocalRegistry\` - Use local registry mode.
- \`LocalCache\` - Cache package locally.
- \`DirectDownload\` - Set false when remote server cannot directly reach the ProGet feed.
- \`Feed\` - Feed name.
- \`EndpointUrl\` - ProGet API endpoint URL.
- \`UserName\`, \`Password\` - ProGet user credentials.
- \`ApiKey\` - ProGet API key.
- \`FeedUrl\` - Direct feed URL.

**Example:**
\`\`\`otterscript
Install-Package
(
    PackageSource: MyPackageSource,
    Name: MyAppPackage,
    Version: 3.4.2,
    To: C:\\MyApps\\MyApp
);
\`\`\`
`
  },
  "Ensure-Package": {
    namespace: null,
    name: "Ensure-Package",
    signature: "Ensure-Package([PackageSource: <text>], Name: <text>, [Version: <text>], [To: <text>], [ClearTarget: <true/false>], [Exists: <true/false>], [LocalRegistry: <integer>], [LocalCache: <true/false>], [FileCompare: <integer>], [Ignore: <@(text)>], [DirectDownload: <true/false>], [Feed: <text>], [EndpointUrl: <text>], [UserName: <text>], [Password: <text>], [ApiKey: <text>], [FeedUrl: <text>]);",
    snippet: "Ensure-Package\n(\n    PackageSource: ${1:MyPackageSource},\n    Name: ${2:FooBarApp},\n    Version: ${3:\\$FooBarVersion},\n    To: ${4:D:\\\\WebApps\\\\FooBar.App},\n    Ignore: ${5:web.config}\n);$0",
    description: "Ensures a universal package is installed in the specified target directory.",
    documentation: `
Ensures that the specified universal package is installed in the specified directory.

**Script Usage:**
\`\`\`otterscript
Ensure-Package(
    [PackageSource: <text>],
    Name: <text>,
    [Version: <text>],
    [To: <text>],
    [ClearTarget: <true/false>],
    [Exists: <true/false>],
    [LocalRegistry: <integer>],
    [LocalCache: <true/false>],
    [FileCompare: <integer>],
    [Ignore: <@(text)>],
    [DirectDownload: <true/false>],
    [Feed: <text>],
    [EndpointUrl: <text>],
    [UserName: <text>],
    [Password: <text>],
    [ApiKey: <text>],
    [FeedUrl: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Package name.
- \`PackageSource\` - Package source name.
- \`Version\` - Package version.
- \`To\` - Target directory path on disk.
- \`ClearTarget\` - Clear the target directory before installation.
- \`Exists\` - Ensure package exists (or does not exist when false).
- \`LocalRegistry\` - Controls local package registry checks.
- \`LocalCache\` - Cache package locally.
- \`FileCompare\` - Controls file comparison behavior.
- \`Ignore\` - File/path masks to ignore during compare.
- \`DirectDownload\` - Set false when remote server cannot directly access the ProGet feed.
- \`Feed\` - Feed name.
- \`EndpointUrl\` - ProGet API endpoint URL.
- \`UserName\`, \`Password\` - ProGet user credentials.
- \`ApiKey\` - ProGet API key.
- \`FeedUrl\` - Direct feed URL.

**Note:**
- Package presence can be determined by local registry and package files; \`LocalRegistry\` and \`FileCompare\` control that behavior.

**Example:**
\`\`\`otterscript
Ensure-Package
(
    PackageSource: MyPackageSource,
    Name: FooBarApp,
    Version: $FooBarVersion,
    To: D:\\WebApps\\FooBar.App,
    Ignore: web.config
);
\`\`\`
`
  },
  "Query-Package": {
    namespace: null,
    name: "Query-Package",
    signature: "Query-Package([From: <text>], Name: <text>, Version: <text>, NewVersion: <text>, [Reason: <text>], [PackageFile: <text>], [Feed: <text>], [EndpointUrl: <text>], [UserName: <text>], [Password: <text>], [ApiKey: <text>], [Exists: <true/false>], [Metadata: <%(key1: value1, ...)>], [FeedUrl: <text>]);",
    snippet: "Query-Package\n(\n    From: ${1:MyPackageSource},\n    Name: ${2:Group/Package},\n    Version: ${3:1.0.0},\n    NewVersion: ${4:1.0.1},\n    Exists => ${5:\\$exists},\n    Metadata => ${6:%packageData}\n);$0",
    description: "Tests whether a universal package exists and optionally reads package metadata.",
    documentation: `
Tests whether a universal package exists and optionally extracts its metadata.

**Script Usage:**
\`\`\`otterscript
Query-Package(
    [From: <text>],
    Name: <text>,
    Version: <text>,
    NewVersion: <text>,
    [Reason: <text>],
    [PackageFile: <text>],
    [Feed: <text>],
    [EndpointUrl: <text>],
    [UserName: <text>],
    [Password: <text>],
    [ApiKey: <text>],
    [Exists: <true/false>],
    [Metadata: <%(key1: value1, ...)>],
    [FeedUrl: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Package name.
- \`Version\` (required) - Package version.
- \`NewVersion\` (required) - Target/new version to query.
- \`From\` - Package source.
- \`Reason\` - Reason text for the query.
- \`PackageFile\` - Path to a local package file; when set, feed/source credentials are ignored.
- \`Feed\` - Feed name.
- \`EndpointUrl\` - ProGet API endpoint URL.
- \`UserName\`, \`Password\` - ProGet user credentials.
- \`ApiKey\` - ProGet API key.
- \`Exists\` - Output variable indicating whether package exists.
- \`Metadata\` - Output map variable containing package metadata.
- \`FeedUrl\` - Direct feed URL.

**Examples:**
\`\`\`otterscript
# Test if package exists and capture metadata
Query-Package
(
    From: MyPackageSource,
    Name: Group/Package,
    Version: 1.0.0,
    NewVersion: 1.0.1,
    Exists => $exists,
    Metadata => %packageData
);

if $exists {
    Log-Debug "Package $(%packageData.name) exists. Latest version is $(%packageData.version).";
}

# Extract metadata from a local package file
Query-Package
(
    PackageFile: C:\\MyPackages\\Package-1.0.0.upack,
    Name: Group/Package,
    Version: 1.0.0,
    NewVersion: 1.0.1,
    Metadata => %packageData
);
\`\`\`
`
  },
  "Push-PackageFile": {
    namespace: null,
    name: "Push-PackageFile",
    signature: "Push-PackageFile(FilePath: <text>, [To: <text>], [Feed: <text>], [EndpointUrl: <text>], [UserName: <text>], [Password: <text>], [ApiKey: <text>], [FeedUrl: <text>]);",
    snippet: "Push-PackageFile ${1:MyPackage.1.0.0.upack}\n(\n    To: ${2:InternalFeed}\n);$0",
    description: "Uploads a universal package file to a package source.",
    documentation: `
Uploads a universal package file to a package source.

**Script Usage:**
\`\`\`otterscript
Push-PackageFile(
    FilePath: <text>,
    [To: <text>],
    [Feed: <text>],
    [EndpointUrl: <text>],
    [UserName: <text>],
    [Password: <text>],
    [ApiKey: <text>],
    [FeedUrl: <text>]
);
\`\`\`

**Arguments:**
- \`FilePath\` (required) - Path to the package file to upload.
- \`To\` - Package source target.
- \`Feed\` - Feed name.
- \`EndpointUrl\` - ProGet API endpoint URL.
- \`UserName\`, \`Password\` - ProGet user credentials.
- \`ApiKey\` - ProGet API key.
- \`FeedUrl\` - Direct feed URL.

**Example:**
\`\`\`otterscript
Push-PackageFile MyPackage.1.0.0.upack
(
    To: InternalFeed
);
\`\`\`
`
  },
  "Concatenate-Files": {
    namespace: null,
    name: "Concatenate-Files",
    signature: "Concatenate-Files(File: <text>, [Directory: <text>], [Include: <@(text)>], [Exclude: <@(text)>], [Encoding: <text>], [Separator: <text>]);",
    snippet: "Concatenate-Files\n(\n    File: ${1:myoutputfile.txt}\n);$0",
    description: "Concatenates files on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Concatenate-Files(
    File: <text>,
    [Directory: <text>],
    [Include: <@(text)>],
    [Exclude: <@(text)>],
    [Encoding: <text>],
    [Separator: <text>]
);
\`\`\`
`
  },
  "Create-ZipFile": {
    namespace: null,
    name: "Create-ZipFile",
    signature: "Create-ZipFile(Name: <text>, Directory: <text>, [Overwrite: <true/false>]);",
    snippet: "Create-ZipFile\n(\n    Overwrite: ${1:true},\n    Name: ${2:myZipFileName.zip},\n    Directory: ${3:c:\\\\sourceDir}\n);$0",
    description: "Creates a zip file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Create-ZipFile(
    Name: <text>,
    Directory: <text>,
    [Overwrite: <true/false>]
);
\`\`\`
`
  },
  "Rename-File": {
    namespace: null,
    name: "Rename-File",
    signature: "Rename-File(From: <text>, To: <text>, [Overwrite: <true/false>]);",
    snippet: "Rename-File\n(\n    Overwrite: ${1:true},\n    From: ${2:mySourceFile.txt},\n    To: ${3:myDestFile.txt}\n);$0",
    description: "Renames a file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Rename-File(
    From: <text>,
    To: <text>,
    [Overwrite: <true/false>]
);
\`\`\`
`
  },
  "Transfer-Files": {
    namespace: null,
    name: "Transfer-Files",
    signature: "Transfer-Files([Include: <@(text)>], [Exclude: <@(text)>], [FromDirectory: <text>], [FromServer: <text>], ToDirectory: <text>, [ToServer: <text>], [DeleteTarget: <true/false>], [SetLastModifiedDate: <true/false>], [BatchSize: <integer>], [Verbose: <true/false>]);",
    snippet: "Transfer-Files\n(\n    DeleteTarget: ${1:true},\n    ToDirectory: ${2:c:\\\\targetDir}\n);$0",
    description: "Copies files from a source directory to a target directory.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Transfer-Files(
    [Include: <@(text)>],
    [Exclude: <@(text)>],
    [FromDirectory: <text>],
    [FromServer: <text>],
    ToDirectory: <text>,
    [ToServer: <text>],
    [DeleteTarget: <true/false>],
    [SetLastModifiedDate: <true/false>],
    [BatchSize: <integer>],
    [Verbose: <true/false>]
);
\`\`\`
`
  },
  "Sign-Exe": {
    namespace: null,
    name: "Sign-Exe",
    signature: "Sign-Exe(SubjectName: <text>, [TimestampServer: <text>], [ContentDescription: <text>], [ContentUrl: <text>], Include: <@(text)>, [Exclude: <@(text)>], [SignToolPath: <text>], [SourceDirectory: <text>]);",
    snippet: "Sign-Exe IncludeText\n(\n    SubjectName: ${1:mySubjectOfCertificate}\n);$0",
    description: "Signs .exe or .dll files using an installed code signing certificate.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Sign-Exe(
    SubjectName: <text>,
    [TimestampServer: <text>],
    [ContentDescription: <text>],
    [ContentUrl: <text>],
    Include: <@(text)>,
    [Exclude: <@(text)>],
    [SignToolPath: <text>],
    [SourceDirectory: <text>]
);
\`\`\`
`
  },
  "Collect-RpmPackages": {
    namespace: null,
    name: "Collect-RpmPackages",
    signature: "Collect-RpmPackages [DefaultArgument] ();",
    snippet: "Collect-RpmPackages();$0",
    description: "Collects the names and versions of .rpm packages installed on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Collect-RpmPackages [DefaultArgument] ();
\`\`\`
`
  },
  "Sleep": {
    namespace: null,
    name: "Sleep",
    signature: "Sleep <integer>;",
    snippet: "Sleep ${1:seconds};$0",
    description: "Pauses script execution for a specified number of seconds.",
    documentation: `
**Arguments:**
- \`Seconds\` (required) - The number of seconds to pause execution.

**Usage:**
\`\`\`otterscript
Sleep 5;
\`\`\`

**Notes:**
- The argument is an integer representing seconds.
- Useful for adding delays between operations, such as waiting for a service to start or avoiding rate limits.
`
  },
  "Restart-Server": {
    namespace: null,
    name: "Restart-Server",
    signature: "Restart-Server([After: <integer>], [MinimumDelay: <integer>]);",
    snippet: "Restart-Server(\n    After: ${1:5},\n    MinimumDelay: ${2:15}\n);$0",
    description: "Restarts a server and waits for it to become available again.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Restart-Server(
    [After: <integer>],
    [MinimumDelay: <integer>]
);
\`\`\`

**Arguments:**
- \`After\` - Number of seconds to wait before initiating the restart.
- \`MinimumDelay\` - Number of seconds to wait after initiating restart before polling the server.

**Notes:**
- Default and minimum for \`After\` is 5 seconds.
- Default and minimum for \`MinimumDelay\` is 15 seconds.
- If \`MinimumDelay\` is too low, the operation could appear to succeed before restart begins.

**Example:**
\`\`\`otterscript
Restart-Server(
    After: 10
);
\`\`\`
`
  },
  "Get-Asset": {
    namespace: null,
    name: "Get-Asset",
    signature: "Get-Asset(Name: <text>, [Raft: <text>], [Type: <integer>], [Overwrite: <true/false>], [To: <text>]);",
    snippet: "Get-Asset ${1:assetName}\n(\n    Type: ${2:Module},\n    Raft: ${3:Raft},\n    Overwrite: ${4:false}\n);$0",
    description: "Gets the specified asset file and saves it to the current working directory or target path.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Get-Asset(
    Name: <text>,
    [Raft: <text>],
    [Type: <integer>],
    [Overwrite: <true/false>],
    [To: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Asset name.
- \`Raft\` - Raft containing the asset.
- \`Type\` - Asset type.
- \`Overwrite\` - Whether to overwrite an existing file at destination.
- \`To\` - Target file path to save as.

**Examples:**
\`\`\`otterscript
# Gets the readme file from the current raft
Get-Asset readme.md;

Get-Asset myAsset
(
    Type: Module,
    Raft: Raft,
    Overwrite: false
);
\`\`\`
`
  },
  "Release-Server": {
    namespace: null,
    name: "Release-Server",
    signature: "Release-Server(Server: <text>, [Role: <text>], [Verbose: <true/false>]);",
    snippet: "Release-Server ${1:serverName}\n(\n    Role: ${2:build-servers},\n    Verbose: ${3:false}\n);$0",
    description: "Releases a server from a resource pool if acquired previously in the execution.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Release-Server(
    Server: <text>,
    [Role: <text>],
    [Verbose: <true/false>]
);
\`\`\`

**Arguments:**
- \`Server\` (required) - Server name to release.
- \`Role\` - Server role / resource pool role.
- \`Verbose\` - Whether to log verbose output.

**Example:**
\`\`\`otterscript
# releases a server acquired earlier in a plan
Release-Server(
    Role: build-servers,
    Server: $AcquiredServerName
);
\`\`\`
`
  },
  "Apply-Template": {
    namespace: null,
    name: "Apply-Template",
    signature: "Apply-Template([Asset: <text>], [OutputVariable: <text>], [OutputFile: <text>], [Literal: <text>], [InputFile: <text>], [AdditionalVariables: <%(key1: value1, ...)>], [NewLines: <integer>]);",
    snippet: "Apply-Template(\n    Literal: >>${1:template text}>>,\n    OutputVariable => ${2:\\$text},\n    AdditionalVariables: %(\n        ${3:key}: ${4:value}\n    ),\n    NewLines: ${5:newLines}\n);$0",
    description: "Applies full template transformation on a literal, an input file, or a template asset.",
    documentation: `
Applies full template transformation on a literal, a file, or a template asset.

**Script Usage:**
\`\`\`otterscript
InedoCore::Apply-Template(
  [Asset: <text>],
  [OutputVariable: <text>],
  [OutputFile: <text>],
  [Literal: <text>],
  [InputFile: <text>],
  [AdditionalVariables: <%(key1: value1, ...)>],
  [NewLines: <integer>]
);
\`\`\`

**Arguments:**
- \`Asset\` *(default)* - Named template asset
- \`OutputVariable\` - Store rendered output in a variable
- \`OutputFile\` - Write rendered output to a file
- \`Literal\` - Inline template text *(variables are not expanded within this property)*
- \`InputFile\` - Template source file path
- \`AdditionalVariables\` - Extra variables available while rendering
- \`NewLines\` - Controls newline handling in output

**Notes:**
- When reading from or writing to a file, there must be a valid server context.

**Examples:**
\`\`\`otterscript
# Literal template to variable
Apply-Template(
  Literal: >>Hello from $ServerName!>>,
  OutputVariable => $text,
  AdditionalVariables: %(name: "Steve")
);

# Asset template to variable
Apply-Template hdars
(
  OutputVariable => $text
);
\`\`\`
`
  },
  "Copy-Files": {
    namespace: null,
    name: "Copy-Files",
    signature: "Copy-Files([Include: <@(text)>], [Exclude: <@(text)>], [From: <text>], To: <text>, [Verbose: <true/false>], [Overwrite: <true/false>], [RenameFrom: <text>], [RenameTo: <text>], [RenameRegex: <true/false>]);",
    snippet: "Copy-Files\n(\n    From: ${1:sourceDir},\n    To: ${2:destinationDir}\n);$0",
    description: "Copies files on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Copy-Files(
    [Include: <@(text)>],
    [Exclude: <@(text)>],
    [From: <text>],
    To: <text>,
    [Verbose: <true/false>],
    [Overwrite: <true/false>],
    [RenameFrom: <text>],
    [RenameTo: <text>],
    [RenameRegex: <true/false>]
);
\`\`\`

**Arguments:**
- \`Include\` - File mask(s) to include; see KB#1119 for masking syntax.
- \`Exclude\` - File mask(s) to exclude.
- \`From\` - Source directory.
- \`To\` (required) - Target directory.
- \`Verbose\` - Log each individual file that is copied.
- \`Overwrite\` - Overwrite target files.
- \`RenameFrom\` - Text or regular expression matched against the copied file name.
- \`RenameTo\` - Replacement text for the renamed file.
- \`RenameRegex\` - Whether \`RenameFrom\`/\`RenameTo\` should be treated as a regular expression.

**Example:**
\`\`\`otterscript
# copy all files and all subdirectories beneath it to the target,
# and log each individual file that is copied, and overwrite any files
Copy-Files(
    From: E:\\Source,
    To: F:\\Target,
    Include: **,
    Verbose: true,
    Overwrite: true
);
\`\`\`

**Notes:**
- May be prefixed with \`Files::\`, though this built-in namespace isn't necessary.
`
  },
  "Create-Directory": {
    namespace: null,
    name: "Create-Directory",
    signature: "ProGet::Create-Directory(Path: <text>, [Source: <text>], [Resource: <text>], [EndpointUrl: <text>], [ApiKey: <text>], [UserName: <text>], [Password: <text>]);",
    snippet: "ProGet::Create-Directory ${1:my/folder/path}\n(\n    Resource: ${2:myAssetDirResource}\n);$0",
    description: "Ensures that a subdirectory exists in a ProGet Asset Directory.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
ProGet::Create-Directory(
    Path: <text>,
    [Source: <text>],
    [Resource: <text>],
    [EndpointUrl: <text>],
    [ApiKey: <text>],
    [UserName: <text>],
    [Password: <text>]
);
\`\`\`

**Arguments:**
- \`Path\` (required) - Directory path within the Asset Directory.
- \`Source\` - Asset source name.
- \`Resource\` - Secure resource (legacy).
- \`EndpointUrl\` - API endpoint URL.
- \`ApiKey\` - API key.
- \`UserName\` - User name.
- \`Password\` - Password.

**Example:**
\`\`\`otterscript
# ensures that the my/folder/path directory exists in the ProGet Asset Directory
# specified by the MyAssetDirResource secure resource
ProGet::Create-Directory my/folder/path
(
    Resource: MyAssetDirResource
);
\`\`\`

**Notes:**
- This creates a directory inside a **ProGet Asset Directory** (remote package/asset storage), not a local folder on the server. For a local directory, use \`Ensure-Directory\`.
`
  },
  "Create-File": {
    namespace: null,
    name: "Create-File",
    signature: "Create-File(Name: <text>, [Text: <text>], [Overwrite: <true/false>], [FileMode: <text>]);",
    snippet: "Create-File ${1:myFile.txt}\n(\n    Text: ${2:file contents}\n);$0",
    description: "Creates a file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Create-File(
    Name: <text>,
    [Text: <text>],
    [Overwrite: <true/false>],
    [FileMode: <text>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Path of the file to create.
- \`Text\` - Content to write to the file.
- \`Overwrite\` - Whether to overwrite an existing file.
- \`FileMode\` - The octal file mode for the file. Ignored on Windows.

**Example:**
\`\`\`otterscript
# write the name of the current working directory to my desktop
Create-File(
    Name: C:\\Users\\atripp\\Desktop\\workingdir.txt,
    Text: $WorkingDirectory
);
\`\`\`

**Notes:**
- May be prefixed with \`Files::\`, though this built-in namespace isn't necessary.
`
  },
  "Delete-Files": {
    namespace: null,
    name: "Delete-Files",
    signature: "Delete-Files(Include: <@(text)>, [Exclude: <@(text)>], [Directory: <text>], [Verbose: <true/false>]);",
    snippet: "Delete-Files ${1:*.tmp};$0",
    description: "Deletes files on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Delete-Files(
    Include: <@(text)>,
    [Exclude: <@(text)>],
    [Directory: <text>],
    [Verbose: <true/false>]
);
\`\`\`

**Arguments:**
- \`Include\` (required) - File mask(s) to delete; see KB#1119 for masking syntax.
- \`Exclude\` - File mask(s) to exclude from deletion.
- \`Directory\` - Directory to search in.
- \`Verbose\` - Log each individual file that is deleted.

**Example:**
\`\`\`otterscript
# delete all .config files in the working directory except web.config
Delete-Files(
    Include: *.config,
    Exclude: web.config
);
\`\`\`

**Notes:**
- May be prefixed with \`Files::\`, though this built-in namespace isn't necessary.
- Deletes files one-by-one; for clearing large directories, a PowerShell script may be more performant.
`
  },
  "Ensure-File": {
    namespace: null,
    name: "Ensure-File",
    signature: "Ensure-File([Text: <text>], [ReadOnly: <true/false>], Name: <text>, [Attributes: <integer>], [Exists: <true/false>], [Modified: <DateTime>]);",
    snippet: "Ensure-File ${1:myFile.txt}\n(\n    Exists: ${2:true}\n);$0",
    description: "Ensures the existence of a file on a server.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Ensure-File(
    [Text: <text>],
    [ReadOnly: <true/false>],
    Name: <text>,
    [Attributes: <integer>],
    [Exists: <true/false>],
    [Modified: <DateTime>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Path of the file or directory.
- \`Text\` - Contents of the file; a missing/empty value means a 0-byte file.
- \`ReadOnly\` - Marks the file with the read-only attribute. Applied after \`Attributes\`, so it overrides any read-only flag specified there.
- \`Attributes\` - File/directory attributes, as an integer flag or by name (\`ReadOnly=1\`, \`Hidden=2\`, \`System=4\`, \`Archive=32\`, \`Normal=128\`). Values may be ORed together, except \`Normal\`, which may only be used alone.
- \`Exists\` - Ensure presence (true) or absence (false).
- \`Modified\` - Last write time (UTC) of the file or directory.

**Example:**
\`\`\`otterscript
# ensures the otter.txt file exists on the server and is marked readonly
Ensure-File(
    Name: E:\\Docs\\otter.txt,
    Text: >>
Otter is a common name for a carnivorous mammal in the subfamily Lutrinae.
>>,
    ReadOnly: true
);
\`\`\`

**Notes:**
- May be prefixed with \`Files::\`, though this built-in namespace isn't necessary.
- Unlike \`Create-File\`, this is a drift-remediation / desired-state operation: re-running it will restore the file if it's missing or has drifted.
`
  },
  "Set-Variable": {
    namespace: null,
    name: "Set-Variable",
    signature: "Otter::Set-Variable([Credentials: <text>], Name: <text>, Value: <text>, [Server: <text>], [Role: <text>], [Environment: <text>], [Sensitive: <true/false>], [Host: <text>], [ApiKey: <SecureString>]);",
    snippet: "Otter::Set-Variable\n(\n    Name: ${1:variableName},\n    Value: ${2:value}\n);$0",
    description: "Creates or assigns a configuration variable in Otter.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
Otter::Set-Variable(
    [Credentials: <text>],
    Name: <text>,
    Value: <text>,
    [Server: <text>],
    [Role: <text>],
    [Environment: <text>],
    [Sensitive: <true/false>],
    [Host: <text>],
    [ApiKey: <SecureString>]
);
\`\`\`

**Arguments:**
- \`Name\` (required) - Variable name.
- \`Value\` (required) - Value to assign.
- \`Credentials\` - Credentials used to connect to the target Otter instance.
- \`Server\` - Server name to scope the variable to.
- \`Role\` - Role name to scope the variable to.
- \`Environment\` - Environment name to scope the variable to.
- \`Sensitive\` - Whether the variable value should be masked.
- \`Host\` - Otter server URL.
- \`ApiKey\` - API key.

**Example:**
\`\`\`otterscript
# sets the variable for the hdars-web-1k-tokyo server to the name of the current application
Otter::Set-Variable
(
    Credentials: ProductionOtter,
    Server: hdars-web-1k-tokyo,
    Name: LatestDeployedApplication,
    Value: $ApplicationName,
    Sensitive: false
);
\`\`\`

**Notes:**
- This creates/updates an **Otter configuration variable** (server/role/environment-scoped, or global if no scope is given) — not a runtime script variable. For a runtime variable, use \`set $myVariable = value;\`.
- If multiple entity scopes are provided, the variable will be multi-scoped.
`
  },
  "Exec": {
    namespace: null,
    name: "Exec",
    signature: "InedoCore::Exec([FileName: <text>], [Arguments: <text>], [WorkingDirectory: <text>], [OutputLogLevel: <integer>], [ErrorOutputLogLevel: <integer>], [SuccessExitCode: <text>], [ImportVariables: <true/false>], [WarnRegex: <text>], [DebugRegex: <text>], [LogArguments: <true/false>], [ReportProgressRegex: <text>], [OutputFilterRegex: <text>]);",
    snippet: "Exec ${1:executablePath}\n(\n    Arguments: ${2:arguments}\n);$0",
    description: "Executes a process, logs its output, and waits until it exits.",
    documentation: `
**Script Usage:**
\`\`\`otterscript
InedoCore::Exec(
    [FileName: <text>],
    [Arguments: <text>],
    [WorkingDirectory: <text>],
    [OutputLogLevel: <integer>],
    [ErrorOutputLogLevel: <integer>],
    [SuccessExitCode: <text>],
    [ImportVariables: <true/false>],
    [WarnRegex: <text>],
    [DebugRegex: <text>],
    [LogArguments: <true/false>],
    [ReportProgressRegex: <text>],
    [OutputFilterRegex: <text>]
);
\`\`\`

**Arguments:**
- \`FileName\` - Path to the executable to run.
- \`Arguments\` - Command-line arguments.
- \`WorkingDirectory\` - Directory to run the process from.
- \`OutputLogLevel\` / \`ErrorOutputLogLevel\` - Log level for stdout/stderr output.
- \`SuccessExitCode\` - Exit code (or inequality expression, e.g. \`>= 0\`) considered successful. Default: 0.
- \`ImportVariables\` - When true, exports all accessible scalar execution variables as environment variables to the process.
- \`WarnRegex\` / \`DebugRegex\` - Regular expression; matching output lines are logged at that level. Use a group named \`m\` to log only part of the message.
- \`LogArguments\` - Whether to log the arguments used.
- \`ReportProgressRegex\` - Regular expression for parsing real-time progress from output; use group \`m\` for a status message and \`p\` for percent complete (0-100).
- \`OutputFilterRegex\` - When set, only output messages matching this expression are logged.

**Example:**
\`\`\`otterscript
# execute 7zip and only succeed if the executable returns a non-negative exit code
Exec c:\\tools\\7za.exe (
    Arguments: i *.*,
    SuccessExitCode: >= 0
);
\`\`\`
`
  }
};

// ============================================================
// SYNTAX DOCS
// ============================================================

/** @type {DocsTable} */
const syntaxDocs = {
  "swimString": {
    namespace: null,
    name: "Swim string",
    signature: ">> ... >> or >==8> ... >==8> etc...",
    description: "Multi-line unquoted string literal with matching fish sentinels.",
    documentation: `
- Preserves line breaks
- Quotes do not need escaping
- Supports expression evaluation using \`$()\`

**Example:**
\`\`\`otterscript
$text = >>
This can span
multiple lines
>>;
\`\`\`
`
  },
  // Template tags
  "templateOpen": {
    namespace: null,
    name: "Template Open (<% ... %>)",
    signature: "<% ... %>",
    description: "Embed OtterScript code inside text templates.",
    documentation: `
### Templating Tag
**Syntax:** \`<% ... %>\`

Used to embed OtterScript code inside text templates.

**Example:**
\`\`\`otterscript
<% foreach %p in @AffectedPackages { %>
  * $(%p.Name)
<% } %>
\`\`\`
`
  },
  "templateClose": {
    namespace: null,
    name: "Template Close (%>)",
    signature: "%>",
    description: "Closes a template code block.",
    documentation: "Closes a template code block started with `<%`"
  },
  // Expression delimiters
  "mapExpr": {
    namespace: null,
    name: "Map Expression",
    signature: "%(key: value, key2: value2)",
    snippet: "(\n    ${1:key}: ${2:value}\n)",
    description: "User-defined map literal",
    documentation: `
Map expressions use the \`%(...)\` syntax to define key/value pairs.
Maps are user-defined and have no built-in variable names.

**Example:**
\`\`\`otterscript
$config = %(
    name: "MyApp",
    version: "1.0",
    debug: true
);
\`\`\`
`
  },
  "vectorExpr": {
    namespace: null,
    name: "Vector Expression",
    signature: "@(value1, value2, value3)",
    description: "Creates a vector (array/list) literal.",
    documentation: `
**Example:**
\`\`\`otterscript
@colors = @("red", "green", "blue");
$first = @colors[0];
\`\`\`
`
  },
  "nestedEval": {
    namespace: null,
    name: "Nested Evaluation",
    signature: "$(expression)",
    description: "Evaluates an expression inside a string.",
    documentation: `
Used when variable expansion is needed inside quoted strings.

**Example:**
\`\`\`otterscript
$message = "Value: $(@list[0])";
\`\`\`
`
  }
};

// ============================================================
// KEYWORD DOCS
// ============================================================

/** @type {DocsTable} */
const keywordDocs = {
  "for": {
    namespace: null,
    name: "for",
    signature: 'for server|role|deployable|directory "name" { ... }',
    description: "Sets the execution context for a block of statements.",
    documentation: `
**Purpose:** Changes the current execution context (server, role, or directory) for the enclosed block.

**Syntax:**
\`\`\`otterscript
for server "server-name" {
    # statements run on that server
}

for role "role-name" {
    # statements run in that role context
}

for directory "C:\\path" {
    # statements run with that working directory
}
\`\`\`

**Important:** This is NOT an iteration statement. It does not loop. It simply sets the context once.

**Example:**
\`\`\`otterscript
for server "web01" {
    Ensure-Directory "C:\\Websites\\MyApp";
}
\`\`\`
`
  },
  "return": {
    namespace: null,
    name: "return",
    signature: "return;",
    description: "Returns execution to the calling script.",
    documentation: `
This has no elements; if this statement is found, the execution engine ends the current script and returns execution to the calling script, if any.
`
  },
  "local": {
    namespace: null,
    name: "local",
    signature: "local $variable = value;",
    description: "Declares a local variable scoped to the current block.",
    documentation: `
Local variables override outer variables of the same name.
`
  },
  "global": {
    namespace: null,
    name: "global",
    description: "Declares or assigns a global variable.",
    documentation: `
**Syntax:**
\`\`\`otterscript
global $var = value;
\`\`\`
`
  },
  "continue": {
    namespace: null,
    name: "continue",
    signature: "continue;",
    snippet: "continue;",
    description: "Advances execution to the next iteration of the enclosing iteration or context iteration block.",
    documentation: `
If there is no enclosing iteration block, a warning is written to the execution log and execution continues.
`
  },
  "break": {
    namespace: null,
    name: "break",
    signature: "break;",
    snippet: "break;",
    description: "Used inside an iteration (loop) statement to exit the loop",
    documentation: `
When the engine encounters a break statement, it immediately terminates the current loop and resumes execution after the enclosing loop block.
If break is used outside of an iteration block, a warning will be written to the log, and no action will be taken.
`
  },
  "foreach": {
    namespace: null,
    name: 'foreach',
    description: 'Iterates over items in a vector. Works in both OtterScript code and template tags.',
    documentation: `
Can be used in two contexts:

**OtterScript Code Block:**
\`\`\`otterscript
foreach $item in @(values) {
    # loop body
}
\`\`\`

**Parameters:**
- \`$item\` - Variable name for each iteration (use \`$\` in code, \`%\` in templates)
- \`@vector\` - The vector to iterate over

**Example with ProGet:**
\`\`\`otterscript
# In template
<% foreach %p in @AffectedPackages { %>
  \* $(%p.Name) $(%p.AffectedVersions)
<% } %>

# In code block
foreach $pkg in @AffectedPackages {
    Log-Information "Package: $pkg.Name"
}
\`\`\`
`
  },
  "in": {
    namespace: null,
    name: "in",
    description: "Specifies the vector to iterate over in a foreach statement.",
    documentation: `
The \`in\` keyword is used within a \`foreach\` statement to connect the iteration variable with the vector (list) being enumerated.

**Syntax:**
\`\`\`otterscript
foreach $variable in @vector {
    # loop body
}
\`\`\`

**Parameters:**
- \`$variable\` - The variable that receives each item during iteration
- \`@vector\` - The vector (list) to iterate over

**Example:**
\`\`\`otterscript
set @items = @("apple", "banana", "cherry");

foreach $item in @items {
    Log-Information "Current item: $item";
}
\`\`\`

**Collections you can loop over:**
- List Variables: \`@ServersInGroup(database-nodes)\`
- Built-in Functions: \`@Range(1,5)\`
- Literal Arrays: \`@(App1, App2, App3)\`

**Note:** The \`in\` keyword is only valid within a \`foreach\` statement and cannot be used elsewhere.
`
  },
  "if": {
    namespace: null,
    name: "if",
    description: "Conditionally executes a block when an expression evaluates to true.",
    documentation: `
Evaluates a condition and executes the associated block if the condition is true.
Conditions typically consist of comparisons or boolean expressions.

**Syntax:**
\`\`\`otterscript
if <expression> {
    // statements
}
\`\`\`

**Example:**
\`\`\`otterscript
if $PackageSize > 1000000 {
    Log-Warning "Large package detected";
}
\`\`\`

**Notes:**
- The expression must evaluate to a boolean value
- Can be combined with \`else\`
`
  },
  "else": {
    namespace: null,
    name: "else",
    description: "Executes a block when the preceding if condition evaluates to false.",
    documentation: `
Specifies an alternative block that executes when the corresponding \`if\`
statement evaluates to false.

**Syntax:**
\`\`\`otterscript
if <expression> {
    // true branch
} else {
    // false branch
}
\`\`\`

**Example:**
\`\`\`otterscript
if $EnvironmentName == "Production" {
    Log-Warning "Production deployment";
} else {
    Log-Information "Non-production environment";
}
\`\`\`
`
  },
  "try": {
    namespace: null,
    name: "try",
    description: "Executes a block of statements and allows error handling via catch.",
    documentation: `
Wraps a sequence of statements that may generate errors,
allowing them to be handled gracefully by a corresponding \`catch\` block.

**Syntax:**
\`\`\`otterscript
try {
    // statements that may fail
} catch {
    // error handling
}
\`\`\`

**Example:**
\`\`\`otterscript
try {
    Deploy-Artifact;
} catch {
    Log-Error "Deployment failed";
}
\`\`\`

**Notes:**
- Errors raised inside \`try\` do not immediately terminate execution
- Control passes to \`catch\` on error
`
  },
  "catch": {
    namespace: null,
    name: "catch",
    description: "Handles errors raised inside a try block.",
    documentation: `
Executes when an error occurs within the associated \`try\` block.

**Syntax:**
\`\`\`otterscript
try {
    // protected code
} catch {
    // runs when an error occurs
}
\`\`\`

**Notes:**
- A \`catch\` block must directly follow a \`try\` block
- Errors may be logged, handled, or rethrown using \`throw\`
`
  },
  "throw": {
    namespace: null,
    name: "throw",
    description: "Explicitly raises an error.",
    documentation: `
Raises an error that immediately halts execution of the current block.
The error may be handled by an enclosing \`try/catch\` block.

**Syntax:**
\`\`\`otterscript
throw "error message";
\`\`\`

**Example:**
\`\`\`otterscript
if !$PackageName {
    throw "PackageName is required";
}
\`\`\`
`
  },
  "module": {
    namespace: null,
    name: "module",
    signature: "module ModuleName <out $param=\"default\"> { ... }",
    snippet: "module ${1:ModuleName} <${2:out \\$param=\"default\"}> {\n    ${3:# module body}\n}",
    description: "Defines a reusable module with optional parameters and outputs.",
    documentation: `
Defines a reusable module that can be invoked using \`call\`.

**Syntax:**
\`\`\`otterscript
module ModuleName <out $result = "default"> {
    // module body
}
\`\`\`

**Notes:**
- Modules may define input and output parameters
- Output parameters are declared using \`out\`
- Modules do not execute until called
`
  },
  "call": {
    namespace: null,
    name: "call",
    signature: "call ModuleName (param: value);",
    snippet: "call ${1:ModuleName} (\n    ${2:param}: ${3:value}\n);",
    description: "Invokes a previously defined module.",
    documentation: `
Invokes a module defined using the \`module\` keyword.

**Syntax:**
\`\`\`otterscript
call ModuleName (
    param1: value,
    param2: value
);
\`\`\`

**Notes:**
- Parameters are passed by name
- Output parameters are assigned to variables
`
  },
  "with": {
    namespace: null,
    name: "with",
    description: "Executes a block with specific execution directives applied.",
    documentation: `
Executes a block of statements using specified execution directives.

**Syntax:**
\`\`\`otterscript
with retry=3, timeout=30 {
    // statements
}
\`\`\`

**Supported directives:**
- \`retry\`
- \`timeout\`
- \`executionPolicy\`
- \`lock\`
- \`credentials\`

**Notes:**
- Directives apply only to the enclosed block
- Nested \`with\` blocks are allowed
`
  },
  "set": {
    namespace: null,
    name: "set",
    description: "Assigns a value to a variable.",
    documentation: `
**Syntax:**
\`\`\`otterscript
set $variable = value;
\`\`\`

**Notes:**
- Variables must be prefixed with \`$\`
- Assignment uses \`=\`
`
  },
  "raise-error": {
    namespace: null,
    name: "raise-error",
    description: "Raises an execution error with the specified message.",
    documentation: `
Raises an error and stops execution immediately.

**Syntax:**
\`\`\`otterscript
raise-error "message";
\`\`\`

**Notes:**
- Terminates execution immediately
- Can be used inside \`try\` / \`catch\`
- Similar in effect to \`throw\`
`
  },
  "await": {
    namespace: null,
    name: "await",
    description: "Pauses execution until asynchronous blocks have completed.",
    documentation: `
**Syntax:**
\`\`\`otterscript
await;
await TokenName;
\`\`\`

**Notes:**
- Without a token, waits for all asynchronous blocks
- With a token, waits only for blocks using the same token
- Commonly used with asynchronous execution patterns
`
  },
  "warn": {
    namespace: null,
    name: "warn",
    description: "Sets the execution status to Warn.",
    documentation: `
Sets the execution status to **Warn** while allowing execution to continue.

**Syntax:**
\`\`\`otterscript
try
{
    throw Something failed;
}
catch
{
    warn;
}
\`\`\`

**Notes:**
- Execution continues after this statement
- Commonly used inside \`catch\` blocks
`
  },
  "fail": {
    namespace: null,
    name: "fail",
    description: "Sets the execution status to Fail.",
    documentation: `
Sets the execution status to **Fail** while allowing execution to continue.

**Syntax:**
\`\`\`otterscript
fail;
\`\`\`

**Notes:**
- Does not immediately stop execution
- Differs from \`raise-error\`, which halts execution
`
  },

  "force normal": {
    namespace: null,
    name: "force normal",
    description: "Forces the execution status back to Normal.",
    documentation: `
Forces the execution status back to **Normal**, overriding a previous Warn or Fail.

**Syntax:**
\`\`\`otterscript
force normal;
\`\`\`
`
  },
  "#region": {
    namespace: null,
    name: "#region",
    description: "Marks a collapsible editor region.",
    documentation: "Editor-only folding directive. `#region` / `#endregion` create a collapsible section in the editor and have no effect on OtterScript execution."
  },
  "#endregion": {
    namespace: null,
    name: "#endregion",
    description: "Ends a collapsible editor region.",
    documentation: "Editor-only folding directive. Used to close a `#region` block. This affects editor folding only and has no runtime meaning."
  }
};

// ============================================================
// VARIABLE DOCS (ProGet / Execution Context)
// ============================================================

/** Shared documentation footer for basic ProGet context variables. */
const PROGET_VAR_DOC = "\n**Available in:** ProGet\n";

/** @type {DocsTable} */
const variableDocs = {
  "BuildId": {
    namespace: null,
    name: "$BuildId",
    description: "The numeric ID of the current build.",
    documentation: PROGET_VAR_DOC
  },
  "BuildNumber": {
    namespace: null,
    name: "$BuildNumber",
    description: "The display number of the current build.",
    documentation: PROGET_VAR_DOC
  },
  "BuildProjectName": {
    namespace: null,
    name: "$BuildProjectName",
    description: "The name of the project associated with the build.",
    documentation: PROGET_VAR_DOC
  },
  "BuildReleaseNumber": {
    namespace: null,
    name: "$BuildReleaseNumber",
    description: "The release number associated with the current build.",
    documentation: PROGET_VAR_DOC
  },
  "FeedId": {
    namespace: null,
    name: "$FeedId",
    description: "The unique identifier of the feed in scope.",
    documentation: PROGET_VAR_DOC
  },
  "FeedName": {
    namespace: null,
    name: "$FeedName",
    description: "The name of the feed in scope.",
    documentation: PROGET_VAR_DOC
  },
  "FeedType": {
    namespace: null,
    name: "$FeedType",
    description: "The type of feed (NuGet, npm, PyPI, etc.).",
    documentation: `
**Available in:** ProGet

**Feed types:**

- alpine
- asset
- cargo
- chocolatey
- composer
- conan
- conda
- cran
- docker
- helm
- maven(Java)
- npm
- nuget
- powershell
- pypi
- romp
- rpm(yum)
- rubygems
- terraform
- universal
- vsix
`
  },
  "NotifierId": {
    namespace: null,
    name: "$NotifierId",
    description: "The unique identifier of the notifier handling the event.",
    documentation: PROGET_VAR_DOC
  },
  "NotifierName": {
    namespace: null,
    name: "$NotifierName",
    description: "The name of the notifier handling the event.",
    documentation: PROGET_VAR_DOC
  },
  "PackageComplianceDetails": {
    namespace: null,
    name: "$PackageComplianceDetails",
    description: "Detailed compliance information for the package.",
    documentation: PROGET_VAR_DOC
  },
  "PackageComplianceResult": {
    namespace: null,
    name: "$PackageComplianceResult",
    description: "The overall compliance result for the package.",
    documentation: PROGET_VAR_DOC
  },
  "PackageEvent": {
    namespace: null,
    name: "$PackageEvent",
    description: "Returns the name of the event which triggered the current notifier.",
    documentation: `
**Available in:** ProGet

| $PackageEvent   | Description            |
| --------------- | ---------------------- |
| PKGADD          | Package Created        |
| PKGDEL          | Package Deleted        |
| PKGDPL          | Package Deployed       |
| PKGMDF          | Package Overwritten    |
| PKGPGD          | Package Purged         |
| PKGPMT          | Package Promoted       |
| PKGSTA          | Package Status Updated |

**Example:**
\`\`\`otterscript
%( title: "**Feed**", value: $FeedName )
\`\`\`
`
  },
  "PackageGroup": {
    namespace: null,
    name: "$PackageGroup",
    description: "The package group associated with the event.",
    documentation: PROGET_VAR_DOC
  },
  "PackageId": {
    namespace: null,
    name: "$PackageId",
    description: "The identifier of the affected package.",
    documentation: PROGET_VAR_DOC
  },
  "PackageName": {
    namespace: null,
    name: "$PackageName",
    description: "The name of the affected package.",
    documentation: PROGET_VAR_DOC
  },
  "PackageSize": {
    namespace: null,
    name: "$PackageSize",
    description: "The size of the affected package in bytes.",
    documentation: PROGET_VAR_DOC
  },
  "PackageVersion": {
    namespace: null,
    name: "$PackageVersion",
    description: "The version of the affected package.",
    documentation: `
**Available in:** ProGet

**Example:**
\`\`\`otterscript
      %( title: "**Version**", value: $PackageVersion )
\`\`\`
`
  },
  "UserName": {
    namespace: null,
    name: "$UserName",
    description: "The name of the user associated with the event.",
    documentation: PROGET_VAR_DOC
  },
  "VulnerabilityId": {
    namespace: null,
    name: "$VulnerabilityId",
    description: "The identifier of the vulnerability.",
    documentation: PROGET_VAR_DOC
  },
  "VulnerabilityScore": {
    namespace: null,
    name: "$VulnerabilityScore",
    description: "The numeric score assigned to the vulnerability.",
    documentation: PROGET_VAR_DOC
  },
  "VulnerabilitySeverity": {
    namespace: null,
    name: "$VulnerabilitySeverity",
    description: "The severity classification of the vulnerability.",
    documentation: PROGET_VAR_DOC
  },
  "VulnerabilitySummary": {
    namespace: null,
    name: "$VulnerabilitySummary",
    description: "A short summary of the vulnerability.",
    documentation: PROGET_VAR_DOC
  },
  "WebBaseUrl": {
    namespace: null,
    name: "$WebBaseUrl",
    description: "The base URL of the ProGet web application.",
    documentation: PROGET_VAR_DOC
  },
  "WorkingDirectory": {
    namespace: null,
    name: "$WorkingDirectory",
    description: "Returns the current working directory.",
    documentation: `
**Available in:** Otter
`
  }
};

// ============================================================
// FUNCTION MODELS
// ============================================================

/** @type {DocsTable} */
const scalarFunctionDocs = {
  "ToJson": {
    namespace: null,
    name: "$ToJson",
    signature: "$ToJson(data)",
    snippet: '\\$ToJson(${1:data})${0}',
    description: "Converts an OtterScript value to JSON.",
    documentation: `
**Parameters:**
- \`data\` - The data to encode as JSON (scalar, vector, or map)

**Returns:** JSON string

**Examples:**
\`\`\`otterscript
# Convert a map to JSON
$json = $ToJson(%(name: "Steve", age: 42));

# Convert a vector to JSON
$json = $ToJson(@(1, 2, 3, 4));

# Convert nested structures
$json = $ToJson(%(
    users: @(
        %(name: "Alice", role: "admin"),
        %(name: "Bob", role: "user")
    )
));
\`\`\`

**Notes:**
- Maps → JSON objects
- Vectors → JSON arrays
- Scalars → JSON strings
`,
  },
  "HtmlEncode": {
    namespace: null,
    name: "$HtmlEncode",
    signature: "$HtmlEncode(text)",
    snippet: "\\$HtmlEncode(${1:text})",
    description: "Encodes a string for safe use in HTML.",
    documentation: `
**Parameters:**
- \`text\` - The string to HTML-encode

**Returns:** HTML-encoded string

**Example:**
\`\`\`otterscript
$encoded = $HtmlEncode("<script>alert('xss')</script>");
# Result: &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;
\`\`\`
`,
  },
  "UrlEncode": {
    namespace: null,
    name: "$UrlEncode",
    signature: "$UrlEncode(text)",
    snippet: "\\$UrlEncode(${1:text})",
    description: "Encodes a string for safe use in URLs.",
    documentation: `
**Parameters:**
- \`text\` - The string to URL-encode

**Returns:** URL-encoded string

**Example:**
\`\`\`otterscript
$url = "https://example.com/search?q=" + $UrlEncode($query);
\`\`\`
`,
  },
  "PathCombine": {
    namespace: null,
    name: "$PathCombine",
    signature: "$PathCombine(path1, path2, ...)",
    snippet: "\\$PathCombine(${1:path1}, ${2:path2})",
    description: "Combines multiple path strings into a single path.",
    documentation: `
Combines multiple path strings into a single path with the correct separators.

**Parameters:**
- \`path1, path2, ...\` - Path segments to combine

**Returns:** Combined path string

**Example:**
\`\`\`otterscript
$fullPath = $PathCombine("C:\\Websites", "MyApp", "web.config");
# Result: C:\\Websites\\MyApp\\web.config
\`\`\`
`,
  },
  "Eval": {
    namespace: null,
    name: "$Eval",
    signature: "$Eval(expression)",
    snippet: "\\$Eval(${1:expression})",
    description: "Evaluates a string containing variable expressions.",
    documentation: `
**Parameters:**
- \`expression\` - String containing variable references to expand

**Returns:** Expanded string

**Example:**
\`\`\`otterscript
$template = "Hello $name!";
$result = $Eval($template);  # Expands $name
\`\`\`
`,
  },
  // String Manipulation Functions
  "ToLower": {
    namespace: null,
    name: "$ToLower",
    signature: "$ToLower(text)",
    snippet: "\\$ToLower(${1:text})",
    description: "Converts a string to lowercase characters.",
    documentation: `
**Parameters:**
- \`text\` - The string to convert to lowercase

**Returns:** Lowercase string

**Example:**
\`\`\`otterscript
$lower = $ToLower("Hello World");
# Result: "hello world"
\`\`\`
`,
  },
  "ToUpper": {
    namespace: null,
    name: "$ToUpper",
    signature: "$ToUpper(text)",
    snippet: "\\$ToUpper(${1:text})",
    description: "Converts a string to uppercase characters.",
    documentation: `
**Parameters:**
- \`text\` - The string to convert to uppercase

**Returns:** Uppercase string

**Example:**
\`\`\`otterscript
$upper = $ToUpper("Hello World");
# Result: "HELLO WORLD"
\`\`\`
`,
  },
  "Trim": {
    namespace: null,
    name: "$Trim",
    signature: "$Trim(text)",
    snippet: "\\$Trim(${1:text})",
    description: "Removes leading and trailing whitespace from a string.",
    documentation: `
Removes all leading and trailing whitespace characters from the specified string.

**Parameters:**
- \`text\` - The string to trim

**Returns:** Trimmed string

**Example:**
\`\`\`otterscript
$trimmed = $Trim("  hello  ");
# Result: "hello"
\`\`\`
`,
  },
  "Substring": {
    namespace: null,
    name: "$Substring",
    signature: "$Substring(text, startIndex, length)",
    snippet: "\\$Substring(${1:text}, ${2:startIndex}, ${3: length})",
    description: "Extracts a substring from a string.",
    documentation: `
Extracts a substring from the specified string starting at the given index.

**Parameters:**
- \`text\` - The source string
- \`startIndex\` - The zero-based starting position
- \`length\` - The number of characters to extract

**Returns:** Extracted substring

**Example:**
\`\`\`otterscript
$sub = $Substring("Hello World", 6, 5);
# Result: "World"
\`\`\`
`,
  },
  "Replace": {
    namespace: null,
    name: "$Replace",
    signature: "$Replace(text, oldValue, newValue, [ignoreCase])",
    snippet: "\\$Replace(${1:text}, ${2:oldValue}, ${3:newValue}, ${4|false,true|})",
    description: "Replaces all occurrences of a substring within a string.",
    documentation: `
Replaces all occurrences of a specified substring with another substring.

**Parameters:**
- \`text\` - The source string
- \`oldValue\` - The substring to replace
- \`newValue\` - The replacement substring
- \`ignoreCase\` *(optional)* - When \`true\`, performs a case-insensitive comparison

**Returns:** String with replacements

**Example:**
\`\`\`otterscript
$result = $Replace("Hello World", "World", "Otter");
# Result: "Hello Otter"
\`\`\`
`,
  },
  "Join": {
    namespace: null,
    name: "$Join",
    signature: "$Join(separator, vector)",
    snippet: '\\$Join("${1:, }", @${2:vector})',
    description: "Joins the elements of a vector into a single string.",
    documentation: `
Concatenates all elements of a vector into a single string, separated by the specified separator.

**Parameters:**
- \`separator\` - The string to insert between each element
- \`vector\` - The vector containing elements to join

**Returns:** Joined string

**Example:**
\`\`\`otterscript
$joined = $Join(", ", @("apple", "banana", "cherry"));
# Result: "apple, banana, cherry"
\`\`\`
`,
  },
  // Date and Time Functions
  "Date": {
    namespace: null,
    name: '$Date',
    signature: "$Date([format])",
    snippet: "\\$Date(${1:format})",
    description: 'Returns the current date and time of the local timezone.',
    documentation: `
Returns the current date and time of the local timezone in the specified .NET datetime format string, or ISO 8601 format (yyyy-MM-ddTHH:mm:ss) if no format is specified.

**Parameters:**
- \`Format\` - (Optional) A .NET datetime format string

**Returns:** Formatted date/time string

**Examples:**
\`\`\`otterscript
$now = $Date();
# Result: "2024-04-01T14:30:00"

$custom = $Date("hh:mm:ss.f");
# Result: "02:30:00.5"

$rfc1123 = $Date("r");
# Result: "Mon, 01 Apr 2024 14:30:00 GMT"

$sortable = $Date("s");
# Result: "2024-04-01T14:30:00"
\`\`\`
`
  },
  "DateUtc": {
    namespace: null,
    name: "$DateUtc",
    signature: "$DateUtc([format])",
    snippet: "\\$DateUtc(${1:format})",
    description: 'Returns the current UTC date and time.',
    documentation: `
Returns the current UTC date and time in the specified .NET datetime format string,
or ISO 8601 format (yyyy-MM-ddTHH:mm:ss) if no format is specified.

**Parameters:**
- \`Format\` - (Optional) A .NET datetime format string

**Returns:** Formatted UTC date/time string

**Example:**
\`\`\`otterscript
$utcNow = $DateUtc();
# Result: "2024-04-01T12:30:00"

$customUtc = $DateUtc("yyyy-MM-dd HH:mm:ss");
# Result: "2024-04-01 12:30:00"
\`\`\`
`
  },
  // Encoding Functions
  "Base64Encode": {
    namespace: null,
    name: "$Base64Encode",
    signature: "$Base64Encode(text)",
    snippet: "\\$Base64Encode(${1:text})",
    description: "Encodes a string to Base64 format.",
    documentation: `
Encodes the specified string to a Base64-encoded string.

**Parameters:**
- \`text\` - The string to encode

**Returns:** Base64-encoded string

**Example:**
\`\`\`otterscript
$encoded = $Base64Encode("Hello World");
# Result: "SGVsbG8gV29ybGQ="
\`\`\`
`,
  },
  "Base64Decode": {
    namespace: null,
    name: "$Base64Decode",
    signature: "$Base64Decode(base64Text)",
    snippet: "\\$Base64Decode(${1:base64Text})",
    description: "Decodes a Base64 string to plain text.",
    documentation: `
Decodes a Base64-encoded string back to its original plain text.

**Parameters:**
- \`base64Text\` - The Base64-encoded string to decode

**Returns:** Decoded plain text string

**Example:**
\`\`\`otterscript
$decoded = $Base64Decode("SGVsbG8gV29ybGQ=");
# Result: "Hello World"
\`\`\`
`,
  },
  // JSON Functions
  "FromJson": {
    namespace: null,
    name: "$FromJson",
    signature: "$FromJson(jsonString)",
    snippet: '\\$FromJson("${1:jsonString}");$0',
    description: "Parses a JSON string into an OtterScript value.",
    documentation: `
Parses a JSON string and converts it into an OtterScript map, vector, or scalar value.

**Parameters:**
- \`jsonString\` - The JSON string to parse

**Returns:** OtterScript value (map, vector, or scalar)

**Example:**
\`\`\`otterscript
$data = $FromJson('{"name": "Steve", "age": 42}');
# $data is now a map with keys "name" and "age"
$name = $data[name];
\`\`\`
`,
  },
  // File System Functions
  "FileExists": {
    namespace: null,
    name: "$FileExists",
    signature: "$FileExists(filePath)",
    snippet: '\\$FileExists("${1:filePath}");$0',
    description: "Checks if a file exists on the server.",
    documentation: `
Determines whether the specified file exists on the server in context.

**Parameters:**
- \`filePath\` - The full path to the file to check

**Returns:** \`true\` if the file exists, \`false\` otherwise

**Example:**
\`\`\`otterscript
if $FileExists("C:\\config\\app.config") {
    Log-Information "Config file found";
}
\`\`\`
`,
  },
  "DirectoryExists": {
    namespace: null,
    name: "$DirectoryExists",
    signature: "$DirectoryExists(directoryPath)",
    snippet: '\\$DirectoryExists("${1:directoryPath}");$0',
    description: "Checks if a directory exists on the server.",
    documentation: `
Determines whether the specified directory exists on the server in context.

**Parameters:**
- \`directoryPath\` - The full path to the directory to check

**Returns:** \`true\` if the directory exists, \`false\` otherwise

**Example:**
\`\`\`otterscript
if $DirectoryExists("C:\\Websites") {
    Log-Information "Websites directory found";
}
\`\`\`
`,
  },
  // Math Functions
  "Expr": {
    namespace: null,
    name: "$Expr",
    signature: "$Expr(expression)",
    snippet: "\\$Expr(\"${1:expression}\")",
    description: "Evaluates a mathematical expression.",
    documentation: `
Evaluates a mathematical expression and returns the result.

**Parameters:**
- \`expression\` - The mathematical expression to evaluate

**Returns:** Numeric result

**Example:**
\`\`\`otterscript
$result = $Expr("(5 + 3) * 2");
# Result: 16
\`\`\`
`,
  },
  "Increment": {
    namespace: null,
    name: "$Increment",
    signature: "$Increment(value)",
    snippet: "\\$Increment(${1:variable})",
    description: "Increments a numeric value by 1.",
    documentation: `
Increments the specified value by 1.

**Parameters:**
- \`value\` - The numeric value to increment

**Returns:** Value + 1

**Example:**
\`\`\`otterscript
$count = 5;
$count = $Increment($count);
# Result: 6
\`\`\`
`,
  },
  "Decrement": {
    namespace: null,
    name: "$Decrement",
    signature: "$Decrement(value)",
    snippet: "\\$Decrement(${1:variable})",
    description: "Decrements a numeric value by 1.",
    documentation: `
Decrements the specified value by 1.

**Parameters:**
- \`value\` - The numeric value to decrement

**Returns:** Value - 1

**Example:**
\`\`\`otterscript
$count = 5;
$count = $Decrement($count);
# Result: 4
\`\`\`
`,
  },
  "Abs": {
    namespace: null,
    name: "$Abs",
    signature: "$Abs(value)",
    snippet: "\\$Abs(${1:value})",
    description: "Returns the absolute value of a number.",
    documentation: `
Returns the absolute (non-negative) value of a number.

**Parameters:**
- \`value\` - The numeric value

**Returns:** Absolute value

**Example:**
\`\`\`otterscript
$result = $Abs(-10);
# Result: 10
\`\`\`
`,
  },
  "Ceiling": {
    namespace: null,
    name: "$Ceiling",
    signature: "$Ceiling(value)",
    snippet: "\\$Ceiling(${1:value})",
    description: "Rounds a number up to the nearest integer.",
    documentation: `
Returns the smallest integer greater than or equal to the specified value.

**Parameters:**
- \`value\` - The numeric value

**Returns:** Ceiling integer

**Example:**
\`\`\`otterscript
$result = $Ceiling(3.2);
# Result: 4
\`\`\`
`,
  },
  "Floor": {
    namespace: null,
    name: "$Floor",
    signature: "$Floor(value)",
    snippet: "\\$Floor(${1:value})",
    description: "Rounds a number down to the nearest integer.",
    documentation: `
Returns the largest integer less than or equal to the specified value.

**Parameters:**
- \`value\` - The numeric value

**Returns:** Floor integer

**Example:**
\`\`\`otterscript
$result = $Floor(3.8);
# Result: 3
\`\`\`
`,
  },
  "Compare": {
    namespace: null,
    name: "$Compare",
    signature: "$Compare(arg1, operator, arg2, [asNumber])",
    snippet: "\\$Compare(${1:value1}, ${2|<,>,<=,>=,=,!=|}, ${3:value2}${4:, true})",
    description: "Compares two scalar values and returns \"true\" or \"false\".",
    documentation: `
Compares two scalar values using the specified operator.

**Parameters:**
- \`arg1\` - Left-hand value
- \`operator\` - One of: \`<\`, \`>\`, \`<=\`, \`>=\`, \`=\`, \`!=\`
- \`arg2\` - Right-hand value
- \`asNumber\` - (Optional) Forces numeric comparison when \`true\`

**Behavior:**
- If both values can be parsed as numbers, a numeric comparison is used
- Otherwise, a case-sensitive string comparison is performed
- The optional \`asNumber\` parameter forces numeric comparison

**Returns:**
- \`"true"\` or \`"false"\` (string)

**Examples:**
\`\`\`otterscript
$Compare(5, >, 3)
$Compare("abc", =, "abc")
$Compare($VulnerabilityScore, >=, 7.5)
$Compare("07", >, "6", true)
\`\`\`
`
  },
  // Regular Expression Functions
  "MatchesRegex": {
    namespace: null,
    name: "$MatchesRegex",
    signature: "$MatchesRegex(text, pattern)",
    snippet: "\\$MatchesRegex(${1:text}, \"${2:pattern}\")",
    description: "Checks if a string matches a regular expression pattern.",
    documentation: `
Determines whether the specified string matches the given regular expression pattern.

**Parameters:**
- \`text\` - The string to test
- \`pattern\` - The regular expression pattern to match

**Returns:** \`true\` if the pattern matches, \`false\` otherwise

**Example:**
\`\`\`otterscript
if $MatchesRegex($email, "^[\\w\\.]+@[\\w\\.]+\\.\\w+$") {
    Log-Information "Valid email format";
}
\`\`\`
`,
  },
  "RegexReplace": {
    namespace: null,
    name: "$RegexReplace",
    signature: "$RegexReplace(text, pattern, replacement)",
    snippet: "\\$RegexReplace(${1:text}, \"${2:pattern}\", \"${3:replacement}\")",
    description: "Replaces text matching a regular expression pattern.",
    documentation: `
Replaces all occurrences of a regular expression pattern in a string with a replacement string.

**Parameters:**
- \`text\` - The source string
- \`pattern\` - The regular expression pattern to match
- \`replacement\` - The replacement text

**Returns:** String with replacements applied

**Example:**
\`\`\`otterscript
$result = $RegexReplace("Hello 123 World", "\\d+", "XXX");
# Result: "Hello XXX World"
\`\`\`
`,
  },
  // Server/Environment Information Functions
  "ServerName": {
    namespace: null,
    name: "$ServerName",
    signature: "$ServerName()",
    snippet: "\\$ServerName()",
    description: "Returns the name of the current server.",
    documentation: `
Returns the name of the server currently in context.

**Returns:** Server name string

**Example:**
\`\`\`otterscript
Log-Information "Running on server: $ServerName";
\`\`\`
`,
  },
  "EnvironmentName": {
    namespace: null,
    name: "$EnvironmentName",
    signature: "$EnvironmentName()",
    snippet: "\\$EnvironmentName()",
    description: "Returns the name of the current environment (Otter only).",
    documentation: `
Returns the name of the environment currently in context.

**Returns:** Environment name string

**Example:**
\`\`\`otterscript
if $EnvironmentName == "Production" {
    Log-Warning "Production deployment detected";
}
\`\`\`
`,
  },
  // List/Vector Functions
  "ListCount": {
    namespace: null,
    name: "$ListCount",
    signature: "$ListCount(vector)",
    snippet: "\\$ListCount(${1:vector})",
    description: "Returns the number of items in a vector.",
    documentation: `
Returns the number of elements in the specified vector.

**Parameters:**
- \`vector\` - The vector to count

**Returns:** Integer count of items

**Example:**
\`\`\`otterscript
$items = @("a", "b", "c");
$count = $ListCount($items);
# Result: 3
\`\`\`
`,
  },
  "ListItem": {
    namespace: null,
    name: "$ListItem",
    signature: "$ListItem(vector, index)",
    snippet: "\\$ListItem(${1:vector}, ${2:index})",
    description: "Gets an item from a vector by index.",
    documentation: `
Retrieves an element from a vector at the specified index (0-based).

**Parameters:**
- \`vector\` - The source vector
- \`index\` - The zero-based index of the item to retrieve

**Returns:** The item at the specified index

**Example:**
\`\`\`otterscript
$items = @("apple", "banana", "cherry");
$second = $ListItem($items, 1);
# Result: "banana"
\`\`\`
`
  },
  // ProGet Functions
  "EncodeBasicAuth": {
    namespace: null,
    name: "$EncodeBasicAuth",
    signature: "$EncodeBasicAuth(userName, password)",
    snippet: "\\$EncodeBasicAuth(\"${1:userName}\", \"${2:password}\")",
    description: "Returns the base64-encoded token used for HTTP basic auth requests.",
    documentation: `
Returns the base64-encoded token used for HTTP basic auth requests.

**Parameters:**
- \`userName\` - The username to encode
- \`password\` - The password to encode

**Returns:** Base64-encoded basic auth token

**Example:**
\`\`\`otterscript
$auth = $EncodeBasicAuth("admin", "secret");
# Result: "YWRtaW46c2VjcmV0"
\`\`\`
`
  },
  "SecureCredentialProperty": {
    namespace: null,
    name: "$SecureCredentialProperty",
    signature: "$SecureCredentialProperty(credential, property)",
    snippet: "\\$SecureCredentialProperty(${1:credential}, ${2:property})",
    description: "Returns the decrypted plain-text value of a credential property.",
    documentation: `
Returns the decrypted plain-text value of a specified credential property.

**Parameters:**
- \`credential\` - The name of the credential to read.
- \`property\` - The credential property to retrieve.

**Notes:**
- If the property is encrypted, the credential must allow encrypted property extraction.
- If extraction is not allowed, the function fails at runtime.

**Example:**
\`\`\`otterscript
# HDarsUser is a Username & Password credential with encrypted extraction enabled
set $username = $SecureCredentialProperty(HDarsUser, Username);
set $password = $SecureCredentialProperty(HDarsUser, Password);

Log-Debug "Executing sometool.exe -user $username -pass *****";
Exec sometool.exe -user $username -pass $password;
\`\`\`
`
  },
  "SecureResourceProperty": {
    namespace: null,
    name: "$SecureResourceProperty",
    signature: "$SecureResourceProperty(resource, property, [type])",
    snippet: "\\$SecureResourceProperty(${1:resource}, ${2:property}${3:, ${4:type}})",
    description: "Returns the value of a secure resource property.",
    documentation: `
Returns the value of a specified secure resource property.

**Parameters:**
- \`resource\` - The name of the secure resource to read.
- \`property\` - The resource property to retrieve.
- \`type\` *(optional)* - The type of resource property to retrieve.

**Example:**
\`\`\`otterscript
# InternalProGet is a ProGet Secure Resource
set $host = $SecureResourceProperty(InternalProGet, ServerUrl);

Exec sometool.exe --host $host;
\`\`\`
`
  },
  "PackageHash": {
    namespace: null,
    name: "$PackageHash",
    signature: "$PackageHash(format, algorithm)",
    snippet: "\\$PackageHash(\"${1|hex,base64|}\", \"${2|sha512,sha1|}\")",
    description: "Returns the value of the associated hash of the package currently in scope.",
    documentation: `
Returns the value of the associated hash of the package currently in scope if available (i.e., previously calculated).

**Parameters:**
- \`format\` - Either 'hex' or 'base64'
- \`algorithm\` - The hash algorithm ('sha512' or 'sha1')

**Returns:** Hash value as string

**Example:**
\`\`\`otterscript
$hash = $PackageHash("hex", "sha512");
\`\`\`
`
  },
  "PackageProperty": {
    namespace: null,
    name: "$PackageProperty",
    signature: "$PackageProperty(name, default)",
    snippet: "\\$PackageProperty(\"${1:propertyName}\", \"${2:defaultValue}\")",
    description: "Returns the value of any property of the package currently in scope.",
    documentation: `
Returns the value of any property of the package currently in scope or the default value. Note an error will occur if a default is not specified and the package does not have that property.

**Parameters:**
- \`name\` - The property name to retrieve
- \`default\` - Optional default value if property doesn't exist

**Returns:** Property value as string

**Example:**
\`\`\`otterscript
$description = $PackageProperty("myPropertyName", "No property defined");
\`\`\`
`
  },
  "Coalesce": {
    namespace: null,
    name: "$Coalesce",
    signature: "$Coalesce(value1, value2, ...)",
    snippet: "\\$Coalesce(${1:value1}, ${2:value2})${0}",
    description: "Returns the first non-empty value from a list of arguments.",
    documentation: `
**Parameters:**
- \`value1, value2, ...\` - Values to evaluate in order

**Returns:** The first argument that is not empty/undefined, or an empty string if all are empty

**Example:**
\`\`\`otterscript
$name = $Coalesce($OverrideName, $DefaultName, "unnamed");
\`\`\`
`
  },
  "PadLeft": {
    namespace: null,
    name: "$PadLeft",
    signature: "$PadLeft(Text, Length, [PadCharacter])",
    snippet: "\\$PadLeft(${1:Text}, ${2:Length})${0}",
    description: "Returns a new string that right-aligns the characters by padding them on the left with a specified character, for a specified total length.",
    documentation: `
**Parameters:**
- \`Text\` - The input string.
- \`Length\` - The length of the string to return.
- \`PadCharacter\` - (Optional) The character to pad with (default: space).

**Returns:** Padded string

**Example:**
\`\`\`otterscript
$padded = $PadLeft("7", 3, "0");
# Result: "007"
\`\`\`
`
  },
  "PadRight": {
    namespace: null,
    name: "$PadRight",
    signature: "$PadRight(Text, Length, [PadCharacter])",
    snippet: "\\$PadRight(${1:Text}, ${2:Length})${0}",
    description: "Returns a new string that left-aligns the characters by padding them on the right with a specified character, for a specified total length.",
    documentation: `
**Parameters:**
- \`Text\` - The input string.
- \`Length\` - The length of the string to return.
- \`PadCharacter\` - (Optional) The character to pad with (default: space).

**Returns:** Padded string

**Example:**
\`\`\`otterscript
$padded = $PadRight("Name", 10, ".");
# Result: "Name......"
\`\`\`
`
  },
  "TrimStart": {
    namespace: null,
    name: "$TrimStart",
    signature: "$TrimStart(Text, ...)",
    snippet: "\\$TrimStart(${1:Text})${0}",
    description: "Returns a string with all leading whitespace characters removed, or optionally a set of specified characters.",
    documentation: `
**Parameters:**
- \`Text\` - The input string.
- \`...\` - (Optional) One or more characters to trim instead of whitespace.

**Returns:** Trimmed string

**Example:**
\`\`\`otterscript
$trimmed = $TrimStart("   hello");
# Result: "hello"
\`\`\`
`
  },
  "TrimEnd": {
    namespace: null,
    name: "$TrimEnd",
    signature: "$TrimEnd(Text, ...)",
    snippet: "\\$TrimEnd(${1:Text})${0}",
    description: "Returns a string with all trailing whitespace characters removed, or optionally a set of specified characters.",
    documentation: `
**Parameters:**
- \`Text\` - The input string.
- \`...\` - (Optional) One or more characters to trim instead of whitespace.

**Returns:** Trimmed string

**Example:**
\`\`\`otterscript
$trimmed = $TrimEnd("hello   ");
# Result: "hello"
\`\`\`
`
  },
  "GetVariableValue": {
    namespace: null,
    name: "GetVariableValue",
    signature: "GetVariableValue(VariableName, [VariableType])",
    snippet: "GetVariableValue(\"${1:variableName}\")${0}",
    description: "Returns the value of a variable if the specified variable name is available in the current context; otherwise returns null.",
    documentation: `
**Parameters:**
- \`VariableName\` (required) - The name of the variable, without the \`$\`, \`@\`, or \`%\` sigil.
- \`VariableType\` - (Optional) Must be one of: \`any\`, \`scalar\`, \`vector\`, \`map\`.

**Returns:** The variable's value, or null if not defined.

**Example:**
\`\`\`otterscript
$value = GetVariableValue("SomeDynamicallyNamedVariable");
\`\`\`

**Notes:**
- Useful when a variable's name is itself computed at runtime.
- Use \`$IsVariableDefined\` first if the variable may not exist.
`
  },
  "IsVariableDefined": {
    namespace: null,
    name: "$IsVariableDefined",
    signature: "$IsVariableDefined(VariableName, [VariableType])",
    snippet: "\\$IsVariableDefined(\"${1:variableName}\")${0}",
    description: "Returns true if the specified variable name is available in the current context; otherwise returns false.",
    documentation: `
**Parameters:**
- \`VariableName\` (required) - The name of the variable, without the \`$\`, \`@\`, or \`%\` sigil.
- \`VariableType\` - (Optional) Must be one of: \`any\`, \`scalar\`, \`vector\`, \`map\`.

**Returns:** \`true\` or \`false\`

**Example:**
\`\`\`otterscript
if $IsVariableDefined("OptionalSetting")
{
    Log-Information $OptionalSetting;
}
\`\`\`
`
  },
  "JSEncode": {
    namespace: null,
    name: "$JSEncode",
    signature: "$JSEncode(Text)",
    snippet: "\\$JSEncode(${1:Text})${0}",
    description: "Encodes a string for use in a JavaScript string literal.",
    documentation: `
**Parameters:**
- \`Text\` (required) - The text to encode.

**Returns:** JavaScript-escaped string
`
  },
  "SHEval": {
    namespace: null,
    name: "$SHEval",
    signature: "$SHEval(ScriptText)",
    snippet: "\\$SHEval(${1:ScriptText})${0}",
    description: "Returns the output of a shell script.",
    documentation: `
**Parameters:**
- \`ScriptText\` (required) - The shell script to execute. This should be an expression.

**Returns:** The script's output.

**Example:**
\`\`\`otterscript
# set the $NextYear variable to the value of... next year
set $ShellScript = >>
date -d next-year +%Y
>>;
set $NextYear = $SHEval($ShellScript);
Log-Information $NextYear;
\`\`\`
`
  },
  "ListIndexOf": {
    namespace: null,
    name: "$ListIndexOf",
    signature: "$ListIndexOf(List, Item)",
    snippet: "\\$ListIndexOf(${1:List}, ${2:Item})${0}",
    description: "Finds the index of an item in a list.",
    documentation: `
**Parameters:**
- \`List\` (required) - The list.
- \`Item\` (required) - The item.

**Returns:** The 0-based index of the first matching item, or \`-1\` if not found.
`
  },
  "XmlEncode": {
    namespace: null,
    name: "$XmlEncode",
    signature: "$XmlEncode(Text)",
    snippet: "\\$XmlEncode(${1:Text})${0}",
    description: "Encodes a string for use in an XML element.",
    documentation: `
**Parameters:**
- \`Text\` (required) - The text to encode.

**Returns:** XML-escaped string
`
  },
  "NewLine": {
    namespace: null,
    name: "$NewLine",
    signature: "$NewLine([WindowsOrLinux])",
    snippet: "\\$NewLine${1:}${0}",
    description: "Returns the newline string for either the operating system of the current server in context, or specifically Windows or Linux.",
    documentation: `
**Parameters:**
- \`WindowsOrLinux\` - (Optional) Must be \`"windows"\`, \`"linux"\`, or \`"current"\` (default).

**Returns:** The newline sequence for the specified/current platform.
`
  },
  "ExecutionId": {
    namespace: null,
    name: "$ExecutionId",
    signature: "$ExecutionId",
    description: "Returns the current execution ID.",
    documentation: `
**Returns:** The ID of the current execution.
`
  },
  "ExecutionState": {
    namespace: null,
    name: "$ExecutionState",
    signature: "$ExecutionState",
    description: "Returns the current state of the execution (normal, warning, or error).",
    documentation: `
**Returns:** One of \`normal\`, \`warning\`, or \`error\`.
`
  },
  "WorkingDirectory": {
    namespace: null,
    name: "$WorkingDirectory",
    signature: "$WorkingDirectory",
    description: "Returns the current working directory.",
    documentation: `
**Returns:** The current working directory path.
`
  },
  "SpecialWindowsPath": {
    namespace: null,
    name: "$SpecialWindowsPath",
    signature: "$SpecialWindowsPath(Name)",
    snippet: "\\$SpecialWindowsPath(${1:Name})${0}",
    description: "Returns the full path of a special directory on a Windows system.",
    documentation: `
**Parameters:**
- \`Name\` (required) - One of the values of the \`Environment.SpecialFolder\` enumeration (e.g. \`ProgramFiles\`, \`ApplicationData\`, \`Desktop\`).

**Returns:** Full path of the special directory.
`
  },
  "ResolvePath": {
    namespace: null,
    name: "$ResolvePath",
    signature: "$ResolvePath(Path)",
    snippet: "\\$ResolvePath(${1:Path})${0}",
    description: "Provides an absolute path (terminated with a directory separator) based on a relative path and the current working directory.",
    documentation: `
**Parameters:**
- \`Path\` - The path to resolve.

**Returns:** Absolute path, with directory separators appropriate to the server in context.

**Examples:**
\`\`\`otterscript
$ResolvePath(C:\\MyDirectory)              # -> C:\\MyDirectory\\
$ResolvePath()                            # -> {WorkingDirectory}
$ResolvePath(my\\path/to/directory)        # -> {WorkingDirectory}/my/path/to/directory (on Linux)
$ResolvePath(my\\path/to/directory)        # -> {WorkingDirectory}\\my\\path\\to\\directory (on Windows)
$ResolvePath(~\\path)                      # -> {ExecutionDirectory}\\path
\`\`\`
`
  },
  "FileContents": {
    namespace: null,
    name: "$FileContents",
    signature: "$FileContents(Name, [MaxLength])",
    snippet: "\\$FileContents(${1:Name})${0}",
    description: "Returns the contents of a file on the current server.",
    documentation: `
**Parameters:**
- \`Name\` (required) - The path of the file.
- \`MaxLength\` - (Optional) The maximum length (in characters) of the file to read.

**Returns:** The file's text content.
`
  },
  "EnvironmentVariable": {
    namespace: null,
    name: "$EnvironmentVariable",
    signature: "$EnvironmentVariable(EnvironmentVariableName)",
    snippet: "\\$EnvironmentVariable(${1:EnvironmentVariableName})${0}",
    description: "Returns the value of the specified environment variable on the current server.",
    documentation: `
**Parameters:**
- \`EnvironmentVariableName\` (required) - The name of the environment variable.

**Returns:** The environment variable's value.

**Example:**
\`\`\`otterscript
# get the PATH on the server in context during an execution
set $Path = $EnvironmentVariable(PATH);
Log-Information $Path;
\`\`\`
`
  },
  "RoleName": {
    namespace: null,
    name: "$RoleName",
    signature: "$RoleName",
    description: "Name of the current server role in context.",
    documentation: `
**Returns:** The name of the current server role.
`
  }
};

// ============================================================
// VECTOR DOCS
// ============================================================

/** @type {DocsTable} */
const vectorFunctionDocs = {
  "Split": {
    namespace: null,
    name: '@Split',
    signature: '@Split(Text, Separator, [Count])',
    snippet: "@Split(\"${1:text}\", \"${2:,}\"${3:, ${4:count}})",
    description: 'Splits a string into substrings based on a specified separator.',
    documentation: `
**Parameters:**
- \`Text\` - The string to split
- \`Separator\` - The delimiter used to split the string
- \`Count\` - (Optional) Maximum number of substrings to return

**Returns:** Vector of substrings

**Example:**
\`\`\`otterscript
@parts = @Split("apple,banana,cherry", ",");
# Result: @("apple", "banana", "cherry")

@limited = @Split("one,two,three,four", ",", 2);
# Result: @("one", "two,three,four")
\`\`\`
`
  },
  "ListConcat": {
    namespace: null,
    name: '@ListConcat',
    signature: '@ListConcat(list1, list2, ...)',
    snippet: "@ListConcat(${1:@list1}, ${2:@list2})",
    description: 'Creates a list containing the contents of each list in sequence.',
    documentation: `
**Parameters:**
- \`list1, list2, ...\` - Lists to concatenate

**Returns:** Combined vector

**Example:**
\`\`\`otterscript
@combined = @ListConcat(@(1, 2), @(3, 4), @(5, 6));
# Result: @(1, 2, 3, 4, 5, 6)
\`\`\`
`
  },
  "ListInsert": {
    namespace: null,
    name: '@ListInsert',
    signature: '@ListInsert(list, item, index)',
    snippet: "@ListInsert(${1:@list}, \"${2:item}\", ${3:index})",
    description: 'Inserts an item into a list at the specified index.',
    documentation: `
**Parameters:**
- \`list\` - The list to modify
- \`item\` - The item to insert
- \`index\` - The zero-based position to insert the item

**Returns:** New list with item inserted

**Example:**
\`\`\`otterscript
@colors = @("red", "blue");
@colors = @ListInsert(@colors, "green", 1);
# Result: @("red", "green", "blue")
\`\`\`
`
  },
  "ListRemove": {
    namespace: null,
    name: '@ListRemove',
    signature: '@ListRemove(list, index)',
    snippet: "@ListRemove(${1:@list}, ${2:index})",
    description: 'Removes an item from a list at the specified index.',
    documentation: `
**Parameters:**
- \`list\` - The list to modify
- \`index\` - The zero-based position to remove

**Returns:** New list with item removed

**Example:**
\`\`\`otterscript
@colors = @("red", "green", "blue");
@colors = @ListRemove(@colors, 1);
# Result: @("red", "blue")
\`\`\`
`
  },
  "ListSet": {
    namespace: null,
    name: '@ListSet',
    signature: '@ListSet(list, index, item)',
    snippet: "@ListSet(${1:@list}, ${2:index}, \"${3:item}\")",
    description: 'Updates the value at a given position in the list to a new value.',
    documentation: `
**Parameters:**
- \`list\` - The list to modify
- \`index\` - The zero-based position to update
- \`item\` - The new value

**Returns:** New list with updated item

**Example:**
\`\`\`otterscript
@colors = @("red", "green", "blue");
@colors = @ListSet(@colors, 1, "yellow");
# Result: @("red", "yellow", "blue")
\`\`\`
`
  },
  "MapKeys": {
    namespace: null,
    name: '@MapKeys',
    signature: '@MapKeys(map)',
    snippet: "@MapKeys(${1:@map})",
    description: 'Lists the keys of a map as a vector.',
    documentation: `
**Parameters:**
- \`map\` - The map to extract keys from

**Returns:** Vector of map keys

**Example:**
\`\`\`otterscript
%config = %(name: "App", version: "1.0", debug: true);
@keys = @MapKeys(%config);
# Result: @("name", "version", "debug")
\`\`\`
`
  },
  "Range": {
    namespace: null,
    name: '@Range',
    signature: '@Range(start, count)',
    snippet: "@Range(${1:start}, ${2:count})",
    description: 'Returns a range of integers starting from a specified value.',
    documentation: `
**Parameters:**
- \`start\` - The starting integer
- \`count\` - The number of integers to generate

**Returns:** Vector of integers

**Example:**
\`\`\`otterscript
@numbers = @Range(5, 3);
# Result: @(5, 6, 7)
\`\`\`
`
  },
  "RegexFind": {
    namespace: null,
    name: '@RegexFind',
    signature: '@RegexFind(text, matchExpression, [matchGroup])',
    snippet: "@RegexFind(${1:text}, ${2:matchExpression}${3:, ${4:matchGroup}})",
    description: 'Finds all matches of a regular expression in a string, optionally returning only a matched group.',
    documentation: `
**Parameters:**
- \`text\` - The string to search
- \`matchExpression\` - The regular expression pattern
- \`matchGroup\` - (Optional) Specific capture group to return

**Returns:** Vector of matches

**Example:**
\`\`\`otterscript
@emails = @RegexFind("Contact: john@example.com, jane@test.com", "[\\w\\.]+@[\\w\\.]+");
# Result: @("john@example.com", "jane@test.com")
\`\`\`
`
  },
  // Vector Variables (ProGet)
  "AffectedPackages": {
    namespace: null,
    name: '@AffectedPackages',
    signature: '@AffectedPackages',
    description: 'Returns a list of packages affected by the vulnerability in the current scope.',
    documentation: `
**Properties:**
- \`Name\` - Package name (string)
- \`AffectedVersions\` - Affected version range (string)

**Example:**
\`\`\`otterscript
<% foreach %p in @AffectedPackages { %>
\* $(%p.Name) $(%p.AffectedVersions)
<% } %>
\`\`\`
`
  },
  "ApiKeys": {
    namespace: null,
    name: '@ApiKeys',
    signature: '@ApiKeys',
    description: 'Returns a list of API Keys in the current scope.',
    documentation: `
**Properties:**
- \`Name\` - API Key name
- \`LastUsedDate\` - Date last used
- \`ExpirationDate\` - Expiration date
- \`ExpiresDays\` - Days until expiration
- \`User\` - Associated user

**Example:**
\`\`\`otterscript
foreach $key in @ApiKeys {
  Log-Information "Key: $key.Name, Expires: $key.ExpirationDate";
}
\`\`\`
`
  },
  "BuildIssues": {
    namespace: null,
    name: '@BuildIssues',
    signature: '@BuildIssues(includeClosed)',
    description: 'Returns a list of issues on the build in the current scope.',
    documentation: `
**Parameters:**
- \`includeClosed\` - Optional, include closed issues

**Properties:**
- \`Sequence\` - Issue sequence number
- \`Detail\` - Issue details

**Example:**
\`\`\`otterscript
foreach $issue in @BuildIssues(true) {
  Log-Information "Issue $issue.Sequence: $issue.Detail";
}
\`\`\`
`
  },
  "FilesOnDisk": {
    namespace: null,
    name: '@FilesOnDisk',
    signature: '@FilesOnDisk(includes, [excludes], [directory])',
    snippet: "@FilesOnDisk(\"${1:*.txt}\")",
    description: 'Returns a list of files matching the mask on the current server.',
    documentation: `
**Parameters:**
- \`includes\` (required) - File mask(s) to include
- \`excludes\` - (Optional) File mask(s) to exclude
- \`directory\` - (Optional) Directory to search in

**Returns:** Vector of file paths

**Example:**
\`\`\`otterscript
# gets project files in the working directory
set @ProjectFiles = @FilesOnDisk(*.csproj);
\`\`\`
`
  },
  "AcquiredServers": {
    namespace: null,
    name: '@AcquiredServers',
    signature: '@AcquiredServers(Role)',
    snippet: "@AcquiredServers(\"${1:roleName}\")",
    description: 'Returns the list of all servers acquired for a specified role.',
    documentation: `
**Parameters:**
- \`Role\` (required) - The name of the server role.

**Returns:** Vector of server names

**Example:**
\`\`\`otterscript
foreach $server in @AcquiredServers("WebServer") {
  Log-Information "Acquired: $server";
}
\`\`\`

**Notes:**
- Reflects servers acquired earlier in the same execution (via \`Acquire-Server\`) for the given role, not all servers in the infrastructure.
`
  },
  "AllEnvironments": {
    namespace: null,
    name: '@AllEnvironments',
    signature: '@AllEnvironments',
    description: 'Returns the list of all environments configured in the instance.',
    documentation: `
**Returns:** Vector of environment names

**Example:**
\`\`\`otterscript
# log all environments in context to the execution log
foreach $Env in @AllEnvironments
{
  Log-Information $Env;
}
\`\`\`
`
  },
  "AllRoles": {
    namespace: null,
    name: '@AllRoles',
    signature: '@AllRoles',
    description: 'Returns the list of all server roles configured in the instance.',
    documentation: `
**Returns:** Vector of role names

**Example:**
\`\`\`otterscript
# log all server roles in context to the execution log
foreach $Role in @AllRoles
{
  Log-Information $Role;
}
\`\`\`
`
  },
  "AllServers": {
    namespace: null,
    name: '@AllServers',
    signature: '@AllServers([IncludeInactive])',
    snippet: "@AllServers",
    description: 'Returns the list of all servers configured in the instance.',
    documentation: `
**Parameters:**
- \`IncludeInactive\` - (Optional) If true, includes servers marked as inactive.

**Returns:** Vector of server names

**Example:**
\`\`\`otterscript
# log all servers in context to the execution log
foreach $Server in @AllServers
{
  Log-Information $Server;
}
\`\`\`
`
  },
  "ServersInEnvironment": {
    namespace: null,
    name: '@ServersInEnvironment',
    signature: '@ServersInEnvironment([EnvironmentName], [IncludeInactive])',
    snippet: "@ServersInEnvironment(\"${1:environmentName}\")",
    description: 'Returns the list of all the servers in the specified environment name.',
    documentation: `
**Parameters:**
- \`EnvironmentName\` - (Optional) The name of the environment. If not supplied, the current environment in context is used.
- \`IncludeInactive\` - (Optional) If true, includes servers marked as inactive.

**Returns:** Vector of server names

**Example:**
\`\`\`otterscript
foreach $server in @ServersInEnvironment("Production") {
  Log-Information "Prod server: $server";
}
\`\`\`
`
  },
  "ServersInRole": {
    namespace: null,
    name: '@ServersInRole',
    signature: '@ServersInRole([RoleName], [IncludeInactive])',
    snippet: "@ServersInRole(\"${1:roleName}\")",
    description: 'Returns the list of servers in the specified role.',
    documentation: `
**Parameters:**
- \`RoleName\` - (Optional) The name of the server role. If not supplied, the current role in context is used.
- \`IncludeInactive\` - (Optional) If true, includes servers marked as inactive.

**Returns:** Vector of server names

**Example:**
\`\`\`otterscript
foreach $server in @ServersInRole("WebServer") {
  Log-Information "Web server: $server";
}
\`\`\`
`
  },
  "ServersInRoleAndEnvironment": {
    namespace: null,
    name: '@ServersInRoleAndEnvironment',
    signature: '@ServersInRoleAndEnvironment([RoleName], [EnvironmentName], [IncludeInactive])',
    snippet: "@ServersInRoleAndEnvironment(\"${1:roleName}\", \"${2:environmentName}\")",
    description: 'Returns the list of all the servers in the specified role and environment name.',
    documentation: `
**Parameters:**
- \`RoleName\` - (Optional) The name of the server role. If not supplied, the current role in context is used.
- \`EnvironmentName\` - (Optional) The name of the environment. If not supplied, the current environment in context is used.
- \`IncludeInactive\` - (Optional) If true, includes servers marked as inactive.

**Returns:** Vector of server names

**Example:**
\`\`\`otterscript
foreach $server in @ServersInRoleAndEnvironment("WebServer", "Production") {
  Log-Information "Prod web server: $server";
}
\`\`\`
`
  }
};

// Freeze exported docs to guarantee immutability at runtime
Object.freeze(operationDocs);
Object.freeze(syntaxDocs);
Object.freeze(keywordDocs);
Object.freeze(variableDocs);
Object.freeze(scalarFunctionDocs);
Object.freeze(vectorFunctionDocs);

// Export
module.exports = {
  operationDocs,
  syntaxDocs,
  keywordDocs,
  variableDocs,
  scalarFunctionDocs,
  vectorFunctionDocs
};
