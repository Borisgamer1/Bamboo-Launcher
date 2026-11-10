//! End-to-End-Test des Startpfads: Versions-JSON -> Classpath -> Argumente -> Natives.

use bamboo_launcher::config::{MemorySettings, Resolution};
use bamboo_launcher::java::JavaRuntime;
use bamboo_launcher::launcher::{
    build_launch_plan, spawn_process, Account, LaunchEvent, LaunchOptions,
};
use bamboo_launcher::version;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn temp_root() -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "bamboo-it-{}-{}-{id}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_version(root: &Path, id: &str, json: &serde_json::Value) {
    let dir = root.join("versions").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_string_pretty(json).unwrap(),
    )
    .unwrap();
}

fn vanilla_json() -> serde_json::Value {
    json!({
        "id": "1.20.1",
        "type": "release",
        "mainClass": "net.minecraft.client.main.Main",
        "assets": "5",
        "assetIndex": { "id": "5" },
        "javaVersion": { "component": "java-runtime-gamma", "majorVersion": 17 },
        "arguments": {
            "game": [
                "--username", "${auth_player_name}",
                "--version", "${version_name}",
                "--gameDir", "${game_directory}",
                "--assetsDir", "${assets_root}",
                "--assetIndex", "${assets_index_name}",
                "--uuid", "${auth_uuid}",
                "--accessToken", "${auth_access_token}",
                "--userType", "${user_type}"
            ],
            "jvm": [
                "-Djava.library.path=${natives_directory}",
                "-Dminecraft.launcher.brand=${launcher_name}",
                "-cp", "${classpath}"
            ]
        },
        "libraries": [
            {
                "name": "com.example:beispiel:1.0",
                "downloads": {
                    "artifact": {
                        "path": "com/example/beispiel/1.0/beispiel-1.0.jar",
                        "url": "https://example.invalid/beispiel-1.0.jar"
                    }
                }
            },
            {
                "name": "org.lwjgl:lwjgl:3.3.3",
                "natives": { "windows": "natives-windows", "linux": "natives-linux" },
                "downloads": {
                    "classifiers": {
                        "natives-windows": {
                            "path": "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
                            "url": "https://example.invalid/lwjgl-natives.jar"
                        }
                    }
                }
            }
        ]
    })
}

/// Legt ein echtes Native-ZIP mit einem Windows-Eintrag an.
fn write_native_jar(root: &Path) -> PathBuf {
    let path = root
        .join("libraries")
        .join("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("windows/x64/foo.dll", options).unwrap();
    writer.write_all(b"fake-dll").unwrap();
    writer.start_file("META-INF/MANIFEST.MF", options).unwrap();
    writer.write_all(b"ignorieren").unwrap();
    writer.finish().unwrap();
    path
}

fn options(java: JavaRuntime) -> LaunchOptions {
    LaunchOptions {
        account: Account::offline("TestSpieler"),
        memory: MemorySettings::new(1024, 4096),
        java,
        extra_jvm_args: vec!["-XX:+UseG1GC".to_string()],
        extra_game_args: Vec::new(),
        resolution: Some(Resolution {
            width: 1280,
            height: 720,
        }),
        demo: false,
        server: Some(("mc.example.invalid".to_string(), 25565)),
        quick_play_world: None,
    }
}

fn java_stub() -> JavaRuntime {
    JavaRuntime {
        path: PathBuf::from("C:/fake/java.exe"),
        major: 17,
        version: "17.0.10".to_string(),
        vendor: Some("Test".to_string()),
        arch: "x64".to_string(),
    }
}

fn argument_after<'a>(command: &'a [String], flag: &str) -> Option<&'a str> {
    let index = command.iter().position(|argument| argument == flag)?;
    command.get(index + 1).map(String::as_str)
}

#[test]
fn builds_complete_launch_command() {
    let root = temp_root();
    write_version(&root, "1.20.1", &vanilla_json());
    write_native_jar(&root);

    let plan = build_launch_plan(
        &root,
        "1.20.1",
        &root.join("instances").join("Test"),
        &options(java_stub()),
    )
    .expect("Startbefehl muss gebaut werden");

    let command = &plan.command;
    assert_eq!(command[0], "C:/fake/java.exe");
    assert!(command.contains(&"-Xms1024M".to_string()));
    assert!(command.contains(&"-Xmx4096M".to_string()));
    assert!(command.contains(&"-XX:+UseG1GC".to_string()));

    assert_eq!(argument_after(command, "--username"), Some("TestSpieler"));
    assert_eq!(argument_after(command, "--accessToken"), Some("0"));
    assert_eq!(argument_after(command, "--userType"), Some("legacy"));
    assert_eq!(argument_after(command, "--version"), Some("1.20.1"));
    assert_eq!(argument_after(command, "--assetIndex"), Some("5"));

    let uuid = argument_after(command, "--uuid").expect("UUID fehlt");
    assert_eq!(uuid.len(), 32);
    assert_eq!(&uuid[12..13], "3");

    let separator = if cfg!(windows) { ';' } else { ':' };
    let classpath = command
        .iter()
        .position(|argument| argument == "-cp")
        .and_then(|index| command.get(index + 1))
        .expect("Classpath fehlt");
    assert!(classpath.contains("beispiel-1.0.jar"));
    assert!(classpath.contains("1.20.1.jar"));
    assert!(classpath.contains(separator));

    // Die Main-Class muss vor den Spielargumenten stehen.
    let main = command
        .iter()
        .position(|argument| argument == "net.minecraft.client.main.Main")
        .expect("Main-Class fehlt");
    let username = command
        .iter()
        .position(|argument| argument == "--username")
        .unwrap();
    assert!(main < username);

    // Quick Play für 1.20 statt --server.
    assert_eq!(
        argument_after(command, "--quickPlayMultiplayer"),
        Some("mc.example.invalid:25565")
    );
    assert!(!command.iter().any(|argument| argument == "--server"));

    // Natives wurden entpackt, Meta-Inf ignoriert.
    let natives = root.join("versions/1.20.1/1.20.1-natives/foo.dll");
    assert!(natives.is_file(), "foo.dll wurde nicht entpackt");
    assert!(!root
        .join("versions/1.20.1/1.20.1-natives/META-INF/MANIFEST.MF")
        .exists());
    assert!(command
        .iter()
        .any(|argument| argument.starts_with("-Djava.library.path=")));

    // Kein Platzhalter darf unaufgelöst im Befehl stehen bleiben.
    assert!(plan
        .display_command()
        .iter()
        .all(|argument| !argument.contains("${")));

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn second_launch_survives_natives_locked_by_the_running_game() {
    let root = temp_root();
    write_version(&root, "1.20.1", &vanilla_json());
    write_native_jar(&root);

    build_launch_plan(
        &root,
        "1.20.1",
        &root.join("instances").join("Erste"),
        &options(java_stub()),
    )
    .expect("erster Start muss einen Plan bauen");

    // Eine laufende Instanz hält ihre Natives offen; Windows verweigert dann
    // jedes Überschreiben. Der zweite Start derselben Version muss trotzdem
    // funktionieren, sonst läuft immer nur eine Instanz.
    let dll = root.join("versions/1.20.1/1.20.1-natives/foo.dll");
    #[cfg(windows)]
    let _locked = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&dll)
            .expect("DLL muss sich sperren lassen")
    };
    #[cfg(not(windows))]
    let _locked = std::fs::File::open(&dll).unwrap();

    let second = build_launch_plan(
        &root,
        "1.20.1",
        &root.join("instances").join("Zweite"),
        &options(java_stub()),
    );
    assert!(
        second.is_ok(),
        "zweiter Start derselben Version muss möglich sein: {:?}",
        second.err()
    );
    assert!(dll.is_file(), "die benutzte DLL darf nicht verschwinden");

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn resolves_inheritance_chain_from_base() {
    let root = temp_root();
    write_version(&root, "1.20.1", &vanilla_json());
    write_version(
        &root,
        "fabric-1.20.1",
        &json!({
            "id": "fabric-1.20.1",
            "inheritsFrom": "1.20.1",
            "libraries": [
                { "name": "net.fabricmc:fabric-loader:0.15.11" }
            ]
        }),
    );

    let resolved = version::resolve_version(&root, "fabric-1.20.1").unwrap();
    assert_eq!(resolved.main_class, "net.minecraft.client.main.Main");
    assert_eq!(resolved.minecraft_version, "1.20.1");
    assert_eq!(resolved.java_major, 17);
    assert!(resolved
        .libraries
        .iter()
        .any(|library| library.name.contains("fabric-loader")));
    assert!(resolved
        .classpath
        .iter()
        .any(|path| path.ends_with("1.20.1.jar")));

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn forge_ignore_list_gets_client_jar() {
    let root = temp_root();
    write_version(
        &root,
        "1.20.1",
        &json!({
            "id": "1.20.1",
            "mainClass": "net.minecraft.client.main.Main",
            "assets": "5",
            "assetIndex": { "id": "5" },
            "arguments": { "game": [], "jvm": ["-cp", "${classpath}"] },
            "libraries": []
        }),
    );
    write_version(
        &root,
        "forge-test",
        &json!({
            "id": "forge-test",
            "inheritsFrom": "1.20.1",
            "mainClass": "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "arguments": {
                "game": [],
                "jvm": [
                    "-DignoreList=asm,${version_name}.jar",
                    "-DlibraryDirectory=${library_directory}"
                ]
            }
        }),
    );

    let plan = build_launch_plan(&root, "forge-test", &root, &options(java_stub())).unwrap();
    let ignore = plan
        .command
        .iter()
        .find(|argument| argument.starts_with("-DignoreList="))
        .expect("-DignoreList fehlt");
    assert!(ignore.contains("forge-test.jar"));
    assert!(ignore.ends_with(",1.20.1.jar"));
    assert_eq!(ignore.matches("1.20.1.jar").count(), 1);

    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn streams_output_and_writes_log() {
    let root = temp_root();
    let marker = "Setting user: Test";
    let argv = if cfg!(windows) {
        vec![
            "cmd".to_string(),
            "/C".to_string(),
            "echo Setting user: Test && echo zweite zeile".to_string(),
        ]
    } else {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "echo 'Setting user: Test'; echo zweite zeile".to_string(),
        ]
    };

    let log_path = root.join("logs").join("test.log");
    let mut process = spawn_process(&argv, &root, Some(log_path.clone()))
        .await
        .expect("Prozess muss starten");

    let mut lines: Vec<String> = Vec::new();
    let mut ready = false;
    let status = process
        .pump_until_exit(|event| match event {
            LaunchEvent::Line { text, .. } => lines.push(text.clone()),
            LaunchEvent::Ready => ready = true,
            LaunchEvent::CrashReport(_) => {}
        })
        .await
        .expect("Prozess muss enden");

    assert!(status.success());
    assert!(ready, "Ready-Marker wurde nicht erkannt");
    assert!(lines.iter().any(|line| line.contains(marker)));
    let log = std::fs::read_to_string(&log_path).expect("Logdatei fehlt");
    assert!(log.contains(marker));

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn reports_cycles_and_missing_versions() {
    let root = temp_root();
    write_version(
        &root,
        "a",
        &json!({ "id": "a", "inheritsFrom": "b", "mainClass": "Main" }),
    );
    write_version(
        &root,
        "b",
        &json!({ "id": "b", "inheritsFrom": "a", "mainClass": "Main" }),
    );

    let cycle = version::resolve_version(&root, "a").unwrap_err();
    assert!(matches!(
        cycle,
        bamboo_launcher::LauncherError::CircularInheritance(_)
    ));

    let missing = version::resolve_version(&root, "gibt-es-nicht").unwrap_err();
    assert!(matches!(
        missing,
        bamboo_launcher::LauncherError::VersionNotFound(_, _)
    ));

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn legacy_versions_get_legacy_arguments() {
    let root = temp_root();
    write_version(
        &root,
        "1.8.9",
        &json!({
            "id": "1.8.9",
            "type": "release",
            "mainClass": "net.minecraft.client.main.Main",
            "assets": "legacy",
            "minecraftArguments": "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets}",
            "libraries": []
        }),
    );

    let plan = build_launch_plan(&root, "1.8.9", &root, &options(java_stub())).unwrap();
    assert!(plan.version.legacy);
    assert!(plan.command.iter().any(|argument| argument == "-cp"));
    assert!(plan
        .command
        .iter()
        .any(|argument| argument.starts_with("-Djava.library.path=")));
    // 1.8.9 kennt kein Quick Play: der Server wird klassisch übergeben.
    assert_eq!(
        argument_after(&plan.command, "--server"),
        Some("mc.example.invalid")
    );
    assert_eq!(argument_after(&plan.command, "--port"), Some("25565"));
    // 1.8.9 hat den Asset-Index "legacy": Die Assets müssen virtualisiert sein.
    let expected_assets = plan
        .version
        .assets_root
        .join("virtual")
        .join("legacy")
        .to_string_lossy()
        .replace('\\', "/");
    assert_eq!(
        argument_after(&plan.command, "--assetsDir"),
        Some(expected_assets.as_str())
    );

    std::fs::remove_dir_all(root).ok();
}
