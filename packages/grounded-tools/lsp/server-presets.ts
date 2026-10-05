import type { LspServerConfig } from "@grounded/pi-core/lsp-client";

export interface SupportedServerPreset {
  id: string;
  language: string;
  config?: LspServerConfig;
  prerequisites: string[];
  notes: string[];
  source: string;
  cost: "low" | "medium" | "high";
  recipe?: string;
}

// This catalog is opt-in launch data, not an installer or a runtime compatibility check.
// Recipe-only entries deliberately omit config. Custom records replace a complete config by ID.
export const SUPPORTED_SERVER_PRESETS: readonly SupportedServerPreset[] = [
  {
    id: "jdtls",
    language: "Java",
    prerequisites: [
      "An installed Eclipse JDT LS distribution, Java 21+, and Python 3.9+ for its upstream wrapper.",
      "The project's required JDK, Maven/Gradle environment, and writable per-root server storage.",
    ],
    notes: [
      "High-cost JVM startup and build-system import can download dependencies or run project tooling.",
      "The wrapper's default data key uses the working-directory basename. Same-named roots can collide, and simultaneous clients must not share a data directory.",
      "Leave CLIENT_PORT and socket-related launcher settings unset for stdio. Static args do not expand per-root storage paths.",
    ],
    source: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
    cost: "high",
    recipe: "Use the installed distribution's bin/jdtls in the foreground. Supply actual writable -configuration and unique -data directories. For multiple roots, use an operator-controlled foreground wrapper that derives and owns separate storage, or limit the config to one root. Do not copy a versioned example Equinox JAR. Create a complete custom record with id jdtls, extensions [.java], languageId java, literal Maven/Gradle/.project root markers, and a finite timeout after reviewing the project environment.",
  },
  {
    id: "kotlin-lsp",
    language: "Kotlin",
    prerequisites: [
      "The selected platform-specific Kotlin LSP distribution and its supported runtime. Recent releases require JDK 25 or ship a matching JBR.",
      "The project's required build JDK and an operator-reviewed release-specific license, region, and data-sharing configuration.",
    ],
    notes: [
      "The official server is Alpha. Current releases use bin/intellij-server, not the deprecated kotlin-lsp.sh forwarding wrapper.",
      "Project import can download artifacts and run generators. Use the selected release's initializer and consent contract.",
      "Use the direct --stdio foreground route, not the daemonizing TCP/router route. Do not add .java routing alongside a Java server.",
    ],
    source: "https://github.com/Kotlin/kotlin-lsp",
    cost: "high",
    recipe: "Review the selected release's runtime, license, region, and data-sharing requirements before launch. Configure its actual bin/intellij-server with --stdio and any required operator-selected options. Create a complete custom record with id kotlin-lsp, extensions [.kt,.kts], languageId kotlin, literal Gradle/Maven root markers, and a finite timeout. Supply actual file URIs for release-specific project initialization when needed. Never fabricate acceptance or use a background daemon launcher.",
  },
  {
    id: "csharp-ls",
    language: "C#/.NET",
    config: {
      id: "csharp-ls",
      command: "csharp-ls",
      args: [],
      extensions: [".cs"],
      languageId: "csharp",
      rootMarkers: ["global.json", "Directory.Build.props", "Directory.Build.targets", "NuGet.Config", "nuget.config", ".git"],
      timeoutMs: 30000,
    },
    prerequisites: [
      "Installed csharp-ls with its tool shim on PATH and .NET 10 SDK+ for current upstream.",
      "The project's SDK, reference assemblies, and dependencies, including any global.json SDK selection.",
    ],
    notes: [
      "Ambiguous workspaces may need a complete custom record with --solution and the actual solution path.",
      "Root markers are literal names. *.sln and *.csproj are not supported glob markers.",
      "Roslyn analyzers are off by default upstream. Enabling them can increase CPU and latency. This preset does not install SDKs or restore packages.",
    ],
    source: "https://github.com/razzmatazz/csharp-language-server",
    cost: "high",
  },
  {
    id: "intelephense",
    language: "PHP",
    config: {
      id: "intelephense",
      command: "intelephense",
      args: ["--stdio"],
      extensions: [".php"],
      languageId: "php",
      rootMarkers: ["composer.json", "intelephense.config.json", ".git"],
    },
    prerequisites: [
      "Node.js, preferably current LTS, and an installed Intelephense server package.",
      "Correct project vendor sources, PHP version settings, and stubs for useful analysis.",
    ],
    notes: [
      "PHP is not required to run this static-analysis server. PHP compiler checks, PHPStan, and Psalm are separate checks.",
      "Intelephense is freemium. Some navigation and refactoring features require a license. No credential is included in this preset.",
      "Use documented workspace settings or intelephense.config.json. Large workspaces can make indexing expensive.",
    ],
    source: "https://intelephense.com/docs",
    cost: "medium",
  },
  {
    id: "solargraph",
    language: "Ruby",
    config: {
      id: "solargraph",
      command: "solargraph",
      args: ["stdio"],
      extensions: [".rb"],
      languageId: "ruby",
      rootMarkers: [".solargraph.yml", "Gemfile", ".ruby-version", ".git"],
    },
    prerequisites: [
      "Ruby 3.1+ for current source, installed Solargraph, and its gem dependencies.",
      "The correct project Ruby, GEM_HOME/GEM_PATH, and Bundler environment.",
    ],
    notes: [
      "For an installed project bundle, a complete custom record can use command bundle and args [exec,solargraph,stdio].",
      "Solargraph publishes push diagnostics. Reporters in .solargraph.yml select checks. RuboCop rules and plugins remain separate prerequisites.",
      "Only .rb files are routed. Gemfile, Rakefile, ERB, and RBS need separate routing support. Ruby LSP is not included because its diagnostic path is pull-only and its default startup installs/updates a composed bundle.",
    ],
    source: "https://solargraph.org/guides/language-server",
    cost: "medium",
  },
  {
    id: "sourcekit-lsp",
    language: "Swift",
    config: {
      id: "sourcekit-lsp",
      command: "sourcekit-lsp",
      args: [],
      extensions: [".swift"],
      languageId: "swift",
      rootMarkers: ["Package.swift", "buildServer.json", "compile_commands.json", ".git"],
      initializationOptions: { backgroundIndexing: false },
      timeoutMs: 30000,
    },
    prerequisites: [
      "A matching Swift toolchain, SourceKit-LSP, sourcekitd, and required host libraries.",
      "Working SwiftPM, build-server, or compilation-database integration and the project's SDK/build settings.",
    ],
    notes: [
      "The plain executable uses stdin/stdout. It does not need --stdio. Select an actual toolchain binary when PATH points to a different toolchain.",
      "Initialization disables background indexing conservatively. Workspace .sourcekit-lsp/config.json can override it, and index-dependent navigation can be limited.",
      "Swift 6.1+ enables background indexing by default upstream. Disabling it is not a CPU or memory limit. Xcode projects require real build integration.",
    ],
    source: "https://github.com/swiftlang/sourcekit-lsp",
    cost: "high",
  },
  {
    id: "dart",
    language: "Dart",
    config: {
      id: "dart",
      command: "dart",
      args: ["language-server", "--protocol=lsp"],
      extensions: [".dart"],
      languageId: "dart",
      rootMarkers: ["pubspec.yaml", ".git"],
      timeoutMs: 30000,
    },
    prerequisites: [
      "The project's Dart SDK, or Dart from the matching Flutter SDK, on PATH.",
      "The project's installed dependencies, package configuration, and analysis_options.yaml.",
    ],
    notes: [
      "The explicit --protocol=lsp flag avoids historical CLI protocol ambiguity. The child remains in the foreground on stdio.",
      "An unrelated system Dart can give incorrect results for a Flutter project. Use a complete custom record with the actual SDK executable when needed.",
      "Workspace analysis can be expensive. Optional onlyAnalyzeProjectsWithOpenFiles initialization limits analysis to opened files' projects, not to individual files.",
    ],
    source: "https://github.com/dart-lang/sdk/blob/main/pkg/analysis_server/tool/lsp_spec/README.md",
    cost: "medium",
  },
  {
    id: "html",
    language: "HTML",
    config: {
      id: "html",
      command: "vscode-html-language-server",
      args: ["--stdio"],
      extensions: [".html", ".htm"],
      languageId: "html",
      rootMarkers: ["package.json", ".git"],
    },
    prerequisites: ["Node.js and an installed compatible vscode-langservers-extracted package."],
    notes: [
      "This package extracts Microsoft's servers. It does not install the VS Code extension integration.",
      "HTML validation is mainly embedded CSS/JavaScript validation, not a general HTML conformance linter.",
      "Framework templates and custom-data integrations can need a different server or client-specific requests.",
    ],
    source: "https://github.com/hrsh7th/vscode-langservers-extracted",
    cost: "low",
  },
  {
    id: "css",
    language: "CSS/SCSS/Less",
    config: {
      id: "css",
      command: "vscode-css-language-server",
      args: ["--stdio"],
      extensions: [".css", ".scss", ".less"],
      languageId: "css",
      languageIds: { ".css": "css", ".scss": "scss", ".less": "less" },
      rootMarkers: ["package.json", ".git"],
    },
    prerequisites: ["Node.js and an installed compatible vscode-langservers-extracted package."],
    notes: [
      "Preserve css, scss, and less document IDs. A scalar-only custom record remains scalar-only.",
      "Parsing and language-server validation are not Stylelint, Sass compilation, PostCSS execution, or a project build.",
      "Custom-data integrations can require client-specific requests not provided by Grounded.",
    ],
    source: "https://github.com/hrsh7th/vscode-langservers-extracted",
    cost: "low",
  },
  {
    id: "bash",
    language: "Bash-compatible shell",
    config: {
      id: "bash",
      command: "bash-language-server",
      args: ["start"],
      extensions: [".sh", ".bash"],
      languageId: "shellscript",
      rootMarkers: [".git"],
    },
    prerequisites: [
      "Node 20+ for current upstream and an installed bash-language-server.",
      "Optional ShellCheck for external lint diagnostics. Optional shfmt for formatting support.",
    ],
    notes: [
      "The foreground stdio command is start, not --stdio. Workspace source discovery and ShellCheck can add work.",
      "Bash parsing does not cover every shell dialect, zsh, fish, or PowerShell. ShellCheck directives and project environment affect its lint results.",
      "Extensionless scripts and .bashrc are not selected by the last-extension router.",
    ],
    source: "https://github.com/bash-lsp/bash-language-server",
    cost: "medium",
  },
  {
    id: "sqls",
    language: "SQL",
    prerequisites: [
      "An installed sqls native binary and a reviewed dialect/schema configuration.",
      "An explicitly selected private database connection profile when database-backed features are wanted.",
    ],
    notes: [
      "The server can read inherited global configuration and connect to a database. Review connection and query permissions before opting in.",
      "Database/schema intelligence depends on the actual driver and database. There is no universal SQL lint or dialect guarantee, and upstream does not promise a stable interface.",
      "Keep credentials out of argv and preset data. Grounded does not execute the server's database query commands.",
    ],
    source: "https://github.com/sqls-server/sqls",
    cost: "medium",
    recipe: "Review sqls configuration precedence and existing global connections. Select an actual private config file and use sqls in the foreground with -config and that file path, or deliberately review a no-argument launch. Create a complete custom record with id sqls, extensions [.sql], languageId sql, and literal root markers such as .git. Keep connection credentials in the private config, not in argv or shared JSON. Confirm the intended database, driver, and access permissions before launch. Do not add query-execution actions.",
  },
  {
    id: "json",
    language: "JSON/JSONC",
    config: {
      id: "json",
      command: "vscode-json-language-server",
      args: ["--stdio"],
      extensions: [".json", ".jsonc"],
      languageId: "json",
      languageIds: { ".json": "json", ".jsonc": "jsonc" },
      rootMarkers: [".git"],
    },
    prerequisites: ["Node.js and an installed compatible vscode-langservers-extracted package."],
    notes: [
      "JSONC uses jsonc. JSON5 is not JSONC and is not routed by this preset.",
      "Syntax parsing and validation against a selected $schema are distinct. Schema files/HTTP reads can add network and cache work.",
      "VS Code schema associations are not supplied by the executable alone. Upstream falls back to push diagnostics when the client does not advertise pull support.",
    ],
    source: "https://github.com/hrsh7th/vscode-langservers-extracted",
    cost: "low",
  },
  {
    id: "yaml",
    language: "YAML",
    config: {
      id: "yaml",
      command: "yaml-language-server",
      args: ["--stdio"],
      extensions: [".yaml", ".yml"],
      languageId: "yaml",
      rootMarkers: [".git"],
      settings: { yaml: { schemaStore: { enable: false } } },
    },
    prerequisites: ["Node.js and an installed yaml-language-server."],
    notes: [
      "The preset disables automatic SchemaStore catalog associations through workspace settings. It does not deny network access or disable all schema downloads.",
      "Use settings.yaml.schemas, customTags, and yamlVersion or a supported document schema modeline for the actual project. YAML 1.2 is the upstream default.",
      "Parsing, selected-schema validation, and yamllint are separate checks. SchemaStore being off does not prove an application schema was selected.",
    ],
    source: "https://github.com/redhat-developer/yaml-language-server",
    cost: "medium",
  },
  {
    id: "taplo",
    language: "TOML",
    config: {
      id: "taplo",
      command: "taplo",
      args: ["lsp", "stdio"],
      extensions: [".toml"],
      languageId: "toml",
      rootMarkers: [".taplo.toml", "taplo.toml", "Cargo.toml", "pyproject.toml", ".git"],
    },
    prerequisites: ["An installed native Taplo build with the LSP feature. Default builds and the npm CLI may lack it."],
    notes: [
      "Confirm that the chosen package supports lsp stdio. Installing the CLI name alone does not establish LSP availability.",
      "Use .taplo.toml or taplo.toml for project configuration. Initializer cachePath/configurationSection are distinct from schema settings.",
      "TOML parsing, selected-schema validation, and format policy are separate checks. Catalogs and schema reads can use network/cache resources.",
    ],
    source: "https://taplo.tamasfe.dev/cli/usage/language-server.html",
    cost: "medium",
  },
  {
    id: "nil",
    language: "Nix",
    config: {
      id: "nil",
      command: "nil",
      args: [],
      extensions: [".nix"],
      languageId: "nix",
      rootMarkers: ["flake.nix", "shell.nix", "default.nix", ".git"],
    },
    prerequisites: [
      "An installed nil native binary. Nix 2.4+ is needed for documented flake/evaluation functionality.",
      "The project's Nix/development-shell environment when evaluation features are used.",
    ],
    notes: [
      "Choose nil or nixd, not both for the same .nix route. First-match routing does not combine servers.",
      "Documented nil options are workspace settings. Do not move them into initializationOptions. Formatting uses a separate executable.",
      "Static diagnostics do not prove NixOS/Home Manager evaluation or builds. autoEvalInputs defaults off upstream, but enabled evaluation/archive features can be expensive and use network.",
    ],
    source: "https://github.com/oxalica/nil",
    cost: "medium",
  },
  {
    id: "nixd",
    language: "Nix",
    config: {
      id: "nixd",
      command: "nixd",
      args: [],
      extensions: [".nix"],
      languageId: "nix",
      rootMarkers: ["flake.nix", "shell.nix", ".git"],
      timeoutMs: 30000,
    },
    prerequisites: [
      "An installed nixd package with compatible Nix libraries and a working Nix environment.",
      "An appropriate NIX_PATH or reviewed settings.nixd expressions for the actual package/module environment.",
    ],
    notes: [
      "Choose nixd or nil, not both for the same .nix route. First-match routing does not combine servers.",
      "Default package evaluation uses import <nixpkgs> { }. Flake-only projects may need real workspace settings or NIX_PATH.",
      "Package/options evaluation can fork helpers and consume substantial CPU/memory. No generic host/module expressions, formatter, or resource cap are supplied.",
    ],
    source: "https://github.com/nix-community/nixd/blob/main/nixd/docs/configuration.md",
    cost: "high",
  },
  {
    id: "terraform-ls",
    language: "Terraform",
    config: {
      id: "terraform-ls",
      command: "terraform-ls",
      args: ["serve"],
      extensions: [".tf", ".tfvars"],
      languageId: "terraform",
      languageIds: { ".tf": "terraform", ".tfvars": "terraform-vars" },
      rootMarkers: [".terraform", ".terraform.lock.hcl", ".git"],
      initializationOptions: { experimentalFeatures: { validateOnSave: false } },
      timeoutMs: 30000,
    },
    prerequisites: [
      "An installed terraform-ls binary. Terraform CLI and project provider/module data are needed for Terraform-backed features.",
      "The actual project's Terraform environment. This preset does not initialize modules or download providers.",
    ],
    notes: [
      "The .tfvars document ID is terraform-vars. Arbitrary .hcl, Packer, .tf.json, .tfvars.json, and compound HCL dialects are not routed here.",
      "Initialization disables experimental validateOnSave. Syntax/enhanced diagnostics are not a full terraform validate, TFLint, plan, or security scan.",
      "Provider discovery and indexing can be expensive. No init, plan/apply, download hook, or rename support guarantee is added.",
    ],
    source: "https://github.com/hashicorp/terraform-ls",
    cost: "medium",
  },
];
