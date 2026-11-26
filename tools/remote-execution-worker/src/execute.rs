use std::{
    collections::HashSet,
    future::Future,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::{ExitStatus, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use prost::Message;
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt},
    process::Command as Process,
};
use worker_protocol::{
    google::rpc::Status,
    reapi,
    worker::{
        LeaseOffer, WorkerExecutionResult, WorkerFailure, WorkerFailureKind,
        complete_lease_request::Outcome,
    },
};

use crate::api::{Blobs, digest_bytes};

const MAX_DEPTH: usize = 128;
const MAX_LOG_BYTES: usize = 1 << 20;

type Task<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

fn checked_path(value: &str, allow_empty: bool) -> Result<&Path> {
    let path = Path::new(value);
    ensure!(allow_empty || !value.is_empty(), "empty path");
    ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "unsafe path"
    );
    Ok(path)
}

fn node_name(value: &str) -> Result<&Path> {
    ensure!(!value.contains('/'), "invalid directory entry name");
    checked_path(value, false)
}

fn symlink_target(relative: &Path, target: &Path) -> Result<()> {
    let mut depth = relative
        .parent()
        .map(|path| path.components().count())
        .unwrap_or(0);
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                ensure!(depth > 0, "symlink target escapes the action workspace");
                depth -= 1;
            }
            Component::CurDir => {}
            _ => anyhow::bail!("absolute symlink targets are unsupported"),
        }
    }
    Ok(())
}

fn stage<'a>(
    blobs: &'a Blobs<'a>,
    root: &'a Path,
    relative: PathBuf,
    digest: reapi::Digest,
    depth: usize,
) -> Task<'a, ()> {
    Box::pin(async move {
        ensure!(depth <= MAX_DEPTH, "input tree exceeds depth limit");
        let directory: reapi::Directory = blobs.message(&digest).await?;
        let parent = root.join(&relative);
        for file in directory.files {
            let path = parent.join(node_name(&file.name)?);
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await?;
            blobs
                .download(
                    file.digest.as_ref().context("missing file digest")?,
                    &mut output,
                )
                .await?;
            fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode(if file.is_executable { 0o755 } else { 0o644 }),
            )
            .await?;
        }
        for subdirectory in directory.directories {
            let child = relative.join(node_name(&subdirectory.name)?);
            fs::create_dir(root.join(&child)).await?;
            stage(
                blobs,
                root,
                child,
                subdirectory.digest.context("missing directory digest")?,
                depth + 1,
            )
            .await?;
        }
        for link in directory.symlinks {
            let child = relative.join(node_name(&link.name)?);
            let target = Path::new(&link.target);
            symlink_target(&child, target)?;
            fs::symlink(target, root.join(child)).await?;
        }
        Ok(())
    })
}

fn archive_directory<'a>(
    blobs: &'a Blobs<'a>,
    root: &'a Path,
    relative: PathBuf,
    depth: usize,
    children: &'a mut Vec<reapi::Directory>,
    known: &'a mut HashSet<String>,
) -> Task<'a, reapi::Directory> {
    Box::pin(async move {
        ensure!(depth <= MAX_DEPTH, "output tree exceeds depth limit");
        let mut directory = reapi::Directory::default();
        let mut reader = fs::read_dir(root.join(&relative)).await?;
        let mut entries = Vec::new();
        while let Some(entry) = reader.next_entry().await? {
            entries.push(entry);
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("output filename is not UTF-8"))?;
            let kind = entry.file_type().await?;
            if kind.is_file() {
                directory.files.push(reapi::FileNode {
                    name,
                    digest: Some(blobs.upload_file(&entry.path()).await?),
                    is_executable: entry.metadata().await?.permissions().mode() & 0o111 != 0,
                    ..Default::default()
                });
            } else if kind.is_symlink() {
                let target = fs::read_link(entry.path()).await?;
                symlink_target(&relative.join(&name), &target)?;
                directory.symlinks.push(reapi::SymlinkNode {
                    name,
                    target: target
                        .to_str()
                        .context("output symlink target is not UTF-8")?
                        .to_owned(),
                    ..Default::default()
                });
            } else if kind.is_dir() {
                let value = archive_directory(
                    blobs,
                    root,
                    relative.join(&name),
                    depth + 1,
                    children,
                    known,
                )
                .await?;
                let digest = digest_bytes(&value.encode_to_vec());
                if known.insert(digest.hash.clone()) {
                    children.push(value);
                }
                directory.directories.push(reapi::DirectoryNode {
                    name,
                    digest: Some(digest),
                });
            } else {
                anyhow::bail!("unsupported output file type");
            }
        }
        Ok(directory)
    })
}

fn output_paths(command: &reapi::Command) -> Vec<&str> {
    #[allow(deprecated)]
    if command.output_paths.is_empty() {
        command
            .output_files
            .iter()
            .chain(&command.output_directories)
            .map(String::as_str)
            .collect()
    } else {
        command.output_paths.iter().map(String::as_str).collect()
    }
}

async fn prepare_outputs(root: &Path, working: &Path, command: &reapi::Command) -> Result<()> {
    for output in output_paths(command) {
        let relative = checked_path(output, true)?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let mut current = root.join(working);
        for part in parent {
            current.push(part);
            match fs::create_dir(&current).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure!(
                        fs::symlink_metadata(&current).await?.is_dir(),
                        "output parent is not a directory"
                    );
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

async fn collect_outputs(
    blobs: &Blobs<'_>,
    root: &Path,
    working: &Path,
    command: &reapi::Command,
    result: &mut reapi::ActionResult,
) -> Result<()> {
    for name in output_paths(command) {
        let relative = working.join(checked_path(name, true)?);
        let path = root.join(&relative);
        let metadata = match fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        ensure!(
            path == root
                || fs::canonicalize(path.parent().context("missing output parent")?)
                    .await?
                    .starts_with(root),
            "output path escapes the action workspace"
        );
        if metadata.is_file() {
            result.output_files.push(reapi::OutputFile {
                path: name.to_owned(),
                digest: Some(blobs.upload_file(&path).await?),
                is_executable: metadata.permissions().mode() & 0o111 != 0,
                ..Default::default()
            });
        } else if metadata.is_dir() {
            let mut children = Vec::new();
            let directory =
                archive_directory(blobs, root, relative, 0, &mut children, &mut HashSet::new())
                    .await?;
            let tree = reapi::Tree {
                root: Some(directory),
                children,
            };
            result.output_directories.push(reapi::OutputDirectory {
                path: name.to_owned(),
                tree_digest: Some(blobs.upload_bytes(tree.encode_to_vec()).await?),
                ..Default::default()
            });
        } else if metadata.is_symlink() {
            let target = fs::read_link(path).await?;
            symlink_target(&relative, &target)?;
            result.output_symlinks.push(reapi::OutputSymlink {
                path: name.to_owned(),
                target: target
                    .to_str()
                    .context("output symlink target is not UTF-8")?
                    .to_owned(),
                ..Default::default()
            });
        } else {
            anyhow::bail!("unsupported output file type");
        }
    }
    Ok(())
}

async fn capped_log(mut source: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let size = source.read(&mut buffer).await?;
        if size == 0 {
            return Ok(captured);
        }
        let kept = size.min(MAX_LOG_BYTES - captured.len());
        captured.extend_from_slice(&buffer[..kept]);
    }
}

async fn sandbox(
    runner: &Path,
    command: &reapi::Command,
    root: &Path,
    working: &Path,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    ensure!(!command.arguments.is_empty(), "action has no command");
    let mut process = Process::new(runner);
    process
        .env_clear()
        .args(["--unshare-all", "--die-with-parent", "--new-session"])
        .args(["--ro-bind", "/usr", "/usr"])
        .args(["--ro-bind-try", "/bin", "/bin"])
        .args(["--ro-bind-try", "/lib", "/lib"])
        .args(["--ro-bind-try", "/lib64", "/lib64"])
        .args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"])
        .arg("--bind")
        .arg(root)
        .arg("/work")
        .arg("--chdir")
        .arg(Path::new("/work").join(working))
        .args([
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "HOME",
            "/tmp",
        ])
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for variable in &command.environment_variables {
        process
            .arg("--setenv")
            .arg(&variable.name)
            .arg(&variable.value);
    }
    let mut child = process
        .args([
            "--",
            "/usr/bin/prlimit",
            "--core=0",
            "--fsize=4294967296",
            "--as=8589934592",
            "--",
        ])
        .args(&command.arguments)
        .spawn()
        .context("start execution sandbox")?;
    let stdout = child.stdout.take().context("take sandbox stdout")?;
    let stderr = child.stderr.take().context("take sandbox stderr")?;
    let (status, stdout, stderr) =
        tokio::join!(child.wait(), capped_log(stdout), capped_log(stderr));
    let stderr = stderr?;
    ensure!(!stderr.starts_with(b"bwrap: "), "sandbox startup failed");
    Ok((status?, stdout?, stderr))
}

fn failed(kind: WorkerFailureKind, error: anyhow::Error) -> Outcome {
    Outcome::WorkerFailure(WorkerFailure {
        kind: kind as i32,
        diagnostic: format!("{error:#}"),
    })
}

pub async fn execute(
    blobs: &Blobs<'_>,
    offer: &LeaseOffer,
    runner: &Path,
    worker_id: &str,
) -> Outcome {
    let staged: Result<_> = async {
        let action_digest = offer
            .action_digest
            .as_ref()
            .context("lease has no action digest")?;
        let action: reapi::Action = blobs.message(action_digest).await?;
        let command: reapi::Command = blobs
            .message(
                action
                    .command_digest
                    .as_ref()
                    .context("missing command digest")?,
            )
            .await?;
        let tree = action
            .input_root_digest
            .context("missing input tree digest")?;
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path()).await?;
        stage(blobs, &root, PathBuf::new(), tree, 0).await?;
        Ok((temp, root, command))
    }
    .await;
    let (_temp, root, command) = match staged {
        Ok(value) => value,
        Err(error) => return failed(WorkerFailureKind::InputStaging, error),
    };
    let working = match checked_path(&command.working_directory, true) {
        Ok(path) => path,
        Err(error) => return failed(WorkerFailureKind::InputStaging, error),
    };
    if !fs::canonicalize(root.join(working))
        .await
        .is_ok_and(|path| path.starts_with(&root))
    {
        return failed(
            WorkerFailureKind::InputStaging,
            anyhow::anyhow!("invalid working directory"),
        );
    }
    if let Err(error) = prepare_outputs(&root, working, &command).await {
        return failed(WorkerFailureKind::InputStaging, error);
    }
    let timeout = offer
        .execution_timeout
        .as_ref()
        .and_then(|value| Duration::try_from(value.clone()).ok())
        .unwrap_or(Duration::from_secs(600));
    let (status, stdout, stderr) =
        match tokio::time::timeout(timeout, sandbox(runner, &command, &root, working)).await {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return failed(WorkerFailureKind::Runner, error),
            Err(_) => {
                return Outcome::Result(WorkerExecutionResult {
                    action_result: None,
                    execution_status: Some(Status {
                        code: 4,
                        message: "action timed out".into(),
                        ..Default::default()
                    }),
                });
            }
        };
    let upload: Result<_> = async {
        use std::os::unix::process::ExitStatusExt;
        let mut result = reapi::ActionResult {
            exit_code: status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)),
            stdout_digest: Some(blobs.upload_bytes(stdout).await?),
            stderr_digest: Some(blobs.upload_bytes(stderr).await?),
            execution_metadata: Some(reapi::ExecutedActionMetadata {
                worker: worker_id.to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        };
        collect_outputs(blobs, &root, working, &command, &mut result).await?;
        Ok(result)
    }
    .await;
    match upload {
        Ok(result) => Outcome::Result(WorkerExecutionResult {
            action_result: Some(result),
            execution_status: Some(Status::default()),
        }),
        Err(error) => failed(WorkerFailureKind::OutputUpload, error),
    }
}
