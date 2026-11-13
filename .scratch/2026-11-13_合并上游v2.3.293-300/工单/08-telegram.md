# 08: Telegram 连接、登录开关与私聊提示

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.295、v2.3.296、v2.3.298、v2.3.300

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** Telegram 改用专用的 undici 连接池（IPv4 优先、超时可控）；Telegram 登录可以单独关闭（只隐藏登录入口，WebApp 和机器人登录不受影响）；机器人在群聊收到指令时回一句提示，只在私聊响应。

- [x] `package.json` 加 `undici`，只为它增量更新锁文件（用户决定 8）；新增 `server/telegramApiTransport.ts`，只改本地 `telegramBot.ts:678` 的 fetch 调用，并按 296 改为懒加载
- [x] `systemRouter.ts` 的 `telegramLoginEnabled` 写入 publicInfo；`routers/telegram.ts`、`Settings.tsx`、`Login.tsx`
- [x] 本地已只处理私聊，补上群聊提示文案（进入本地多语言 bot 结构）
- [x] 移植 `telegramApiTimeout.test.ts`、`telegramLoginSettings.test.ts`
