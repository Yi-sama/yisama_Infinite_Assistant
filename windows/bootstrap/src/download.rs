use super::{ini_value, verify_package, Release, Result};
use codex_win_engine as engine;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

fn partial_path(file: &Path) -> PathBuf {
    file.with_extension("msix.part")
}

fn file_size(file: &Path) -> u64 {
    fs::metadata(file).map(|metadata| metadata.len()).unwrap_or(0)
}

fn verifying(report: &Path) -> Result<()> {
    fs::write(report.with_extension("ini.verifying"), [])?;
    Ok(())
}

fn curl_command(url: &str, part: &Path, size: u64) -> Command {
    let curl = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32/curl.exe"))
        .unwrap_or_else(|| PathBuf::from("curl"));
    let mut command = Command::new(curl);
    // Ignore per-user curl options and proxy variables; keep TLS checks enabled.
    command.args([
        "--disable", "--noproxy", "*", "--fail", "--location", "--silent", "--show-error",
        "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "20", "--max-time", "7200",
        "--speed-limit", "1", "--speed-time", "120",
        "--max-filesize", &size.to_string(), "--continue-at", "-",
        "--write-out", "%{http_code}", "--output",
    ]).arg(part).arg(url);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

// Kept separate so a local HTTP fixture can verify interruption and Range
// behavior without adding a test URL or a test-only command to the product.
fn transfer(mut command: Command, part: &Path, cancel: &Path, size: u64) -> Result<bool> {
    if cancel.exists() { return Ok(false); }
    let resumed_from = file_size(part);
    let mut child = command.spawn()?;
    let result = (|| -> Result<bool> {
        loop {
            if cancel.exists() {
                child.kill()?;
                child.wait()?;
                return Ok(false);
            }
            if let Some(status) = child.try_wait()? {
                let mut errors = String::new();
                child.stderr.take().unwrap().take(16 * 1024).read_to_string(&mut errors)?;
                let mut response = String::new();
                child.stdout.take().unwrap().take(32).read_to_string(&mut response)?;
                if !status.success() {
                    return Err(format!(
                        "下载中断（curl {}）。已下载的部分会保留，重新运行安装程序会接着下载。{}",
                        status.code().unwrap_or(-1), ini_value(errors.trim())
                    ).into());
                }
                if response.trim() != "200" && response.trim() != "206" {
                    return Err(format!("下载服务器返回了异常结果：{}。请稍后重试。", response.trim()).into());
                }
                if resumed_from > 0 && response.trim() != "206" {
                    return Err("下载服务器不支持续传，已下载的部分已保留。请稍后重试。".into());
                }
                if file_size(part) != size {
                    return Err("下载没有完成，已下载的部分会保留，下次接着下载。".into());
                }
                return Ok(true);
            }
            thread::sleep(Duration::from_millis(200));
        }
    })();
    // An observation/disk error must not leave an unobserved download behind.
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

// Every URL serves the same pinned file, so a fallback resumes the same partial data.
fn transfer_first(
    urls: &[&str], command: impl Fn(&str) -> Command, part: &Path, cancel: &Path, size: u64,
) -> Result<bool> {
    let mut errors = Vec::new();
    for url in urls.iter().filter(|url| !url.is_empty()) {
        match transfer(command(url), part, cancel, size) {
            Err(error) => errors.push(error.to_string()),
            result => return result,
        }
    }
    Err(errors.join(" / ").into())
}

fn intact(file: &Path, pinned: &Release) -> Result<bool> {
    Ok(file_size(file) == pinned.size
        && engine::sha256_file(file)?.eq_ignore_ascii_case(&pinned.sha256))
}

pub(super) fn download(
    file: &Path, report: &Path, cancel: &Path, pinned: &Release,
) -> Result<BTreeMap<String, String>> {
    if !file.is_absolute() || file.extension().and_then(|value| value.to_str()) != Some("msix") {
        return Err("The download cache must be an absolute MSIX path.".into());
    }
    fs::create_dir_all(file.parent().ok_or("Missing download directory.")?)?;
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(file.with_extension("msix.lock"))?;
    lock.try_lock().map_err(|_| "另一个安装程序正在下载 Codex。请先关掉它再继续。")?;
    let part = partial_path(file);
    let resumed_from = file_size(&part);
    if file.exists() { verifying(report)?; }
    if file.exists() && !intact(file, pinned)? {
        fs::remove_file(file)?;
        return Err("之前下载的安装包已损坏并已删除。请重新运行安装程序下载。".into());
    }
    if !file.exists() {
        if file_size(&part) > pinned.size {
            fs::remove_file(&part)?;
            return Err("未下载完的安装包无效，已删除。请重新运行安装程序下载。".into());
        }
        if file_size(&part) != pinned.size {
            let urls = [pinned.mirror_url.as_str(), pinned.release_url.as_str()];
            if !transfer_first(&urls, |url| curl_command(url, &part, pinned.size), &part, cancel, pinned.size)? {
                return Ok(BTreeMap::from([
                    ("status".into(), "paused".into()),
                    ("downloaded".into(), file_size(&part).to_string()),
                    ("size".into(), pinned.size.to_string()),
                ]));
            }
        }
        verifying(report)?;
        if !intact(&part, pinned)? {
            fs::remove_file(&part)?;
            return Err("Codex 安装包校验失败，损坏的文件已删除，没有安装任何内容。请重新运行安装程序。".into());
        }
        fs::rename(&part, file)?;
    }
    verifying(report)?;
    verify_package(file, pinned)?;
    Ok(BTreeMap::from([
        ("status".into(), "ready".into()),
        ("file".into(), file.display().to_string()),
        ("downloaded".into(), pinned.size.to_string()),
        ("size".into(), pinned.size.to_string()),
        ("resumedFrom".into(), resumed_from.to_string()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader, Write}, net::TcpListener};

    #[test]
    fn interrupted_download_is_preserved_then_resumed_with_a_range_request() {
        let fixture = super::super::tests::Fixture::new("resume");
        let part = fixture.0.join("Codex.msix.part");
        let cancel = fixture.0.join("cancel");
        let data: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
        let first = 64 * 1024;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected = data.clone();
        let server = thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    request.push_str(&line);
                }
                if attempt == 0 {
                    assert!(!request.to_ascii_lowercase().contains("range:"));
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", expected.len()).unwrap();
                    stream.write_all(&expected[..first]).unwrap();
                } else {
                    assert!(request.to_ascii_lowercase().contains(&format!("range: bytes={first}-")));
                    write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                        expected.len() - first, first, expected.len() - 1, expected.len()).unwrap();
                    stream.write_all(&expected[first..]).unwrap();
                }
            }
        });
        let run = || {
            let mut command = curl_command(&format!("http://{address}/Codex.msix"), &part, data.len() as u64);
            command.args(["--proto", "=http"]);
            transfer(command, &part, &cancel, data.len() as u64)
        };
        assert!(run().unwrap_err().to_string().contains("保留"));
        assert_eq!(fs::read(&part).unwrap(), data[..first]);
        assert!(run().unwrap());
        assert_eq!(fs::read(&part).unwrap(), data);
        server.join().unwrap();
    }

    #[test]
    fn an_unreachable_mirror_falls_back_and_resumes_the_same_partial_file() {
        let fixture = super::super::tests::Fixture::new("fallback");
        let part = fixture.0.join("Codex.msix.part");
        let cancel = fixture.0.join("cancel");
        let data: Vec<u8> = (0..128 * 1024).map(|index| (index % 249) as u8).collect();
        let first = 32 * 1024;
        fs::write(&part, &data[..first]).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected = data.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                request.push_str(&line);
            }
            assert!(request.to_ascii_lowercase().contains(&format!("range: bytes={first}-")));
            write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                expected.len() - first, first, expected.len() - 1, expected.len()).unwrap();
            stream.write_all(&expected[first..]).unwrap();
        });
        let release = format!("http://{address}/Codex.msix");
        let urls = ["http://127.0.0.1:1/Codex.msix", release.as_str()];
        let command = |url: &str| {
            let mut command = curl_command(url, &part, data.len() as u64);
            command.args(["--proto", "=http"]);
            command
        };
        assert!(transfer_first(&urls, command, &part, &cancel, data.len() as u64).unwrap());
        assert_eq!(fs::read(&part).unwrap(), data);
        server.join().unwrap();
    }

    #[test]
    fn curl_keeps_strict_tls_direct_access_and_never_discards_on_network_failure() {
        let command = curl_command("https://example.test/file", Path::new("Codex.msix.part"), 100);
        let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy()).collect();
        assert_eq!(args[0], "--disable");
        assert!(args.windows(2).any(|pair| pair == ["--continue-at", "-"]));
        assert!(args.windows(2).any(|pair| pair == ["--noproxy", "*"]));
        assert!(args.windows(2).any(|pair| pair == ["--proto", "=https"]));
        assert!(!args.iter().any(|arg| ["--insecure", "--ssl-no-revoke", "--retry"].contains(&arg.as_ref())));
    }

    #[test]
    fn pausing_a_transfer_keeps_the_partial_file() {
        let fixture = super::super::tests::Fixture::new("pause");
        let part = fixture.0.join("Codex.msix.part");
        let cancel = fixture.0.join("cancel");
        fs::write(&part, b"keep existing partial data").unwrap();
        fs::write(&cancel, b"pause").unwrap();
        let command = curl_command("https://127.0.0.1:1/file", &part, 100);
        assert!(!transfer(command, &part, &cancel, 100).unwrap());
        assert_eq!(fs::read(&part).unwrap(), b"keep existing partial data");
    }
}
