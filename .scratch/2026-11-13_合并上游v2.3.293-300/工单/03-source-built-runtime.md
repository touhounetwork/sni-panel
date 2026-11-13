# 03: 自编译转发运行时与故障切换补丁

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.293、v2.3.295

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** GOST 运行时固定 go-gost commit，从源码编译并打故障切换补丁（仍有正常节点时不再重试已知故障节点），二进制自报 `forwardx-runtime <版本>`；安装脚本只认这个标识；发布包附带 `RUNTIME_LICENSE.txt`、`RUNTIME_BUILD.txt`。

- [x] 引入 `scripts/build-runtime.sh`、`scripts/patch-runtime.sh`、`scripts/runtime-patches/`、`shared/runtimeBuild.ts`；**不引入** `fetch-runtime.sh`、`RELEASE_TAG` 和上游的 SHA256（用户决定 3）
- [x] `build-agent-release.sh` 改为调用 build-runtime；`agentInstallScripts.ts` 的运行时下载地址用 `repoReleaseAssetUrl`
- [x] `scripts/release/assemble.mjs`、`protocol.mjs` 的 requiredFiles、`prepare-image-context.mjs` 纳入运行时与两份说明文件；Dockerfile 的 agent-assets 阶段改用 golang:1.24
- [x] `THIRD_PARTY_NOTICES.md` 补 GOST 条目
- [x] 移植 `runtimeBuild.test.ts`（改写 poouo 断言）、`runtimeFailoverIntegration.test.ts`、补丁的 Go 测试；本地实际编译一次并核对版本标识
- [x] 发布说明写明：节点升级时会替换 gost，连接可能短暂中断
