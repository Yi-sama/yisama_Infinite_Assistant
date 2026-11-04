use codex_win_engine as engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};

mod download;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    app_version: String,
    package_version: String,
    architecture: String,
    package_moniker: String,
    size: u64,
    sha256: String,
    mirror_url: String,
    release_url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    format: u32,
    source: String,
    root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Desktop {
    root: PathBuf,
    executable: PathBuf,
    version: String,
    source: String,
    running: bool,
}

fn release() -> Release {
    serde_json::from_str(include_str!("../codex-release.json")).expect("bundled Codex release")
}

fn same_path(left: &Path, right: &Path) -> bool {
    engine::same_windows_path(left, right)
}

fn desktop(installed: engine::InstalledWindowsCodex) -> Result<Desktop> {
    let root = PathBuf::from(&installed.path);
    let executable = engine::installed_app_exe(&root)
        .ok_or("Codex installation has no app executable. Select its installation again.")?;
    let running = engine::codex_running_for_root(&root)?;
    Ok(Desktop {
        root,
        executable,
        version: installed.version,
        source: installed.source,
        running,
    })
}

fn registered() -> Option<engine::InstalledWindowsCodex> {
    // A nonexistent portable root makes this an MSIX-only query.
    engine::detect_installed_codex(Path::new(""))
        .filter(|installed| installed.source == "msix")
}

fn read_location(file: &Path) -> Result<Location> {
    let saved: Location = serde_json::from_slice(&fs::read(file)?)?;
    if saved.format != 1 || !["msix", "portable"].contains(&saved.source.as_str()) || !saved.root.is_absolute() {
        return Err("Saved Codex location is invalid. Run the installer to select it again.".into());
    }
    Ok(saved)
}

fn select(path: &Path) -> Result<Desktop> {
    let root = if path.is_file() {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if !["codex.exe", "chatgpt.exe"].contains(&name.to_ascii_lowercase().as_str()) {
            return Err("Select Codex.exe or ChatGPT.exe, not the command-line Codex.".into());
        }
        path.parent().ok_or("Codex executable has no parent directory.")?
    } else {
        path
    };
    if !root.is_absolute() {
        return Err("Codex installation path must be absolute.".into());
    }
    if let Some(installed) = registered() {
        let package = Path::new(&installed.path);
        if same_path(root, package) || same_path(root, &package.join("app")) {
            return desktop(installed);
        }
    }
    for candidate in [Some(root), root.parent()].into_iter().flatten() {
        if let Some(installed) = engine::detect_portable_install(candidate) {
            return desktop(installed);
        }
    }
    Err("This is not a recognizable Codex desktop installation.".into())
}

fn detect(location: Option<&Path>, selected: Option<&Path>) -> Result<Option<Desktop>> {
    if let Some(path) = selected {
        return select(path).map(Some);
    }
    if let Some(file) = location.filter(|file| file.exists()) {
        let saved = read_location(file)?;
        if saved.source == "msix" {
            return registered().map(desktop).transpose();
        }
        return select(&saved.root).map(Some);
    }
    if let Some(installed) = registered() {
        return desktop(installed).map(Some);
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        for relative in [Path::new("Programs").join("Codex"), PathBuf::from("Codex")] {
            let root = PathBuf::from(&local).join(relative);
            if let Some(installed) = engine::detect_portable_install(&root) {
                return desktop(installed).map(Some);
            }
        }
    }
    Ok(None)
}

fn ini_value(value: impl AsRef<str>) -> String {
    value.as_ref().replace(['\r', '\n', '\0'], " ")
}

fn write_report(path: &Path, values: &BTreeMap<String, String>) -> Result<()> {
    let mut text = String::from("[codex]\r\n");
    for (key, value) in values {
        text.push_str(&format!("{}={}\r\n", key, ini_value(value)));
    }
    // Inno's native INI reader requires UTF-16 for non-ASCII Windows paths.
    let mut bytes = vec![0xff, 0xfe];
    for word in text.encode_utf16() {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    fs::write(path, bytes)?;
    Ok(())
}

fn desktop_report(found: Option<&Desktop>) -> BTreeMap<String, String> {
    let mut report = BTreeMap::from([(
        "status".into(),
        if found.is_some() { "found" } else { "missing" }.into(),
    )]);
    if let Some(found) = found {
        report.insert("root".into(), found.root.display().to_string());
        report.insert("executable".into(), found.executable.display().to_string());
        report.insert("version".into(), found.version.clone());
        report.insert("source".into(), found.source.clone());
        report.insert("running".into(), if found.running { "1" } else { "0" }.into());
        report.insert(
            "tested".into(),
            if ["26.1021.31345", "26.1027.30824", "26.1027.3384.0"].contains(&found.version.as_str()) {
                "1"
            } else {
                "0"
            }
            .into(),
        );
    }
    report
}

fn verify_package(path: &Path, pinned: &Release) -> Result<()> {
    if fs::metadata(path)?.len() != pinned.size {
        return Err("Codex download size does not match the pinned release.".into());
    }
    if !engine::sha256_file(path)?.eq_ignore_ascii_case(&pinned.sha256) {
        return Err("Codex SHA256 verification failed; nothing was installed.".into());
    }
    let identity = engine::read_msix_identity(path)?;
    engine::validate_codex_identity(
        &identity,
        &pinned.package_version,
        Some(&pinned.architecture),
    )?;
    if !engine::verify_openai_authenticode(path)?.is_valid_openai() {
        return Err("Codex publisher/signature verification failed; nothing was installed.".into());
    }
    Ok(())
}

/// Installs without administrator rights: the package is unpacked into a normal
/// folder, as Codex-App-Manager's portable route does. Never replaces a folder
/// that already has content, and never touches the user's Codex data.
fn install_portable(file: &Path, root: &Path) -> Result<BTreeMap<String, String>> {
    if !root.is_absolute() {
        return Err("Codex installation folder must be an absolute path.".into());
    }
    if root.exists() && (!root.is_dir() || fs::read_dir(root)?.next().is_some()) {
        return Err(format!(
            "安装文件夹已存在且不是空的，为避免覆盖已有文件，已停止：{}", root.display()
        ).into());
    }
    verify_package(file, &release())?;
    let report = engine::install_portable_from_msix(file, root, false)?;
    let found = select(root).map_err(|error| format!("安装后未能识别 Codex：{error}"))?;
    Ok(BTreeMap::from([
        ("status".into(), "ready".into()),
        ("root".into(), found.root.display().to_string()),
        ("executable".into(), found.executable.display().to_string()),
        ("version".into(), report.version),
    ]))
}

fn source_report() -> BTreeMap<String, String> {
    let pinned = release();
    // Both URLs identify the pinned file; source selection never queries latest.
    // The Chengdu mirror comes first; the downloader falls back to GitHub.
    // The downloader and installer verify size, SHA256, identity and signature.
    BTreeMap::from([
        ("status".into(), "ready".into()),
        ("url".into(), if pinned.mirror_url.is_empty() { pinned.release_url } else { pinned.mirror_url }),
        ("filename".into(), format!("{}.msix", pinned.package_moniker)),
        ("version".into(), pinned.app_version),
        ("size".into(), pinned.size.to_string()),
        ("sha256".into(), pinned.sha256),
    ])
}

fn arguments(args: &[String]) -> Result<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let key = &args[index];
        if key == "--json" {
            if result.insert(key.clone(), String::new()).is_some() {
                return Err("Repeated bootstrap argument.".into());
            }
            index += 1;
        } else if ["--report", "--selected", "--location", "--file", "--cancel", "--root"].contains(&key.as_str()) {
            let value = args.get(index + 1).ok_or("Missing bootstrap argument value.")?;
            if value.starts_with("--") || result.insert(key.clone(), value.clone()).is_some() {
                return Err("Invalid or repeated bootstrap argument.".into());
            }
            index += 2;
        } else {
            return Err(format!("Unknown bootstrap argument: {key}").into());
        }
    }
    Ok(result)
}

fn run(command: &str, args: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>> {
    let location = args.get("--location").map(Path::new);
    let selected = args.get("--selected").map(Path::new);
    match command {
        "detect" => {
            let found = detect(location, selected)?;
            if args.contains_key("--json") {
                println!("{}", serde_json::to_string(&found)?);
            }
            Ok(desktop_report(found.as_ref()))
        }
        "remember" => {
            let file = location.ok_or("--location is required.")?;
            let found = select(selected.ok_or("--selected is required.")?)?;
            let saved = Location { format: 1, source: found.source.clone(), root: found.root.clone() };
            fs::write(file, serde_json::to_vec_pretty(&saved)?)?;
            Ok(desktop_report(Some(&found)))
        }
        "running" => {
            let mut roots = Vec::new();
            if let Some(file) = location.filter(|file| file.exists()) {
                roots.push(read_location(file)?.root);
            }
            if let Some(installed) = registered() {
                roots.push(PathBuf::from(installed.path));
            }
            let mut running = false;
            for root in roots {
                running |= engine::codex_running_for_root(&root)?;
            }
            Ok(BTreeMap::from([
                ("status".into(), "ready".into()),
                ("running".into(), if running { "1" } else { "0" }.into()),
            ]))
        }
        "source" => Ok(source_report()),
        "download" => download::download(
            Path::new(args.get("--file").ok_or("--file is required.")?),
            Path::new(args.get("--report").ok_or("--report is required.")?),
            Path::new(args.get("--cancel").ok_or("--cancel is required.")?),
            &release(),
        ),
        "install-portable" => install_portable(
            Path::new(args.get("--file").ok_or("--file is required.")?),
            Path::new(args.get("--root").ok_or("--root is required.")?),
        ),
        "verify" => {
            verify_package(Path::new(args.get("--file").ok_or("--file is required.")?), &release())?;
            Ok(BTreeMap::from([("status".into(), "ready".into())]))
        }
        "release" => {
            let pinned = release();
            Ok(BTreeMap::from([
                ("status".into(), "ready".into()),
                ("version".into(), pinned.app_version),
                ("packageVersion".into(), pinned.package_version),
                ("size".into(), pinned.size.to_string()),
                ("sha256".into(), pinned.sha256),
            ]))
        }
        _ => Err("Usage: codex-bootstrap detect|running|remember|source|download|verify|install-portable|release [--report file]".into()),
    }
}

fn main() -> ExitCode {
    let raw: Vec<String> = env::args().skip(1).collect();
    let parsed = arguments(raw.get(1..).unwrap_or(&[]));
    let result = parsed.as_ref().map_err(|error| error.to_string()).and_then(|args| {
        run(raw.first().map(String::as_str).unwrap_or(""), args).map_err(|error| error.to_string())
    });
    let (values, code) = match result {
        Ok(values) => (values, ExitCode::SUCCESS),
        Err(message) => {
            eprintln!("{message}");
            (BTreeMap::from([("status".into(), "error".into()), ("message".into(), message)]), ExitCode::FAILURE)
        }
    };
    if let Ok(args) = parsed {
        if let Some(path) = args.get("--report") {
            if let Err(error) = write_report(Path::new(path), &values) {
                eprintln!("Cannot write bootstrap report: {error}");
                return ExitCode::FAILURE;
            }
        }
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) struct Fixture(pub(super) PathBuf);

    impl Fixture {
        pub(super) fn new(name: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = env::temp_dir().join(format!("yisama-bootstrap-test-{}-{name}-{stamp}", std::process::id()));
            fs::create_dir_all(root.join("app")).unwrap();
            Self(root)
        }

        fn codex(&self, identity: &str) -> PathBuf {
            fs::write(self.0.join("AppxManifest.xml"), format!(
                r#"<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
                <Identity Name="{identity}" Version="26.1027.3384.0" ProcessorArchitecture="x64"
                Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"/>
                <Applications><Application Id="Codex" Executable="app\Codex.exe"/></Applications>
                </Package>"#
            )).unwrap();
            let exe = self.0.join("app").join("Codex.exe");
            fs::write(&exe, b"isolated test marker, never executed").unwrap();
            exe
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(self.0.starts_with(env::temp_dir()));
            assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("yisama-bootstrap-test-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn pinned_release_is_architecture_and_hash_specific() {
        let pinned = release();
        assert_eq!(pinned.architecture, "x64");
        assert!(pinned.package_moniker.contains(&pinned.package_version));
        assert_eq!(pinned.sha256.len(), 64);
        assert!(pinned.sha256.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(pinned.release_url.ends_with(&format!("{}.Msix", pinned.package_moniker)));
    }

    #[test]
    fn mirror_is_a_fixed_version_file_not_a_moving_latest_alias() {
        let pinned = release();
        assert!(pinned.mirror_url.starts_with("https://api-cn.yisama.asia/"));
        assert!(!pinned.mirror_url.contains("/latest/"));
        assert!(pinned.mirror_url.ends_with(&format!(
            "/{}/{}.Msix", pinned.package_version, pinned.package_moniker
        )));
    }

    #[test]
    fn arguments_reject_duplicates_and_missing_values() {
        for raw in [
            vec!["--report"],
            vec!["--report", "--json"],
            vec!["--json", "--json"],
            vec!["--selected", "a", "--selected", "b"],
            vec!["--url", "https://example.test"],
        ] {
            assert!(arguments(&raw.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }

    #[test]
    fn ini_values_cannot_inject_report_sections() {
        assert_eq!(ini_value("x\r\nstatus=found\0"), "x  status=found ");
    }

    #[test]
    fn existing_installations_do_not_offer_an_automatic_upgrade() {
        let found = Desktop {
            root: PathBuf::from("C:/Codex"),
            executable: PathBuf::from("C:/Codex/app/Codex.exe"),
            version: "99.1.1".into(),
            source: "portable".into(),
            running: true,
        };
        let report = desktop_report(Some(&found));
        assert_eq!(report["status"], "found");
        assert_eq!(report["running"], "1");
        assert_eq!(report["tested"], "0");
        assert!(!report.contains_key("package"));
    }

    #[test]
    fn custom_portable_roots_and_their_actual_executables_are_recognized() {
        let fixture = Fixture::new("portable");
        let exe = fixture.codex("OpenAI.Codex");
        for selected in [&fixture.0, &exe, &fixture.0.join("app")] {
            let found = select(selected).unwrap();
            assert!(same_path(&found.executable, &exe));
            assert_eq!(found.source, "portable");
        }
    }

    #[test]
    fn renamed_executables_and_foreign_manifests_are_not_codex_identity() {
        let fixture = Fixture::new("foreign");
        let exe = fixture.codex("OpenAI.ChatGPT");
        assert!(select(&exe).is_err());
        assert!(select(Path::new("relative/Codex.exe")).is_err());
        let cli = fixture.0.join("codex-cli.exe");
        fs::write(&cli, b"not a desktop app").unwrap();
        assert!(select(&cli).is_err());
    }

    #[test]
    fn a_stale_explicit_location_cannot_silently_switch_to_another_installation() {
        let fixture = Fixture::new("stale");
        let file = fixture.0.join("selection.json");
        fs::write(&file, serde_json::to_vec(&Location {
            format: 1, source: "portable".into(), root: fixture.0.join("missing"),
        }).unwrap()).unwrap();
        let before = fs::read(&file).unwrap();
        assert!(detect(Some(&file), None).is_err());
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn reports_preserve_unicode_paths_and_corrupt_packages_fail_before_installation() {
        let fixture = Fixture::new("report");
        let report = fixture.0.join("report.ini");
        write_report(&report, &BTreeMap::from([
            ("status".into(), "found".into()),
            ("root".into(), "C:\\\u{5de5}\u{4f5c}\\Codex".into()),
        ])).unwrap();
        let bytes = fs::read(&report).unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        let words: Vec<u16> = bytes[2..].chunks_exact(2)
            .map(|word| u16::from_le_bytes([word[0], word[1]])).collect();
        assert!(String::from_utf16(&words).unwrap().contains("C:\\\u{5de5}\u{4f5c}\\Codex"));
        let package = fixture.0.join("untrusted.msix");
        fs::write(&package, b"not an MSIX").unwrap();
        assert!(verify_package(&package, &release()).unwrap_err().to_string().contains("size"));
    }
}

