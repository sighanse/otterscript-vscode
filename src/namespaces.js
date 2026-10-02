// @ts-check
/**
 * @fileoverview The valid OtterScript namespace prefixes. Its own module so
 * that scripts/update-inedo-reference.js can read it without loading
 * language-data.js, which loads the data that script generates. language-data.js
 * re-exports it.
 */

/**
 * The set of valid OtterScript namespace prefixes: `Core` (the built-in engine
 * namespace — every unqualified operation/function may optionally be written as
 * `Core::Name`) plus every first-party extension's declared `[ScriptNamespace]`
 * token, verified against Inedo source (github.com/Inedo/inedox-*). A value here
 * is never a typo, so the `unknown-namespace` diagnostic never flags a
 * legitimate prefix.
 *
 * A `DocEntry.namespace` is either `null` (no `[ScriptNamespace]` on the class
 * or its assembly — the common case; such constructs are `Core::` built-ins and
 * are shown without a namespace) or one of the tokens below. NOTE: an extension's
 * name is not a namespace — e.g. the InedoCore extension declares only
 * `Files`, `HTTP`, `Network`, `ProGet`, `UPack`, `Otter`; there is no
 * `InedoCore::` prefix.
 *
 * Not included, because no public source declares them: `DB::`, `Packages::`
 * and `System::`, which only BuildMaster's generated operation reference
 * shows (`DB::Backup-Database`, `Packages::Attach-Package`,
 * `System::Backup-Application` -- BuildMaster's own, closed-source
 * operations).
 *
 * Single source of truth for diagnostics, the docs-table check in the tests, the grammar sync
 * check, and any namespace-aware editor feature.
 *
 * `Object.freeze` does not stop `Set.prototype.add`; read-only-ness is enforced
 * by the `ReadonlySet` type under `// @ts-check`, not at runtime.
 *
 * @type {ReadonlySet<string>}
 */
const NAMESPACES = Object.freeze(
  new Set([
    // -- Built-in engine namespace (optional prefix for any unqualified name)
    "Core",
    // -- Every [ScriptNamespace] declared in Inedo's public extensions
    //    (github.com/Inedo/inedox-*, all 42 scanned 2026-10-02), by repository.
    //    Names are matched case-insensitively (inedox-scripting also declares
    //    "python").
    "Files", "HTTP", "Network", "ProGet", "UPack", "Otter", // inedox-inedocore
    "Windows", "IIS", "Firewall",                           // inedox-windows
    "DotNet", "DevEnv", "MSBuild", "NuGet", "WindowsSDK",   // inedox-dotnet (DotNet/MSBuild also inedox-windowssdk)
    "Scripting", "PowerShell", "Linux",                     // inedox-scripting (Linux also inedox-linux)
    "Python", "Pip",                                        // inedox-python
    "Artifactory",                                          // inedox-artifactory
    "AWS",                                                  // inedox-aws
    "Azure",                                                // inedox-azure
    "AzureDevOps",                                          // inedox-azuredevops
    "Bitbucket",                                            // inedox-bitbucket
    "Chocolatey",                                           // inedox-chocolatey
    "Docker",                                               // inedox-docker
    "FTP",                                                  // inedox-ftp
    "Git",                                                  // inedox-git
    "Gitea",                                                // inedox-gitea
    "GitHub",                                               // inedox-github
    "GitLab",                                               // inedox-gitlab
    "GoogleCloud",                                          // inedox-googlecloud
    "Java",                                                 // inedox-java
    "Jenkins",                                              // inedox-jenkins
    "Jira",                                                 // inedox-jira
    "Kubernetes",                                           // inedox-kubernetes
    "Loupe",                                                // inedox-loupe
    "Mercurial",                                            // inedox-mercurial
    "nginx",                                                // inedox-nginx
    "npm",                                                  // inedox-node
    "NUnit",                                                // inedox-nunit
    "PHP", "Composer",                                      // inedox-php
    "SqlServer",                                            // inedox-sqlserver
    "TeamCity",                                             // inedox-teamcity
    "TFS",                                                  // inedox-tfs
    "YouTrack",                                             // inedox-youtrack
  ])
);

module.exports = { NAMESPACES };
