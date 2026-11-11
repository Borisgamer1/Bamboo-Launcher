use bamboo_launcher::auth::MicrosoftAuth;
use bamboo_launcher::config::{self, LauncherSettings};
use bamboo_launcher::download::Downloader;
use bamboo_launcher::install::{
    InstallEvent, InstallOptions, InstallReport, InstallStep, Installer, RepairReport,
};
use bamboo_launcher::instances::InstanceManager;
use bamboo_launcher::java::{self, JavaRuntime};
use bamboo_launcher::launcher::{self, Account, LaunchOptions, LaunchPlan};
use bamboo_launcher::loader::{LoaderInstall, LoaderInstaller, LoaderUpdate};
use bamboo_launcher::modpack::ModpackImporter;
use bamboo_launcher::mods::{
    self, install_plan, plan_install, AnyProvider, Loader, ModLedger, ModProvider, ModSource,
    ModTarget, ResolveOptions, SearchQuery,
};
use bamboo_launcher::token_store::{self, KeyringStore, SessionManager};
use bamboo_launcher::version;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let settings = LauncherSettings::load(&config::default_settings_path())?;
    let game_root = settings.game_root.clone();

    match args.first().map(String::as_str).unwrap_or("help") {
        "java" => {
            list_java().await;
            Ok(())
        }
        "versions" => {
            list_versions(&game_root);
            Ok(())
        }
        "instances" => {
            if args.get(1).map(String::as_str) == Some("create") {
                create_instance(&game_root, &settings, &args).await;
            } else {
                list_instances(&game_root);
            }
            Ok(())
        }
        "loader" => {
            match args.get(1).map(String::as_str) {
                Some("install") => install_loader_command(&game_root, &settings, &args).await,
                Some("update") => update_loader_command(&game_root, &settings, &args).await,
                _ => println!(
                    "Nutzung:\n  bamboo-launcher loader install <minecraft-version> [--loader fabric|forge|neoforge|quilt] [--loader-version <v>]\n  bamboo-launcher loader update [<minecraft-version>] [--loader fabric|forge|neoforge|quilt] [--dry-run]"
                ),
            }
            Ok(())
        }
        "mods" => mods_command(&game_root, &settings, &args).await,
        "modpacks" => {
            if args.get(1).map(String::as_str) == Some("import") {
                import_modpack_command(&game_root, &settings, &args).await;
            } else {
                println!(
                    "Nutzung: bamboo-launcher modpacks import <datei.mrpack> [--name <instanz>]"
                );
            }
            Ok(())
        }
        "login" => {
            println!("[launcher] Öffne den Browser für die Microsoft-Anmeldung ...");
            match MicrosoftAuth::new().login().await {
                Ok(outcome) => {
                    println!(
                        "[launcher] Angemeldet als {} ({})",
                        outcome.minecraft.profile.name, outcome.minecraft.profile.id
                    );
                    match session_manager().save(&outcome) {
                        Ok(_) => println!(
                            "[launcher] Sitzung im Anmeldedaten-Speicher gespeichert – der nächste Start meldet automatisch an."
                        ),
                        Err(error) => println!(
                            "[launcher] Angemeldet, aber das Speichern der Sitzung schlug fehl: {error}"
                        ),
                    }
                }
                Err(error) => println!("[launcher] Anmeldung fehlgeschlagen: {error}"),
            }
            Ok(())
        }
        "logout" => {
            match session_manager().clear() {
                Ok(()) => println!("[launcher] Sitzung aus dem Credential Store entfernt."),
                Err(error) => println!("[launcher] Sitzung konnte nicht entfernt werden: {error}"),
            }
            Ok(())
        }
        "session" => {
            show_session();
            Ok(())
        }
        "install" => {
            let version_id = args.get(1).ok_or_else(|| {
                anyhow::anyhow!(
                    "Nutzung: bamboo-launcher install <version> [--no-assets] [--no-java] [--refresh-manifest]"
                )
            })?;
            let options = InstallOptions {
                assets: !has_flag(&args, "--no-assets"),
                java: !has_flag(&args, "--no-java"),
                refresh_manifest: has_flag(&args, "--refresh-manifest"),
            };
            let installer = Installer::new(config::default_cache_dir());
            println!(
                "[install] Installiere {} nach {} ...",
                version_id,
                settings.game_root.display()
            );
            let report = installer
                .install_version(
                    &settings.game_root,
                    version_id,
                    &options,
                    progress_printer(),
                )
                .await?;
            print_install_report(&report);
            Ok(())
        }
        "repair" => {
            let version_id = args
                .get(1)
                .ok_or_else(|| anyhow::anyhow!("Nutzung: bamboo-launcher repair <version>"))?;
            let installer = Installer::new(config::default_cache_dir())
                .with_java_path(settings.java_path.clone());
            println!(
                "[repair] Prüfe {} in {} ...",
                version_id,
                settings.game_root.display()
            );
            let report = installer
                .repair_version(&settings.game_root, version_id, progress_printer())
                .await?;
            print_repair_report(&report);
            Ok(())
        }
        "plan" => {
            let version_id = args.get(1).ok_or_else(|| {
                anyhow::anyhow!(
                    "Nutzung: bamboo-launcher plan <version> [--instance NAME] [--user NAME]"
                )
            })?;
            let prepared = prepare(&args, &settings, version_id, false).await?;
            print_plan(&prepared);
            Ok(())
        }
        "launch" => {
            let version_id = args.get(1).ok_or_else(|| {
                anyhow::anyhow!(
                    "Nutzung: bamboo-launcher launch <version> [--instance NAME] [--user NAME]"
                )
            })?;
            let instance = flag_value(&args, "--instance");
            let version_id = offer_loader_update(&settings, version_id, instance.as_deref()).await;
            let prepared = prepare(&args, &settings, &version_id, true).await?;
            let mut process = launcher::spawn_game(&prepared.plan, prepared.log_path).await?;
            if let Some(pid) = process.pid() {
                println!("[launcher] Minecraft gestartet (PID {pid})");
            }
            let status = process
                .pump_until_exit(|event| match event {
                    launcher::LaunchEvent::Line { text, .. } => println!("{text}"),
                    launcher::LaunchEvent::Ready => println!("[launcher] Spiel bereit"),
                    launcher::LaunchEvent::CrashReport(path) => {
                        println!("[launcher] Crash-Report: {}", path.display())
                    }
                })
                .await?;
            println!("[launcher] Prozess beendet: {status}");
            Ok(())
        }
        _ => {
            print_help();
            Ok(())
        }
    }
}

struct Prepared {
    plan: LaunchPlan,
    java: JavaRuntime,
    log_path: Option<PathBuf>,
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|argument| argument == flag)
}

async fn prepare(
    args: &[String],
    settings: &LauncherSettings,
    version_id: &str,
    require_java: bool,
) -> anyhow::Result<Prepared> {
    let game_root = &settings.game_root;
    let instance = flag_value(args, "--instance");
    let account = match flag_value(args, "--user") {
        Some(name) => Account::offline(name),
        None => resume_session()
            .await
            .unwrap_or_else(|| Account::offline(OFFLINE_USER)),
    };

    let resolved = version::resolve_version(game_root, version_id)?;
    if require_java && !resolved.client_jar.is_file() {
        anyhow::bail!(
            "Version '{}' ist noch nicht installiert ({} fehlt). Führe zuerst `bamboo-launcher install {}` aus.",
            version_id,
            resolved.client_jar.display(),
            version_id
        );
    }
    let runtime = match java::find_java_in(
        game_root,
        settings.java_path.as_deref(),
        resolved.java_major,
    )
    .await
    {
        Ok(runtime) => runtime,
        Err(error) if !require_java => {
            eprintln!("[launcher] Warnung: {error} – Plan wird mit Platzhalterpfad gebaut.");
            JavaRuntime {
                path: PathBuf::from("java"),
                major: resolved.java_major,
                version: "unbekannt".to_string(),
                vendor: None,
                arch: std::env::consts::ARCH.to_string(),
            }
        }
        Err(error) => return Err(error.into()),
    };

    let (working_dir, log_path) = match &instance {
        Some(name) => {
            let manager = InstanceManager::new(game_root.join("instances"));
            let instance = manager.load(name)?;
            let log_path = instance.dir.join("logs").join("latest.log");
            (instance.dir, Some(log_path))
        }
        None => (game_root.clone(), None),
    };

    let server = flag_value(args, "--server").map(|value| {
        let (host, port) = value.rsplit_once(':').unwrap_or((value.as_str(), "25565"));
        (host.to_string(), port.parse::<u16>().unwrap_or(25565))
    });

    let options = LaunchOptions {
        account,
        memory: settings.memory,
        java: runtime.clone(),
        extra_jvm_args: settings.extra_jvm_args.clone(),
        extra_game_args: settings.extra_game_args.clone(),
        resolution: settings.resolution,
        demo: settings.demo_mode || has_flag(args, "--demo"),
        server,
        quick_play_world: flag_value(args, "--world"),
    };

    let plan = launcher::build_launch_plan(game_root, version_id, &working_dir, &options)?;
    Ok(Prepared {
        plan,
        java: runtime,
        log_path,
    })
}

const OFFLINE_USER: &str = "Player";

fn session_manager() -> SessionManager<KeyringStore> {
    SessionManager::new(KeyringStore::new())
}

/// Lädt die gespeicherte Sitzung beim Start und erneuert sie bei Bedarf – ohne Browser.
async fn resume_session() -> Option<Account> {
    match session_manager().restore(&MicrosoftAuth::new()).await {
        Ok(Some(session)) => {
            eprintln!(
                "[launcher] Sitzung geladen: {} ({})",
                session.username, session.uuid
            );
            Some(session.account())
        }
        Ok(None) => None,
        Err(error) => {
            eprintln!("[launcher] Sitzung nicht nutzbar ({error}) – starte als Offline-Profil.");
            None
        }
    }
}

fn show_session() {
    match session_manager().load() {
        Ok(Some(session)) => {
            let now = token_store::now_ms();
            println!("Konto:      {} ({})", session.username, session.uuid);
            println!(
                "Minecraft:  {}",
                token_store::describe_expiry(session.minecraft_expires_at, now)
            );
            println!(
                "Microsoft:  {}",
                token_store::describe_expiry(session.microsoft_expires_at, now)
            );
            if !session.tokens_valid(now) {
                println!(
                    "[launcher] Der Minecraft-Token wird beim nächsten Start automatisch erneuert."
                );
            }
        }
        Ok(None) => println!("Keine gespeicherte Sitzung. Mit `bamboo-launcher login` anmelden."),
        Err(error) => println!("[launcher] Sitzung nicht lesbar: {error}"),
    }
}

fn print_plan(prepared: &Prepared) {
    let plan = &prepared.plan;
    println!("Version:      {}", plan.version.id);
    println!("Minecraft:    {}", plan.version.minecraft_version);
    println!("Main-Class:   {}", plan.version.main_class);
    println!("Java:         {}", prepared.java.label());
    println!("Arbeitsordner: {}", plan.working_dir.display());
    println!("Classpath:    {} Einträge", plan.version.classpath.len());
    println!("Natives:      {} Archive", plan.version.natives.len());
    println!();
    println!("{}", plan.display_command().join(" "));
}

async fn list_java() {
    let runtimes = java::detect_all().await;
    if runtimes.is_empty() {
        println!("Keine Java-Installation gefunden.");
        return;
    }
    println!("{:>4}  {:<10} {:<28} Pfad", "Java", "Arch", "Version");
    for runtime in runtimes {
        println!(
            "{:>4}  {:<10} {:<28} {}",
            runtime.major,
            runtime.arch,
            runtime.version,
            runtime.path.display()
        );
    }
}

fn list_versions(game_root: &Path) {
    match version::list_installed_versions(game_root) {
        Ok(versions) if versions.is_empty() => {
            println!("Keine installierten Versionen in {}", game_root.display());
        }
        Ok(versions) => {
            for id in versions {
                println!("{id}");
            }
        }
        Err(error) => println!("Fehler: {error}"),
    }
}

async fn create_instance(game_root: &Path, settings: &LauncherSettings, args: &[String]) {
    let usage =
        "Nutzung: bamboo-launcher instances create <name> <version> [--loader fabric|forge|neoforge|quilt]";
    let (Some(name), Some(version)) = (args.get(2), args.get(3)) else {
        println!("{usage}");
        return;
    };
    let loader = match flag_value(args, "--loader") {
        Some(value) => match Loader::parse(&value) {
            Some(loader) => Some(loader),
            None => {
                println!("Unbekannter Loader '{value}'. Erlaubt: fabric, forge, neoforge, quilt.");
                return;
            }
        },
        None => None,
    };

    let manager = InstanceManager::new(game_root.join("instances"));
    if manager
        .instance_dir(name)
        .map(|dir| dir.exists())
        .unwrap_or(false)
    {
        println!("Fehler: Instanz '{name}' existiert bereits.");
        return;
    }

    let mut version_id = version.clone();
    if let Some(loader) = loader {
        match loader_installer(settings)
            .install(game_root, version, loader, None)
            .await
        {
            Ok(installed) => {
                print_loader_install(&installed);
                version_id = installed.version_id;
            }
            Err(error) => {
                println!("Fehler: {error}");
                return;
            }
        }
    }

    match manager.create(name, Some(&version_id)) {
        Ok(instance) => println!(
            "Instanz '{}' angelegt: {} ({})",
            instance.name,
            instance.dir.display(),
            version_id
        ),
        Err(error) => println!("Fehler: {error}"),
    }
}

async fn install_loader_command(game_root: &Path, settings: &LauncherSettings, args: &[String]) {
    let Some(version) = args.get(2) else {
        println!(
            "Nutzung: bamboo-launcher loader install <minecraft-version> [--loader fabric|forge|neoforge|quilt] [--loader-version <v>]"
        );
        return;
    };
    let loader = match flag_value(args, "--loader") {
        Some(value) => match Loader::parse(&value) {
            Some(loader) => loader,
            None => {
                println!("Unbekannter Loader '{value}'. Erlaubt: fabric, forge, neoforge, quilt.");
                return;
            }
        },
        None => Loader::Fabric,
    };
    let pinned = flag_value(args, "--loader-version");

    match loader_installer(settings)
        .install(game_root, version, loader, pinned.as_deref())
        .await
    {
        Ok(installed) => {
            print_loader_install(&installed);
            println!(
                "[loader] Profil-ID: {} – nutze sie mit `--instance` oder `launch {}`.",
                installed.version_id, installed.version_id
            );
        }
        Err(error) => println!("Fehler: {error}"),
    }
}

async fn update_loader_command(game_root: &Path, settings: &LauncherSettings, args: &[String]) {
    let minecraft = args.get(2).filter(|arg| !arg.starts_with("--")).cloned();
    let loader = match flag_value(args, "--loader") {
        Some(value) => match Loader::parse(&value) {
            Some(loader) => Some(loader),
            None => {
                println!("Unbekannter Loader '{value}'. Erlaubt: fabric, forge, neoforge, quilt.");
                return;
            }
        },
        None => None,
    };
    let dry_run = has_flag(args, "--dry-run");
    let installer = loader_installer(settings);

    let result = if dry_run {
        installer
            .check_updates(game_root, minecraft.as_deref(), loader)
            .await
    } else {
        installer
            .update_all(game_root, minecraft.as_deref(), loader)
            .await
    };

    match result {
        Ok(updates) => print_loader_updates(&updates, dry_run),
        Err(error) => println!("Fehler: {error}"),
    }
}

/// Bietet vor dem Start ein Loader-Update an und liefert die Version-ID, mit
/// der danach gestartet wird. Gefragt wird nur in einem echten Terminal –
/// Skripte bekommen den Hinweis ohne Blockade. Netzwerkfehler werden still
/// übergangen; die Prüfung darf den Start nie verhindern.
async fn offer_loader_update(
    settings: &LauncherSettings,
    version_id: &str,
    instance: Option<&str>,
) -> String {
    let check = tokio::time::timeout(
        Duration::from_secs(3),
        loader_installer(settings).check_update_for(&settings.game_root, version_id),
    )
    .await;

    let Ok(Ok(Some(update))) = check else {
        return version_id.to_string();
    };
    let Some(latest) = update.latest.clone() else {
        return version_id.to_string();
    };

    // Eine bereits abgelehnte Version wird nicht erneut angefragt.
    let manager = InstanceManager::new(settings.game_root.join("instances"));
    let declined = match instance {
        Some(name) => manager.declined_loader_update(name).ok().flatten(),
        None => None,
    };
    if !should_offer_update(declined.as_deref(), &latest) {
        return version_id.to_string();
    }

    println!(
        "[launcher] Hinweis: {} {} ist installiert, {} ist verfügbar.",
        update.installed.loader.label(),
        update.installed.loader_version,
        latest
    );

    if !std::io::stdin().is_terminal() {
        println!("[launcher] `bamboo-launcher loader update` hebt die Instanz an.");
        return version_id.to_string();
    }

    print!("[launcher] Jetzt aktualisieren und starten? [j/N] ");
    let _ = std::io::stdout().flush();
    let answer = tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map(|_| line)
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    if !confirmed(&answer) {
        if let Some(name) = instance {
            let _ = manager.set_declined_loader_update(name, Some(&latest));
            println!(
                "[launcher] Wird gemerkt – gefragt wird wieder bei der nächsten Loader-Version."
            );
        } else {
            println!("[launcher] Starte mit der installierten Version.");
        }
        return version_id.to_string();
    }

    match loader_installer(settings)
        .update_profile(&settings.game_root, version_id)
        .await
    {
        Ok(Some(update)) => {
            let new_id = update
                .applied
                .as_ref()
                .map(|applied| applied.version_id.clone())
                .unwrap_or_else(|| version_id.to_string());
            println!(
                "[launcher] {} {} installiert.",
                update.installed.loader.label(),
                latest
            );
            if !update.retargeted_instances.is_empty() {
                println!(
                    "[launcher] Instanzen umgehängt: {}",
                    update.retargeted_instances.join(", ")
                );
            }
            if let Some(name) = instance {
                let _ = manager.set_declined_loader_update(name, None);
            }
            new_id
        }
        Ok(None) => version_id.to_string(),
        Err(error) => {
            println!("[launcher] Update fehlgeschlagen: {error}");
            println!("[launcher] Starte mit der installierten Version.");
            version_id.to_string()
        }
    }
}

/// Eine abgelehnte Loader-Version wird übersprungen; erst eine neuere Version
/// löst wieder eine Nachfrage aus.
fn should_offer_update(declined: Option<&str>, latest: &str) -> bool {
    declined != Some(latest)
}

/// Nur eine bewusste Zustimmung gilt; Enter, „n“ und alles andere lehnen ab.
fn confirmed(answer: &str) -> bool {
    matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "j" | "ja" | "y" | "yes"
    )
}

fn print_loader_updates(updates: &[LoaderUpdate], dry_run: bool) {
    if updates.is_empty() {
        println!(
            "[loader] Keine passenden Loader-Profile gefunden. Installiere eins mit `loader install`."
        );
        return;
    }

    for update in updates {
        let installed = &update.installed;
        let Some(latest) = update.latest.as_ref() else {
            continue;
        };
        if !update.update_available {
            println!(
                "[loader] {} {} ({}) ist aktuell.",
                installed.loader.label(),
                installed.loader_version,
                installed.version_id
            );
            continue;
        }
        if dry_run {
            println!(
                "[loader] {} {} → {} verfügbar ({})",
                installed.loader.label(),
                installed.loader_version,
                latest,
                installed.version_id
            );
            continue;
        }

        let new_id = update
            .applied
            .as_ref()
            .map(|applied| applied.version_id.as_str())
            .unwrap_or_default();
        println!(
            "[loader] {} {} → {} ({})",
            installed.loader.label(),
            installed.loader_version,
            latest,
            new_id
        );
        if !update.retargeted_instances.is_empty() {
            println!(
                "[loader] Instanzen umgehängt: {}",
                update.retargeted_instances.join(", ")
            );
        }
    }

    let updated = updates
        .iter()
        .filter(|update| update.applied.is_some())
        .count();
    if dry_run {
        let available = updates.iter().filter(|u| u.update_available).count();
        println!(
            "[loader] {available} Aktualisierung(en) verfügbar. Ohne --dry-run werden sie installiert."
        );
    } else if updated == 0 {
        println!("[loader] Alles aktuell.");
    } else {
        println!("[loader] {updated} Profil(e) aktualisiert.");
    }
}

fn loader_installer(settings: &LauncherSettings) -> LoaderInstaller {
    LoaderInstaller::new(config::default_cache_dir()).with_java_path(settings.java_path.clone())
}

fn print_loader_install(installed: &LoaderInstall) {
    println!(
        "[loader] {} {} für Minecraft {} → {}",
        installed.loader.label(),
        installed.loader_version,
        installed.minecraft_version,
        installed.version_id
    );
    if installed.used_installer {
        println!(
            "[loader] Profil und Bibliotheken wurden vom offiziellen NeoForge-Installer angelegt."
        );
    } else {
        println!(
            "[loader] Bibliotheken: {} Dateien, {} geladen",
            installed.library_files,
            format_bytes(installed.downloaded_bytes)
        );
    }
    if installed.missing_libraries > 0 {
        println!(
            "[loader] Warnung: {} Bibliotheksdateien fehlen – der Classpath ist unvollständig; installiere den Loader erneut.",
            installed.missing_libraries
        );
    }
}

fn list_instances(game_root: &Path) {
    let manager = InstanceManager::new(game_root.join("instances"));
    match manager.list() {
        Ok(instances) if instances.is_empty() => println!("Keine Instanzen angelegt."),
        Ok(instances) => {
            for instance in instances {
                let version = instance.version_id.as_deref().unwrap_or("ohne Version");
                println!("{:<28} {version}", instance.name);
            }
        }
        Err(error) => println!("Fehler: {error}"),
    }
}

fn list_mods(game_root: &Path, instance: &str) {
    let manager = InstanceManager::new(game_root.join("instances"));
    match manager.scan_mods(instance) {
        Ok(mods) if mods.is_empty() => println!("Keine Mods in '{instance}'."),
        Ok(mods) => {
            for entry in mods {
                let state = if entry.enabled { "aktiv " } else { "aus   " };
                let name = entry
                    .metadata
                    .name
                    .as_deref()
                    .or(entry.metadata.id.as_deref())
                    .unwrap_or(&entry.file_name);
                let version = entry
                    .metadata
                    .version
                    .as_deref()
                    .map(|value| format!(" v{value}"))
                    .unwrap_or_default();
                println!(
                    "{state}{name}{version}  ({} KB, {})",
                    entry.size / 1024,
                    entry.file_name
                );
            }
        }
        Err(error) => println!("Fehler: {error}"),
    }
}

async fn mods_command(
    game_root: &Path,
    settings: &LauncherSettings,
    args: &[String],
) -> anyhow::Result<()> {
    match args.get(1).map(String::as_str) {
        Some("search") => mods_search(settings, args).await,
        Some("install") => mods_install(game_root, settings, args).await,
        Some(name) => {
            list_mods(game_root, name);
            Ok(())
        }
        None => {
            println!("Nutzung: bamboo-launcher mods <instanz>");
            println!(
                "        bamboo-launcher mods search <text> [--source modrinth|curseforge] [--loader <l>] [--game-version <v>]"
            );
            println!(
                "        bamboo-launcher mods install <instanz> <projekt> [--source modrinth|curseforge] [--version-id <id>]"
            );
            Ok(())
        }
    }
}

async fn mods_search(settings: &LauncherSettings, args: &[String]) -> anyhow::Result<()> {
    let source = source_flag(args)?;
    let provider = AnyProvider::from_source(source, curseforge_key(settings))?;
    let loader = match flag_value(args, "--loader") {
        Some(value) => Some(parse_loader(&value)?),
        None => None,
    };
    let target = match (flag_value(args, "--game-version"), loader) {
        (Some(version), loader) => Some(ModTarget::new(version, loader)),
        (None, Some(_)) => anyhow::bail!(
            "Für den Loader-Filter wird zusätzlich --game-version <version> benötigt."
        ),
        (None, None) => None,
    };
    let limit = match flag_value(args, "--limit") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| anyhow::anyhow!("--limit erwartet eine Zahl."))?,
        None => 10,
    };
    let text = positional_args(
        args,
        2,
        &["--source", "--loader", "--game-version", "--limit"],
    )
    .join(" ");

    if let Some(target) = &target {
        target.validate()?;
    }
    let page = provider
        .search(&SearchQuery {
            text,
            target,
            limit,
            offset: 0,
        })
        .await?;

    if page.hits.is_empty() {
        println!("Keine Treffer bei {}.", source.label());
        return Ok(());
    }
    println!(
        "{} Treffer bei {} (angezeigt: {}):",
        page.total,
        source.label(),
        page.hits.len()
    );
    for hit in &page.hits {
        println!();
        let author = hit
            .author
            .as_deref()
            .map(|author| format!(" · {author}"))
            .unwrap_or_default();
        println!(
            "{}  ·  {} Downloads  ·  ID {}{}",
            hit.title,
            format_count(hit.downloads),
            hit.id,
            author
        );
        if !hit.description.trim().is_empty() {
            println!("  {}", truncate(&hit.description, 120));
        }
    }
    println!();
    println!(
        "Installieren: bamboo-launcher mods install <instanz> {} --source {}",
        page.hits[0].id,
        source.slug()
    );
    Ok(())
}

async fn mods_install(
    game_root: &Path,
    settings: &LauncherSettings,
    args: &[String],
) -> anyhow::Result<()> {
    let usage = "Nutzung: bamboo-launcher mods install <instanz> <projekt> [--source modrinth|curseforge] [--version-id <id>] [--loader <l>] [--game-version <v>]";
    let instance_name = args
        .get(2)
        .ok_or_else(|| anyhow::anyhow!(usage.to_string()))?;
    let project = args
        .get(3)
        .ok_or_else(|| anyhow::anyhow!(usage.to_string()))?;

    let manager = InstanceManager::new(game_root.join("instances"));
    let instance = manager.load(instance_name)?;
    let version_id = instance.version_id.clone().ok_or_else(|| {
        anyhow::anyhow!(
            "Instanz '{}' hat keine Minecraft-Version. Lege sie mit `instances create {} <version>` neu an.",
            instance.name,
            instance.name
        )
    })?;
    let resolved = version::resolve_version(game_root, &version_id)?;

    let loader = match flag_value(args, "--loader") {
        Some(value) => parse_loader(&value)?,
        None => mods::detect_instance_loader(game_root, &version_id).ok_or_else(|| {
            anyhow::anyhow!(
                "In '{}' ist kein Mod-Loader installiert. Installiere Fabric, Forge, NeoForge oder Quilt – oder setze --loader.",
                version_id
            )
        })?,
    };
    let game_version =
        flag_value(args, "--game-version").unwrap_or_else(|| resolved.minecraft_version.clone());
    let target = ModTarget::new(game_version, Some(loader));
    target.validate()?;

    let source = source_flag(args)?;
    let provider = AnyProvider::from_source(source, curseforge_key(settings))?;

    let mut ledger = ModLedger::load(&instance.dir)?;
    let installed = ledger.installed_projects(&instance.dir);
    let options = ResolveOptions::new(target.clone());

    println!(
        "[mods] {}: {} (Quelle: {})",
        instance.name,
        project,
        source.label()
    );
    println!("[mods] Ziel: {}", target.describe());
    let plan = plan_install(
        &provider,
        project,
        flag_value(args, "--version-id").as_deref(),
        &options,
        &installed,
    )
    .await?;

    println!(
        "[mods] Gewählt: {} ({})",
        plan.primary.label(),
        plan.primary.version_number
    );
    for planned in plan.mods.iter().skip(1) {
        println!(
            "[mods] Abhängigkeit: {} ({})",
            planned.version.label(),
            planned.version.project_id
        );
    }
    for note in &plan.notes {
        println!("[mods] Hinweis: {}", note.describe());
    }
    if !plan.unresolved.is_empty() {
        for line in plan.missing_required() {
            println!("[mods] Fehlt: {line}");
        }
        anyhow::bail!("Pflichtabhängigkeiten fehlen – es wurde nichts installiert.");
    }

    let report = install_plan(&provider, &instance, &plan, &Downloader::new(), &mut ledger).await?;
    for file in &report.files {
        println!(
            "[mods] {} ({}, {} KB)",
            file.title,
            file.file_name,
            file.size.unwrap_or(0) / 1024
        );
    }
    println!(
        "[mods] Fertig: {} geladen, {} übersprungen, {}",
        report.download.downloaded,
        report.download.skipped,
        format_bytes(report.download.bytes)
    );
    Ok(())
}

fn source_flag(args: &[String]) -> anyhow::Result<ModSource> {
    match flag_value(args, "--source") {
        Some(value) => ModSource::parse(&value).ok_or_else(|| {
            anyhow::anyhow!("Unbekannte Quelle '{value}'. Erlaubt: modrinth, curseforge.")
        }),
        None => Ok(ModSource::Modrinth),
    }
}

async fn import_modpack_command(game_root: &Path, settings: &LauncherSettings, args: &[String]) {
    let usage = "Nutzung: bamboo-launcher modpacks import <datei.mrpack> [--name <instanz>]";
    let Some(path) = args.get(2) else {
        println!("{usage}");
        return;
    };
    let requested_name = flag_value(args, "--name");
    let importer = ModpackImporter::new(config::default_cache_dir())
        .with_java_path(settings.java_path.clone())
        .with_install_progress(progress_printer());

    println!("[modpack] Lese {} ...", path);
    match importer
        .import(game_root, Path::new(path), requested_name.as_deref())
        .await
    {
        Ok(report) => {
            println!(
                "[modpack] {} {} → Instanz '{}'",
                report.pack_name, report.pack_version, report.instance.name
            );
            if let Some(install) = &report.base_install {
                let java = match (&install.java, &report.system_java) {
                    (Some(java), _) => format!(", Java {}", java.component),
                    (None, Some(java)) => format!(", {} vorhanden", java.label()),
                    (None, None) => String::new(),
                };
                println!(
                    "[modpack] Minecraft {} mitinstalliert: {} Dateien, {} Assets{java}",
                    report.minecraft_version,
                    install.files.downloaded,
                    install.assets.as_ref().map_or(0, |assets| assets.objects),
                );
            }
            match (&report.loader, &report.loader_version) {
                (Some(loader), Some(version)) => println!(
                    "[modpack] {} {} für Minecraft {}",
                    loader.label(),
                    version,
                    report.minecraft_version
                ),
                _ => println!("[modpack] Vanilla {}", report.minecraft_version),
            }
            let skipped = if report.skipped > 0 {
                format!(", {} client-seitig übersprungen", report.skipped)
            } else {
                String::new()
            };
            println!(
                "[modpack] {} Dateien, {} Overrides, {}{skipped}",
                report.files,
                report.overrides,
                format_bytes(report.downloaded_bytes)
            );
            println!(
                "[modpack] Starten: bamboo-launcher launch {} --instance {}",
                report.version_id, report.instance.name
            );
        }
        Err(error) => println!("[modpack] Fehler: {error}"),
    }
}

fn parse_loader(value: &str) -> anyhow::Result<Loader> {
    Loader::parse(value).ok_or_else(|| {
        anyhow::anyhow!("Unbekannter Loader '{value}'. Erlaubt: fabric, forge, neoforge, quilt.")
    })
}

/// Reihenfolge: Umgebungsvariable, generische Variable, Einstellungsdatei,
/// zuletzt die Einstellungsdatei der alten Electron-Fassung.
fn curseforge_key(settings: &LauncherSettings) -> Option<String> {
    ["BAMBOO_CURSEFORGE_API_KEY", "CURSEFORGE_API_KEY"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| settings.curseforge_api_key.clone())
        .or_else(config::legacy_curseforge_api_key)
}

/// Alle Argumente ab `skip`, ohne Flags und deren Werte.
fn positional_args(args: &[String], skip: usize, value_flags: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = skip;
    while index < args.len() {
        let argument = &args[index];
        if value_flags.contains(&argument.as_str()) {
            index += 2;
            continue;
        }
        if argument.starts_with("--") {
            index += 1;
            continue;
        }
        values.push(argument.clone());
        index += 1;
    }
    values
}

fn format_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0).replace('.', ",")
    } else if value >= 1_000 {
        format!("{:.0}k", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn truncate(text: &str, max: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result: String = compact.chars().take(max).collect();
    if compact.chars().count() > max {
        result.push('…');
    }
    result
}

/// Fortschritt kompakt halten: pro Schritt eine Zeile und danach nur, wenn
/// genug Zeit oder genug Dateien vergangen sind – Assets haben tausende.
fn progress_printer() -> impl Fn(InstallEvent) + Send + Sync + 'static {
    struct State {
        step: Option<InstallStep>,
        last: Instant,
        last_completed: usize,
    }

    let state = Arc::new(Mutex::new(State {
        step: None,
        last: Instant::now(),
        last_completed: 0,
    }));

    move |event| {
        let mut state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let new_step = state.step != Some(event.step);

        if new_step {
            state.step = Some(event.step);
            state.last = now;
            state.last_completed = event.progress.completed;
            println!("[install] {} ...", event.step.label());
            return;
        }

        let progress = &event.progress;
        if progress.total == 0 {
            return;
        }
        let finished = progress.completed >= progress.total;
        let due = now.duration_since(state.last) >= Duration::from_millis(400)
            || progress.completed.saturating_sub(state.last_completed) >= 200;
        if !finished && !due {
            return;
        }

        state.last = now;
        state.last_completed = progress.completed;
        let total = progress
            .total_bytes
            .map(|bytes| format!(" / {}", format_bytes(bytes)))
            .unwrap_or_default();
        println!(
            "[install] {} {}/{}  {}{}",
            event.step.label(),
            progress.completed,
            progress.total,
            format_bytes(progress.bytes),
            total
        );
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn print_repair_report(report: &RepairReport) {
    let install = &report.install;
    let assets_downloaded = install
        .assets
        .as_ref()
        .map_or(0, |assets| assets.download.downloaded);
    let java_downloaded = install
        .java
        .as_ref()
        .map_or(0, |java| java.download.downloaded);

    println!();
    if install.downloaded_files() == 0 {
        println!(
            "[repair] Version {} ist vollständig – nichts nachgeladen.",
            report.version_id
        );
    } else {
        println!(
            "[repair] Version {}: {} Dateien, {} Assets, {} Java-Dateien nachgeladen",
            report.version_id, install.files.downloaded, assets_downloaded, java_downloaded
        );
    }
    if let Some(java) = &report.system_java {
        println!(
            "[repair] Java: {} vorhanden – Runtime-Download übersprungen",
            java.label()
        );
    } else if let Some(java) = &install.java {
        println!(
            "[repair] Java: {} {} -> {}",
            java.component,
            java.version.as_deref().unwrap_or("unbekannt"),
            java.java_path.display()
        );
    }
    if let Some(assets) = &install.assets {
        println!(
            "[repair] Assets: {} Objekte (Index {})",
            assets.objects, assets.index_id
        );
    }
    println!(
        "[repair] Gesamt: {} in {} Dateien",
        format_bytes(install.downloaded_bytes()),
        install.downloaded_files()
    );
}

fn print_install_report(report: &InstallReport) {
    println!();
    if report.version_json_downloaded {
        println!("[install] Versions-JSON geladen");
    }
    println!(
        "[install] Dateien: {} geladen, {} übersprungen",
        report.files.downloaded, report.files.skipped
    );
    if let Some(assets) = &report.assets {
        println!(
            "[install] Assets: {} Objekte (Index {})",
            assets.objects, assets.index_id
        );
        if let Some(directory) = &assets.virtual_dir {
            println!("[install] Legacy-Assets: {}", directory.display());
        }
    }
    if let Some(java) = &report.java {
        println!(
            "[install] Java: {} {} -> {}",
            java.component,
            java.version.as_deref().unwrap_or("unbekannt"),
            java.java_path.display()
        );
    }
    println!(
        "[install] Gesamt: {} in {} Dateien",
        format_bytes(report.downloaded_bytes()),
        report.downloaded_files()
    );
}

fn print_help() {
    println!("Bamboo Launcher {}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Nutzung: bamboo-launcher <befehl> [optionen]");
    println!();
    println!("  login                         Microsoft-Anmeldung im Browser starten");
    println!(
        "  logout                        Gespeicherte Sitzung aus dem Credential Store löschen"
    );
    println!("  session                       Gespeicherte Sitzung anzeigen");
    println!("  install <version>             Version vollständig herunterladen");
    println!("  repair <version>              Fehlende Dateien einer Installation nachladen");
    println!("  java                          Gefundene Java-Installationen anzeigen");
    println!("  versions                      Installierte Minecraft-Versionen auflisten");
    println!("  instances                     Angelegte Instanzen auflisten");
    println!("  instances create <n> <ver>    Neue Instanz anlegen (--loader …)");
    println!("  loader install <mc>           Loader-Profil installieren (Fabric, Forge, NeoForge, Quilt)");
    println!("  loader update [<mc>]          Loader-Profile aktualisieren (--dry-run)");
    println!("  mods <instanz>                Mods einer Instanz auflisten");
    println!("  mods search <text>            Mods suchen (Modrinth, optional CurseForge)");
    println!("  mods install <inst> <projekt> Mod samt Abhängigkeiten installieren");
    println!(
        "  modpacks import <datei>      Modrinth-Modpack als Instanz anlegen (inkl. Minecraft)"
    );
    println!("  plan <version> [optionen]     Startbefehl bauen und anzeigen");
    println!("  launch <version> [optionen]   Minecraft starten und Ausgabe streamen");
    println!();
    println!("Optionen:");
    println!("  --instance <name>   Instanz als Arbeitsverzeichnis verwenden");
    println!("  --user <name>       Offline-Profil erzwingen (Standard: gespeicherte Sitzung)");
    println!("  --demo              Demo-Modus aktivieren");
    println!("  --server host:port  Direkt auf einen Server verbinden");
    println!("  --world <name>      Welt direkt laden (ab 1.20)");
    println!();
    println!("Install-Optionen:");
    println!("  --no-assets         Assets überspringen");
    println!("  --no-java           Java-Runtime nicht herunterladen");
    println!("  --refresh-manifest  Versions-Manifest neu laden");
    println!();
    println!("Mod- und Loader-Optionen:");
    println!("  --source <quelle>      modrinth (Standard) oder curseforge");
    println!("  --loader <loader>      fabric (Standard), neoforge, forge oder quilt");
    println!("  --loader-version <v>   Bestimmte Loader-Version erzwingen");
    println!("  --dry-run              Nur zeigen, welche Loader-Updates anstehen");
    println!("  --game-version <ver>   Zielversion (Standard: Version der Instanz)");
    println!("  --version-id <id>      Genau diese Mod-Version installieren");
    println!("  --limit <n>            Trefferzahl der Suche (Standard: 10)");
    println!("  --name <name>          Instanzname beim Modpack-Import");
    println!();
    println!(
        "Einstellungen: {}",
        config::default_settings_path().display()
    );
}

#[cfg(test)]
mod tests {
    use super::{confirmed, should_offer_update};

    #[test]
    fn declined_versions_are_not_offered_again() {
        assert!(should_offer_update(None, "0.20.1"));
        assert!(!should_offer_update(Some("0.20.1"), "0.20.1"));
        assert!(should_offer_update(Some("0.20.1"), "0.20.2"));
    }

    #[test]
    fn only_explicit_yes_confirms_an_update() {
        for answer in ["j", "J", "ja", " Ja ", "y", "yes", "YES\n"] {
            assert!(confirmed(answer), "{answer:?} sollte zustimmen");
        }
        for answer in ["", "\n", "n", "nein", "no", "später", "jj"] {
            assert!(!confirmed(answer), "{answer:?} sollte ablehnen");
        }
    }
}
