# Remote Hindsight deployment

A split deployment keeps the session importer on the workstation and runs Hindsight with PostgreSQL on an always-on Linux host.

```text
workstation                         service host
session files                       Hindsight
importer       -- SSH tunnel -->    PostgreSQL
Pi extension                        extraction provider
```

This keeps source histories local. The service host can continue extraction and consolidation after the workstation disconnects, but it cannot discover session changes that the workstation has not submitted.

## Service host

Use Docker or Podman Compose with persistent local SSD storage. The default Compose ports bind to loopback. Keep this default when an SSH tunnel provides access.

For a small remote-provider deployment, start with four CPU cores, 8 GB RAM, and 50 GB of SSD storage. A local LLM needs separate model-specific resources.

Install from a permanent checkout and configure the provider on the service host. Keep provider credentials and Compose overrides outside Git.

## TLS reverse proxy

A reverse proxy is the usual choice on a trusted private network. Bind the Compose ports to the service host's LAN address:

```bash
PI_HINDSIGHT_BIND_ADDRESS=192.0.2.10 scripts/prepare-deployment.sh
```

Replace the example address with the service host address. Use separate HTTPS names for the API and UI, and forward them to ports 8888 and 9999. Keep Hindsight bearer authentication enabled on the API. The UI access key is optional on a trusted network.

The API proxy must preserve the `Authorization` header and accept canonical request bodies:

```nginx
client_max_body_size 128m;
proxy_connect_timeout 60s;
proxy_read_timeout 900s;
proxy_send_timeout 900s;
proxy_buffering off;
```

Set `hindsight.apiUrl` and `hindsight.uiUrl` to the two HTTPS URLs. Install the importer with no local stack dependency:

```bash
PI_HINDSIGHT_IMPORTER_DEPENDENCY='' scripts/install-importer-service.sh --start
```

API authentication protects access but does not encrypt plain HTTP. Use TLS when traffic leaves the host.

## SSH tunnel

Use a dedicated SSH key and verify the service-host key. The following Linux user service forwards the standard local endpoints while keeping the service host private:

```ini
[Unit]
Description=SSH tunnel to Pi Hindsight
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:8888:127.0.0.1:8888 -L 127.0.0.1:9999:127.0.0.1:9999 hindsight-host
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Replace `hindsight-host` with a host from `~/.ssh/config`. Install the unit as `~/.config/systemd/user/pi-hindsight-tunnel.service`, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-hindsight-tunnel.service
```

The existing `hindsight.apiUrl` and `hindsight.uiUrl` can remain on ports 8888 and 9999. Existing Pi processes then use the remote service without changing their configured endpoint.

Install the importer with the tunnel as its service dependency:

```bash
PI_HINDSIGHT_IMPORTER_DEPENDENCY=pi-hindsight-tunnel.service \
  scripts/install-importer-service.sh --start
```

## Migration

1. Stop the workstation importer.
2. Wait for retain and consolidation work to finish.
3. Create and verify a logical PostgreSQL backup and an importer-state backup.
4. Restore PostgreSQL on the service host with the same Hindsight version and embedding dimensions.
5. Start Hindsight and verify health, provider access, document counts, recall, and bank configuration.
6. Stop the local Hindsight stack.
7. Start the SSH tunnel on the same local ports.
8. Start the workstation importer and let it submit changes made during migration.
9. Verify another retain, consolidation, known recall, and unanswerable-query abstention.
10. Keep the stopped local volumes until the remote service is proven stable.

Do not copy the importer state to the service host when the importer continues to run on the workstation.

## Backups

The workstation state database and remote PostgreSQL database form one recovery set. `scripts/backup.sh` can stream `pg_dump` over SSH while it backs up local SQLite state:

```bash
PI_HINDSIGHT_SSH_HOST=hindsight-host scripts/backup.sh
```

The SSH account must be able to run Docker without an interactive password. Set `PI_HINDSIGHT_REMOTE_ENGINE=podman` when the service host uses Podman. `PI_HINDSIGHT_DB_USER` and `PI_HINDSIGHT_DB_NAME` override the PostgreSQL defaults.

Also keep logical PostgreSQL backups on the service host, so consolidation data remains protected while the workstation is off. Keep a copy outside the service host or use verified host-level backups.

## Security

- Do not expose the plain HTTP API or UI to an untrusted network.
- Prefer an SSH tunnel, private VPN, or authenticated TLS reverse proxy.
- Use a dedicated, revocable SSH key.
- Keep Hindsight bearer tokens and provider credentials mode `0600`.
- Keep PostgreSQL on the internal container network.
- Verify the SSH host fingerprint before first use.
