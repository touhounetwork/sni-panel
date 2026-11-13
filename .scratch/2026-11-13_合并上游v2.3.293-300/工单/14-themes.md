# 14: 全站主题管理

Status: resolved（2026-11-13）

**上游来源：** v2.3.297、v2.3.298

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 全站主题的导入、预览、切换，支持 ZIP、TAR.GZ、RAR 上传；内置的六款预设配色作为内置主题保留。

- [x] `package.json` 加 `yauzl`、`tar-stream`、`postcss`、`postcss-value-parser`、`node-unrar-js`、`fflate` 和两个类型包，只为它们增量更新锁文件（用户决定 8）
- [x] 新增 `shared/themes*`、`server/theme*.ts`、`themeRepository.ts`、`routers/themes.ts`、客户端主题组件和 `styles/theme-views.css`；`ui/*` 加 `data-theme-part`
- [x] 按本地个性化布局（`personalization.ts`、`PersonalizationLayer`）合并 `Settings/DashboardLayout/LoginLayout/Login`；`requestBodyParser.ts` 手工合并
- [x] 主题模板包和文档里的品牌改为本项目；`ssrf.ts` 的远程下载限制按上游合入
- [x] 移植 `themes`、`themePackage`、`themeDownload`、`themeUpload`、`themeViews`、`managedTheme`、`ThemeBlocks` 测试

## Comments

- 2026-11-13 未完成的验证：主题模板包 starter.zip 未重新打包为本项目品牌；未在浏览器中实测上传与切换。
- 2026-11-13 已验证（浏览器）：ZIP、TAR.GZ、RAR 三种主题包都能上传安装；应用后 CSS 变量与样式表生效，公开接口返回当前主题（所有用户跟随），登录页同样生效；`?themeSafe=1` 回到默认外观；恢复默认主题与删除主题正常。模板包品牌按用户要求保持上游原样。
