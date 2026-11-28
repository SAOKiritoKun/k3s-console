# k3s Console

A local web console for installing, inspecting and operating k3s / Kubernetes clusters over SSH. Target nodes are
reached through SSH only: the console runs `k3s`, `kubectl`, `ctr`, `crictl` and `systemctl` on them, so nothing has
to be installed on the nodes themselves.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![k3s](https://img.shields.io/badge/k3s-v1.34%20%2F%20v1.35-ffc61c?logo=k3s&logoColor=black)](https://k3s.io)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)
![Build](https://img.shields.io/badge/build-none-brightgreen)

English · [简体中文](README_zh.md)

> The UI is in Simplified Chinese.

## Features

| Area | Contents |
| --- | --- |
| Server inventory | Groups with drag-and-drop regrouping, SSH / local / kubeconfig transports, status that separates *wrong password* from *offline*, SSH terminal window with a built-in SFTP browser |
| Cluster lifecycle | Install single-node or 3/5-node embedded-etcd HA, online or offline, with preflight checks and a post-install network self-check; per-node upgrade; single or batch uninstall behind a typed confirmation |
| Cluster view | Node / Pod / Deployment / Service counters, events, resource usage, node cordon / drain |
| Workloads | 20 resource kinds, a detail drawer (overview, YAML, logs, terminal, events, describe), apply YAML with server-side dry run, scale, rollout restart, delete, form-based resource creation |
| Images | Browse node images, pull base images, export a node image to a one-shot `.tar` download, import a `.tar` into one or many nodes (uploaded once, then distributed) |
| Local templates | YAML files under `data/deployment-templates/`, created from a form or imported, applied to one or many servers |
| Records | Every async job (install, uninstall, upgrade, import, export) is stored with its steps and full log, streamed live, and can be cancelled |
| UI | Light / dark theme, mobile layout, all assets served locally, `?demo=1` preview that needs no cluster |

## Requirements

| Item | Requirement |
| --- | --- |
| Console host | Node.js 18+ (Windows, Linux or macOS) |
| Target nodes | Linux, `amd64` / `arm64` / `armhf`, reachable over SSH |
| Credentials | `root`, or a user with passwordless sudo on the targets |

## Quick start

```bash
git clone https://github.com/SAOKiritoKun/k3s-console.git
cd k3s-console
```

Start it with the launcher that ships with the project — it checks Node.js, installs the one dependency on first run
and boots the console:

| Platform | Command |
| --- | --- |
| Windows | `start.cmd` |
| Linux / macOS | `chmod +x start.sh && ./start.sh` |

Then open <http://127.0.0.1:8964>.

Prefer to do it by hand? `npm install && npm start` is exactly what the scripts do.

No cluster at hand? Append `?demo=1` — <http://127.0.0.1:8964/?demo=1> renders the whole UI with fake data.

## Basic usage

### Install a cluster

1. **服务器 → 添加服务器**: address, SSH user, password or private key.
2. **部署中心 → k3s 安装/卸载**: pick 1 control plane (single node) or 3 / 5 (HA with embedded etcd), optionally
   add workers, then choose an online or offline install.
3. Preflight runs first (SSH, sudo, systemd, cgroup, memory, disk, ports, swap). The install then runs step by step
   with live logs.
4. A **network self-check** runs after install: every node's `flannel.1`, the routes to each peer's pod CIDR, the
   VTEP entries and cluster DNS. A cluster that reports `Ready` but cannot route pod traffic fails here instead of
   silently passing.
5. **服务器** → open the cluster detail drawer for nodes, events and metrics.

Only servers without Kubernetes are listed. To reinstall an existing node, enable 强制重装 (it reuses the cluster
token; uninstall first for a clean reset).

### Servers

- The group tree on the left: create groups, drag a server onto another group row to move it. Deleting a non-empty
  group also drops the server entries inside it, not the machines.
- Each row's 更多 menu: 远程连接, 编辑, 重新读取服务器信息, 复制, 安装/加入, 卸载 k3s, 删除.
- Status separates 在线 / 密码错误 / 离线 / 未安装; hover or open the detail for the full message.
- 远程连接 opens a separate window with an SSH terminal and an SFTP panel: browse, upload (multi-select, drag and
  drop, per-file overwrite prompt), download, and follow the terminal's working directory.

### Uninstall and upgrade

- **卸载 k3s** on the same deploy page. Select servers of one cluster only, type `uninstall` to confirm. A batch runs
  workers before control planes; 深度清理 also removes k3s data, CNI leftovers and IPVS rules.
- Uninstalling is irreversible: it deletes cluster data, certificates and etcd contents.
- **升级**: 部署中心 → k3s 升级, one node at a time, existing flags are kept. A failed upgrade does not roll back.

### Components and images

- 部署中心 → 组件与镜像: plugins for a k3s host (Ingress NGINX, cert-manager, kube-state-metrics / Metrics Server,
  Kubernetes Dashboard).
- 查看当前k3s内镜像 lists name, tag, ID and size: copy the name, export the image to a one-shot `.tar` download
  (export it again if the download fails), or delete it by ID.
- 导入镜像 imports one tar into the current node; 多台导入 uploads it once and distributes it to several nodes.
- Base images are grouped into tabs (OS, runtime, database, cache, message queue, registry); every card has a version dropdown, a pull button and copyable
  pull commands. Everything is editable on the page and every change is written back to `data/image-management/images.json` (not shipped with the repo — it is created on the first save): the `+` at the end of the tab strip adds a category inline, tabs can be dragged to reorder, the `×` on a tab deletes that category (with a confirmation; if it still has images the dialog says how many and deletes those image entries too), and the `…` in a card's top-right corner offers edit and delete (delete asks for confirmation again). Editing the file directly also works — refresh the browser to apply. An image's `kind` references the category `id` (for example `database`), so renaming a category keeps its images; writing the category name itself (`数据库`) still works. The registry is configured in `data/image-management/images-repository.json`.

### Workloads

- 20 resource kinds on the left; filter by name, switch namespace, refresh, page through results on top.
- A row opens the drawer: overview, YAML, logs, terminal, events, describe.
- Apply or edit YAML (server-side dry run first if you want), scale, rolling restart, delete, cordon / uncordon /
  drain a node, read pod logs by container / tail / previous.
- 新增 builds a manifest for the current kind from a form, previews the YAML, then saves it to
  `data/deployment-templates/` or applies it right away.
- When the selected server is a worker, the cluster data is read through its control plane and the banner says
  which node that is.

### Local manifests

- 部署中心 → Pod 部署 manages the YAML files in `data/deployment-templates/`. Nothing reaches the cluster until you
  press 应用.
- Create from a form or paste YAML, import `.yaml` files, edit in either mode, then apply to one or more servers
  (dry run first when unsure).

### Records and settings

- 操作记录 lists every install, uninstall, upgrade, import and export with its steps and full log. Running jobs can
  be cancelled; right-click deletes one record or all of them.
- 设置 holds the access token and the theme. `config.json` and `data/server.json` are hot-reloaded; only `app.host`
  and `app.port` need a restart.

## Offline install packages

An offline install reads a package from `packages/` — either an extracted directory or a `.tar.gz` archive. The
console uploads the selected package to each target itself; you don't copy anything by hand.

- Both forms are accepted. If a directory and an archive with the same name exist, the directory is used.
- Archives are extracted into the system temp directory on the console host when the deploy starts and removed as
  soon as the upload finishes; nothing is left inside `packages/`.
- One package per CPU architecture (`amd64`, `arm64`, `armhf`). The UI filters by the architecture of each target and
  the server validates it again. `arm`, `armv6l` and `armv7l` are all treated as `armhf`.
- While offline mode is selected the list is rescanned every 10 seconds; 「重新扫描」 refreshes it immediately.

Files inside a package:

| File | Purpose |
| --- | --- |
| `k3s` (or `k3s-<arch>`) | k3s binary |
| `k3s-airgap-images-<arch>.tar` | preloaded images; `.tar.gz` / `.tar.zst` and `k3s-airgap-images.tar` also work, and for `armhf` the official `...-arm.tar.gz` name is accepted |
| `install.sh` | official k3s installer |
| `SHA256SUMS` | strongly recommended — the install runs `sha256sum -c` |
| `manifest.json` | recommended — lets the UI show version and architecture |

`manifest.json` example:

```json
{
  "k3sVersion": "v1.34.1+k3s1",
  "arch": "armhf"
}
```

Directory layout — one directory or archive per version:

```text
packages/
├── k3s-v1.34.1-k3s1-amd64.tar.gz    # x86_64, archive
├── k3s-v1.34.1-k3s1-armhf.tar.gz    # armhf, archive
├── k3s-v1.35.0-k3s1-amd64/          # x86_64, extracted directory
│   ├── k3s
│   ├── k3s-airgap-images-amd64.tar.gz
│   ├── install.sh
│   ├── install-offline.sh
│   ├── SHA256SUMS
│   └── manifest.json
└── k3s-v1.35.0-k3s1-armhf/          # armhf, same structure
```

How a deploy uses it:

1. Put the directory or archive under `packages/` (create the folder first if it does not exist).
2. Open **部署中心 → k3s 安装/卸载** and enable 「离线安装」.
3. Pick the version and architecture in the package dropdown.
4. Select the target servers and deploy. The console uploads the package to `/opt/k3s-offline/<package-name>` on
   every control plane and worker, then runs the install with `INSTALL_K3S_SKIP_DOWNLOAD=true`.

The image tarball is copied to `/var/lib/rancher/k3s/agent/images/` so k3s imports it on start. A `.k3s-ui-ready`
marker is written on the target, so deploying the same package again skips the upload.

> Editing any file inside a package means regenerating `SHA256SUMS`, otherwise the pre-install check fails. Once
> regenerated, the console treats the package as new and uploads it again.

Packages are not part of this repository (`packages/` is gitignored because the archives are hundreds of megabytes).
Build one from the k3s release artifacts: the `k3s` binary, `k3s-airgap-images-<arch>.tar`, and the `install.sh` that
ships with the [k3s release](https://github.com/k3s-io/k3s/releases).

Manual install without the console (optional):

```sh
scp k3s-v1.34.1-k3s1-armhf.tar.gz root@<target>:/var/tmp/
ssh root@<target> 'mkdir -p /opt/k3s-offline \
  && tar -xzf /var/tmp/k3s-v1.34.1-k3s1-armhf.tar.gz -C /opt/k3s-offline --strip-components=1 \
  && cd /opt/k3s-offline && sh ./install-offline.sh'
```

If the package has no `install-offline.sh`, copy the binary and the images tarball to the target, set
`INSTALL_K3S_SKIP_DOWNLOAD=true` and run `install.sh`.

## How it works

```text
Browser (vanilla JS SPA, app/web/js/01-core.js … 11-main.js)
   │  fetch / live stream
   ▼
Node HTTP server (app/server.js + app/server/*.js)
   │  ssh2
   ▼
Target nodes: k3s / kubectl / ctr / crictl / systemctl
```

Long-running actions become **jobs**: the server keeps the step list and the log, the browser follows them live, and
the record is written to `logs/operations/` so it survives a restart.

## Project layout

```text
k3s-console/
├── app/
│   ├── index.html          # single-page shell
│   ├── web/
│   │   ├── app.css         # all styles
│   │   ├── vendor/         # js-yaml, xterm.js (bundled locally)
│   │   └── js/             # 01-core … 11-main, loaded in order, no bundler
│   ├── server.js           # HTTP server and API routes
│   └── server/             # config, servers, transport (SSH), kube, deploy, jobs, terminal…
├── packages/               # offline k3s packages (not in git)
├── data/                   # runtime data: server.json, templates (not in git)
├── logs/                   # job records and temp files (not in git)
├── config.json
├── start.cmd / start.sh
└── package.json
```

## Configuration

`config.json` is hot-reloaded on change; `app.host` and `app.port` only apply after a restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `app.title` | `k3s console` | Console title (browser tab and top bar) |
| `app.host` | `127.0.0.1` | Bind address — keep it on loopback unless `accessToken` is set |
| `app.port` | `8964` | HTTP port |
| `app.accessToken` | `""` | When set, the page asks for it and every request must carry it |
| `app.autoDetect` | `true` | Detect servers on startup |
| `app.commandTimeoutMs` | `60000` | Default SSH command timeout |
| `app.kubectlTimeoutSeconds` | `25` | Default kubectl timeout |
| `ssh.defaultUser` / `ssh.defaultPort` | `root` / `22` | Defaults for new servers |
| `ssh.hostKeyPolicy` | `accept-new` | `accept-new` or `strict` |
| `ssh.privateKeyPath` / `ssh.knownHostsPath` | `""` | Global key / known_hosts override |
| `ssh.useSudo` | `true` | Use sudo for privileged commands |
| `k3s.mirror` / `k3s.mirrorUrl` | `cn` / `rancher-mirror` | Mirror used by online installs |
| `k3s.offlineDir` | `/opt/k3s-offline` | Where packages are unpacked on the target |
| `k3s.clusterToken` | `""` | Fixed cluster token (random when empty) |

## Data

| Path | Contents |
| --- | --- |
| `data/server.json` | Server list with credentials — **plaintext, gitignored** |
| `data/deployment-templates/*.yaml` | Local manifests, one YAML per file |
| `data/image-management/images-repository.json` | Registry settings (default `docker.io`) |
| `data/image-management/images.json` | Image catalogue: categories and image entries, created and updated when you edit on the page; not shipped with the repo |
| `logs/operations/*.json` | Job records: steps, logs, result |
| `packages/` | Offline k3s packages as `*.tar.gz` or extracted directories |

A backup of the console is `config.json` + `data/`.

`data/` and `logs/` are created on first start, together with `data/server.json`, `data/image-management/images-repository.json`
and `data/deployment-templates/` — a fresh clone needs no manual setup. `data/image-management/images.json` is not in the repo and is not generated at startup;
it only appears once you edit images or categories on the page (and is recreated by the next edit if deleted), so a fresh install opens the images page empty. `logs/tmp/` only appears when an image export
starts, and `packages/` is never created for you: create it yourself when you add offline bundles.

## Security

- It listens on `127.0.0.1` by default. If you bind `0.0.0.0`, set `app.accessToken` first — anyone who can open
  the page can SSH into your nodes.
- `data/server.json` stores SSH passwords and keys in plaintext, and `config.json` may hold tokens. Neither file is
  served over HTTP. Keep both out of version control.
- Secrets are masked in the UI; saving a masked field keeps the stored value.
- Uninstall is destructive: it runs the k3s uninstall script, removes `/etc/rancher/k3s`, `/var/lib/rancher/k3s`,
  CNI leftovers and IPVS rules, and requires typing `uninstall` to confirm.
- There is no multi-user model. Treat it as a single-operator console.

## Limitations

- One-click install and uninstall only cover **k3s**. A kubeadm or external Kubernetes cluster can be viewed
  through `kubeconfig`, but not managed by the install flow.
- Local transport (the console host is also the node) only works on **Linux**. On macOS and Windows the console is a
  control host only: use SSH or `kubeconfig`.
- HA means 3 or 5 control planes with embedded etcd; no external datastore.
- CNI is flannel (the k3s default). Cilium or Calico must be installed manually.
- Upgrade does not roll back when it fails.
- Terminal sessions live in memory: released after 30 minutes idle, about one minute after a broken connection.

## License

[MIT](LICENSE) © 2026 dongyan
