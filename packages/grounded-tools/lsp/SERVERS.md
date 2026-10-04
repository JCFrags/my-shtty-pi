# Supported LSP server catalog

The Language Server Protocol (LSP) carries navigation requests and diagnostic publications between Grounded and a server. This catalog supplies opt-in launch configurations. It does not install a server, select a project toolchain, accept a license, or certify runtime compatibility.

`server-presets.ts` exports `SUPPORTED_SERVER_PRESETS`. Each entry has an `id`, language name, prerequisites, notes, source URL, and qualitative cost. Direct entries have a complete `LspServerConfig`. Java, Kotlin, and SQL have manual recipes instead of executable placeholder configurations.

## Select a server

1. Read the selected entry's prerequisites and project caveats. Review the executable and any inherited configuration before launch.
2. Make the required server and project environment available to the Pi process. This catalog does not install them.
3. Add direct preset IDs to `presets` in `<agent-dir>/grounded-tools/lsp.json`. For example:

   ```json
   {
     "presets": ["json", "yaml", "taplo"],
     "automaticDiagnostics": false
   }
   ```

4. If launch paths, arguments, language IDs, or settings must change, put a complete record from the relevant section in the global `servers` array. Change that full record, not only the changed fields.
5. Reload at a safe idle point after configuration changes. Use `lsp action=status` to inspect the configuration. When a launch is authorized, exercise a navigation request and the real diagnostic path on the intended project.

The five existing defaults remain TypeScript/JavaScript, Pyright, gopls, rust-analyzer, and clangd. The catalog does not enable any additional server by default. A trusted project's `.pi/grounded-lsp.json` controls policy and `disabledServers`, not launch definitions.

### Replacement and routing

- Custom `servers` records replace the **whole** default or selected preset with the same `id`. There is no deep merge of arguments, mappings, initialization options, or settings. A scalar-only custom record remains scalar-only.
- Routing uses the lowercase last extension and the first matching server. It does not combine servers for one file. Choose either `nil` or `nixd` for Nix. Do not add Kotlin `.java` routing alongside a Java server. Distinct custom IDs can still compete for the same extension.
- `languageIds[extension]` takes precedence over the required scalar `languageId`. Preserve the CSS, JSONC, and Terraform variable mappings shown below unless a custom server needs different IDs.
- `rootMarkers` are literal names, not globs. The nearest ancestor with any marker wins. Marker order cannot make an outer root win over a nearer module. If no marker exists, the caller's working directory is used.
- The child runs in the selected root with the Pi process's environment plus the record's optional static `env` values. There is no shell, `~`/`$HOME` expansion, glob expansion, or per-root argument substitution. Use an actual executable path or a reviewed foreground wrapper. Do not put shell activation expressions in `command`. Keep credentials out of shared records.
- Servers start lazily. Automatic edit/write diagnostics remain opt-in. Cost metadata and request timeouts are not CPU, memory, network, or child-process limits.

### Settings and initialization

`initializationOptions` goes unchanged in the LSP initialize request. `settings` is a separate static object. The client advertises workspace configuration, answers `workspace/configuration` sections from that object, and sends `workspace/didChangeConfiguration` after initialization when `settings` is present. Scoped configuration requests outside the selected root return `null`. The client returns the selected root for `workspace/workspaceFolders`.

Use each server's documented structure. For example, YAML uses `settings.yaml`, while Terraform's static options go in `initializationOptions`. Do not put arbitrary editor settings into initialization options. Configuration does not add file watching, dynamic project discovery, or every editor-specific custom request.

### What support means

- **Catalog-supported:** upstream documentation or source establishes a credible foreground stdio command and the listed configuration fields. This is not an installed-version or runtime test claim.
- **Configured:** the entry is selected or supplied as a complete custom record. Configuration does not prove that an executable exists.
- **Available:** the command can be found by the runtime. That does not prove compatible libraries, project dependencies, license access, successful initialization, or feature support.
- **Ready:** the LSP transport initialized. Workspace analysis completion is still unknown.
- **Exercised:** a real request was made with the actual server/toolchain and project, and its result was observed. Check navigation and diagnostics separately.

No language server in this catalog was installed or launched to produce it. Source inspection and a syntax check do not establish exercised support. Versions, especially development branches and Alpha releases, can differ from the selected package.

Grounded observes push diagnostics from `textDocument/publishDiagnostics`. It does not request pull diagnostics with `textDocument/diagnostic`. Empty, cached, stale, unversioned, or timed-out observations do not prove a clean current-version check. Even a current-version publication has `analysisComplete: "unknown"`. Routing alone does not prove support for every navigation, rename, formatting, or code-action request. Previews do not authorize edits or server command execution.

Parsing detects syntax. Schema validation checks a selected schema. Lint checks selected code or style rules, often with separate tools. A language ID does not enable all three.

## Catalog summary

Costs are qualitative, not measured limits. Low mainly covers document parsing. Medium includes dependency indexing, schema reads, or helper processes. High includes compiler/build-system import, substantial indexing, or evaluation. Every category can become expensive in a large workspace.

| Preset ID | Language | Mode | Cost |
| --- | --- | --- | --- |
| `jdtls` | Java | Manual | High |
| `kotlin-lsp` | Kotlin | Manual | High |
| `csharp-ls` | C#/.NET | Direct | High |
| `intelephense` | PHP | Direct | Medium |
| `solargraph` | Ruby | Direct | Medium |
| `sourcekit-lsp` | Swift | Direct | High |
| `dart` | Dart | Direct | Medium |
| `html` | HTML | Direct | Low |
| `css` | CSS/SCSS/Less | Direct | Low |
| `bash` | Bash-compatible shell | Direct | Medium |
| `sqls` | SQL | Manual | Medium |
| `json` | JSON/JSONC | Direct | Low |
| `yaml` | YAML | Direct | Medium |
| `taplo` | TOML | Direct | Medium |
| `nil` | Nix | Direct alternative | Medium |
| `nixd` | Nix | Direct alternative | High |
| `terraform-ls` | Terraform | Direct | Medium |

## Complete direct records

Each JSON block below is one complete `servers` array element, not a complete global file. For example, a file with one custom record has the shape `{"servers": [record]}`. Do not copy the word `record` as JSON. Retain existing unrelated configuration.

Selected high-cost/project-analysis entries use a finite `timeoutMs` of 30000. This bounds initialize/navigation request waits, not total indexing time or resource use. Entries without it use the client's 5000 ms request default. The diagnostic publication wait has its own policy timeout.

### C#/.NET: csharp-ls

```json
{
  "id": "csharp-ls",
  "command": "csharp-ls",
  "args": [],
  "extensions": [".cs"],
  "languageId": "csharp",
  "rootMarkers": ["global.json", "Directory.Build.props", "Directory.Build.targets", "NuGet.Config", "nuget.config", ".git"],
  "timeoutMs": 30000
}
```

- Prerequisites: installed `csharp-ls`, a tool shim on `PATH`, and .NET 10 SDK+ for current upstream. The project also needs its own SDK, reference assemblies, dependencies, and any `global.json` selection.
- Cost: high. Solution import and compiler analysis can be expensive. Roslyn analyzers are off by default upstream and add work when enabled.
- For multiple solutions, change the complete record's `args` to include `--solution` and the actual solution path. Use actual literal solution/project basenames as extra root markers when needed. `*.sln` and `*.csproj` are not supported glob markers.
- This record does not restore packages or install SDKs. Successful transport startup does not prove project compilation.
- Sources: [server and CLI](https://github.com/razzmatazz/csharp-language-server), [feature settings](https://github.com/razzmatazz/csharp-language-server/blob/main/docs/features.md).

### PHP: Intelephense

```json
{
  "id": "intelephense",
  "command": "intelephense",
  "args": ["--stdio"],
  "extensions": [".php"],
  "languageId": "php",
  "rootMarkers": ["composer.json", "intelephense.config.json", ".git"]
}
```

- Prerequisites: Node.js, preferably current LTS, and an installed Intelephense package. PHP itself is not required to run this static-analysis server. The analyzed PHP version, stubs, and Composer/vendor sources affect results.
- Cost: medium, potentially high for a large index.
- Intelephense is proprietary freemium software. Some navigation/refactoring features require a license. Use the upstream-supported private mechanism if needed. Do not put license credentials in shared records.
- Workspace settings and `intelephense.config.json` are separate from supported initialization fields such as cache storage paths. PHP compiler checks, PHPStan, and Psalm remain separate checks.
- Source: [Intelephense documentation](https://intelephense.com/docs).

### Ruby: Solargraph

```json
{
  "id": "solargraph",
  "command": "solargraph",
  "args": ["stdio"],
  "extensions": [".rb"],
  "languageId": "ruby",
  "rootMarkers": [".solargraph.yml", "Gemfile", ".ruby-version", ".git"]
}
```

- Prerequisites: Ruby 3.1+ for current source, Solargraph and its gems, and the correct project Ruby, `GEM_HOME`, `GEM_PATH`, and Bundler environment.
- Cost: medium, potentially high for workspace/gem indexing.
- If Solargraph is already in the project's installed bundle, change the complete record to `"command": "bundle"` and `"args": ["exec", "solargraph", "stdio"]`. This is not a request to install a bundle.
- Solargraph publishes push diagnostics. `.solargraph.yml` selects reporters. RuboCop lint depends on the chosen reporter, rules, and plugins. A Ruby language ID does not select those rules.
- Only `.rb` is routed. `Gemfile`, `Rakefile`, ERB, and RBS need separate filename/language support.
- Ruby LSP is not a second enabled choice here. Its current diagnostics use pull requests. Its default launcher creates `.ruby-lsp`, installs a composed bundle, and attempts tooling updates. Navigation compatibility alone would not make it a drop-in diagnostic preset.
- Sources: [stdio](https://solargraph.org/guides/language-server), [reporters/configuration](https://solargraph.org/guides/configuration), [Bundler environment](https://github.com/castwide/solargraph), [Ruby minimum](https://raw.githubusercontent.com/castwide/solargraph/master/solargraph.gemspec), [Ruby LSP startup](https://shopify.github.io/ruby-lsp/composed-bundle.html), [Ruby LSP diagnostic implementation](https://raw.githubusercontent.com/Shopify/ruby-lsp/main/lib/ruby_lsp/server.rb).

### Swift: SourceKit-LSP

```json
{
  "id": "sourcekit-lsp",
  "command": "sourcekit-lsp",
  "args": [],
  "extensions": [".swift"],
  "languageId": "swift",
  "rootMarkers": ["Package.swift", "buildServer.json", "compile_commands.json", ".git"],
  "initializationOptions": {"backgroundIndexing": false},
  "timeoutMs": 30000
}
```

- Prerequisites: a matching Swift toolchain, `sourcekitd`, required host libraries, and usable project SDK/build settings. Prefer the actual toolchain binary when `PATH` selects a different toolchain.
- Cost: high. SwiftPM/build-server work and indexing can be substantial. The executable uses stdin/stdout without a `--stdio` flag.
- Swift 6.1+ enables background indexing by default upstream. This record disables it conservatively. Index-dependent navigation can be limited, and workspace `.sourcekit-lsp/config.json` has higher precedence and can override the initializer. The configuration structure can change between toolchains.
- SwiftPM projects use `Package.swift`. Other build systems need a working Build Server Protocol (BSP) integration or compilation database. Adding `.xcodeproj` routing does not supply Xcode build integration.
- On macOS, an operator may instead use `xcrun` with `--toolchain`, the actual selected toolchain, and `sourcekit-lsp`. That is not a Linux launcher.
- Sources: [server](https://github.com/swiftlang/sourcekit-lsp), [stdio implementation](https://raw.githubusercontent.com/swiftlang/sourcekit-lsp/main/Sources/sourcekit-lsp/SourceKitLSP.swift), [indexing defaults](https://github.com/swiftlang/sourcekit-lsp/blob/main/Documentation/Enable%20Experimental%20Background%20Indexing.md), [initialization/configuration precedence](https://raw.githubusercontent.com/swiftlang/sourcekit-lsp/main/Documentation/Configuration%20File.md).

### Dart

```json
{
  "id": "dart",
  "command": "dart",
  "args": ["language-server", "--protocol=lsp"],
  "extensions": [".dart"],
  "languageId": "dart",
  "rootMarkers": ["pubspec.yaml", ".git"],
  "timeoutMs": 30000
}
```

- Prerequisites: the project-selected Dart SDK, or Dart from the matching Flutter SDK, and the project's installed dependencies/package configuration. `analysis_options.yaml` affects checks.
- Cost: medium to high, depending on project analysis.
- The explicit `--protocol=lsp` option is supported and avoids historical CLI ambiguity. The server uses foreground stdio.
- An unrelated system Dart is not a safe substitute for an incompatible Flutter project. Change the complete record's executable to the actual SDK binary if needed.
- Upstream supports `initializationOptions: {"onlyAnalyzeProjectsWithOpenFiles": true}` as an optional narrower mode. It analyzes opened files' **projects**, not just those individual files. It is not a single-file resource limit.
- Sources: [LSP contract](https://github.com/dart-lang/sdk/blob/main/pkg/analysis_server/tool/lsp_spec/README.md), [CLI transport](https://raw.githubusercontent.com/dart-lang/sdk/main/pkg/dartdev/lib/src/commands/language_server.dart).

### HTML

```json
{
  "id": "html",
  "command": "vscode-html-language-server",
  "args": ["--stdio"],
  "extensions": [".html", ".htm"],
  "languageId": "html",
  "rootMarkers": ["package.json", ".git"]
}
```

- Prerequisites: Node.js and a compatible installed `vscode-langservers-extracted` package. This is community packaging of Microsoft's servers, not the complete VS Code extension integration.
- Cost: low to medium.
- HTML navigation can be useful, but the server's validation pipeline mainly checks embedded CSS/JavaScript. It is not a general HTML conformance linter.
- Framework/template languages need an appropriate server or supported integration. Custom-data integration can use client-specific requests that Grounded does not provide.
- Sources: [command package](https://github.com/hrsh7th/vscode-langservers-extracted), [server contract](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/html-language-features/server/src/htmlServer.ts), [HTML validation mode](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/html-language-features/server/src/modes/htmlMode.ts).

### CSS, SCSS, and Less

```json
{
  "id": "css",
  "command": "vscode-css-language-server",
  "args": ["--stdio"],
  "extensions": [".css", ".scss", ".less"],
  "languageId": "css",
  "languageIds": {".css": "css", ".scss": "scss", ".less": "less"},
  "rootMarkers": ["package.json", ".git"]
}
```

- Prerequisites: Node.js and a compatible installed `vscode-langservers-extracted` package.
- Cost: low to medium.
- Preserve each document ID. A scalar-only custom record does not inherit this mapping.
- Parser/validation rules are not Stylelint, Sass compilation, PostCSS plugin execution, or a project build. Custom-data integration can require editor-specific requests.
- Sources: [command package](https://github.com/hrsh7th/vscode-langservers-extracted), [server contract](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/css-language-features/server/src/cssServer.ts).

### Bash-compatible shell

```json
{
  "id": "bash",
  "command": "bash-language-server",
  "args": ["start"],
  "extensions": [".sh", ".bash"],
  "languageId": "shellscript",
  "rootMarkers": [".git"]
}
```

- Prerequisites: Node 20+ for current upstream and the installed server. ShellCheck is optional for the server but required for its external lint diagnostics. shfmt is optional formatting support, not a diagnostic prerequisite.
- Cost: medium when source discovery or ShellCheck processes add work.
- The stdio command is `start`, not `--stdio`. The Bash parser is not universal support for zsh, fish, PowerShell, or all shell dialects. ShellCheck directives and the project environment affect lint.
- Extensionless scripts and `.bashrc` are not selected by the last-extension router.
- Source: [server CLI, requirements, and checks](https://github.com/bash-lsp/bash-language-server).

### JSON and JSONC

```json
{
  "id": "json",
  "command": "vscode-json-language-server",
  "args": ["--stdio"],
  "extensions": [".json", ".jsonc"],
  "languageId": "json",
  "languageIds": {".json": "json", ".jsonc": "jsonc"},
  "rootMarkers": [".git"]
}
```

- Prerequisites: Node.js and a compatible installed `vscode-langservers-extracted` package.
- Cost: low, plus schema/cache work.
- Map `.jsonc` to `jsonc`. JSON5 is not JSONC and is excluded.
- Syntax parsing and validation against a selected `$schema` are different. Schema reads can use local files or HTTP. Disabling another server's SchemaStore does not block this server's network access.
- Launching the executable alone does not supply VS Code's complete schema associations. Upstream selects push diagnostics when the client does not advertise pull support.
- Sources: [command package](https://github.com/hrsh7th/vscode-langservers-extracted), [server settings/transport](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/json-language-features/server/src/jsonServer.ts).

### YAML

```json
{
  "id": "yaml",
  "command": "yaml-language-server",
  "args": ["--stdio"],
  "extensions": [".yaml", ".yml"],
  "languageId": "yaml",
  "rootMarkers": [".git"],
  "settings": {"yaml": {"schemaStore": {"enable": false}}}
}
```

- Prerequisites: Node.js and installed `yaml-language-server`.
- Cost: medium when schema/network work is included.
- This record disables automatic SchemaStore catalog associations through `settings.yaml.schemaStore.enable`. It does **not** deny network access, disable every schema source, or prove that no download occurs. Explicit schemas, modelines, and other upstream schema mechanisms can still read remote data.
- `settings.yaml.schemas`, `customTags`, and `yamlVersion` are workspace settings. They do not belong in a guessed initialization object. Use a complete custom record to set the application's actual schema and parser options. YAML 1.2 is the upstream default.
- A supported modeline is `# yaml-language-server: $schema=<schema-url-or-path>`. Replace the schema reference with an actual one. Relative modeline paths resolve from the YAML file, not the workspace root.
- Parsing, selected-schema validation, and yamllint are separate. A successful publication does not prove that Kubernetes or another application schema was selected.
- Sources: [settings and schema routes](https://github.com/redhat-developer/yaml-language-server), [workspace configuration handler](https://raw.githubusercontent.com/redhat-developer/yaml-language-server/main/src/languageserver/handlers/settingsHandlers.ts).

### TOML: Taplo

```json
{
  "id": "taplo",
  "command": "taplo",
  "args": ["lsp", "stdio"],
  "extensions": [".toml"],
  "languageId": "toml",
  "rootMarkers": [".taplo.toml", "taplo.toml", "Cargo.toml", "pyproject.toml", ".git"]
}
```

- Prerequisites: an LSP-enabled native Taplo build. Upstream warns that default builds lack LSP and the npm CLI does not include it. A command named `taplo` alone is not proof that `lsp stdio` is supported. Rust is a source-build prerequisite, not a runtime requirement for the installed native binary.
- Cost: medium with schemas/catalogs/cache work.
- Use `.taplo.toml` or `taplo.toml` for project configuration. Initializer `cachePath` and `configurationSection` are distinct from schema settings. The documented settings section defaults to `evenBetterToml`.
- TOML parsing, selected-schema validation, and format policy are separate. Catalog/schema reads can use network.
- Sources: [LSP-enabled binary/command](https://taplo.tamasfe.dev/cli/usage/language-server.html), [file configuration](https://taplo.tamasfe.dev/configuration/file.html), [initializer and settings structure](https://github.com/tamasfe/taplo/blob/master/crates/taplo-lsp/src/config.rs).

### Nix: nil

```json
{
  "id": "nil",
  "command": "nil",
  "args": [],
  "extensions": [".nix"],
  "languageId": "nix",
  "rootMarkers": ["flake.nix", "shell.nix", "default.nix", ".git"]
}
```

- Prerequisites: native `nil`. Nix 2.4+ is needed for documented flake/evaluation functionality. Current source builds require Rust 1.89+, not a runtime Rust installation. Use the project's Nix/development-shell environment when evaluation features need it.
- Cost: medium for static/dependency use, potentially high when evaluating inputs or options.
- Choose `nil` or `nixd`, not both for the same route. First-match routing does not combine diagnostics or navigation.
- `nil` configuration is a workspace settings section, not initialization options. Formatting uses a separate executable. `autoEvalInputs` defaults off upstream, but configured evaluation/archive behavior can still be expensive and use network.
- Static diagnostics are not proof that a NixOS/Home Manager configuration evaluates or builds.
- Sources: [server](https://github.com/oxalica/nil), [settings/evaluation](https://github.com/oxalica/nil/blob/main/docs/configuration.md).

### Nix: nixd

```json
{
  "id": "nixd",
  "command": "nixd",
  "args": [],
  "extensions": [".nix"],
  "languageId": "nix",
  "rootMarkers": ["flake.nix", "shell.nix", ".git"],
  "timeoutMs": 30000
}
```

- Prerequisites: a compatible nixd/Nix-library package and a working Nix environment. Avoid mixed incompatible Nix libraries.
- Cost: high. Package/options evaluation can fork helpers and consume substantial CPU/memory.
- Choose `nixd` or `nil`, not both. Default package evaluation uses `import <nixpkgs> { }`. Flake-only environments need suitable `NIX_PATH` or actual `settings.nixd` expressions.
- Host/module expressions are operator-specific. No generic hostname, module selection, formatter, or resource cap is supplied. Put documented settings in `settings`, not initialization options.
- Sources: [editor/stdio setup](https://github.com/nix-community/nixd/blob/main/nixd/docs/editor-setup.md), [evaluation/settings](https://github.com/nix-community/nixd/blob/main/nixd/docs/configuration.md).

### Terraform

```json
{
  "id": "terraform-ls",
  "command": "terraform-ls",
  "args": ["serve"],
  "extensions": [".tf", ".tfvars"],
  "languageId": "terraform",
  "languageIds": {".tf": "terraform", ".tfvars": "terraform-vars"},
  "rootMarkers": [".terraform", ".terraform.lock.hcl", ".git"],
  "initializationOptions": {"experimentalFeatures": {"validateOnSave": false}},
  "timeoutMs": 30000
}
```

- Prerequisites: installed `terraform-ls`. Terraform CLI and initialized/downloaded provider/module data are needed for Terraform-backed features. This record does not run `terraform init` or download providers.
- Cost: medium, potentially high for indexing/provider discovery or opted-in CLI operations.
- `.tfvars` uses `terraform-vars`, not `terraform`. Do not route arbitrary `.hcl`, Packer, `.tf.json`, `.tfvars.json`, or compound HCL dialects to this record. The last-extension router cannot distinguish the upstream compound suffix IDs. A JSON server can still parse a `.tf.json` file as JSON, not as Terraform.
- The supported initializer sets `experimentalFeatures.validateOnSave` to false. Turning it on runs `terraform validate` after saves under upstream's module/root constraints. It is not an open-file validation guarantee.
- Syntax/enhanced diagnostics are not a complete `terraform validate`, TFLint, plan, or security scan. `rootModulePaths` is deprecated and ignored since v0.29. The cited upstream feature matrix does not implement rename.
- No init, download, plan, or apply hooks are added. Server configuration is not authorization for infrastructure changes.
- Sources: [server](https://github.com/hashicorp/terraform-ls), [stdio and file IDs](https://github.com/hashicorp/terraform-ls/blob/main/docs/USAGE.md), [initializer keys](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/docs/SETTINGS.md), [validation boundaries](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/docs/validation.md), [feature matrix](https://raw.githubusercontent.com/hashicorp/terraform-ls/main/docs/features.md).

## Manual recipes

These catalog entries deliberately have no `config`. Do not select them in `presets` as if they were direct entries. Complete operator-reviewed custom `servers` records are required. No executable placeholder record is provided.

### Java: Eclipse JDT LS

Prerequisites: an installed JDT LS distribution, Java 21+ to run it, and Python 3.9+ for the upstream wrapper. The project's target JDK and Maven/Gradle environment are separate. Cost: high. JVM startup and build import can download dependencies and run project tooling.

1. Select the actual installed distribution's `bin/jdtls` foreground wrapper. Leave `CLIENT_PORT` and other socket-related launcher settings unset for stdio.
2. Select actual writable `-configuration` and `-data` directories. Give each canonical project root its own data directory. Coordinate simultaneous clients so they do not share it.
3. For more than one root, use an operator-controlled foreground wrapper with per-root storage ownership, or limit the configuration to one root. Static Grounded args cannot substitute a root-specific path. The upstream wrapper's current default data key hashes the working-directory **basename**, so same-named roots can collide. Its `-Xms1G` default is not a memory cap.
4. Create a complete custom record with ID `jdtls`, extension `.java`, scalar `java`, and a suitable finite timeout. Suggested literal roots are `pom.xml`, `settings.gradle`, `settings.gradle.kts`, `build.gradle`, `build.gradle.kts`, `.project`, and `.git`.
5. If project runtimes need explicit paths, use the selected version's documented `initializationOptions.settings.java.configuration.runtimes` contract. Keep actual runtime and storage paths local to the operator's configuration.

If Java is invoked directly instead of through the wrapper, select the **installed** Equinox launcher JAR, platform configuration directory, JVM flags, and data directory. Do not copy a versioned README example JAR filename as a universal launcher.

Sources: [requirements/server](https://github.com/eclipse-jdtls/eclipse.jdt.ls), [initialization shape](https://github.com/eclipse-jdtls/eclipse.jdt.ls/wiki/Running-the-JAVA-LS-server-from-the-command-line), [wrapper storage/JVM behavior](https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/org.eclipse.jdt.ls.product/scripts/jdtls.py).

### Kotlin: official Kotlin LSP

Prerequisites: the selected platform-specific distribution, its matching runtime, and the project's build JDK. Since v262.4739.0, upstream uses `bin/intellij-server` and requires JDK 25. Recent product documentation describes bundled JetBrains Runtime (JBR). The server is Alpha, partially closed-source, and its release contract can change. Cost: high.

1. Review the selected release's license, region, and data-sharing requirements. Make the operator's choices explicitly. Do not fabricate acceptance or copy another client's consent metadata.
2. Select the actual distribution's `bin/intellij-server` with `--stdio` and release-required operator options. Keep it in the foreground. `kotlin-lsp.sh` is now a deprecated forwarding wrapper. Do not use the daemonizing TCP/router route with Grounded's spawned-child lifecycle.
3. Create a complete custom record with ID `kotlin-lsp`, extensions `.kt` and `.kts`, scalar `kotlin`, and a finite timeout. Suggested literal roots are `settings.gradle`, `settings.gradle.kts`, `build.gradle`, `build.gradle.kts`, `pom.xml`, and `.git`. Do not add `.java` alongside a Java server.
4. Use the selected release's initializer when needed. Current source sends `defaultSdk`, `buildTools`, `projects`, `disableRocksDBWriteAheadLog`, and optional `fromWorkspace`. Project entries use actual absolute file URIs and a project type. Import options can download artifacts or run generators. Editor `kotlinLSP.*` settings are not a substitute for that contract.

Sources: [server](https://github.com/Kotlin/kotlin-lsp), [release/runtime changes](https://github.com/Kotlin/kotlin-lsp/releases), [actual stdio/consent handling](https://raw.githubusercontent.com/Kotlin/kotlin-lsp/main/vscode-extension-core/src/lspClient.ts), [project initializer](https://raw.githubusercontent.com/Kotlin/kotlin-lsp/main/vscode-extension-core/src/initializationSettings.ts), [runtime/settings details](https://www.jetbrains.com/help/intellij-vscode/IntelliJ-lsp-settings.html).

### SQL: sqls

Prerequisites: an installed native `sqls` binary. A source build needs upstream's Go/cgo requirements, but a prebuilt binary does not need Go at runtime. Database-backed features need a compatible driver and explicitly selected reachable database. Cost: medium, plus database/network work. Upstream does not promise a stable interface or universal dialect/lint support.

1. Review existing global configuration and configuration precedence. A no-argument launch can inherit connection settings and connect to a database.
2. Select the intended private config file and reviewed database/driver/access permissions. Keep credentials in that private file, not in argv, shared JSON, or preset metadata.
3. Use foreground `sqls` with `-config` and the actual selected file path. Use a no-argument launch only after deliberate review.
4. Create a complete custom record with ID `sqls`, extension `.sql`, scalar `sql`, and suitable literal roots such as `.git`.
5. Exercise only the authorized navigation/diagnostic behavior. Grounded does not execute server database-query commands. Do not add query execution to preset setup.

A SQL document route does not establish schema access, a selected dialect, lint coverage, or permission to query a database.

Sources: [server/configuration](https://github.com/sqls-server/sqls), [stdio/config selection](https://github.com/sqls-server/sqls/blob/master/main.go), [source-build dependencies](https://github.com/sqls-server/sqls/blob/master/go.mod).
