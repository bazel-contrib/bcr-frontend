use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use tokio::{
    fs,
    signal::unix::{SignalKind, signal},
    sync::watch,
    time::{self, MissedTickBehavior},
};
use uuid::Uuid;
use worker_protocol::{
    reapi::{Platform, platform::Property},
    worker::{
        AcknowledgeLeaseRequest, AcknowledgeLeaseResponse, CompleteLeaseRequest,
        CompleteLeaseResponse, HeartbeatRequest, HeartbeatResponse, LeaseOffer, LeaseWorkRequest,
        LeaseWorkResponse, RegisterWorkerRequest, RegisterWorkerResponse,
        lease_directive::Directive,
    },
};

mod api;
mod execute;
use api::Scheduler;
use remote_execution_tunnel as tunnel;

#[derive(Parser)]
#[command(about = "Run Bazel Remote Execution actions in a Linux sandbox")]
struct Options {
    /// HTTPS scheduler origin, or an HTTP origin on loopback.
    #[arg(
        long,
        required_unless_present = "ticket_file",
        requires = "token_file",
        conflicts_with = "ticket_file"
    )]
    scheduler: Option<String>,
    /// Iroh ticket file issued by the execution gateway.
    #[arg(long, conflicts_with_all = ["scheduler", "token_file"])]
    ticket_file: Option<PathBuf>,
    /// Worker ID for a preconfigured worker.
    #[arg(long)]
    worker_id: Option<String>,
    /// Persistent, private Iroh key file for a worker using a pool ticket.
    #[arg(long, requires = "ticket_file", conflicts_with = "worker_id")]
    identity_file: Option<PathBuf>,
    #[arg(long)]
    token_file: Option<PathBuf>,
    #[arg(long)]
    name: Option<String>,
    /// Worker platform property, such as OSFamily=Linux. Repeat as needed.
    #[arg(long = "property")]
    properties: Vec<String>,
    /// Path to the bubblewrap executable.
    #[arg(long, default_value = "/usr/bin/bwrap")]
    runner: PathBuf,
}

fn properties(values: &[String]) -> Result<Platform> {
    let mut all = BTreeMap::from([
        ("OSFamily".into(), "Linux".into()),
        ("Arch".into(), std::env::consts::ARCH.into()),
    ]);
    for value in values {
        let (name, value) = value
            .split_once('=')
            .context("expected a property of the form NAME=VALUE")?;
        ensure!(
            !name.is_empty() && !value.is_empty(),
            "invalid empty platform property"
        );
        all.insert(name.to_owned(), value.to_owned());
    }
    Ok(Platform {
        properties: all
            .into_iter()
            .map(|(name, value)| Property { name, value })
            .collect(),
    })
}

async fn heartbeat(
    scheduler: &Scheduler,
    id: &str,
    active: Option<&LeaseOffer>,
    draining: bool,
) -> Result<bool> {
    let response: HeartbeatResponse = scheduler
        .rpc(
            "heartbeat",
            &HeartbeatRequest {
                session_id: id.to_owned(),
                active_lease_ids: active
                    .into_iter()
                    .map(|offer| offer.lease_id.clone())
                    .collect(),
                draining,
            },
        )
        .await?;
    Ok(response
        .leases
        .iter()
        .any(|item| matches!(item.directive, Some(Directive::Revoke(_)))))
}

async fn session(
    scheduler: &Scheduler,
    options: &Options,
    worker_id: &str,
    platform: &Platform,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<()> {
    let registered: RegisterWorkerResponse = scheduler
        .rpc(
            "register",
            &RegisterWorkerRequest {
                worker_id: worker_id.to_owned(),
                registration_id: Uuid::new_v4().to_string(),
                display_name: options.name.clone().unwrap_or_else(|| worker_id.to_owned()),
                version: "0.1.0".into(),
                platform: Some(platform.clone()),
                slots: 1,
            },
        )
        .await?;
    let interval = registered
        .heartbeat_interval
        .and_then(|value| Duration::try_from(value).ok())
        .filter(|value| !value.is_zero())
        .context("invalid scheduler heartbeat interval")?;
    let mut tick = time::interval(interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let id = registered.session_id;
    eprintln!(
        "Registered worker {} in pool {}",
        worker_id, registered.pool_id
    );
    loop {
        if *shutdown.borrow() {
            heartbeat(scheduler, &id, None, true).await?;
            return Ok(());
        }
        let request = LeaseWorkRequest {
            session_id: id.clone(),
            request_id: Uuid::new_v4().to_string(),
        };
        let incoming = scheduler.rpc::<_, LeaseWorkResponse>("lease", &request);
        tokio::pin!(incoming);
        let offer = loop {
            tokio::select! {
                _ = shutdown.changed() => break None,
                _ = tick.tick() => { heartbeat(scheduler, &id, None, false).await?; }
                result = &mut incoming => break result?.offer,
            }
        };
        let Some(offer) = offer else { continue };
        let _: AcknowledgeLeaseResponse = scheduler
            .rpc(
                "acknowledge",
                &AcknowledgeLeaseRequest {
                    session_id: id.clone(),
                    lease_id: offer.lease_id.clone(),
                },
            )
            .await?;
        let blobs = scheduler.blobs(&id, &offer);
        let task = execute::execute(&blobs, &offer, &options.runner, worker_id);
        tokio::pin!(task);
        let mut draining = *shutdown.borrow();
        let outcome = loop {
            tokio::select! {
                _ = shutdown.changed(), if !draining => {
                    draining = true;
                    if heartbeat(scheduler, &id, Some(&offer), true).await? {break None}
                }
                _ = tick.tick() => {
                    if heartbeat(scheduler, &id, Some(&offer), draining).await? {break None}
                }
                outcome = &mut task => break Some(outcome),
            }
        };
        if let Some(outcome) = outcome {
            let _: CompleteLeaseResponse = scheduler
                .rpc(
                    "complete",
                    &CompleteLeaseRequest {
                        session_id: id.clone(),
                        lease_id: offer.lease_id.clone(),
                        outcome: Some(outcome),
                    },
                )
                .await?;
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = Options::parse();
    let platform = properties(&options.properties)?;
    let (origin, token, worker_id) = if let Some(ticket) = &options.ticket_file {
        let ticket = tunnel::Ticket::decode(
            &fs::read_to_string(ticket)
                .await
                .context("read Iroh worker ticket")?,
        )?;
        let (key, worker_id) = if ticket.pool.is_some() {
            let path = options
                .identity_file
                .as_ref()
                .context("pool tickets require --identity-file")?;
            let key = tunnel::identity(path)?;
            let worker_id = format!("iroh-{}", key.public());
            (Some(key), worker_id)
        } else {
            ensure!(
                options.identity_file.is_none(),
                "--identity-file requires a pool ticket"
            );
            (
                None,
                options
                    .worker_id
                    .clone()
                    .context("preconfigured workers require --worker-id")?,
            )
        };
        let (origin, token) = tunnel::client(ticket, key).await?;
        (origin, token, worker_id)
    } else {
        let file = options
            .token_file
            .as_ref()
            .context("HTTP worker token file missing")?;
        (
            options.scheduler.clone().context("scheduler URL missing")?,
            fs::read_to_string(file)
                .await
                .context("read worker token file")?
                .trim()
                .to_owned(),
            options
                .worker_id
                .clone()
                .context("preconfigured workers require --worker-id")?,
        )
    };
    let scheduler = Scheduler::http(&origin, token)?;
    ensure!(
        options.runner.is_absolute() && options.runner.is_file(),
        "the worker requires an absolute path to a bubblewrap executable"
    );
    let (stopping, mut shutdown) = watch::channel(false);
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::spawn(async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
        let _ = stopping.send(true);
    });
    while !*shutdown.borrow() {
        if let Err(error) =
            session(&scheduler, &options, &worker_id, &platform, &mut shutdown).await
        {
            eprintln!("Worker session ended: {error:#}");
            tokio::select! {
                _ = time::sleep(Duration::from_secs(2)) => {}
                _ = shutdown.changed() => {}
            }
        }
    }
    Ok(())
}
