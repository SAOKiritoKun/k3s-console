# k3s Console · k3s 集群管家

一个本地运行的 k3s / Kubernetes 部署与运维控制台，通过 SSH 操作目标节点：`k3s`、`kubectl`、`ctr`、`crictl`
和 `systemctl` 都在目标机上执行，节点本身不需要安装任何 Agent。

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![k3s](https://img.shields.io/badge/k3s-v1.34%20%2F%20v1.35-ffc61c?logo=k3s&logoColor=black)](https://k3s.io)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)
![Build](https://img.shields.io/badge/build-none-brightgreen)

[English](README.md) · 简体中文

## 功能

| 模块 | 内容 |
| --- | --- |
| 服务器 | 分组管理并支持拖拽换组；SSH / 本地 / kubeconfig 三种接入；状态区分「密码错误」和「离线」；独立窗口的 SSH 终端，内置 SFTP 文件浏览 |
| 集群生命周期 | 单机或 3 / 5 台嵌入式 etcd 高可用安装，在线或离线；部署前预检 + 安装后网络自检；逐台升级；单台或批量卸载（需手输确认） |
| 集群视图 | 节点 / Pod / Deployment / Service 统计、事件、资源占用、节点 cordon / drain |
| 工作负载 | 20 类资源、详情抽屉（概览 / YAML / 日志 / 终端 / 事件 / describe）、带服务端试运行的 YAML apply、扩缩容、滚动重启、删除、表单化创建资源 |
| 镜像 | 查看节点镜像、拉取基础镜像、把节点镜像导出为一次性 `.tar` 下载、把一个 `.tar` 导入一台或多台节点（只上传一次再分发） |
| 本地配置 | `data/deployment-templates/` 下的 YAML，表单生成或直接导入，可应用到一台或多台服务器 |
| 操作记录 | 每个异步任务（安装、卸载、升级、导入、导出）都保存步骤和完整日志，实时推送进度，可取消 |
| 界面 | 白天 / 黑夜主题、移动端适配、前端资源全部本地内置、`?demo=1` 免集群预览 |

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 控制台所在机器 | Node.js 18+（Windows、Linux 或 macOS） |
| 目标节点 | Linux，`amd64` / `arm64` / `armhf`，SSH 可连通 |
| 凭据 | `root`，或目标机上具备免密 sudo 的普通用户 |

## 快速开始

```bash
git clone https://github.com/SAOKiritoKun/k3s-console.git
cd k3s-console
```

直接用工程自带的启动脚本：它会检查 Node.js、首次运行时装好唯一的依赖，然后拉起控制台。

| 平台 | 命令 |
| --- | --- |
| Windows | `start.cmd` |
| Linux / macOS | `chmod +x start.sh && ./start.sh` |

然后打开 <http://127.0.0.1:8964>。

想手动启动也可以：`npm install && npm start`，脚本做的就是这两步。

手边没有集群？在地址后面加 `?demo=1`：<http://127.0.0.1:8964/?demo=1> 会用假数据渲染整个界面。

## 基本操作

### 安装集群

1. **服务器 → 添加服务器**：填地址、SSH 用户、密码或私钥。
2. **部署中心 → k3s 安装/卸载**：选择 1 台控制平面（单机）或 3 / 5 台（嵌入式 etcd 高可用），按需勾选工作节点，
   再选择在线或离线安装。
3. 先跑预检（SSH、sudo、systemd、cgroup、内存、磁盘、端口、Swap），通过后安装过程分步骤实时输出日志。
4. 安装完成后自动执行**网络自检**：逐台核对 `flannel.1`、到其他节点 pod 网段的路由、VTEP 表项和集群 DNS。
   节点全部 `Ready` 但跨节点 pod 网络不通的集群会在这里失败，而不是被当成部署成功。
5. **服务器** → 打开集群详情推窗，查看节点、事件和资源占用。

列表里只出现没装 Kubernetes 的服务器。要给已装好的机器重装，勾选「强制重装」它才会重新出现（会沿用已有集群
token）；想彻底重来请先卸载。

### 服务器

- 左侧分组树：可以新建分组、把服务器拖到另一个分组行上换组。删除非空分组会连同组内服务器配置一起删掉，
  但不会动服务器本身。
- 每行「更多」菜单：远程连接、编辑、重新读取服务器信息、复制、安装/加入、卸载 k3s、删除。
- 状态区分 在线 / 密码错误 / 离线 / 未安装，悬停或进详情看完整提示。
- 「远程连接」打开独立窗口，左边 SSH 终端，右边 SFTP：浏览、上传（多选、拖拽、同名逐个确认覆盖）、下载，
  并跟随终端当前目录。

### 卸载与升级

- **卸载 k3s** 在同一个部署页面。只能选同一个集群的服务器，输入 `uninstall` 确认；批量时按「工作节点 → 控制平面」
  顺序执行，勾选「深度清理」会额外清理 k3s 数据、CNI 残留和 IPVS 规则。
- 卸载不可逆：集群数据、证书和 etcd 内容都会被删除。
- **升级**：部署中心 → k3s 升级，逐台执行并保留现有启动参数；升级失败不会自动回滚。

### 组件与镜像

- 部署中心 → 组件与镜像：给 k3s 节点装插件（Ingress NGINX、cert-manager、kube-state-metrics / Metrics Server、
  Kubernetes Dashboard）。
- 「查看当前k3s内镜像」列出镜像名、tag、ID 和大小：可以复制名称、导出成一次性 `.tar` 下载（没下载成要重新导出）、
  按 ID 删除。
- 「导入镜像」把 tar 导入当前节点；「多台导入」只上传一次，再分发到多台节点。
- 基础镜像按分类（操作系统、运行环境、数据库、缓存、消息队列、注册中心）分页签展示，每张卡片带版本下拉、拉取按钮和可复制的拉取命令；
  镜像管理页上可以直接编辑，保存都写回 `data/image-management/images.json`（这个文件不随仓库发布，第一次保存时才创建）：
  页签最右边的 `+` 就地新增分类、拖动页签可以调整顺序、页签上的 `×` 删除分类（二次确认；分类下还有镜像时会提示数量，确认后连同这些镜像配置一起删除）；
  卡片右上角的 `…` 里有编辑和删除（删除同样二次确认，确认后只删配置）；
  也可以直接改这个文件，改完刷新浏览器即可生效；镜像的 `kind` 写分类 `id`（如 `database`），改分类名称不影响归属，也兼容直接写分类名（如 `数据库`）；
  仓库配置在 `data/image-management/images-repository.json`。

### 工作负载

- 左侧 20 类资源，顶部可以按名称过滤、切换命名空间、刷新、翻页。
- 点一行打开详情抽屉：概览、YAML、日志、终端、事件、describe。
- 可以应用 / 编辑 YAML（必要时先服务端试运行）、扩缩容、滚动重启、删除、对节点 cordon / uncordon / drain、
  按容器 / tail 行数 / 上一次查看 Pod 日志。
- 「新增」按当前资源类型从表单生成清单，先预览 YAML，再保存到 `data/deployment-templates/` 或直接应用。
- 选中的服务器是工作节点时，集群数据经它连接的控制节点读取，页面会说明是哪一台。

### 本地配置

- 部署中心 → Pod 部署 管理 `data/deployment-templates/` 下的 YAML，不点「应用」不会写进集群。
- 可以用表单生成或直接粘 YAML、导入 `.yaml` 文件、在图形化和 YAML 之间切换编辑，然后应用到一台或多台服务器
  （不确定时先勾试运行）。

### 操作记录与设置

- 操作记录列出每次安装、卸载、升级、导入、导出，含步骤和完整日志；执行中的可以取消，右键可删除单条或全部。
- 设置里有访问令牌和主题。`config.json` 和 `data/server.json` 修改后热加载，只有 `app.host`、`app.port` 需要重启。

## 离线安装包

离线安装从 `packages/` 读取安装包，可以是**解压后的目录**，也可以是 **`.tar.gz` 归档**。选中的包由控制台
自己上传到每台目标机，不需要手工复制文件。

- 两种形式都支持；同名目录和归档同时存在时优先使用目录。
- 归档只在部署开始时解压到控制台所在机器的系统临时目录，上传完成后立即删除，`packages/` 里不会留下解压产物。
- 不同 CPU 架构要分别准备包（`amd64`、`arm64`、`armhf`）。界面按目标机架构过滤，服务端还会再校验一次；
  `arm`、`armv6l`、`armv7l` 统一按 `armhf` 处理。
- 离线模式下列表每 10 秒自动重扫一次，也可以点「重新扫描」立即刷新。

包内必需文件：

| 文件 | 用途 |
| --- | --- |
| `k3s`（或 `k3s-<arch>`） | k3s 二进制 |
| `k3s-airgap-images-<arch>.tar` | 预加载镜像包；`.tar.gz` / `.tar.zst` 和 `k3s-airgap-images.tar` 也认，`armhf` 还兼容官方的 `...-arm.tar.gz` 命名 |
| `install.sh` | k3s 官方安装脚本 |
| `SHA256SUMS` | 强烈建议提供，安装前会执行 `sha256sum -c` |
| `manifest.json` | 建议提供，界面用它显示版本和架构 |

`manifest.json` 示例：

```json
{
  "k3sVersion": "v1.34.1+k3s1",
  "arch": "armhf"
}
```

目录结构 —— 每个版本一个目录或一个同名归档：

```text
packages/
├── k3s-v1.34.1-k3s1-amd64.tar.gz    # x86_64，归档形式
├── k3s-v1.34.1-k3s1-armhf.tar.gz    # armhf，归档形式
├── k3s-v1.35.0-k3s1-amd64/          # x86_64，解压目录
│   ├── k3s
│   ├── k3s-airgap-images-amd64.tar.gz
│   ├── install.sh
│   ├── install-offline.sh
│   ├── SHA256SUMS
│   └── manifest.json
└── k3s-v1.35.0-k3s1-armhf/          # armhf，结构同上
```

部署时控制台做的事：

1. 把目录或归档放到 `packages/` 下（目录不存在就先新建）。
2. 打开 **部署中心 → k3s 安装/卸载**，勾选「离线安装」。
3. 在安装包下拉框里选择版本和架构。
4. 选择目标服务器并部署。控制台会把包上传到每台控制平面 / 工作节点的 `/opt/k3s-offline/<包名>`，
   然后以 `INSTALL_K3S_SKIP_DOWNLOAD=true` 执行安装。

镜像包会被复制到 `/var/lib/rancher/k3s/agent/images/`，k3s 启动时自动导入。上传完成后目标机会写入
`.k3s-ui-ready` 标记，重复部署同一个包时会跳过上传。

> 改动包内任何文件后都要重新生成 `SHA256SUMS`，否则安装前的校验会失败。重新生成后控制台会把它当作新的包，
> 重新上传一次。

离线包不随仓库分发（`packages/` 已加入 `.gitignore`，单个包就有几百 MB）。需要时从
[k3s release](https://github.com/k3s-io/k3s/releases) 取 `k3s` 二进制、`k3s-airgap-images-<arch>.tar` 和
`install.sh` 自行组装。

不用控制台、手工安装（可选）：

```sh
scp k3s-v1.34.1-k3s1-armhf.tar.gz root@<目标机>:/var/tmp/
ssh root@<目标机> 'mkdir -p /opt/k3s-offline \
  && tar -xzf /var/tmp/k3s-v1.34.1-k3s1-armhf.tar.gz -C /opt/k3s-offline --strip-components=1 \
  && cd /opt/k3s-offline && sh ./install-offline.sh'
```

包里没有 `install-offline.sh` 时，把二进制和镜像包放到目标机，设置 `INSTALL_K3S_SKIP_DOWNLOAD=true` 后
执行 `install.sh`。

## 实现方式

```text
浏览器（原生 JS 单页，app/web/js/01-core.js … 11-main.js）
   │  fetch / 实时推送
   ▼
Node HTTP 服务（app/server.js + app/server/*.js）
   │  ssh2
   ▼
目标节点：k3s / kubectl / ctr / crictl / systemctl
```

耗时操作都会变成**任务**：服务端保存步骤和日志，浏览器实时接收进度，记录同时落到 `logs/operations/`，
服务重启后依然能查。

## 目录结构

```text
k3s-console/
├── app/
│   ├── index.html          # 单页外壳
│   ├── web/
│   │   ├── app.css         # 全部样式
│   │   ├── vendor/         # js-yaml、xterm.js（本地内置）
│   │   └── js/             # 01-core … 11-main，按文件名顺序加载，无打包器
│   ├── server.js           # HTTP 服务与 API 路由
│   └── server/             # 配置、服务器、SSH 传输、kubectl、部署、任务、终端等模块
├── packages/               # k3s 离线安装包（不入库）
├── data/                   # 运行数据：server.json、本地配置（不入库）
├── logs/                   # 操作记录与临时文件（不入库）
├── config.json
├── start.cmd / start.sh
└── package.json
```

## 配置

`config.json` 修改后热加载；`app.host` 和 `app.port` 需要重启才生效。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `app.title` | `k3s console` | 控制台标题（浏览器标签和控制台顶部） |
| `app.host` | `127.0.0.1` | 监听地址，未设置访问令牌时请保持在本机回环 |
| `app.port` | `8964` | HTTP 端口 |
| `app.accessToken` | `""` | 设置后页面会要求输入令牌，之后每个请求都要带上它 |
| `app.autoDetect` | `true` | 启动时自动读取服务器信息 |
| `app.commandTimeoutMs` | `60000` | 默认 SSH 命令超时 |
| `app.kubectlTimeoutSeconds` | `25` | 默认 kubectl 超时 |
| `ssh.defaultUser` / `ssh.defaultPort` | `root` / `22` | 新增服务器的默认值 |
| `ssh.hostKeyPolicy` | `accept-new` | `accept-new` 或 `strict` |
| `ssh.privateKeyPath` / `ssh.knownHostsPath` | `""` | 全局私钥 / known_hosts 覆盖 |
| `ssh.useSudo` | `true` | 特权命令使用 sudo |
| `k3s.mirror` / `k3s.mirrorUrl` | `cn` / `rancher-mirror` | 在线安装使用的镜像源 |
| `k3s.offlineDir` | `/opt/k3s-offline` | 离线包在目标机上的解压目录 |
| `k3s.clusterToken` | `""` | 固定集群 token，留空则随机生成 |

## 数据目录

| 路径 | 内容 |
| --- | --- |
| `data/server.json` | 服务器连接信息（含凭据，**明文**，已 gitignore） |
| `data/deployment-templates/*.yaml` | 本地配置，一个文件就是一份 YAML |
| `data/image-management/images-repository.json` | 镜像仓库配置（默认 `docker.io`） |
| `data/image-management/images.json` | 镜像清单：分类与镜像信息，页面编辑时生成并写回，不随仓库发布 |
| `logs/operations/*.json` | 操作记录：步骤、日志、结果 |
| `packages/` | k3s 离线包，`*.tar.gz` 归档或解压后的目录 |

备份这个控制台就是备份 `config.json` + `data/`。

`data/` 和 `logs/` 在第一次启动时自动创建，包括 `data/server.json`、`data/image-management/images-repository.json`、
`data/deployment-templates/`，克隆下来直接启动即可，不用手工建目录。`data/image-management/images.json` 不在仓库里，启动时也不会生成，
只有在页面上编辑过镜像或分类之后才会写回它（文件被删掉时，下次编辑会自动重建），所以新环境刚打开镜像页时是空的。`logs/tmp/` 只在导出镜像时出现；
`packages/` 不会自动创建，放离线包时自己建。

## 安全提示

- 默认只监听 `127.0.0.1`。如果要改成 `0.0.0.0`，请先设置 `app.accessToken` —— 能打开页面的人就能 SSH 进你的节点。
- `data/server.json` 明文保存 SSH 密码和私钥口令，`config.json` 也可能含访问令牌。这两个文件不经 HTTP 对外暴露，
  也不要提交到版本库。
- 密码和令牌在界面上打码显示，原样保存不会把打码值写回。
- 卸载是不可逆操作：会执行 k3s 官方卸载脚本，清理 `/etc/rancher/k3s`、`/var/lib/rancher/k3s`、CNI 残留和 IPVS 规则，
  并且必须手动输入 `uninstall` 才能执行。
- 没有多用户和权限模型，请当作单操作员的本机控制台使用。

## 限制

- 一键安装和卸载只覆盖 **k3s**。kubeadm 或外部 Kubernetes 集群可以通过 `kubeconfig` 查看，但不走安装流程。
- 本地接入（控制端即节点）只在 **Linux** 上可用；macOS 和 Windows 上控制台只能作为管理端，请用 SSH 或
  `kubeconfig`。
- 高可用指 3 或 5 台控制平面 + 嵌入式 etcd，不接外部数据库。
- CNI 使用 k3s 默认的 flannel；Cilium / Calico 需要手工安装。
- 升级失败不会自动回滚。
- 终端会话保存在内存里：空闲 30 分钟释放，连接异常断开约 1 分钟后回收。

## 许可证

[MIT](LICENSE) © 2026 dongyan
