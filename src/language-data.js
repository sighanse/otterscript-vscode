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
 *
 * Optional fields:
 * - signature
 * - snippet
 * - documentation
 *
 * @typedef {Object} DocEntry
 * @property {string} name Human-readable name shown in completion and hover
 * @property {string} description Short summary shown in IntelliSense
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
  'Post-Http': {
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
  'Sleep': {
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
  "Apply-Template": {
    name: "Apply-Template",
    signature: "Apply-Template([Asset: <text>], [OutputVariable: <text>], [OutputFile: <text>], [Literal: <text>], [InputFile: <text>], [AdditionalVariables: <%(key1: value1, ...)>], [NewLines: <integer>]);",
    snippet: "Apply-Template(\n    Literal: >>${1:template text}>>,\n    OutputVariable => ${2:$text},\n    AdditionalVariables: %(\n        ${3:key}: ${4:value}\n    ),\n    NewLines: ${5:newLines}\n);$0",
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
  }
};

// ============================================================
// SYNTAX DOCS
// ============================================================

/** @type {DocsTable} */
const syntaxDocs = {
  swimString: {
    name: "Swim string",
    signature: ">> ... >> or >==8> ... >==8> etc...",
    documentation: "Multi-line unquoted string literal with matching fish sentinels.",
    description: `
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
  templateOpen: {
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
  templateClose: {
    name: "Template Close (%>)",
    signature: "%>",
    description: "Closes a template code block.",
    documentation: "Closes a template code block started with `<%`"
  },
  // Expression delimiters
  mapExpr: {
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
  vectorExpr: {
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
  nestedEval: {
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
  'for': {
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
  'return': {
    name: "return",
    signature: "return;",
    description: "Returns execution to the calling script.",
    documentation: `
This has no elements; if this statement is found, the execution engine ends the current script and returns execution to the calling script, if any.
`
},
  'local': {
    name: "local",
    signature: "local $variable = value;",
    description: "Declares a local variable scoped to the current block.",
    documentation: `
Local variables override outer variables of the same name.
`
},
  'global': {
    name: "global",
    description: "Declares or assigns a global variable.",
    documentation: `
**Syntax:**
\`\`\`otterscript
global $var = value;
\`\`\`
`
  },
  'continue': {
    name: "continue",
    signature: "continue;",
    snippet: "continue;",
    description: "Advances execution to the next iteration of the enclosing iteration or context iteration block.",
    documentation: `
If there is no enclosing iteration block, a warning is written to the execution log and execution continues.
`
  },
  'break': {
    name: "break",
    signature: "break;",
    snippet: "break;",
    description: "Used inside an iteration (loop) statement to exit the loop",
    documentation: `
When the engine encounters a break statement, it immediately terminates the current loop and resumes execution after the enclosing loop block.
If break is used outside of an iteration block, a warning will be written to the log, and no action will be taken.
`
  },
  'foreach': {
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
  'in': {
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
  'if': {
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
  'else': {
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
  try: {
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
  catch: {
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
  throw: {
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
module: {
  name: "module",
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
  call: {
    name: "call",
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
  with: {
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
  set: {
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
  await: {
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
  warn: {
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
  fail: {
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
    name: "#region",
    description: "Marks a collapsible editor region.",
    documentation: "Editor-only folding directive. `#region` / `#endregion` create a collapsible section in the editor and have no effect on OtterScript execution."
  },
  "#endregion": {
    name: "#endregion",
    description: "Ends a collapsible editor region.",
    documentation: "Editor-only folding directive. Used to close a `#region` block. This affects editor folding only and has no runtime meaning."
  }
};

// ============================================================
// VARIABLE DOCS (ProGet / Execution Context)
// ============================================================

/** @type {DocsTable} */
const variableDocs = {
  "BuildId": {
    name: "$BuildId",
    description: "The numeric ID of the current build.",
    documentation: `
**Available in:** ProGet
`
  },
  "BuildNumber": {
    name: "$BuildNumber",
    description: "The display number of the current build.",
    documentation: `
**Available in:** ProGet
`
  },
  "BuildProjectName": {
    name: "$BuildProjectName",
    description: "The name of the project associated with the build.",
    documentation: `
**Available in:** ProGet
`
  },
  "BuildReleaseNumber": {
    name: "$BuildReleaseNumber",
    description: "The release number associated with the current build.",
    documentation: `
**Available in:** ProGet
`
  },
  "FeedId": {
    name: "$FeedId",
    description: "The unique identifier of the feed in scope.",
    documentation: `
**Available in:** ProGet
`
  },
  "FeedName": {
    name: "$FeedName",
    description: "The name of the feed in scope.",
    documentation: `
**Available in:** ProGet
`
  },
  "FeedType": {
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
    name: "$NotifierId",
    description: "The unique identifier of the notifier handling the event.",
    documentation: `
**Available in:** ProGet
`
  },
  "NotifierName": {
    name: "$NotifierName",
    description: "The name of the notifier handling the event.",
    documentation: `
**Available in:** ProGet
`
    },
    "PackageComplianceDetails": {
      name: "$PackageComplianceDetails",
      description: "Detailed compliance information for the package.",
      documentation: `
**Available in:** ProGet
`
    },
    "PackageComplianceResult": {
      name: "$PackageComplianceResult",
      description: "The overall compliance result for the package.",
      documentation: `
**Available in:** ProGet
`
    },
    "PackageEvent": {
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
    name: "$PackageGroup",
    description: "The package group associated with the event.",
    documentation: `
**Available in:** ProGet
`
  },
  "PackageId": {
    name: "$PackageId",
    description: "The identifier of the affected package.",
    documentation: `
**Available in:** ProGet
`
  },
  "PackageName": {
    name: "$PackageName",
    description: "The name of the affected package.",
    documentation: `
**Available in:** ProGet
`
  },
  "PackageSize": {
    name: "$PackageSize",
    description: "The size of the affected package in bytes.",
    documentation: `
**Available in:** ProGet
`
  },
  "PackageVersion": {
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
    name: "$UserName",
    description: "The name of the user associated with the event.",
    documentation: `
**Available in:** ProGet
`
  },
  "VulnerabilityId": {
    name: "$VulnerabilityId",
    description: "The identifier of the vulnerability.",
    documentation: `
**Available in:** ProGet
`
  },
  "VulnerabilityScore": {
    name: "$VulnerabilityScore",
    description: "The numeric score assigned to the vulnerability.",
    documentation: `
**Available in:** ProGet
`
  },
  "VulnerabilitySeverity": {
    name: "$VulnerabilitySeverity",
    description: "The severity classification of the vulnerability.",
    documentation: `
**Available in:** ProGet
`
  },
  "VulnerabilitySummary": {
    name: "$VulnerabilitySummary",
    description: "A short summary of the vulnerability.",
    documentation: `
**Available in:** ProGet
`
  },
  "WebBaseUrl": {
    name: "$WebBaseUrl",
    description: "The base URL of the ProGet web application.",
    documentation: `
**Available in:** ProGet
`
  },
  "WorkingDirectory": {
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
  ToJson: {
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
  HtmlEncode: {
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
  UrlEncode: {
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
  PathCombine: {
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
  Eval: {
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
  ToLower: {
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
  ToUpper: {
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
  Trim: {
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
  Substring: {
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
  Replace: {
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
  Join: {
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
  Date: {
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
  DateUtc: {
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
  Base64Encode: {
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
  Base64Decode: {
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
  FromJson: {
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
  FileExists: {
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
  DirectoryExists: {
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
  Expr: {
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
  Increment: {
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
  Decrement: {
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
  Abs: {
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
  Ceiling: {
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
  Floor: {
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
  Compare: {
    name: "$Compare",
    signature: "$Compare(arg1, operator, arg2, [asNumber])",
    snippet: "\\$Compare(${1:value1}, ${2|<,>,<=,>=,=,!=|}, ${3:value2}${4:, true})",
    description: "Compares two scalar values and returns \"true\" or \"false\".",
    documentation: `
Compares two scalar values using the specified operator.

**Parameters:**
- \`arg1\` – Left-hand value
- \`operator\` – One of: \`<\`, \`>\`, \`<=\`, \`>=\`, \`=\`, \`!=\`
- \`arg2\` – Right-hand value
- \`asNumber\` – (Optional) Forces numeric comparison when \`true\`

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
  MatchesRegex: {
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
  RegexReplace: {
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
  ServerName: {
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
  EnvironmentName: {
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
  ListCount: {
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
  ListItem: {
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
  EncodeBasicAuth: {
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
  PackageHash: {
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
  PackageProperty: {
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
  }
};

// ============================================================
// VECTOR DOCS
// ============================================================

/** @type {DocsTable} */
const vectorFunctionDocs = {
  'Split': {
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
  'ListConcat': {
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
  'ListInsert': {
    name: '@ListInsert',
    signature: '@ListInsert(list, item, index)',
    snippet: "@ListInsert(${1:@list}, \"${2:item}\", ${3:index})",
    description: 'Inserts an item into a list.',
    documentation: `
Inserts an item into a list at the specified index.

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
  'ListRemove': {
    name: '@ListRemove',
    signature: '@ListRemove(list, index)',
    snippet: "@ListRemove(${1:@list}, ${2:index})",
    description: 'Removes an item from a list.',
    documentation: `
Removes an item from a list at the specified index.

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
  'ListSet': {
    name: '@ListSet',
    signature: '@ListSet(list, index, item)',
    snippet: "@ListSet(${1:@list}, ${2:index},\"${3:item}\")",
    description: 'Updates the value at a given position in the list to a new value.',
    documentation: `
Updates the value at a given position in the list to a new value.

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
  'MapKeys': {
    name: '@MapKeys',
    signature: '@MapKeys(map)',
    snippet: "@MapKeys(${1:@map})",
    description: 'Lists the keys of a map.',
    documentation: `
Lists the keys of a map as a vector.

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
  'Range': {
    name: '@Range',
    signature: '@Range(start, count)',
    snippet: "@Range(${1:start}, ${2:count})",
    description: 'Returns a range of integers starting from a specified value.',
    documentation: `
Returns a range of integers starting from a specified value.

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
  'RegexFind': {
    name: '@RegexFind',
    signature: '@RegexFind(text, matchExpression, [matchGroup])',
    snippet: "@RegexFind(${1:text}, ${2:matchExpression}${3:, ${4:matchGroup}})",
    description: 'Finds all matches of a regular expression in a string, optionally returning only a matched group.',
    documentation: `
Finds all matches of a regular expression in a string, optionally returning only a matched group.

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
  'AffectedPackages': {
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
  'ApiKeys': {
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
  'BuildIssues': {
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
