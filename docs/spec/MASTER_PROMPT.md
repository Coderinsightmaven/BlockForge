MASTER DEVELOPMENT PROMPT: Build a Complete Minecraft Server Management Platform

1. Project Overview

You are the lead software architect, senior full-stack engineer, DevOps engineer, infrastructure engineer, UI/UX designer, security engineer, and testing lead responsible for building a production-ready Minecraft Server Management Platform.

Build a comprehensive platform that allows users to create, configure, deploy, monitor, manage, network, and maintain Minecraft servers through one modern web interface.

The platform should combine the capabilities of a professional game server control panel, infrastructure monitoring dashboard, server orchestration system, and Minecraft network management suite.

This must be a functional application, not a static dashboard, mockup, or prototype.

Every major interface must connect to real backend functionality. CPU utilization, memory consumption, storage, network throughput, player counts, server status, logs, and other metrics must come from actual infrastructure telemetry.

The platform must support managing an individual Minecraft server, multiple independent servers, and large interconnected Minecraft networks.

Primary objectives

1. Create Minecraft servers completely from scratch through a guided setup process.
2. Monitor CPU, RAM, storage, network traffic, disk I/O, and server-specific performance.
3. Create and manage interconnected Minecraft server networks using Velocity.
4. Configure Velocity forced hosts, virtual hosts, server routing, and player forwarding.
5. Manage Paper, Purpur, Fabric, Forge, NeoForge, Vanilla, and other supported server software.
6. Install, configure, update, and remove plugins and mods.
7. Manage player access, permissions, bans, whitelists, and server operations.
8. Create automated backups, restore servers, and migrate installations.
9. Manage server files, configurations, console access, and software updates.
10. Support multiple physical machines, virtual machines, and dedicated or cloud-hosted nodes.
11. Provide secure remote management through a lightweight node agent.
12. Make the platform modular, extensible, reliable, and suitable for production use.

The architecture must allow new Minecraft versions, server software, integrations, node types, and management capabilities to be added without rewriting the entire application.

---

2. Required Development Workflow

2.1 Begin by inspecting the environment

Before implementing anything:

- Inspect the existing repository, if one exists.
- Identify the current framework, language, package manager, deployment setup, and architecture.
- Read all applicable project instructions, including "AGENTS.md", "CLAUDE.md", "README.md", and relevant configuration files.
- Inspect existing code, tests, infrastructure, and dependencies.
- Determine whether this is a new project or an existing application.
- Preserve useful existing functionality unless a replacement is justified.
- Create a technical assessment and implementation plan.

Do not replace existing technology simply because another framework is fashionable.

For a new project, select an appropriate modern architecture based on performance, maintainability, security, developer experience, and operational simplicity.

2.2 Use an orchestrator and specialized sub-agents

Create an orchestrator responsible for breaking down the project into manageable tasks, assigning work, tracking dependencies, resolving conflicts, and validating integration.

Use specialized sub-agents where available:

- Architecture Agent: System design, technical decisions, module boundaries, and shared interfaces.
- Frontend Agent: Dashboard, navigation, forms, responsive layouts, charts, and user interactions.
- Backend Agent: APIs, business logic, persistence, authentication, and authorization.
- Infrastructure Agent: Node agents, server provisioning, containers, resource isolation, and deployment.
- Minecraft Agent: Server software, versions, plugins, mods, RCON, Velocity, forwarding, and network configuration.
- Monitoring Agent: Metrics collection, telemetry, historical storage, alerts, and diagnostics.
- Security Agent: Threat modeling, permission boundaries, secrets, remote access, and vulnerability prevention.
- Testing Agent: Unit, integration, end-to-end, security, performance, and infrastructure testing.
- Documentation Agent: Installation instructions, architecture documentation, operational runbooks, and user guides.

Agents must agree on API contracts, data models, event formats, and shared types before independently implementing dependent modules.

2.3 Mandatory cross-agent code review

Implement cross-agent review rules:

- If Claude writes code, have a different agent, such as Codex or Grok when available, review it.
- If Codex or Grok writes code, have Claude or another independent agent review it.
- If a second agent is unavailable, perform an explicit independent review pass.
- The reviewing agent must examine correctness, security, performance, maintainability, error handling, and test coverage.
- Address critical and high-severity findings before merging.
- Never accept a review merely because the code compiles.
- Do not let agents overwrite each other's work without coordinating shared files and interfaces.

Use feature branches or clearly separated work areas when supported.

2.4 Implementation discipline

- Work in small, testable phases.
- Implement real functionality instead of placeholder buttons.
- Run relevant tests, type checks, linters, and builds after meaningful changes.
- Verify integration between modules before proceeding.
- Keep a continuously updated task checklist.
- Document architectural decisions.
- Do not silently skip difficult requirements.
- If a requirement cannot be implemented, explain the limitation and provide an actionable alternative.
- Never claim that a feature works until it has been tested.

---

3. Recommended Technology Architecture

Choose a modern stack with clear separation between the management application and the machines running Minecraft.

Web application

Preferred options:

- TypeScript.
- React.
- Vite for a lightweight, efficient frontend build.
- Tailwind CSS.
- A consistent component library such as shadcn/ui.
- TanStack Query for server-state management.
- TanStack Router or an equivalent typed routing solution.
- A charting library suitable for high-frequency metrics.
- WebSockets or Server-Sent Events for real-time updates.

Use a monorepo such as Turborepo when it meaningfully improves shared package management, development workflows, and testing.

Backend services

Evaluate the following:

- Node.js with TypeScript and Fastify or NestJS for the management API.
- PostgreSQL for durable relational data.
- Redis for caching, transient state, distributed coordination, and queues when needed.
- A durable job queue for provisioning, backups, downloads, and long-running operations.
- An appropriate metrics backend, such as Prometheus, for time-series monitoring.
- OpenTelemetry for application tracing and diagnostics where appropriate.

Do not force every technology into the stack. Each dependency must have a clear purpose and acceptable operational cost.

Node agent

Build a lightweight agent that runs on every managed machine.

Evaluate Go as the preferred implementation language because it is suitable for long-running infrastructure services, resource monitoring, concurrent tasks, and deployment as a standalone binary.

The agent must communicate securely with the management control plane and perform explicitly authorized operations on its host.

Server runtime

Use isolated server instances, preferably with rootless containers such as Docker-compatible container runtimes or Podman where appropriate.

The platform must support both container-based deployments and a clearly defined path for managing supported existing installations where feasible.

Never assume that the web application itself should run inside every Minecraft server container.

Deployment targets

Support an initial deployment model consisting of:

- A control-plane host.
- One or more Minecraft nodes.
- Persistent application storage.
- A database.
- Optional metrics and caching services.
- Optional backup storage outside the primary node.

Document a single-host installation for small networks and a multi-node installation for larger deployments.

---

4. Main Application Layout

Build a professional, modern control panel with dark and light themes.

Use a consistent navigation system with the following sections.

Global navigation

1. Overview
2. Game Servers
3. Server Networks
4. Proxies
5. Nodes and Infrastructure
6. Monitoring
7. Players
8. Plugins and Mods
9. Files
10. Backups
11. Schedules and Tasks
12. Alerts
13. Users and Permissions
14. Audit Logs
15. Settings

Include global search, notifications, a node-health indicator, and a quick-action menu.

The interface must be responsive and usable on desktop, tablet, and mobile.

Prioritize desktop for intensive administration, but make emergency controls, server status, console access, and monitoring usable on mobile.

---

5. Infrastructure Overview Dashboard

Create a live overview of the entire Minecraft infrastructure.

Global metrics

Display:

- Total managed nodes.
- Online, offline, degraded, and unreachable nodes.
- Total Minecraft servers.
- Running, stopped, starting, stopping, and crashed servers.
- Total connected players.
- Total allocated memory.
- Actual memory consumption.
- Available memory across nodes.
- Total CPU capacity and current utilization.
- Aggregate storage capacity and usage.
- Network ingress and egress.
- Backup health.
- Pending updates.
- Active alerts.
- Recent crashes and deployment failures.

Clearly distinguish allocated resources from actual resource consumption.

For example, a server assigned 8 GB of memory must not automatically be represented as using 8 GB if it currently consumes 2.5 GB.

Visualizations

Implement real-time and historical charts for:

- CPU usage.
- RAM usage.
- Storage consumption.
- Network throughput.
- Disk read/write throughput.
- Disk I/O latency where supported.
- Active players.
- Server tick performance.
- Backup duration and success rate.
- Server restarts and crash frequency.

Provide configurable time ranges:

- Last 5 minutes.
- Last 15 minutes.
- Last hour.
- Last 6 hours.
- Last 24 hours.
- Last 7 days.
- Custom time range.

Use actual collected metrics, with clear timestamps, units, and handling of missing telemetry.

Do not generate fake metrics to make charts look populated.

---

6. Detailed Infrastructure Monitoring

Monitoring must operate at both the physical-node level and the individual Minecraft-server level.

6.1 CPU monitoring

Collect and display:

- Overall CPU utilization.
- Per-core utilization where supported.
- CPU model and architecture.
- Physical and logical core counts.
- Load averages.
- Per-node CPU consumption.
- Per-server CPU consumption.
- CPU time and throttling for containers where supported.
- Process-level CPU usage.
- CPU saturation and resource contention.
- Historical utilization.
- CPU spikes and sustained high usage.

Show the difference between host-wide utilization and the resources attributable to a particular server.

6.2 RAM monitoring

Collect:

- Total physical RAM.
- Used RAM.
- Available RAM.
- Cached and reclaimable memory where supported.
- Swap usage.
- Per-process resident memory.
- Per-container memory.
- Per-server Java heap usage.
- Java maximum heap allocation.
- Java garbage-collection activity where available.
- Out-of-memory events.
- Memory pressure and allocation failures.

For Java servers, distinguish JVM heap allocation, actual heap utilization, and total process memory. Do not treat these measurements as interchangeable.

Allow administrators to configure server memory limits and display warnings before a node becomes dangerously oversubscribed.

6.3 Storage monitoring

Display:

- Total disk capacity.
- Used and available disk space.
- Filesystem and mount-point information.
- Server directory sizes.
- World folder sizes.
- Plugin and mod folder sizes.
- Backup storage consumption.
- Log storage consumption.
- Container storage consumption.
- Disk read/write throughput.
- Disk utilization and I/O latency when available.
- Inode usage where relevant.

Identify the largest directories and files.

Provide per-server storage quotas where supported.

Prevent a single server from unexpectedly filling the entire host disk.

Allow administrators to configure retention policies for logs, temporary files, and backups.

6.4 Network monitoring

Collect:

- Host network throughput.
- Per-node ingress and egress.
- Per-server traffic where attribution is supported.
- Interface utilization.
- Packet errors and dropped packets where available.
- Connection counts.
- Connection failures.
- Latency to managed services where measured.
- Proxy-to-backend connectivity.
- Backend health checks.
- Public endpoint reachability.

Do not claim precise per-server bandwidth accounting when the underlying operating system or container configuration cannot provide it.

6.5 Process and operating-system health

Display:

- Operating-system version.
- Kernel version.
- Uptime.
- CPU architecture.
- Available disk mounts.
- Running Minecraft-related processes.
- Java version and executable.
- Container runtime health.
- Agent health and version.
- System service status.
- Recent operating-system and agent errors.

Provide safe diagnostics for disk pressure, memory pressure, failed health checks, and unexpectedly terminated processes.

---

7. Create a Minecraft Server From Scratch

Build a complete server creation wizard.

Step 1: Choose deployment target

Allow users to select:

- An existing managed node.
- An eligible node selected automatically.
- A newly registered node, once available.
- A server network to which the new server will belong.

Show node capacity and available resources before placement.

Reject placements that violate configured capacity limits unless an authorized administrator explicitly overrides the policy.

Step 2: Select server software

Support a modular server software catalog including:

- Vanilla.
- Paper.
- Purpur.
- Spigot, where compatible and appropriate.
- Fabric.
- Forge.
- NeoForge.
- Folia, with its specific compatibility requirements.
- Other compatible server distributions through extensible adapters.

Support proxy software separately, including Velocity.

For each distribution, show:

- Supported Minecraft versions.
- Available builds.
- Compatibility information.
- Required Java version.
- Release channel.
- Build provenance.
- Download source.
- Known restrictions.

Fetch release metadata from authoritative sources and verify downloaded artifacts when checksums or signatures are available.

Do not assume that every distribution supports every Minecraft version.

Step 3: Configure the server

Allow configuration of:

- Server name.
- Internal server identifier.
- Minecraft version.
- Software distribution and build.
- Node assignment.
- Deployment region or location label.
- CPU limits.
- Memory limits.
- Storage quotas.
- Server port.
- Optional query port.
- Optional RCON configuration.
- JVM startup parameters.
- Java runtime.
- Time zone for scheduled tasks.
- Startup behavior.
- Automatic restart policy.
- Backup policy.
- Environment variables approved by the platform.

Generate a secure, unique server directory and runtime configuration.

Step 4: Configure gameplay

Provide a graphical editor for supported settings, including:

- MOTD.
- Maximum players.
- Difficulty.
- Game mode.
- Online mode.
- Whitelist.
- Spawn protection.
- View distance.
- Simulation distance.
- PvP.
- Command blocks.
- Nether and End access.
- Hardcore mode.
- Resource pack settings.
- World generation settings.
- Other settings exposed by the selected distribution.

Validate settings against the chosen software version.

Display configuration descriptions and preserve unknown configuration values where possible.

Step 5: Configure worlds

Support:

- Creating a new world.
- Uploading a world.
- Importing a world archive.
- Replacing a world.
- Managing overworld, Nether, and End data.
- Configuring supported world seeds.
- Configuring world generation options.
- World backups.
- World size reporting.
- World export and download.

Require a safe shutdown or a documented consistency procedure before modifying active world data.

Step 6: Provision

The backend must:

1. Validate the request and the user's permissions.
2. Reserve the required resources.
3. Create an isolated server environment.
4. Download and verify the selected software.
5. Install the correct Java runtime if necessary.
6. Generate the configuration.
7. Create persistent directories.
8. Apply CPU, memory, storage, and network policies.
9. Configure ports and firewall rules.
10. Apply the selected access controls.
11. Initialize the world if required.
12. Start the server.
13. Monitor startup and inspect the logs.
14. Run a health check.
15. Register the server in the control panel.
16. Release temporary provisioning resources.
17. Report the result and any warnings.

Provisioning must be asynchronous, observable, retry-safe, and recoverable after failures.

Show a real-time progress interface with individual stages, logs, elapsed time, and actionable errors.

Do not report success until the server passes the defined readiness checks.

---

8. Server Management Interface

Each server must have a detailed management page.

Overview

Display:

- Server status.
- Player count.
- CPU consumption.
- Memory consumption.
- JVM heap metrics.
- Storage usage.
- Network throughput.
- Server software and version.
- Node assignment.
- Address and port.
- Uptime.
- Last restart.
- Last crash.
- Current tick performance when supported.
- Active alerts.

Controls

Provide:

- Start.
- Stop.
- Restart.
- Graceful shutdown.
- Force stop, with an appropriate warning.
- Reload where supported, with compatibility warnings.
- Update software.
- Create backup.
- Restore backup.
- Open console.
- Open file manager.
- Edit configuration.
- View logs.
- Manage players.
- Manage plugins or mods.
- Move to another eligible node.
- Delete server.

Require confirmation for destructive operations.

Stopping a server should send an appropriate graceful shutdown signal and allow world data to be saved before escalation.

Server lifecycle

Implement an explicit state machine:

- Provisioning.
- Starting.
- Running.
- Degraded.
- Stopping.
- Stopped.
- Crashed.
- Updating.
- Backing up.
- Restoring.
- Migrating.
- Unreachable.

Prevent conflicting operations and handle race conditions.

---

9. Live Console and Log Management

Create a real-time console experience.

Requirements:

- Stream console output to authorized users.
- Send commands to the server.
- Display timestamps.
- Support searching and filtering.
- Colorize Minecraft log levels where appropriate.
- Highlight warnings, errors, crashes, and player events.
- Download logs.
- Browse historical logs.
- Search across managed servers.
- Follow output in real time.
- Pause automatic scrolling.
- Copy selected output.
- Show connection status.
- Support reconnecting after network interruptions.

Provide server-specific command suggestions where possible.

Dangerous commands must not bypass normal authorization checks.

Do not expose unrestricted host shell access through the Minecraft console.

Treat log contents as untrusted data. Escape output and prevent log injection from breaking the management interface.

Support log rotation, size limits, and retention settings.

---

10. Complete Velocity Proxy Network Management

This is a core requirement, not an optional add-on.

Build a dedicated Server Networks section that lets users create and manage interconnected Minecraft server networks.

A network can contain:

- One or more Velocity proxies.
- Lobby servers.
- Survival servers.
- Creative servers.
- Minigame servers.
- Authentication or limbo servers.
- Event servers.
- Other supported backend types.

Allow multiple proxies and multiple backend servers to belong to a single logical network.

10.1 Network creation wizard

Allow administrators to:

1. Create a network.
2. Name the network and assign an identifier.
3. Choose its nodes and locations.
4. Create or assign a Velocity proxy.
5. Create backend servers.
6. Define internal backend addresses.
7. Configure ports and firewall rules.
8. Configure player forwarding.
9. Configure backend authentication requirements.
10. Set a default server.
11. Define server routing and forced hosts.
12. Validate connectivity.
13. Generate configuration.
14. Deploy or restart affected services.
15. Run a complete network health check.

Display the network topology visually.

Show each proxy, backend, node, port, and connection state.

10.2 Velocity proxy configuration

Provide a graphical editor for supported Velocity settings, including:

- Bind address.
- Player information forwarding mode.
- Forwarding secret.
- Online-mode behavior.
- Player-IP forwarding.
- Default backend servers.
- Fallback behavior.
- Connection timeouts.
- Compression settings.
- Query settings where applicable.
- Plugin configuration.
- Supported proxy-level options.

Generate valid configuration for the installed Velocity version.

Treat the proxy's configuration schema as version-specific.

Use secure random generation for forwarding secrets. Store secrets securely, restrict access, and never print them into ordinary logs.

10.3 Forced hosts

Implement a complete graphical forced-host management system.

Allow administrators to map hostnames to backend servers using Velocity's supported forced-host configuration.

Example conceptual configuration:

- "play.example.com" → "lobby"
- "survival.example.com" → "survival"
- "creative.example.com" → "creative"
- "events.example.com" → "events"

These are examples, not required real domains.

The interface must allow administrators to:

- Add a hostname.
- Remove a hostname.
- Edit a hostname.
- Select its target backend.
- Select or review fallback behavior.
- Validate the target.
- Detect duplicate or conflicting mappings.
- Display DNS and port requirements.
- Preview generated configuration.
- Apply configuration safely.
- Roll back a failed configuration change.

Use the forced-host syntax supported by the installed Velocity version. Preserve valid configuration formatting and unrelated settings.

Explain that forced-host routing depends on the hostname the player actually connects with. DNS, client connection address, proxy configuration, and backend availability must all be correct.

Do not imply that forced hosts automatically create DNS records or public network access.

10.4 Backend server registration

For each backend, store:

- Display name.
- Internal identifier.
- Backend address and port.
- Associated node.
- Minecraft version.
- Server software.
- Network membership.
- Intended role.
- Connection status.
- Health-check status.
- Routing priority.
- Operational status.

Prefer private networking or an internal container network for proxy-to-backend communication.

Where possible, bind backend services to private interfaces and firewall off direct public access.

10.5 Modern forwarding and authentication security

Use a secure, compatible Velocity player-forwarding mode.

For modern forwarding:

- Configure the proxy and backend consistently.
- Generate a strong forwarding secret.
- Configure the backend to require and validate the appropriate forwarding information.
- Ensure backend servers cannot be impersonated or accessed through an insecure direct route.
- Restrict backend ports to trusted proxy sources or private networks.
- Prevent clients from bypassing the proxy.
- Validate online-mode and identity-handling settings against the selected topology.
- Warn about unsafe forwarding combinations.

Never expose forwarding secrets in frontend responses, logs, error messages, or ordinary audit events.

Do not treat a forwarding secret alone as a substitute for network isolation and correct backend configuration.

10.6 Network operations

Support:

- Starting and stopping individual proxies.
- Restarting an entire network in a controlled sequence.
- Graceful maintenance mode.
- Setting a default lobby.
- Registering new backends.
- Removing backends.
- Draining players where supported.
- Checking proxy-to-backend connectivity.
- Viewing cross-server player counts.
- Identifying unreachable servers.
- Updating proxies and backends.
- Coordinated backups.
- Network-wide configuration validation.
- Configuration change history and rollback.

A network-wide action must show which servers will be affected before execution.

Never restart every server simultaneously by default when doing so would unnecessarily disconnect the entire network.

---

11. Network Topology and Visual Editor

Create a visual network designer.

Use a node-and-connection diagram that represents:

- Velocity proxies.
- Backend Minecraft servers.
- Physical or virtual nodes.
- Network boundaries.
- Public endpoints.
- Internal connections.
- Routing relationships.
- Forced-host mappings.

Administrators must be able to create a network visually and configure each component through an inspector panel.

The editor should support:

- Adding components.
- Connecting supported components.
- Editing server properties.
- Detecting invalid connections.
- Detecting duplicate ports.
- Showing health status.
- Saving drafts.
- Previewing deployment changes.
- Applying changes.
- Reviewing diffs.
- Rolling back failed changes.

The visual editor must manipulate real persisted configuration and validated deployment plans. It must not be a decorative diagram disconnected from the backend.

---

12. Plugin and Mod Management

Create a centralized plugin and mod management interface.

Features

- Browse supported sources.
- Search by name.
- View descriptions and release metadata.
- Filter by Minecraft version.
- Filter by server software.
- Check compatibility where reliable data exists.
- Install plugins or mods.
- Upload local JAR files.
- Update installed plugins or mods.
- Remove plugins or mods.
- Enable or disable components where supported.
- Browse plugin configuration files.
- Inspect dependency requirements.
- View installation history.
- Roll back to a previously installed version where possible.

Support appropriate integrations with legitimate distribution sources, such as Modrinth, and other sources through configurable adapters.

For every installation, validate the source and artifact metadata. Verify signatures or checksums when available.

Warn about compatibility issues and potentially unsafe third-party files.

Never silently execute arbitrary uploaded code during the management process. Minecraft plugins and mods inherently execute code inside the server process, so make this risk clear to administrators.

Provide a configurable policy for allowed sources and uploaded artifacts.

---

13. Java and Runtime Management

Build a Java runtime management module.

Features:

- Detect installed Java runtimes.
- Display runtime versions.
- Show Java vendor and architecture.
- Map compatible Java versions to supported Minecraft releases.
- Install supported runtimes.
- Select a runtime per server.
- Configure JVM arguments.
- Display startup failures caused by runtime incompatibility.
- Track runtime security updates.
- Apply runtime updates safely.

Use authoritative compatibility metadata where possible.

Provide conservative JVM defaults and allow expert configuration.

Do not blindly apply universal JVM flag recommendations to every server distribution.

Support diagnostic information for garbage collection, heap exhaustion, and JVM crashes.

---

14. File Manager

Implement a secure file manager for each server.

Required capabilities:

- Browse directories.
- Upload files.
- Download files.
- Create folders.
- Rename files.
- Delete files.
- Edit text configuration files.
- Search filenames.
- Display file sizes and modification times.
- View file permissions where appropriate.
- Manage world files.
- Inspect logs.
- Extract supported archives safely.
- Upload configuration templates.

The file manager must be restricted to the server's authorized data directory and explicitly approved locations.

Prevent path traversal, symbolic-link escapes, archive extraction attacks, and unauthorized access to host files.

Large uploads and downloads must be streamed rather than unnecessarily buffered in application memory.

Require additional confirmation before deleting worlds, server configurations, or important data.

Do not expose the host filesystem as an unrestricted web-accessible file browser.

---

15. Player and Access Management

Build a player management section with:

- Online player lists.
- Username and UUID information where available.
- Join and leave events.
- Whitelist management.
- Ban and unban controls.
- Kick controls.
- Operator management.
- Player lookup.
- Server-specific player history.
- Network-wide player history where available.
- Permission management integrations.
- Player counts over time.
- Search and filtering.

Support common permission plugins through adapters where feasible.

Do not assume Minecraft's built-in operator list is a complete permissions system.

Protect sensitive player information and restrict administrative actions by role.

Avoid collecting unnecessary player data.

---

16. Backups and Disaster Recovery

Create a robust backup and restoration system.

Backup capabilities

- Manual backups.
- Scheduled backups.
- Per-server backup policies.
- Network-wide coordinated backups.
- World-only backups.
- Full server backups.
- Configuration-only backups.
- Plugin and mod backups.
- Optional off-node backup destinations.
- Compression.
- Incremental backups where appropriate.
- Retention policies.
- Backup verification.
- Restore previews.
- Backup size and duration metrics.

Support local storage and configurable remote object storage, including S3-compatible services.

Backup consistency

For Minecraft world backups, use a consistency strategy appropriate to the server and storage architecture.

Where necessary, gracefully stop the server, save the world, or use a supported snapshot mechanism.

Do not assume copying files from a live server always produces a consistent backup.

Restore capabilities

Allow administrators to:

1. Select a backup.
2. Inspect its contents and metadata.
3. Verify integrity.
4. Choose the restoration target.
5. Review the files that will be replaced.
6. Confirm the operation.
7. Restore safely.
8. Validate server startup.
9. Roll back the restoration if a recovery point exists.

Maintain a history of backup and restore operations.

Document realistic recovery-time and recovery-point expectations rather than promising unsupported guarantees.

---

17. Scheduling and Automation

Build a scheduling engine for recurring and one-time administrative tasks.

Support:

- Scheduled restarts.
- Scheduled backups.
- Plugin updates.
- Server software updates.
- World maintenance.
- Log cleanup.
- Backup retention cleanup.
- Health checks.
- Player notifications.
- Network maintenance windows.
- Custom administrator-defined tasks.

Include:

- Time zone selection.
- Cron expressions where appropriate.
- Human-readable schedules.
- Execution history.
- Retry policies.
- Failure notifications.
- Cancellation.
- Concurrency limits.
- Maintenance windows.
- Dependency handling.

Avoid automatic updates that could unexpectedly break a production network.

Provide staged rollout policies and require approval for potentially disruptive operations.

---

18. Alerting and Notifications

Implement configurable alerts for:

- CPU usage above a threshold.
- Memory pressure.
- Java heap exhaustion.
- Low disk space.
- High disk I/O latency.
- Excessive network errors.
- Server crashes.
- Repeated restarts.
- Player connectivity problems.
- Backend servers becoming unreachable.
- Velocity proxy failures.
- Failed backups.
- Backup storage nearing capacity.
- Expired or invalid certificates where applicable.
- Outdated or unhealthy node agents.
- Failed software updates.
- Unexpected server configuration changes.

Support configurable thresholds, durations, severity levels, and notification suppression.

Add notification adapters for email, Discord webhooks, and other providers through a common interface.

Provide alert acknowledgment, resolution tracking, and incident history.

Prevent alert storms through deduplication, grouping, and cooldown periods.

---

19. Node Management and Agent Architecture

Build a secure node registration and lifecycle management system.

Each node should report:

- Hardware information.
- Operating-system information.
- CPU and memory metrics.
- Storage capacity and usage.
- Network interfaces.
- Container runtime health.
- Running managed workloads.
- Agent version.
- Last successful heartbeat.
- Available capacity.

Agent capabilities

The agent should support authorized operations for:

- Creating server environments.
- Starting and stopping workloads.
- Collecting telemetry.
- Streaming logs.
- Managing server files within approved directories.
- Executing lifecycle jobs.
- Managing backups.
- Reporting health.
- Updating itself through a controlled mechanism.

Secure registration

Use a secure registration process with expiring enrollment credentials or administrator-approved enrollment.

After enrollment:

- Authenticate each node.
- Use encrypted transport.
- Rotate credentials when appropriate.
- Support node revocation.
- Reject unauthorized control-plane commands.
- Apply replay protection where applicable.
- Maintain an auditable command history.

Avoid permanent shared secrets embedded in source code.

Node operations

Provide:

- Register node.
- Validate connectivity.
- Rename node.
- Assign tags.
- Assign location.
- Configure resource limits.
- Drain node.
- Schedule maintenance.
- Upgrade agent.
- Disable scheduling.
- Remove node.
- Migrate workloads.

Node removal must require explicit handling of running workloads and persistent data.

---

20. Security Architecture

Treat security as a foundational requirement.

Authentication

Implement secure authentication using an appropriate identity provider or a carefully implemented local authentication system.

If using Auth0 or another identity provider, ensure that the backend validates access tokens and does not trust frontend authentication state alone.

Support secure session management, logout, account recovery, and multi-factor authentication where available.

Role-based access control

Provide configurable roles, including:

- Owner.
- Administrator.
- Infrastructure Administrator.
- Network Administrator.
- Server Administrator.
- Moderator.
- Read-only Observer.

Permissions should be granular and scoped to:

- Entire installation.
- Specific nodes.
- Specific networks.
- Individual servers.
- Player-management actions.
- Configuration changes.
- File access.
- Backups.
- Secrets.

Additional requirements

- Encrypt communication in transit.
- Store sensitive secrets using appropriate encryption and access controls.
- Prevent cross-site scripting, CSRF, SQL injection, command injection, and path traversal.
- Validate all API inputs.
- Apply rate limits.
- Use secure cookies and browser security headers where appropriate.
- Maintain immutable or tamper-evident audit records where feasible.
- Log administrative actions without leaking credentials.
- Use least-privilege operating-system accounts.
- Isolate workloads.
- Restrict dangerous host operations.
- Prevent unauthorized access to other tenants' data.
- Protect against server-side request forgery when fetching external resources.
- Verify software downloads and handle untrusted archives safely.

Never execute arbitrary shell commands directly from user-provided input.

Use predefined, validated operations with tightly scoped arguments.

Never expose container-runtime control, unrestricted root access, database credentials, forwarding secrets, or node enrollment tokens to ordinary users.

---

21. Multi-Node Scheduling and Resource Placement

Build a scheduling service that chooses appropriate nodes for new servers.

Consider:

- CPU capacity.
- Memory capacity.
- Available storage.
- Network location.
- Current utilization.
- Server compatibility.
- Configured quotas.
- Node health.
- Maintenance status.
- User placement preferences.
- Affinity and anti-affinity rules.

Allow administrators to define:

- Preferred nodes.
- Dedicated nodes for specific networks.
- Separation rules for critical workloads.
- Resource reservations.
- Maximum utilization thresholds.
- Placement constraints.

Distinguish hard limits from scheduling recommendations.

Do not promise that a server can be migrated live between nodes. Minecraft server migration may require stopping the workload, transferring data, updating routing, and validating startup.

Implement safe offline migration first, with optional advanced migration strategies later.

---

22. Configuration Management and Change History

Create a centralized configuration-management system.

Support:

- Versioned server configuration.
- Versioned Velocity configuration.
- Configuration templates.
- Reusable server profiles.
- Network templates.
- Environment-specific settings.
- Configuration diffs.
- Validation before deployment.
- Change approval where required.
- Rollback.
- Audit history.

When generating configurations, preserve unrelated user-defined settings.

Avoid overwriting entire files when a safe, targeted update is possible.

Use atomic file replacement where appropriate.

If a configuration change causes a health check to fail, offer a controlled rollback to the last known good version.

---

23. API and Event Architecture

Create a documented API for the web frontend, node agents, and future integrations.

Provide:

- Versioned REST APIs.
- WebSocket or SSE channels for real-time updates.
- Authentication and authorization middleware.
- Pagination.
- Filtering and sorting.
- Input validation.
- Consistent error formats.
- Request identifiers.
- Rate limiting.
- API documentation.
- Integration tests.

Define typed contracts for:

- Servers.
- Nodes.
- Networks.
- Proxies.
- Backups.
- Alerts.
- Players.
- Jobs.
- Metrics.
- Audit events.

Use a job/event architecture for long-running operations.

Examples include:

- "server.provision.requested"
- "server.provision.completed"
- "server.state.changed"
- "server.crashed"
- "node.heartbeat.received"
- "network.configuration.validated"
- "network.configuration.applied"
- "backup.completed"
- "backup.failed"
- "migration.completed"

Define delivery guarantees, retry behavior, idempotency, and failure handling.

Do not rely on transient WebSocket messages as the only record of important operations.

---

24. Database and Data Model

Design a normalized, migration-managed relational schema.

Include appropriate entities for:

- Users.
- Roles.
- Permissions.
- Nodes.
- Node credentials.
- Server instances.
- Server deployments.
- Server software versions.
- Networks.
- Proxies.
- Backend registrations.
- Forced-host mappings.
- Network configuration revisions.
- Server configuration revisions.
- Plugins.
- Mods.
- Worlds.
- Backups.
- Backup policies.
- Scheduled jobs.
- Job executions.
- Alerts.
- Notifications.
- Audit events.
- Resource reservations.
- API tokens.
- Maintenance windows.

Define explicit relationships, uniqueness constraints, indexes, retention policies, and deletion behavior.

Store high-volume time-series metrics in a suitable monitoring system rather than allowing the primary application database to grow uncontrollably.

Use durable migrations and documented backup procedures for application data.

---

25. Performance and Reliability

The platform must remain usable when managing many servers and nodes.

Requirements:

- Avoid polling every server excessively.
- Use efficient telemetry collection intervals.
- Support batching and aggregation.
- Use pagination for large datasets.
- Avoid unnecessary frontend rerenders.
- Virtualize large log and file listings where appropriate.
- Stream large files.
- Bound queue concurrency.
- Apply backpressure.
- Implement retry policies with exponential backoff where appropriate.
- Handle intermittent node connectivity.
- Recover pending jobs after process restarts.
- Detect duplicate job execution.
- Make provisioning and backup operations idempotent.
- Maintain health endpoints.
- Support graceful shutdown.
- Monitor the management platform itself.

Establish measurable performance targets and test against a representative multi-node workload.

---

26. User Experience Requirements

The design should feel like a polished professional infrastructure product.

Use:

- Clear visual hierarchy.
- Consistent spacing.
- Accessible color contrast.
- Responsive layouts.
- Meaningful status indicators.
- Useful empty states.
- Skeleton loading states.
- Clear error messages.
- Contextual help.
- Confirmation dialogs for destructive actions.
- Searchable tables.
- Keyboard navigation.
- Tooltips for technical metrics.
- Reusable charts and status components.

Provide both simple and advanced views where appropriate.

For example, a beginner should be able to create a Paper server without understanding JVM flags, while an advanced administrator should be able to configure Java arguments and inspect detailed runtime metrics.

Avoid unnecessary visual clutter, oversized cards, and animations that interfere with monitoring.

---

27. Testing Strategy

Build an automated test suite throughout development.

Unit tests

Test:

- Configuration validation.
- Permission enforcement.
- Resource calculations.
- Scheduling decisions.
- Forced-host validation.
- Server lifecycle transitions.
- Backup retention.
- Retry behavior.
- Secret handling.
- Configuration generation.

Integration tests

Test:

- API and database interactions.
- Node enrollment.
- Agent authentication.
- Provisioning workflows.
- Server start and stop operations.
- Metrics collection.
- Log streaming.
- Backup creation and restoration.
- Velocity configuration deployment.
- Backend connectivity.
- Forced-host routing configuration.
- Permission boundaries.

End-to-end tests

Verify that a user can:

1. Sign in.
2. Register a node.
3. Create a Minecraft server.
4. Start it.
5. View real resource metrics.
6. Open the console.
7. Modify a configuration.
8. Install a plugin.
9. Create a backup.
10. Restore the backup.
11. Create a Velocity proxy.
12. Register multiple backends.
13. Configure forced hosts.
14. Validate the network.
15. Connect through the configured proxy in an appropriate test environment.
16. Trigger and resolve an alert.
17. Review the audit history.

Security tests

Include:

- Unauthorized API access.
- Cross-server privilege escalation.
- Path traversal.
- Malicious archive extraction.
- Command injection.
- Secret leakage.
- Forged node commands.
- Replay attacks.
- Resource exhaustion.
- Insecure backend exposure.
- Invalid forwarding configurations.
- Authentication and authorization failures.

Performance tests

Measure:

- API latency.
- Dashboard load time.
- Telemetry ingestion rate.
- WebSocket fan-out.
- Log streaming under load.
- Job queue throughput.
- Large file transfer behavior.
- Database performance.
- Resource consumption of the control plane and agents.

---

28. Implementation Phases

Implement the project in explicit phases. Maintain a detailed checklist and do not skip phases silently.

Phase 0 — Repository Assessment and Architecture

- Inspect the repository.
- Choose the architecture.
- Define module boundaries.
- Establish shared types.
- Document security assumptions.
- Design the database.
- Define the agent protocol.
- Create the implementation plan.
- Establish testing and code-review requirements.

Deliverable: Architecture documents, repository assessment, and an actionable development roadmap.

Phase 1 — Project Foundation

- Configure the monorepo if appropriate.
- Establish the frontend and backend.
- Set up authentication.
- Configure database migrations.
- Build shared UI components.
- Add API contracts.
- Add structured logging.
- Configure tests, linting, and CI.
- Establish local development instructions.

Deliverable: A functioning application foundation.

Phase 2 — Node Agent and Infrastructure Monitoring

- Build the node agent.
- Implement secure enrollment.
- Implement heartbeats.
- Collect CPU, memory, storage, and network metrics.
- Implement historical monitoring.
- Build node health pages.
- Implement alerts.
- Add agent recovery and connectivity handling.

Deliverable: Real infrastructure monitoring across multiple nodes.

Phase 3 — Server Provisioning

- Build the server creation wizard.
- Implement software adapters.
- Implement resource placement.
- Provision isolated workloads.
- Configure Java.
- Implement lifecycle management.
- Stream logs.
- Build server management pages.
- Implement server configuration editing.

Deliverable: Users can create and operate actual Minecraft servers.

Phase 4 — Advanced Server Management

- Implement file management.
- Add worlds and world management.
- Add plugin and mod management.
- Add player management.
- Add schedules.
- Add server templates.
- Add updates and rollback support.

Deliverable: Comprehensive single-server administration.

Phase 5 — Velocity and Network Management

- Implement network creation.
- Provision Velocity proxies.
- Register multiple backend servers.
- Generate secure forwarding configuration.
- Implement forced-host management.
- Implement network topology visualization.
- Add connectivity checks.
- Add coordinated network operations.
- Test routing in an actual Minecraft test environment.

Deliverable: Functional interconnected Minecraft networks with configurable forced hosts.

Phase 6 — Backups and Disaster Recovery

- Implement backup jobs.
- Add retention policies.
- Add remote storage.
- Add verification.
- Add restoration workflows.
- Add disaster-recovery documentation.
- Test failure recovery.

Deliverable: Reliable, verified backups and restoration.

Phase 7 — Advanced Infrastructure Operations

- Implement advanced scheduling.
- Add resource reservations.
- Add node maintenance.
- Add offline server migration.
- Add staged updates.
- Add advanced alerts.
- Add configuration history.
- Add operational reporting.

Deliverable: Production-oriented multi-node management.

Phase 8 — Security Hardening

- Perform threat modeling.
- Review authorization boundaries.
- Audit node-agent operations.
- Review secret storage.
- Run security tests.
- Review dependency vulnerabilities.
- Validate network isolation.
- Test disaster-recovery procedures.
- Fix critical and high-severity findings.

Deliverable: Security review and remediation report.

Phase 9 — Performance and Production Readiness

- Run representative load tests.
- Optimize bottlenecks.
- Validate long-running agent stability.
- Test control-plane restarts.
- Test node disconnections.
- Validate recovery from interrupted jobs.
- Finalize deployment automation.
- Finalize monitoring and alerting.
- Document upgrades and rollback.

Deliverable: Release candidate with documented limitations and verified functionality.

Phase 10 — Final Acceptance

Verify all core user workflows against the requirements in this prompt.

Produce:

- A completed feature checklist.
- Automated test results.
- Security review findings.
- Performance test results.
- Installation instructions.
- Production deployment guide.
- Backup and recovery guide.
- Troubleshooting documentation.
- Known limitations.
- A list of incomplete requirements, if any.

Do not label the application production-ready if critical functionality remains unimplemented or untested.

---

29. Repository Structure

Use a modular repository structure similar to the following, adapting it to the selected stack.

- "apps/"
  - "web/" — Main management dashboard.
  - "api/" — Management API.
  - "worker/" — Background job processing.
  - "docs/" — Documentation site, if warranted.
- "packages/"
  - "ui/" — Shared UI components.
  - "types/" — Shared domain types.
  - "api-client/" — Typed API client.
  - "validation/" — Shared schemas.
  - "config/" — Shared configuration.
  - "minecraft/" — Minecraft software and configuration adapters.
  - "velocity/" — Velocity configuration and network logic.
  - "monitoring/" — Metrics abstractions.
  - "jobs/" — Job definitions and contracts.
  - "security/" — Shared security utilities.
- "services/"
  - "node-agent/" — Host-level infrastructure agent.
  - "metrics/" — Optional monitoring integration.
- "infra/"
  - "containers/"
  - "deployment/"
  - "database/"
  - "monitoring/"
- "tests/"
  - "unit/"
  - "integration/"
  - "e2e/"
  - "security/"
- "docs/"
  - "architecture/"
  - "operations/"
  - "security/"
  - "development/"

The node agent may live in a separate language-specific workspace if that provides a cleaner build and release process.

Do not create empty modules simply to match the proposed structure. Each package must have a clear responsibility.

---

30. Definition of Done

A feature is complete only when:

- Its intended behavior is implemented.
- Its API and data contracts are documented.
- Authentication and authorization are enforced.
- Errors are handled safely.
- Relevant tests pass.
- The UI reflects real backend state.
- Loading, failure, and empty states are implemented.
- Logs and audit records are appropriate.
- The feature integrates with existing modules.
- Relevant documentation is updated.
- An independent review has been completed.

A server is not considered provisioned simply because a database record exists.

A network is not considered functional simply because its topology diagram looks correct.

A monitoring feature is not considered functional if it displays simulated metrics.

A backup feature is not considered functional until restoration has been tested.

A forced-host feature is not considered functional until the generated configuration is validated and routing has been tested in a suitable environment.

---

31. Final Instructions to the Development Agent

Begin with Phase 0.

Inspect the environment before making changes. Determine the existing architecture and the most appropriate implementation strategy.

Create a persistent project checklist and track every requirement from this prompt.

Delegate independent tasks to specialized agents, coordinate shared interfaces, and require cross-agent code review.

Implement the platform incrementally, prioritizing secure infrastructure monitoring and real Minecraft server provisioning before advanced features.

Treat Velocity proxy management, multi-server networking, and forced-host configuration as mandatory core capabilities.

Build a usable, integrated product rather than a collection of disconnected screens.

Do not stop after creating the dashboard, database schema, architecture plan, or initial server wizard. Continue through implementation, testing, integration, and documentation.

If context limits or execution time interrupt development, save the current state, record completed work, document blockers, and identify the exact next task. Resume from the existing checklist instead of restarting or claiming completion.

At every stage, report:

1. What was implemented.
2. Which files and modules changed.
3. Which tests were executed and their results.
4. Which security or architectural decisions were made.
5. What remains incomplete.
6. What the next implementation task is.

The end goal is a secure, modern, fully functional Minecraft infrastructure management platform that can create servers from scratch, monitor the underlying hardware in real time, and operate interconnected Minecraft networks through Velocity and forced-host routing from one centralized control panel.